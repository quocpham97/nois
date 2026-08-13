// Call event messages: a finished call must leave ONE row in the DM thread, on
// BOTH sides, with the outcome each side should see.
//
// The row is written by the caller only (call-context recordCall → chat-context
// logCallEvent) and delivered as an ordinary E2EE message, so this drives two
// real browsers through real WebRTC calls (Chromium's fake capture devices) and
// then reads the thread on each side. What it pins down:
//   - answered   → both sides show one "Voice call" row, with a talk time
//   - cancelled  → caller "No answer", callee "Missed video call" (same row)
//   - declined   → both sides show "Call declined"
//   - busy       → the automatic decline reads as declined, not as a no-answer
//   - exactly one row per call (both ends observe the hang-up; only one logs)
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/call-event-harness.mts [--headed]

import { chromium, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { dmIdFor } from "../src/lib/dm-id.ts";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const CALLER = "callev-bob@test";
const CALLEE = "callev-alice@test";
// Rings the callee while they're already on a call, to exercise the busy
// auto-decline (their client turns the call down without ever ringing).
const INTERLOPER = "callev-carol@test";
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
  await new Promise<void>((resolve, reject) => {
    s.on("connect", () => resolve());
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 6000);
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

/** Click something in the app, shrugging off a modal (key backup, device
 *  approval) that may have popped up since the last interaction. */
async function click(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 15000 });
  await dismissDialogs(page);
  await page.click(selector, { timeout: 15000 });
}

