"use client";

/**
 * Device-to-device recovery: a fresh device asks the user's other online devices
 * for their group keys, and a human on one of those devices approves.
 *
 * Both sides live here. The requester arms itself, waits, and imports whatever
 * arrives; the responder verifies that the directory bundle for the requesting
 * device id really matches the fingerprint in the request (which defends against a
 * lying server) before prompting anyone.
 *
 * What crosses the wire is the sender-keys material and the storage key — never an
 * identity keypair, and never MLS state: every device is its own MLS leaf, and two
 * devices sharing one leaf's state fork the ratchet irrecoverably.
 */
import { useCallback, useMemo, useRef } from "react";
import {
  deriveFingerprintFromSpki,
  ensureDeviceIdentity,
  exportKeys,
  importGroups,
  loadDeviceSecrets,
  storageKeyGet,
  storageKeyPut,
} from "@/lib/crypto/identity";
import { decryptEnvelope, encryptForDevices, type Envelope } from "@/lib/crypto/session";
import type { PreKeyBundle } from "@/lib/crypto/types";
import type { RecoveryOfferRelay, RecoveryRequestPayload } from "@/lib/socket-events";
import { session, type TypedSocket } from "@/stores/session-store";
import type { HistorySync } from "./use-history-sync";

/** How long a fresh device waits for one of the user's other devices to answer a
 *  recovery request before falling back to the PIN restore path. */
const RECOVERY_WAIT_MS = 8000;

export type DeviceRecovery = ReturnType<typeof useDeviceRecovery>;

