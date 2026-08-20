"use client";

/**
 * Bookkeeping for OUR OWN outgoing messages — the plaintext we sealed, the
 * ack/fail timers, and the in-flight edit cache.
 *
 * The sender cannot decrypt its own envelope (encrypting consumes that
 * generation of the ratchet and never retains it), so between send and ack the
 * copy kept here is the ONLY copy of our own message body. That's why there are
 * two: an in-memory map keyed by clientId for the ack path, and a durable
 * IndexedDB-backed record keyed by the ENVELOPE (which the server echoes back
 * verbatim) so a reload before the ack can't strand our own message as 🔒.
 */
import { useCallback, useMemo, useRef } from "react";
import { groupGet, groupPut } from "@/lib/crypto/identity";
import type { CallEvent, LinkPreview, Message, ReplyRef } from "@/lib/chat-data";
import { chat } from "@/stores/chat-store";
import { withTabLock } from "@/lib/tab-lock";
import { SENT_PENDING_MAX, SEND_TIMEOUT_MS, type SentEnvelope } from "../lib/types";

/** The body fields we cache for one of our own in-flight messages. */
type SentPlaintext = {
  text: string;
  rich?: string;
  att?: { key: string; iv: string };
  preview?: LinkPreview;
  replyTo?: ReplyRef;
  forwarded?: boolean;
  call?: CallEvent;
};

export type Outbox = ReturnType<typeof useOutbox>;

export function useOutbox(userId: string) {
  /** Plaintext of our own outgoing encrypted messages, keyed by clientId, so we
   *  render them without self-decrypting (and never see a ciphertext flash). */
  const sentPlaintextRef = useRef<Map<string, SentPlaintext>>(new Map());

  /**
   * Durable twin of sentPlaintextRef, keyed by the envelope itself so nothing
   * has to map a client id across a reload. `null` = not read from IndexedDB
   * yet. Entries are superseded by the acked message row and age out through the
   * cap rather than being deleted on ack — a stale entry can never yield the
   * wrong body (the envelope is the key), and keeping it is what saves a message
   * whose ack was lost.
   */
  const sentEnvelopesRef = useRef<SentEnvelope[] | null>(null);

  /** Our own in-flight edits, keyed by msgId: the echoed message:edited applies
   *  the cached plaintext instead of round-tripping our own ciphertext, and
   *  `prev` reverts an edit the server never acks. */
  const sentEditRef = useRef<
    Map<string, { patch: Partial<Message>; prev: Partial<Message> }>
  >(new Map());
  const editTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  /** Per-message fail timers: a send that isn't acked in time is marked failed. */
  const failTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const loadSentEnvelopes = useCallback(
    async (fresh = false): Promise<SentEnvelope[]> => {
      if (fresh || !sentEnvelopesRef.current) {
        sentEnvelopesRef.current =
          (await groupGet<SentEnvelope[]>(userId, "sentpending")) ?? [];
      }
      return sentEnvelopesRef.current;
    },
    [userId],
  );

  const rememberSent = useCallback(
    async (clientId: string, enc: string, body: SentEnvelope["body"]) => {
      // Read-modify-write under a cross-tab lock, re-reading inside it: the whole
      // list lives in ONE IndexedDB record, so a plain put from two tabs drops
      // every entry the loser hadn't seen — and each dropped entry is one of that
      // tab's own messages that the other tab can then only render as 🔒.
      await withTabLock(`sentpending:${userId}`, async () => {
        const list = await loadSentEnvelopes(true);
        const next = [...list.filter((e) => e.enc !== enc), { clientId, enc, body }];
        sentEnvelopesRef.current = next.slice(-SENT_PENDING_MAX);
        await groupPut(userId, "sentpending", sentEnvelopesRef.current);
      });
    },
    [loadSentEnvelopes, userId],
  );

  const sentBodyFor = useCallback(
    async (enc: string): Promise<SentEnvelope["body"] | undefined> => {
      const find = (list: SentEnvelope[]) => list.find((e) => e.enc === enc)?.body;
      const hit = find(await loadSentEnvelopes());
      if (hit) return hit;
      // A miss may only mean our listing is stale: a message sent from ANOTHER
      // TAB of this device lands here through IndexedDB, and this record is the
      // only place its plaintext exists — no scheme can open an envelope our own
      // leaf sealed once its ratchet moved on. So re-read before concluding the
      // envelope is someone else's and handing it to the decrypt path.
      return find(await loadSentEnvelopes(true));
    },
    [loadSentEnvelopes],
  );

  /** Cache what we're about to seal, for the ack path. */
  const rememberPlaintext = useCallback(
    (clientId: string, body: SentPlaintext) => {
      sentPlaintextRef.current.set(clientId, body);
    },
    [],
  );

  /** Take (and forget) the cached body for an acked message. */
  const takePlaintext = useCallback((clientId: string) => {
    const cached = sentPlaintextRef.current.get(clientId);
    sentPlaintextRef.current.delete(clientId);
    return cached;
  }, []);

  /** Mark an optimistic message failed if it isn't acked within the timeout.
   *  A late ack (e.g. a resend on reconnect) still reconciles it. */
  const armFailTimer = useCallback((clientId: string) => {
    const existing = failTimers.current.get(clientId);
    if (existing) clearTimeout(existing);
    failTimers.current.set(
      clientId,
      setTimeout(() => {
        failTimers.current.delete(clientId);
        chat().markFailed(clientId);
      }, SEND_TIMEOUT_MS),
    );
  }, []);

  const clearFailTimer = useCallback((clientId: string) => {
    const t = failTimers.current.get(clientId);
    if (t) {
      clearTimeout(t);
      failTimers.current.delete(clientId);
    }
  }, []);

  /** Fail an optimistic message immediately with a reason (e.g. it could not be
   *  end-to-end encrypted). Default-E2EE: we never fall back to plaintext. */
  const markFailed = useCallback(
    (clientId: string, reason: string) => {
      clearFailTimer(clientId);
      chat().markFailed(clientId, reason);
    },
    [clearFailTimer],
  );

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      sentEditRef,
      editTimersRef,
      loadSentEnvelopes,
      rememberSent,
      sentBodyFor,
      rememberPlaintext,
      takePlaintext,
      armFailTimer,
      clearFailTimer,
      markFailed,
    }),
    [sentEditRef, editTimersRef, loadSentEnvelopes, rememberSent, sentBodyFor, rememberPlaintext, takePlaintext, armFailTimer, clearFailTimer, markFailed],
  );
}
