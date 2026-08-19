// A Welcome is stored once, pointed at per device, and collected when spent.
//
// One commit yields ONE Welcome however many devices it adds, but the queue used
// to inline a full copy of the blob in every per-device row — and a blob carries
// the whole ratchet tree, so admitting N devices wrote N copies of an O(N)
// payload. Together with nothing ever expiring, that is how `mls_welcome` reached
// 446 MB in 3,710 rows against 244 actual messages.
//
// Three things are checked here, against the real implementation:
//
//   * dedup — one blob row per commit, with a pointer row per recipient device
//   * the live-join ack — a device that joins from the relay has its queued row
//     dropped immediately, instead of waiting for a reconnect that may never come
//   * the sweep — a blob whose last pointer is gone is collected, and one that
//     still has a pointer is NOT
//
// The committer and the joinee are real browser clients; the two devices that
// never ack are real Node MLS clients, standing in for browser profiles that
// received a Welcome and vanished.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/welcome-storage-harness.mts [--headed]

import { chromium, type BrowserContext, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import * as mls from "../src/lib/crypto/mls.ts";
import * as mlsDs from "../src/server/mls-ds.ts";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
// Fresh identities per run. A browser profile is a new DEVICE every time, so a
// reused account accumulates live devices across runs — every one of which the
// commit then targets, which makes exact pointer counts meaningless.
const RUN = Date.now();
const SENDER = `wstore-v-${RUN}@test`; // browser, the committer
const JOINER = `wstore-w-${RUN}@test`; // browser, joins from the relay and acks
const GHOST = `wstore-g-${RUN}@test`; // Node devices that receive and never return
const HEADED = process.argv.includes("--headed");

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

const emitAck = <T,>(s: Socket, ev: string, ...args: unknown[]): Promise<T> =>
  new Promise((resolve) =>
    s.timeout(8000).emit(ev, ...args, (_e: unknown, r: T) => resolve(r)),
  );

/** A Node device that publishes a real KeyPackage and never acks a Welcome. */
class Ghost {
  welcomes = 0;
  constructor(
    public deviceId: string,
    public socket: Socket,
    public kp: mls.MlsKeyPair,
  ) {
    socket.on("mls:welcome", (p: { toDeviceId: string }) => {
      if (p.toDeviceId === this.deviceId) this.welcomes++;
    });
    socket.emit("device:announce", { deviceId });
    socket.emit("mls:publishKeyPackage", {
      deviceId,
      keyPackage: mls.mlsEncodeKeyPackage(kp.publicPackage),
    });
  }
}

async function browserFor(uid: string): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 780 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: await jwt(uid),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return ctx;
}

/** Focus the composer past the key-backup prompt, which this fresh device gets
 *  a beat after "Connected". */
async function focusComposer(page: Page): Promise<void> {
  const editor = page.locator('[contenteditable="true"]').first();
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Escape");
    await sleep(400);
    try {
      await editor.click({ timeout: 1500 });
      return;
    } catch {
      /* still covered */
    }
  }
  throw new Error("composer never became clickable");
}

const pool = getPool();
const countBlobs = async (groupId: string) =>
  Number(
    (
      await pool.query(
        "SELECT count(*)::int n FROM mls_welcome_blob WHERE group_id=$1",
        [groupId],
      )
    ).rows[0].n,
  );
const countPointers = async (groupId: string, deviceId?: string) =>
  Number(
    (
      await pool.query(
        deviceId
          ? "SELECT count(*)::int n FROM mls_welcome WHERE group_id=$1 AND to_device=$2"
          : "SELECT count(*)::int n FROM mls_welcome WHERE group_id=$1",
        deviceId ? [groupId, deviceId] : [groupId],
      )
    ).rows[0].n,
  );

