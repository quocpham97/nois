"use client";

/**
 * The "new message" compose flow: pick a recipient, type, send. It creates the DM
 * as a side effect, which is why it doesn't go through the ordinary send path —
 * the conversation doesn't exist yet, so the optimistic group and the `dm:create`
 * emit have to be built here.
 */
import { useCallback, useMemo } from "react";
import { cryptoAvailable } from "@/lib/crypto/identity";
import { dmIdFor } from "@/lib/dm-id";
import { nowTime, type Group, type Message } from "@/lib/chat-data";
import { chat } from "@/stores/chat-store";
import { session } from "@/stores/session-store";
import { myUser } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import type { KeyMaterial } from "./use-key-material";
import type { Outbox } from "./use-outbox";

export type Compose = ReturnType<typeof useCompose>;

export function useCompose({
  socket,
  keys,
  outbox,
  scrollToBottom,
}: {
  socket: TypedSocket | null;
  keys: KeyMaterial;
  outbox: Outbox;
  scrollToBottom: () => void;
}) {
  const { buildEnvelope } = keys;
  const { armFailTimer, markFailed, rememberSent, rememberPlaintext } = outbox;

  const sendCompose = useCallback(() => {
    const s = chat();
    const text = s.composeText.trim();
    const recipient = s.composeRecipients[0];
    if (!recipient || !text) return;

    const user = s.workspaceMembers.find((u) => u.name === recipient);
    if (!user?.id) return;

    // The recipient key is the partner's stable uid (the id the server routes DMs
    // by and that their E2EE bundles are published under) — never guessed from the
    // display name, which fails for real users keyed by email.
    const recipientId = user.id;
    // DM id == an opaque hash of both participants' uids (no "dm-" prefix): the
    // flat id space is shared with groups, and `type` distinguishes them. Must
    // match the server's `dmIdFor` so our optimistic group is the same
    // conversation the server acks into.
    const dmId = dmIdFor(session().userId, recipientId);
    const clientId = "tmp-" + Date.now();
    const optimistic: Message = {
      id: clientId,
      author: myUser(),
      self: true,
      time: nowTime(),
      ts: Date.now(),
      text,
      reactions: [],
      pending: true,
    };

    s.setGroups((cur) => {
      const existing = cur[dmId];
      if (existing) {
        return {
          ...cur,
          [dmId]: { ...existing, messages: [...existing.messages, optimistic] },
        };
      }
      const newDm: Group = {
        id: dmId,
        type: "dm",
        name: user.name,
        user,
        presence: "active",
        pinned: [],
        messages: [optimistic],
      };
      return { ...cur, [dmId]: newDm };
    });

    s.setDmOrder((order) => (order.includes(dmId) ? order : [...order, dmId]));
    s.setComposeText("");
    s.setComposeQuery("");
    s.setComposeRecipients([]);
    s.navigateTo(dmId);
    s.setComposeOpen(false);
    requestAnimationFrame(scrollToBottom);
    armFailTimer(clientId);
    rememberPlaintext(clientId, { text });
    // Server creates/joins the DM, acks our optimistic message, and announces
    // brand-new DMs to other clients via group:created. Default-E2EE: only send
    // once encrypted; if the recipient has no keys yet, fail (no plaintext).
    const NO_KEYS =
      "Not sent — end-to-end encryption isn’t available yet (they haven’t set up their keys).";
    if (cryptoAvailable() && socket) {
      buildEnvelope(recipientId, { text })
        .then((enc) => {
          if (!enc) return markFailed(clientId, NO_KEYS);
          void rememberSent(clientId, enc, { text });
          socket.emit("dm:create", { recipientId, text: "", clientId, enc });
        })
        .catch(() => markFailed(clientId, NO_KEYS));
    } else {
      markFailed(clientId, "Not sent — encryption isn’t available on this device.");
    }
  }, [
    socket,
    buildEnvelope,
    armFailTimer,
    markFailed,
    rememberSent,
    rememberPlaintext,
    scrollToBottom,
  ]);

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      sendCompose,
    }),
    [sendCompose],
  );
}
