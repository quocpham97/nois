// Call signaling relay harness: verifies the SERVER rules for calls — the
// security- and abuse-relevant parts — against the real server (socket.io).
//
// A call is a socket room, `call:<groupId>:<callId>`, and every rule below is
// derived from the group's roster or the room's occupancy rather than from any
// per-call server state. What must hold:
//   - only MEMBERS may start or join a call — and since groups are member-only,
//     a non-member can't so much as see the conversation to try
//   - who rings: the members who are ONLINE, when they'd all fit in the call.
//     A roster is a poor proxy for reachability — a 40-person group with three
//     people online is a three-person group as far as a call is concerned — and
//     the cap is what stops any group becoming a notification cannon
//   - video follows presence the same way, and because people can come online
//     mid-call the video cap (4) is enforced at JOIN rather than guaranteed by
//     the group's size
//   - the participant cap is enforced by what the call CARRIES — 4 video, 6
//     voice — and refusals are counted
//   - one device per user per call: a second device DISPLACES the first, and the
//     displacement is ordered ahead of the new device's announcement (that
//     ordering is the entire self-echo guarantee)
//   - signaling is addressed per DEVICE, never fanned out to a user's devices
//
// (The WebRTC engine itself lives in call-context/React; the mesh is covered
// end-to-end by scripts/group-call-harness.mts in real browsers.)
//
// Run: npx tsx --env-file=.env.local scripts/call-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";
import { dmIdFor } from "../src/lib/dm-id.ts";

const URL = "http://localhost:4000";
const ALICE = "call-alice@test";
const BOB = "call-bob@test";
const CAROL = "call-carol@test";
/** Extra bodies for the capacity + huddle rules. */
const CROWD = ["d", "e", "f", "g", "h"].map((c) => `call-${c}@test`);
const ALL = [ALICE, BOB, CAROL, ...CROWD];

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

/** Connect and announce a device id (call signaling is addressed per device). */
async function connect(uid: string, deviceId: string): Promise<Socket> {
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
  s.emit("device:announce", { deviceId });
  return s;
}

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

/** Resolve with the next payload for `event`, or null if none arrives in `ms`. */
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

/** Record the ORDER of events on a socket — some guarantees are about sequence. */
function record(s: Socket, events: string[]): { log: string[] } {
  const log: string[] = [];
  for (const e of events) {
    s.on(e, (p: Record<string, unknown>) => {
      log.push(`${e}:${(p.deviceId as string) ?? (p.userId as string) ?? ""}`);
    });
  }
  return { log };
}

