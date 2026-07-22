// Auth.js names the session cookie by scheme: over https it's the
// `__Secure-`-prefixed name; on plain http (dev) it's unprefixed. The
// Socket.IO handshake (server.ts) and the desktop auth routes must agree on
// this — and Auth.js v5 also salts the session JWE with the cookie name, so
// `salt` must be this exact string wherever a token is decoded or encoded.
//
// Functions (not consts): server.ts calls loadEnvConfig() AFTER static
// imports are evaluated, so AUTH_URL isn't in process.env yet at module
// scope — reading it lazily sidesteps the ordering hazard.

export function secureCookies(): boolean {
  return (process.env.AUTH_URL ?? "").startsWith("https://");
}

export function sessionCookieName(): string {
  return secureCookies()
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}
