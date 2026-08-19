// The open conversation must scroll inside the app shell, never grow the page.
//
// The app is a fixed-height flex layout (h-screen + overflow-hidden), and the
// message list is the one scrolling element. That only works while every
// ancestor between the shell and the list can shrink below its content — a flex
// item needs min-height:0 for that. Miss it on one wrapper and the list grows
// past the viewport instead: no scrollbar, the composer pushed off-screen.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/conversation-layout-harness.mts [--headed]

import { chromium } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const SENDER = "layout-a@test";
const VIEWER = "layout-b@test";
const MESSAGES = 60; // comfortably taller than any viewport
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

async function dismissDialogs(page: import("playwright").Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (!(await page.locator('[data-slot="dialog-overlay"]').count())) return;
    await page.keyboard.press("Escape");
    await sleep(300);
  }
}

async function main() {
  const sender = await connect(SENDER);
  await sleep(300);

  const stamp = Date.now();
  const groupId = await new Promise<string>((resolve, reject) => {
    sender.emit(
      "group:create",
      { name: `layout-${stamp}`, topic: "layout harness", memberIds: [VIEWER] },
      (res: { ok: boolean; groupId?: string }) =>
        res.ok && res.groupId ? resolve(res.groupId) : reject(new Error("create failed")),
    );
  });
  for (let i = 0; i < MESSAGES; i++) {
    sender.emit("message:send", {
      groupId,
      text: `line ${i} of ${MESSAGES} — ${stamp}`,
      clientId: `c-${stamp}-${i}`,
    });
  }
  await sleep(1500);

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: await jwtFor(VIEWER),
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
  await page.waitForSelector(`text=line ${MESSAGES - 1} of`, { timeout: 20000 });
  await sleep(800); // let the autoscroll-to-latest settle

  const list = page.locator("main .app-scroll").first();
  const box = await list.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  }));
  check(
    box.scrollHeight > box.clientHeight + 50,
    `the message list overflows its own box (${box.scrollHeight} > ${box.clientHeight})`,
  );

  // The page itself must not have grown — the shell is fixed height.
  const doc = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  check(
    doc.scrollHeight <= doc.innerHeight + 2,
    `the page does not scroll (doc ${doc.scrollHeight} <= viewport ${doc.innerHeight})`,
  );

  // Scrolling actually moves the list.
  await list.evaluate((el) => el.scrollBy(0, -400));
  await sleep(300);
  const afterUp = await list.evaluate((el) => el.scrollTop);
  check(afterUp < box.scrollTop, `scrolling up moves the list (${box.scrollTop} → ${afterUp})`);

  await list.evaluate((el) => el.scrollBy(0, 400));
  await sleep(300);
  const afterDown = await list.evaluate((el) => el.scrollTop);
  check(afterDown > afterUp, `scrolling back down moves the list (${afterUp} → ${afterDown})`);

  // Mouse wheel over the list must scroll it too (not just programmatic calls).
  await list.hover();
  await page.mouse.wheel(0, -500);
  await sleep(300);
  const afterWheel = await list.evaluate((el) => el.scrollTop);
  check(afterWheel < afterDown, `the wheel scrolls the list (${afterDown} → ${afterWheel})`);

  // The composer stays on screen at the bottom.
  const composer = await page
    .locator(".lex-editor")
    .first()
    .boundingBox()
    .catch(() => null);
  check(
    !!composer && composer.y + composer.height <= doc.innerHeight,
    composer
      ? `the composer is inside the viewport (bottom ${Math.round(
          composer.y + composer.height,
        )} <= ${doc.innerHeight})`
      : "the composer is inside the viewport (not found)",
  );

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  await browser.close();
  sender.emit("group:delete", { groupId }, () => {});
  await sleep(400);
  sender.close();
  for (const t of ["message", "reaction", "pin", "read_cursor", "group_member"]) {
    await getPool().query(`DELETE FROM ${t} WHERE group_id = $1`, [groupId]);
  }
  await getPool().query(`DELETE FROM "group" WHERE id = $1`, [groupId]);
  await getPool().end();
  process.exit(failed ? 1 : 0);
}

void main();
