// A device that stops coming back must stop being an MLS leaf.
//
// Every browser profile that ever signs in is a distinct device with its own
// KeyPackage, and nothing used to expire either. `mlsSyncMembership` added each
// one as a leaf and only ever removed leaves whose USER left the group, so the
// ratchet tree grew forever — and since a Welcome embeds the whole tree
// (`ratchetTreeExtension: true`), every join blob grew with it. Admitting N
// devices to a group of N leaves queues N Welcomes of O(N) bytes, which is how
// one deployment reached 446 MB of undrained Welcomes in `mls_welcome`.
//
// Two halves are checked, both against the REAL implementation: the server no
// longer offers a stale device's package (so no new dead leaves), and the client
// hook evicts the leaf of a device that has gone quiet (so existing ones drain
// away) — proven by the fact that the device is re-Welcomed when it returns,
// which can only happen if its leaf was gone.
//
// The live devices here are real MLS clients (real KeyPackages, real leaves) and
// the committer is the real React hook in a browser.
//
// Needs the dev server on :4000 started with a SHORT device TTL, e.g.
//   MLS_DEVICE_TTL_DAYS=0.0002 npx tsx watch --env-file=.env.local server.ts
// then:
//   npx tsx --env-file=.env.local scripts/device-expiry-harness.mts [--headed]

import { chromium, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import * as mls from "../src/lib/crypto/mls.ts";

const URL = "http://localhost:4000";
const VIEWER = "expiry-v@test"; // the browser, and the committer
const PEER = "expiry-p@test"; // two Node devices, one of which goes quiet
const HEADED = process.argv.includes("--headed");

/** Must match the server's MLS_DEVICE_TTL_DAYS for this run, plus slack. */
const TTL_MS = Number(process.env.MLS_DEVICE_TTL_DAYS ?? 0.0002) * 86_400_000;
const PAST_TTL_MS = Math.max(TTL_MS * 2, 6000);

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

/** A Node MLS device: real KeyPackage, counts the Welcomes addressed to it. */
class NodeDevice {
  welcomes = 0;
  constructor(
    public user: string,
    public deviceId: string,
    public socket: Socket,
    public kp: mls.MlsKeyPair,
  ) {
    socket.on("mls:welcome", (p: { toDeviceId: string }) => {
      if (p.toDeviceId === this.deviceId) this.welcomes++;
    });
  }
  /** What a real device does on connect: announce itself and publish its package.
   *  This is the ONLY thing that refreshes its liveness. */
  announce() {
    this.socket.emit("device:announce", { deviceId: this.deviceId });
    this.socket.emit("mls:publishKeyPackage", {
      deviceId: this.deviceId,
      keyPackage: mls.mlsEncodeKeyPackage(this.kp.publicPackage),
    });
  }
}

/** Focus the composer, clearing whatever modal is in the way.
 *
 *  This viewer is a brand-new device on every reload, so the key-backup prompt
 *  appears each time — and it appears a beat AFTER "Connected", so a single
 *  Escape pass before typing races it. Retry until the composer takes focus. */
async function focusComposer(page: Page): Promise<void> {
  const editor = page.locator('[contenteditable="true"]').first();
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Escape");
    await sleep(400);
    try {
      await editor.click({ timeout: 1500 });
      return;
    } catch {
      /* a modal is still over it — Escape again */
    }
  }
  throw new Error("composer never became clickable");
}

async function main() {
  const stamp = Date.now();

  // Two devices of one peer, so one can go quiet while the other stays live —
  // which is what separates "expiry works" from "everything gets evicted".
  const s1 = await connect(PEER);
  const s2 = await connect(PEER);
  const n1 = new NodeDevice(PEER, `dev-live-${stamp}`, s1, await mls.mlsGenerateKeyPackage(PEER, `dev-live-${stamp}`));
  const n2 = new NodeDevice(PEER, `dev-quiet-${stamp}`, s2, await mls.mlsGenerateKeyPackage(PEER, `dev-quiet-${stamp}`));
  n1.announce();
  n2.announce();
  await sleep(800);

  const creator = await connect(VIEWER);
  const groupId = await new Promise<string>((resolve, reject) =>
    creator.emit(
      "group:create",
      { name: `expiry-${stamp}`, topic: "device expiry", memberIds: [PEER] },
      (r: { ok: boolean; groupId?: string }) =>
        r.ok && r.groupId ? resolve(r.groupId) : reject(new Error("create failed")),
    ),
  );

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: await jwt(VIEWER),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();

  /** Send from the browser. A reload first, because mlsSyncMembership throttles
   *  per group per page load — reloading is how a test gets a fresh sync. */
  const sendFromBrowser = async (body: string) => {
    await page.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Connected", { timeout: 40000 });
    await focusComposer(page);
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.type(body, { delay: 8 });
    await page.keyboard.press("Enter");
    await page.waitForSelector(`text=${body}`, { timeout: 20000 });
    await sleep(4000); // let the commit + welcomes land
  };

  // --- both devices live: both become leaves -------------------------------
  n1.announce();
  n2.announce();
  await sendFromBrowser(`establish ${stamp}`);
  check(n1.welcomes >= 1, `the live device was added (welcomes: ${n1.welcomes})`);
  check(n2.welcomes >= 1, `the second device was added (welcomes: ${n2.welcomes})`);
  const afterEstablish = { n1: n1.welcomes, n2: n2.welcomes };

  // --- one goes quiet -----------------------------------------------------
  // n1 keeps announcing; n2 says nothing at all from here.
  const keepAlive = setInterval(() => n1.announce(), Math.max(TTL_MS / 3, 1000));
  await sleep(PAST_TTL_MS);

  // Server half: a stale device is no longer offered as an add candidate.
  const fetched = await emitAck<{
    packages: { userId: string; deviceId: string }[];
    liveDevices?: { userId: string; deviceId: string }[];
  }>(s1, "mls:fetchGroup", { groupId });
  const liveIds = new Set((fetched.liveDevices ?? []).map((d) => d.deviceId));
  const pkgIds = new Set(fetched.packages.map((p) => p.deviceId));
  check(liveIds.has(n1.deviceId), "the announcing device is still reported live");
  check(!liveIds.has(n2.deviceId), "the quiet device is no longer reported live");
  check(pkgIds.has(n1.deviceId), "the live device's package is still offered");
  check(!pkgIds.has(n2.deviceId), "the quiet device's package is no longer offered");

  // --- client half: the stale leaf is evicted ------------------------------
  await sendFromBrowser(`after-expiry ${stamp}`);
  check(
    n1.welcomes === afterEstablish.n1,
    `the live device was NOT re-Welcomed, so it kept its leaf (${n1.welcomes})`,
  );

  // The proof of eviction: bring the quiet device back. It can only be Welcomed
  // again if its leaf is gone — a device that still had one is "already in,
  // unchanged" and is never re-added.
  clearInterval(keepAlive);
  n2.announce();
  n1.announce();
  await sleep(1000);
  await sendFromBrowser(`return ${stamp}`);
  check(
    n2.welcomes > afterEstablish.n2,
    `the returning device was re-Welcomed, proving its leaf was evicted (${afterEstablish.n2} → ${n2.welcomes})`,
  );
  check(
    n1.welcomes === afterEstablish.n1,
    `the continuously-live device was never evicted (${n1.welcomes})`,
  );

  if (HEADED) await sleep(3000);
  await browser.close();
  s1.close();
  s2.close();
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
