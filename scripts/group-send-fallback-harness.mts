// Group sends must not fail when a SAFE encrypted path exists.
//
// Two ways the group send path used to give up and show
// "Not sent — end-to-end encryption isn't available here yet":
//
//  1. You add someone to a group who has never signed in, so no co-member device
//     has published keys. The old code refused (a leftover from when returning
//     null there meant "send it in plaintext"), which under default-E2EE just
//     loses the message. Our sender-key seed is stable and re-distributed
//     whenever the member-device set changes, so the message becomes readable as
//     soon as they set their keys up — which this harness proves, rather than
//     assuming.
//
//  2. Anything in the MLS path THROWS. buildGroupEnc is documented as "MLS first,
//     falling back to sender-keys", but the fallback only covered MLS returning
//     null, so an exception failed the message instead of degrading to the older
//     scheme. Membership churn is exactly when that path does its most
//     failure-prone work. Forced here by corrupting the stored MLS state, which
//     is the same shape as a stale/rejected state after a membership change.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/group-send-fallback-harness.mts [--headed]

import { chromium, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import { getPool } from "../src/lib/db.ts";

const URL = "http://localhost:4000";
// Fresh ids per run: the server keeps a device-key directory per user, so a
// recycled id would carry a stale published device and quietly make "nobody has
// keys" untestable.
const STAMP = Date.now();
const OWNER = `gsend-owner-${STAMP}@test`;
const LATECOMER = `gsend-late-${STAMP}@test`;
const PEER = `gsend-peer-${STAMP}@test`;
const ALL = [OWNER, LATECOMER, PEER];
const HEADED = process.argv.includes("--headed");

const results: string[] = [];
const check = (cond: boolean, label: string) =>
  results.push(`${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);
const sleep = (ms: number) => new Promise((f) => setTimeout(f, ms));
const flat = (s: string | null) => (s ?? "").replace(/\s+/g, " ");

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

async function send(page: Page, text: string): Promise<void> {
  await dismissDialogs(page);
  await page.click('[contenteditable="true"], input[placeholder="Aa"]');
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** The open conversation's text (not the whole page — the sidebar is noisy). */
const thread = async (page: Page) => flat(await page.textContent("main"));

async function main() {
  const owner = await connect(OWNER);
  await sleep(300);
  const mkGroup = (name: string, memberIds: string[]) =>
    new Promise<string>((resolve, reject) => {
      owner.emit(
        "group:create",
        { name, topic: "group send fallback", memberIds },
        (res: { ok: boolean; groupId?: string }) =>
          res.ok && res.groupId ? resolve(res.groupId) : reject(new Error("create failed")),
      );
    });
  // nobody else has keys / healthy group, MLS broken later
  const groupA = await mkGroup(`gsend-a-${STAMP}`, [LATECOMER]);
  const groupB = await mkGroup(`gsend-b-${STAMP}`, [PEER]);
  await sleep(1000);

  const browser = await chromium.launch({ headless: !HEADED });
  const openAs = async (uid: string, groupId: string): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
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

  // --- 1. the only member with keys can still send -----------------------------
  const ownerA = await openAs(OWNER, groupA);
  await sleep(3500);
  const WAITING = "this should wait for you";
  await send(ownerA, WAITING);
  await sleep(6000);
  const threadA = await thread(ownerA);
  check(
    !/Not sent/.test(threadA),
    `sending to a group where nobody else has keys yet succeeds ${
      /Not sent/.test(threadA) ? `("${threadA.match(/Not sent[^]{0,90}/)?.[0]}")` : ""
    }`,
  );
  check(/this should wait for you/.test(threadA), "the message is in the thread");

  // --- 2. …and becomes readable once they sign in -------------------------------
  // The whole justification for sending rather than refusing: the stable
  // sender-key seed reaches them later, via redistribution or their own
  // pull-on-miss request. The owner stays open to answer that request.
  const lateA = await openAs(LATECOMER, groupA);
  await sleep(6000);
  await send(ownerA, "and here is a second one");
  await sleep(8000);
  const lateThread = await thread(lateA);
  check(
    /this should wait for you/.test(lateThread),
    `the latecomer can read the message sent before they had keys ${
      /Unable to decrypt/.test(lateThread) ? "(saw 🔒)" : ""
    }`,
  );
  check(
    !/Unable to decrypt/.test(lateThread),
    "nothing in that thread is stuck as undecryptable",
  );

  // --- 3. an MLS failure degrades to sender-keys, it doesn't fail the send ------
  const ownerB = await openAs(OWNER, groupB);
  const peerB = await openAs(PEER, groupB);
  await sleep(4000);
  await send(ownerB, "healthy first message");
  await sleep(5000);
  check(!/Not sent/.test(await thread(ownerB)), "baseline group send works");

  await ownerB.evaluate(
    async ([uid, gid]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(`e2ee:${uid}`, 3);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("groups", "readwrite");
        tx.objectStore("groups").put("!!!not-a-serialized-mls-state!!!", `mls2:${gid}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    [OWNER, groupB],
  );
  await ownerB.reload({ waitUntil: "domcontentloaded" });
  await ownerB.waitForSelector("text=Connected", { timeout: 30000 });
  await dismissDialogs(ownerB);
  await sleep(3500);

  const AFTER = "sent after mls broke";
  await send(ownerB, AFTER);
  await sleep(8000);
  const brokenThread = await thread(ownerB);
  check(
    !/Not sent/.test(brokenThread),
    `a broken MLS state falls back instead of failing the send ${
      /Not sent/.test(brokenThread) ? `("${brokenThread.match(/Not sent[^]{0,90}/)?.[0]}")` : ""
    }`,
  );
  const peerThread = await thread(peerB);
  check(
    new RegExp(AFTER).test(peerThread),
    `the peer receives and decrypts it ${/Unable to decrypt/.test(peerThread) ? "(saw 🔒)" : ""}`,
  );

  if (HEADED) await sleep(4000);
  await browser.close();
  owner.disconnect();

  try {
    const pool = getPool();
    const groups = [groupA, groupB];
    await pool.query(`DELETE FROM message WHERE group_id = ANY($1)`, [groups]);
    await pool.query(`DELETE FROM group_member WHERE user_id = ANY($1)`, [ALL]);
    await pool.query(`DELETE FROM read_cursor WHERE user_id = ANY($1)`, [ALL]);
    await pool.query(`DELETE FROM "group" WHERE id = ANY($1)`, [groups]);
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
