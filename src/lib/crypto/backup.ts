// Passphrase/PIN-encrypted backup of this device's keys (crypto/identity.ts
// export/import) AND its decrypted message history (message-db). The message
// content is included because keys alone can't recover forward-secret DMs: a
// one-time prekey is consumed on first decrypt, so that ciphertext can never be
// re-decrypted — only a saved plaintext copy brings the message back. The blob
// is stored server-side but is opaque to the server — only the holder of the
// secret can decrypt it, so E2EE is preserved.
// Security rests on secret strength: the blob is offline-guessable (the server
// hands it to any authenticated holder and can't rate-limit decryption), so the
// keyspace is the only defense. An alphanumeric passphrase is strongest; a
// numbers-only PIN trades security for memorability — we require ≥8 digits and
// a hardened (600k) PBKDF2 work factor to claw back some margin, but a PIN is
// still meaningfully weaker than a passphrase (see the UI warning).
//
// The blob carries its own `iters`, so decryption is forward/backward
// compatible: older blobs decrypt at whatever count they were written with.

"use client";

import {
  cryptoAvailable,
  exportKeys,
  importKeys,
  storageKeyGet,
  storageKeyPut,
  type KeyExport,
} from "./identity";
import { importMessages, type BackupMessageRow } from "@/lib/message-db";
import type { HistoryRowWire } from "@/lib/socket-events";

// OWASP-recommended PBKDF2-SHA256 work factor (2023+). Higher than the original
// 210k to slow offline guessing of short numeric PINs.
const PBKDF2_ITERS = 600_000;
const te = new TextEncoder();
const td = new TextDecoder();

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** The opaque blob stored server-side. Carries its own KDF params. */
export type BackupBlob = {
  v: 1 | 2 | 3;
  kdf: "PBKDF2-SHA256";
  iters: number;
  salt: string;
  iv: string;
  ct: string;
};

/**
 * The decrypted payload. v3 wraps keys only (incl. the storage key `keys.sk`) —
 * message history lives in the server-side encrypted history store, fetched
 * separately on restore. v2 additionally embedded message rows; v1 blobs stored
 * a bare `KeyExport` and are normalized to `{ keys }` on read. All three
 * versions keep restoring with no migration.
 */
export type BackupData = { keys: KeyExport; messages?: BackupMessageRow[] };

// PBKDF2 → 256 raw bits. Split out from key import so the same derivation can
// feed both the AES key and the unlock proof (computeKcv) — the bit output is
// identical to the previous direct deriveKey call, so ALL existing blobs keep
// decrypting.
async function deriveBits(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iters: number,
): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey(
    "raw",
    te.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" },
    base,
    256,
  );
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iters: number,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    await deriveBits(passphrase, salt, iters),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Key-check value: the PIN-derived proof a client presents to `backup:unlock`.
 * SHA-256 over a domain-separation tag + the PBKDF2 bits, so it can't be used
 * as the AES key. The server stores it at backup:put and compares (with a
 * guess counter + lockout) before releasing the blob — turning PIN guessing
 * from offline-at-GPU-speed into rate-limited online attempts for anyone who
 * merely holds an authenticated session. (A full DB compromise can still guess
 * offline against the stored ct — the HSM/passkey tier is the answer there.)
 */
export async function computeKcv(
  passphrase: string,
  saltB64: string,
  iters: number,
): Promise<string> {
  const bits = new Uint8Array(await deriveBits(passphrase, fromB64(saltB64), iters));
  const tag = te.encode("chat-backup-kcv:");
  const input = new Uint8Array(tag.length + bits.length);
  input.set(tag);
  input.set(bits, tag.length);
  return toB64(await crypto.subtle.digest("SHA-256", input));
}

