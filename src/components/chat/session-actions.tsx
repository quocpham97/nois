"use client";

/**
 * What a view can DO with the session: manage the encrypted key backup, restore
 * onto a fresh device, and answer another device's recovery request.
 *
 * Session STATE (status, latency, device id, fingerprint, backup timestamps) is
 * read from `useSessionStore`. As with the chat and call actions, this value is
 * referentially stable, so the backup modals don't re-render when the socket
 * reconnects.
 */
import { createContext, useContext } from "react";
import type { BackupDeleteResult, BackupPutResult } from "@/lib/socket-events";

export type SessionActionsValue = {
  /** Encrypt the current keys under `passphrase` and upload (first-time setup;
   *  also enables auto-backup). Throws if the server rejects it. */
  createBackup: (passphrase: string) => Promise<void>;
  /** Re-hold the EXISTING backup PIN on this device (validates it against the
   *  stored blob, then resumes backup) without re-importing history. Throws
   *  "Incorrect PIN" on a mismatch. */
  unlockBackup: (passphrase: string) => Promise<void>;
  /** Change the backup PIN: validates `currentPassphrase` against the stored
   *  blob, then re-encrypts under `newPassphrase`. Throws on a wrong current PIN. */
  changeBackupPin: (
    currentPassphrase: string,
    newPassphrase: string,
  ) => Promise<void>;
  /** Re-upload a fresh backup using the session passphrase. */
  backupNow: () => Promise<BackupPutResult>;
  /** Delete the server-side backup blob (local keys are untouched). */
  deleteBackup: () => Promise<BackupDeleteResult>;
  /** Restore keys from the server backup with `passphrase`, then provision. */
  runRestore: (passphrase: string) => Promise<void>;
  /** Dismiss the restore prompt and provision a fresh identity instead. */
  skipRestore: () => void;
  /** Refill + republish one-time prekeys if the pool has drained (sustains FS). */
  replenishKeys: () => Promise<void>;
  /** Approve the pending device: seal our group keys to it and send them over. */
  approveDevice: () => void;
  /** Deny the pending device recovery request. */
  denyDevice: () => void;
};

const SessionActionsContext = createContext<SessionActionsValue | null>(null);

export const SessionActionsProvider = SessionActionsContext.Provider;

export function useSessionActions(): SessionActionsValue {
  const ctx = useContext(SessionActionsContext);
  if (!ctx)
    throw new Error("useSessionActions must be used within SessionProvider");
  return ctx;
}
