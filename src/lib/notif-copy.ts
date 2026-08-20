/**
 * What a "new message" notification says.
 *
 * Deliberately generic — no sender's words, ever. The server can't read the
 * body, and the page has usually not opened it yet either, so there is nothing
 * to preview; showing content would also put it on a lock screen, which is a
 * decision of its own rather than a side effect of this.
 *
 * Three surfaces render it and they must agree, because the same conversation
 * can notify through any of them: the page (src/lib/notify.ts), a native push
 * the server composes for iOS/Android (src/server/mobile-push.ts), and Web Push
 * where the SERVICE WORKER composes it from routing metadata. public/sw.js is a
 * separately-cached artifact that can't import this, so it mirrors these strings
 * — keep the two in step.
 *
 * Not a client module (no "use client"): server.ts composes native pushes.
 */

export type NotifCopy = { title: string; body: string };

export function messageNotifCopy({
  senderName,
  groupName,
}: {
  senderName: string;
  /** Absent for a DM — where the sender IS the conversation. */
  groupName?: string;
}): NotifCopy {
  const sender = senderName || "Someone";
  return groupName
    ? { title: `New message in ${groupName}`, body: `${sender} sent a message` }
    : { title: `New message from ${sender}`, body: "Tap to read" };
}

/** A preview is trimmed, not wrapped: a notification shows two lines at most. */
const MAX_PREVIEW = 140;

/**
 * The same notification WITH the message in it, for the one caller that can
 * have it: the page, after this device decrypted the body. Opt-in per user
 * (NotifPrefs.preview) because it shows on a lock screen.
 */
export function messagePreviewCopy({
  senderName,
  groupName,
  text,
}: {
  senderName: string;
  groupName?: string;
  text: string;
}): NotifCopy {
  const body = text.length > MAX_PREVIEW ? text.slice(0, MAX_PREVIEW - 1) + "…" : text;
  // In a DM the sender IS the conversation, so they title it; in a group the
  // conversation titles it and the sender prefixes the line.
  return groupName
    ? { title: groupName, body: `${senderName || "Someone"}: ${body}` }
    : { title: senderName || "Someone", body };
}

/**
 * A call that started while this person was away. Composed by the server (the
 * only party that knows a call began) and shown by every transport.
 */
export function callNotifCopy({
  callerName,
  groupName,
  video,
}: {
  callerName: string;
  /** Absent for a DM. */
  groupName?: string;
  video: boolean;
}): NotifCopy {
  const caller = callerName || "Someone";
  const kind = video ? "video call" : "call";
  return groupName
    ? { title: `${kind === "call" ? "Call" : "Video call"} in ${groupName}`, body: `${caller} started it — tap to join` }
    : { title: `Incoming ${kind} from ${caller}`, body: "Tap to answer" };
}

/** Collapse key: one live notification per conversation, on every transport
 *  (Web Push `tag`, FCM `tag`/collapse_key, APNs `apns-collapse-id`). */
export function conversationTag(groupId: string): string {
  return "ch:" + groupId;
}

/** Calls collapse separately: a ringing call must not replace — or be replaced
 *  by — the message banner for the same conversation. */
export function callTag(groupId: string): string {
  return "call:" + groupId;
}
