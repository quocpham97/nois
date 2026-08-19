"use client";

/**
 * The user-facing key-backup operations: create a PIN, re-hold an existing one,
 * change it, back up now, delete the server copy, and restore onto a fresh device.
 *
 * The PIN is held in a ref for the session only (never persisted) so auto-backup
 * can re-encrypt after key changes without re-prompting.
 */
import { useCallback, useMemo, useRef } from "react";
import { storageKeyGet, storageKeyPut } from "@/lib/crypto/identity";
import {
  buildBackup,
  computeKcv,
  decryptBackup,
  restoreBackup,
} from "@/lib/crypto/backup";
import type { BackupDeleteResult, BackupPutResult } from "@/lib/socket-events";
import { session, type TypedSocket } from "@/stores/session-store";
import type { BackupVault } from "./use-backup-vault";
import type { DeviceIdentity } from "./use-device-identity";
import type { HistorySync } from "./use-history-sync";

export type KeyBackup = ReturnType<typeof useKeyBackup>;

export function useKeyBackup({
  userId,
  socketRef,
  vault,
  identity,
  history,
}: {
  userId: string;
  socketRef: React.RefObject<TypedSocket | null>;
  vault: BackupVault;
  identity: DeviceIdentity;
  history: HistorySync;
}) {
  const { getBackup, unlockBlob, putBackup } = vault;
  const { provisionAndPublish } = identity;

  /** Session-held passphrase, so auto-backup can re-encrypt after key changes
   *  without re-prompting. Never persisted. */
  const passphraseRef = useRef<string | null>(null);

  const createBackup = useCallback(
    async (passphrase: string) => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      const blob = await buildBackup(userId, passphrase);
      if (!blob) throw new Error("No keys to back up yet");
      const res = await putBackup(
        s,
        blob,
        await computeKcv(passphrase, blob.salt, blob.iters),
      );
      if (!res.ok) throw new Error(res.error || "Backup failed");
      passphraseRef.current = passphrase;
      session().setBackupEnabled(true);
      session().setBackupUpdatedAt(res.updatedAt);
      // First backup created a storage key — seed the history store with this
      // device's existing local history (one-time, marker-guarded).
      void history.syncUp();
    },
    [putBackup, userId, history, socketRef],
  );

  /** Re-hold the existing backup PIN on this device: validate it by decrypting the
   *  stored blob (throws "Incorrect PIN" on a mismatch), then resume backups.
   *  Unlike runRestore, this does NOT re-import messages — this device already has
   *  its history; we only need the passphrase held again so auto/manual backup works
   *  without silently re-keying under a different secret. */
  const unlockBackup = useCallback(
    async (passphrase: string): Promise<void> => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      // Vault-gated fetch (throws on wrong PIN / lockout), then a local decrypt as
      // the end-to-end validation and to read the payload.
      const blob = await unlockBlob(s, passphrase);
      const data = await decryptBackup(passphrase, blob);
      // A v3 blob carries the storage key — adopt it if this device predates
      // continuous history (never overwrite one we already hold).
      if (data.keys.sk && !(await storageKeyGet(userId))) {
        await storageKeyPut(userId, data.keys.sk);
      }
      passphraseRef.current = passphrase;
      session().setBackupEnabled(true);
      session().setBackupUpdatedAt((await getBackup(s)).updatedAt);
      void history.syncUp();
    },
    [getBackup, unlockBlob, userId, history, socketRef],
  );

  /** Change the backup PIN. Requires the CURRENT PIN and validates it against the
   *  stored blob before re-encrypting under the new one — so a backup's secret is
   *  never silently replaced by someone who doesn't already know it. With no
   *  existing blob this is just first-time setup. */
  const changeBackupPin = useCallback(
    async (currentPassphrase: string, newPassphrase: string): Promise<void> => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      const meta = await getBackup(s);
      if (!meta.updatedAt) {
        await createBackup(newPassphrase);
        return;
      }
      // Prove the current secret through the vault (counts a guess on a wrong PIN),
      // then validate the decrypt locally before re-keying.
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
      session().setBackupEnabled(true);
      session().setBackupUpdatedAt(put.updatedAt);
      void history.syncUp();
    },
    [getBackup, unlockBlob, createBackup, putBackup, userId, history, socketRef],
  );

  const backupNow = useCallback(async (): Promise<BackupPutResult> => {
    const s = socketRef.current;
    const pass = passphraseRef.current;
    if (!s) return { ok: false, updatedAt: null, error: "Not connected" };
    if (!pass)
      return {
        ok: false,
        updatedAt: null,
        error: "Enter your PIN to back up on this device",
      };
    const blob = await buildBackup(userId, pass);
    if (!blob) return { ok: false, updatedAt: null, error: "No keys to back up" };
    const res = await putBackup(
      s,
      blob,
      await computeKcv(pass, blob.salt, blob.iters),
    );
    if (res.ok) session().setBackupUpdatedAt(res.updatedAt);
    return res;
  }, [putBackup, userId, socketRef]);

  /** Delete the server-side backup blob and forget the session passphrase. Leaves
   *  local keys intact — this only removes the recovery copy. */
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
          session().setBackupEnabled(false);
          session().setBackupUpdatedAt(null);
        }
        done(res);
      });
    });
  }, [socketRef]);

  const runRestore = useCallback(
    async (passphrase: string) => {
      const s = socketRef.current;
      if (!s) throw new Error("Not connected");
      // Vault-gated fetch: wrong PINs are counted + locked out server-side
      // ("Incorrect PIN — N attempts left."). v3 blobs import the storage key; v2
      // blobs import their embedded message rows.
      const blob = await unlockBlob(s, passphrase);
      await restoreBackup(userId, passphrase, blob);
      // Pull the continuous history store down with the imported storage key — the
      // full message history (forward-secret DMs included) lands in local SQLite
      // before the app loads groups.
      await history.syncDown(s);
      passphraseRef.current = passphrase;
      session().setBackupEnabled(true);
      session().setNeedsRestore(false);
      await provisionAndPublish(s);
    },
    [unlockBlob, provisionAndPublish, history, userId, socketRef],
  );

  const skipRestore = useCallback(() => {
    session().setNeedsRestore(false);
    const s = socketRef.current;
    if (s) void provisionAndPublish(s);
  }, [provisionAndPublish, socketRef]);

  return useMemo(
    () => ({
      createBackup,
      unlockBackup,
      changeBackupPin,
      backupNow,
      deleteBackup,
      runRestore,
      skipRestore,
    }),
    [
      createBackup,
      unlockBackup,
      changeBackupPin,
      backupNow,
      deleteBackup,
      runRestore,
      skipRestore,
    ],
  );
}