async function main() {
  const stamp = RUN;

  // Two devices of a user that will receive Welcomes and never come back.
  const g1 = new Ghost(`ghost-a-${stamp}`, await connect(GHOST), await mls.mlsGenerateKeyPackage(GHOST, `ghost-a-${stamp}`));
  const g2 = new Ghost(`ghost-b-${stamp}`, await connect(GHOST), await mls.mlsGenerateKeyPackage(GHOST, `ghost-b-${stamp}`));
  await sleep(800);

  const creator = await connect(SENDER);
  const groupId = await new Promise<string>((resolve, reject) =>
    creator.emit(
      "group:create",
      { name: `wstore-${stamp}`, topic: "welcome storage", memberIds: [GHOST, JOINER] },
      (r: { ok: boolean; groupId?: string }) =>
        r.ok && r.groupId ? resolve(r.groupId) : reject(new Error("create failed")),
    ),
  );

  // The joiner comes up FIRST so its KeyPackage is published before the commit —
  // establishment only proceeds once every co-member is MLS-capable.
  const joinerCtx = await browserFor(JOINER);
  const joinerPage = await joinerCtx.newPage();
  joinerPage.on("console", (m) => {
    const t = m.text();
    if (t.includes("[DBG]") || t.includes("[mls]")) console.log("  joiner>", t.slice(0, 200));
  });
  await joinerPage.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
  await joinerPage.waitForSelector("text=Connected", { timeout: 40000 });
  await sleep(2500);

  const joinerDevice = (
    await pool.query(
      "SELECT device_id FROM mls_key_package WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
      [JOINER],
    )
  ).rows[0]?.device_id as string | undefined;
  check(!!joinerDevice, "the joiner published a KeyPackage");

  // The committer sends, which establishes the group and adds all three devices.
  const senderCtx = await browserFor(SENDER);
  const senderPage = await senderCtx.newPage();
  await senderPage.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
  await senderPage.waitForSelector("text=Connected", { timeout: 40000 });
  await focusComposer(senderPage);
  const body = `establish ${stamp}`;
  await senderPage.locator('[contenteditable="true"]').first().type(body, { delay: 8 });
  await senderPage.keyboard.press("Enter");
  await senderPage.waitForSelector(`text=${body}`, { timeout: 20000 });
  await sleep(6000); // commit + welcomes + the joiner's ack

  check(g1.welcomes >= 1 && g2.welcomes >= 1, "both ghost devices were Welcomed");

  // --- dedup: one blob, many pointers -------------------------------------
  const blobs = await countBlobs(groupId);
  check(blobs === 1, `the commit stored ${blobs} blob (want 1, shared by every recipient)`);
  check(
    (await countPointers(groupId, g1.deviceId)) === 1,
    "the first ghost has a pointer row",
  );
  check(
    (await countPointers(groupId, g2.deviceId)) === 1,
    "the second ghost has a pointer row",
  );

  // --- the live-join ack ---------------------------------------------------
  // The joiner processed the relayed Welcome and told the server, so its row is
  // already gone — without reconnecting. The ghosts', which never acked, remain.
  check(
    !!joinerDevice && (await countPointers(groupId, joinerDevice)) === 0,
    "the joiner's queued row was dropped on its live join",
  );
  check(
    (await countPointers(groupId)) === 2,
    `only the two un-acked rows are left (${await countPointers(groupId)})`,
  );

  // --- the sweep ----------------------------------------------------------
  // Negative control first: a blob with pointers must survive a sweep.
  await mlsDs.pruneExpired();
  check(
    (await countBlobs(groupId)) === 1,
    "a sweep keeps a blob that still has pointers",
  );

  // Drain both ghosts, which is what a returning device does. Their pointers go,
  // leaving the blob orphaned — the bytes are only reclaimed by the sweep.
  await emitAck(g1.socket, "mls:drainWelcomes", { deviceId: g1.deviceId });
  await emitAck(g2.socket, "mls:drainWelcomes", { deviceId: g2.deviceId });
  await sleep(600);
  check((await countPointers(groupId)) === 0, "draining removed the pointer rows");
  check((await countBlobs(groupId)) === 1, "the blob outlives its pointers until swept");

  await mlsDs.pruneExpired();
  check((await countBlobs(groupId)) === 0, "the sweep collected the orphaned blob");

  if (HEADED) await sleep(3000);
  await joinerCtx.browser()?.close();
  await senderCtx.browser()?.close();
  g1.socket.close();
  g2.socket.close();
  creator.close();

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
