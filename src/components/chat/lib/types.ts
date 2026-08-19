/**
 * Shared chat vocabulary — the types and tuning constants the store, the logic
 * hooks and the views all speak. Extracted from the former single-file
 * chat-context so no module has to import the provider to name a draft.
 */
import type { CallEvent, LinkPreview, Message, ReplyRef } from "@/lib/chat-data";

export type SettingsTab =
  | "general"
  | "profile"
  | "privacy"
  | "notifications"
  | "appearance";

/** Sidebar nav destinations that take over the main pane. */
export type NavPanel = "mentions" | "drafts" | "people" | "archived";

/** Conversation-list filter chips (Messenger: Inbox / Unread / Groups). */
export type ChatFilter = "inbox" | "unread" | "groups";

/** An unsent composer draft, kept per group. */
export type Draft = { text: string; rich?: string };

/** Which message the composer is editing instead of sending. */
export type EditTarget = {
  groupId: string;
  msgId: string;
  parentId: string | null;
};

/** The last sealed read-cursor we CONSUMED from a peer device, and what it
 *  opened to. `readSeq` is absent when the envelope turned out to be
 *  undecryptable — enough to know never to run it through decrypt again. */
export type ConsumedReceipt = { env: string; readSeq?: number; ts?: number };

/** One of our own outgoing envelopes and the body we sealed into it. */
export type SentEnvelope = {
  clientId: string;
  enc: string;
  body: Partial<Message> & { att?: { key: string; iv: string } };
};

/** Everything an envelope carries besides the plain text, grouped so a new body
 *  field (preview, replyTo, call, …) doesn't grow a positional argument list. */
export type SendBody = {
  rich?: string;
  preview?: LinkPreview;
  replyTo?: ReplyRef;
  forwarded?: boolean;
  call?: CallEvent;
};

/** History page size (mirrors the old server page size). */
export const PAGE_SIZE = 30;

/** How long to wait for a pulled sender key before showing 🔒 (unrecoverable). */
export const KEY_WAIT_MS = 6000;

/** How long to wait for a DM reheal offer before showing 🔒 (peer/own device
 *  offline, or nobody holds the plaintext). */
export const REHEAL_WAIT_MS = 8000;

/** How long an optimistic message waits for its ack before it's marked failed. */
export const SEND_TIMEOUT_MS = 10_000;

/** How many un-acked outgoing envelopes to keep bodies for. Normally 0-1 are
 *  live at once; the cap just stops a pathological offline burst from growing
 *  the record without bound. */
export const SENT_PENDING_MAX = 32;
