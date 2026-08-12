// DM pair-id harness: two different people DM the same recipient, and the
// recipient must end up with TWO separate conversations — the bug this covers
// keyed a DM by the recipient alone, so B→A and C→A collapsed into one thread
// (A saw C's messages inside the chat with B, and each sender sealed E2EE
// payloads to whichever member it guessed was "the other one").
//
// Also checks the two properties that follow from a pair-derived id: A→B and
// B→A are the SAME conversation (no duplicate half-threads), and a DM refuses
// a third member.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/dm-pair-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";
import { dmIdFor } from "../src/lib/dm-id.ts";

const URL = "http://localhost:4000";
const A = "dmpair-a@test"; // the recipient (plays "chris")
const B = "dmpair-b@test"; // plays "wuewue17"
const C = "dmpair-c@test"; // plays the second account

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
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 6000);
  });
  return s;
}

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

type Msg = { groupId: string; message: { text: string; author: { name: string } } };
type Group = { group: { id: string; type: string; user?: { id: string } } };

async function main() {
  const a = await connect(A);
  const b = await connect(B);
  const c = await connect(C);
  await sleep(400); // let each socket join its user:<uid> room

  // Everything A is told about, from the moment both senders start.
  const aMsgs: Msg[] = [];
  const aGroups: Group["group"][] = [];
  a.on("message:new", (p: Msg) => aMsgs.push(p));
  a.on("group:created", (p: Group) => aGroups.push(p.group));

  const stamp = Date.now();
  b.emit("dm:create", { recipientId: A, text: `from-b-${stamp}`, clientId: "b1" });
  await sleep(500);
  c.emit("dm:create", { recipientId: A, text: `from-c-${stamp}`, clientId: "c1" });
  await sleep(700);

  const dmAB = dmIdFor(A, B);
  const dmAC = dmIdFor(A, C);
  const fromB = aMsgs.find((m) => m.message.text === `from-b-${stamp}`);
  const fromC = aMsgs.find((m) => m.message.text === `from-c-${stamp}`);

  check(!!fromB && !!fromC, "A receives both senders' messages");
  check(dmAB !== dmAC, "the two DMs have different ids");
  check(fromB?.groupId === dmAB, `B's message lands in the A↔B DM (${dmAB})`);
  check(fromC?.groupId === dmAC, `C's message lands in the A↔C DM (${dmAC})`);
  check(
    fromB?.groupId !== fromC?.groupId,
    "C's message does NOT appear in A's chat with B (the reported bug)",
  );

  // A's roster entry for each DM must name the right peer — that's what the
  // avatar/header render from, and what the client seals to.
  const gAB = aGroups.find((g) => g.id === dmAB);
  const gAC = aGroups.find((g) => g.id === dmAC);
  check(gAB?.user?.id === B, "A's A↔B roster entry names B as the peer");
  check(gAC?.user?.id === C, "A's A↔C roster entry names C as the peer");

  // Symmetry: A replying by composing a *new* DM to B must reuse the same
  // conversation, not open a second half-thread keyed the other way.
  const bMsgs: Msg[] = [];
  b.on("message:new", (p: Msg) => bMsgs.push(p));
  a.emit("dm:create", { recipientId: B, text: `from-a-${stamp}`, clientId: "a1" });
  await sleep(600);
  const fromA = bMsgs.find((m) => m.message.text === `from-a-${stamp}`);
  check(fromA?.groupId === dmAB, "A→B reuses the existing A↔B DM (id is symmetric)");

  // A DM is 1:1: the roster must reject a third member however it's attempted.
  a.emit("group:addMember", { groupId: dmAB, userId: C }, () => {});
  await sleep(500);
  const mem = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM group_member WHERE group_id = $1`,
    [dmAB],
  );
  check(mem.rows[0].n === 2, "a DM refuses a third member (stays 1:1)");

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  // Clean up this harness's DMs so they don't linger in anyone's sidebar.
  for (const id of [dmAB, dmAC]) {
    for (const t of ["message", "reaction", "pin", "read_cursor", "group_member"]) {
      await getPool().query(`DELETE FROM ${t} WHERE group_id = $1`, [id]);
    }
    await getPool().query(`DELETE FROM "group" WHERE id = $1`, [id]);
  }
  a.close();
  b.close();
  c.close();
  await getPool().end();
  process.exit(failed ? 1 : 0);
}

void main();