export function useDeviceRecovery({
  userId,
  socketRef,
  history,
}: {
  userId: string;
  socketRef: React.RefObject<TypedSocket | null>;
  history: HistorySync;
}) {
  /** Requester side: resolves the tryRecovery() wait when an offer arrives or the
   *  timeout fires. */
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);
  /** Stays armed from the moment we send a request until we actually import an
   *  offer — OUTLIVES the initial wait, because approval needs a human on the other
   *  device and that easily takes longer than the timeout. A late approval then
   *  still imports and reloads. */
  const expectingOfferRef = useRef(false);
  /** Responder side: the requesting device's verified bundle, held between showing
   *  the approval prompt and the human approving it. */
  const pendingBundleRef = useRef<PreKeyBundle | null>(null);

  const fetchOwnBundles = useCallback(
    (s: TypedSocket): Promise<PreKeyBundle[]> =>
      new Promise((resolve) => {
        s.timeout(5000).emit("keys:fetch", { userId }, (err, res) =>
          resolve(err || !res ? [] : res.bundles),
        );
      }),
    [userId],
  );

  /** Requester side: ask our other online devices to hand over group keys, and
   *  wait briefly. Resolves true if an offer arrived and imported, else false. */
  const tryRecovery = useCallback(
    (s: TypedSocket): Promise<boolean> =>
      new Promise((resolve) => {
        void (async () => {
          const id = await ensureDeviceIdentity(userId);
          session().setRecovering(true);
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveRef.current = null;
            session().setRecovering(false);
            resolve(ok);
          };
          const timer = setTimeout(() => finish(false), RECOVERY_WAIT_MS);
          resolveRef.current = finish;
          expectingOfferRef.current = true; // stays armed past the timeout
          s.emit("recovery:request", {
            deviceId: id.deviceId,
            fingerprint: id.fingerprint,
          });
        })();
      }),
    [userId],
  );

  /** Requester side: an offer arrived. Decrypt it with our own keys (it's sealed to
   *  us), import the group seeds + storage key, pull the full encrypted history
   *  store down, and resolve the recovery wait → reload. */
  const onOffer = useCallback(
    async ({ env }: RecoveryOfferRelay) => {
      if (!expectingOfferRef.current) return; // we didn't ask to recover
      const secrets = await loadDeviceSecrets(userId);
      if (!secrets) return;
      try {
        const res = await decryptEnvelope(JSON.parse(env) as Envelope, secrets);
        if (!res) return; // not sealed to this device
        const data = JSON.parse(res.text) as {
          groups?: Record<string, unknown>;
          sk?: string;
        };
        if (data.groups) await importGroups(userId, data.groups);
        // Adopt the offered storage key (never clobber one we already hold), then
        // download the whole history store with it — so device approval alone
        // brings back full history, forward-secret DMs included.
        if (data.sk && !(await storageKeyGet(userId))) {
          await storageKeyPut(userId, data.sk);
        }
        const s = socketRef.current;
        if (s && (await storageKeyGet(userId))) await history.syncDown(s);
        expectingOfferRef.current = false;
        if (resolveRef.current) {
          resolveRef.current(true); // within the initial wait → bootstrap reloads
        } else {
          window.location.reload(); // late approval (human took a while) → reload now
        }
      } catch {
        // malformed / foreign offer — ignore, keep waiting
      }
    },
    [userId, history, socketRef],
  );

  /** Responder side: a new device of ours is asking to recover. */
  const onRequest = useCallback(
    async ({ deviceId: reqDeviceId, fingerprint }: RecoveryRequestPayload) => {
      const s = socketRef.current;
      if (!s) return;
      const mine = await ensureDeviceIdentity(userId);
      if (reqDeviceId === mine.deviceId) return; // never answer our own request
      // Nothing to hand over (no group history on this device) → stay silent so a
      // keyless device doesn't pop a pointless approval prompt.
      const exp = await exportKeys(userId);
      if (!exp || Object.keys(exp.groups).length === 0) return;
      const bundle = (await fetchOwnBundles(s)).find(
        (b) => b.deviceId === reqDeviceId,
      );
      if (!bundle) return;
      if ((await deriveFingerprintFromSpki(bundle.identityKey)) !== fingerprint) {
        return; // server handed us a bundle that isn't the requester's — ignore
      }
      pendingBundleRef.current = bundle;
      session().setPendingApproval({ deviceId: reqDeviceId, fingerprint });
    },
    [userId, fetchOwnBundles, socketRef],
  );

  /** Responder side: human approved — seal the group seeds AND the storage key
   *  (never our identity) to the requesting device and send them over. The new
   *  device keeps its own identity, so the two never share an identity keypair; the
   *  storage key lets it pull the full encrypted history store, so approval alone
   *  restores everything (Messenger parity — no PIN needed). */
  const approveDevice = useCallback(() => {
    const s = socketRef.current;
    const bundle = pendingBundleRef.current;
    if (!s || !bundle) return;
    void (async () => {
      const secrets = await loadDeviceSecrets(userId);
      const exp = await exportKeys(userId);
      pendingBundleRef.current = null;
      session().setPendingApproval(null);
      if (!secrets || !exp) return;
      // Never hand MLS material (mlskp keypair / mls:* group states / mlsseq:*
      // cursors) to ANOTHER device: every device is its own MLS leaf, and two
      // devices sharing one leaf's state fork the ratchet irrecoverably. The new
      // device publishes its own KeyPackage and is added to each group by the next
      // sender's membership sync instead. (Sender-keys seeds — seed:/send:/recv: —
      // still transfer: they're per-sender symmetric chains, safe to copy.)
      const groups = Object.fromEntries(
        Object.entries(exp.groups).filter(([k]) => !k.startsWith("mls")),
      );
      const env = await encryptForDevices(
        { text: JSON.stringify({ groups, sk: exp.sk }) },
        [bundle],
        secrets,
      );
      if (env)
        s.emit("recovery:offer", {
          toDeviceId: bundle.deviceId,
          env: JSON.stringify(env),
        });
    })();
  }, [userId, socketRef]);

  const denyDevice = useCallback(() => {
    pendingBundleRef.current = null;
    session().setPendingApproval(null);
  }, []);

  return useMemo(
    () => ({ tryRecovery, onOffer, onRequest, approveDevice, denyDevice }),
    [tryRecovery, onOffer, onRequest, approveDevice, denyDevice],
  );
}
