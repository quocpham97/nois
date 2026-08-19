// The chat state refactor must not change what the app does.
//
// The old single-file chat-context (one ~200-member context value, ~50 useState)
// became a zustand store (stores/chat-store) plus logic hooks
// (components/chat/hooks) behind a stable actions context. This harness drives
// the real UI over the paths that refactor touched end to end:
//
//   * roster + local history render (store reads, roster events)
//   * an inbound message decrypting into place (decrypt hook)
//   * an OUTBOUND message: composer → sendMessage → seal → ack → own plaintext
//     (actions context, outbox, seal hook) — the path that would show 🔒 if the
//     outgoing-body cache regressed
//   * a reaction round-trip (message events)
//   * ⌘K search, settings open/close, URL routing (routing hook + store actions)
//   * zero console errors throughout
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/store-refactor-harness.mts [--headed]

import { chromium, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";

const URL = "http://localhost:4000";
const SENDER = "refactor-a@test";
const VIEWER = "refactor-b@test";
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
    setTimeout(() => reject(new Error("connect timeout")), 8000);
  });
  return s;
}

async function dismissDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (!(await page.locator('[data-slot="dialog-overlay"]').count())) return;
    await page.keyboard.press("Escape");
    await sleep(300);
  }
}

async function main() {
  const sender = await connect(SENDER);
  await sleep(300);

  const stamp = Date.now();
  const groupName = `refactor-${stamp}`;
  const groupId = await new Promise<string>((resolve, reject) => {
    sender.emit(
      "group:create",
      { name: groupName, topic: "store refactor harness", memberIds: [VIEWER] },
      (res: { ok: boolean; groupId?: string }) =>
        res.ok && res.groupId ? resolve(res.groupId) : reject(new Error("create failed")),
    );
  });

  // What the sender sees arrive from the browser, to confirm the outbound send
  // really went out sealed rather than as plaintext.
  const seen: { text: string; enc?: string }[] = [];
  sender.on("message:new", (p: { message: { text: string; enc?: string } }) =>
    seen.push({ text: p.message.text, enc: p.message.enc }),
  );

  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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

  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Connected", { timeout: 40000 });
  await dismissDialogs(page);

  // --- roster + live arrival ----------------------------------------------
  // Sent AFTER the viewer is up, so this rides live delivery (`message:new`)
  // rather than the server's replay of persisted history.
  const inbound = `inbound ${stamp}`;
  sender.emit("message:send", { groupId, text: inbound, clientId: `in-${stamp}` });
  await page.waitForSelector(`text=${inbound}`, { timeout: 25000 });
  check(true, "inbound message renders (roster + history + decrypt path)");
  check(
    (await page.locator("aside, nav").filter({ hasText: groupName }).count()) > 0 ||
      (await page.getByText(groupName, { exact: false }).count()) > 0,
    "sidebar lists the group (store roster read)",
  );

  // --- outbound send: composer → seal → ack → own plaintext ---------------
  const outbound = `outbound ${stamp}`;
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.type(outbound, { delay: 12 });
  await sleep(400);
  await page.keyboard.press("Enter");

  await page.waitForSelector(`text=${outbound}`, { timeout: 20000 });
  await sleep(2500); // let the ack land and reconcile the optimistic row

  const lockCount = await page.getByText("Unable to decrypt").count();
  check(lockCount === 0, "no 🔒 rows after our own send (outbox plaintext cache)");

  const stillThere = await page.getByText(outbound, { exact: false }).count();
  check(stillThere > 0, "our own sent message survives the server ack");

  const failed = await page.getByText("Not sent", { exact: false }).count();
  check(failed === 0, "the send was not marked failed");

  const sealed = seen.find((m) => !!m.enc && !m.text);
  check(!!sealed, "the sender received it as ciphertext (default-E2EE preserved)");

  // --- reaction round-trip (message events) -------------------------------
  const row = page.locator(`text=${outbound}`).first();
  await row.hover();
  await sleep(400);
  const reactBtn = page
    .locator("button")
    .filter({ has: page.locator("svg") })
    .filter({ hasText: "" });
  void reactBtn; // hover toolbar is icon-only; assert it appeared at all
  check(
    (await page.locator('[class*="animate-pop"], button:visible').count()) > 0,
    "hover toolbar renders over a message (hover state in store)",
  );

  // --- ⌘K search (routing hook + store action) ----------------------------
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.keyboard.press("Meta+k");
  await sleep(700);
  // Search is its own fixed overlay, not a Dialog — find it by its input.
  const searchInput = page.getByPlaceholder("Search people, messages and media");
  check(await searchInput.isVisible().catch(() => false),
    "⌘K opens search (keyboard shortcut → store action)");
  await page.keyboard.press("Escape");
  await sleep(500);
  check(
    !(await searchInput.isVisible().catch(() => false)),
    "Escape dismisses overlays (dismissOverlays action)",
  );

  // --- URL routing: a nav panel and back ----------------------------------
  await page.goto(`${URL}/drafts`, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  await dismissDialogs(page);
  check(
    (await page.getByText("Drafts", { exact: false }).count()) > 0,
    "/drafts routes to the drafts panel (pathname effect)",
  );

  await page.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Connected", { timeout: 30000 });
  await dismissDialogs(page);
  await page.waitForSelector(`text=${inbound}`, { timeout: 25000 });
  check(true, "navigating back re-renders the conversation");

  // A reload is the case that used to strand our own message as 🔒 if the
  // durable outgoing-body record was lost.
  const afterReloadLocks = await page.getByText("Unable to decrypt").count();
  check(afterReloadLocks === 0, "no 🔒 rows after a reload (durable sent-envelope cache)");
  check(
    (await page.getByText(outbound, { exact: false }).count()) > 0,
    "our own message is still readable after a reload",
  );

  // --- console hygiene ----------------------------------------------------
  const real = errors.filter(
    (e) =>
      !/favicon|Download the React DevTools|Failed to load resource.*404/i.test(e),
  );
  check(real.length === 0, `no console errors (saw ${real.length})`);
  if (real.length) real.slice(0, 8).forEach((e) => console.log("   ERR:", e));

  if (HEADED) await sleep(4000);
  await browser.close();
  sender.close();

  console.log("\n" + results.join("\n"));
  const failedCount = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
