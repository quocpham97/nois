// Does the configured TURN relay actually work?
//
// A call succeeding proves nothing about TURN: on a normal network the peers
// find each other directly and the relay is never touched. So ONE side is forced
// to `iceTransportPolicy: "relay"` — injected by wrapping the RTCPeerConnection
// constructor in a page init script, so no product code carries a test switch —
// which makes the call impossible unless TURN is reachable, the credentials are
// accepted, and the relay passes media.
//
// One side, not both, because that is the situation TURN exists for: a peer
// behind a symmetric NAT reaching one that is directly addressable. Forcing BOTH
// sides onto the relay is a strictly harder test that some providers (including
// ExpressTURN's free tier) refuse, since it means relaying between two of their
// own allocations. That case is probed separately and reported, not asserted —
// if it fails, calls still work unless BOTH participants need a relay.
//
// Run it after changing TURN configuration, and against a deployed instance
// (change URL) before trusting a production rollout.
//
// Needs the dev server on :4000 with NEXT_PUBLIC_TURN_* set at BUILD time
// (Next inlines them — restart the dev server after editing .env.local). Run:
//   npx tsx --env-file=.env.local scripts/turn-check.mts [--headed]

import { chromium, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { dmIdFor } from "../src/lib/dm-id.ts";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const STAMP = Date.now();
const A = `turn-a-${STAMP}@test`;
const B = `turn-b-${STAMP}@test`;
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

/** What the browser ended up using: the succeeded pair and its candidate types. */
type IceReport = {
  configured: string[];
  pairs: { state: string; local: string; remote: string; bytes: number }[];
};

async function iceReport(page: Page): Promise<IceReport> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __pcs?: RTCPeerConnection[];
      __iceUrls?: string[];
    };
    const pcs = w.__pcs ?? [];
    const pairs: IceReport["pairs"] = [];
    for (const pc of pcs) {
      const stats = await pc.getStats();
      const byId = new Map<string, RTCStats>();
      stats.forEach((r) => byId.set(r.id, r));
      let bytes = 0;
      stats.forEach((r) => {
        const rec = r as unknown as Record<string, unknown>;
        if (r.type === "inbound-rtp" && typeof rec.bytesReceived === "number") {
          bytes += rec.bytesReceived;
        }
      });
      stats.forEach((r) => {
        const rec = r as unknown as Record<string, unknown>;
        if (r.type !== "candidate-pair" || rec.state !== "succeeded") return;
        const local = byId.get(rec.localCandidateId as string) as unknown as
          | Record<string, unknown>
          | undefined;
        const remote = byId.get(rec.remoteCandidateId as string) as unknown as
          | Record<string, unknown>
          | undefined;
        pairs.push({
          state: String(rec.state),
          local: String(local?.candidateType ?? "?"),
          remote: String(remote?.candidateType ?? "?"),
          bytes,
        });
      });
    }
    return { configured: w.__iceUrls ?? [], pairs };
  });
}

