// A conversation's chat color belongs to the conversation, and the app logo is
// not part of it.
//
// Before: the picker in the conversation's info panel wrote the *viewer's*
// profile preference (bubbleTheme), so only the person who picked saw a change,
// and it repainted every conversation plus the app mark — the logo shared the
// same --sent-grad variable.
//
// Now: group:setTheme stores the color on the group and broadcasts it to every
// member, GroupView scopes --sent-grad to that conversation, and the mark reads
// --brand-grad instead.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/chat-color-harness.mts [--headed]

import { chromium } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";
import { CHAT_GRADIENTS } from "../src/lib/chat-data.ts";

const URL = "http://localhost:4000";
const SETTER = "color-a@test"; // picks the color
const VIEWER = "color-b@test"; // must see it too
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

/** The gradient in effect INSIDE the open conversation. GroupView scopes
 *  --sent-grad to its own subtree, so this must read an element within it (the
 *  message list) — reading `main` or the sidebar would report the global
 *  default and silently pass. */
const sentGrad = (page: import("playwright").Page) =>
  page.evaluate(() => {
    const el = document.querySelector("main .app-scroll") ?? document.body;
    return getComputedStyle(el).getPropertyValue("--sent-grad").trim();
  });

async function main() {
  const setter = await connect(SETTER);
  await sleep(300);

  const stamp = Date.now();
  const groupId = await new Promise<string>((resolve, reject) => {
    setter.emit(
      "group:create",
      { name: `color-${stamp}`, topic: "chat color harness", private: true },
      (res: { ok: boolean; groupId?: string }) =>
        res.ok && res.groupId ? resolve(res.groupId) : reject(new Error("create failed")),
    );
  });
  setter.emit("group:addMember", { groupId, userId: VIEWER }, () => {});
  setter.emit("message:send", { groupId, text: `hello-${stamp}`, clientId: `c-${stamp}` });
  await sleep(600);

  // The VIEWER's browser — it never touches the picker.
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext();
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
  await page.waitForSelector(`text=hello-${stamp}`, { timeout: 15000 });

  const before = await sentGrad(page);
  // "" when the mark isn't on its own gradient class at all — report a FAIL
  // rather than throwing, so a regression is legible.
  const logoBefore = await page
    .locator(".brand-grad")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundImage)
    .catch(() => "");

  // Someone else picks "sunset" for this conversation.
  setter.emit("group:setTheme", { groupId, theme: "sunset" });
  const sunset = CHAT_GRADIENTS.sunset;
  let after = "";
  for (let i = 0; i < 30; i++) {
    after = await sentGrad(page);
    if (after === sunset) break;
    await sleep(300);
  }
  check(
    after === sunset,
    "the other member's conversation picks up the color (was only local before)",
  );
  check(before !== after, `the gradient actually changed (${before || "∅"} → ${after || "∅"})`);

  // The app mark must be untouched by a chat color.
  const logoAfter = await page
    .locator(".brand-grad")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundImage)
    .catch(() => "");
  check(
    !!logoAfter && logoAfter === logoBefore,
    "the app logo's background does not follow the chat color",
  );
  check(
    !!logoAfter && !logoAfter.includes("255, 138, 61"), // sunset's leading #FF8A3D
    "the logo is not painted with the chosen chat color",
  );

  // Clearing falls back to each member's own default.
  setter.emit("group:setTheme", { groupId, theme: null });
  let cleared = "";
  for (let i = 0; i < 30; i++) {
    cleared = await sentGrad(page);
    if (cleared === CHAT_GRADIENTS.default) break;
    await sleep(300);
  }
  check(
    cleared === CHAT_GRADIENTS.default,
    "clearing the color falls back to the member's own default",
  );

  // It survives a reload (persisted server-side, not just broadcast).
  setter.emit("group:setTheme", { groupId, theme: "forest" });
  await sleep(500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Connected", { timeout: 30000 });
  await dismissDialogs(page);
  let reloaded = "";
  for (let i = 0; i < 30; i++) {
    reloaded = await sentGrad(page);
    if (reloaded === CHAT_GRADIENTS.forest) break;
    await sleep(300);
  }
  check(reloaded === CHAT_GRADIENTS.forest, "the conversation's color survives a reload");

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  await browser.close();
  setter.emit("group:delete", { groupId }, () => {});
  await sleep(400);
  setter.close();
  for (const t of ["message", "reaction", "pin", "read_cursor", "group_member"]) {
    await getPool().query(`DELETE FROM ${t} WHERE group_id = $1`, [groupId]);
  }
  await getPool().query(`DELETE FROM "group" WHERE id = $1`, [groupId]);
  await getPool().end();
  process.exit(failed ? 1 : 0);
}

void main();
