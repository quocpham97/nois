"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";
import { type User, deriveUser } from "@/lib/chat-data";
import {
  cryptoAvailable,
  deriveFingerprintFromSpki,
  ensureDeviceIdentity,
  exportKeys,
  hasDeviceIdentity,
  importGroups,
  loadDeviceSecrets,
  replenishOneTimePreKeys,
  storageKeyGet,
  storageKeyPut,
} from "@/lib/crypto/identity";
import { decryptEnvelope, encryptForDevices } from "@/lib/crypto/session";
import type { Envelope } from "@/lib/crypto/session";
import type { PreKeyBundle } from "@/lib/crypto/types";
import {
  type BackupBlob,
  buildBackup,
  computeKcv,
  decryptBackup,
  decryptHistoryRows,
  encryptHistoryRow,
  restoreBackup,
} from "@/lib/crypto/backup";
import {
  exportBackupMessages,
  importMessages,
  setHistorySink,
  type BackupMessageRow,
} from "@/lib/message-db";
import type {
  BackupDeleteResult,
  BackupGetResult,
  BackupPutResult,
  BackupUnlockResult,
  ClientToServerEvents,
  HistoryFetchResult,
  HistoryRowWire,
  RecoveryOfferRelay,
  RecoveryRequestPayload,
  ServerToClientEvents,
} from "@/lib/socket-events";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// How long a fresh device waits for one of the user's other devices to answer a
// recovery request before falling back to the PIN restore path.
const RECOVERY_WAIT_MS = 8000;

type SocketContextValue = {
  socket: TypedSocket | null;
  status: ConnectionStatus;
  /** Round-trip time of the last echo health check, in ms. */
  latencyMs: number | null;
  /** Mock viewer identity (the user this client is acting as). */
  userId: string;
  user: User;
  /** This browser's E2EE device id, once its identity is provisioned. */
  deviceId: string | null;
  /** Safety number for out-of-band identity verification (null until ready). */
  fingerprint: string | null;

  // --- encrypted key backup ---
  /** True when this device has no local keys but a server backup exists → prompt to restore. */
  needsRestore: boolean;
  /** Last-updated time of the server backup (null = none), for the Settings UI. */
  backupUpdatedAt: string | null;
  /** True once a passphrase is held this session (enables auto re-backup). */
  backupEnabled: boolean;
  /** Encrypt the current keys under `passphrase` and upload (first-time setup; also enables auto-backup). Throws if the server rejects it. */
  createBackup: (passphrase: string) => Promise<void>;
  /** Re-hold the EXISTING backup PIN on this device (validates it against the
   *  stored blob, then resumes auto/manual backup) without re-importing history.
   *  Throws "Incorrect PIN" on a mismatch. */
  unlockBackup: (passphrase: string) => Promise<void>;
  /** Change the backup PIN: validates `currentPassphrase` against the stored
   *  blob, then re-encrypts under `newPassphrase`. Throws on a wrong current PIN. */
  changeBackupPin: (currentPassphrase: string, newPassphrase: string) => Promise<void>;
  /** Re-upload a fresh backup using the session passphrase. Returns the server-confirmed result. */
  backupNow: () => Promise<BackupPutResult>;
  /** Delete the server-side backup blob (local keys are untouched). */
  deleteBackup: () => Promise<BackupDeleteResult>;
  /** Restore keys from the server backup with `passphrase`, then provision. Throws if wrong. */
  runRestore: (passphrase: string) => Promise<void>;
  /** Refill + republish one-time prekeys if the pool has drained (sustains FS). */
  replenishKeys: () => Promise<void>;
  /** Dismiss the restore prompt and provision a fresh identity instead. */
  skipRestore: () => void;

  // --- device-to-device recovery ---
  /** True while a fresh device is waiting for one of the user's other devices to answer. */
  recovering: boolean;
  /** Set on an EXISTING device when a new device asks to recover — prompt the human. */
  pendingApproval: { deviceId: string; fingerprint: string } | null;
  /** Approve the pending device: seal our group keys to it and send them over. */
  approveDevice: () => void;
  /** Deny the pending device recovery request. */
  denyDevice: () => void;
};

