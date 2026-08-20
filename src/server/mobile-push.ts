/**
 * Native push for the Capacitor shell: APNs on iOS, FCM on Android.
 *
 * Why two transports rather than "everything through FCM": with
 * `@capacitor/push-notifications` as it ships, an Android device registers an
 * FCM token and an iOS device registers a raw APNs device token — putting iOS
 * on FCM as well means adding the Firebase iOS SDK to the native project. The
 * token's platform travels with it (see /api/mobile/push-token) and picks the
 * transport here, so either setup works: an iOS build that DOES register with
 * Firebase simply never produces an "ios" row.
 *
 * Both protocols are a signed JWT and one HTTPS request, so they're written out
 * here rather than pulled in as an SDK — `firebase-admin` alone is tens of
 * megabytes for one POST.
 *
 * Unlike Web Push, the SERVER composes the visible text here (the OS renders
 * it, no service worker gets a look in), so the copy comes from the shared
 * src/lib/notif-copy.ts. It stays generic: this process cannot read a message.
 */
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { sign } from "node:crypto";
import { conversationTag, type NotifCopy } from "../lib/notif-copy";
import type { MobileToken } from "../lib/db";

// --- configuration ---------------------------------------------------------

// A service account with the "Firebase Cloud Messaging API" scope. Three envs
// rather than the raw JSON blob so they sit alongside VAPID_* in render.yaml.
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID;
const FCM_CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL;
// PEM. Escaped newlines survive a single-line env var, so accept both forms.
const FCM_PRIVATE_KEY = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n");

// An Apple "Key ID"/p8 pair (Keys → Apple Push Notifications service), the team
// id, and the app's bundle id (which is the APNs topic).
const APNS_KEY_ID = process.env.APNS_KEY_ID;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;
const APNS_PRIVATE_KEY = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID;
/** Sandbox for debug builds: api.sandbox.push.apple.com. */
const APNS_HOST = process.env.APNS_HOST ?? "api.push.apple.com";

const fcmReady = !!(FCM_PROJECT_ID && FCM_CLIENT_EMAIL && FCM_PRIVATE_KEY);
const apnsReady = !!(
  APNS_KEY_ID &&
  APNS_TEAM_ID &&
  APNS_PRIVATE_KEY &&
  APNS_BUNDLE_ID
);

/** Is either transport configured? (Each platform is independently optional.) */
export function mobilePushReady(): boolean {
  return fcmReady || apnsReady;
}

// --- JWT -------------------------------------------------------------------

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/**
 * A signed JWT. ES256 needs the raw r||s signature JOSE specifies, not the DER
 * sequence node produces by default — hence `ieee-p1363`. Getting this wrong
 * yields a 403 from Apple that looks exactly like a bad key.
 */
function jwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: string,
  es256: boolean,
): string {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = sign(
    "sha256",
    Buffer.from(data),
    es256 ? { key, dsaEncoding: "ieee-p1363" } : key,
  );
  return `${data}.${sig.toString("base64url")}`;
}

/** A cached bearer token, refreshed a minute before it lapses. */
type Cached = { value: string; expiresAt: number };
const fresh = (c: Cached | null) => (c && c.expiresAt > Date.now() + 60_000 ? c.value : null);

// --- FCM (Android) ---------------------------------------------------------

let fcmAccess: Cached | null = null;

/** OAuth2 access token for the FCM v1 API, via a service-account assertion. */
async function fcmAccessToken(): Promise<string | null> {
  const cached = fresh(fcmAccess);
  if (cached) return cached;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = jwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: FCM_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    },
    FCM_PRIVATE_KEY!,
    false,
  );
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) {
      console.warn(`[push] FCM token exchange failed (${res.status})`);
      return null;
    }
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    fcmAccess = {
      value: j.access_token,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    };
    return fcmAccess.value;
  } catch (e) {
    console.warn("[push] FCM token exchange error:", (e as Error).message);
    return null;
  }
}

async function sendFcm(
  token: string,
  copy: NotifCopy,
  channelId: string,
  onDeadToken: (token: string) => void,
): Promise<void> {
  const access = await fcmAccessToken();
  if (!access) return;
  const tag = conversationTag(channelId);
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: copy.title, body: copy.body },
          // Read by the tap handler in capacitor-bridge.ts. Data values must be
          // strings in FCM.
          data: { channelId },
          android: {
            priority: "high",
            // Both halves of "one live notification per conversation": the tag
            // replaces the banner on the device, collapse_key replaces an
            // undelivered message still queued at Google.
            collapse_key: tag,
            notification: { tag },
          },
        },
      }),
    },
  );
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  // 404 is UNREGISTERED: app uninstalled, or this token superseded. Anything
  // else (401/403 credentials, 400 a malformed message of OUR making, 429/503
  // throttling) is not the token's fault, and pruning on it would quietly
  // unregister every device over a server-side mistake.
  if (res.status === 404) {
    onDeadToken(token);
    return;
  }
  console.warn(`[push] FCM send failed (${res.status}) ${detail.slice(0, 200)}`);
}

