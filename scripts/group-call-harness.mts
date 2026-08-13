// Group calls, end to end in three real browsers.
//
// This is the harness that actually proves the mesh: Chromium's fake capture
// devices mean real getUserMedia, real ICE/DTLS and real media, so it catches a
// mesh that "connects" without anything flowing. It also covers the pieces no
// server-side test can reach — the join banner, late joining, and the thread
// record with its participant count.
//
// Flow: A starts a voice call in a 3-member private group; C accepts; B DECLINES
// and then joins later from the conversation's "Ongoing call" bar; A (the
// starter) leaves while B and C carry on.
//
// What it pins down:
//   - every participant sees a tile per remote DEVICE, and the count reads right
//   - media actually flows both ways on every leg (inbound bytes per peer
//     connection, collected by instrumenting RTCPeerConnection in the page)
//   - a declined ring still leaves a joinable call in the conversation
//   - a late joiner ends up fully meshed with everyone already talking
//   - the starter writes exactly one thread row, carrying "N on the call", and
//     everyone in the group can decrypt it
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/group-call-harness.mts [--headed] [--shots]

import { chromium, type Browser, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const A = "gcall-ana@test";
const B = "gcall-ben@test";
const C = "gcall-cai@test";
const ALL = [A, B, C];
const HEADED = process.argv.includes("--headed");

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);
const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

async function jwtFor(uid: string): Promise<string> {
  return encode({
    token: { uid, name: uid },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
}

async function connect(uid: string): Promise<Socket> {
  const s = io(URL, {
    transports: ["websocket"],
    extraHeaders: { cookie: `authjs.session-token=${await jwtFor(uid)}` },
    forceNew: true,
  });
  await new Promise<void>((res, rej) => {
    s.on("connect", () => res());
    s.on("connect_error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 6000);
  });
  return s;
}

async function dismissDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (!(await page.locator('[data-slot="dialog-overlay"]').count())) return;
    await page.keyboard.press("Escape");
    await sleep(300);
  }
}

async function click(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 20000 });
  await dismissDialogs(page);
  await page.click(selector, { timeout: 20000 });
}

/** Participant tiles currently rendered in the call panel. */
const tiles = (page: Page) =>
  page.locator("[data-participant]").evaluateAll((els) =>
    els.map((el) => ({
      deviceId: el.getAttribute("data-participant") ?? "",
      connected: el.getAttribute("data-connected") === "1",
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );

/**
 * Bytes received on every RTCPeerConnection in the page. The app keeps its
 * connections in React refs, so they're instrumented at construction time by an
 * init script instead of being reached into — no test hooks in product code.
 */
async function inboundBytes(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? [];
    const out: number[] = [];
    for (const pc of pcs) {
      if (pc.connectionState !== "connected") continue;
      let bytes = 0;
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === "inbound-rtp" && typeof r.bytesReceived === "number") {
          bytes += r.bytesReceived;
        }
      });
      out.push(bytes);
    }
    return out;
  });
}

