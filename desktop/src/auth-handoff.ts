// Desktop side of the login handoff (counterpart of the web repo's
// /api/desktop/* routes). Google blocks OAuth in embedded webviews, so login
// runs in the SYSTEM browser and comes back via the messenger:// protocol
// with a one-time code. PKCE-style binding: the verifier below never leaves
// this process, so an intercepted deep-link code is useless on its own.
import { createHash, randomBytes } from "node:crypto";
import { net, shell } from "electron";

const VERIFIER_TTL_MS = 5 * 60_000;

let pending: { verifier: string; expires: number } | null = null;

/** Open the system browser on the login page, carrying our PKCE challenge. */
export function startLogin(appUrl: string): void {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  pending = { verifier, expires: Date.now() + VERIFIER_TTL_MS };
  void shell.openExternal(`${appUrl}/login?desktop=1&challenge=${challenge}`);
}

/**
 * Handle a messenger://auth?code=… deep link: trade code + verifier for a
 * session cookie. `credentials: "include"` binds the request to the default
 * session's cookie jar, so the Set-Cookie session JWT is persisted there and
 * never transits renderer JS. Returns true when the app now has a session.
 */
export async function handleAuthUrl(
  rawUrl: string,
  appUrl: string,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "messenger:" || url.hostname !== "auth") return false;
  const code = url.searchParams.get("code");
  if (!code || !pending || Date.now() > pending.expires) {
    pending = null;
    return false;
  }
  const { verifier } = pending;
  pending = null; // single attempt per startLogin, like the code itself

  const res = await net.fetch(`${appUrl}/api/desktop/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
    credentials: "include",
  });
  return res.status === 204;
}