async function main() {
  const seed = await connect(A);
  await sleep(300);
  seed.emit("dm:create", {
    recipientId: B,
    text: "turn check setup",
    clientId: "turnchk-" + STAMP,
  });
  await sleep(1500);
  seed.disconnect();
  const dmId = dmIdFor(A, B);

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const openAs = async (uid: string, forceRelay: boolean): Promise<Page> => {
    const ctx = await browser.newContext({
      viewport: { width: 1100, height: 800 },
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
    // Force relay-only and record what the app configured. Wrapping the
    // constructor keeps the coercion in the test, not in call-context.
    await page.addInitScript((relay: boolean) => {
      const Native = window.RTCPeerConnection;
      const seen: RTCPeerConnection[] = [];
      const w = window as unknown as {
        __pcs: RTCPeerConnection[];
        __iceUrls: string[];
        __iceCfg: RTCIceServer[];
      };
      w.__pcs = seen;
      w.__iceUrls = [];
      w.__iceCfg = [];
      // @ts-expect-error - test-time wrapper
      window.RTCPeerConnection = function (config?: RTCConfiguration) {
        for (const s of config?.iceServers ?? []) {
          const urls = typeof s.urls === "string" ? [s.urls] : (s.urls ?? []);
          for (const u of urls) if (!w.__iceUrls.includes(u)) w.__iceUrls.push(u);
        }
        // Keep what the APP configured (credentials included) so the harder
        // relay-to-relay case can be probed against the real settings.
        if (config?.iceServers?.length) w.__iceCfg = config.iceServers;
        const pc = new Native(relay ? { ...config, iceTransportPolicy: "relay" } : config);
        seen.push(pc);
        return pc;
      };
      window.RTCPeerConnection.prototype = Native.prototype;
    }, forceRelay);
    await page.goto(`${URL}/${dmId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Connected", { timeout: 30000 });
    await dismissDialogs(page);
    return page;
  };

  // A is pinned to the relay; B connects normally — the realistic shape.
  const pageA = await openAs(A, true);
  const pageB = await openAs(B, false);
  await sleep(3000);

  await click(pageA, '[title="Start a voice call"]');
  await click(pageB, "text=Accept");
  // Relay setup is slower than a direct connection — allow for the allocation.
  await sleep(12000);

  const [ra, rb] = await Promise.all([iceReport(pageA), iceReport(pageB)]);
  const turnConfigured = ra.configured.some((u) => u.startsWith("turn"));
  check(
    turnConfigured,
    `a TURN server is configured in the client (${ra.configured.join(", ") || "none"})`,
  );

  check(
    ra.pairs.length > 0,
    `a relay-pinned peer completes the call (${ra.pairs.length} succeeded pair(s))`,
  );
  check(
    ra.pairs.length > 0 && ra.pairs.every((p) => p.local === "relay"),
    `its media really goes through the relay (${
      ra.pairs.map((p) => `${p.local}→${p.remote}`).join(", ") || "none"
    })`,
  );
  check(
    [...ra.pairs, ...rb.pairs].some((p) => p.bytes > 0),
    `media flows over the relay (${[...ra.pairs, ...rb.pairs].map((p) => p.bytes).join(", ")} bytes)`,
  );

  // Harder case, reported not asserted: two allocations on the same server
  // talking to each other. Real coturn and Cloudflare do this; some free tiers
  // don't, and then a call fails only when BOTH sides need a relay.
  const bothRelay = await pageB.evaluate(async () => {
    const cfg = (window as unknown as { __iceCfg: RTCIceServer[] }).__iceCfg;
    const turn = cfg.filter((s) => String(s.urls).startsWith("turn"));
    if (!turn.length) return null;
    // NB no inner named functions here: tsx compiles this body with esbuild's
    // keepNames helper, which doesn't exist in the page and throws "__name is
    // not defined" the moment one is declared.
    const opts: RTCConfiguration = {
      iceServers: turn,
      iceTransportPolicy: "relay",
    };
    const a = new RTCPeerConnection(opts);
    const b = new RTCPeerConnection(opts);
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const dc = a.createDataChannel("probe");
    const opened = new Promise<boolean>((r) => {
      dc.onopen = () => r(true);
      setTimeout(() => r(false), 15000);
    });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    const ok = await opened;
    a.close();
    b.close();
    return ok;
  });
  console.log(
    bothRelay === null
      ? "\nnote: no TURN server configured, relay-to-relay not probed"
      : bothRelay
        ? "\nnote: relay-to-relay works — calls survive even when BOTH sides need a relay"
        : "\nnote: relay-to-relay REFUSED by this server — a call where BOTH participants\n" +
          "      need a relay (e.g. both on carrier-grade NAT) will fail. Fine otherwise.",
  );

  if (HEADED) await sleep(4000);
  await browser.close();

  try {
    const pool = getPool();
    await pool.query(`DELETE FROM message WHERE group_id = $1`, [dmId]);
    await pool.query(`DELETE FROM group_member WHERE user_id = ANY($1)`, [[A, B]]);
    await pool.query(`DELETE FROM read_cursor WHERE user_id = ANY($1)`, [[A, B]]);
    await pool.query(`DELETE FROM "group" WHERE id = $1`, [dmId]);
    await pool.end();
  } catch (e) {
    console.warn("cleanup skipped:", (e as Error).message);
  }

  console.log("\n" + results.join("\n"));
  const ok = results.every((r) => r.startsWith("PASS"));
  if (!ok) {
    console.log(
      "\nIf the call never connected: the credentials may be wrong or expired, the\n" +
        "provider may be unreachable, or NEXT_PUBLIC_TURN_* was not present when the\n" +
        "app was BUILT (Next inlines it — restart the dev server / redeploy).",
    );
  }
  console.log("\n" + (ok ? "ALL PASS ✅" : "SOME FAILED ❌"));
  process.exit(ok ? 0 : 1);
}

void main();
