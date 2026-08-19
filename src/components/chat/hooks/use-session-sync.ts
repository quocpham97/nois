"use client";

/**
 * Connection lifecycle: joining the active conversation's room (and re-joining on
 * reconnect), and resending optimistic messages that were never acked.
 *
 * The group room (`socket.join(groupId)`) means "currently viewing" — durable
 * per-member state is broadcast to member rooms instead (see server.ts), so
 * joining here is about presence and typing, not delivery.
 */
import { useEffect } from "react";
import { chat, useChatStore } from "@/stores/chat-store";
import type { ConnectionStatus, TypedSocket } from "@/stores/session-store";
import type { History } from "./use-history";
import type { Outbox } from "./use-outbox";

export function useSessionSync({
  socket,
  status,
  history,
  outbox,
  scheduleReceipt,
}: {
  socket: TypedSocket | null;
  status: ConnectionStatus;
  history: History;
  outbox: Outbox;
  scheduleReceipt: (groupId: string) => void;
}) {
  const { loadLocalHistory, scrollToBottom, jumpPendingRef } = history;
  const { armFailTimer } = outbox;
  const currentGroupId = useChatStore((s) => s.currentGroupId);

  // Join the active group's room (and re-join on reconnect); leave on switch.
  // Opening a group marks it read: clear its badge locally + tell the server.
  useEffect(() => {
    if (!socket || status !== "connected") return;
    const groupId = currentGroupId;
    if (!groupId) return;
    socket.emit("group:join", { groupId });
    socket.emit("group:read", { groupId });
    scheduleReceipt(groupId);
    chat().setUnreadByGroup((s) => (s[groupId] ? { ...s, [groupId]: 0 } : s));
    // History lives locally (OPFS SQLite), not on the server — load it. Skip the
    // default latest-page load when a jump-to-message is loading a window around
    // a specific target for this group (jumpToMessage owns the load instead).
    if (jumpPendingRef.current !== groupId) {
      void loadLocalHistory(groupId).then(() =>
        requestAnimationFrame(scrollToBottom),
      );
    }
    return () => {
      socket.emit("group:leave", { groupId });
    };
  }, [
    socket,
    status,
    currentGroupId,
    loadLocalHistory,
    scrollToBottom,
    jumpPendingRef,
    scheduleReceipt,
  ]);

  // On (re)connect, resend any optimistic messages that were never acked. Server
  // idempotency (by clientId) makes this safe from duplicates, so this is the
  // reliable delivery path rather than socket.io's offline buffer.
  useEffect(() => {
    if (!socket || status !== "connected") return;
    const all = chat().groups;
    const resend: {
      groupId: string;
      id: string;
      text: string;
      attachment?: import("@/lib/chat-data").Message["attachment"];
      rich?: string;
    }[] = [];
    for (const groupId of Object.keys(all)) {
      for (const m of all[groupId].messages) {
        if (m.pending || m.failed) {
          resend.push({
            groupId,
            id: m.id,
            text: m.text,
            attachment: m.attachment,
            rich: m.rich,
          });
        }
      }
    }
    if (resend.length === 0) return;
    resend.forEach(({ groupId, id, text, attachment, rich }) => {
      socket.emit("message:send", { groupId, text, clientId: id, attachment, rich });
      armFailTimer(id);
    });
    chat().setGroups((s) => {
      let next = s;
      for (const { groupId, id } of resend) {
        const ch = next[groupId];
        if (!ch) continue;
        next = {
          ...next,
          [groupId]: {
            ...ch,
            messages: ch.messages.map((m) =>
              m.id === id ? { ...m, pending: true, failed: false } : m,
            ),
          },
        };
      }
      return next;
    });
  }, [socket, status, armFailTimer]);
}
