// Continuous-encrypted-history harness: drives the user_history store through
// the REAL server (over socket.io) as an authenticated user — append, upsert,
// cursor pagination, AES-GCM roundtrip (the same construction as
// crypto/backup.ts encryptHistoryRow/decryptHistoryRows, inlined here because
// that module needs IndexedDB), and the backup:delete cascade. Cleans up its
// DB rows at the end.
//
// Run: npx tsx --env-file=.env.local scripts/history-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { webcrypto as crypto } from "node:crypto";
import { getPool, ensureSchema } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const USER = "hist-tester@test";
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
  const cookie = await mintCookie(uid);
  const s = io(URL, {
    transports: ["websocket"],
    extraHeaders: { cookie },
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
const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

// --- storage-key row crypto (mirror of crypto/backup.ts) --------------------
const te = new TextEncoder();
const td = new TextDecoder();
const toB64 = (b: Uint8Array | ArrayBuffer) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

async function makeSk(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
type Row = { id: string; group_id: string; conv_id: string | null; parent_id: string | null; data: string };
type Wire = { msgId: string; iv: string; ct: string };
async function encRow(sk: CryptoKey, row: Row): Promise<Wire> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sk, te.encode(JSON.stringify(row)));
  return { msgId: row.id, iv: toB64(iv), ct: toB64(ct) };
}
async function decRow(sk: CryptoKey, w: Wire): Promise<Row> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(w.iv) },
    sk,
    fromB64(w.ct),
  );
  return JSON.parse(td.decode(pt)) as Row;
}

type FetchRes = { rows: Wire[]; nextCursor: string | null };
const fetchAll = async (s: Socket): Promise<Wire[]> => {
  const out: Wire[] = [];
  let cursor: string | null = null;
  do {
    const res: FetchRes = await emitAck<FetchRes>(s, "history:fetchMine", { afterMsgId: cursor });
    out.push(...(res?.rows ?? []));
    cursor = res?.nextCursor ?? null;
  } while (cursor);
  return out;
};

async function main() {
  await ensureSchema();
  const pool = getPool();
  // Fresh slate for the test user.
  await pool.query("DELETE FROM user_history WHERE user_id=$1", [USER]);
  await pool.query("DELETE FROM key_backup WHERE user_id=$1", [USER]);

  const s = await connect(USER);
  check(s.connected, "authenticated + connected");
  const sk = await makeSk();

  // 1. Append three rows (ids time-sortable like store.newId).
  const mkRow = (n: number, text: string): Row => ({
    id: `2026-07-10T0${n}:00:00.000Z-test${n}`,
    group_id: "general",
    conv_id: "general",
    parent_id: null,
    data: JSON.stringify({ id: `t${n}`, text, time: "1:00 PM" }),
  });
  const rows = [mkRow(1, "first"), mkRow(2, "second"), mkRow(3, "third")];
  const wires = await Promise.all(rows.map((r) => encRow(sk, r)));
  s.emit("history:append", { rows: wires });
  await sleep(400);

  const got1 = await fetchAll(s);
  check(got1.length === 3, `append + fetch roundtrip (${got1.length}/3 rows)`);
  check(
    got1.every((w, i) => i === 0 || w.msgId > got1[i - 1].msgId),
    "rows come back in msg_id order",
  );
  const dec1 = await Promise.all(got1.map((w) => decRow(sk, w)));
  check(
    dec1.some((r) => r.data.includes("second")),
    "decrypted rows match plaintext",
  );

  // 2. Upsert: re-append row 2 with new content (an edit/tombstone) → still 3
  //    rows, ciphertext replaced.
  const edited = { ...rows[1], data: JSON.stringify({ id: "t2", text: "second (edited)" }) };
  s.emit("history:append", { rows: [await encRow(sk, edited)] });
  await sleep(400);
  const got2 = await fetchAll(s);
  const dec2 = await Promise.all(got2.map((w) => decRow(sk, w)));
  check(got2.length === 3, `upsert keeps row count (${got2.length}/3)`);
  check(
    dec2.some((r) => r.data.includes("second (edited)")),
    "upsert replaced the row's ciphertext",
  );

  // 3. Cursor pagination: verify afterMsgId excludes prior rows.
  const page2: FetchRes = await emitAck<FetchRes>(s, "history:fetchMine", {
    afterMsgId: got2[0].msgId,
  });
  check(
    page2.rows.length === 2 && page2.rows.every((w) => w.msgId > got2[0].msgId),
    "cursor pagination excludes rows at/before the cursor",
  );

  // 4. backup:delete cascades to user_history.
  await emitAck(s, "backup:put", { blob: { v: 3, dummy: true } });
  const del = await emitAck<{ ok: boolean }>(s, "backup:delete");
  check(!!del?.ok, "backup:delete acked");
  const got3 = await fetchAll(s);
  check(got3.length === 0, `backup:delete cascaded to history rows (${got3.length}/0 left)`);

  // 5. Isolation: another user sees none of this user's rows.
  const other = await connect("hist-other@test");
  s.emit("history:append", { rows: [await encRow(sk, mkRow(4, "mine only"))] });
  await sleep(400);
  const otherRows = await fetchAll(other);
  check(otherRows.length === 0, "another user's fetch sees no rows (per-user isolation)");

  // Cleanup.
  await pool.query("DELETE FROM user_history WHERE user_id=$1", [USER]);
  await pool.query("DELETE FROM key_backup WHERE user_id=$1", [USER]);
  s.close();
  other.close();

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
