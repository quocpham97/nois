"use client";

/**
 * Typing signals, both directions. Outgoing: emit `typing:start` on the first
 * keystroke, auto-stop after a short idle, and stop explicitly on send. Incoming:
 * maintain the set of userIds typing per group.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { chat } from "@/stores/chat-store";
import type { TypedSocket } from "@/stores/session-store";

export type Typing = ReturnType<typeof useTyping>;

export function useTyping({ socket }: { socket: TypedSocket | null }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentRef = useRef(false);

  const stopTyping = useCallback(
    (groupId: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (sentRef.current) {
        sentRef.current = false;
        socket?.emit("typing:stop", { groupId });
      }
    },
    [socket],
  );

  const notifyTyping = useCallback(
    (groupId: string) => {
      if (!socket) return;
      if (!sentRef.current) {
        sentRef.current = true;
        socket.emit("typing:start", { groupId });
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        sentRef.current = false;
        socket.emit("typing:stop", { groupId });
      }, 2500);
    },
    [socket],
  );

  useEffect(() => {
    if (!socket) return;
    const onTyping = ({
      groupId,
      userId: uid,
      isTyping,
    }: {
      groupId: string;
      userId: string;
      isTyping: boolean;
    }) => {
      chat().setTypingByGroup((s) => {
        const cur = s[groupId] || [];
        const next = isTyping
          ? cur.includes(uid)
            ? cur
            : [...cur, uid]
          : cur.filter((u) => u !== uid);
        return { ...s, [groupId]: next };
      });
    };
    socket.on("typing:update", onTyping);
    return () => {
      socket.off("typing:update", onTyping);
    };
  }, [socket]);

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      notifyTyping,
      stopTyping,
    }),
    [notifyTyping, stopTyping],
  );
}
