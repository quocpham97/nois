"use client";

/**
 * Holding pen for messages that arrive for a conversation whose META hasn't
 * landed yet — a brand-new DM's first message racing its `group:created`.
 * Filled by the message events, drained by the roster events. Without it those
 * messages would only reappear from local history on the next reload.
 */
import { useCallback, useMemo, useRef } from "react";
import type { Message } from "@/lib/chat-data";
import { withSelf } from "@/stores/chat-selectors";

export type PendingMessages = ReturnType<typeof usePendingMessages>;

export function usePendingMessages() {
  const heldRef = useRef<Map<string, Message[]>>(new Map());

  /** Park a message (or several) until its conversation's meta arrives. */
  const hold = useCallback((groupId: string, messages: Message[]) => {
    const held = heldRef.current.get(groupId) ?? [];
    for (const m of messages) {
      if (!held.some((h) => h.id === m.id)) held.push(m);
    }
    heldRef.current.set(groupId, held);
  }, []);

  /**
   * Append any messages held for `groupId` that `messages` doesn't have yet.
   * Called from inside a setGroups updater, so it must be idempotent: React can
   * invoke an updater twice (StrictMode), hence the entry is dropped in a
   * microtask instead of here.
   */
  const withHeld = useCallback(
    (groupId: string, messages: Message[]): Message[] => {
      const held = heldRef.current.get(groupId);
      if (!held?.length) return messages;
      queueMicrotask(() => heldRef.current.delete(groupId));
      // Placeholders don't count as "already have it" — a real message with the
      // same id replaces the preview line it stood in for.
      const have = new Set(messages.filter((m) => !m.snapshot).map((m) => m.id));
      const add = held.filter((m) => !have.has(m.id)).map(withSelf);
      const added = new Set(add.map((m) => m.id));
      return [...messages.filter((m) => !(m.snapshot && added.has(m.id))), ...add];
    },
    [],
  );

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      hold,
      withHeld,
    }),
    [hold, withHeld],
  );
}
