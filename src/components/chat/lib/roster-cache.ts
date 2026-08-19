/**
 * The sidebar's localStorage roster snapshot: pure snapshot/restore over a
 * compact per-user cache of the conversation list. The hook that reads and
 * writes localStorage lives in hooks/use-roster-cache.ts.
 */
import type { Group, GroupMap, Message, User } from "@/lib/chat-data";

// --- sidebar roster cache --------------------------------------------------
// A compact, per-user snapshot of the conversation list (group meta + a
// one-line last-message preview) persisted to localStorage. Rendered instantly
// on reload so the sidebar is populated before the socket connects, instead of
// blank-then-populate. The server roster + local OPFS history reconcile it a
// moment later. Only a single already-rendered preview line per group is
// stored (no ciphertext, no bodies beyond the visible snippet).
export const rosterCacheKey = (userId: string) => `chat:roster:${userId}`;

export type PreviewCache = {
  id: string;
  self: boolean;
  authorName: string;
  time: string;
  ts: number;
  /** Already-resolved preview body (plain text, "🔒 Message", "📎 name", …). */
  body: string;
  deleted: boolean;
};
export type GroupCache = Omit<Group, "messages" | "pinned"> & {
  last?: PreviewCache;
};
export type RosterCache = {
  groups: GroupCache[];
  groupOrder: string[];
  dmOrder: string[];
};

export function snapshotRoster(
  groups: GroupMap,
  groupOrder: string[],
  dmOrder: string[],
): RosterCache {
  const out: GroupCache[] = [];
  for (const id of [...groupOrder, ...dmOrder]) {
    const ch = groups[id];
    if (!ch) continue;
    const m = ch.messages[ch.messages.length - 1];
    let last: PreviewCache | undefined;
    if (m) {
      let body = m.text ?? "";
      if (!m.deleted) {
        if (!body && m.enc) body = "🔒 Message";
        else if (!body && m.attachment) body = "📎 " + m.attachment.name;
      }
      last = {
        id: m.id,
        self: !!m.self,
        authorName: m.author?.name ?? "",
        time: m.time ?? "",
        ts: m.ts ?? 0,
        body,
        deleted: !!m.deleted,
      };
    }
    const { messages: _msgs, pinned: _pins, ...meta } = ch;
    void _msgs;
    void _pins;
    out.push({ ...meta, last });
  }
  return { groups: out, groupOrder, dmOrder };
}

export function restoreRoster(cache: RosterCache): {
  groups: GroupMap;
  groupOrder: string[];
  dmOrder: string[];
} {
  const groups: GroupMap = {};
  for (const c of cache.groups) {
    const { last, ...meta } = c;
    // Rebuild a minimal message just so previewOf/lastTs render the cached
    // snippet + recency. No `enc` — the decrypt effect must never touch these
    // placeholders (opening the conversation replaces them with real history).
    // `snapshot` marks it as exactly that: a preview line, not a message. The
    // body it carries is the already-rendered snippet, so a call row would read
    // as plain text ("Missed voice call") and an attachment as "📎 name" — the
    // thread never renders these, and the real message supersedes them by id.
    const messages: Message[] = last
      ? [
          {
            id: last.id,
            self: last.self,
            time: last.time,
            ts: last.ts,
            text: last.deleted ? "" : last.body,
            deleted: last.deleted || undefined,
            author: { name: last.authorName } as User,
            reactions: [],
            snapshot: true,
          } as Message,
        ]
      : [];
    groups[meta.id] = { ...meta, messages, pinned: [] } as Group;
  }
  return {
    groups,
    groupOrder: cache.groupOrder,
    dmOrder: cache.dmOrder,
  };
}
