// A message resent after a reconnect must be SEALED, like every other send.
//
// The reconnect path used to build its own `message:send` with the body in the
// plaintext `text` field and no envelope — so a message typed while the socket
// was down reached the server in the clear, which is the one thing default-E2EE
// promises never happens. It also passed the attachment through with its
// `key`/`iv` still attached, and dropped the quoted reply / preview / forwarded
// marker / call payload that the envelope carries.
//
// This drives the real thing: take the browser offline, send, come back, and
// watch what a co-member's socket actually receives.
//
// Needs the dev server on :4000. Run:
//   npx tsx --env-file=.env.local scripts/resend-encrypted-harness.mts [--headed]

import { chromium, type Page } from "playwright";
import { io, type Socket } from "socket.io-client";
import { encode } from "next-auth/jwt";

const URL = "http://localhost:4000";
const PEER = "resend-a@test";
const VIEWER = "resend-b@test";
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
  const peer = await connect(PEER);
  await sleep(300);

  const stamp = Date.now();
  const groupId = await new Promise<string>((resolve, reject) => {
    peer.emit(
      "group:create",
      { name: `resend-${stamp}`, topic: "resend harness", memberIds: [VIEWER] },
      (res: { ok: boolean; groupId?: string }) =>
        res.ok && res.groupId ? resolve(res.groupId) : reject(new Error("create failed")),
    );
  });

  // Everything the co-member's socket sees for this group.
  const seen: {
    id: string;
    text: string;
    enc?: string;
    attachment?: Record<string, unknown>;
  }[] = [];
  peer.on(
    "message:new",
    (p: {
      groupId: string;
      message: {
        id: string;
        text: string;
        enc?: string;
        attachment?: Record<string, unknown>;
      };
    }) => {
      if (p.groupId === groupId) seen.push(p.message);
    },
  );

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
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${URL}/${groupId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Connected", { timeout: 40000 });
  await dismissDialogs(page);
  await sleep(1500); // let key publication settle so a seal is possible

  // --- go offline, send, come back ----------------------------------------
  const body = `offline-then-resent ${stamp}`;
  await ctx.setOffline(true);
  await page.waitForSelector("text=Offline", { timeout: 20000 }).catch(() => {});

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.type(body, { delay: 10 });
  await page.keyboard.press("Enter");
  // It renders optimistically and cannot be acked while the socket is down.
  await page.waitForSelector(`text=${body}`, { timeout: 15000 });
  check(true, "the message renders optimistically while offline");
  await sleep(1500);

  const deliveredWhileOffline = seen.length;
  check(deliveredWhileOffline === 0, "nothing reached the peer while offline");

  await ctx.setOffline(false);
  await page.waitForSelector("text=Connected", { timeout: 40000 });
  // The reconnect resend fires here; give the seal + round trip room.
  await sleep(6000);

  // --- what actually crossed the wire -------------------------------------
  check(seen.length > 0, `the peer received the message after reconnect (${seen.length})`);

  // THE point of this harness: no copy may carry a readable body, and every copy
  // must carry an envelope.
  const plaintext = seen.filter((m) => (m.text ?? "") !== "");
  check(
    plaintext.length === 0,
    `no copy arrived as plaintext (${plaintext.length} did: ${plaintext
      .map((m) => JSON.stringify(m.text))
      .join(", ")})`,
  );
  check(
    seen.length > 0 && seen.every((m) => !!m.enc),
    "every copy carried an E2EE envelope",
  );
  // Attachment keys ride inside the envelope; the wire attachment must be stripped.
  const leakedKeys = seen.filter((m) => m.attachment?.key || m.attachment?.iv);
  check(leakedKeys.length === 0, "no attachment key/iv on the wire");

  // The sender must still be able to read its own message (the outbox holds the
  // only copy of the body until the ack lands).
  check(
    (await page.getByText(body, { exact: false }).count()) > 0,
    "the sender can still read its own resent message",
  );
  check(
    (await page.getByText("Unable to decrypt").count()) === 0,
    "no 🔒 row after the resend",
  );
  check(
    (await page.getByText("Not sent", { exact: false }).count()) === 0,
    "the resend was not marked failed",
  );
  // Reported, not asserted: this harness is about SEALING, and duplication is a
  // separate, pre-existing defect. The server discards clientId (`void clientId`
  // in server/store.ts addMessage), so a buffered emit that lands plus this
  // resend become two messages with two ids — which the recipient cannot
  // de-dupe. Printed loudly so it can't quietly become the accepted behaviour.
  const ids = new Set(seen.map((m) => m.id));
  if (ids.size > 1) {
    console.log(
      `\nNOTE  the send was delivered as ${ids.size} distinct messages from ` +
        `${seen.length} relays — the server does not de-dupe by clientId, so a ` +
        `reconnect resend duplicates. Separate fix, server-side.`,
    );
  }
  check(errors.length === 0, `no uncaught page errors (${errors.length})`);
  if (errors.length) errors.slice(0, 5).forEach((e) => console.log("   ERR:", e));

  if (HEADED) await sleep(4000);
  await browser.close();
  peer.close();

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
