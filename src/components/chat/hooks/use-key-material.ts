"use client";

/**
 * This device's key material and the pairwise (Phase 1) / sender-key (Phase 2)
 * primitives built on it: loading our own secrets, fetching and TOFU-pinning
 * peer prekey bundles, sealing a DM envelope, and distributing a group's sender
 * key.
 *
 * MLS (the live group scheme) builds on top of this — see use-mls.ts — and the
 * decrypt path consumes the received chains kept here.
 */
import { useCallback, useMemo, useRef } from "react";
import {
  cryptoAvailable,
  groupGet,
  groupPut,
  loadDeviceSecrets,
  pinGet,
  type DeviceSecrets,
} from "@/lib/crypto/identity";
import { acknowledgePin, checkAndPin, type Pin } from "@/lib/crypto/pinning";
import { encryptForDevices } from "@/lib/crypto/session";
import {
  generateSenderKey,
  serializeState,
  type SenderKeyDistribution,
  type SenderKeyState,
  type SenderKeyWire,
} from "@/lib/crypto/group";
import type { MessageContent, PreKeyBundle } from "@/lib/crypto/types";
import type { TypedSocket } from "@/stores/session-store";
import { chat } from "@/stores/chat-store";

export type KeyMaterial = ReturnType<typeof useKeyMaterial>;