const SocketContext = createContext<SocketContextValue | null>(null);

export function useSocket(): SocketContextValue {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error("useSocket must be used within SocketProvider");
  return ctx;
}

export function SocketProvider({
  meId,
  meName,
  children,
}: {
  meId: string;
  meName?: string;
  children: React.ReactNode;
}) {
  const [socket, setSocket] = useState<TypedSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [needsRestore, setNeedsRestore] = useState(false);
  const [backupUpdatedAt, setBackupUpdatedAt] = useState<string | null>(null);
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    deviceId: string;
    fingerprint: string;
  } | null>(null);
  // Identity comes from the authenticated session (passed from the server).
  // The handshake itself is authorized via the session cookie, not this value.
  const userId = meId;
  const user = deriveUser(meId, meName);

  const socketRef = useRef<TypedSocket | null>(null);
  const provisionedRef = useRef(false);
  // Session-held passphrase, so auto-backup can re-encrypt after key changes
  // without re-prompting. Never persisted.
  const passphraseRef = useRef<string | null>(null);
  // Recovery (requester side): resolves the tryDeviceRecovery() wait when an
  // offer arrives or the timeout fires.
  const recoveryResolveRef = useRef<((ok: boolean) => void) | null>(null);
  // Stays armed from the moment we send a recovery request until we actually
  // import an offer — OUTLIVES the initial wait, because approval needs a human
  // on the other device and that easily takes longer than the timeout. A late
  // approval then still imports and reloads.
  const expectingOfferRef = useRef(false);
  // Recovery (responder side): the requesting device's verified bundle, held
  // between showing the approval prompt and the human approving it.
  const pendingBundleRef = useRef<PreKeyBundle | null>(null);

  const getBackup = useCallback(
    (s: TypedSocket): Promise<BackupGetResult> =>
      new Promise((resolve) => {
        const done = (res?: BackupGetResult) =>
          resolve(res ?? { updatedAt: null, salt: null, iters: null });
        const t = setTimeout(() => done(), 5000);
        s.emit("backup:get", (res) => {
          clearTimeout(t);
          done(res);
        });
      }),
    [],
  );

  // Obtain the backup ciphertext through the rate-limited unlock vault: derive
  // the PIN proof from the KDF params backup:get exposes, present it to
  // backup:unlock, and get the blob back only on a match. Wrong PINs and
  // lockouts surface as the server's error message (with attempts remaining).
  // Legacy pre-vault rows come back directly from backup:get.
  const unlockBlob = useCallback(
    async (s: TypedSocket, passphrase: string): Promise<BackupBlob> => {
      const meta = await getBackup(s);
      if (!meta.updatedAt) throw new Error("No backup found");
      if (meta.legacyBlob) return meta.legacyBlob as BackupBlob;
      if (!meta.salt || !meta.iters) throw new Error("Backup metadata unavailable");
      const kcv = await computeKcv(passphrase, meta.salt, meta.iters);
      const res = await new Promise<BackupUnlockResult>((resolve) => {
        const t = setTimeout(
          () => resolve({ ok: false, error: "Timed out" }),
          8000,
        );
        s.emit("backup:unlock", { kcv }, (r) => {
          clearTimeout(t);
          resolve(r ?? { ok: false, error: "Timed out" });
        });
      });
      if (!res.ok) throw new Error(res.error);
      return res.blob as BackupBlob;
    },
    [getBackup],
  );

  // Provision (or load) this device's identity and publish its public bundle.
  // `keys:publish` seeds the server's one-time-prekey pool only on a device's
  // FIRST publish (it no longer replaces the pool on reconnect — that used to
  // re-add already-consumed prekeys and cause permanent "Unable to decrypt"; see
  // key-store.ts `publish`). So refills generated here for a returning device are
  // sent as an APPEND via `keys:supplement`, the same group post-consume
  // replenishment uses — the only way to top the server pool up now.
  const provisionAndPublish = useCallback(
    async (s: TypedSocket) => {
      const fresh = await replenishOneTimePreKeys(userId);
      const identity = await ensureDeviceIdentity(userId);
      provisionedRef.current = true;
      setDeviceId(identity.deviceId);
      setFingerprint(identity.fingerprint);
      s.emit("keys:publish", { bundle: identity.bundle });
      // First publish carries the full pool in the bundle; on reconnect the
      // bundle's prekeys are ignored server-side, so append any refill here.
      if (fresh.length) {
        s.emit("keys:supplement", { deviceId: identity.deviceId, oneTimePreKeys: fresh });
      }
    },
    [userId],
  );

  // --- continuous encrypted history (crypto/backup.ts) ----------------------
  // Mirror every locally-persisted plaintext row to the server-side history
  // store, encrypted under the user's storage key. Registered as message-db's
  // sink so all persist paths (send ack, receive, replay backfill, edits,
  // tombstones) flow through without chat-context changes. No-op until a
  // storage key exists on this device (i.e. backup set up or restored).
  useEffect(() => {
    setHistorySink((rows: BackupMessageRow[]) => {
      void (async () => {
        const wire: HistoryRowWire[] = [];
        for (const r of rows) {
          const w = await encryptHistoryRow(userId, r);
          if (w) wire.push(w);
        }
        if (wire.length) socketRef.current?.emit("history:append", { rows: wire });
      })();
    });
    return () => setHistorySink(null);
  }, [userId]);

  // One-time UPLOAD of this device's existing local history into the store —
  // runs when a storage key first becomes available (backup created/unlocked)
  // or once per device for pre-existing installs, so the store isn't empty for
  // history that predates continuous appends. Marker-guarded per user+device.
  const histSyncingRef = useRef(false);
  const histMarker = useCallback(
    () => `chat:histsync:${userId}`,
    [userId],
  );
  const syncHistoryUp = useCallback(async () => {
    const s = socketRef.current;
    if (!s || histSyncingRef.current) return;
    try {
      if (localStorage.getItem(histMarker())) return;
    } catch {
      return; // no localStorage → skip (SSR/ancient browser)
    }
    if (!(await storageKeyGet(userId))) return;
    histSyncingRef.current = true;
    try {
      const rows = await exportBackupMessages();
      for (let i = 0; i < rows.length; i += 100) {
        const wire: HistoryRowWire[] = [];
        for (const r of rows.slice(i, i + 100)) {
          const w = await encryptHistoryRow(userId, r);
          if (w) wire.push(w);
        }
        if (wire.length) s.emit("history:append", { rows: wire });
      }
      try {
        localStorage.setItem(histMarker(), new Date().toISOString());
      } catch {
        /* best-effort marker */
      }
    } finally {
      histSyncingRef.current = false;
    }
  }, [userId, histMarker]);

  // DOWNLOAD the full history store into local SQLite (new-device restore):
  // page → decrypt with the (just-imported) storage key → upsert. Sets the
  // sync-up marker so the restored device doesn't re-upload what it just got.
  const syncHistoryDown = useCallback(
    async (s: TypedSocket) => {
      let cursor: string | null = null;
      do {
        const res: HistoryFetchResult = await new Promise((resolve) => {
          const t = setTimeout(() => resolve({ rows: [], nextCursor: null }), 15000);
          s.emit("history:fetchMine", { afterMsgId: cursor }, (r) => {
            clearTimeout(t);
            resolve(r ?? { rows: [], nextCursor: null });
          });
        });
        const rows = await decryptHistoryRows(userId, res.rows);
        if (rows.length) await importMessages(rows);
        cursor = res.nextCursor;
      } while (cursor);
      try {
        localStorage.setItem(histMarker(), new Date().toISOString());
      } catch {
        /* best-effort marker */
      }
    },
    [userId, histMarker],
  );

  // Mid-session top-up: when the pool has drained (prekeys consumed for forward
  // secrecy), generate fresh ones and APPEND their publics to the server pool.
  const replenishKeys = useCallback(async () => {
    const s = socketRef.current;
    if (!s || !cryptoAvailable() || !deviceId) return;
    const fresh = await replenishOneTimePreKeys(userId);
    if (fresh.length) s.emit("keys:supplement", { deviceId, oneTimePreKeys: fresh });
  }, [userId, deviceId]);

  // --- device-to-device recovery --------------------------------------------

  const fetchOwnBundles = useCallback(
    (s: TypedSocket): Promise<PreKeyBundle[]> =>
      new Promise((resolve) => {
        s.timeout(5000).emit("keys:fetch", { userId }, (err, res) =>
          resolve(err || !res ? [] : res.bundles),
        );
      }),
    [userId],
  );

  // Requester side: ask our other online devices to hand over group keys, and
  // wait briefly. Resolves true if an offer arrived and imported, else false.
  const tryDeviceRecovery = useCallback(
    (s: TypedSocket): Promise<boolean> =>
      new Promise((resolve) => {
        void (async () => {
          const id = await ensureDeviceIdentity(userId);
          setRecovering(true);
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            recoveryResolveRef.current = null;
            setRecovering(false);
            resolve(ok);
          };
          const timer = setTimeout(() => finish(false), RECOVERY_WAIT_MS);
          recoveryResolveRef.current = finish;
          expectingOfferRef.current = true; // stays armed past the timeout
          s.emit("recovery:request", {
            deviceId: id.deviceId,
            fingerprint: id.fingerprint,
          });
        })();
      }),
    [userId],
  );

  // Requester side: an offer arrived. Decrypt it with our own keys (it's sealed
  // to us), import the group seeds + storage key, pull the full encrypted
  // history store down, and resolve the recovery wait → reload.
  const onRecoveryOffer = useCallback(
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
        // Adopt the offered storage key (never clobber one we already hold),
        // then download the whole history store with it — so device approval
        // alone brings back full history, forward-secret DMs included.
        if (data.sk && !(await storageKeyGet(userId))) {
          await storageKeyPut(userId, data.sk);
        }
        const s = socketRef.current;
        if (s && (await storageKeyGet(userId))) await syncHistoryDown(s);
        expectingOfferRef.current = false;
        if (recoveryResolveRef.current) {
          recoveryResolveRef.current(true); // within the initial wait → bootstrap reloads
        } else {
          window.location.reload(); // late approval (human took a while) → reload now
        }
      } catch {
        // malformed / foreign offer — ignore, keep waiting
      }
    },
    [userId, syncHistoryDown],
  );

  // Responder side: a new device of ours is asking to recover. Verify the
  // directory bundle for that device id really matches the fingerprint in the
  // request (defends against a lying server), then prompt the human to approve.
  const onRecoveryRequest = useCallback(
    async ({ deviceId: reqDeviceId, fingerprint }: RecoveryRequestPayload) => {
      const s = socketRef.current;
      if (!s) return;
      const mine = await ensureDeviceIdentity(userId);
      if (reqDeviceId === mine.deviceId) return; // never answer our own request
      // Nothing to hand over (no group history on this device) → stay silent so
      // a keyless device doesn't pop a pointless approval prompt.
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
      setPendingApproval({ deviceId: reqDeviceId, fingerprint });
    },
    [userId, fetchOwnBundles],
  );

  // Responder side: human approved — seal the group seeds AND the storage key
  // (never our identity) to the requesting device and send them over. The new
  // device keeps its own identity, so the two devices never share an identity
  // keypair; the storage key lets it pull the full encrypted history store, so
  // approval alone restores everything (Messenger parity — no PIN needed).
  const approveDevice = useCallback(() => {
    const s = socketRef.current;
    const bundle = pendingBundleRef.current;
    if (!s || !bundle) return;
    void (async () => {
      const secrets = await loadDeviceSecrets(userId);
      const exp = await exportKeys(userId);
      pendingBundleRef.current = null;
      setPendingApproval(null);
      if (!secrets || !exp) return;
      // Never hand MLS material (mlskp keypair / mls:* group states /
      // mlsseq:* cursors) to ANOTHER device: every device is its own MLS
      // leaf, and two devices sharing one leaf's state fork the ratchet
      // irrecoverably. The new device publishes its own KeyPackage and is
      // added to each group by the next sender's membership sync instead.
      // (Sender-keys seeds — seed:/send:/recv: — still transfer: they're
      // per-sender symmetric chains, safe to copy.)
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
  }, [userId]);

  const denyDevice = useCallback(() => {
    pendingBundleRef.current = null;
    setPendingApproval(null);
  }, []);

  // On connect: returning devices provision normally. A FRESH device publishes a
  // new identity, then tries device-to-device recovery (another online device of
  // ours), then falls back to the PIN restore modal, then to a clean start.
  const bootstrapIdentity = useCallback(
    async (s: TypedSocket) => {
      if (provisionedRef.current || !cryptoAvailable()) return;
      const res = await getBackup(s);
      setBackupUpdatedAt(res.updatedAt);
      if (await hasDeviceIdentity(userId)) {
        await provisionAndPublish(s);
        // Existing install that already holds a storage key but predates
        // continuous appends: seed the history store once (marker-guarded).
        void syncHistoryUp();
        return;
      }
      await provisionAndPublish(s); // publish a fresh identity so peers can target it
      if (await tryDeviceRecovery(s)) {
        // Reload so chat-context re-reads the imported seeds and 🔒 history
        // re-decrypts cleanly (same approach as the manual PIN restore).
        window.location.reload();
        return;
      }
      if (res.updatedAt) setNeedsRestore(true); // fall back to PIN restore
    },
    [getBackup, provisionAndPublish, tryDeviceRecovery, syncHistoryUp, userId],
  );
  const bootstrapRef = useRef(bootstrapIdentity);
  const onRecoveryRequestRef = useRef(onRecoveryRequest);
  const onRecoveryOfferRef = useRef(onRecoveryOffer);
  useEffect(() => {
    bootstrapRef.current = bootstrapIdentity;
    onRecoveryRequestRef.current = onRecoveryRequest;
    onRecoveryOfferRef.current = onRecoveryOffer;
  });

  // Upload a blob (+ its unlock proof) and WAIT for the server to confirm it
  // persisted. Without the ack the client would report success even when the
  // DB write fails.
  const putBackup = useCallback(
    (s: TypedSocket, blob: BackupBlob, kcv: string): Promise<BackupPutResult> =>
      new Promise((resolve) => {
        const done = (r?: BackupPutResult) =>
          resolve(r ?? { ok: false, updatedAt: null, error: "Timed out" });
        const t = setTimeout(() => done(), 8000);
        s.emit("backup:put", { blob, kcv }, (res) => {
          clearTimeout(t);
          done(res);
        });
      }),
    [],
  );

  const createBackup = useCallback(
    async (passphrase: string) => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      const blob = await buildBackup(userId, passphrase);
      if (!blob) throw new Error("No keys to back up yet");
      const res = await putBackup(s, blob, await computeKcv(passphrase, blob.salt, blob.iters));
      if (!res.ok) throw new Error(res.error || "Backup failed");
      passphraseRef.current = passphrase;
      setBackupEnabled(true);
      setBackupUpdatedAt(res.updatedAt);
      // First backup created a storage key — seed the history store with this
      // device's existing local history (one-time, marker-guarded).
      void syncHistoryUp();
    },
    [putBackup, userId, syncHistoryUp],
  );

  // Re-hold the existing backup PIN on this device: validate it by decrypting
  // the stored blob (throws "Incorrect PIN" on a mismatch), then resume backups.
  // Unlike runRestore, this does NOT re-import messages — this device already
  // has its history; we only need the passphrase held again so auto/manual
  // backup works without silently re-keying under a different secret.
  const unlockBackup = useCallback(
    async (passphrase: string): Promise<void> => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      // Vault-gated fetch (throws on wrong PIN / lockout), then a local decrypt
      // as the end-to-end validation and to read the payload.
      const blob = await unlockBlob(s, passphrase);
      const data = await decryptBackup(passphrase, blob);
      // A v3 blob carries the storage key — adopt it if this device predates
      // continuous history (never overwrite one we already hold).
      if (data.keys.sk && !(await storageKeyGet(userId))) {
        await storageKeyPut(userId, data.keys.sk);
      }
      passphraseRef.current = passphrase;
      setBackupEnabled(true);
      setBackupUpdatedAt((await getBackup(s)).updatedAt);
      void syncHistoryUp();
    },
    [getBackup, unlockBlob, userId, syncHistoryUp],
  );

  // Change the backup PIN. Requires the CURRENT PIN and validates it against the
  // stored blob before re-encrypting under the new one — so a backup's secret is
  // never silently replaced by someone who doesn't already know it. With no
  // existing blob this is just first-time setup.
  const changeBackupPin = useCallback(
    async (currentPassphrase: string, newPassphrase: string): Promise<void> => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      const meta = await getBackup(s);
      if (!meta.updatedAt) {
        await createBackup(newPassphrase);
        return;
      }
      // Prove the current secret through the vault (counts a guess on a wrong
      // PIN), then validate the decrypt locally before re-keying.
      const oldBlob = await unlockBlob(s, currentPassphrase);
      await decryptBackup(currentPassphrase, oldBlob);
      const blob = await buildBackup(userId, newPassphrase);
      if (!blob) throw new Error("No keys to back up yet");
      const put = await putBackup(
        s,
        blob,
        await computeKcv(newPassphrase, blob.salt, blob.iters),
      );
      if (!put.ok) throw new Error(put.error || "Backup failed");
      passphraseRef.current = newPassphrase;
      setBackupEnabled(true);
      setBackupUpdatedAt(put.updatedAt);
      void syncHistoryUp();
    },
    [getBackup, unlockBlob, createBackup, putBackup, userId, syncHistoryUp],
  );

  const backupNow = useCallback(async (): Promise<BackupPutResult> => {
    const s = socketRef.current;
    const pass = passphraseRef.current;
    if (!s)
      return { ok: false, updatedAt: null, error: "Not connected" };
    if (!pass)
      return {
        ok: false,
        updatedAt: null,
        error: "Enter your PIN to back up on this device",
      };
    const blob = await buildBackup(userId, pass);
    if (!blob)
      return { ok: false, updatedAt: null, error: "No keys to back up" };
    const res = await putBackup(s, blob, await computeKcv(pass, blob.salt, blob.iters));
    if (res.ok) setBackupUpdatedAt(res.updatedAt);
    return res;
  }, [putBackup, userId]);

  // Delete the server-side backup blob and forget the session passphrase.
  // Leaves local keys intact — this only removes the recovery copy.
  const deleteBackup = useCallback((): Promise<BackupDeleteResult> => {
    const s = socketRef.current;
    if (!s) return Promise.resolve({ ok: false, error: "Not connected" });
    return new Promise((resolve) => {
      const done = (r?: BackupDeleteResult) =>
        resolve(r ?? { ok: false, error: "Timed out" });
      const t = setTimeout(() => done(), 8000);
      s.emit("backup:delete", (res) => {
        clearTimeout(t);
        if (res.ok) {
          passphraseRef.current = null;
          setBackupEnabled(false);
          setBackupUpdatedAt(null);
        }
        done(res);
      });
    });
  }, []);

  const runRestore = useCallback(
    async (passphrase: string) => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      // Vault-gated fetch: wrong PINs are counted + locked out server-side
      // ("Incorrect PIN — N attempts left."). v3 blobs import the storage key;
      // v2 blobs import their embedded message rows.
      const blob = await unlockBlob(s, passphrase);
      await restoreBackup(userId, passphrase, blob);
      // Pull the continuous history store down with the imported storage key —
      // the full message history (forward-secret DMs included) lands in local
      // SQLite before the app loads groups.
      await syncHistoryDown(s);
      passphraseRef.current = passphrase;
      setBackupEnabled(true);
      setNeedsRestore(false);
      await provisionAndPublish(s);
    },
    [unlockBlob, provisionAndPublish, syncHistoryDown, userId],
  );

  const skipRestore = useCallback(() => {
    setNeedsRestore(false);
    const s = socketRef.current;
    if (s) void provisionAndPublish(s);
  }, [provisionAndPublish]);

  useEffect(() => {
    // Same-origin connection — the session cookie is sent automatically and
    // verified by the server's handshake middleware.
    const s: TypedSocket = io({
      withCredentials: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    // Intentional one-time setup: the socket instance must live in state so
    // consumers re-render when it's ready (not derived state).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSocket(s);
    socketRef.current = s;

    const runHealthCheck = () => {
      const t = Date.now();
      s.emit("echo", { t }, (reply) => {
        setLatencyMs(Date.now() - reply.t);
      });
    };

    s.on("connect", () => {
      setStatus("connected");
      runHealthCheck();
      // Provision keys (or pause for restore if a backup exists and this device
      // has none). Best-effort: a runtime without WebCrypto just skips it.
      void bootstrapRef.current(s).catch((err) =>
        console.warn("[e2ee] key bootstrap failed", err),
      );
    });
    s.on("disconnect", () => setStatus("disconnected"));
    s.io.on("reconnect_attempt", () => setStatus("reconnecting"));

    // Device-to-device recovery relays (same-user devices only, server-enforced).
    s.on("recovery:request", (p) => void onRecoveryRequestRef.current(p));
    s.on("recovery:offer", (p) => void onRecoveryOfferRef.current(p));

    // Proactively reconnect when the network/ tab comes back (e.g. after sleep),
    // rather than waiting for the ping timeout to notice the dead connection.
    const nudge = () => {
      if (!s.connected) s.connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") nudge();
    };
    window.addEventListener("online", nudge);
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("online", nudge);
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", onVisible);
      s.removeAllListeners();
      s.io.removeAllListeners();
      s.close();
    };
  }, []);

  return (
    <SocketContext.Provider
      value={{
        socket,
        status,
        latencyMs,
        userId,
        user,
        deviceId,
        fingerprint,
        needsRestore,
        backupUpdatedAt,
        backupEnabled,
        createBackup,
        unlockBackup,
        changeBackupPin,
        backupNow,
        deleteBackup,
        runRestore,
        skipRestore,
        replenishKeys,
        recovering,
        pendingApproval,
        approveDevice,
        denyDevice,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}

const STATUS_META: Record<
  ConnectionStatus,
  { label: string; color: string }
> = {
  connecting: { label: "Connecting…", color: "var(--app-yellow)" },
  connected: { label: "Connected", color: "var(--app-green)" },
  reconnecting: { label: "Reconnecting…", color: "var(--app-yellow)" },
  disconnected: { label: "Offline", color: "var(--app-faint)" },
};

/** Compact live connection indicator for the sidebar footer. */
export function ConnectionStatus() {
  const { status, latencyMs } = useSocket();
  const meta = STATUS_META[status];
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-app-muted"
      title={
        status === "connected" && latencyMs != null
          ? `WebSocket connected · ${latencyMs}ms`
          : meta.label
      }
    >
      <span
        className="size-[7px] shrink-0 rounded-full"
        style={{ background: meta.color }}
      />
      <span>{meta.label}</span>
      {status === "connected" && latencyMs != null && (
        <span className="font-mono text-app-faint">· {latencyMs}ms</span>
      )}
    </div>
  );
}
