// Pinned messages must be visible to every member, not just the ones who happen
// to hold the pinned message in their local store.
//
// The server stores pin *ids* only (store.listPins → Group.pinIds); each client
// resolves them to snippets itself. Resolution used to read the local
// SQLite/OPFS store exclusively, so a member who never stored that message —
// or whose store is unavailable at all (it's effectively single-tab, see
// message-db.ts) — rendered no pinned bar and an empty pin list.
//
// Setup mirrors the report: the message is sent AND pinned before the viewer
// ever connects, so the viewer only ever learns of it through the server's
// history replay.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/pin-visibility-harness.mts [--headed]

import { chromium } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
const PINNER = "pinviz-a@test";
const VIEWER = "pinviz-b@test";
const HEADED = process.argv.includes("--headed");

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

async function cookie(uid: string): Promise<string> {
  const jwt = await encode({
    token: { uid, name: uid },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
  return jwt;
}

async function connect(uid: string): Promise<Socket> {
  const s = io(URL, {
    transports: ["websocket"],
    extraHeaders: { cookie: `authjs.session-token=${await cookie(uid)}` },
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
  const pinner = await connect(PINNER);
  await sleep(300);

  // A throwaway group with the viewer on its roster from the start (groups are
  // member-only — a viewer who was never added can't open it at all), deleted at
  // the end so it doesn't linger in either sidebar.
  const stamp = Date.now();
  const groupId = await new Promise<string>((resolve, reject) => {
    pinner.emit(
      "group:create",
      {
        name: `pinviz-${stamp}`,
        topic: "pin visibility harness",
        memberIds: [VIEWER],
      },
      (res: { ok: boolean; groupId?: string }) =>
        res.ok && res.groupId ? resolve(res.groupId) : reject(new Error("create failed")),
    );
  });

  const text = `pinned-${stamp}`;
  const msgId = await new Promise<string>((resolve, reject) => {
    pinner.on("message:ack", (p: { message: { id: string } }) => resolve(p.message.id));
    pinner.emit("message:send", { groupId, text, clientId: `c-${stamp}` });
    setTimeout(() => reject(new Error("no ack")), 6000);
  });
  pinner.emit("pin:toggle", { groupId, msgId });
  await sleep(600);

  // Only now does the viewer connect — with its local store blocked, so the
  // replayed history and the pin snippet have to come from memory.
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext();
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: await cookie(VIEWER),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await ctx.route("**/sqlite-wasm/db-worker.mjs", (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Connected", { timeout: 30000 });
  await dismissDialogs(page);

  const sawMessage = await page
    .waitForSelector(`text=${text}`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(sawMessage, "viewer sees the message it never stored locally");

  const sawBar = await page
    .waitForSelector("text=1 pinned", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(sawBar, "viewer sees the pinned bar (the reported bug)");

  const barText = await page
    .locator('button[title="Jump to pinned message"]')
    .first()
    .textContent()
    .catch(() => null);
  check(
    !!barText?.includes(text),
    `pinned bar shows the message text${barText ? ` (got: ${barText.trim()})` : ""}`,
  );

  // Dismissing the bar in the UI unpins for everyone: it confirms first, and
  // the pinner (who never opened a browser) must see the pin list empty out.
  const pinsAfterClear = new Promise<string[]>((resolve) => {
    pinner.on("pins:updated", (p: { groupId: string; pinIds: string[] }) => {
      if (p.groupId === groupId) resolve(p.pinIds);
    });
  });
  await page.getByTitle("Unpin all for everyone").first().click();
  const confirmVisible = await page
    .waitForSelector("text=Unpin this message for everyone", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(confirmVisible, "dismissing the bar asks for confirmation first");
  await page.getByRole("button", { name: "Unpin all" }).first().click();

  check(
    (await Promise.race([pinsAfterClear, sleep(8000).then(() => null)]))?.length === 0,
    "confirming unpins for everyone, not just the viewer",
  );
  const cleared = await page
    .waitForSelector("text=1 pinned", { state: "detached", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(cleared, "the viewer's own pinned bar goes away");

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  await browser.close();
  pinner.emit("group:delete", { groupId }, () => {});
  await sleep(500);
  pinner.close();
  for (const t of ["message", "reaction", "pin", "read_cursor", "group_member"]) {
    await getPool().query(`DELETE FROM ${t} WHERE group_id = $1`, [groupId]);
  }
  await getPool().query(`DELETE FROM "group" WHERE id = $1`, [groupId]);
  await getPool().end();
  process.exit(failed ? 1 : 0);
}

void main();
