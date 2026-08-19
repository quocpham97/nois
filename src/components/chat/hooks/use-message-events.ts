"use client";

/**
 * Server-authoritative MESSAGE events applied into local state: our own send's
 * ack, other people's arrivals, thread replies, reactions, deletes, edits, and
 * the history the server replays on join.
 *
 * The recurring rule here is "never overwrite what we already hold". The
 * server's copy of an E2EE message is ciphertext forever, while the local row
 * holds the plaintext from whenever we first decrypted it — and a replay is not
 * a second chance at that envelope (MLS drops a generation's key as it consumes
 * it, so re-decrypting throws and would flip a readable message to 🔒).
 */
import { useEffect } from "react";
import * as msgdb from "@/lib/message-db";
import { getShellBridge } from "@/lib/shell";
import type { Message } from "@/lib/chat-data";
import { chat } from "@/stores/chat-store";
import { withSelf } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import type { History } from "./use-history";
import type { Outbox } from "./use-outbox";
import type { PendingMessages } from "./use-pending-messages";

export function useMessageEvents({
  socket,
  userId,
  outbox,
  history,
  pending,
  scheduleReceipt,
  scheduleBackup,
}: {
  socket: TypedSocket | null;
  userId: string;
  outbox: Outbox;
  history: History;
  pending: PendingMessages;
  scheduleReceipt: (groupId: string) => void;
  scheduleBackup: () => void;
}) {
  const { takePlaintext, clearFailTimer, sentEditRef, editTimersRef } = outbox;
  const { loadLocalHistory, scrollToBottom } = history;
  const { hold } = pending;

  useEffect(() => {
    if (!socket) return;

    // Sender reconcile: swap the optimistic temp (id === clientId) for the
    // canonical server message wherever it lives.
    const onAck = ({
      clientId,
      message,
    }: {
      clientId: string;
      message: Message;
    }) => {
      clearFailTimer(clientId);
      // For our own encrypted message the server echoes back only ciphertext;
      // restore the plaintext we cached at send so it renders without
      // self-decryption (and clear `enc` so the decrypt pass ignores it).
      const cached = takePlaintext(clientId);
      const resolved =
        cached && message.enc
          ? {
              ...message,
              text: cached.text,
              rich: cached.rich,
              preview: cached.preview,
              replyTo: cached.replyTo,
              forwarded: cached.forwarded,
              call: cached.call,
              enc: undefined,
              // The acked attachment came back with key/iv stripped (they rode in
              // the envelope); restore them locally so our own image decrypts.
              ...(message.attachment && cached.att
                ? {
                    attachment: {
                      ...message.attachment,
                      key: cached.att.key,
                      iv: cached.att.iv,
                    },
                  }
                : {}),
            }
          : message;
      chat().setGroups((s) => {
        for (const id of Object.keys(s)) {
          const idx = s[id].messages.findIndex((m) => m.id === clientId);
          if (idx >= 0) {
            const msgs = [...s[id].messages];
            msgs[idx] = withSelf(resolved);
            // Persist our own (now-acked) message — it carries the server seq.
            void msgdb.putMessage(id, resolved);
            scheduleBackup(); // new plaintext locally → capture it in the backup
            return { ...s, [id]: { ...s[id], messages: msgs } };
          }
        }
        return s;
      });
    };

    // Message from another socket: append, de-duping by id.
    const onNew = ({ groupId, message }: { groupId: string; message: Message }) => {
      void msgdb.putMessage(groupId, message);
      chat().setGroups((s) => {
        const ch = s[groupId];
        // A message for a conversation whose meta hasn't arrived yet: hold it
        // instead of dropping it (it's already in local history, but live state
        // would stay empty until a reload).
        if (!ch) {
          hold(groupId, [message]);
          return s;
        }
        // A roster-cache placeholder for this same message is a preview line, not
        // the message — swap the real one in over it rather than de-duping the
        // real one away (which would leave the preview text on screen).
        const at = ch.messages.findIndex((m) => m.id === message.id);
        if (at >= 0) {
          if (!ch.messages[at].snapshot) return s;
          const messages = [...ch.messages];
          messages[at] = withSelf(message);
          return { ...s, [groupId]: { ...ch, messages } };
        }
        return {
          ...s,
          [groupId]: { ...ch, messages: [...ch.messages, withSelf(message)] },
        };
      });
      const state = chat();
      if (groupId === state.currentGroupId) {
        requestAnimationFrame(scrollToBottom);
        // We're viewing this group — keep it read on the server + reseal our E2EE
        // read cursor so the sender sees the "seen" avatar advance.
        socket.emit("group:read", { groupId });
        scheduleReceipt(groupId);
      }
      // Native shell (Electron desktop or Capacitor mobile): OS notification for
      // messages arriving outside the focused group (Web Push doesn't apply in a
      // native shell — src/lib/push.ts reports unsupported there; mobile uses
      // local/native notifications). Copy mirrors public/sw.js and stays generic:
      // the payload may still be an undecrypted E2EE envelope here.
      const shell = getShellBridge();
      if (
        shell &&
        message.author.id !== userId &&
        (groupId !== state.currentGroupId || document.hidden || !document.hasFocus())
      ) {
        const ch = state.groups[groupId];
        const dm = ch?.type === "dm";
        shell.notify({
          title: dm
            ? `New message from ${message.author.name}`
            : `New message in #${ch?.name ?? "a group"}`,
          body: dm ? "Tap to read" : `${message.author.name} sent a message`,
          // Native bridge (desktop/src/preload.ts) reads n.channelId; keep the key.
          channelId: groupId,
        });
      }
    };

    // Thread reply from anyone (incl. self): append to the parent, de-dupe.
    const onThreadNew = ({
      groupId,
      parentId,
      reply,
      threadCount,
      threadLastTime,
    }: {
      groupId: string;
      parentId: string;
      reply: Message;
      threadCount: number;
      threadLastTime: string;
    }) => {
      void msgdb.putReply(groupId, parentId, reply);
      void msgdb.patchMessage(parentId, { threadCount, threadLastTime });
      chat().setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        const msgs = ch.messages.map((m) => {
          if (m.id !== parentId) return m;
          const existing = m.threadReplies || [];
          if (existing.some((r) => r.id === reply.id)) return m;
          return {
            ...m,
            threadReplies: [...existing, withSelf(reply)],
            threadCount,
            threadLastTime,
          };
        });
        return { ...s, [groupId]: { ...ch, messages: msgs } };
      });
    };

    // Server broadcasts aggregated reactions (with reactor ids); derive our own
    // viewer-relative `mine`.
    const onReaction = ({
      groupId,
      msgId,
      reactions,
    }: {
      groupId: string;
      msgId: string;
      reactions: { e: string; n: number; by: string[] }[];
    }) => {
      const mine = reactions.map((r) => ({
        e: r.e,
        n: r.n,
        mine: r.by.includes(userId),
      }));
      void msgdb.patchMessage(msgId, { reactions: mine });
      chat().setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        return {
          ...s,
          [groupId]: {
            ...ch,
            messages: ch.messages.map((m) =>
              m.id === msgId ? { ...m, reactions: mine } : m,
            ),
          },
        };
      });
    };

    /**
     * Merge server-replayed history straight into live state.
     *
     * The local store is the durable home for message bodies, but it is
     * unavailable in some clients — it's effectively single-tab, so a second
     * tab's worker init fails and every msgdb call then resolves to an empty
     * result instead of throwing (see message-db.ts). Such a client used to show
     * every conversation as empty even though the server had just replayed it,
     * because replay only ever landed in the store.
     */
    const mergeReplayed = (
      groupId: string,
      messages: Message[],
      replies: { parentId: string; reply: Message }[],
    ) => {
      if (!messages.length && !replies.length) return;
      chat().setGroups((s) => {
        const ch = s[groupId];
        if (!ch) {
          hold(groupId, messages); // meta hasn't arrived — same holding pen
          return s;
        }
        // As in withHeld: a roster-cache placeholder never blocks the real copy.
        const have = new Set(ch.messages.filter((m) => !m.snapshot).map((m) => m.id));
        const fresh = messages.filter((m) => !have.has(m.id));
        const freshIds = new Set(fresh.map((m) => m.id));
        const byParent = new Map<string, Message[]>();
        for (const { parentId, reply } of replies) {
          byParent.set(parentId, [...(byParent.get(parentId) ?? []), reply]);
        }
        if (!fresh.length && !byParent.size) return s;
        // Message ids are time-sortable (store.newId), so sorting by id restores
        // send order; optimistic "tmp-" ids sort last and stay at the bottom.
        const merged = [
          ...ch.messages.filter((m) => !(m.snapshot && freshIds.has(m.id))),
          ...fresh.map(withSelf),
        ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return {
          ...s,
          [groupId]: {
            ...ch,
            messages: merged.map((m) => {
              const add = byParent.get(m.id);
              if (!add) return m;
              const existing = m.threadReplies ?? [];
              const seen = new Set(existing.map((r) => r.id));
              const extra = add.filter((r) => !seen.has(r.id)).map(withSelf);
              return extra.length
                ? { ...m, threadReplies: [...existing, ...extra] }
                : m;
            }),
          },
        };
      });
    };

    // Converge deletes/edits that happened while we were offline — a server
    // tombstone, or an edit with a newer editedTs, replaces the stale local body
    // (setting `enc` so the decrypt pass derives the new plaintext).
    const mergeStale = async (local: Message, incoming: Message) => {
      if (incoming.deleted && !local.deleted) {
        await msgdb.patchMessage(incoming.id, {
          text: "",
          rich: undefined,
          attachment: undefined,
          reactions: [],
          deleted: true,
        });
        return true;
      }
      if (
        incoming.enc &&
        incoming.edited &&
        (incoming.editedTs ?? 0) > (local.editedTs ?? 0)
      ) {
        await msgdb.patchMessage(incoming.id, {
          enc: incoming.enc,
          edited: true,
          editedTs: incoming.editedTs,
          text: "",
          rich: undefined,
          preview: undefined,
          locked: undefined,
        });
        return true;
      }
      return false;
    };

    // The same "never overwrite what we already hold" rule, applied to STATE.
    // Keep the replayed copy for everything the server owns — reactions, edits,
    // seq — and restore the body from the local row, exactly as onAck does for our
    // own sends.
    const withLocalPlaintext = (
      incoming: Message,
      local: Message | undefined,
    ): Message => {
      if (!local || !incoming.enc) return incoming;
      // Already read once — the plaintext exists nowhere else.
      if (!local.enc && !local.locked) {
        return {
          ...incoming,
          text: local.text,
          rich: local.rich,
          preview: local.preview,
          replyTo: local.replyTo,
          forwarded: local.forwarded,
          call: local.call,
          enc: undefined,
          locked: undefined,
          // Holds the attachment's decryption key/iv, which the server copy never
          // carries (they ride inside the envelope).
          attachment: local.attachment ?? incoming.attachment,
        };
      }
      // Already found unrecoverable — carry the verdict so the decrypt pass
      // doesn't take another run at an envelope whose keys are gone.
      if (local.locked) return { ...incoming, text: local.text, locked: true };
      return incoming;
    };

    const onHistoryReplay = async ({
      groupId,
      messages,
      replies,
    }: {
      groupId: string;
      messages: Message[];
      replies: { parentId: string; reply: Message }[];
    }) => {
      let added = false;
      const resolved: Message[] = [];
      for (const m of messages) {
        const local = await msgdb.getMessage(m.id);
        // A converged delete/edit deliberately replaced the local body, so the
        // replayed copy wins there — `local` is the pre-patch snapshot.
        let converged = false;
        if (!local) {
          await msgdb.putMessage(groupId, m);
          added = true;
        } else if (await mergeStale(local, m)) {
          added = true;
          converged = true;
        }
        resolved.push(converged ? m : withLocalPlaintext(m, local));
      }
      const resolvedReplies: { parentId: string; reply: Message }[] = [];
      for (const { parentId, reply } of replies) {
        const local = await msgdb.getMessage(reply.id);
        let converged = false;
        if (!local) {
          await msgdb.putReply(groupId, parentId, reply);
          added = true;
        } else if (await mergeStale(local, reply)) {
          added = true;
          converged = true;
        }
        resolvedReplies.push({
          parentId,
          reply: converged ? reply : withLocalPlaintext(reply, local),
        });
      }
      // State, not just the store: a client whose store is unavailable has
      // nowhere else to get this from, and loadLocalHistory would read back an
      // empty page for it.
      mergeReplayed(groupId, resolved, resolvedReplies);
      if (added && groupId === chat().currentGroupId) {
        void loadLocalHistory(groupId);
      }
    };

    const onMessageDeleted = ({
      groupId,
      msgId,
      parentId,
    }: {
      groupId: string;
      msgId: string;
      parentId: string | null;
    }) => {
      // Soft delete: turn the message into a tombstone in place (keep its slot and
      // any thread it anchors), rather than removing it.
      const tombstone = (m: Message): Message => ({
        ...m,
        text: "",
        rich: undefined,
        attachment: undefined,
        reactions: [],
        deleted: true,
      });
      void msgdb.patchMessage(msgId, {
        text: "",
        rich: undefined,
        attachment: undefined,
        reactions: [],
        deleted: true,
      });
      chat().setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        const messages = ch.messages.map((m) => {
          if (!parentId && m.id === msgId) return tombstone(m);
          if (parentId && m.id === parentId) {
            return {
              ...m,
              threadReplies: (m.threadReplies || []).map((r) =>
                r.id === msgId ? tombstone(r) : r,
              ),
            };
          }
          return m;
        });
        return { ...s, [groupId]: { ...ch, messages } };
      });
    };

    // An edit arrived (possibly our own echo). Ours: apply the cached plaintext —
    // no ciphertext flash. Others': swap in the new envelope; setting `enc`
    // re-triggers the decrypt pass, which decrypts the new body and re-persists
    // the plaintext locally.
    const onMessageEdited = ({
      groupId,
      msgId,
      parentId,
      enc,
      editedTs,
    }: {
      groupId: string;
      msgId: string;
      parentId: string | null;
      enc: string;
      editedTs: number;
    }) => {
      const own = sentEditRef.current.get(msgId);
      if (own) {
        sentEditRef.current.delete(msgId);
        const t = editTimersRef.current.get(msgId);
        if (t) {
          clearTimeout(t);
          editTimersRef.current.delete(msgId);
        }
        const patch: Partial<Message> = { edited: true, editedTs };
        void msgdb.patchMessage(msgId, patch);
        chat().applyMessagePatch(groupId, msgId, parentId, patch);
        return;
      }
      const patch: Partial<Message> = {
        enc,
        edited: true,
        editedTs,
        text: "",
        rich: undefined,
        preview: undefined,
        locked: undefined,
      };
      void msgdb.patchMessage(msgId, patch);
      chat().applyMessagePatch(groupId, msgId, parentId, patch);
    };

    socket.on("message:ack", onAck);
    socket.on("message:new", onNew);
    socket.on("thread:new", onThreadNew);
    socket.on("reaction:updated", onReaction);
    socket.on("history:replay", onHistoryReplay);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("message:edited", onMessageEdited);
    return () => {
      socket.off("message:ack", onAck);
      socket.off("message:new", onNew);
      socket.off("thread:new", onThreadNew);
      socket.off("reaction:updated", onReaction);
      socket.off("history:replay", onHistoryReplay);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("message:edited", onMessageEdited);
    };
  }, [
    socket,
    userId,
    takePlaintext,
    clearFailTimer,
    sentEditRef,
    editTimersRef,
    loadLocalHistory,
    scrollToBottom,
    hold,
    scheduleReceipt,
    scheduleBackup,
  ]);
}
