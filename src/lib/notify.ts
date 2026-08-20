"use client";

/**
 * Notifications for a message that arrives while the page is RUNNING.
 *
 * Web Push (src/lib/push.ts + public/sw.js) only covers a member with no live
 * socket, so it deliberately skips anyone whose tab is merely in the
 * background — that tab is "online" as far as the server can tell. Nothing
 * covered that case on the web: a hidden tab got a sidebar badge and silence.
 * The native shells had it (window.desktop/window.mobile `notify`), the browser
 * did not. This is the browser half, and it routes the shells through the same
 * decision so one set of preferences governs all three.
 *
 * Four things are decided here:
 *   * the PREFERENCES — shared with the server's push hook via notif-policy.ts,
 *   * WHEN the answer is knowable: a sealed message can't say whether it
 *     mentions you, so that decision is parked and re-asked after decrypt,
 *   * whether the user is already LOOKING at the conversation, and
 *   * which TAB shows it, because every tab of the login receives the message.
 *
 * Copy stays generic ("New message from Alice"), matching public/sw.js. The
 * escalation path does hold plaintext, so a content preview is possible there —
 * but it would put message text on a lock screen, so it stays a deliberate
 * separate decision rather than a side effect of this one.
 */
import { chat } from "@/stores/chat-store";
import { isDm as groupIsDm } from "@/stores/chat-selectors";
import { getShellBridge } from "./shell";
import type { NotifPrefs } from "./chat-data";
import { notifDecision, withNotifDefaults } from "./notif-policy";
import {
  conversationTag,
  messageNotifCopy,
  messagePreviewCopy,
} from "./notif-copy";

/** `renotify` (re-alert rather than silently replace a same-tag banner) is real
 *  on the service-worker path but missing from lib.dom's NotificationOptions. */
type ShowOptions = NotificationOptions & { renotify?: boolean };

const BUS_NAME = "messenger:notify";
/** How long to wait for sibling tabs to bid before showing a banner. */
const DECIDE_MS = 150;
/** Message ids remembered per tab, so a replay can't re-notify. */
const SEEN_MAX = 300;
/** A burst of messages is one ping, not one per message. */
const PING_GAP_MS = 3000;
/** How long a preview-wanting notification waits for its plaintext. */
const PREVIEW_WAIT_MS = 1200;

/** This tab's identity — used only to break the "who shows it" tie. */
const tabId =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

type Bid = { kind: "bid"; msgId: string; tabId: string; viewing: boolean };
/** A peer's bid plus when WE heard it — clocks differ across tabs, arrival
 *  order on this one doesn't. */
type HeardBid = { tabId: string; viewing: boolean; at: number };

/** Bids heard from OTHER tabs, per message id (dropped once decided). */
const peerBids = new Map<string, HeardBid[]>();
const seen = new Set<string>();
/**
 * Messages whose notification the arrival path parked, because a sealed
 * envelope can't answer "was I mentioned?" (see notif-policy.ts). ONLY these
 * may be re-opened once decrypted: the decrypt pass also runs over replayed
 * history on load, and that must never raise a banner.
 */
const deferred = new Set<string>();
let bus: BroadcastChannel | null | undefined;

/** The cross-tab bus, opened on first use. Null where unsupported (then this
 *  tab simply decides alone — the same-tag collapse absorbs a duplicate). */
function getBus(): BroadcastChannel | null {
  if (bus !== undefined) return bus;
  bus = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BUS_NAME);
  bus?.addEventListener("message", (e: MessageEvent) => {
    const bid = e.data as Bid | undefined;
    if (bid?.kind !== "bid" || typeof bid.msgId !== "string") return;
    const heard: HeardBid = { tabId: bid.tabId, viewing: bid.viewing, at: Date.now() };
    const list = peerBids.get(bid.msgId);
    if (list) list.push(heard);
    else peerBids.set(bid.msgId, [heard]);
    // Bids are normally consumed by winsBanner, but a tab that is *viewing* the
    // conversation returns before deciding and leaves its entry behind, so the
    // map is capped rather than trusted to drain. Oldest key first (Map iterates
    // in insertion order).
    while (peerBids.size > SEEN_MAX) {
      const oldest = peerBids.keys().next().value;
      if (oldest === undefined) break;
      peerBids.delete(oldest);
    }
  });
  return bus;
}

