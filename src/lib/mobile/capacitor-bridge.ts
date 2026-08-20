// Capacitor mobile shell, web side. Capacitor loads this same web app from the
// remote server (capacitor.config server.url), so — exactly like the Electron
// window — the Socket.IO client, the session cookie, and the secure-context
// APIs (WebCrypto, OPFS) all resolve against the app's own origin. There is no
// separate native "main process": the shell logic below runs in THIS WebView
// against the injected `window.Capacitor` global and sets up `window.mobile`
// (the same bridge contract as window.desktop; see src/types/mobile.d.ts).
//
// setupMobileBridge() is idempotent and a no-op off-native, so it is safe to
// call unconditionally from a client component (components/mobile-mode.tsx).

"use client";

const PROTOCOL = "messenger"; // shared with the desktop shell's deep-link scheme
const VERIFIER_KEY = "mobile:auth:verifier";

type Plugin = Record<string, (...args: unknown[]) => Promise<unknown>>;

function plugin(name: string): Plugin | undefined {
  return window.Capacitor?.Plugins?.[name] as Plugin | undefined;
}

// --- PKCE helpers (mirror desktop/src/auth-handoff.ts, in-WebView) -------------

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// --- login handoff -------------------------------------------------------------

// Google blocks OAuth inside embedded webviews, so login runs in the SYSTEM
// browser and returns via the messenger:// deep link — reusing the web app's
// existing ?desktop=1 handoff pages and /api/desktop/* routes verbatim. Unlike
// Electron, the exchange runs HERE (same-origin as server.url), so the
// Set-Cookie lands straight in the WebView's own cookie jar.
async function startLogin(): Promise<void> {
  const Browser = plugin("Browser");
  const { verifier, challenge } = await pkce();
  // sessionStorage (not memory) so the verifier survives the WebView being
  // paused/reclaimed while the system browser is foregrounded.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const url = `${location.origin}/login?desktop=1&challenge=${challenge}`;
  if (Browser) await Browser.open({ url } as never);
  else location.href = url; // degrade: in-WebView (works if the IdP allows it)
}

async function completeLogin(code: string): Promise<boolean> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) return false;
  sessionStorage.removeItem(VERIFIER_KEY); // single attempt, like the code
  const res = await fetch(`${location.origin}/api/desktop/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
    credentials: "include", // same-origin: cookie persists in the WebView jar
  });
  return res.status === 204;
}

function parseAuthCode(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${PROTOCOL}:` || url.hostname !== "auth") return null;
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

// --- notification-tap fan-out --------------------------------------------------

// A tapped local notification or push carries a channelId in its extra/data;
// deliver it to whoever registered via window.mobile.onOpenChannel (chat
// context uses this to select the channel).
const openChannelSubs = new Set<(channelId: string) => void>();
function emitOpenChannel(channelId: unknown): void {
  const id = String(channelId ?? "");
  if (id) for (const cb of openChannelSubs) cb(id);
}

// --- native push (APNs / FCM) --------------------------------------------------

/** Mirrors PushState in src/lib/push.ts, which is what the settings UI reads. */
type PushState = "unsupported" | "denied" | "enabled" | "disabled";

/** The token this device last registered, so it can be withdrawn on disable. */
let deviceToken: string | null = null;

async function postToken(token: string): Promise<void> {
  deviceToken = token;
  await fetch("/api/mobile/push-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // iOS registers an APNs device token, Android an FCM registration token —
    // the platform decides which transport the server sends over.
    body: JSON.stringify({ token, platform: window.Capacitor?.getPlatform?.() }),
  });
}

async function dropToken(): Promise<void> {
  if (!deviceToken) return;
  await fetch("/api/mobile/push-token", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: deviceToken }),
  });
  deviceToken = null;
}

/** granted → "enabled"; denied → "denied"; never-asked → "disabled". */
function stateFrom(receive: string | undefined): PushState {
  if (receive === "granted") return "enabled";
  if (receive === "denied") return "denied";
  return "disabled";
}

async function pushPermission(): Promise<string | undefined> {
  const res = (await plugin("PushNotifications")?.checkPermissions?.()) as
    | { receive?: string }
    | undefined;
  return res?.receive;
}

async function nativePushState(): Promise<PushState> {
  const Push = plugin("PushNotifications");
  if (!Push) return "unsupported";
  return stateFrom(await pushPermission());
}

