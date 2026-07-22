"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { ShieldCheck, KeyRound, ShieldAlert } from "lucide-react";
import { useSocket } from "./socket-context";
import { useChat } from "./chat-context";
import { clearDeviceIdentity } from "@/lib/crypto/identity";
import { clearAll as clearMessages } from "@/lib/message-db";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** Backup unlock is a numbers-only PIN; require at least this many digits. */
const MIN_PIN = 8;
const isValidPin = (s: string) => new RegExp(`^\\d{${MIN_PIN},}$`).test(s);
/** Keep only digits so the field can never hold a non-numeric PIN. */
const digitsOnly = (s: string) => s.replace(/\D/g, "");

// A high-entropy alternative to a PIN: 32 chars from a Crockford-style base32
// alphabet (no I/L/O/U to avoid ambiguity), grouped in fives for legibility —
// ~165 bits, immune to the offline-guessing weakness a short numeric PIN has.
// The user must save it; it can't be recovered if lost (see backup.ts).
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 5 === 0) out += "-";
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Shown automatically on a device with no local keys when a server backup
 * exists — restore message history by entering the passphrase, or skip (a fresh
 * identity is created and old history stays 🔒).
 */
export function RestoreKeysModal() {
  const { needsRestore, runRestore, skipRestore } = useSocket();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Skipping abandons a recoverable backup, so confirm it in two steps rather
  // than losing history to a stray click.
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  if (!needsRestore) return null;

  const submit = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runRestore(pass);
      setPass("");
      // Reload so chat-context re-reads the restored keys + message history from
      // storage and 🔒 history re-renders as plaintext (mirrors the Settings
      // "Restore from backup" path).
      window.location.reload();
    } catch (e) {
      setError((e as Error).message || "Restore failed");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && skipRestore()}>
      <DialogContent className="flex w-[460px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[460px]">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-app-border px-5">
          <KeyRound size={17} className="text-app-accent" />
          <DialogTitle className="text-[16px] font-bold">
            Restore your encrypted messages
          </DialogTitle>
        </div>
        <div className="px-5 py-4">
          <p className="mb-3 text-[13px] leading-[1.5] text-app-muted">
            This device has no keys. Enter your backup PIN to restore your
            message history. Skipping starts fresh — past messages stay locked.
          </p>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pass}
            onChange={(e) => setPass(digitsOnly(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Backup PIN"
            className="w-full rounded-md border border-app-border bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-app-accent"
          />
          {error && (
            <div className="mt-2 text-[12px]" style={{ color: "oklch(0.62 0.2 25)" }}>
              {error}
            </div>
          )}
        </div>
        {confirmingSkip && (
          <div className="border-t border-app-border bg-panel-2 px-5 py-2.5 text-[12px] leading-[1.5] text-app-muted">
            Start fresh without restoring? Your past messages stay locked on this
            device, even though a backup exists. Click “Skip anyway” to confirm.
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
          <button
            onClick={() =>
              confirmingSkip ? skipRestore() : setConfirmingSkip(true)
            }
            className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover"
          >
            {confirmingSkip ? "Skip anyway" : "Skip"}
          </button>
          <button
            onClick={submit}
            disabled={!pass || busy}
            className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50"
            style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
          >
            {busy ? "Restoring…" : "Restore"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Settings panel: set up / refresh the passphrase-encrypted key backup. The
 *  "Set a backup PIN" dialog itself lives in the standalone BackupSetupModal
 *  (opened via the shared context flag) so it can also be popped from the nudge
 *  banner without opening Settings. */
export function BackupPanel() {
  const {
    backupUpdatedAt,
    backupEnabled,
    backupNow,
    deleteBackup,
    runRestore,
    unlockBackup,
  } = useSocket();
  const { setBackupSetupOpen } = useChat();
  const [backingUp, setBackingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Manual restore (e.g. after skipping, or to pull history onto this device).
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePin, setRestorePin] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Unlock: re-enter the EXISTING PIN to resume backups this session (no reload,
  // no re-import) — the everyday "keep backing up" path after a reload.
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPin, setUnlockPin] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const doUnlock = async () => {
    if (unlockBusy || !unlockPin) return;
    setUnlockBusy(true);
    setUnlockError(null);
    try {
      await unlockBackup(unlockPin);
      setUnlockOpen(false);
      setUnlockPin("");
      setStatus("Backups resumed on this device.");
    } catch (e) {
      setUnlockError((e as Error).message || "Couldn’t unlock");
    } finally {
      setUnlockBusy(false);
    }
  };
  // Deleting the server backup is destructive (it's the only off-device
  // recovery path), so it's confirmed in a modal.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const doRestore = async () => {
    if (restoreBusy || !restorePin) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      await runRestore(restorePin);
      // Reload so the restored identity + group keys fully replace the in-memory
      // session state and previously-🔒 history re-decrypts cleanly.
      window.location.reload();
    } catch (e) {
      setRestoreError((e as Error).message || "Restore failed");
      setRestoreBusy(false);
    }
  };

  const doDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    setStatus(null);
    const res = await deleteBackup();
    setDeleting(false);
    setDeleteOpen(false);
    if (res.ok) setStatus("Backup deleted.");
    else setError(res.error || "Delete failed.");
  };

  return (
    <div className="rounded-lg border border-app-border p-4">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck size={16} className="text-app-accent" />
        <h3 className="m-0 text-[14px] font-semibold">Encrypted message backup</h3>
      </div>
      <p className="mb-3 text-[12.5px] leading-[1.5] text-app-muted">
        Encrypt your device keys under a PIN so you can restore your message
        history after clearing data or on a new device. The server only stores
        the encrypted blob — it can&apos;t read your messages. The PIN
        can&apos;t be recovered if forgotten. A numbers-only PIN is easier to
        remember but easier to guess than a passphrase — use {MIN_PIN}+ digits,
        the more the better.
      </p>
      <div className="mb-3 text-[12px] text-app-faint">
        Last backup: {relTime(backupUpdatedAt)}
        {backupEnabled && " · auto-backup on this device is on"}
      </div>
      <div className="flex items-center gap-2">
        {backupUpdatedAt && !backupEnabled ? (
          // A backup exists but this session hasn't unlocked it — the everyday
          // resume path: enter the SAME PIN, don't set up a new one.
          <button
            onClick={() => {
              setError(null);
              setStatus(null);
              setUnlockError(null);
              setUnlockPin("");
              setUnlockOpen(true);
            }}
            className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold"
            style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
          >
            Enter PIN to resume backups
          </button>
        ) : (
          <button
            onClick={() => {
              setError(null);
              setStatus(null);
              setBackupSetupOpen(true);
            }}
            className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold"
            style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
          >
            {backupUpdatedAt ? "Change PIN" : "Set up backup"}
          </button>
        )}
        {backupEnabled && (
          <button
            disabled={backingUp}
            onClick={async () => {
              setBackingUp(true);
              setError(null);
              setStatus(null);
              const res = await backupNow();
              setBackingUp(false);
              if (res.ok) setStatus("Backed up just now.");
              else setError(res.error || "Backup failed.");
            }}
            className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
          >
            {backingUp ? "Backing up…" : "Back up now"}
          </button>
        )}
        {backupUpdatedAt && (
          <button
            onClick={() => {
              setRestoreError(null);
              setRestorePin("");
              setRestoreOpen(true);
            }}
            className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover"
          >
            Restore from backup
          </button>
        )}
        {backupUpdatedAt && (
          <button
            onClick={() => {
              setError(null);
              setStatus(null);
              setDeleteOpen(true);
            }}
            className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] hover:bg-panel-hover"
            style={{ color: "oklch(0.62 0.2 25)" }}
          >
            Delete backup
          </button>
        )}
        {status && <span className="text-[12px] text-app-faint">{status}</span>}
        {error && (
          <span className="text-[12px]" style={{ color: "oklch(0.62 0.2 25)" }}>
            {error}
          </span>
        )}
      </div>

      <Dialog open={restoreOpen} onOpenChange={(o) => !restoreBusy && setRestoreOpen(o)}>
        <DialogContent className="flex w-[420px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[420px]">
          <div className="flex h-14 items-center border-b border-app-border px-5">
            <DialogTitle className="text-[16px] font-bold">
              Restore from backup
            </DialogTitle>
          </div>
          <div className="flex flex-col gap-2 px-5 py-4">
            <p className="text-[12.5px] leading-[1.5] text-app-muted">
              Enter your backup PIN to restore your keys on this device and
              recover your message history. The page will reload.
            </p>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={restorePin}
              onChange={(e) => setRestorePin(digitsOnly(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && doRestore()}
              placeholder="Backup PIN"
              className="w-full rounded-md border border-app-border bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-app-accent"
            />
            {restoreError && (
              <div className="text-[12px]" style={{ color: "oklch(0.62 0.2 25)" }}>
                {restoreError}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
            <button
              onClick={() => setRestoreOpen(false)}
              disabled={restoreBusy}
              className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={doRestore}
              disabled={restoreBusy || !restorePin}
              className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50"
              style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
            >
              {restoreBusy ? "Restoring…" : "Restore"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={unlockOpen} onOpenChange={(o) => !unlockBusy && setUnlockOpen(o)}>
        <DialogContent className="flex w-[420px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[420px]">
          <div className="flex h-14 items-center border-b border-app-border px-5">
            <DialogTitle className="text-[16px] font-bold">
              Resume backups
            </DialogTitle>
          </div>
          <div className="flex flex-col gap-2 px-5 py-4">
            <p className="text-[12.5px] leading-[1.5] text-app-muted">
              Enter your existing backup PIN to keep backing up on this device.
              This doesn&apos;t change your PIN or reload the page.
            </p>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={unlockPin}
              onChange={(e) => setUnlockPin(digitsOnly(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && doUnlock()}
              placeholder="Backup PIN"
              className="w-full rounded-md border border-app-border bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-app-accent"
            />
            {unlockError && (
              <div className="text-[12px]" style={{ color: "oklch(0.62 0.2 25)" }}>
                {unlockError}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
            <button
              onClick={() => setUnlockOpen(false)}
              disabled={unlockBusy}
              className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={doUnlock}
              disabled={unlockBusy || !unlockPin}
              className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50"
              style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
            >
              {unlockBusy ? "Unlocking…" : "Resume"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(o) => !deleting && setDeleteOpen(o)}>
        <DialogContent className="flex w-[420px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[420px]">
          <div className="flex h-14 items-center gap-2 border-b border-app-border px-5">
            <ShieldAlert size={17} style={{ color: "oklch(0.62 0.2 25)" }} />
            <DialogTitle className="text-[16px] font-bold">
              Delete backup?
            </DialogTitle>
          </div>
          <div className="px-5 py-4">
            <p className="text-[12.5px] leading-[1.5] text-app-muted">
              This permanently deletes the encrypted backup from the server. You
              won&apos;t be able to restore your message history on a new device
              or after clearing this one — only the keys already on this device
              keep working. This can&apos;t be undone.
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
            <button
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
              className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void doDelete()}
              disabled={deleting}
              className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
              style={{ background: "var(--app-red)" }}
            >
              {deleting ? "Deleting…" : "Delete backup"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Standalone "Set a backup PIN" modal. Its open-state lives in ChatContext so it
 * can be popped over ANY view — by the no-backup nudge banner or the sign-out
 * dialog — without first navigating into Settings. Mounted once in the app shell
 * (chat-app.tsx). Doubles as "Change PIN" when a backup already exists.
 */
export function BackupSetupModal() {
  const {
    backupUpdatedAt,
    createBackup,
    changeBackupPin,
    status,
    deviceId,
    needsRestore,
    recovering,
  } = useSocket();
  const { backupSetupOpen: open, setBackupSetupOpen: setOpen } = useChat();
  // Changing an existing backup requires proving the current secret first, so a
  // backup's PIN can't be silently replaced by someone who doesn't know it.
  const changing = !!backupUpdatedAt;
  // Onboarding: a connected, provisioned account with NO backup gets this modal
  // opened automatically (Messenger-style mandatory PIN setup) — messages only
  // flow into the encrypted history store once a storage key exists, so an
  // unprotected account is unrecoverable on a new device. "Not now" dismisses
  // for the session; it re-opens on the next one until a backup exists.
  // Derived (no effect): open = explicit open OR un-dismissed onboarding nag.
  const [nagDismissed, setNagDismissed] = useState(false);
  const mustSetup =
    status === "connected" &&
    !!deviceId &&
    backupUpdatedAt === null &&
    !needsRestore &&
    !recovering;
  const nagOpen = mustSetup && !nagDismissed;
  const effectiveOpen = open || nagOpen;
  // "pin" = memorable but offline-guessable; "code" = high-entropy, must be saved.
  const [mode, setMode] = useState<"pin" | "code">("pin");
  const [current, setCurrent] = useState("");
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [codeSaved, setCodeSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode("pin");
    setCurrent("");
    setPass("");
    setConfirm("");
    setCode("");
    setCodeSaved(false);
    setError(null);
  };

  const close = (o: boolean) => {
    if (busy) return;
    if (!o && nagOpen) setNagDismissed(true); // "Not now" on the onboarding nag
    setOpen(o);
    if (!o) reset();
  };

  const toCodeMode = () => {
    // Generate once on entering code mode so the displayed value is stable.
    setCode((c) => c || generateRecoveryCode());
    setError(null);
    setMode("code");
  };

  const upload = async (secret: string) => {
    setBusy(true);
    setError(null);
    try {
      // Changing requires the current secret (validated server-side against the
      // stored blob); first-time setup just creates it.
      if (changing) await changeBackupPin(current, secret);
      else await createBackup(secret);
      reset();
      setOpen(false);
    } catch (e) {
      setError((e as Error).message || "Backup failed");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (busy) return;
    if (changing && !current) return setError("Enter your current PIN.");
    if (mode === "code") {
      if (!codeSaved) return setError("Confirm you've saved the code first.");
      return void upload(code);
    }
    if (!isValidPin(pass))
      return setError(`Use at least ${MIN_PIN} digits (numbers only).`);
    if (pass !== confirm) return setError("PINs don't match.");
    void upload(pass);
  };

  return (
    <Dialog open={effectiveOpen} onOpenChange={close}>
      <DialogContent className="flex w-[420px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[420px]">
        <div className="flex h-14 items-center border-b border-app-border px-5">
          <DialogTitle className="text-[16px] font-bold">
            {backupUpdatedAt ? "Update backup" : "Secure your messages"}
          </DialogTitle>
        </div>
        <div className="flex flex-col gap-2 px-5 py-4">
          {changing && (
            <input
              type="password"
              autoComplete="off"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="Current PIN or recovery code"
              className="w-full rounded-md border border-app-border bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-app-accent"
            />
          )}
          {mode === "pin" ? (
            <>
              <p className="mb-1 text-[12.5px] leading-[1.5] text-app-muted">
                {changing
                  ? "Choose a new PIN. You’ll need your current PIN above to confirm the change."
                  : "Set a PIN to protect your message history. From then on your messages are continuously backed up (encrypted — only your PIN unlocks them), so logging in on a new device restores everything. The PIN can’t be recovered if forgotten — use " +
                    MIN_PIN +
                    "+ digits."}
              </p>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                autoFocus={!changing}
                value={pass}
                onChange={(e) => setPass(digitsOnly(e.target.value))}
                placeholder={`New PIN (${MIN_PIN}+ digits)`}
                className="w-full rounded-md border border-app-border bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-app-accent"
              />
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={confirm}
                onChange={(e) => setConfirm(digitsOnly(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="Confirm PIN"
                className="w-full rounded-md border border-app-border bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-app-accent"
              />
              <button
                onClick={toCodeMode}
                className="mt-1 self-start text-[12px] text-app-accent hover:underline"
              >
                Prefer a recovery code? (stronger)
              </button>
            </>
          ) : (
            <>
              <p className="mb-1 text-[12.5px] leading-[1.5] text-app-muted">
                Save this recovery code somewhere safe — a password manager is
                ideal. It&apos;s the only way to restore your history and{" "}
                <strong>can&apos;t be recovered if lost</strong>.
              </p>
              <div className="select-all rounded-md border border-app-border bg-panel-2 px-3 py-2 font-mono text-[13px] leading-[1.6] tracking-wide text-app-text">
                {code}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  onClick={() => void navigator.clipboard?.writeText(code)}
                  className="rounded-[6px] border border-app-border px-2.5 py-1 text-[12px] text-app-muted hover:bg-panel-hover"
                >
                  Copy
                </button>
                <button
                  onClick={() => setMode("pin")}
                  className="text-[12px] text-app-accent hover:underline"
                >
                  Use a PIN instead
                </button>
              </div>
              <label className="mt-2 flex items-center gap-2 text-[12.5px] text-app-muted">
                <input
                  type="checkbox"
                  checked={codeSaved}
                  onChange={(e) => setCodeSaved(e.target.checked)}
                />
                I&apos;ve saved this code
              </label>
            </>
          )}
          {error && (
            <div className="text-[12px]" style={{ color: "oklch(0.62 0.2 25)" }}>
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
          <button
            onClick={() => close(false)}
            disabled={busy}
            className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
          >
            {nagOpen ? "Not now" : "Cancel"}
          </button>
          <button
            onClick={save}
            disabled={busy || (mode === "code" && !codeSaved)}
            className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50"
            style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
          >
            {busy ? "Encrypting…" : "Back up"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * TOFU warning: a peer device's identity key changed since we pinned it (a
 * possible key swap / MITM, or a legitimate re-provision). Shows one alert at a
 * time with the new safety number and an Acknowledge action that re-pins.
 */
export function KeyChangeBanner() {
  const { keyAlerts, acknowledgeKeyAlert } = useChat();
  if (!keyAlerts.length) return null;
  const a = keyAlerts[0];
  return (
    <div
      className="flex items-center gap-2.5 border-b px-4 py-2"
      style={{ background: "oklch(0.62 0.2 25 / 0.12)", borderColor: "oklch(0.62 0.2 25 / 0.4)" }}
    >
      <ShieldAlert size={15} className="shrink-0" style={{ color: "oklch(0.62 0.2 25)" }} />
      <span className="flex-1 text-[12.5px] leading-[1.4] text-app-text">
        The safety number for {a.peerUserId ? <strong>{a.peerUserId}</strong> : "a contact"}
        ’s device changed. If you didn’t expect this, verify it out of band before
        trusting. New number: <span className="font-mono">{a.pendingFingerprint}</span>
      </span>
      <button
        onClick={() => void acknowledgeKeyAlert(a.deviceId)}
        className="shrink-0 rounded-[6px] border border-app-border bg-panel px-2.5 py-1 text-[12.5px] font-semibold hover:bg-panel-hover"
      >
        Acknowledge
      </button>
    </div>
  );
}

/**
 * Requester side of device-to-device recovery: a thin, non-blocking banner shown
 * on a fresh device while it waits (briefly) for one of the user's other online
 * devices to approve and hand over the group keys. On success the app reloads.
 */
export function RecoveryWaitingBanner() {
  const { recovering } = useSocket();
  if (!recovering) return null;
  return (
    <div className="flex items-center gap-2 border-b border-app-border bg-panel-2 px-4 py-1.5">
      <KeyRound size={13} className="shrink-0 animate-pulse text-app-accent" />
      <span className="text-[12px] leading-[1.4] text-app-muted">
        Checking your other devices to restore your message history…
      </span>
    </div>
  );
}

/**
 * Responder side (security-critical): an EXISTING device shows this when a new
 * device asks to recover. The human must confirm the safety number matches the
 * one shown on the new device — this is the trust anchor that stops a malicious
 * server from injecting a rogue device to exfiltrate the account's keys. Approve
 * ONLY on a match; the new device gets the group history keys, not the identity.
 */
export function DeviceApprovalModal() {
  const { pendingApproval, approveDevice, denyDevice } = useSocket();
  if (!pendingApproval) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && denyDevice()}>
      <DialogContent className="flex w-[460px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[460px]">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-app-border px-5">
          <ShieldAlert size={17} className="text-app-accent" />
          <DialogTitle className="text-[16px] font-bold">
            A new device wants to sign in
          </DialogTitle>
        </div>
        <div className="px-5 py-4">
          <p className="mb-3 text-[13px] leading-[1.5] text-app-muted">
            A device is asking to restore your encrypted message history. Approve
            it <strong>only</strong> if you just signed in on a new device and the
            safety number below <strong>exactly matches</strong> the one shown
            there. If you didn’t start this, deny it.
          </p>
          <div className="select-all rounded-md border border-app-border bg-panel-2 px-3 py-2 font-mono text-[13px] leading-[1.6] tracking-wide text-app-text">
            {pendingApproval.fingerprint}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
          <button
            onClick={denyDevice}
            className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover"
          >
            Deny
          </button>
          <button
            onClick={approveDevice}
            className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold"
            style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
          >
            Approve
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sign-out confirmation that won't let you walk off a cliff: if no backup
 * exists, signing out permanently locks history (it also wipes this device's
 * keys + local message cache), so we warn and offer to set one up first. If a
 * backup exists, we offer a final "back up now" so freshly-rotated group keys
 * are captured before the local copy is gone. Controlled — the trigger lives
 * elsewhere (the user avatar menu in the workspace rail).
 */
export function SignOutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { userId, backupUpdatedAt, backupEnabled, backupNow } = useSocket();
  const { setBackupSetupOpen } = useChat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasBackup = backupUpdatedAt !== null;

  // Clear this device's keys + the local decrypted-message cache BEFORE ending
  // the session, so signing out actually leaves the machine clean. Best-effort:
  // if a clear fails we still sign out rather than trap the user. Old messages
  // remain recoverable on next login only via the encrypted backup.
  const doSignOut = async () => {
    setBusy(true);
    try {
      await Promise.all([clearDeviceIdentity(userId), clearMessages()]);
    } catch (e) {
      console.warn("[e2ee] sign-out key wipe failed", e);
    }
    void signOut({ callbackUrl: "/login" });
  };

  const backupThenSignOut = async () => {
    setBusy(true);
    setError(null);
    const res = await backupNow();
    if (!res.ok) {
      setError(res.error || "Backup failed");
      setBusy(false);
      return;
    }
    await doSignOut();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
        <DialogContent className="flex w-[440px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[440px]">
          <div className="flex h-14 items-center gap-2 border-b border-app-border px-5">
            {!hasBackup && <ShieldAlert size={17} className="text-app-accent" />}
            <DialogTitle className="text-[16px] font-bold">
              {hasBackup ? "Sign out" : "Sign out without a backup?"}
            </DialogTitle>
          </div>
          <div className="px-5 py-4">
            <p className="text-[13px] leading-[1.5] text-app-muted">
              {hasBackup
                ? "Your keys are backed up, so you can restore your message history after signing back in. Back up once more to capture any recent changes."
                : "You haven’t backed up your keys. Signing out clears them from this device and permanently locks your message history — it can’t be recovered."}
            </p>
            {error && (
              <div className="mt-2 text-[12px]" style={{ color: "oklch(0.62 0.2 25)" }}>
                {error}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
            <button
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
            >
              Cancel
            </button>
            {hasBackup ? (
              <>
                <button
                  onClick={() => void doSignOut()}
                  disabled={busy}
                  className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
                >
                  Sign out
                </button>
                <button
                  onClick={backupThenSignOut}
                  disabled={busy || !backupEnabled}
                  title={
                    backupEnabled
                      ? undefined
                      : "Enter your PIN in the backup panel to enable one-tap backup"
                  }
                  className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50"
                  style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
                >
                  {busy ? "Backing up…" : "Back up & sign out"}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => void doSignOut()}
                  disabled={busy}
                  className="rounded-[6px] border border-app-border px-3 py-1.5 text-[13px] text-app-muted hover:bg-panel-hover disabled:opacity-50"
                >
                  Sign out anyway
                </button>
                <button
                  onClick={() => {
                    onOpenChange(false);
                    setBackupSetupOpen(true);
                  }}
                  className="rounded-[6px] px-3 py-1.5 text-[13px] font-semibold"
                  style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
                >
                  Set up backup
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
  );
}
