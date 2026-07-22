// Rate-limited backup-unlock vault harness: exercises backup:put (with kcv),
// backup:get (metadata only — never the ciphertext), backup:unlock (wrong-PIN
// attempt counting, lockout, correct-PIN release + reset) and the legacy
// (pre-vault, kcv-less) fallback, against the REAL server. Mirrors the client
// KDF/kcv construction from crypto/backup.ts. Cleans up after itself.
//
// Run: npx tsx --env-file=.env.local scripts/vault-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { webcrypto as crypto } from "node:crypto";
import { getPool, ensureSchema } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const USER = "vault-tester@test";
const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS" : "FAIL"}  ${label}`);

async function mintCookie(uid: string): Promise<string> {
  const jwt = await encode({
    token: { uid, name: uid },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
  return `authjs.session-token=${jwt}`;
}
async function connect(uid: string): Promise<Socket> {
  const s = io(URL, {
    transports: ["websocket"],
    extraHeaders: { cookie: await mintCookie(uid) },
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    s.on("connect", () => resolve());
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 6000);
  });
  return s;
}
const emitAck = <T>(s: Socket, ev: string, ...args: unknown[]): Promise<T> =>
  new Promise((resolve) =>
    s.timeout(6000).emit(ev, ...args, (_e: unknown, r: T) => resolve(r)),
  );

// --- client-side KDF + kcv (mirror of crypto/backup.ts) ---------------------
const te = new TextEncoder();
const toB64 = (b: Uint8Array | ArrayBuffer) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const ITERS = 600_000;

async function deriveBits(pass: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERS, hash: "SHA-256" },
    base,
    256,
  );
}
async function computeKcv(pass: string, saltB64: string): Promise<string> {
  const bits = new Uint8Array(await deriveBits(pass, fromB64(saltB64)));
  const tag = te.encode("chat-backup-kcv:");
  const input = new Uint8Array(tag.length + bits.length);
  input.set(tag);
  input.set(bits, tag.length);
  return toB64(await crypto.subtle.digest("SHA-256", input));
}
async function makeBlob(pass: string): Promise<{ blob: Record<string, unknown>; kcv: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", await deriveBits(pass, salt), "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode('{"keys":{}}'));
  const blob = {
    v: 3,
    kdf: "PBKDF2-SHA256",
    iters: ITERS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  };
  return { blob, kcv: await computeKcv(pass, blob.salt) };
}

type Meta = { updatedAt: string | null; salt: string | null; iters: number | null; legacyBlob?: unknown };
type Unlock =
  | { ok: true; blob: unknown }
  | { ok: false; error: string; remainingAttempts?: number; lockedForSec?: number };

async function main() {
  await ensureSchema();
  const pool = getPool();
  await pool.query("DELETE FROM key_backup WHERE user_id=$1", [USER]);

  const s = await connect(USER);
  check(s.connected, "authenticated + connected");

  // 1. Put with kcv; get returns metadata only, never ciphertext.
  const PIN = "31415926";
  const { blob, kcv } = await makeBlob(PIN);
  const put = await emitAck<{ ok: boolean }>(s, "backup:put", { blob, kcv });
  check(put?.ok === true, "backup:put with kcv acked");
  const meta = await emitAck<Meta>(s, "backup:get", );
  check(!!meta.updatedAt && meta.salt === blob.salt && meta.iters === ITERS, "get returns KDF metadata");
  check(!("legacyBlob" in meta) && !JSON.stringify(meta).includes(blob.ct as string), "get does NOT return ciphertext");

  // 2. Correct proof unlocks and returns the exact blob.
  const good = await emitAck<Unlock>(s, "backup:unlock", { kcv });
  check(good.ok === true && (good as { blob: { ct?: string } }).blob?.ct === blob.ct, "correct PIN releases the blob");

  // 3. Wrong proofs count down.
  const badKcv = await computeKcv("99999999", blob.salt as string);
  const w1 = await emitAck<Unlock>(s, "backup:unlock", { kcv: badKcv });
  check(w1.ok === false && w1.remainingAttempts === 9, `wrong PIN counts (${!w1.ok ? w1.remainingAttempts : "?"} left)`);
  for (let i = 0; i < 8; i++) await emitAck<Unlock>(s, "backup:unlock", { kcv: badKcv });
  const w10 = await emitAck<Unlock>(s, "backup:unlock", { kcv: badKcv });
  check(w10.ok === false && (w10.lockedForSec ?? 0) > 0, "10th wrong attempt engages lockout");

  // 4. Even the CORRECT proof is rejected while locked.
  const lockedGood = await emitAck<Unlock>(s, "backup:unlock", { kcv });
  check(lockedGood.ok === false && (lockedGood.lockedForSec ?? 0) > 0, "correct PIN rejected during lockout");

  // 5. After lock expiry (simulated), correct proof works and resets attempts.
  await pool.query("UPDATE key_backup SET locked_until=NULL WHERE user_id=$1", [USER]);
  const after = await emitAck<Unlock>(s, "backup:unlock", { kcv });
  check(after.ok === true, "correct PIN unlocks after lock expiry");
  const { rows } = await pool.query("SELECT attempts FROM key_backup WHERE user_id=$1", [USER]);
  check(rows[0]?.attempts === 0, "successful unlock resets the attempt counter");

  // 6. Legacy row (no kcv): get returns the blob directly.
  await pool.query("UPDATE key_backup SET kcv=NULL WHERE user_id=$1", [USER]);
  const legacy = await emitAck<Meta>(s, "backup:get");
  check(
    !!legacy.legacyBlob && (legacy.legacyBlob as { ct?: string }).ct === blob.ct,
    "legacy (kcv-less) row falls back to returning the blob",
  );

  await pool.query("DELETE FROM key_backup WHERE user_id=$1", [USER]);
  s.close();

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
