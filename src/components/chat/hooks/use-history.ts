"use client";

/**
 * Local message history. The server stores no message bodies, so history lives
 * in this device's OPFS/SQLite store (lib/message-db) and everything here reads
 * from there: the latest page for an opened conversation, older pages on scroll,
 * a window around a jump target, and the one-line previews the sidebar shows
 * before any conversation is opened.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as msgdb from "@/lib/message-db";
import type { Group, Message } from "@/lib/chat-data";
import { chat, useChatStore } from "@/stores/chat-store";
import { withSelf } from "@/stores/chat-selectors";
import { resolvePins } from "../lib/pins";
import { PAGE_SIZE } from "../lib/types";

export type History = ReturnType<typeof useHistory>;

export function useHistory({ scrollToBottom }: { scrollToBottom: () => void }) {
  /** Conversations whose full history page is loaded in state. Preview-seeding
   *  skips these so it never clobbers a fully-loaded/open conversation with a
   *  single-message placeholder. */
  const loadedFullRef = useRef<Set<string>>(new Set());

  /** When a jump-to-message is loading a window around a target, the group-join
   *  effect must NOT also load the latest page (it would clobber the window).
   *  Holds the groupId being jumped into until the window is injected. */
  const jumpPendingRef = useRef<string | null>(null);

  /**
   * Last top-level message per conversation, from local history. Prefetched on
   * mount — in parallel with the socket connect, and warming the DB worker early
   * — so the sidebar can show the right preview + recency order the moment the
   * roster arrives, instead of seconds later when the worker would otherwise
   * cold-start. The roster handler reads this synchronously as it merges.
   */
  const latestByGroupRef = useRef<Map<string, Message>>(new Map());

  const groups = useChatStore((s) => s.groups);

  /** Seed/refresh each conversation's last-message preview from local history,
   *  for the sidebar's preview + recency order. Applies only to conversations not
   *  fully loaded, and only when the candidate is newer than what's shown — so it
   *  upgrades a stale cached snippet without disturbing live/open state. */
  const seedPreviews = useCallback(
    (entries: { groupId: string; message: Message }[]) => {
      if (!entries.length) return;
      chat().setGroups((s) => {
        let changed = false;
        const next = { ...s };
        for (const { groupId, message } of entries) {
          const ch = next[groupId];
          if (!ch || loadedFullRef.current.has(groupId)) continue;
          const cur = ch.messages[ch.messages.length - 1];
          // Equal ids still upgrade a placeholder: same message, real body.
          if (cur && (cur.snapshot ? cur.id > message.id : cur.id >= message.id))
            continue;
          next[groupId] = { ...ch, messages: [withSelf(message)] };
          changed = true;
        }
        return changed ? next : s;
      });
    },
    [],
  );

  /** Load a group's latest history page into state, keeping any un-acked
   *  optimistic tail. Also resolves the thread replies for each loaded message. */
  const loadLocalHistory = useCallback(async (groupId: string) => {
    const { messages, nextCursor } = await msgdb.getTopPage(groupId, null, PAGE_SIZE);
    loadedFullRef.current.add(groupId);
    const withReplies = await Promise.all(
      messages.map(async (m) =>
        m.threadCount ? { ...m, threadReplies: await msgdb.getReplies(m.id) } : m,
      ),
    );
    chat().setGroups((s) => {
      const loaded = withReplies.map(withSelf);
      const loadedIds = new Set(loaded.map((m) => m.id));
      // If the group meta hasn't arrived from groups:list yet, seed a placeholder
      // — the roster handler preserves existing messages when it merges the real
      // meta, so load order doesn't matter. Type isn't knowable from the id alone,
      // so assume "group"; the roster overwrites it with the server's type
      // (preserving these messages) before any send/receipt path needs the
      // DM/group distinction.
      const ch: Group =
        s[groupId] ?? {
          id: groupId,
          type: "group",
          name: "",
          pinned: [],
          messages: [],
        };
      // An empty local page must never wipe what's already on screen: when the
      // store is unavailable every read comes back empty (message-db.ts degrades
      // rather than throwing), and live + replayed messages in state are then the
      // only copy this client has.
      if (!loaded.length && ch.messages.length) return s;
      // Keep trailing un-acked optimistic messages across the (re)load.
      const pendingTail = ch.messages.filter(
        (m) => (m.pending || m.failed) && !loadedIds.has(m.id),
      );
      return { ...s, [groupId]: { ...ch, messages: [...loaded, ...pendingTail] } };
    });
    chat().setHistoryCursor((c) => ({ ...c, [groupId]: nextCursor }));
  }, []);

  /** Page older messages (prepend, de-dupe, advance the cursor). */
  const loadOlder = useCallback(async (groupId: string) => {
    const cursor = chat().historyCursor[groupId];
    if (cursor == null) return;
    const { messages, nextCursor } = await msgdb.getTopPage(groupId, cursor, PAGE_SIZE);
    chat().setGroups((s) => {
      const ch = s[groupId];
      if (!ch) return s;
      const have = new Set(ch.messages.map((m) => m.id));
      const older = messages.filter((m) => !have.has(m.id)).map(withSelf);
      if (older.length === 0) return s;
      return { ...s, [groupId]: { ...ch, messages: [...older, ...ch.messages] } };
    });
    chat().setHistoryCursor((c) => ({ ...c, [groupId]: nextCursor }));
  }, []);

  /** Jump to a message (e.g. a pinned one): highlight it if it's loaded,
   *  otherwise load a window around it first. Pass parentId for a thread-reply
   *  target — replies live in the thread panel, not the group scroll. */
  const jumpToMessage = useCallback(
    async (groupId: string, msgId: string, parentId?: string | null) => {
      const s = chat();
      s.setPinnedPanelFor(null);
      if (parentId) {
        if (groupId !== s.currentGroupId) s.navigateTo(groupId);
        s.setThreadFor(parentId);
        s.setHighlightMsgId(msgId);
        return;
      }
      // Top-level hit: if it's already loaded, just highlight; otherwise load a
      // window around it (guarding the join effect from clobbering with the
      // latest page), then highlight once it's in state.
      const loaded = s.groups[groupId]?.messages.some((m) => m.id === msgId);
      if (groupId === s.currentGroupId && loaded) {
        s.setHighlightMsgId(msgId);
        return;
      }
      jumpPendingRef.current = groupId;
      if (groupId !== s.currentGroupId) s.navigateTo(groupId);
      try {
        const { messages, nextCursor } = await msgdb.getPageAround(
          groupId,
          msgId,
          PAGE_SIZE,
        );
        const withReplies = await Promise.all(
          messages.map(async (m) =>
            m.threadCount ? { ...m, threadReplies: await msgdb.getReplies(m.id) } : m,
          ),
        );
        chat().setGroups((st) => {
          const ch = st[groupId];
          if (!ch) return st;
          const loadedMsgs = withReplies.map(withSelf);
          const ids = new Set(loadedMsgs.map((m) => m.id));
          const pendingTail = ch.messages.filter(
            (m) => (m.pending || m.failed) && !ids.has(m.id),
          );
          return {
            ...st,
            [groupId]: { ...ch, messages: [...loadedMsgs, ...pendingTail] },
          };
        });
        chat().setHistoryCursor((c) => ({ ...c, [groupId]: nextCursor }));
      } finally {
        jumpPendingRef.current = null;
      }
      requestAnimationFrame(() => chat().setHighlightMsgId(msgId));
    },
    [],
  );

  /** Resolve pin ids → snippets (local store, else the group's in-memory
   *  messages) and merge into a group's state. */
  const applyResolvedPins = useCallback(
    async (groupId: string, pinIds: string[]) => {
      const pinned = await resolvePins(pinIds, (id) => {
        const ch = chat().groups[groupId];
        if (!ch) return undefined;
        for (const m of ch.messages) {
          if (m.id === id) return m;
          const reply = m.threadReplies?.find((r) => r.id === id);
          if (reply) return reply;
        }
        return undefined;
      });
      chat().setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        // Nothing new resolved — hand back the identical state so the retry effect
        // can't spin on a pin no copy of which has arrived yet.
        const same =
          ch.pinIds?.length === pinIds.length &&
          ch.pinIds.every((id, i) => id === pinIds[i]) &&
          ch.pinned.length === pinned.length &&
          pinned.every(
            (p, i) => p.id === ch.pinned[i].id && p.text === ch.pinned[i].text,
          );
        if (same) return s;
        return { ...s, [groupId]: { ...ch, pinIds, pinned } };
      });
    },
    [],
  );

  // Prefetch the last message per conversation, and warm the DB worker.
  useEffect(() => {
    let cancelled = false;
    void msgdb.getLatestPerGroup().then((list) => {
      if (cancelled) return;
      latestByGroupRef.current = new Map(list.map((x) => [x.groupId, x.message]));
      seedPreviews(list);
    });
    return () => {
      cancelled = true;
    };
  }, [seedPreviews]);

  // A pin can only be rendered once this device has the message it points at, and
  // those arrive after the roster does (server replay, local page load, or the
  // decrypt pass). Retry any group whose pins aren't fully resolved yet whenever
  // its messages change; applyResolvedPins returns the state unchanged when
  // nothing new resolves, so this settles instead of looping.
  useEffect(() => {
    for (const [groupId, ch] of Object.entries(groups)) {
      const want = ch.pinIds?.length ?? 0;
      if (want && ch.pinned.length < want) {
        void applyResolvedPins(groupId, ch.pinIds!);
      }
    }
  }, [groups, applyResolvedPins]);

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      jumpPendingRef,
      latestByGroupRef,
      loadedFullRef,
      seedPreviews,
      loadLocalHistory,
      loadOlder,
      jumpToMessage,
      applyResolvedPins,
      scrollToBottom,
    }),
    [jumpPendingRef, latestByGroupRef, loadedFullRef, seedPreviews, loadLocalHistory, loadOlder, jumpToMessage, applyResolvedPins, scrollToBottom],
  );
}