function emitWithAck<T>(s: Socket, event: string, payload: unknown, ms = 5000): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.emit(event, payload, (res: T) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

type StartResult =
  | { ok: true; callId: string; video: boolean; ringing: boolean }
  | { ok: false; reason: string };
type JoinResult =
  | { ok: true; participants: { userId: string; deviceId: string }[]; video: boolean }
  | { ok: false; reason: string };
type InviteRelay = { callId: string; groupId: string; fromUserId: string; video: boolean };
type SignalRelay = { callId: string; fromUserId: string; fromDeviceId: string; data: string };

async function makeGroup(
  s: Socket,
  name: string,
  memberIds: string[],
): Promise<string> {
  const res = await emitWithAck<{ ok: boolean; groupId?: string }>(s, "group:create", {
    name,
    topic: "call harness",
    memberIds,
  });
  if (!res?.ok || !res.groupId) throw new Error(`group:create failed for ${name}`);
  await sleep(250);
  return res.groupId;
}

async function main() {
  const aliceD1 = await connect(ALICE, "alice-d1");
  const aliceD2 = await connect(ALICE, "alice-d2"); // Alice's SECOND device
  const bob = await connect(BOB, "bob-d1");
  const carol = await connect(CAROL, "carol-d1");
  const crowd = await Promise.all(
    CROWD.map((uid, i) => connect(uid, `crowd-d${i}`)),
  );
  await sleep(500); // let each socket join its user:/device: rooms

  // Establish a real DM Bob↔Alice (call:start validates membership).
  bob.emit("dm:create", {
    recipientId: ALICE,
    text: "call harness setup",
    clientId: "call-harness-" + Date.now(),
  });
  const ackMsg = await waitFor(bob, "message:ack", 3000);
  check(ackMsg !== null, "setup: DM Bob→Alice created");
  const dmId = dmIdFor(BOB, ALICE);
  await sleep(200);

  // --- authorization ----------------------------------------------------------

  const carolStart = await emitWithAck<StartResult>(carol, "call:start", {
    groupId: dmId,
    video: false,
  });
  check(
    carolStart?.ok === false && carolStart.reason === "unauthorized",
    "starting a call in a DM you don't belong to → unauthorized",
  );

  const nowhereStart = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: "not-a-group-" + Date.now(),
    video: false,
  });
  check(
    nowhereStart?.ok === false && nowhereStart.reason === "unauthorized",
    "starting a call in a group that doesn't exist → unauthorized",
  );

  // --- DM: ring fanout --------------------------------------------------------

  const a1Inv = waitFor<InviteRelay>(aliceD1, "call:invite");
  const a2Inv = waitFor<InviteRelay>(aliceD2, "call:invite");
  const carolInv = waitFor<InviteRelay>(carol, "call:invite");
  const bobInv = waitFor<InviteRelay>(bob, "call:invite"); // starter: none
  const start = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: dmId,
    video: true,
  });
  check(start?.ok === true && !!start.callId, "valid start acks ok with a callId");
  const callId = start?.ok ? start.callId : "";
  check(start?.ok === true && start.ringing === true, "a DM rings");
  check(start?.ok === true && start.video === true, "a DM (2 members) may use video");
  const [iA1, iA2, iCarol, iBob] = await Promise.all([a1Inv, a2Inv, carolInv, bobInv]);
  check(
    iA1?.fromUserId === BOB && iA1?.callId === callId && iA1?.video === true,
    "callee device 1 rings (fromUserId=Bob, video=true)",
  );
  check(iA2?.fromUserId === BOB, "callee device 2 rings too");
  check(iCarol === null, "third party (Carol) does NOT ring");
  check(iBob === null, "the starter does NOT receive its own invite");

  // --- join: roster, handled fanout ------------------------------------------

  const bobJoined = waitFor<{ userId: string; deviceId: string }>(bob, "call:joined");
  const a2Handled = waitFor<{ callId: string }>(aliceD2, "call:handled");
  const join = await emitWithAck<JoinResult>(aliceD1, "call:join", { callId, groupId: dmId });
  check(
    join?.ok === true && join.participants.some((p) => p.deviceId === "bob-d1"),
    "join returns the devices already in the call",
  );
  const [jBob, hA2] = await Promise.all([bobJoined, a2Handled]);
  check(
    jBob?.deviceId === "alice-d1" && jBob?.userId === ALICE,
    "the incumbent is told which DEVICE joined",
  );
  check(hA2?.callId === callId, "the answerer's OTHER device stops ringing (call:handled)");

  // --- per-device signal routing ---------------------------------------------

  const sdp = JSON.stringify({ type: "offer", sdp: "v=0 FAKE-SDP" });
  const a1Sig = waitFor<SignalRelay>(aliceD1, "call:signal");
  const a2Sig = waitFor<SignalRelay>(aliceD2, "call:signal");
  const carolSig = waitFor<SignalRelay>(carol, "call:signal");
  bob.emit("call:signal", { callId, toDeviceId: "alice-d1", data: sdp });
  const [sA1, sA2, sCarol] = await Promise.all([a1Sig, a2Sig, carolSig]);
  check(
    sA1?.data === sdp && sA1?.fromUserId === BOB && sA1?.fromDeviceId === "bob-d1",
    "an offer reaches the addressed device, tagged with the sender's device",
  );
  check(
    sA2 === null,
    "the SAME USER's other device does NOT receive it (per-device routing)",
  );
  check(sCarol === null, "third party does NOT see signaling");

  const bigSig = waitFor<SignalRelay>(aliceD1, "call:signal");
  bob.emit("call:signal", { callId, toDeviceId: "alice-d1", data: "x".repeat(300 * 1024) });
  check((await bigSig) === null, "oversized (>256KiB) signal is dropped");

  // --- device migration, ORDERED ---------------------------------------------
  // Bob is the incumbent; Alice joins from her second device. Her first device
  // must be kicked and its call:left must reach Bob BEFORE Bob hears about the
  // new device — otherwise Bob briefly holds legs to both and the two devices
  // feed back acoustically.
  const bobOrder = record(bob, ["call:left", "call:joined"]);
  const a1Kicked = waitFor<{ reason: string }>(aliceD1, "call:kicked");
  const join2 = await emitWithAck<JoinResult>(aliceD2, "call:join", { callId, groupId: dmId });
  const kicked = await a1Kicked;
  await sleep(400);
  check(
    kicked?.reason === "joined_on_another_device",
    "joining from a second device kicks the first",
  );
  check(
    join2?.ok === true && !join2.participants.some((p) => p.userId === ALICE),
    "the new device's roster excludes its own displaced sibling",
  );
  const leftIdx = bobOrder.log.indexOf("call:left:alice-d1");
  const joinedIdx = bobOrder.log.indexOf("call:joined:alice-d2");
  check(
    leftIdx >= 0 && joinedIdx >= 0 && leftIdx < joinedIdx,
    `the displacement is ordered BEFORE the new device (${bobOrder.log.join(" → ") || "nothing"})`,
  );

  // --- leaving ----------------------------------------------------------------

  const bobLeft = waitFor<{ deviceId: string }>(bob, "call:left");
  aliceD2.emit("call:leave", { callId, groupId: dmId });
  check((await bobLeft)?.deviceId === "alice-d2", "leaving broadcasts call:left to the room");
  const bobOver = waitFor<{ callId: string }>(bob, "call:over", 2500);
  bob.emit("call:leave", { callId, groupId: dmId });
  check((await bobOver)?.callId === callId, "the last participant out ends the call (call:over)");

  // --- who rings: the ONLINE members, when they'd all fit in the call ----------

  const smallGroup = await makeGroup(bob, "call-small-" + Date.now(), [ALICE, CAROL]);
  const smallInv = waitFor<InviteRelay>(aliceD1, "call:invite");
  const smallStart = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: smallGroup,
    video: true,
  });
  check(
    smallStart?.ok === true && smallStart.ringing === true,
    "a group of 3 with everyone online rings them",
  );
  check(
    smallStart?.ok === true && smallStart.video === true,
    "3 people online may use video (≤4)",
  );
  check((await smallInv) !== null, "a member's device actually rings");
  if (smallStart?.ok) bob.emit("call:leave", { callId: smallStart.callId, groupId: smallGroup });

  const bigGroup = await makeGroup(bob, "call-big-" + Date.now(), [
    ALICE,
    CAROL,
    ...CROWD,
  ]);
  // A huddle has to be discoverable, since nothing rings: the conversation-level
  // "ongoing call" event is what puts the Join bar in front of people who have
  // the group open.
  aliceD1.emit("group:join", { groupId: bigGroup });
  await sleep(250);
  const bigInv = waitFor<InviteRelay>(aliceD1, "call:invite", 1200);
  const bigLive = waitFor<{ groupId: string; callId: string; video: boolean }>(
    aliceD1,
    "call:ongoing",
    2000,
  );
  const bigStart = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: bigGroup,
    video: true,
  });
  check(
    bigStart?.ok === true && bigStart.ringing === false,
    "8 members all online is past the cap — a huddle, so nobody rings",
  );
  check(
    bigStart?.ok === true && bigStart.video === false,
    "8 people online is voice-only — past the video cap",
  );
  check((await bigInv) === null, "no member's device rings for a huddle");
  const live = await bigLive;
  check(
    live?.groupId === bigGroup && live?.video === false,
    "a huddle is announced to the conversation instead (call:ongoing)",
  );

  // (A "public group rings too" case lived here. Groups are member-only now —
  // there is no privacy flag left for ringing to be independent of, and it was
  // otherwise a duplicate of the small-group case above.)

  // The case the whole rule exists for: a group far past the cap on paper, but
  // with almost nobody actually connected. Under a roster-counted rule this was
  // a silent huddle; counting who can answer, it rings the one person who can.
  const dormant = ["z1", "z2", "z3", "z4", "z5"].map((c) => `call-${c}@offline`);
  const dormantGroup = await makeGroup(bob, "call-dormant-" + Date.now(), [
    ALICE,
    ...dormant,
  ]);
  const dormantInv = waitFor<InviteRelay>(aliceD1, "call:invite");
  const dormantStart = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: dormantGroup,
    video: false,
  });
  check(
    dormantStart?.ok === true && dormantStart.ringing === true,
    "a 7-member group with one member online RINGS that member",
  );
  check(
    (await dormantInv) !== null,
    "the online member's device is the one that rings",
  );
  if (dormantStart?.ok) {
    bob.emit("call:leave", { callId: dormantStart.callId, groupId: dormantGroup });
  }

  // --- capacity ----------------------------------------------------------------
  // The huddle group has 8 members; the cap is 6, so the 7th join is refused.
  const bigCallId = bigStart?.ok ? bigStart.callId : "";
  const joiners = [aliceD1, carol, ...crowd]; // 7 devices joining Bob's call
  const joinResults: (JoinResult | null)[] = [];
  for (const s of joiners) {
    joinResults.push(
      await emitWithAck<JoinResult>(s, "call:join", { callId: bigCallId, groupId: bigGroup }),
    );
  }
  const admitted = joinResults.filter((r) => r?.ok).length;
  check(admitted === 5, `the cap admits 6 in total including the starter (admitted ${admitted})`);
  check(
    joinResults.some((r) => r?.ok === false && r.reason === "full"),
    "joining a full call is refused with reason=full",
  );

  // Everyone out (also releases the room for the next run).
  for (const s of joiners) s.emit("call:leave", { callId: bigCallId, groupId: bigGroup });
  bob.emit("call:leave", { callId: bigCallId, groupId: bigGroup });
  await sleep(300);

  // --- joining is member-only too ----------------------------------------------
  const privateStart = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: smallGroup,
    video: false,
  });
  const outsider = crowd[0]; // not a member of smallGroup
  const outsiderJoin = await emitWithAck<JoinResult>(outsider, "call:join", {
    callId: privateStart?.ok ? privateStart.callId : "",
    groupId: smallGroup,
  });
  check(
    outsiderJoin?.ok === false && outsiderJoin.reason === "unauthorized",
    "a non-member cannot join a private group's call",
  );
  const goneJoin = await emitWithAck<JoinResult>(aliceD1, "call:join", {
    callId: "no-such-call",
    groupId: smallGroup,
  });
  check(
    goneJoin?.ok === false && goneJoin.reason === "gone",
    "joining a call that isn't running → gone",
  );
  // --- SFU proxy authorization (phase C) ---------------------------------------
  // The Cloudflare app token is app-wide, so the server proxies every SFU call
  // and is the only thing standing between a member and someone else's media.
  // These assert the gate, not the media path — the latter needs a real SFU app
  // (see docs/calls-production.md).
  type SfuResult = { ok: true; sessionId?: string } | { ok: false; reason: string };
  if (privateStart?.ok) {
    const sfuCallId = privateStart.callId;
    // Bob started it, so he IS in the room; Carol is a member who never joined.
    const outsiderSfu = await emitWithAck<SfuResult>(carol, "sfu:session", {
      groupId: smallGroup,
      callId: sfuCallId,
    });
    check(
      outsiderSfu?.ok === false && outsiderSfu.reason === "unauthorized",
      `a group member not IN the call cannot open an SFU session (${outsiderSfu?.ok === false ? outsiderSfu.reason : "allowed"})`,
    );
    // Naming a session you did not create is the `tracks/close` abuse
    // Cloudflare's docs warn about; it must be refused before any upstream call.
    const forged = await emitWithAck<SfuResult>(bob, "sfu:tracks", {
      groupId: smallGroup,
      callId: sfuCallId,
      sessionId: "someone-elses-session",
      body: { tracks: [] },
    });
    check(
      forged?.ok === false && forged.reason === "unauthorized",
      `a session id the socket never opened is refused (${forged?.ok === false ? forged.reason : "allowed"})`,
    );
    // Positive control: Bob IS in the call, so he clears the gate and only the
    // missing Cloudflare app stops him. Without this the two checks above would
    // also pass if the guard were rejecting everything unconditionally.
    const allowed = await emitWithAck<SfuResult>(bob, "sfu:session", {
      groupId: smallGroup,
      callId: sfuCallId,
    });
    check(
      allowed?.ok === true || (allowed?.ok === false && allowed.reason === "unconfigured"),
      `a participant clears the gate (${allowed?.ok ? "session opened" : (allowed?.reason ?? "no ack")})`,
    );
    bob.emit("call:leave", { callId: sfuCallId, groupId: smallGroup });
  }

  // --- a video call cannot outgrow its cap --------------------------------------
  // Video eligibility follows presence now, so the group can no longer guarantee
  // the cap on its own: people who were offline when the call started can come
  // online, see the banner and join. The ceiling has to hold at JOIN instead.
  const growGroup = await makeGroup(bob, "call-grow-" + Date.now(), [
    ALICE,
    CAROL,
    CROWD[0],
    CROWD[1],
  ]);
  // Everyone except Alice steps away, so the call is offered video.
  carol.disconnect();
  crowd[0].disconnect();
  crowd[1].disconnect();
  await sleep(600);
  const growStart = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: growGroup,
    video: true,
  });
  check(
    growStart?.ok === true && growStart.video === true,
    "video is offered when only the ONLINE members would fit under the cap",
  );
  const growCallId = growStart?.ok ? growStart.callId : "";
  // ...and now the absent ones come back and pile in.
  const carolBack = await connect(CAROL, "carol-d1");
  const crowd0Back = await connect(CROWD[0], "crowd-d0");
  const crowd1Back = await connect(CROWD[1], "crowd-d1");
  await sleep(400);
  const growJoins: (JoinResult | null)[] = [];
  for (const s of [aliceD1, carolBack, crowd0Back, crowd1Back]) {
    growJoins.push(
      await emitWithAck<JoinResult>(s, "call:join", { callId: growCallId, groupId: growGroup }),
    );
  }
  const admittedVideo = growJoins.filter((r) => r?.ok).length;
  check(
    admittedVideo === 3,
    `a video call admits 4 in total including the starter (admitted ${admittedVideo})`,
  );
  check(
    growJoins.some((r) => r?.ok === false && r.reason === "full"),
    "the 5th is refused — a video call can't grow past the VIDEO cap, only the voice one",
  );
  for (const s of [aliceD1, carolBack, crowd0Back, crowd1Back]) {
    s.emit("call:leave", { callId: growCallId, groupId: growGroup });
  }
  bob.emit("call:leave", { callId: growCallId, groupId: growGroup });
  await sleep(300);

  // --- crash-leave --------------------------------------------------------------
  const crashStart = await emitWithAck<StartResult>(bob, "call:start", {
    groupId: smallGroup,
    video: false,
  });
  const crashCallId = crashStart?.ok ? crashStart.callId : "";
  await emitWithAck<JoinResult>(aliceD1, "call:join", {
    callId: crashCallId,
    groupId: smallGroup,
  });
  // A dropped socket is usually a BLIP, not a departure: media is
  // peer-to-peer and unaffected, so the seat is held for CALL_DROP_GRACE_MS
  // before the rest of the call is told. Evicting immediately used to end a
  // call that was still perfectly able to carry audio — and cascaded, because
  // one eviction emptied everyone else's roster in turn.
  const noEarlyLeft = waitFor<{ deviceId: string }>(aliceD1, "call:left", 3000);
  bob.disconnect(); // tab closed / network died
  check(
    (await noEarlyLeft) === null,
    "a dropped socket does NOT immediately evict its owner from the call",
  );

  // Back within the grace window: the call carries on and nobody else is told
  // anything except that the seat is occupied again.
  const bobBack = await connect(BOB, "bob-d1");
  const aliceSeesRejoin = waitFor<{ deviceId: string }>(aliceD1, "call:joined", 3000);
  const rejoin = await emitWithAck<JoinResult>(bobBack, "call:rejoin", {
    callId: crashCallId,
    groupId: smallGroup,
  });
  check(rejoin?.ok === true, `a reconnecting device reclaims its seat (${JSON.stringify(rejoin)})`);
  check(
    (await aliceSeesRejoin)?.deviceId === "bob-d1",
    "peers are told to heal the leg, so an expired grace period still recovers",
  );
  const lateLeft = waitFor<{ deviceId: string }>(aliceD1, "call:left", 4000);
  check(
    (await lateLeft) === null,
    "the held seat's timer does not fire after a successful rejoin",
  );

  // Gone for good: past the grace period the eviction lands as it always did.
  const aliceSeesLeft = waitFor<{ deviceId: string }>(aliceD1, "call:left", 15000);
  bobBack.disconnect();
  check(
    (await aliceSeesLeft)?.deviceId === "bob-d1",
    "a socket that stays gone is evicted once the grace period expires",
  );
  aliceD1.emit("call:leave", { callId: crashCallId, groupId: smallGroup });

  for (const s of [aliceD1, aliceD2, carol, carolBack, crowd0Back, crowd1Back, ...crowd]) {
    s.disconnect();
  }

  // Cleanup: harness users' membership/read rows and the test conversations.
  try {
    const pool = getPool();
    const groupIds = [dmId, smallGroup, bigGroup, dormantGroup, growGroup];
    await pool.query(`DELETE FROM message WHERE group_id = ANY($1)`, [groupIds]);
    await pool.query(`DELETE FROM group_member WHERE user_id = ANY($1)`, [[...ALL, ...dormant]]);
    await pool.query(`DELETE FROM read_cursor WHERE user_id = ANY($1)`, [ALL]);
    await pool.query(`DELETE FROM "group" WHERE id = ANY($1)`, [groupIds]);
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
