// A re-sent message must resolve to the message it already created.
//
// A client resends any send it never saw acked (see the reconnect resend in
// hooks/use-session-sync). The server used to discard the sender's clientId
// (`void clientId`), so each resend minted a fresh message with a fresh id —
// and the recipient de-dupes on the SERVER id, so one send became two rows that
// stayed two rows.
//
// This exercises the server contract directly, without a browser: the in-memory
// index, the per-group scoping of the key, and the durable unique index.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/send-idempotency-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const A = "idem-a@test";
const B = "idem-b@test";

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);
const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

const jwt = (uid: string) =>
  encode({
    token: { uid, name: uid },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });

async function connect(uid: string): Promise<Socket> {
  const s = io(URL, {
    transports: ["websocket"],
    extraHeaders: { cookie: `authjs.session-token=${await jwt(uid)}` },
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    s.on("connect", () => resolve());
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 8000);
  });
  return s;
}

/** Send and resolve the acked message id. */
function sendFor(s: Socket, groupId: string, text: string, clientId: string) {
  return new Promise<string>((resolve, reject) => {
    const onAck = (p: { clientId: string; message: { id: string } }) => {
      if (p.clientId !== clientId) return;
      s.off("message:ack", onAck);
      resolve(p.message.id);
    };
    s.on("message:ack", onAck);
    s.emit("message:send", { groupId, text, clientId });
    setTimeout(() => reject(new Error(`no ack for ${clientId}`)), 8000);
  });
}

async function makeGroup(s: Socket, name: string): Promise<string> {
  return new Promise((resolve, reject) =>
    s.emit(
      "group:create",
      { name, topic: "idempotency harness", memberIds: [B] },
      (r: { ok: boolean; groupId?: string }) =>
        r.ok && r.groupId ? resolve(r.groupId) : reject(new Error("create failed")),
    ),
  );
}

async function main() {
  const stamp = Date.now();
  let a = await connect(A);
  await sleep(300);
  const g1 = await makeGroup(a, `idem-${stamp}`);
  const g2 = await makeGroup(a, `idem-${stamp}-b`);

  // Everything B is told about, to prove the duplicate never reaches a recipient.
  const b = await connect(B);
  const relayed: { group: string; id: string }[] = [];
  b.on("message:new", (p: { groupId: string; message: { id: string } }) =>
    relayed.push({ group: p.groupId, id: p.message.id }),
  );
  await sleep(500);

  // 1. The same clientId twice on one connection.
  const cid = `c-${stamp}-1`;
  const first = await sendFor(a, g1, `hello ${stamp}`, cid);
  const second = await sendFor(a, g1, `hello ${stamp}`, cid);
  check(first === second, "a repeat send acks the same message id");

  // 2. A different clientId is a different message — dedupe must not over-match.
  const other = await sendFor(a, g1, `second ${stamp}`, `c-${stamp}-2`);
  check(other !== first, "a different clientId gets its own message");

  // 3. Same clientId, different group: the key is scoped per conversation.
  const elsewhere = await sendFor(a, g2, `hello ${stamp}`, cid);
  check(
    elsewhere !== first,
    "the same clientId in another conversation is its own message",
  );

  // 4. Across a reconnect — the case the client actually hits.
  a.close();
  await sleep(600);
  a = await connect(A);
  await sleep(400);
  const afterReconnect = await sendFor(a, g1, `hello ${stamp}`, cid);
  check(afterReconnect === first, "a resend after reconnect resolves to the original");

  await sleep(1200);

  // 5. What the recipient saw: one id per logical message, never a duplicate.
  const inG1 = relayed.filter((r) => r.group === g1);
  const distinct = new Set(inG1.map((r) => r.id));
  check(
    distinct.size === 2,
    `recipient saw ${distinct.size} distinct messages from ${inG1.length} relays (want 2)`,
  );

  // 6. The durable backstop: one row per (group, clientId).
  const pool = getPool();
  const rows = await pool.query(
    `SELECT count(*)::int n FROM message WHERE group_id=$1 AND client_id=$2`,
    [g1, cid],
  );
  check(rows.rows[0].n === 1, `the send has ${rows.rows[0].n} stored row (want 1)`);

  const total = await pool.query(
    `SELECT count(*)::int n FROM message WHERE group_id=$1 AND parent_id IS NULL`,
    [g1],
  );
  check(total.rows[0].n === 2, `the group holds ${total.rows[0].n} messages (want 2)`);

  a.close();
  b.close();
  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