export async function encryptBackup(
  passphrase: string,
  data: BackupData,
): Promise<BackupBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERS);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(JSON.stringify(data)),
  );
  return {
    v: 3,
    kdf: "PBKDF2-SHA256",
    iters: PBKDF2_ITERS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

/** Throws on a wrong passphrase (AES-GCM auth failure). */
export async function decryptBackup(
  passphrase: string,
  blob: BackupBlob,
): Promise<BackupData> {
  const key = await deriveKey(passphrase, fromB64(blob.salt), blob.iters);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(blob.iv) },
      key,
      fromB64(blob.ct),
    );
  } catch {
    throw new Error("Incorrect PIN");
  }
  const obj = JSON.parse(td.decode(pt)) as unknown;
  // v2 payloads are `{ keys, messages }`; a v1 blob held a bare KeyExport (which
  // has no `keys` field), so normalize it to the wrapper — keys only, no history.
  if (obj && typeof obj === "object" && "keys" in obj) return obj as BackupData;
  return { keys: obj as KeyExport };
}

/**
 * Snapshot + encrypt this user's keys (v3: identity + groups + storage key —
 * message history lives in the server-side history store, not the blob). Null
 * if there are no keys to back up yet. Ensures a storage key exists first so
 * every uploaded blob can unlock the history store.
 */
export async function buildBackup(
  userId: string,
  passphrase: string,
): Promise<BackupBlob | null> {
  await ensureStorageKey(userId);
  const keys = await exportKeys(userId);
  if (!keys) return null;
  return encryptBackup(passphrase, { keys });
}

/**
 * Decrypt + import a backup: restores this user's identity + groups (+ storage
 * key on v3 — the caller then pulls history from the server store). Legacy v2
 * blobs carried message rows inline; upsert them so those backups keep working.
 */
export async function restoreBackup(
  userId: string,
  passphrase: string,
  blob: BackupBlob,
): Promise<void> {
  const data = await decryptBackup(passphrase, blob);
  await importKeys(userId, data.keys);
  if (data.messages?.length) await importMessages(data.messages);
}

// --- storage key + history-row crypto ---------------------------------------
// Continuous encrypted history (the Messenger "secure storage" model): every
// decrypted message row is re-encrypted under a random per-user STORAGE KEY and
// appended to a server-side store, so any device that can unlock the backup
// (which carries the key) recovers the full history — including forward-secret
// DMs whose transport ciphertext is permanently dead. Transport encryption is
// untouched; this is a storage layer on top of it.

/** One encrypted history row as stored/relayed by the server (opaque to it). */
export type { HistoryRowWire };

/** Get this user's storage key, creating (and persisting) it on first use.
 *  Null when WebCrypto/IndexedDB is unavailable. */
export async function ensureStorageKey(userId: string): Promise<string | null> {
  if (!cryptoAvailable()) return null;
  const existing = await storageKeyGet(userId);
  if (existing) return existing;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const b64 = toB64(raw);
  await storageKeyPut(userId, b64);
  return b64;
}

// Imported AES key cache — the b64 is the cache key so a restored/changed
// storage key never serves stale material.
const skCache = new Map<string, CryptoKey>();
async function skAesKey(b64: string): Promise<CryptoKey> {
  const hit = skCache.get(b64);
  if (hit) return hit;
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64(b64),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  skCache.set(b64, key);
  return key;
}

/**
 * Encrypt one message row for the history store. Null when no storage key is
 * held on this device yet (rows flow once the user sets up their backup, or a
 * restore imports the key).
 */
export async function encryptHistoryRow(
  userId: string,
  row: BackupMessageRow,
): Promise<HistoryRowWire | null> {
  if (!cryptoAvailable()) return null;
  const b64 = await storageKeyGet(userId);
  if (!b64) return null;
  const key = await skAesKey(b64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(JSON.stringify(row)),
  );
  return { msgId: row.id, iv: toB64(iv), ct: toB64(ct) };
}

/**
 * Decrypt fetched history rows back into message rows. Rows that fail to
 * decrypt (e.g. written under a storage key that was later regenerated) are
 * skipped rather than failing the whole restore.
 */
export async function decryptHistoryRows(
  userId: string,
  rows: HistoryRowWire[],
): Promise<BackupMessageRow[]> {
  if (!cryptoAvailable() || !rows.length) return [];
  const b64 = await storageKeyGet(userId);
  if (!b64) return [];
  const key = await skAesKey(b64);
  const out: BackupMessageRow[] = [];
  for (const r of rows) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(r.iv) },
        key,
        fromB64(r.ct),
      );
      out.push(JSON.parse(td.decode(pt)) as BackupMessageRow);
    } catch {
      // undecryptable row — skip
    }
  }
  return out;
}