/**
 * Turn native push on or off for this device.
 *
 * "Off" can only mean "stop being reachable" — an OS permission can't be handed
 * back, so the token is withdrawn from the server instead and the switch reads
 * as off because nothing will be sent.
 */
async function setNativePushEnabled(on: boolean): Promise<PushState> {
  const Push = plugin("PushNotifications");
  if (!Push) return "unsupported";
  if (!on) {
    await dropToken();
    return "disabled";
  }
  let receive = await pushPermission();
  if (receive !== "granted") {
    receive = ((await Push.requestPermissions?.()) as { receive?: string } | undefined)
      ?.receive;
  }
  if (receive !== "granted") return stateFrom(receive);
  // `register()` is what actually asks APNs/FCM for a token; the value arrives
  // asynchronously on the 'registration' listener installed at setup.
  await Push.register?.();
  return "enabled";
}

// --- setup ---------------------------------------------------------------------

let installed = false;

export async function setupMobileBridge(): Promise<void> {
  if (installed) return;
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.()) return; // no-op in a plain browser
  installed = true;

  document.documentElement.classList.add("mobile");

  const App = plugin("App");
  const LocalNotifications = plugin("LocalNotifications");

  const version =
    (((await App?.getInfo?.()) as { version?: string } | undefined)?.version) ??
    "";

  window.mobile = {
    startLogin: () => void startLogin(),
    notify: ({ title, body, channelId }) => {
      void LocalNotifications?.schedule({
        notifications: [
          {
            // A stable per-channel id coalesces banners like the desktop `tag`:
            // a hash keeps it inside the 32-bit id space Android requires.
            id: hashId(channelId),
            title,
            body,
            extra: { channelId },
          },
        ],
      } as never);
    },
    setBadge: (count) => {
      // Badge support is a plugin (@capawesome/capacitor-badge) that the native
      // projects don't ship yet — driven through the runtime global like every
      // other plugin here, so it's a no-op until the plugin is installed rather
      // than a build-time dependency.
      void plugin("Badge")?.set?.({ count } as never);
    },
    pushState: () => nativePushState(),
    setPushEnabled: (on) => setNativePushEnabled(on),
    onOpenChannel: (cb) => {
      openChannelSubs.add(cb);
      return () => openChannelSubs.delete(cb);
    },
    version,
  };

  // Deep-link return leg of the login handoff.
  await App?.addListener?.("appUrlOpen", (async (evt: { url?: string }) => {
    const code = parseAuthCode(evt?.url ?? "");
    if (!code) return;
    const ok = await completeLogin(code);
    await plugin("Browser")?.close?.();
    // Reload as signed-in (or back to /login on failure) — the session cookie
    // is now (or is not) in the jar.
    location.href = ok ? location.origin : `${location.origin}/login`;
  }) as never);

  // Local-notification taps open the channel.
  await LocalNotifications?.addListener?.(
    "localNotificationActionPerformed",
    ((evt: { notification?: { extra?: { channelId?: string } } }) =>
      emitOpenChannel(evt?.notification?.extra?.channelId)) as never,
  );

  // --- background push ---------------------------------------------------
  const Push = plugin("PushNotifications");

  // The token is handed over asynchronously after register(), and is also
  // re-issued by the OS on its own schedule — so this listener, not the
  // register() call, is what keeps the server's copy current.
  await Push?.addListener?.("registration", ((token: { value?: string }) => {
    if (token?.value) void postToken(token.value);
  }) as never);

  await Push?.addListener?.("registrationError", ((err: unknown) => {
    console.warn("[push] native registration failed", err);
  }) as never);

  // A tapped push opens its conversation, exactly like a tapped local
  // notification. channelId rides in FCM `data` and beside APNs `aps`; both
  // surface here as `notification.data`.
  await Push?.addListener?.("pushNotificationActionPerformed", ((evt: {
    notification?: { data?: { channelId?: string } };
  }) => emitOpenChannel(evt?.notification?.data?.channelId)) as never);

  // Deliberately NO handler for 'pushNotificationReceived': a push that lands
  // while the app is open is a duplicate of what the live socket already
  // delivered, and the page raises its own banner for that (src/lib/notify.ts).

  // Re-register on every launch when permission is already granted: tokens
  // rotate, rows get lost, and a device that switched accounts must rebind to
  // the user signed in now. This never prompts — the prompt is the settings
  // toggle's job.
  if ((await pushPermission()) === "granted") await Push?.register?.();
}

// djb2 → signed 31-bit int (Android LocalNotifications ids must fit in an int).
function hashId(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