export function useKeyMaterial({
  socket,
  userId,
  backupNow,
  replenishKeys,
}: {
  socket: TypedSocket | null;
  userId: string;
  backupNow: () => Promise<unknown>;
  replenishKeys: () => Promise<void>;
}) {
  /** This device's private keys, loaded once and cached. Provisioned on connect
   *  by SocketProvider; null until then or when WebCrypto is unavailable. */
  const secretsRef = useRef<DeviceSecrets | null>(null);

  /** Received per-sender sender-key chains for groups, keyed
   *  `groupId|senderDeviceId`. Backed by IndexedDB (crypto/identity groupGet). */
  const recvChainsRef = useRef<Map<string, SenderKeyState>>(new Map());

  /** (groupId|senderDeviceId) we've already asked the sender to (re)distribute
   *  its key for, so a flood of undecryptable messages triggers one request, not
   *  one per message. Cleared once that sender's key successfully decrypts. */
  const requestedKeysRef = useRef<Set<string>>(new Set());

  /** When we first requested each (group|sender) key, so a request that goes
   *  unanswered past KEY_WAIT_MS resolves to a 🔒 instead of a blank forever
   *  (e.g. our OWN messages after a data wipe — the old sender key is gone). */
  const requestedAtRef = useRef<Map<string, number>>(new Map());

  // Debounced re-backup after group key material changes (no-op unless a
  // session passphrase is held). Keeps the encrypted backup current so newly
  // joined groups' seeds stay recoverable.
  const backupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleBackup = useCallback(() => {
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    backupTimerRef.current = setTimeout(() => void backupNow(), 3000);
  }, [backupNow]);

  // Debounced one-time-prekey top-up after prekeys are consumed (for FS), so the
  // pool doesn't run dry past the initial batch. No-op unless below watermark.
  const replenishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReplenish = useCallback(() => {
    if (replenishTimerRef.current) clearTimeout(replenishTimerRef.current);
    replenishTimerRef.current = setTimeout(() => void replenishKeys(), 3000);
  }, [replenishKeys]);

  const getSecrets = useCallback(async (): Promise<DeviceSecrets | null> => {
    if (secretsRef.current) return secretsRef.current;
    if (!cryptoAvailable()) return null;
    secretsRef.current = await loadDeviceSecrets(userId);
    return secretsRef.current;
  }, [userId]);

  /** Fetch a user's published prekey bundles (one per device) from the server's
   *  key directory. Resolves to [] for users who have published no keys. */
  const fetchBundles = useCallback(
    (target: string): Promise<PreKeyBundle[]> =>
      new Promise((resolve) => {
        if (!socket) return resolve([]);
        socket
          .timeout(5000)
          .emit("keys:fetch", { userId: target }, (err, res) =>
            resolve(err || !res ? [] : res.bundles),
          );
      }),
    [socket],
  );

  /** TOFU: observe peer device identity keys and, on a mismatch with what we
   *  pinned, raise a key-change alert. Never blocks the operation — surfacing is
   *  safer than blocking given a legit re-provision also trips it. */
  const pinBundles = useCallback(
    async (
      bundles: { userId: string; deviceId: string; identityKey: string }[],
    ) => {
      for (const b of bundles) {
        if (b.userId === userId) continue; // don't pin our own devices
        const res = await checkAndPin(userId, {
          deviceId: b.deviceId,
          peerUserId: b.userId,
          identityKey: b.identityKey,
        });
        if (res === "mismatch") {
          const p = await pinGet<Pin>(userId, b.deviceId);
          if (p) chat().raiseKeyAlert(b.deviceId, p);
        }
      }
    },
    [userId],
  );

  /** Accept a flagged key change and re-pin to the new key. */
  const acknowledgeKeyAlert = useCallback(
    async (deviceId: string) => {
      await acknowledgePin(userId, deviceId);
      chat().dropKeyAlert(deviceId);
    },
    [userId],
  );

  /**
   * Build the E2EE envelope (JSON) for a DM message, or null when it can't be
   * sealed. Encrypts to every device of BOTH the peer and ourselves (so our own
   * devices can read it on reload). `peerId` is the recipient's key — supplied by
   * the caller because the DM group *id* is the creator's view (the recipient's
   * key) and is NOT viewer-symmetric, so the recipient must derive the peer from
   * the viewer-corrected partner, not from the id.
   */
  const buildEnvelope = useCallback(
    async (
      peerId: string,
      content: MessageContent,
      // Receipts pass this so the sealed cursor stays repeatably decryptable
      // from the signed prekey (no one-time prekey to be consumed on replay).
      opts?: { skipOneTimePreKey?: boolean },
    ): Promise<string | null> => {
      const secrets = await getSecrets();
      if (!secrets || !peerId) return null;
      const [peer, mine] = await Promise.all([
        fetchBundles(peerId),
        fetchBundles(userId),
      ]);
      if (!peer.length) return null; // peer has published no keys
      await pinBundles(peer); // TOFU: catch a swapped key before we seal to it
      const env = await encryptForDevices(content, [...peer, ...mine], secrets, opts);
      return env ? JSON.stringify(env) : null;
    },
    [getSecrets, fetchBundles, pinBundles, userId],
  );

  /** Fetch the prekey bundles of every device of every member of a group (for
   *  sender-key distribution). [] when no members have published keys. */
  const fetchGroupBundles = useCallback(
    (groupId: string): Promise<PreKeyBundle[]> =>
      new Promise((resolve) => {
        if (!socket) return resolve([]);
        socket.timeout(5000).emit("keys:fetchGroup", { groupId }, (err, res) => {
          const bundles = err || !res ? [] : res.bundles;
          void pinBundles(bundles); // TOFU on every member device we may seal to
          resolve(bundles);
        });
      }),
    [socket, pinBundles],
  );

  /** Distribute our stable sender-key SEED for a group to the given member
   *  devices, wrapped in the pairwise envelope (so only those devices can read
   *  it). Reused on first send, on membership change, and when a member
   *  explicitly requests the key (pull-on-miss). */
  const distributeSenderKey = useCallback(
    async (
      groupId: string,
      seed: SenderKeyWire,
      members: PreKeyBundle[],
      secrets: DeviceSecrets,
    ) => {
      const dist: SenderKeyDistribution = {
        skd: 1,
        groupId,
        sender: secrets.deviceId,
        ...seed,
      };
      const env = await encryptForDevices(
        { text: JSON.stringify(dist) },
        members,
        secrets,
      );
      if (env)
        socket?.emit("group:senderKey", {
          groupId,
          sender: secrets.deviceId,
          env: JSON.stringify(env),
        });
    },
    [socket],
  );

  /**
   * Ensure our sender key is distributed to the group's current member device
   * set. We keep ONE stable seed (index 0) per group and never rotate it (chosen
   * policy: reliable decryption for everyone over forward secrecy), and
   * re-distribute that same seed whenever the member-device set changes so a
   * newly-added device can read the whole stream. `send:` is the advancing send
   * pointer used to encrypt; `seed:` is the stable index-0 seed we hand out.
   */
  const ensureSenderKeyDistributed = useCallback(
    async (groupId: string, members: PreKeyBundle[], secrets: DeviceSecrets) => {
      const devices = members.map((m) => m.deviceId).sort();
      let seed = await groupGet<SenderKeyWire>(userId, `seed:${groupId}`);
      const lastDist = await groupGet<string[]>(userId, `dist:${groupId}`);
      const sameSet =
        !!lastDist &&
        lastDist.length === devices.length &&
        lastDist.every((d, i) => d === devices[i]);
      if (seed && sameSet) return;
      if (!seed) {
        const fresh = generateSenderKey();
        seed = serializeState(fresh);
        await groupPut(userId, `seed:${groupId}`, seed); // stable index-0 seed to hand out
        await groupPut(userId, `send:${groupId}`, seed); // advancing send pointer starts at the seed
        // Also store ourselves as a recv chain so we can self-decrypt our OWN
        // group messages from ciphertext (on cache loss / after a key restore) —
        // not just from the live sentPlaintext cache.
        await groupPut(userId, `recv:${groupId}:${secrets.deviceId}`, seed);
        scheduleBackup(); // new key material → refresh the encrypted backup
      }
      await distributeSenderKey(groupId, seed, members, secrets);
      await groupPut(userId, `dist:${groupId}`, devices);
    },
    [distributeSenderKey, scheduleBackup, userId],
  );

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      recvChainsRef,
      requestedKeysRef,
      requestedAtRef,
      getSecrets,
      fetchBundles,
      pinBundles,
      fetchGroupBundles,
      acknowledgeKeyAlert,
      buildEnvelope,
      distributeSenderKey,
      ensureSenderKeyDistributed,
      scheduleBackup,
      scheduleReplenish,
    }),
    [recvChainsRef, requestedKeysRef, requestedAtRef, getSecrets, fetchBundles, pinBundles, fetchGroupBundles, acknowledgeKeyAlert, buildEnvelope, distributeSenderKey, ensureSenderKeyDistributed, scheduleBackup, scheduleReplenish],
  );
}
