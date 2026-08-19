"use client";

/**
 * The inbound decrypt path: one envelope in, a message patch out.
 *
 * `decryptInbound` routes by envelope tag — MLS application message, group
 * sender-keys message, or pairwise DM — and answers our own outgoing messages
 * from the outbox (no scheme here can open an envelope we sealed ourselves).
 * Three outcomes matter to callers:
 *   * a patch          → plaintext, apply it
 *   * `null`           → not decryptable YET (key hasn't arrived); leave `enc`
 *                        in place and retry on the next chain/reheal bump
 *   * a `locked` patch  → 🔒; `permanent` when the key material is gone for good
 *
 * The effect at the bottom drives it over everything in state that still carries
 * `enc`, persists each plaintext locally, and converges because a successful
 * decrypt clears `enc`.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as msgdb from "@/lib/message-db";
import {
  consumeOneTimePreKey,
  cryptoAvailable,
  groupGet,
  groupPut,
  type DeviceSecrets,
} from "@/lib/crypto/identity";
import { decryptEnvelope, type Envelope } from "@/lib/crypto/session";
import {
  decryptGroupMessage,
  deserializeState,
  serializeState,
  type GroupEnvelope,
  type SenderKeyWire,
} from "@/lib/crypto/group";
import type { Message } from "@/lib/chat-data";
import { chat, useChatStore } from "@/stores/chat-store";
import { dmPeerId, isDm } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import { loadMls } from "../lib/mls-directory";
import { KEY_WAIT_MS, REHEAL_WAIT_MS } from "../lib/types";
import type { KeyMaterial } from "./use-key-material";
import type { Mls } from "./use-mls";
import type { Outbox } from "./use-outbox";

/** What one decrypt attempt yields. */
export type DecryptResult =
  | (Partial<Message> & {
      att?: { key: string; iv: string };
      /** Locked for good: the key material this envelope needs no longer
       *  exists, so re-running it later can only fail again. */
      permanent?: boolean;
    })
  | null;

export type Decrypt = ReturnType<typeof useDecrypt>;

