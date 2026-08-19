"use client";

/**
 * E2EE read receipts. A read cursor is a sealed message like any other, so it
 * rides the same DM/group/MLS path — the server relays an opaque envelope and
 * never learns who read what.
 *
 * The awkward part is replay. The server keeps only the LATEST cursor per
 * (group, user, device) and re-emits it on every (re)join, but a sealed cursor
 * decrypts exactly ONCE: MLS drops a generation's key as it consumes it and the
 * sender-keys chain has no skipped-key cache, so a second decrypt of a replayed
 * envelope throws "gen in the past" and the cursor would be lost — leaving "seen
 * by" blank after every reconnect. So each consumed envelope is remembered with
 * the cursor it opened to, and a replay is answered from that record.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { groupGet, groupPut } from "@/lib/crypto/identity";
import type { ReceiptRelayPayload } from "@/lib/socket-events";
import { chat, useChatStore } from "@/stores/chat-store";
import type { TypedSocket } from "@/stores/session-store";
import type { ConsumedReceipt } from "../lib/types";
import type { KeyMaterial } from "./use-key-material";
import type { Decrypt } from "./use-decrypt";
import type { Seal } from "./use-seal";

export type Receipts = ReturnType<typeof useReceipts>;

export function useReceipts({
  socket,
  userId,
  keys,
  decrypt,
  seal,
}: {
  socket: TypedSocket | null;
  userId: string;
  keys: KeyMaterial;
  decrypt: Decrypt;
  seal: Seal;
}) {
  const { getSecrets } = keys;
  const { decryptInbound } = decrypt;
  const { sealFor } = seal;

  /** The sealed cursor most recently consumed per `groupId:deviceId`, with its
   *  plaintext. Persisted (one bounded slot per peer device, replaced as their
   *  cursor advances) because a reload is exactly the case where the stored
   *  ratchet has already moved past everything about to be replayed. */
  const seenRef = useRef<Map<string, ConsumedReceipt>>(new Map());
  /** In-flight receipt decrypts, by `groupId:deviceId|env`, so two deliveries of
   *  one envelope share a single attempt instead of racing the ratchet. */
  const inFlightRef = useRef<Map<string, Promise<boolean>>>(new Map());
  /** Highest readSeq we've already sealed per group (skip redundant reseals). */
  const lastSealedSeqRef = useRef<Map<string, number>>(new Map());
  /** Debounce timers for sealing our own read cursor (one per group). */
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** Receipts whose sender key hasn't arrived yet — retried on chainVersion
   *  bumps (a reconnect can replay a receipt before its key distribution). */
  const pendingRef = useRef<ReceiptRelayPayload[]>([]);

  const chainVersion = useChatStore((s) => s.chainVersion);

  // Read/record the last sealed cursor consumed from a peer device, through the
  // in-memory map first so a burst of replays doesn't hit IndexedDB per event.
  const loadSeen = useCallback(
    async (key: string): Promise<ConsumedReceipt | undefined> => {
      const mem = seenRef.current.get(key);
      if (mem) return mem;
      const stored = await groupGet<ConsumedReceipt>(userId, `rcpt:${key}`);
      if (stored) seenRef.current.set(key, stored);
      return stored;
    },
    [userId],
  );

  const saveSeen = useCallback(
    async (key: string, rec: ConsumedReceipt): Promise<void> => {
      seenRef.current.set(key, rec);
      await groupPut(userId, `rcpt:${key}`, rec);
    },
    [userId],
  );

  /** Decrypt + apply one sealed receipt. Returns false when its sender key hasn't
   *  arrived yet (caller parks it for a chainVersion retry); true once handled or
   *  definitively undecryptable (dropped). */
  const handleReceipt = useCallback(
    async (p: ReceiptRelayPayload): Promise<boolean> => {
      const secrets = await getSecrets();
      if (!secrets) return false;
      // Replay guard — see seenRef. Running an envelope we already consumed back
      // through decrypt can only fail, so re-merge the cursor it opened to the
      // first time. Receipts get no help from the MLS plaintext cache: that one
      // is keyed by msgId, which this path deliberately omits.
      const seenKey = `${p.groupId}:${p.deviceId}`;
      const seen = await loadSeen(seenKey);
      if (seen?.env === p.env) {
        if (seen.readSeq !== undefined) {
          chat().mergeReceipt(p.groupId, p.fromUserId, seen.readSeq, seen.ts ?? 0);
        }
        return true;
      }
      const patch = await decryptInbound(p.groupId, p.env, secrets);
      if (patch === null) return false; // no key yet → park + retry
      // Past here the envelope has been consumed whether or not it opened, so
      // record it either way — a locked one must not be retried on every
      // reconnect (it can't start working; the ratchet has moved on).
      if (patch.locked) {
        await saveSeen(seenKey, { env: p.env });
        return true; // undecryptable → drop
      }
      let cursor: ConsumedReceipt = { env: p.env };
      try {
        const c = JSON.parse(patch.text ?? "") as {
          rcpt?: number;
          groupId?: string;
          readSeq?: number;
          ts?: number;
        };
        if (c.rcpt === 1 && c.groupId === p.groupId && typeof c.readSeq === "number") {
          cursor = { env: p.env, readSeq: c.readSeq, ts: c.ts ?? 0 };
        }
      } catch {
        // Not a receipt payload (shouldn't happen on this event) — ignore.
      }
      await saveSeen(seenKey, cursor);
      if (cursor.readSeq !== undefined) {
        chat().mergeReceipt(p.groupId, p.fromUserId, cursor.readSeq, cursor.ts ?? 0);
      }
      return true;
    },
    [getSecrets, decryptInbound, loadSeen, saveSeen],
  );

  /** Coalesce concurrent attempts at the SAME envelope — a reconnect's replay can
   *  race the parked retry of the copy that arrived before its key. Both would
   *  clear the seen check, one would consume the ratchet, and the loser would take
   *  the "gen in the past" failure and record the envelope as undecryptable. */
  const processReceipt = useCallback(
    async (p: ReceiptRelayPayload): Promise<boolean> => {
      const key = `${p.groupId}:${p.deviceId}|${p.env}`;
      const running = inFlightRef.current.get(key);
      if (running) return running;
      const run = handleReceipt(p).finally(() => {
        inFlightRef.current.delete(key);
      });
      inFlightRef.current.set(key, run);
      return run;
    },
    [handleReceipt],
  );

  /** Seal THIS device's read cursor for a group and relay it. Skips when the
   *  cursor hasn't advanced past what we last sealed, and when the group isn't
   *  E2EE (sealFor returns null → no plaintext ever goes out). */
  const sealReceipt = useCallback(
    async (groupId: string) => {
      if (!socket) return;
      const ch = chat().groups[groupId];
      if (!ch) return;
      let readSeq = 0;
      for (const m of ch.messages) {
        if (typeof m.seq === "number" && m.seq > readSeq) readSeq = m.seq;
      }
      if (readSeq <= 0) return;
      if ((lastSealedSeqRef.current.get(groupId) ?? 0) >= readSeq) return;
      const secrets = await getSecrets();
      if (!secrets) return;
      const payload = {
        text: JSON.stringify({ rcpt: 1, groupId, readSeq, ts: Date.now() }),
      };
      const enc = await sealFor(groupId, payload, { skipOneTimePreKey: true });
      if (!enc) return;
      lastSealedSeqRef.current.set(groupId, readSeq);
      socket.emit("receipt:update", { groupId, deviceId: secrets.deviceId, env: enc });
    },
    [socket, getSecrets, sealFor],
  );

  /** Debounce receipt sealing (2s) — piggybacks the group:read emit sites, so
   *  rapidly reading many messages seals once, not once per message. */
  const scheduleReceipt = useCallback(
    (groupId: string) => {
      const t = timersRef.current.get(groupId);
      if (t) clearTimeout(t);
      timersRef.current.set(
        groupId,
        setTimeout(() => {
          timersRef.current.delete(groupId);
          void sealReceipt(groupId);
        }, 2000),
      );
    },
    [sealReceipt],
  );

  // A peer's sealed read cursor: decrypt + merge (retry via chainVersion if its
  // sender key hasn't landed). Our own device's receipts are ignored.
  useEffect(() => {
    if (!socket) return;
    const onReceipt = (p: ReceiptRelayPayload) => {
      if (p.fromUserId === userId) return;
      void processReceipt(p).then((handled) => {
        if (!handled) {
          pendingRef.current = pendingRef.current.filter(
            (q) => !(q.groupId === p.groupId && q.deviceId === p.deviceId),
          );
          pendingRef.current.push(p);
        }
      });
    };
    socket.on("receipt:update", onReceipt);
    return () => {
      socket.off("receipt:update", onReceipt);
    };
  }, [socket, userId, processReceipt]);

  // Retry parked receipts when a sender key arrives (chainVersion bump).
  useEffect(() => {
    if (!pendingRef.current.length) return;
    const items = pendingRef.current;
    pendingRef.current = [];
    void (async () => {
      for (const p of items) {
        if (!(await processReceipt(p))) pendingRef.current.push(p);
      }
    })();
  }, [chainVersion, processReceipt]);

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      scheduleReceipt,
    }),
    [scheduleReceipt],
  );
}
