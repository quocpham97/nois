"use client";

/**
 * Instant paint for the conversation list: hydrate it from the persisted local
 * snapshot on mount, before the socket connects, and write the snapshot back
 * (debounced) whenever the list or its previews change. Without this the sidebar
 * is blank on every reload until the roster arrives.
 */
import { useEffect, useRef } from "react";
import { chat, useChatStore } from "@/stores/chat-store";
import {
  restoreRoster,
  rosterCacheKey,
  snapshotRoster,
  type RosterCache,
} from "../lib/roster-cache";

export function useRosterCache({ userId }: { userId: string }) {
  const groups = useChatStore((s) => s.groups);
  const groupOrder = useChatStore((s) => s.groupOrder);
  const dmOrder = useChatStore((s) => s.dmOrder);

  // Only fills empty state; the live roster then reconciles.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !userId) return;
    hydratedRef.current = true;
    try {
      const raw = localStorage.getItem(rosterCacheKey(userId));
      if (!raw) return;
      const restored = restoreRoster(JSON.parse(raw) as RosterCache);
      const s = chat();
      s.setGroups((cur) => (Object.keys(cur).length ? cur : restored.groups));
      s.setGroupOrder((o) => (o.length ? o : restored.groupOrder));
      s.setDmOrder((o) => (o.length ? o : restored.dmOrder));
    } catch {}
  }, [userId]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!userId || (!groupOrder.length && !dmOrder.length)) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(
          rosterCacheKey(userId),
          JSON.stringify(snapshotRoster(groups, groupOrder, dmOrder)),
        );
      } catch {}
    }, 500);
  }, [groups, groupOrder, dmOrder, userId]);
}
