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

/** Collapse key: one live notification per conversation, on every transport
 *  (Web Push `tag`, FCM `tag`/collapse_key, APNs `apns-collapse-id`). */
export function conversationTag(groupId: string): string {
  return "ch:" + groupId;
}
