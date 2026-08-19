// A group's durable state must reach every member, not only the members who
// happen to be looking at that group.
//
// The group room (`socket.join(groupId)`) is joined when a client OPENS a
// conversation, so it means "currently viewing" — that's why messages are
// delivered to member user-rooms instead (see memberRooms in server.ts). Pins,
// reactions, roster edits and deletion were still broadcast to the room, so a
// member reading another conversation kept stale state until they reloaded:
// unpinning left the pinned bar up for everyone else.
//
// B here is a member who never opens the group — connected, in no group room.
// The last check is a negative control: typing genuinely IS viewing-only and
// must NOT reach B.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/group-state-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const A = "gstate-a@test"; // creates the group, pins, reacts, deletes
const B = "gstate-b@test"; // a member who never opens it

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);

async function connect(uid: string): Promise<Socket> {
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
  await new Promise<void>((resolve, reject) => {
    s.on("connect", () => resolve());
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 6000);
  });
  return s;
}

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

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

type Pins = { groupId: string; pinIds: string[] };
type Reactions = { groupId: string; msgId: string; reactions: { e: string }[] };
type GroupEvt = { group: { id: string; name: string } };

async function main() {
  const a = await connect(A);
  const b = await connect(B);
  await sleep(400); // each socket joins its user:<uid> room

  const stamp = Date.now();
  // Groups are member-only, so this exercises member-room routing throughout —
  // there is no whole-workspace broadcast to fall back on.
  const created = waitFor<GroupEvt>(b, "group:created");
  const groupId = await new Promise<string>((resolve, reject) => {
    a.emit(
      "group:create",
      {
        name: `gstate-${stamp}`,
        topic: "group state harness",
        memberIds: [B],
      },
      (res: { ok: boolean; groupId?: string }) =>
        res.ok && res.groupId
          ? resolve(res.groupId)
          : reject(new Error("create failed")),
    );
  });
  const createdEvt = await created;
  check(
    createdEvt?.group.id === groupId,
    "B is told about a group it was created into",
  );
  // B deliberately never emits group:join — it is a member, not a viewer.

  const msgId = await new Promise<string>((resolve, reject) => {
    a.on("message:ack", (p: { message: { id: string } }) => resolve(p.message.id));
    a.emit("message:send", { groupId, text: `msg-${stamp}`, clientId: `c-${stamp}` });
    setTimeout(() => reject(new Error("no ack")), 6000);
  });

  const onPin = waitFor<Pins>(b, "pins:updated");
  a.emit("pin:toggle", { groupId, msgId });
  const pinned = await onPin;
  check(pinned?.pinIds.includes(msgId) === true, "a pin reaches a non-viewing member");

  const onUnpin = waitFor<Pins>(b, "pins:updated");
  a.emit("pin:toggle", { groupId, msgId });
  const unpinned = await onUnpin;
  check(
    unpinned !== null && unpinned.pinIds.length === 0,
    "an unpin reaches a non-viewing member (the reported bug)",
  );

  // "Unpin all" (the pinned bar's dismiss) clears every pin in one event.
  a.emit("pin:toggle", { groupId, msgId });
  await sleep(300);
  const onClear = waitFor<Pins>(b, "pins:updated");
  a.emit("pins:clear", { groupId });
  const cleared = await onClear;
  check(
    cleared !== null && cleared.pinIds.length === 0,
    "pins:clear empties the pin list for a non-viewing member",
  );

  const onReaction = waitFor<Reactions>(b, "reaction:updated");
  a.emit("reaction:toggle", { groupId, msgId, emoji: "👍" });
  const reacted = await onReaction;
  check(
    reacted?.reactions.some((r) => r.e === "👍") === true,
    "a reaction reaches a non-viewing member",
  );

  // Re-pin, then delete the message: the delete must also clear the pin for B.
  a.emit("pin:toggle", { groupId, msgId });
  await sleep(300);
  const onDeletePins = waitFor<Pins>(b, "pins:updated");
  a.emit("message:delete", { groupId, msgId, parentId: null });
  const afterDelete = await onDeletePins;
  check(
    afterDelete !== null && afterDelete.pinIds.length === 0,
    "deleting a pinned message clears the pin for a non-viewing member",
  );

  const onUpdated = waitFor<GroupEvt>(b, "group:updated");
  a.emit("group:update", { groupId, name: `gstate-${stamp}-renamed` }, () => {});
  const updated = await onUpdated;
  check(
    updated?.group.name === `gstate-${stamp}-renamed`,
    "a rename reaches a non-viewing member",
  );

  // Negative control: typing is a viewing-only signal and must stay room-scoped.
  const onTyping = waitFor(b, "typing:update", 1200);
  a.emit("typing:start", { groupId });
  check(
    (await onTyping) === null,
    "typing does NOT leak to a member who isn't viewing",
  );

  const onDeleted = waitFor<{ groupId: string }>(b, "group:deleted");
  a.emit("group:delete", { groupId }, () => {});
  check((await onDeleted)?.groupId === groupId, "deletion reaches a non-viewing member");

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  a.close();
  b.close();
  for (const t of ["message", "reaction", "pin", "read_cursor", "group_member"]) {
    await getPool().query(`DELETE FROM ${t} WHERE group_id = $1`, [groupId]);
  }
  await getPool().query(`DELETE FROM "group" WHERE id = $1`, [groupId]);
  await getPool().end();
  process.exit(failed ? 1 : 0);
}

void main();