/** Add to a capped set, evicting the oldest (a Set iterates insertion order). */
function push(set: Set<string>, msgId: string): void {
  set.add(msgId);
  if (set.size > SEEN_MAX) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/** Is the user looking at this conversation, in THIS tab, right now? */
function isViewing(groupId: string): boolean {
  return (
    chat().currentGroupId === groupId && !document.hidden && document.hasFocus()
  );
}

function announce(msgId: string, viewing: boolean): void {
  getBus()?.postMessage({ kind: "bid", msgId, tabId, viewing } satisfies Bid);
}

/**
 * Decide whether THIS tab shows the banner for `msgId`.
 *
 * Every tab of the login gets the same `message:new` and runs this same
 * algorithm, so they converge without a coordinator: a tab that has the
 * conversation on screen bids `viewing`, which cancels the banner everywhere —
 * the user has already seen it. Otherwise a bid that reached us BEFORE we
 * placed ours means that tab got there first and is already showing it, and
 * only genuinely concurrent bids need the tab-id tie-break. The two rules are
 * both needed: reaching for arrival order alone makes two simultaneous tabs
 * both stand down, and the id alone makes a tab that decides late (decrypt
 * timing differs per tab, and hidden tabs have throttled timers) double up.
 * Where they still race the shared `tag` collapses it into one banner.
 */
async function winsBanner(msgId: string, placedAt: number): Promise<boolean> {
  if (!getBus()) return true;
  await new Promise((r) => setTimeout(r, DECIDE_MS));
  const peers = peerBids.get(msgId) ?? [];
  peerBids.delete(msgId);
  if (peers.some((p) => p.viewing)) return false;
  if (peers.some((p) => p.at < placedAt)) return false;
  return peers.every((p) => tabId < p.tabId);
}

async function show(groupId: string, title: string, body: string): Promise<void> {
  // In a native shell the OS notification goes through the bridge (Electron's
  // main process / Capacitor LocalNotifications); the Notification API below is
  // either absent or second-class there.
  const shell = getShellBridge();
  if (shell) {
    shell.notify({ title, body, channelId: groupId });
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  const opts: ShowOptions = {
    body,
    // Same tag as the push path, so a second message replaces the first banner
    // for that conversation instead of stacking.
    tag: conversationTag(groupId),
    renotify: true,
    data: { channelId: groupId },
  };
  // Prefer the service worker: `new Notification()` throws outright on Android
  // Chrome, and the SW's existing notificationclick handler already does the
  // deep-link (public/sw.js), so this path needs no click wiring of its own.
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) {
    await reg.showNotification(title, opts);
    return;
  }
  const n = new Notification(title, opts);
  n.onclick = () => {
    window.focus();
    chat().selectGroup(groupId);
    n.close();
  };
}

let lastPing = 0;
let audio: AudioContext | null = null;

/** A short two-tone blip, synthesized so it ships no audio asset. */
function ping(): void {
  const now = Date.now();
  if (now - lastPing < PING_GAP_MS) return;
  lastPing = now;
  try {
    const Ctx =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    // Autoplay policy suspends the context until the page has had a gesture.
    void audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
    // Ramp both ends: a raw start/stop on a sine clicks.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.11, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  } catch {
    // No audio device, or a context the browser won't start — the banner still
    // fired, and a silent notification is not a failure worth surfacing.
  }
}

type Incoming = {
  msgId: string;
  groupId: string;
  authorName: string;
  /** Was the viewer @-mentioned? `undefined` = not knowable yet (the body is
   *  still sealed), which parks the decision rather than answering it. */
  mentioned?: boolean;
  /** The decrypted body, where there is one. Absent for a sealed message —
   *  which is what a preview has to wait for. */
  text?: string;
};

/** A decided notification held back for its text (see the preview wait below). */
type PendingPreview = {
  timer: ReturnType<typeof setTimeout>;
  msg: Incoming;
  prefs: NotifPrefs;
  dm: boolean;
};
const previewWait = new Map<string, PendingPreview>();

/**
 * Announce a message that just arrived from someone else. A no-op unless the
 * viewer's preferences allow it, they aren't already reading that conversation,
 * and this is the tab that won the banner.
 */
export function notifyIncoming(msg: Incoming): void {
  void run(msg, false);
}

/**
 * The same message, now that this device has opened it. Two things wait on
 * this, both of which are only knowable from plaintext:
 *
 *   * the mention question, for level 1 in a group — which is what makes
 *     "direct messages & mentions" true for an encrypted conversation;
 *   * the preview text, when the viewer asked for previews.
 *
 * A no-op for anything the arrival path didn't hold, so the replayed history
 * this same decrypt loop grinds through on load raises nothing.
 */
export function notifyDecrypted(msg: Incoming): void {
  void (async () => {
    try {
      // Already decided, and only waiting to be able to say what it says.
      const waiting = previewWait.get(msg.msgId);
      if (waiting) {
        clearTimeout(waiting.timer);
        previewWait.delete(msg.msgId);
        await deliver(msg, waiting.prefs, waiting.dm);
        return;
      }
      await run(msg, true);
    } catch (err) {
      console.warn("[notify] could not announce decrypted message", err);
    }
  })();
}

async function run(msg: Incoming, escalated: boolean): Promise<void> {
  const { msgId, groupId, text } = msg;
  try {
    // Arrival gets one shot per message. An escalation must claim the parked
    // entry (delete = claim), so two decrypt passes can't both announce.
    if (escalated ? !deferred.delete(msgId) : seen.has(msgId)) return;
    const dm = groupIsDm(groupId);
    const prefs = withNotifDefaults(chat().profile.notif);
    const decision = notifDecision(prefs, { isDm: dm, groupId, mentioned: msg.mentioned });
    if (decision === "defer") {
      push(deferred, msgId);
      return;
    }
    // Decided either way — don't reconsider this message again.
    push(seen, msgId);
    if (decision === "skip") return;

    // Notifying, but perhaps not yet: with previews on there is nothing to
    // preview until this device decrypts. Hold it briefly rather than firing a
    // generic banner that a preview would immediately replace — and only
    // briefly, because a message whose keys never arrive would otherwise be
    // announced not at all, which is worse than announcing it vaguely.
    if (prefs.preview && !escalated && !text) {
      const timer = setTimeout(() => {
        const held = previewWait.get(msgId);
        previewWait.delete(msgId);
        // No text after all — say the generic thing.
        if (held) void deliver(held.msg, held.prefs, held.dm);
      }, PREVIEW_WAIT_MS);
      previewWait.set(msgId, { timer, msg, prefs, dm });
      return;
    }
    await deliver(msg, prefs, dm);
  } catch (err) {
    // A banner that won't show is not a reason to lose the message: this runs
    // inside the message:new handler, and an unhandled rejection here would
    // surface as a page error over a cosmetic failure.
    console.warn("[notify] could not announce message", err);
  }
}

/** Everything after the decision: who shows it, the ping, the banner. */
async function deliver(msg: Incoming, prefs: NotifPrefs, dm: boolean): Promise<void> {
  const { msgId, groupId, authorName, text } = msg;
  const viewing = isViewing(groupId);
  // Bid before returning either way: sibling tabs need to hear that a focused
  // tab has this conversation on screen.
  const placedAt = Date.now();
  announce(msgId, viewing);
  if (viewing) {
    // On screen already — the ping is the whole notification.
    if (prefs.sound) ping();
    return;
  }
  if (!(await winsBanner(msgId, placedAt))) return;
  if (prefs.sound) ping();
  const groupName = dm ? undefined : (chat().groups[groupId]?.name ?? "a group");
  const body = text?.trim();
  const { title, body: line } =
    prefs.preview && body
      ? messagePreviewCopy({ senderName: authorName, groupName, text: body })
      : messageNotifCopy({ senderName: authorName, groupName });
  await show(groupId, title, line);
}