const callRows = (page: Page) =>
  page.locator("[data-call-status]").evaluateAll((els) =>
    els.map((el) => ({
      status: el.getAttribute("data-call-status") ?? "",
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );

async function waitForTiles(page: Page, n: number, ms = 25000): Promise<void> {
  await page
    .waitForFunction(
      (want) =>
        document.querySelectorAll('[data-participant][data-connected="1"]').length >= want,
      n,
      { timeout: ms },
    )
    .catch(() => {});
}

async function main() {
  // Build a private 3-member group over a socket (call:start validates membership).
  const seed = await connect(A);
  await sleep(300);
  const groupId = await new Promise<string>((resolve, reject) => {
    seed.emit(
      "group:create",
      { name: `gcall-${Date.now()}`, topic: "group call harness", private: true },
      (res: { ok: boolean; groupId?: string }) =>
        res.ok && res.groupId ? resolve(res.groupId) : reject(new Error("create failed")),
    );
  });
  seed.emit("group:addMember", { groupId, userId: B }, () => {});
  seed.emit("group:addMember", { groupId, userId: C }, () => {});
  await sleep(800);
  seed.disconnect();

  const browser: Browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const openAs = async (uid: string): Promise<Page> => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ["microphone", "camera"],
    });
    await ctx.addCookies([
      {
        name: "authjs.session-token",
        value: await jwtFor(uid),
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await ctx.newPage();
    // Collect every peer connection the app creates, so media can be measured
    // without the app exposing anything.
    await page.addInitScript(() => {
      const Native = window.RTCPeerConnection;
      const seen: RTCPeerConnection[] = [];
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = seen;
      // @ts-expect-error - test-time wrapper
      window.RTCPeerConnection = function (...args: unknown[]) {
        // @ts-expect-error - forwarding to the native constructor
        const pc = new Native(...args);
        seen.push(pc);
        return pc;
      };
      window.RTCPeerConnection.prototype = Native.prototype;
    });
    await page.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Connected", { timeout: 30000 });
    await dismissDialogs(page);
    return page;
  };

  const pageA = await openAs(A);
  const pageB = await openAs(B);
  const pageC = await openAs(C);
  await sleep(4000); // key bundles + group state

  // --- 1. A starts, C accepts, B declines --------------------------------------
  await click(pageA, '[title="Start a voice call"]');
  await click(pageC, "text=Accept");
  await click(pageB, "text=Decline");
  await waitForTiles(pageA, 1);
  await waitForTiles(pageC, 1);

  let aTiles = await tiles(pageA);
  let cTiles = await tiles(pageC);
  check(
    aTiles.length === 1 && aTiles[0].connected,
    `starter sees the one participant who joined (${aTiles.length} tiles)`,
  );
  check(
    cTiles.length === 1 && cTiles[0].connected,
    `the joiner sees the starter (${cTiles.length} tiles)`,
  );
  const declined = await pageA.textContent("body");
  check(
    /declined/i.test((declined ?? "").replace(/\s+/g, " ")),
    "the starter is told live that someone declined",
  );

  // --- 2. B joins late, from the conversation's banner --------------------------
  await pageB.waitForSelector("text=Ongoing voice call", { timeout: 15000 }).catch(() => {});
  const banner = await pageB.locator("text=Ongoing voice call").count();
  check(banner > 0, "a declined ring leaves a joinable call in the conversation");
  await click(pageB, "text=Join");

  // Everyone should end up meshed with everyone: two remote tiles each.
  await waitForTiles(pageA, 2);
  await waitForTiles(pageB, 2);
  await waitForTiles(pageC, 2);
  aTiles = await tiles(pageA);
  const bTiles = await tiles(pageB);
  cTiles = await tiles(pageC);
  check(
    aTiles.filter((t) => t.connected).length === 2,
    `starter is meshed with both (${aTiles.length} tiles)`,
  );
  check(
    bTiles.filter((t) => t.connected).length === 2,
    `the late joiner is meshed with both (${bTiles.length} tiles)`,
  );
  check(
    cTiles.filter((t) => t.connected).length === 2,
    `the early joiner picked up the late one (${cTiles.length} tiles)`,
  );
  const header = ((await pageA.textContent("body")) ?? "").replace(/\s+/g, " ");
  check(/3 on the call/.test(header), "the panel reads 3 on the call");

  // --- 3. media actually flows on every leg ------------------------------------
  await sleep(3000); // let RTP accumulate
  const [ba, bb, bc] = await Promise.all([
    inboundBytes(pageA),
    inboundBytes(pageB),
    inboundBytes(pageC),
  ]);
  const flowing = (bytes: number[]) => bytes.length >= 2 && bytes.every((b) => b > 0);
  check(flowing(ba), `starter receives media from both peers (${ba.join(", ")} bytes)`);
  check(flowing(bb), `late joiner receives media from both peers (${bb.join(", ")} bytes)`);
  check(flowing(bc), `early joiner receives media from both peers (${bc.join(", ")} bytes)`);

  if (process.argv.includes("--shots")) {
    await pageA.screenshot({ path: "/tmp/group-call-a.png" });
    await pageB.screenshot({ path: "/tmp/group-call-b.png" });
  }

  // --- 4. the starter leaves: one row, with the participant count ---------------
  await click(pageA, '[title="End call"]');
  await sleep(4000);
  const [rowsA, rowsB, rowsC] = await Promise.all([
    callRows(pageA),
    callRows(pageB),
    callRows(pageC),
  ]);
  check(
    rowsA.length === 1 && rowsA[0].status === "answered",
    `the starter's thread has exactly one answered row (${rowsA.length})`,
  );
  check(
    /3 on the call/.test(rowsA[0]?.text ?? ""),
    `the row records how many were on it ("${rowsA[0]?.text ?? "—"}")`,
  );
  check(
    /started a call/.test(rowsB[0]?.text ?? ""),
    `members see who started it ("${rowsB[0]?.text ?? "—"}")`,
  );
  check(
    rowsB.length === 1 && rowsC.length === 1,
    `everyone gets exactly one row, decrypted (B ${rowsB.length}, C ${rowsC.length})`,
  );
  // B and C were left talking to each other — the call did not end with A.
  const bStill = await tiles(pageB);
  check(
    bStill.length === 1,
    `the call continues without the starter (${bStill.length} tile left)`,
  );

  await click(pageB, '[title="End call"]');
  await sleep(2500);

  // --- 5. group VIDEO call ------------------------------------------------------
  // A 3-member group is under the video cap, so video is offered. This is the
  // one leg the voice flow above can't cover: tiles must render real <video>
  // elements and carry the audio, not just avatars.
  await click(pageC, '[title="Start a video call"]');
  await click(pageB, "text=Accept");
  await waitForTiles(pageB, 1);
  await sleep(3500);
  const videoTiles = await pageB
    .locator("[data-participant] video")
    .count();
  check(videoTiles >= 1, `a group video call renders video tiles (${videoTiles})`);
  const vBytes = await inboundBytes(pageB);
  check(
    vBytes.length >= 1 && vBytes.every((b) => b > 0),
    `video call media flows (${vBytes.join(", ")} bytes)`,
  );
  if (process.argv.includes("--shots")) {
    await pageB.screenshot({ path: "/tmp/group-call-video.png" });
  }
  await click(pageC, '[title="End call"]');
  await sleep(1500);

  if (HEADED) await sleep(4000);
  await browser.close();

  try {
    const pool = getPool();
    await pool.query(`DELETE FROM message WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM group_member WHERE user_id = ANY($1)`, [ALL]);
    await pool.query(`DELETE FROM read_cursor WHERE user_id = ANY($1)`, [ALL]);
    await pool.query(`DELETE FROM "group" WHERE id = $1`, [groupId]);
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
