"use client";

/**
 * Socket events that move KEY material rather than messages: group sender-key
 * distribution (and the pull-on-miss request that asks for a re-send), and DM
 * self-heal, where a device that can't open a message asks a party to the
 * conversation to re-encrypt it to that device's current keys.
 *
 * The participant check in the reheal responder is what stops a DM being handed
 * to a third party that guessed a msgId.
 */
import { useEffect } from "react";
import * as msgdb from "@/lib/message-db";
import {
  consumeOneTimePreKey,
  groupGet,
  groupPut,
} from "@/lib/crypto/identity";
import { decryptEnvelope, encryptForDevices, type Envelope } from "@/lib/crypto/session";
import {
  deserializeState,
  type SenderKeyDistribution,
  type SenderKeyWire,
} from "@/lib/crypto/group";
import { chat } from "@/stores/chat-store";
import { dmPeerId, isDm } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import type { KeyMaterial } from "./use-key-material";

export function useKeyEvents({
  socket,
  userId,
  keys,
}: {
  socket: TypedSocket | null;
  userId: string;
  keys: KeyMaterial;
}) {
  const {
    getSecrets,
    recvChainsRef,
    requestedKeysRef,
    requestedAtRef,
    fetchBundles,
    fetchGroupBundles,
    distributeSenderKey,
    scheduleBackup,
    scheduleReplenish,
  } = keys;

  useEffect(() => {
    if (!socket) return;

    // A peer distributed its group sender key to us: decrypt the pairwise
    // envelope, store the chain for that (group, sender), and bump chainVersion so
    // the decrypt pass retries any messages awaiting it.
    const onSenderKey = async ({
      groupId,
      env,
    }: {
      groupId: string;
      env: string;
    }) => {
      const secrets = await getSecrets();
      if (!secrets) return;
      try {
        const res = await decryptEnvelope(JSON.parse(env) as Envelope, secrets);
        if (!res) return;
        const dist = JSON.parse(res.text) as SenderKeyDistribution;
        if (dist.skd !== 1 || dist.groupId !== groupId) return;
        recvChainsRef.current.set(
          `${groupId}|${dist.sender}`,
          deserializeState({ chainKey: dist.chainKey, index: dist.index }),
        );
        await groupPut(userId, `recv:${groupId}:${dist.sender}`, {
          chainKey: dist.chainKey,
          index: dist.index,
        });
        // We now hold a working key for this sender — allow future re-requests and
        // reset its wait clock.
        requestedKeysRef.current.delete(`${groupId}|${dist.sender}`);
        requestedAtRef.current.delete(`${groupId}|${dist.sender}`);
        // Forward secrecy: consume the one-time prekey this envelope used (we've
        // persisted the recv chain, so we never need to re-decrypt the envelope).
        if (res.usedOpkId) {
          await consumeOneTimePreKey(userId, res.usedOpkId);
          scheduleReplenish();
        }
        scheduleBackup(); // received key material → refresh the encrypted backup
        chat().bumpChainVersion();
      } catch {
        // malformed/foreign distribution — ignore
      }
    };

    // A member couldn't decrypt one of OUR messages and asked us to re-send our
    // sender key. If we're the requested sender and hold a seed for the group,
    // re-distribute it to the current member set (reaching the requester).
    const onSenderKeyRequest = async ({
      groupId,
      sender,
    }: {
      groupId: string;
      sender: string;
      fromUserId?: string;
    }) => {
      const secrets = await getSecrets();
      if (!secrets || secrets.deviceId !== sender) return;
      const seed = await groupGet<SenderKeyWire>(userId, `seed:${groupId}`);
      if (!seed) return;
      const members = await fetchGroupBundles(groupId);
      if (members.length) await distributeSenderKey(groupId, seed, members, secrets);
    };

    // DM self-heal responder: a peer (or our own other device) can't decrypt a DM
    // message. If we hold its plaintext AND the requester is a genuine party to
    // the DM the message lives in (our view), re-encrypt it to the requester's
    // CURRENT devices.
    const onRehealRequest = async ({
      groupId: reqGroupId,
      msgId,
      fromUserId,
    }: {
      groupId: string;
      msgId: string;
      fromUserId: string;
    }) => {
      const meta = await msgdb.getMessageMeta(msgId);
      if (!meta || !isDm(meta.groupId)) return;
      const { message, groupId } = meta;
      // Only hand over a readable body (skip tombstones / still-encrypted here).
      if (message.deleted || message.enc || message.locked) return;
      if (!message.text && !message.attachment) return;
      const peer = chat().groups[groupId]?.user?.id ?? dmPeerId(groupId);
      if (fromUserId !== userId && fromUserId !== peer) return; // not a DM party
      const secrets = await getSecrets();
      if (!secrets) return;
      const bundles = await fetchBundles(fromUserId);
      if (!bundles.length) return;
      const att =
        message.attachment?.encrypted &&
        message.attachment.key &&
        message.attachment.iv
          ? { key: message.attachment.key, iv: message.attachment.iv }
          : undefined;
      const env = await encryptForDevices(
        {
          text: message.text,
          rich: message.rich,
          att,
          preview: message.preview,
          replyTo: message.replyTo,
          forwarded: message.forwarded,
          // Every body field must ride along: a re-sealed message is the only copy
          // the requesting device will ever see, so a field dropped here is lost
          // for good on that device (a call row would decode as plain text).
          call: message.call,
        },
        bundles,
        secrets,
      );
      if (!env) return;
      socket.emit("dm:reheal:offer", {
        groupId: reqGroupId,
        msgId,
        toUserId: fromUserId,
        enc: JSON.stringify(env),
      });
    };

    // DM self-heal requester side: an envelope re-sealed to us arrived — swap it
    // in and re-run decryption (it now opens with a key we hold).
    const onRehealOffer = ({
      groupId,
      msgId,
      enc,
    }: {
      groupId: string;
      msgId: string;
      enc: string;
    }) => {
      void msgdb.patchMessage(msgId, { enc, locked: undefined });
      chat().setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        let found = false;
        const messages = ch.messages.map((m) => {
          if (m.id !== msgId) return m;
          found = true;
          return { ...m, enc, locked: undefined };
        });
        return found ? { ...s, [groupId]: { ...ch, messages } } : s;
      });
      chat().bumpRehealVersion();
    };

    socket.on("group:senderKey", onSenderKey);
    socket.on("group:senderKey:request", onSenderKeyRequest);
    socket.on("dm:reheal:request", onRehealRequest);
    socket.on("dm:reheal:offer", onRehealOffer);
    return () => {
      socket.off("group:senderKey", onSenderKey);
      socket.off("group:senderKey:request", onSenderKeyRequest);
      socket.off("dm:reheal:request", onRehealRequest);
      socket.off("dm:reheal:offer", onRehealOffer);
    };
  }, [
    socket,
    userId,
    getSecrets,
    recvChainsRef,
    requestedKeysRef,
    requestedAtRef,
    fetchBundles,
    fetchGroupBundles,
    distributeSenderKey,
    scheduleBackup,
    scheduleReplenish,
  ]);
}
