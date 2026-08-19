// A group is visible to exactly its member roster — and to nobody else.
//
// Groups used to be Slack-shaped: anything not explicitly marked private was
// readable by the whole workspace, announced to every socket on creation, and
// handed to every user in their connect snapshot. Creating a group therefore
// put it in the sidebar of people who had never been added to it, and opening
// one silently made you a member.
//
// Membership is now the only gate (store.canAccess), so this pins down the
// negative space: C is never invited to anything, and must not learn the group
// exists — not from the creation broadcast, not from their roster, not by
// guessing the id and joining, and they must not be able to write to it.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/group-visibility-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const A = "gvis-a@test"; // creates the group
const B = "gvis-b@test"; // invited at creation
const C = "gvis-c@test"; // never invited to anything

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

type Roster = { groups: { id: string; type: string }[] };
type GroupEvt = { group: { id: string; name: string } };
type CreateAck = { ok: boolean; groupId?: string; error?: string };
type OpAck = { ok: boolean; error?: string };

/** A connected socket plus the connect-time roster snapshot it was sent. The
 *  listener is attached before the connect resolves, so the snapshot can't be
 *  missed. */
async function connect(uid: string): Promise<{ s: Socket; roster: Promise<Roster | null> }> {
  const jwt = await encode({
    token: { uid, name: uid },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
  const s = io(URL, {
    transports: ["websocket"],
    extraHeaders: { cookie: `authjs.session-token=${jwt}` },
    forceNew: true,
  });
  const roster = waitFor<Roster>(s, "groups:list", 6000);
  await new Promise<void>((resolve, reject) => {
    s.on("connect", () => resolve());
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 6000);
  });
  return { s, roster };
}

/** Next payload for `event`, or null if none arrives in `ms`. */
function waitFor<T>(s: Socket, event: string, ms = 2000): Promise<T | null> {
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

function emitAck<T>(s: Socket, event: string, payload: unknown, ms = 5000): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.emit(event, payload, (res: T) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

const has = (r: Roster | null, id: string) =>
  (r?.groups ?? []).some((g) => g.id === id);

async function main() {
  const { s: a } = await connect(A);
  const { s: b } = await connect(B);
  const { s: c } = await connect(C);
  await sleep(400); // each socket joins its user:<uid> room

  const stamp = Date.now();

  // --- creation ---------------------------------------------------------------

  const empty = await emitAck<CreateAck>(a, "group:create", {
    name: `gvis-empty-${stamp}`,
    memberIds: [],
  });
  check(
    empty?.ok === false,
    `a group with nobody in it is refused (${empty?.error ?? "no error"})`,
  );

  // Both listeners armed BEFORE the create: the announcement is the moment the
  // leak used to happen.
  const bCreated = waitFor<GroupEvt>(b, "group:created", 3000);
  const cCreated = waitFor<GroupEvt>(c, "group:created", 3000);
  const mk = await emitAck<CreateAck>(a, "group:create", {
    name: `gvis-${stamp}`,
    topic: "group visibility harness",
    memberIds: [B],
  });
  const groupId = mk?.groupId ?? "";
  check(!!groupId, `A created a group with B (${groupId})`);
  check((await bCreated)?.group.id === groupId, "the invited member is told about it");
  check((await cCreated) === null, "an uninvited user is NOT told about it");

  // --- the roster snapshot ----------------------------------------------------

  const { s: b2, roster: bRoster } = await connect(B);
  const { s: c2, roster: cRoster } = await connect(C);
  const bSnap = await bRoster;
  const cSnap = await cRoster;
  check(has(bSnap, groupId), "a member's connect snapshot contains the group");
  check(
    cSnap !== null && !has(cSnap, groupId),
    `an uninvited user's snapshot does not (${cSnap?.groups.length ?? 0} conversations)`,
  );

  // --- guessing the id --------------------------------------------------------

  a.emit("message:send", { groupId, text: `hello-${stamp}`, clientId: `c-${stamp}` });
  await sleep(500);

  const bReplay = waitFor(b2, "history:replay", 2500);
  b2.emit("group:join", { groupId });
  check((await bReplay) !== null, "a member who opens the group gets its history");

  const cReplay = waitFor(c2, "history:replay", 2500);
  c2.emit("group:join", { groupId });
  check(
    (await cReplay) === null,
    "joining by id replays nothing to a non-member (and grants nothing)",
  );

  // Joining used to auto-enrol the joiner. If it still did, C would now be on
  // the roster — and would receive this message.
  const bLeak = waitFor(b, "message:new", 2000);
  c2.emit("message:send", { groupId, text: `intruder-${stamp}`, clientId: `i-${stamp}` });
  check((await bLeak) === null, "a non-member cannot post into the group");

  const cManage = await emitAck<OpAck>(c2, "group:addMember", { groupId, userId: C });
  check(cManage?.ok === false, "a non-member cannot add themselves");
  const cDelete = await emitAck<OpAck>(c2, "group:delete", { groupId });
  check(cDelete?.ok === false, "a non-member cannot delete the group");

  // --- removal ----------------------------------------------------------------

  const bRemoved = waitFor<{ groupId: string }>(b, "group:deleted", 3000);
  a.emit("group:removeMember", { groupId, userId: B }, () => {});
  check((await bRemoved)?.groupId === groupId, "a removed member is told to drop it");

  const { s: b3, roster: b3Roster } = await connect(B);
  const b3Snap = await b3Roster;
  check(
    b3Snap !== null && !has(b3Snap, groupId),
    "and it's gone from their next connect snapshot",
  );

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  for (const s of [a, b, c, b2, c2, b3]) s.close();
  for (const t of ["message", "reaction", "pin", "read_cursor", "group_member"]) {
    await getPool().query(`DELETE FROM ${t} WHERE group_id = $1`, [groupId]);
  }
  await getPool().query(`DELETE FROM "group" WHERE id = $1`, [groupId]);
  await getPool().end();
  process.exit(failed ? 1 : 0);
}

void main();
