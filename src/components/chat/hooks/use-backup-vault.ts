"use client";

/**
 * Server transport for the encrypted key backup: read its metadata, fetch the
 * blob through the rate-limited unlock vault, and write a new one.
 *
 * The vault is what makes a short PIN safe: `backup:get` exposes only the KDF
 * params, the client derives a proof from them, and the blob comes back from
 * `backup:unlock` only on a match. Wrong PINs and lockouts surface as the
 * server's message (with attempts remaining). Legacy pre-vault rows come back
 * directly from `backup:get`.
 */
import { useCallback, useMemo } from "react";
import { type BackupBlob, computeKcv } from "@/lib/crypto/backup";
import type {
  BackupGetResult,
  BackupPutResult,
  BackupUnlockResult,
} from "@/lib/socket-events";
import type { TypedSocket } from "@/stores/session-store";

export type BackupVault = ReturnType<typeof useBackupVault>;

export function useBackupVault() {
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

  const unlockBlob = useCallback(
    async (s: TypedSocket, passphrase: string): Promise<BackupBlob> => {
      const meta = await getBackup(s);
      if (!meta.updatedAt) throw new Error("No backup found");
      if (meta.legacyBlob) return meta.legacyBlob as BackupBlob;
      if (!meta.salt || !meta.iters) throw new Error("Backup metadata unavailable");
      const kcv = await computeKcv(passphrase, meta.salt, meta.iters);
      const res = await new Promise<BackupUnlockResult>((resolve) => {
        const t = setTimeout(() => resolve({ ok: false, error: "Timed out" }), 8000);
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

  /** Upload a blob (+ its unlock proof) and WAIT for the server to confirm it
   *  persisted. Without the ack the client would report success even when the DB
   *  write fails. */
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

  return useMemo(
    () => ({ getBackup, unlockBlob, putBackup }),
    [getBackup, unlockBlob, putBackup],
  );
}