// --- APNs (iOS) ------------------------------------------------------------

let apnsAuth: Cached | null = null;

function apnsJwt(): string {
  const cached = fresh(apnsAuth);
  if (cached) return cached;
  const iat = Math.floor(Date.now() / 1000);
  const value = jwt(
    { alg: "ES256", kid: APNS_KEY_ID, typ: "JWT" },
    { iss: APNS_TEAM_ID, iat },
    APNS_PRIVATE_KEY!,
    true,
  );
  // Apple rejects a token older than an hour; refresh well inside that.
  apnsAuth = { value, expiresAt: Date.now() + 45 * 60_000 };
  return value;
}

/** One request on an already-open HTTP/2 session. Resolves to the status. */
function apnsRequest(
  session: ClientHttp2Session,
  token: string,
  copy: NotifCopy,
  channelId: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      aps: {
        alert: { title: copy.title, body: copy.body },
        sound: "default",
        // Groups this conversation's notifications in the shade, like `tag`.
        "thread-id": channelId,
      },
      // Custom keys ride alongside `aps` and reach the tap handler as data.
      channelId,
    });
    const stream = session.request({
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
      authorization: `bearer ${apnsJwt()}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      // Replaces an earlier undelivered notification for the same conversation.
      // Apple caps this at 64 bytes.
      "apns-collapse-id": conversationTag(channelId).slice(0, 64),
      "content-type": "application/json",
    });
    let status = 0;
    let out = "";
    stream.on("response", (headers) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS]) || 0;
    });
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      out += chunk;
    });
    stream.on("end", () => resolve({ status, body: out }));
    stream.on("error", reject);
    stream.end(body);
  });
}

async function sendApnsBatch(
  tokens: string[],
  copy: NotifCopy,
  channelId: string,
  onDeadToken: (token: string) => void,
): Promise<void> {
  // One session for the whole batch — a TLS handshake per device would dwarf
  // the notification. It is closed at the end rather than pooled: pushes are
  // coalesced to at most one per conversation per 30s, so a long-lived
  // connection would mostly sit idle.
  let session: ClientHttp2Session;
  try {
    session = connect(`https://${APNS_HOST}`);
  } catch (e) {
    console.warn("[push] APNs connect failed:", (e as Error).message);
    return;
  }
  // Without a handler, a connection-level error is an unhandled 'error' event.
  session.on("error", (e) => console.warn("[push] APNs session:", e.message));
  try {
    for (const token of tokens) {
      try {
        const { status, body } = await apnsRequest(session, token, copy, channelId);
        if (status === 200) continue;
        const reason = (JSON.parse(body || "{}") as { reason?: string }).reason;
        // 410 Unregistered, or 400 BadDeviceToken: this device is gone for
        // good. Everything else — 403 (bad key/JWT), 429, 500 — is ours.
        if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
          onDeadToken(token);
        } else {
          console.warn(`[push] APNs send failed (${status}) ${reason ?? body.slice(0, 120)}`);
        }
      } catch (e) {
        console.warn("[push] APNs request error:", (e as Error).message);
      }
    }
  } finally {
    session.close();
  }
}

// --- entry point -----------------------------------------------------------

/**
 * Fire-and-forget a notification to one user's mobile devices. Never throws:
 * every failure is logged, and a token the service reports as gone is handed to
 * `onDeadToken` for pruning.
 */
export async function sendMobilePush(
  tokens: MobileToken[],
  copy: NotifCopy,
  channelId: string,
  onDeadToken: (token: string) => void,
): Promise<void> {
  const android = tokens.filter((t) => t.platform === "android").map((t) => t.token);
  const ios = tokens.filter((t) => t.platform === "ios").map((t) => t.token);

  if (fcmReady) {
    await Promise.all(
      android.map((t) =>
        sendFcm(t, copy, channelId, onDeadToken).catch((e: Error) =>
          console.warn("[push] FCM send error:", e.message),
        ),
      ),
    );
  } else if (android.length) {
    console.warn(`[push] ${android.length} Android token(s) but FCM_* is not configured`);
  }

  if (apnsReady) {
    if (ios.length) await sendApnsBatch(ios, copy, channelId, onDeadToken);
  } else if (ios.length) {
    console.warn(`[push] ${ios.length} iOS token(s) but APNS_* is not configured`);
  }
}
