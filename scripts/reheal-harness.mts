// DM self-heal ("reheal") relay harness: verifies the SERVER routing added for
// dm:reheal:request / dm:reheal:offer against the real server (socket.io) — the
// security-relevant part. A request must reach the DM peer AND the requester's
// own other devices, but NOT a third party; an offer must reach only the
// requester's devices. (The client-side authorize + re-encrypt lives in
// chat-context/React and is not runnable here — same limitation as other
// chat-context logic; it's covered by code review + browser use.)
//
// Run: npx tsx --env-file=.env.local scripts/reheal-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const ALICE = "reheal-alice@test";
const BOB = "reheal-bob@test";
const CAROL = "reheal-carol@test";

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

type Req = { channelId: string; msgId: string; fromUserId: string };
type Offer = { channelId: string; msgId: string; enc: string };

async function main() {
  const aliceD1 = await connect(ALICE);
  const aliceD2 = await connect(ALICE); // Alice's SECOND device (same uid)
  const bob = await connect(BOB);
  const carol = await connect(CAROL);
  await sleep(400); // let each socket join its user:<uid> room

  const msgId = "reheal-test-" + Date.now();
  const channelId = "dm-" + BOB; // Alice's view of the DM with Bob

  // --- request routing ------------------------------------------------------
  const bobReq = waitFor<Req>(bob, "dm:reheal:request");
  const aliceD2Req = waitFor<Req>(aliceD2, "dm:reheal:request");
  const aliceD1Req = waitFor<Req>(aliceD1, "dm:reheal:request"); // sender: none
  const carolReq = waitFor<Req>(carol, "dm:reheal:request");
  aliceD1.emit("dm:reheal:request", { channelId, msgId, peerId: BOB });

  const [rBob, rA2, rA1, rCarol] = await Promise.all([
    bobReq,
    aliceD2Req,
    aliceD1Req,
    carolReq,
  ]);
  check(rBob?.fromUserId === ALICE && rBob?.msgId === msgId, "peer (Bob) receives request w/ fromUserId=Alice");
  check(rA2?.fromUserId === ALICE, "Alice's OTHER device receives request");
  check(rA1 === null, "requesting device does NOT receive its own request");
  check(rCarol === null, "third party (Carol) does NOT receive request");

  // --- offer routing --------------------------------------------------------
  const enc = "ENVELOPE-CIPHERTEXT-" + msgId;
  const aliceD1Off = waitFor<Offer>(aliceD1, "dm:reheal:offer");
  const aliceD2Off = waitFor<Offer>(aliceD2, "dm:reheal:offer");
  const bobOff = waitFor<Offer>(bob, "dm:reheal:offer"); // responder: none
  const carolOff = waitFor<Offer>(carol, "dm:reheal:offer");
  bob.emit("dm:reheal:offer", { channelId, msgId, toUserId: ALICE, enc });

  const [oA1, oA2, oBob, oCarol] = await Promise.all([
    aliceD1Off,
    aliceD2Off,
    bobOff,
    carolOff,
  ]);
  check(oA1?.enc === enc && oA1?.msgId === msgId, "requester device receives offer w/ enc");
  check(oA2?.enc === enc, "requester's other device receives offer");
  check(oBob === null, "responder (Bob) does NOT receive its own offer");
  check(oCarol === null, "third party (Carol) does NOT receive offer");

  for (const s of [aliceD1, aliceD2, bob, carol]) s.disconnect();

  // cleanup: connecting auto-joins default channels — drop the test users' rows.
  try {
    const pool = getPool();
    await pool.query(
      `DELETE FROM channel_member WHERE user_id = ANY($1)`,
      [[ALICE, BOB, CAROL]],
    );
    await pool.query(
      `DELETE FROM read_cursor WHERE user_id = ANY($1)`,
      [[ALICE, BOB, CAROL]],
    );
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