/** The call rows currently in the open thread: status + the card's own text. */
async function callRows(
  page: Page,
): Promise<{ status: string; text: string }[]> {
  return page.locator("[data-call-status]").evaluateAll((els) =>
    els.map((el) => ({
      status: el.getAttribute("data-call-status") ?? "",
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
}

/** Wait until the thread has `n` call rows (or give up). */
async function waitForRows(page: Page, n: number, ms = 15000): Promise<void> {
  await page
    .waitForFunction(
      (want) => document.querySelectorAll("[data-call-status]").length >= want,
      n,
      { timeout: ms },
    )
    .catch(() => {});
}

async function main() {
  // Establish the DM (call:invite validates DM membership server-side).
  const seed = await connect(CALLER);
  const seed2 = await connect(INTERLOPER);
  await sleep(300);
  seed.emit("dm:create", {
    recipientId: CALLEE,
    text: "call-event harness setup",
    clientId: "callev-" + Date.now(),
  });
  seed2.emit("dm:create", {
    recipientId: CALLEE,
    text: "call-event harness setup (busy)",
    clientId: "callev-busy-" + Date.now(),
  });
  await sleep(1500);
  seed.disconnect();
  seed2.disconnect();

  const dmId = dmIdFor(CALLER, CALLEE);
  const busyDmId = dmIdFor(INTERLOPER, CALLEE);

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const openAs = async (uid: string, groupId = dmId): Promise<Page> => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
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
    await page.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Connected", { timeout: 30000 });
    await dismissDialogs(page);
    return page;
  };

  const callerPage = await openAs(CALLER);
  const calleePage = await openAs(CALLEE);
  // Let both sides publish/fetch key bundles before the first sealed send.
  await sleep(3000);

  // --- 1. answered call --------------------------------------------------------
  await click(callerPage, '[title="Start a voice call"]');
  await click(calleePage, "text=Accept");
  await sleep(4000); // let ICE connect and the timer run past 0:00
  await click(callerPage, '[title="End call"]');

  await waitForRows(callerPage, 1);
  await waitForRows(calleePage, 1);
  let callerRows = await callRows(callerPage);
  let calleeRows = await callRows(calleePage);
  check(callerRows.length === 1, `caller: one row after the call (got ${callerRows.length})`);
  check(calleeRows.length === 1, `callee: one row after the call (got ${calleeRows.length})`);
  check(
    callerRows[0]?.status === "answered" && /Voice call/.test(callerRows[0]?.text ?? ""),
    `caller sees an answered voice call ("${callerRows[0]?.text ?? "—"}")`,
  );
  check(
    calleeRows[0]?.status === "answered" && /Voice call/.test(calleeRows[0]?.text ?? ""),
    `callee sees the same answered call ("${calleeRows[0]?.text ?? "—"}")`,
  );
  check(
    /·\s*\d+:\d\d/.test(callerRows[0]?.text ?? ""),
    "the answered row carries a talk time",
  );

  // --- 2. cancelled while ringing (video) --------------------------------------
  await click(callerPage, '[title="Start a video call"]');
  await calleePage.waitForSelector("text=Accept", { timeout: 15000 });
  await sleep(700);
  await click(callerPage, '[title="End call"]'); // caller gives up
  await waitForRows(callerPage, 2);
  await waitForRows(calleePage, 2);
  callerRows = await callRows(callerPage);
  calleeRows = await callRows(calleePage);
  check(
    callerRows.length === 2 && calleeRows.length === 2,
    `one row per call, no duplicates (caller ${callerRows.length}, callee ${calleeRows.length})`,
  );
  check(
    callerRows[1]?.status === "unanswered" && /No answer/.test(callerRows[1]?.text ?? ""),
    `caller sees "No answer" ("${callerRows[1]?.text ?? "—"}")`,
  );
  check(
    calleeRows[1]?.status === "unanswered" &&
      /Missed video call/.test(calleeRows[1]?.text ?? ""),
    `callee sees "Missed video call" ("${calleeRows[1]?.text ?? "—"}")`,
  );

  // --- 3. declined --------------------------------------------------------------
  await click(callerPage, '[title="Start a voice call"]');
  await click(calleePage, "text=Decline");
  await waitForRows(callerPage, 3);
  await waitForRows(calleePage, 3);
  callerRows = await callRows(callerPage);
  calleeRows = await callRows(calleePage);
  check(
    callerRows[2]?.status === "declined" && /Call declined/.test(callerRows[2]?.text ?? ""),
    `caller sees "Call declined" ("${callerRows[2]?.text ?? "—"}")`,
  );
  check(
    calleeRows[2]?.status === "declined",
    `callee sees the declined row too ("${calleeRows[2]?.text ?? "—"}")`,
  );

  // --- 4. busy: the callee's client declines automatically -----------------------
  // Bob and Alice go on a call; Carol rings Alice mid-call. Alice's client turns
  // it down without ringing, so Carol must be told so live AND end up with a
  // declined row — not the "No answer" of a call that rang out.
  const interloperPage = await openAs(INTERLOPER, busyDmId);
  await sleep(2500); // key bundles for the Carol↔Alice DM

  await click(callerPage, '[title="Start a voice call"]');
  await click(calleePage, "text=Accept");
  await sleep(3000); // Alice is now busy

  await click(interloperPage, '[title="Start a voice call"]');
  await sleep(2500);
  const busyToast = ((await interloperPage.textContent("body")) ?? "").replace(/\s+/g, " ");
  check(
    /is on another call/.test(busyToast),
    "busy: the interloper is told live that the callee is on another call",
  );
  await waitForRows(interloperPage, 1);
  const busyRows = await callRows(interloperPage);
  check(
    busyRows.length === 1 && busyRows[0]?.status === "declined",
    `busy: the resting record says declined, not "No answer" ("${busyRows[0]?.text ?? "—"}")`,
  );
  // The call Bob is still on must not have been logged yet, and must log once.
  await click(callerPage, '[title="End call"]');
  await waitForRows(callerPage, 4);
  callerRows = await callRows(callerPage);
  check(
    callerRows.length === 4 && callerRows[3]?.status === "answered",
    `busy: the unrelated in-progress call logs once, on hang-up (caller rows: ${callerRows.length})`,
  );
  await waitForRows(calleePage, 4);
  const calleeBusyRows = await callRows(calleePage);
  check(
    calleeBusyRows.length === 4,
    `busy: the refused call stays in its own DM — the callee's thread with the caller has 4 rows (${calleeBusyRows.length})`,
  );

  // The server must never see what these rows say — it only relayed ciphertext.
  // (Sanity: the sidebar preview reads the call row, not an empty message.)
  // asides in DOM order: the workspace rail, then the conversation list.
  const preview = await calleePage
    .locator("aside")
    .nth(1)
    .textContent()
    .catch(() => "");
  const previewText = (preview ?? "").replace(/\s+/g, " ").trim();
  check(
    /Call declined/.test(previewText),
    `the conversation list previews the latest call row (sidebar: "${previewText.slice(0, 220)}")`,
  );

  // --shots: save both threads for a visual check against the design comp.
  if (process.argv.includes("--shots")) {
    await callerPage.screenshot({ path: "/tmp/call-rows-caller.png" });
    await calleePage.screenshot({ path: "/tmp/call-rows-callee.png" });
    await interloperPage.screenshot({ path: "/tmp/call-rows-busy.png" });
  }

  if (HEADED) await sleep(4000);
  await browser.close();

  try {
    const pool = getPool();
    const users = [CALLER, CALLEE, INTERLOPER];
    await pool.query(`DELETE FROM message WHERE group_id = ANY($1)`, [
      [dmId, busyDmId],
    ]);
    await pool.query(`DELETE FROM group_member WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM read_cursor WHERE user_id = ANY($1)`, [users]);
    await pool.query(`DELETE FROM "group" WHERE id = ANY($1)`, [[dmId, busyDmId]]);
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
