"use client";

/**
 * Everything a view can DO to a message: send, retry, delete, edit, forward,
 * reply in a thread, react, pin, and record a finished call.
 *
 * `emitSend` is the single wire path for a new message body — first send, retry,
 * forward and call rows all go through it, so the default-E2EE rule is stated
 * once: if we can't encrypt, the message FAILS with a reason. There is no
 * plaintext fallback.
 */
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import * as msgdb from "@/lib/message-db";
import { cryptoAvailable } from "@/lib/crypto/identity";
import type { MessageContent } from "@/lib/crypto/types";
import {
  callEventTitle,
  messageExcerpt,
  nowTime,
  type Attachment,
  type CallEvent,
  type LinkPreview,
  type Message,
  type ReplyRef,
} from "@/lib/chat-data";
import { chat } from "@/stores/chat-store";
import { isDm, myUser } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import { SEND_TIMEOUT_MS, type SendBody } from "../lib/types";
import type { Outbox } from "./use-outbox";
import type { Seal } from "./use-seal";
import type { Typing } from "./use-typing";

export type MessageActions = ReturnType<typeof useMessageActions>;

export function useMessageActions({
  socket,
  outbox,
  seal,
  typing,
  scrollToBottom,
}: {
  socket: TypedSocket | null;
  outbox: Outbox;
  seal: Seal;
  typing: Typing;
  scrollToBottom: () => void;
}) {
  const {
    armFailTimer,
    markFailed,
    rememberSent,
    rememberPlaintext,
    sentEditRef,
    editTimersRef,
  } = outbox;
  const { sealFor } = seal;
  const { stopTyping } = typing;

  /** socket.io buffers emits while disconnected and flushes on reconnect. Shared
   *  by first-send and retry so the wire shape + fail timer stay in sync. */
  const emitSend = useCallback(
    (
      groupId: string,
      clientId: string,
      text: string,
      attachment?: Attachment | null,
      body: SendBody = {},
    ) => {
      const { rich, preview, replyTo, forwarded, call } = body;
      armFailTimer(clientId);
      // An encrypted attachment's key/iv travel inside the message envelope, so
      // strip them from the wire attachment (the server only ever gets ciphertext
      // + an opaque blob).
      const att =
        attachment?.encrypted && attachment.key && attachment.iv
          ? { key: attachment.key, iv: attachment.iv }
          : undefined;
      const strippedAttachment = attachment
        ? (() => {
            const { key: _k, iv: _iv, ...rest } = attachment;
            void _k;
            void _iv;
            return rest;
          })()
        : undefined;
      const sendEnc = (enc: string) => {
        // Durable copy of what we just sealed, so a reload before the ack can't
        // strand our own message as 🔒.
        void rememberSent(clientId, enc, {
          text,
          rich,
          preview,
          replyTo,
          forwarded,
          call,
          att,
        });
        socket?.emit("message:send", {
          groupId,
          text: "",
          clientId,
          attachment: strippedAttachment,
          enc,
        });
      };
      // "The other side" is only meaningful in a DM; in a group the same failure
      // means nobody else has published keys yet.
      const NO_KEYS = isDm(groupId)
        ? "Not sent — end-to-end encryption isn’t available here yet (the other side hasn’t set up their keys)."
        : "Not sent — no other member of this group has set up encryption keys yet.";
      if (cryptoAvailable() && socket) {
        // The preview travels ONLY inside the envelope — never a wire field.
        sealFor(groupId, { text, rich, att, preview, replyTo, forwarded, call })
          .then((enc) => (enc ? sendEnc(enc) : markFailed(clientId, NO_KEYS)))
          .catch(() => markFailed(clientId, NO_KEYS));
      } else {
        markFailed(clientId, "Not sent — encryption isn’t available on this device.");
      }
    },
    [socket, armFailTimer, markFailed, rememberSent, sealFor],
  );

  const sendMessage = useCallback(
    (text: string, rich?: string, preview?: LinkPreview) => {
      const s = chat();
      const trimmed = text.trim();
      const attachment = s.composerAttachment;
      if (!trimmed && !attachment) return;
      const groupId = s.currentGroupId;
      // Quoted reply: snapshot the message being replied to (consumed here so the
      // reply banner clears on send). Rides the E2EE envelope via emitSend.
      const replyTo: ReplyRef | undefined = s.replyingTo
        ? {
            msgId: s.replyingTo.id,
            author: s.replyingTo.author.name,
            authorId: s.replyingTo.author.id,
            text: messageExcerpt(s.replyingTo),
          }
        : undefined;
      // Optimistic: render immediately with a temp id that doubles as the clientId
      // for reconcile. The server ack swaps in the canonical message.
      const clientId = "tmp-" + Date.now();
      s.appendMessage(groupId, {
        id: clientId,
        author: myUser(),
        self: true,
        time: nowTime(),
        ts: Date.now(),
        text: trimmed,
        reactions: [],
        pending: true,
        ...(attachment ? { attachment } : {}),
        ...(rich ? { rich } : {}),
        ...(preview ? { preview } : {}),
        ...(replyTo ? { replyTo } : {}),
      });
      s.setComposerAttachment(null);
      stopTyping(groupId);
      requestAnimationFrame(scrollToBottom);
      // Remember our own plaintext (and the attachment key, which rides the
      // envelope and is stripped from the acked attachment) so the ack renders
      // without self-decryption.
      rememberPlaintext(clientId, {
        text: trimmed,
        rich,
        preview,
        ...(replyTo ? { replyTo } : {}),
        ...(attachment?.encrypted && attachment.key && attachment.iv
          ? { att: { key: attachment.key, iv: attachment.iv } }
          : {}),
      });
      s.setReplyingTo(null);
      emitSend(groupId, clientId, trimmed, attachment, { rich, preview, replyTo });
    },
    [emitSend, rememberPlaintext, scrollToBottom, stopTyping],
  );

  /**
   * Record a finished call in its conversation. Called by CallProvider on the
   * CALLER's side only — one row per call, sealed like any other message, so it
   * reaches every device on both sides through the normal delivery + local-history
   * path. `text` carries a readable rendering of the same thing: it's what a
   * client too old to know about `call` shows, and what full-text search indexes.
   */
  const logCallEvent = useCallback(
    (groupId: string, call: CallEvent) => {
      const s = chat();
      if (!s.groups[groupId]) return; // unresolvable conversation
      const title = callEventTitle(call, false);
      const text = call.duration ? `${title} · ${call.duration}` : title;
      const clientId = "tmp-call-" + Date.now();
      s.appendMessage(groupId, {
        id: clientId,
        author: myUser(),
        self: true,
        time: nowTime(),
        ts: Date.now(),
        text,
        call,
        reactions: [],
        pending: true,
      });
      if (groupId === s.currentGroupId) requestAnimationFrame(scrollToBottom);
      rememberPlaintext(clientId, { text, call });
      emitSend(groupId, clientId, text, null, { call });
    },
    [emitSend, rememberPlaintext, scrollToBottom],
  );

  const retrySend = useCallback(
    (groupId: string, msgId: string) => {
      const msg = chat().groups[groupId]?.messages.find((m) => m.id === msgId);
      if (!msg) return;
      chat().markSending(groupId, msgId);
      emitSend(groupId, msgId, msg.text, msg.attachment, {
        rich: msg.rich,
        preview: msg.preview,
        replyTo: msg.replyTo,
        forwarded: msg.forwarded,
        call: msg.call,
      });
    },
    [emitSend],
  );

  const deleteMessage = useCallback(
    (groupId: string, msgId: string) => {
      // The server keeps no message copy, so tell it whether this is a thread
      // reply (and under which parent) by inspecting the loaded tree.
      const ch = chat().groups[groupId];
      const parent = ch?.messages.find((m) =>
        (m.threadReplies || []).some((r) => r.id === msgId),
      );
      socket?.emit("message:delete", {
        groupId,
        msgId,
        parentId: parent?.id ?? null,
      });
    },
    [socket],
  );

  // An edit is a re-encrypted body: the FULL MessageContent (text, rich, the
  // attachment's key/iv, preview) is re-sealed and the server REPLACES the stored
  // envelope — so the attachment key must ride along, or a device replaying
  // history later could never decrypt the (kept) attachment.
  const startEdit = useCallback((groupId: string, msg: Message) => {
    const ch = chat().groups[groupId];
    const parent = ch?.messages.find((m) =>
      (m.threadReplies || []).some((r) => r.id === msg.id),
    );
    chat().setEditing({ groupId, msgId: msg.id, parentId: parent?.id ?? null });
  }, []);

  const submitEdit = useCallback(
    (text: string, rich?: string) => {
      const s = chat();
      const ed = s.editing;
      if (!ed || !socket) return;
      s.setEditing(null);
      const { groupId, msgId, parentId } = ed;
      const ch = s.groups[groupId];
      const msg = parentId
        ? ch?.messages
            .find((m) => m.id === parentId)
            ?.threadReplies?.find((r) => r.id === msgId)
        : ch?.messages.find((m) => m.id === msgId);
      // Only own, delivered, already-decrypted messages are editable.
      if (!msg || !msg.self || msg.deleted || msg.pending || msg.enc) return;
      const trimmed = text.trim();
      if (!trimmed || (trimmed === msg.text && rich === msg.rich)) return;

      const prev: Partial<Message> = {
        text: msg.text,
        rich: msg.rich,
        edited: msg.edited,
        editedTs: msg.editedTs,
      };
      const patch: Partial<Message> = {
        text: trimmed,
        rich,
        edited: true,
        editedTs: Date.now(), // provisional — the echo applies the server stamp
      };
      // Optimistic apply; the echoed message:edited short-circuits via this cache
      // (no ciphertext round-trip for the editing device).
      sentEditRef.current.set(msgId, { patch, prev });
      chat().applyMessagePatch(groupId, msgId, parentId, patch);
      void msgdb.patchMessage(msgId, patch);

      const revert = () => {
        sentEditRef.current.delete(msgId);
        editTimersRef.current.delete(msgId);
        chat().applyMessagePatch(groupId, msgId, parentId, prev);
        void msgdb.patchMessage(msgId, prev);
      };
      // Default-E2EE, same as sends: an edit that can't be encrypted is reverted —
      // never sent as plaintext.
      if (!cryptoAvailable()) return revert();
      const att =
        msg.attachment?.encrypted && msg.attachment.key && msg.attachment.iv
          ? { key: msg.attachment.key, iv: msg.attachment.iv }
          : undefined;
      // An edit REPLACES the stored envelope, so it must re-seal the whole body —
      // anything left out here disappears for every other device.
      const content: MessageContent = {
        text: trimmed,
        rich,
        att,
        preview: msg.preview,
        replyTo: msg.replyTo,
        forwarded: msg.forwarded,
        call: msg.call,
      };
      sealFor(groupId, content)
        .then((enc) => {
          if (!enc) return revert();
          editTimersRef.current.set(msgId, setTimeout(revert, SEND_TIMEOUT_MS));
          socket.emit("message:edit", { groupId, msgId, parentId, enc });
        })
        .catch(revert);
    },
    [socket, sealFor, sentEditRef, editTimersRef],
  );

  /** Forward to any number of conversations. Each target gets its own optimistic
   *  message + E2EE send (via emitSend) — the same default-E2EE path as a normal
   *  send, so a forward is never relayed as plaintext. Marked `forwarded` so the
   *  recipient renders the "Forwarded" label. */
  const forwardMessage = useCallback(
    (toGroupIds: string[]) => {
      const s = chat();
      const src = s.forwardSource;
      if (!src || toGroupIds.length === 0) return;
      toGroupIds.forEach((toId, i) => {
        const clientId = `tmp-${Date.now()}-${i}`;
        s.appendMessage(toId, {
          id: clientId,
          author: myUser(),
          self: true,
          time: nowTime(),
          ts: Date.now(),
          text: src.text,
          reactions: [],
          pending: true,
          forwarded: true,
          ...(src.attachment ? { attachment: src.attachment } : {}),
          ...(src.rich ? { rich: src.rich } : {}),
        });
        rememberPlaintext(clientId, {
          text: src.text,
          rich: src.rich,
          forwarded: true,
          ...(src.attachment?.encrypted && src.attachment.key && src.attachment.iv
            ? { att: { key: src.attachment.key, iv: src.attachment.iv } }
            : {}),
        });
        emitSend(toId, clientId, src.text, src.attachment, {
          rich: src.rich,
          forwarded: true,
        });
      });
      s.setForwardSource(null);
      if (toGroupIds.length === 1) {
        s.selectGroup(toGroupIds[0]);
      } else {
        toast.success(`Forwarded to ${toGroupIds.length} chats`);
      }
    },
    [emitSend, rememberPlaintext],
  );

  const sendThreadMessage = useCallback(
    (text: string, rich?: string) => {
      const s = chat();
      const trimmed = text.trim();
      if (!trimmed || !s.threadFor) return;
      stopTyping(s.currentGroupId);
      // The server broadcasts thread:new back to the whole room (incl. us), so we
      // don't render optimistically — one broadcast keeps everyone in sync.
      socket?.emit("thread:reply", {
        groupId: s.currentGroupId,
        parentId: s.threadFor,
        text: trimmed,
        clientId: "tmp-" + Date.now(),
        rich,
      });
    },
    [socket, stopTyping],
  );

  const toggleReaction = useCallback(
    (msgId: string, emoji: string) => {
      // Server owns the count; it broadcasts reaction:updated back to the room.
      socket?.emit("reaction:toggle", {
        groupId: chat().currentGroupId,
        msgId,
        emoji,
      });
      chat().setPickerOpenFor(null);
    },
    [socket],
  );

  /** Dismissing the pinned bar unpins everything for the whole group. The
   *  server's pins:updated comes back to us too, so state isn't touched here. */
  const clearPins = useCallback(
    (groupId: string) => {
      socket?.emit("pins:clear", { groupId });
    },
    [socket],
  );

  const togglePin = useCallback(
    (groupId: string, msgId: string) => {
      socket?.emit("pin:toggle", { groupId, msgId });
    },
    [socket],
  );

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      sendMessage,
      retrySend,
      deleteMessage,
      startEdit,
      submitEdit,
      forwardMessage,
      sendThreadMessage,
      toggleReaction,
      clearPins,
      togglePin,
      logCallEvent,
    }),
    [sendMessage, retrySend, deleteMessage, startEdit, submitEdit, forwardMessage, sendThreadMessage, toggleReaction, clearPins, togglePin, logCallEvent],
  );
}
