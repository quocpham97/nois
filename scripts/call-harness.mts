// Call-signaling relay harness: verifies the SERVER routing added for
// call:invite / call:answer / call:signal / call:end against the real server
// (socket.io) — the security-relevant part. An invite must only be placeable
// on a DM the caller belongs to (the callee is derived from the roster, never
// client-claimed), must ring every device of the callee and nobody else, and
// must fail fast with "offline" when the callee has no connected socket.
// (The WebRTC engine itself lives in call-context/React and is not runnable
// here — covered by code review + browser use, same as other client logic.)
//
// Run: npx tsx --env-file=.env.local scripts/call-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const ALICE = "call-alice@test";
const BOB = "call-bob@test";
const CAROL = "call-carol@test";

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);

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

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

// Resolve with the next payload for `event`, or null if none arrives in `ms`.
function waitFor<T>(s: Socket, event: string, ms = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      s.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (p: T) => {
      clearTimeout(t);
      s.off(event, handler);
      resolve(p);
    };
    s.on(event, handler);
  });
}

function emitWithAck<T>(s: Socket, event: string, payload: unknown, ms = 4000): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.emit(event, payload, (res: T) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

type InviteRelay = { callId: string; groupId: string; fromUserId: string; video: boolean };
type AnswerRelay = { callId: string; fromUserId: string; accept: boolean };
type SignalRelay = { callId: string; fromUserId: string; data: string };
type EndRelay = { callId: string; fromUserId: string; reason: string };
type InviteAck = { ok: boolean; reason?: string };

async function main() {
  const aliceD1 = await connect(ALICE);
  const aliceD2 = await connect(ALICE); // Alice's SECOND device (same uid)
  const bob = await connect(BOB);
  const carol = await connect(CAROL);
  await sleep(400); // let each socket join its user:<uid> room

  // Establish a real DM Bob↔Alice (call:invite validates DM membership).
  bob.emit("dm:create", {
    recipientId: ALICE,
    text: "call harness setup",
    clientId: "call-harness-" + Date.now(),
  });
  const ackMsg = await waitFor(bob, "message:ack", 3000);
  check(ackMsg !== null, "setup: DM Bob→Alice created");
  const dmId = ALICE; // a DM's id is the recipient's bare key (Bob's view)
  await sleep(200);

  // --- invite validation ------------------------------------------------------
  const callId = "call-" + Date.now();

  // Non-member: Carol may not place a call on someone else's DM.
  const carolAck = await emitWithAck<InviteAck>(carol, "call:invite", {
    callId: "intruder-" + Date.now(),
    groupId: dmId,
    video: false,
  });
  check(
    carolAck?.ok === false && carolAck.reason === "unauthorized",
    "invite on a DM the caller doesn't belong to → unauthorized",
  );

  // Non-DM group id → unauthorized (calls are DM-only).
  const groupAck = await emitWithAck<InviteAck>(bob, "call:invite", {
    callId: "nogroup-" + Date.now(),
    groupId: "not-a-dm-" + Date.now(),
    video: false,
  });
  check(groupAck?.ok === false, "invite on a non-DM group id → rejected");

  // --- invite routing ----------------------------------------------------------
  const a1Inv = waitFor<InviteRelay>(aliceD1, "call:invite");
  const a2Inv = waitFor<InviteRelay>(aliceD2, "call:invite");
  const carolInv = waitFor<InviteRelay>(carol, "call:invite");
  const bobInv = waitFor<InviteRelay>(bob, "call:invite"); // caller: none
  const inviteAck = await emitWithAck<InviteAck>(bob, "call:invite", {
    callId,
    groupId: dmId,
    video: true,
  });
  check(inviteAck?.ok === true, "valid invite acks ok:true");
  const [iA1, iA2, iCarol, iBob] = await Promise.all([a1Inv, a2Inv, carolInv, bobInv]);
  check(
    iA1?.fromUserId === BOB && iA1?.callId === callId && iA1?.video === true,
    "callee device 1 rings (fromUserId=Bob, video=true)",
  );
  check(iA2?.fromUserId === BOB, "callee device 2 rings too");
  check(iCarol === null, "third party (Carol) does NOT ring");
  check(iBob === null, "caller does NOT receive its own invite");

  // --- answer routing (+ stop-ringing fanout) ----------------------------------
  const bobAns = waitFor<AnswerRelay>(bob, "call:answer");
  const a2Handled = waitFor<EndRelay>(aliceD2, "call:end");
  const carolAns = waitFor<AnswerRelay>(carol, "call:answer");
  aliceD1.emit("call:answer", { callId, toUserId: BOB, accept: true });
  const [ansBob, hA2, ansCarol] = await Promise.all([bobAns, a2Handled, carolAns]);
  check(
    ansBob?.accept === true && ansBob?.fromUserId === ALICE && ansBob?.callId === callId,
    "caller receives the acceptance",
  );
  check(
    hA2?.reason === "handled" && hA2?.callId === callId,
    "answerer's OTHER device stops ringing (call:end reason=handled)",
  );
  check(ansCarol === null, "third party does NOT see the answer");

  // --- signal routing ------------------------------------------------------------
  const sdp = JSON.stringify({ type: "offer", sdp: "v=0 FAKE-SDP" });
  const a1Sig = waitFor<SignalRelay>(aliceD1, "call:signal");
  const carolSig = waitFor<SignalRelay>(carol, "call:signal");
  bob.emit("call:signal", { callId, toUserId: ALICE, data: sdp });
  const [sA1, sCarol] = await Promise.all([a1Sig, carolSig]);
  check(sA1?.data === sdp && sA1?.fromUserId === BOB, "offer relays caller → callee devices");
  check(sCarol === null, "third party does NOT see signaling");

  const bobSig = waitFor<SignalRelay>(bob, "call:signal");
  aliceD1.emit("call:signal", {
    callId,
    toUserId: BOB,
    data: JSON.stringify({ type: "answer", sdp: "v=0 FAKE-ANSWER" }),
  });
  check((await bobSig)?.fromUserId === ALICE, "answer relays callee → caller");

  // Oversized signal payloads are dropped.
  const bigSig = waitFor<SignalRelay>(aliceD1, "call:signal");
  bob.emit("call:signal", { callId, toUserId: ALICE, data: "x".repeat(300 * 1024) });
  check((await bigSig) === null, "oversized (>256KiB) signal is dropped");

  // --- end routing + reason sanitizing -------------------------------------------
  const a1End = waitFor<EndRelay>(aliceD1, "call:end");
  bob.emit("call:end", { callId, toUserId: ALICE, reason: "not-a-reason" });
  const e1 = await a1End;
  check(e1?.reason === "ended", "unknown end reason sanitized to 'ended'");

  const a1End2 = waitFor<EndRelay>(aliceD1, "call:end");
  bob.emit("call:end", { callId, toUserId: ALICE, reason: "cancelled" });
  check((await a1End2)?.reason === "cancelled", "cancel relays to callee devices");

  // --- offline fast-fail -----------------------------------------------------------
  aliceD1.disconnect();
  aliceD2.disconnect();
  await sleep(400);
  const offlineAck = await emitWithAck<InviteAck>(bob, "call:invite", {
    callId: "offline-" + Date.now(),
    groupId: dmId,
    video: false,
  });
  check(
    offlineAck?.ok === false && offlineAck.reason === "offline",
    "invite to a fully-offline callee → offline",
  );

  for (const s of [bob, carol]) s.disconnect();

  // Cleanup: drop the harness users' membership/read rows and the test DM
  // (message rows cascade… they don't — delete them explicitly, best-effort).
  try {
    const pool = getPool();
    await pool.query(`DELETE FROM message WHERE group_id = $1`, [dmId]);
    await pool.query(`DELETE FROM group_member WHERE user_id = ANY($1)`, [
      [ALICE, BOB, CAROL],
    ]);
    await pool.query(`DELETE FROM read_cursor WHERE user_id = ANY($1)`, [
      [ALICE, BOB, CAROL],
    ]);
    await pool.query(`DELETE FROM "group" WHERE id = $1`, [dmId]);
    await pool.end();
  } catch (e) {
    console.warn("cleanup skipped:", (e as Error).message);
  }

  console.log("\n" + results.join("\n"));
  const ok = results.every((r) => r.startsWith("PASS"));
  console.log("\n" + (ok ? "ALL PASS ✅" : "SOME FAILED ❌"));
  process.exit(ok ? 0 : 1);
}

void main();
