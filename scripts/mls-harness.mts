// Multi-device MLS harness: drives the full establish → Welcome → join →
// encrypt → decrypt round trip through the REAL server delivery service (over
// socket.io) using the device-granular protocol, modeling what chat-context
// does. Covers: per-device KeyPackages, multi-device fan-out (two devices of
// one user), membership drift (a post-establishment joiner added via a sync
// commit), per-device Welcome drain, keypair export/import persistence,
// removal, and concurrent-commit ordering. Cleans up its DB rows at the end.
//
// Run: npx tsx --env-file=.env.local scripts/mls-harness.mts

import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import * as mls from "../src/lib/crypto/mls.ts";
import { getPool, ensureSchema } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
let CH = ""; // a fresh public group is created per run (avoids stale DS cache)
const ALICE = "mls-alice@test";
const BOB = "mls-bob@test";
const CAROL = "mls-carol@test";
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

const emitAck = <T,>(s: Socket, ev: string, ...args: unknown[]): Promise<T> =>
  new Promise((resolve) => s.timeout(6000).emit(ev, ...args, (_e: unknown, r: T) => resolve(r)));
const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

type MlsState = Awaited<ReturnType<typeof mls.mlsCreateGroup>>;

/** A harness "device": socket + keypair + group state + inbox, wired like the
 *  client — joins on its own Welcome, applies relayed commits in seq order,
 *  decrypts MLS app messages. */
class Device {
  state: MlsState | null = null;
  seq = 0;
  got: string[] = [];
  constructor(
    public user: string,
    public deviceId: string,
    public socket: Socket,
    public kp: mls.MlsKeyPair,
  ) {}

  publish() {
    this.socket.emit("mls:publishKeyPackage", {
      deviceId: this.deviceId,
      keyPackage: mls.mlsEncodeKeyPackage(this.kp.publicPackage),
    });
  }

  /** Wire the live listeners (welcome / commit / message). */
  listen() {
    this.socket.on(
      "mls:welcome",
      async (p: { groupId: string; welcome: string; seq: number; toDeviceId: string }) => {
        if (p.groupId !== CH || this.state || p.toDeviceId !== this.deviceId) return;
        try {
          this.state = await mls.mlsJoinFromWelcome(p.welcome, this.kp);
          this.seq = p.seq;
        } catch {
          /* stale welcome */
        }
      },
    );
    this.socket.on(
      "mls:commit",
      async (p: { groupId: string; seq: number; commit: string }) => {
        if (p.groupId !== CH || !this.state || p.seq <= this.seq) return;
        try {
          this.state = await mls.mlsProcessCommit(this.state, p.commit);
          this.seq = p.seq;
        } catch {
          /* not our epoch (e.g. we authored it) */
        }
      },
    );
    this.socket.on(
      "message:new",
      async (p: { groupId: string; message: { enc?: string } }) => {
        if (p.groupId !== CH || !p.message.enc || !this.state) return;
        try {
          const env = JSON.parse(p.message.enc) as { t?: string; w?: string };
          if (env.t !== "mls" || !env.w) return;
          const res = await mls.mlsDecrypt(this.state, env.w);
          if (res) this.state = res.state;
          if (res?.kind === "application") this.got.push(res.text);
        } catch {
          /* undecryptable for this member (expected post-removal) */
        }
      },
    );
  }
}

