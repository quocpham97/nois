import { createHash, timingSafeEqual } from "node:crypto";
import { encode, type JWT } from "next-auth/jwt";
import { getPool } from "@/lib/db";
import { sessionCookieName, secureCookies } from "@/server/session-cookie";

// Matches Auth.js's default session maxAge (30 days).
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

// Desktop login handoff, step 2: the Electron app trades its one-time code +
// PKCE verifier for a fresh session cookie. Unauthenticated by design (the
// app has no session yet); safety comes from the 256-bit single-use code
// (atomic DELETE), the 60s TTL, and the challenge binding. The session JWT is
// returned only as Set-Cookie so it lands straight in the app's cookie jar
// and never transits renderer-visible JS.
export async function POST(req: Request) {
  let body: { code?: string; verifier?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad body", { status: 400 });
  }
  const { code, verifier } = body;
  if (!code || !verifier) return new Response("Bad body", { status: 400 });

  const codeHash = createHash("sha256").update(code).digest("hex");
  // Single-use + TTL in one atomic step: expired or replayed codes match no
  // row, and a failed challenge check below still burns the code — correct,
  // since someone else has clearly seen it.
  const { rows } = await getPool().query(
    `DELETE FROM desktop_auth_code
     WHERE code_hash=$1 AND created_at > now() - interval '60 seconds'
     RETURNING token, challenge`,
    [codeHash],
  );
  if (rows.length !== 1) return new Response("Unauthorized", { status: 401 });

  const expected = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(rows[0].challenge as string);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const name = sessionCookieName();
  const jwt = await encode({
    token: rows[0].token as JWT,
    secret: process.env.AUTH_SECRET!,
    salt: name,
    maxAge: SESSION_MAX_AGE,
  });
  const cookie = [
    `${name}=${jwt}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE}`,
    ...(secureCookies() ? ["Secure"] : []),
  ].join("; ");
  return new Response(null, { status: 204, headers: { "Set-Cookie": cookie } });
}
