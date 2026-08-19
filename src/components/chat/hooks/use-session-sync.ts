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

export function useSessionSync({
  socket,
  status,
  history,
  retrySend,
  scheduleReceipt,
}: {
  socket: TypedSocket | null;
  status: ConnectionStatus;
  history: History;
  /** The ordinary retry path — see the resend effect below for why it is used
   *  rather than re-emitting the message here. */
  retrySend: (groupId: string, msgId: string) => void;
  scheduleReceipt: (groupId: string) => void;
}) {
  const { loadLocalHistory, scrollToBottom, jumpPendingRef } = history;
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

  /**
   * On (re)connect, resend any optimistic message that was never acked — the
   * only path that recovers a send whose emit was lost outright (a reload drops
   * socket.io's offline buffer; a disconnect does not).
   *
   * It goes through the ordinary retry path so a resend is sealed like any other
   * message. It used to build its own `message:send` here with the body in the
   * plaintext `text` field and no envelope, which handed the server exactly what
   * default-E2EE promises it never sees; the same shape also passed the
   * attachment through with its `key`/`iv` still attached, where every other send
   * strips them into the envelope. Two lesser bugs came with it: the hand-rolled
   * payload carried only text/attachment/rich, so a resent message silently lost
   * its quoted reply, link preview, forwarded marker and call payload.
   *
   * `retrySend` re-seals from the local plaintext and marks the row pending
   * again, so all of that is handled in one place.
   *
   * KNOWN ISSUE (predates this, and not fixed here): a resend can DUPLICATE the
   * message. The long-standing comment here claimed "server idempotency (by
   * clientId) makes this safe from duplicates", but the server discards clientId
   * (`void clientId` in server/store.ts addMessage) and there is no client_id
   * column — so a buffered emit that lands plus this resend become two messages
   * with two ids, which the recipient's de-dupe (keyed on the server id) cannot
   * collapse. scripts/resend-encrypted-harness.mts reports the relay/id counts.
   * The fix belongs on the server: key the insert on clientId and return the
   * existing row.
   */
  useEffect(() => {
    if (!socket || status !== "connected") return;
    const all = chat().groups;
    const stale: { groupId: string; msgId: string }[] = [];
    for (const groupId of Object.keys(all)) {
      for (const m of all[groupId].messages) {
        if (m.pending || m.failed) stale.push({ groupId, msgId: m.id });
      }
    }
    for (const { groupId, msgId } of stale) retrySend(groupId, msgId);
  }, [socket, status, retrySend]);
}
