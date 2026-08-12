// Browser harness: a client whose local message store is unavailable must still
// show conversation history.
//
// The message store is SQLite-in-OPFS behind a Web Worker, and it is documented
// as effectively single-tab ("A second tab won't be able to open it ... this
// module degrades to empty results in that tab" — src/lib/message-db.ts). Every
// msgdb call then resolves to a no-op/empty value instead of throwing. This
// harness reproduces that state by blocking the worker script for one of two
// real browser sessions, then checks whether that client can see a DM sent to it.
//
// E2EE is unaffected by the block: device keys live in IndexedDB (e2ee:<uid>),
// not in the OPFS store, so the receiving client can still decrypt.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/dm-nostore-harness.mts [--headed]

import { chromium, type BrowserContext } from "playwright";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";
import { dmIdFor } from "../src/lib/dm-id.ts";

const URL = "http://localhost:4000";
const SENDER = "nostore-sender@test";
const RECIPIENT = "nostore-recipient@test";
const HEADED = process.argv.includes("--headed");

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);

async function session(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  uid: string,
  { breakStore = false } = {},
): Promise<BrowserContext> {
  const jwt = await encode({
    token: { uid, name: uid },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
  const ctx = await browser.newContext();
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: jwt,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  if (breakStore) {
    // Exactly what a second tab hits: the worker can't start, so message-db.ts
    // sets workerFailed and every call degrades to an empty result.
    await ctx.route("**/sqlite-wasm/db-worker.mjs", (r) => r.abort());
  }
  return ctx;
}

const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));

// Key-backup / device-recovery prompts (key-backup.tsx) can open on their own
// once the crypto setup settles, and their overlay swallows clicks. Close any
// that are up before driving the UI.
async function dismissDialogs(page: import("playwright").Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (!(await page.locator('[data-slot="dialog-overlay"]').count())) return;
    await page.keyboard.press("Escape");
    await sleep(300);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED });
  const senderCtx = await session(browser, SENDER);
  const recipientCtx = await session(browser, RECIPIENT, { breakStore: true });

  const sender = await senderCtx.newPage();
  const recipient = await recipientCtx.newPage();
  const recipientErrors: string[] = [];
  recipient.on("pageerror", (e) => recipientErrors.push(e.message));

  // Both clients need to be online and have published their E2EE keys before
  // the DM is sent (the sender seals to the recipient's devices).
  await recipient.goto(URL, { waitUntil: "domcontentloaded" });
  await sender.goto(URL, { waitUntil: "domcontentloaded" });
  await recipient.waitForSelector("text=Connected", { timeout: 30000 });
  await sender.waitForSelector("text=Connected", { timeout: 30000 });
  await sleep(3000); // key publish + roster
  await dismissDialogs(recipient);

  const text = `nostore-${Date.now()}`;

  // Sender: compose a new DM to the recipient through the real UI.
  await dismissDialogs(sender);
  await sender.getByTitle("New message").first().click();
  await sender.getByPlaceholder("Type a name").fill(RECIPIENT);
  // Match the suggestion by its "@handle" subtitle — the sidebar's contact rows
  // carry the same name, and clicking one of those would close the composer.
  const handle = "@" + RECIPIENT.toLowerCase().replace(/[' ]/g, "").slice(0, 12);
  await sender.getByRole("button").filter({ hasText: handle }).first().click();
  await sender.getByPlaceholder("Aa").fill(text);
  await sender.keyboard.press("Enter");

  const dmId = dmIdFor(SENDER, RECIPIENT);
  await sender.waitForSelector(`text=${text}`, { timeout: 15000 });
  check(true, "sender's own message renders (store working)");

  // The recipient is connected, so this is the live path: the message should
  // appear without touching local storage at all.
  const liveSeen = await recipient
    .waitForSelector(`text=${text}`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(liveSeen, "recipient with no local store shows the live message");

  // Open the conversation: this is where the client loads history. With the
  // store dead the local page is empty, and it must not wipe what's on screen.
  await recipient.goto(`${URL}/${dmId}`, { waitUntil: "domcontentloaded" });
  await recipient.waitForSelector("text=Connected", { timeout: 30000 });
  await dismissDialogs(recipient);
  const afterOpen = await recipient
    .waitForSelector(`text=${text}`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(
    afterOpen,
    "recipient still sees it after opening the conversation (server replay)",
  );

  // And the sidebar preview must show the text, not the empty-DM placeholder.
  const sawPlaceholder = await recipient
    .locator("text=Say hi 👋")
    .first()
    .isVisible()
    .catch(() => false);
  check(!sawPlaceholder, "sidebar shows the message, not the 'Say hi' placeholder");

  // The recipient can still talk back, and the sender (working store) must show
  // it live. The open-conversation composer is Lexical (a contenteditable), not
  // a textarea like the compose modal's.
  const reply = `reply-${Date.now()}`;
  await dismissDialogs(recipient);
  await recipient.locator(".lex-editor").first().click();
  await recipient.keyboard.type(reply);
  await recipient.keyboard.press("Enter");
  const senderSawReply = await sender
    .waitForSelector(`text=${reply}`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(senderSawReply, "sender receives the reply from the store-less client");

  // Regression guard for the "don't wipe on an empty page" change: a client WITH
  // a working store must still rebuild history from it across a reload.
  await sender.reload({ waitUntil: "domcontentloaded" });
  await sender.waitForSelector("text=Connected", { timeout: 30000 });
  await dismissDialogs(sender);
  const senderAfterReload = await sender
    .waitForSelector(`text=${text}`, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(senderAfterReload, "sender reloads its history from the local store");

  check(
    recipientErrors.length === 0,
    `no uncaught page errors on the recipient${
      recipientErrors.length ? `: ${recipientErrors[0]}` : ""
    }`,
  );

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  await browser.close();
  for (const t of ["message", "reaction", "pin", "read_cursor", "group_member"]) {
    await getPool().query(`DELETE FROM ${t} WHERE group_id = $1`, [dmId]);
  }
  await getPool().query(`DELETE FROM "group" WHERE id = $1`, [dmId]);
  await getPool().end();
  process.exit(failed ? 1 : 0);
}

void main();