export function useDecrypt({
  socket,
  userId,
  keys,
  mls,
  outbox,
}: {
  socket: TypedSocket | null;
  userId: string;
  keys: KeyMaterial;
  mls: Mls;
  outbox: Outbox;
}) {
  const {
    recvChainsRef,
    requestedKeysRef,
    requestedAtRef,
    getSecrets,
    scheduleReplenish,
    scheduleBackup,
  } = keys;
  const { sentBodyFor } = outbox;

  /** DM self-heal ("reheal") throttles: (groupId|msgId) we've already asked to
   *  have re-encrypted, so an undecryptable DM triggers one request (not one per
   *  decrypt pass); `rehealAtRef` stamps when, so a request unanswered past
   *  REHEAL_WAIT_MS resolves to 🔒 instead of pending forever. */
  const rehealRequestedRef = useRef<Set<string>>(new Set());
  const rehealAtRef = useRef<Map<string, number>>(new Map());

  // The decrypt pass re-runs on these, so it must subscribe to them.
  const groups = useChatStore((s) => s.groups);
  const chainVersion = useChatStore((s) => s.chainVersion);
  const rehealVersion = useChatStore((s) => s.rehealVersion);

  /** Ask a sender to (re)distribute its group key (pull-on-miss), throttled to
   *  one request per (group, sender) until we hold a working key. Because the
   *  distributed seed is the stable index-0 seed, getting it recovers the
   *  sender's whole history, not just messages from here on. */
  const requestSenderKey = useCallback(
    (groupId: string, sender: string) => {
      const k = `${groupId}|${sender}`;
      if (!socket || requestedKeysRef.current.has(k)) return;
      requestedKeysRef.current.add(k);
      requestedAtRef.current.set(k, Date.now());
      socket.emit("group:senderKey:request", { groupId, sender });
      // Re-run the decrypt pass after the grace window so an unanswered request
      // can resolve to 🔒 (the key may never come — e.g. our own pre-wipe keys).
      setTimeout(() => chat().bumpChainVersion(), KEY_WAIT_MS + 200);
    },
    [socket, requestedKeysRef, requestedAtRef],
  );

  /** DM self-heal: ask the DM peer (and our own other devices) to re-encrypt a
   *  message we can't open to our current keys. Throttled to one request per
   *  (group|msg); schedules a reheal bump so the decrypt pass re-runs after the
   *  grace window (to lock it if no offer arrived). */
  const requestReheal = useCallback(
    (groupId: string, msgId: string) => {
      const k = `${groupId}|${msgId}`;
      if (rehealRequestedRef.current.has(k)) return;
      rehealRequestedRef.current.add(k);
      rehealAtRef.current.set(k, Date.now());
      socket?.emit("dm:reheal:request", {
        groupId,
        msgId,
        peerId: dmPeerId(groupId),
      });
      setTimeout(() => chat().bumpRehealVersion(), REHEAL_WAIT_MS);
    },
    [socket],
  );

  const decryptInbound = useCallback(
    async (
      groupId: string,
      enc: string,
      secrets: DeviceSecrets,
      /** Message id — enables DM self-heal on an undecryptable copy (omitted for
       *  ephemeral receipts, which must not trigger a reheal). */
      msgId?: string,
    ): Promise<DecryptResult> => {
      const locked = { text: "🔒 Unable to decrypt", enc: undefined, locked: true };
      // Our own outgoing message: no scheme here can open an envelope we sealed
      // ourselves, so answer from the body we kept at send. `enc` is cleared
      // explicitly — the stored body round-trips through JSON, which drops
      // undefined fields, and leaving `enc` in place would re-queue the message
      // on every pass.
      const mine = await sentBodyFor(enc);
      if (mine) return { ...mine, enc: undefined };
      let parsed: unknown;
      try {
        parsed = JSON.parse(enc);
      } catch {
        return locked;
      }
      // MLS application message. Needs the group state; without it (no
      // Welcome/Commit processed yet) stay pending briefly — if no Welcome
      // materializes inside the grace window the message predates our membership
      // (or our leaf is unreachable) and locks. Lock-serialized against
      // sends/commits: decryption advances the receiver chains.
      if (parsed && (parsed as { t?: string }).t === "mls") {
        return mls.withMlsLock(groupId, async () => {
          // Already decrypted this session (overlapping passes) → replay the
          // cached plaintext instead of re-ratcheting (which would throw).
          const cached = msgId && mls.plainRef.current.get(msgId);
          if (cached) return cached;
          // Same envelope, already known unopenable → don't re-derive the verdict.
          const deadKey = msgId ?? (parsed as { w: string }).w;
          if (mls.deadRef.current.has(deadKey)) return { ...locked, permanent: true };
          const state = await mls.loadState(groupId);
          if (!state) {
            const since = mls.waitRef.current.get(groupId);
            if (since === undefined) {
              mls.waitRef.current.set(groupId, Date.now());
              return null;
            }
            return Date.now() - since > KEY_WAIT_MS ? locked : null;
          }
          mls.waitRef.current.delete(groupId);
          const engine = await loadMls();
          try {
            const res = await engine.mlsDecrypt(state, (parsed as { w: string }).w);
            if (!res) return locked;
            await mls.saveState(groupId, res.state);
            if (res.kind !== "application") return null; // control msg — state advanced
            const patch = {
              text: res.text,
              rich: res.rich ?? undefined,
              preview: res.preview ?? undefined,
              replyTo: res.replyTo ?? undefined,
              forwarded: res.forwarded ?? undefined,
              call: res.call ?? undefined,
              enc: undefined,
              att: res.att ?? undefined,
            };
            if (msgId) mls.plainRef.current.set(msgId, patch);
            return patch;
          } catch (err) {
            // ts-mls throws on a message we can't process (wrong epoch, our own
            // message, foreign/stale group) — lock it rather than crash decrypt.
            // Separate the two kinds: an envelope whose epoch/generation keys are
            // gone is lost for good and must be locked ONCE (the caller persists
            // that verdict, or every reconnect re-replays and re-fails it), while
            // anything else is still waiting on something.
            if (engine.mlsUnrecoverable(err)) {
              mls.deadRef.current.add(deadKey);
              console.warn(
                "[mls] message unrecoverable (its key material is gone)",
                groupId,
                msgId,
                (err as Error).message,
              );
              return { ...locked, permanent: true };
            }
            console.warn("[mls] decrypt failed", groupId, msgId, err);
            return locked;
          }
        });
      }
      // Group (sender-keys) message.
      if (parsed && (parsed as GroupEnvelope).t === "grp") {
        const env = parsed as GroupEnvelope;
        const k = `${groupId}|${env.s}`;
        let chain = recvChainsRef.current.get(k);
        if (!chain) {
          const wire = await groupGet<SenderKeyWire>(userId, `recv:${groupId}:${env.s}`);
          if (wire) {
            chain = deserializeState(wire);
            recvChainsRef.current.set(k, chain);
          }
        }
        if (!chain) {
          // No key for this sender. If a pull has gone unanswered past the grace
          // window, give up and lock it (e.g. our own messages whose sender key
          // was wiped — no device can ever answer). Otherwise pull and keep
          // waiting; it retries when the key arrives.
          const since = requestedAtRef.current.get(k);
          if (since !== undefined && Date.now() - since > KEY_WAIT_MS) {
            return locked;
          }
          requestSenderKey(groupId, env.s);
          return null;
        }
        const res = await decryptGroupMessage(chain, env);
        if (!res) {
          // Key present but it didn't decrypt (e.g. a stale seed from before a
          // re-key). Ask once for the current seed; if it still fails, lock it.
          if (requestedKeysRef.current.has(k)) return locked;
          requestSenderKey(groupId, env.s);
          return null;
        }
        recvChainsRef.current.set(k, res.next);
        await groupPut(userId, `recv:${groupId}:${env.s}`, serializeState(res.next));
        requestedKeysRef.current.delete(k);
        requestedAtRef.current.delete(k);
        return {
          text: res.text,
          rich: res.rich ?? undefined,
          preview: res.preview ?? undefined,
          replyTo: res.replyTo ?? undefined,
          forwarded: res.forwarded ?? undefined,
          call: res.call ?? undefined,
          enc: undefined,
          att: res.att ?? undefined,
        };
      }
      // 1:1 DM envelope.
      const res = await decryptEnvelope(parsed as Envelope, secrets);
      if (!res) {
        // Our per-device copy won't open (sealed to a key we no longer hold — a
        // consumed one-time prekey, or we weren't a recipient at send time). Try
        // to self-heal: ask the peer / our own other devices to re-encrypt it to
        // our current keys. Stay pending (null → retry) until the grace window
        // elapses, then lock. Skipped for receipts (no msgId).
        if (msgId && isDm(groupId)) {
          const since = rehealAtRef.current.get(`${groupId}|${msgId}`);
          if (since === undefined || Date.now() - since <= REHEAL_WAIT_MS) {
            requestReheal(groupId, msgId);
            return null;
          }
        }
        return locked;
      }
      // Forward secrecy: drop the one-time prekey this message consumed so its
      // key can't be re-derived from stored keys later, then top the pool back up.
      if (res.usedOpkId) {
        await consumeOneTimePreKey(userId, res.usedOpkId);
        scheduleReplenish();
      }
      return {
        text: res.text,
        rich: res.rich ?? undefined,
        preview: res.preview ?? undefined,
        replyTo: res.replyTo ?? undefined,
        forwarded: res.forwarded ?? undefined,
        call: res.call ?? undefined,
        enc: undefined,
        att: res.att ?? undefined,
      };
    },
    [
      requestSenderKey,
      requestReheal,
      userId,
      scheduleReplenish,
      mls,
      sentBodyFor,
      recvChainsRef,
      requestedKeysRef,
      requestedAtRef,
    ],
  );

  // Decrypt inbound E2EE messages on this device, patching the plaintext into
  // place. Runs whenever messages change and quickly no-ops once nothing is
  // pending — decryption clears `enc`, so each message is processed at most once
  // and the loop converges.
  useEffect(() => {
    if (!cryptoAvailable()) return;
    const pending: {
      groupId: string;
      id: string;
      enc: string;
      /** Set when the encrypted message is a thread reply under this parent. */
      parentId?: string;
    }[] = [];
    // `locked` rows carry a persisted verdict: their key material is gone, so a
    // re-attempt can only fail (and log) again. A path that CAN recover one — the
    // DM reheal offer — clears `locked` as it swaps in the fresh envelope.
    for (const [cid, ch] of Object.entries(groups)) {
      for (const m of ch.messages) {
        if (m.enc && !m.locked) pending.push({ groupId: cid, id: m.id, enc: m.enc });
        for (const r of m.threadReplies || []) {
          if (r.enc && !r.locked)
            pending.push({ groupId: cid, id: r.id, enc: r.enc, parentId: m.id });
        }
      }
    }
    if (!pending.length) return;
    let cancelled = false;
    void (async () => {
      const secrets = await getSecrets();
      for (const { groupId, id, enc, parentId } of pending) {
        if (cancelled) return;
        // Mirrors decryptInbound rather than restating its shape, so the
        // permanent-lock flag can't drift out of sync here.
        let result: DecryptResult;
        if (!secrets) {
          result = { text: "🔒 Encrypted message", enc: undefined, locked: true };
        } else {
          result = await decryptInbound(groupId, enc, secrets, id);
        }
        // null → not decryptable yet (group key not received); leave `enc` so a
        // later chainVersion bump retries. Skip the state write.
        if (result === null || cancelled) continue;
        // Separate the envelope-carried attachment key from the message patch:
        // it's merged onto the message's attachment so an encrypted image can be
        // fetched + decrypted on display.
        const { att, permanent, ...msgPatch } = result;
        const live = chat().groups;
        const existing = parentId
          ? live[groupId]?.messages
              .find((m) => m.id === parentId)
              ?.threadReplies?.find((r) => r.id === id)
          : live[groupId]?.messages.find((m) => m.id === id);
        const patch: Partial<Message> =
          att && existing?.attachment
            ? {
                ...msgPatch,
                attachment: { ...existing.attachment, key: att.key, iv: att.iv },
              }
            : msgPatch;
        // Persist the decrypted plaintext (+ attachment key) so revisiting this
        // group reloads cleartext from IndexedDB instead of re-decrypting the
        // ciphertext — a group message's sender-key ratchet only moves forward
        // (no skipped-key cache), so a second decrypt against the now-advanced
        // chain fails and would flip every prior message back to "🔒 Unable to
        // decrypt". Only successful decrypts are stored; a transient lock
        // (secrets not loaded yet) keeps `enc` so it retries.
        if (!patch.locked) {
          void msgdb.patchMessage(id, patch);
          scheduleBackup(); // decrypted plaintext cached → refresh the backup so
          // this message survives device loss even if its one-time prekey is spent
        } else if (permanent) {
          // Record the lock so this envelope is never fed back through decrypt:
          // the server replays it on every (re)join for as long as it sits before
          // our read cursor, and without this the failure (and its console noise)
          // repeats for the life of the message. `enc` is written back
          // deliberately — patchMessage would otherwise drop it with the rest of
          // the patch's undefined fields, and it's the only copy of the ciphertext
          // we hold if a re-encrypt path ever arrives.
          void msgdb.patchMessage(id, { text: patch.text, locked: true, enc });
        }
        chat().setGroups((s) => {
          const ch = s[groupId];
          if (!ch) return s;
          let found = false;
          const messages = ch.messages.map((m) => {
            if (!parentId) {
              if (m.id !== id || !m.enc) return m;
              found = true;
              return { ...m, ...patch };
            }
            if (m.id !== parentId) return m;
            const threadReplies = (m.threadReplies || []).map((r) => {
              if (r.id !== id || !r.enc) return r;
              found = true;
              return { ...r, ...patch };
            });
            return found ? { ...m, threadReplies } : m;
          });
          return found ? { ...s, [groupId]: { ...ch, messages } } : s;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    groups,
    chainVersion,
    rehealVersion,
    getSecrets,
    decryptInbound,
    scheduleBackup,
  ]);

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      decryptInbound,
      requestSenderKey,
    }),
    [decryptInbound, requestSenderKey],
  );
}