async function main() {
  await ensureSchema();
  const aliceD1 = new Device(ALICE, "dev-a1", await connect(ALICE), await mls.mlsGenerateKeyPackage(ALICE, "dev-a1"));
  const aliceD2 = new Device(ALICE, "dev-a2", await connect(ALICE), await mls.mlsGenerateKeyPackage(ALICE, "dev-a2"));
  const bob = new Device(BOB, "dev-b1", await connect(BOB), await mls.mlsGenerateKeyPackage(BOB, "dev-b1"));
  check(true, "three sockets authenticated + connected (alice ×2 devices, bob)");

  // Fresh public group per run; alice + bob join (carol joins later).
  const mk = await emitAck<{ ok: boolean; groupId?: string }>(
    aliceD1.socket, "group:create",
    { name: "mlstest-" + Math.random().toString(36).slice(2, 8) });
  CH = mk?.groupId ?? "";
  check(!!CH, `created fresh test group (${CH})`);
  aliceD1.socket.emit("group:join", { groupId: CH });
  aliceD2.socket.emit("group:join", { groupId: CH });
  bob.socket.emit("group:join", { groupId: CH });
  await sleep(500);

  for (const d of [aliceD1, aliceD2, bob]) {
    d.publish();
    d.listen();
  }
  await sleep(600); // let the KP upserts land

  // --- establishment (models ensureMlsGroup) --------------------------------
  const fetched = await emitAck<{
    packages: { userId: string; deviceId: string; keyPackage: string }[];
    memberIds: string[];
  }>(aliceD1.socket, "mls:fetchGroup", { groupId: CH });
  const pkgs = fetched?.packages ?? [];
  check(
    pkgs.some((p) => p.userId === ALICE && p.deviceId === "dev-a2") &&
      pkgs.some((p) => p.userId === BOB && p.deviceId === "dev-b1"),
    `fetchGroup returns per-device packages incl. requester's sibling (${pkgs.length})`,
  );
  check(
    (fetched?.memberIds ?? []).includes(ALICE) && (fetched?.memberIds ?? []).includes(BOB),
    `fetchGroup returns the member roster (${JSON.stringify(fetched?.memberIds)})`,
  );

  const targets = pkgs
    .filter((p) => !(p.userId === ALICE && p.deviceId === "dev-a1"))
    .map((p) => ({ ...p, kp: mls.mlsDecodeKeyPackage(p.keyPackage)! }));
  const created = await mls.mlsCreateGroup(CH, aliceD1.kp);
  const added = await mls.mlsAddMembers(created, targets.map((t) => t.kp));
  const ack = await emitAck<{ ok: boolean; seq?: number; epoch?: number }>(
    aliceD1.socket, "mls:commit",
    {
      groupId: CH,
      fromEpoch: 0,
      commit: added.commit,
      welcomes: targets.map((t) => ({ toUserId: t.userId, toDeviceId: t.deviceId, welcome: added.welcome })),
    });
  check(ack?.ok === true && ack.seq === 1 && ack.epoch === 1, `establish commit accepted via DS: ${JSON.stringify(ack)}`);
  aliceD1.state = added.state;
  aliceD1.seq = 1;

  await sleep(900);
  check(!!aliceD2.state, "alice's SECOND device joined from its own Welcome");
  check(!!bob.state, "bob joined from his Welcome");

  // --- multi-device app message fan-out --------------------------------------
  {
    const { state, wire } = await mls.mlsEncrypt(aliceD1.state!, { text: "HELLO-MLS" });
    aliceD1.state = state;
    aliceD1.socket.emit("message:send", { groupId: CH, text: "", clientId: "h1", enc: JSON.stringify({ t: "mls", w: wire }) });
  }
  await sleep(900);
  check(bob.got.includes("HELLO-MLS"), `bob decrypted alice's MLS message (${JSON.stringify(bob.got)})`);
  check(aliceD2.got.includes("HELLO-MLS"), `alice's OTHER device decrypted it too (${JSON.stringify(aliceD2.got)})`);

  // --- membership drift: carol joins AFTER establishment ----------------------
  // Carol's keypair round-trips through export/import first (persistence check).
  const carolKpOrig = await mls.mlsGenerateKeyPackage(CAROL, "dev-c1");
  const carolKp = mls.mlsImportKeyPair(mls.mlsExportKeyPair(carolKpOrig));
  check(!!carolKp, "KeyPackage keypair survives export → import (persistence)");
  const carol = new Device(CAROL, "dev-c1", await connect(CAROL), carolKp!);
  carol.socket.emit("group:join", { groupId: CH });
  await sleep(300);
  carol.publish();
  await sleep(500);
  // Carol does NOT listen live — she'll DRAIN her per-device Welcome instead.
  carol.socket.on("message:new", async (p: { groupId: string; message: { enc?: string } }) => {
    if (p.groupId !== CH || !p.message.enc || !carol.state) return;
    try {
      const env = JSON.parse(p.message.enc) as { t?: string; w?: string };
      if (env.t !== "mls" || !env.w) return;
      const res = await mls.mlsDecrypt(carol.state, env.w);
      if (res) carol.state = res.state;
      if (res?.kind === "application") carol.got.push(res.text);
    } catch { /* expected after removal */ }
  });

  // aliceD1 re-fetches, diffs leaves vs packages (mlsSyncMembership's logic),
  // and issues ONE sync commit adding carol's device.
  const fetched2 = await emitAck<{
    packages: { userId: string; deviceId: string; keyPackage: string }[];
    memberIds: string[];
  }>(aliceD1.socket, "mls:fetchGroup", { groupId: CH });
  const leaves = mls.mlsGroupMembers(aliceD1.state!);
  const leafIds = new Set(leaves.map((l) => l.identity));
  const missing = (fetched2?.packages ?? []).filter(
    (p) => !leafIds.has(mls.mlsIdentity(p.userId, p.deviceId)),
  );
  check(
    missing.length === 1 && missing[0].userId === CAROL,
    `drift diff finds exactly carol's device missing (${missing.length})`,
  );
  const sync = await mls.mlsSyncCommit(
    aliceD1.state!,
    missing.map((p) => mls.mlsDecodeKeyPackage(p.keyPackage)!),
    [],
  );
  const ack2 = await emitAck<{ ok: boolean; seq?: number; epoch?: number }>(
    aliceD1.socket, "mls:commit",
    {
      groupId: CH,
      fromEpoch: mls.mlsEpoch(aliceD1.state!),
      commit: sync!.commit,
      welcomes: missing.map((p) => ({ toUserId: p.userId, toDeviceId: p.deviceId, welcome: sync!.welcome! })),
    });
  check(ack2?.ok === true && ack2.epoch === 2, `drift sync commit accepted (${JSON.stringify(ack2)})`);
  aliceD1.state = sync!.state;
  aliceD1.seq = ack2.seq!;
  await sleep(700); // bob + aliceD2 apply the relayed commit

  // Carol drains HER device's Welcome (per-device: dev-c1 only).
  const drained = await emitAck<{ welcomes: { groupId: string; welcome: string; seq: number }[] }>(
    carol.socket, "mls:drainWelcomes", { deviceId: "dev-c1" });
  const w = (drained?.welcomes ?? []).find((x) => x.groupId === CH);
  check(!!w, "carol drained her queued per-device Welcome");
  if (w) {
    carol.state = await mls.mlsJoinFromWelcome(w.welcome, carol.kp);
    carol.seq = w.seq;
  }
  const drained2 = await emitAck<{ welcomes: { groupId: string; welcome: string; seq: number }[] }>(
    carol.socket, "mls:drainWelcomes", { deviceId: "dev-c1" });
  check((drained2?.welcomes ?? []).length === 0, "welcome drain is one-shot");

  {
    const { state, wire } = await mls.mlsEncrypt(aliceD1.state!, { text: "AFTER-DRIFT" });
    aliceD1.state = state;
    aliceD1.socket.emit("message:send", { groupId: CH, text: "", clientId: "h2", enc: JSON.stringify({ t: "mls", w: wire }) });
  }
  await sleep(900);
  check(carol.got.includes("AFTER-DRIFT"), `late-joiner carol decrypts post-add traffic (${JSON.stringify(carol.got)})`);
  check(bob.got.includes("AFTER-DRIFT"), "bob still decrypts after applying the add commit");

  // --- removal + concurrent-commit ordering -----------------------------------
  // Both alice and bob build a remove-carol commit at the SAME epoch: the DS
  // must accept exactly one; the loser rebases via fetchCommits.
  const carolLeaf = mls.mlsGroupMembers(aliceD1.state!).find((l) => l.userId === CAROL);
  check(!!carolLeaf, "carol's leaf is visible in the tree");
  const bobRemove = await mls.mlsSyncCommit(
    bob.state!,
    [],
    [mls.mlsGroupMembers(bob.state!).find((l) => l.userId === CAROL)!.leafIndex],
  );
  const aliceRemove = await mls.mlsSyncCommit(aliceD1.state!, [], [carolLeaf!.leafIndex]);
  const ep = mls.mlsEpoch(aliceD1.state!);
  const [r1, r2] = await Promise.all([
    emitAck<{ ok: boolean }>(aliceD1.socket, "mls:commit", { groupId: CH, fromEpoch: ep, commit: aliceRemove!.commit, welcomes: [] }),
    emitAck<{ ok: boolean }>(bob.socket, "mls:commit", { groupId: CH, fromEpoch: ep, commit: bobRemove!.commit, welcomes: [] }),
  ]);
  const winners = [r1, r2].filter((r) => r?.ok).length;
  check(winners === 1, `two concurrent remove commits → exactly one accepted (${winners})`);
  // Adopt the winner's state locally; the loser catches up from the DS.
  if (r1?.ok) {
    aliceD1.state = aliceRemove!.state;
  } else {
    const cu = await emitAck<{ commits: { seq: number; commit: string }[] }>(
      aliceD1.socket, "mls:fetchCommits", { groupId: CH, sinceSeq: aliceD1.seq });
    for (const c of cu?.commits ?? []) {
      aliceD1.state = await mls.mlsProcessCommit(aliceD1.state!, c.commit);
      aliceD1.seq = c.seq;
    }
  }
  await sleep(700);

  {
    const { state, wire } = await mls.mlsEncrypt(aliceD1.state!, { text: "AFTER-REMOVE" });
    aliceD1.state = state;
    aliceD1.socket.emit("message:send", { groupId: CH, text: "", clientId: "h3", enc: JSON.stringify({ t: "mls", w: wire }) });
  }
  await sleep(900);
  check(bob.got.includes("AFTER-REMOVE"), `bob decrypts post-removal traffic (${JSON.stringify(bob.got)})`);
  check(!carol.got.includes("AFTER-REMOVE"), "REMOVED carol cannot decrypt post-removal traffic");

  // --- cleanup ----------------------------------------------------------------
  const pool = getPool();
  await pool.query(`DELETE FROM mls_commit WHERE group_id=$1`, [CH]);
  await pool.query(`DELETE FROM mls_group WHERE group_id=$1`, [CH]);
  await pool.query(`DELETE FROM mls_welcome WHERE group_id=$1`, [CH]);
  await pool.query(`DELETE FROM mls_key_package WHERE user_id = ANY($1)`, [[ALICE, BOB, CAROL]]);
  await pool.query(`DELETE FROM message WHERE group_id=$1`, [CH]);
  await pool.query(`DELETE FROM group_member WHERE group_id=$1`, [CH]);
  await pool.query(`DELETE FROM group_member WHERE user_id = ANY($1)`, [[ALICE, BOB, CAROL]]);
  await pool.query(`DELETE FROM read_cursor WHERE user_id = ANY($1)`, [[ALICE, BOB, CAROL]]);
  await pool.query(`DELETE FROM "group" WHERE id=$1`, [CH]);
  for (const d of [aliceD1, aliceD2, bob, carol]) d.socket.close();
  await pool.end();

  console.log("\n" + results.join("\n"));
  console.log(results.every((r) => r.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
  if (!results.every((r) => r.startsWith("PASS"))) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => { console.error("harness error:", e); process.exit(1); },
);
