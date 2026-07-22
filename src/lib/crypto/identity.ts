// Per-device cryptographic identity (Phase 0 of the E2EE plan).
//
// Generates and persists this browser's long-term identity keypair and its
// prekeys, entirely client-side. Private keys are stored in IndexedDB as
// NON-EXTRACTABLE CryptoKeys — they can be used to sign/derive but their bytes
// can never be read back out (not by us, not by injected script), and they
// never touch the network. Only public material (see DeviceKeyBundle) is ever
// published to the server.
//
// Crypto choices: ECDSA P-256 for the identity (sign/verify) and ECDH P-256
// for prekeys (key agreement). P-256 is chosen for universal SubtleCrypto
// support across browsers and Node. This is the protocol-agnostic substrate
// both Signal and MLS build on; the message-encryption layer is a later phase.

"use client";

import type { DeviceKeyBundle, PublicPreKey, SignedPreKey } from "./types";

// Keys are scoped PER USER, not per browser: each signed-in account gets its
// own IndexedDB (`e2ee:<userId>`) holding its own device identity + group
// secrets. Without this, two users sharing one browser profile would collide on
// a single shared "device" record — the second to sign in would inherit the
// first's private keys. The userId is the auth session's uid (the user's email).
const DB_PREFIX = "e2ee";
const dbName = (userId: string) => `${DB_PREFIX}:${userId}`;
const DB_VERSION = 3;
const STORE = "identity";
const GROUP_STORE = "groups";
// v3: trust-on-first-use pins of peer device identity keys (crypto/pinning.ts).
const PIN_STORE = "pins";
const ONE_TIME_PREKEY_COUNT = 20;
// Refill the one-time prekey pool once it drops to this many, so a device that
// has consumed most of its prekeys keeps offering fresh ones (sustained forward
// secrecy past the initial batch). See `replenishOneTimePreKeys`.
const OPK_LOW_WATERMARK = 10;

const ID_CURVE = { name: "ECDSA", namedCurve: "P-256" } as const;
const ID_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const ECDH_CURVE = { name: "ECDH", namedCurve: "P-256" } as const;

/** Public identity + the device id, ready to publish and to display for verification. */
export type DeviceIdentity = {
  deviceId: string;
  /** Human-comparable safety number derived from the identity public key. */
  fingerprint: string;
  /** Public key material to publish to the server. */
  bundle: DeviceKeyBundle;
};

/**
 * This device's private keys, for the message layer (crypto/session.ts). The
 * keys are non-extractable CryptoKeys — usable for sign / ECDH-deriveBits but
 * their bytes can never be read out. Never serialize this object.
 */
export type DeviceSecrets = {
  deviceId: string;
  /** ECDSA P-256 private key — signs outgoing message envelopes. */
  identityPriv: CryptoKey;
  /** ECDSA P-256 public key — its SPKI is embedded so peers can verify our sig. */
  identityPub: CryptoKey;
  /** This device's signed prekey: id + ECDH P-256 private key for key agreement. */
  signedPreKey: { id: string; priv: CryptoKey };
  /**
   * This device's unused one-time prekey privates (ECDH P-256), by id. A sealed
   * envelope that claimed one of these mixes its DH into the key, so consuming
   * (deleting) it after decrypt gives that message forward secrecy. See
   * `consumeOneTimePreKey`.
   */
  oneTimePreKeys: { id: string; priv: CryptoKey }[];
};

// What we persist per device. CryptoKeyPairs survive IndexedDB's structured
// clone with their non-extractable private keys intact.
type StoredPreKey = { id: string; keyPair: CryptoKeyPair };
type StoredSignedPreKey = StoredPreKey & { sig: ArrayBuffer };
type Persisted = {
  deviceId: string;
  identity: CryptoKeyPair;
  signedPreKey: StoredSignedPreKey;
  oneTimePreKeys: StoredPreKey[];
};

/** True when the runtime can do the WebCrypto we need (browser/secure context). */
export function cryptoAvailable(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    !!crypto.subtle
  );
}

// --- IndexedDB plumbing (tiny promisified wrapper) -------------------------

function openDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(userId), DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
      // v2: per-channel sender-key chains for group encryption (crypto/group.ts).
      if (!req.result.objectStoreNames.contains(GROUP_STORE)) {
        req.result.createObjectStore(GROUP_STORE);
      }
      // v3: TOFU pins of peer device identity keys (crypto/pinning.ts). Additive
      // only — never drop STORE/GROUP_STORE or existing devices lose their keys.
      if (!req.result.objectStoreNames.contains(PIN_STORE)) {
        req.result.createObjectStore(PIN_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(
  db: IDBDatabase,
  store: string,
  key: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(
  db: IDBDatabase,
  store: string,
  key: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Read/write small serializable values in the group-keys store (sender-key
 * chains, distribution sets). Values must be structured-clone-safe plain data.
 */
export async function groupGet<T>(
  userId: string,
  key: string,
): Promise<T | undefined> {
  if (!cryptoAvailable()) return undefined;
  return idbGet<T>(await openDb(userId), GROUP_STORE, key);
}

export async function groupPut(
  userId: string,
  key: string,
  value: unknown,
): Promise<void> {
  if (!cryptoAvailable()) return;
  await idbPut(await openDb(userId), GROUP_STORE, key, value);
}

// --- storage key (continuous encrypted history) ------------------------------
// A random per-USER AES-256 key (base64 raw bytes) under which decrypted
// message rows are re-encrypted for the server-side history store
// (crypto/backup.ts). Unlike the transport keys it never rotates and is shared
// across the user's devices via the encrypted backup, so any device holding it
// can read the whole history store. Kept in the identity store but exported
// separately so recovery paths can move it without touching the device identity.
const STORAGE_KEY_KEY = "storage-key";

export async function storageKeyGet(userId: string): Promise<string | undefined> {
  if (!cryptoAvailable()) return undefined;
  return idbGet<string>(await openDb(userId), STORE, STORAGE_KEY_KEY);
}

export async function storageKeyPut(userId: string, b64: string): Promise<void> {
  if (!cryptoAvailable()) return;
  await idbPut(await openDb(userId), STORE, STORAGE_KEY_KEY, b64);
}

/**
 * Read/write/enumerate TOFU pins of peer device identity keys (crypto/pinning.ts).
 * Stored in the viewer's own per-user DB, keyed by the peer's identity.
 */
export async function pinGet<T>(
  userId: string,
  key: string,
): Promise<T | undefined> {
  if (!cryptoAvailable()) return undefined;
  return idbGet<T>(await openDb(userId), PIN_STORE, key);
}

export async function pinPut(
  userId: string,
  key: string,
  value: unknown,
): Promise<void> {
  if (!cryptoAvailable()) return;
  await idbPut(await openDb(userId), PIN_STORE, key, value);
}

/** Every pinned peer record — for the per-contact list in Settings → Security. */
export async function pinGetAll<T>(userId: string): Promise<T[]> {
  if (!cryptoAvailable()) return [];
  const db = await openDb(userId);
  return new Promise((resolve, reject) => {
    const req = db.transaction(PIN_STORE, "readonly").objectStore(PIN_STORE).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

// --- base64 / fingerprint helpers ------------------------------------------

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function exportPub(key: CryptoKey, format: "raw" | "spki"): Promise<string> {
  return toB64(await crypto.subtle.exportKey(format, key));
}

async function exportPriv(key: CryptoKey): Promise<string> {
  return toB64(await crypto.subtle.exportKey("pkcs8", key));
}

/** Render a SHA-256 digest of an identity key's SPKI as a grouped safety number. */
function fingerprintFromSpki(spki: BufferSource): Promise<string> {
  return crypto.subtle.digest("SHA-256", spki).then((d) => {
    const digest = new Uint8Array(d);
    let out = "";
    // 30 digits, grouped in fives — derived from the first 15 hash bytes.
    for (let i = 0; i < 15; i++) {
      out += (digest[i] % 100).toString().padStart(2, "0");
    }
    return out.match(/.{1,5}/g)!.join(" ");
  });
}

/**
 * A Signal-style "safety number": SHA-256 of the identity public key, rendered
 * as grouped decimal digits two parties can read aloud to confirm they hold
 * each other's real key (defeats a server that swaps keys for a MITM).
 */
export async function deriveFingerprint(identityPub: CryptoKey): Promise<string> {
  return fingerprintFromSpki(await crypto.subtle.exportKey("spki", identityPub));
}

/**
 * Safety number for a peer's identity key given as base64 SPKI (the form
 * published in a DeviceKeyBundle and returned by decryptEnvelope's
 * `senderIdentity`). Used by the TOFU layer and the device-approval prompt.
 */
export function deriveFingerprintFromSpki(spkiB64: string): Promise<string> {
  return fingerprintFromSpki(fromB64(spkiB64));
}

// --- key generation ---------------------------------------------------------

// extractable=true so keys can be exported into an encrypted, passphrase-
// protected backup (see crypto/backup.ts). Trade-off: the private bytes can
// leave the device — only ever inside ciphertext the server can't read.
async function genIdentity(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ID_CURVE, true, ["sign", "verify"]);
}

async function genPreKey(identityPriv: CryptoKey, id: string): Promise<StoredSignedPreKey> {
  const keyPair = (await crypto.subtle.generateKey(ECDH_CURVE, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const rawPub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const sig = await crypto.subtle.sign(ID_SIGN, identityPriv, rawPub);
  return { id, keyPair, sig };
}

async function genOneTimePreKey(id: string): Promise<StoredPreKey> {
  const keyPair = (await crypto.subtle.generateKey(ECDH_CURVE, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return { id, keyPair };
}

// --- public API --------------------------------------------------------------

/**
 * Load this device's identity, creating and persisting it on first run. Returns
 * the device id, a verification fingerprint, and the publishable public bundle.
 * Idempotent: subsequent calls return the same persisted identity.
 */
export async function ensureDeviceIdentity(userId: string): Promise<DeviceIdentity> {
  if (!cryptoAvailable()) throw new Error("WebCrypto/IndexedDB unavailable");
  const db = await openDb(userId);

  let persisted = await idbGet<Persisted>(db, STORE, "device");
  if (!persisted) {
    const deviceId = crypto.randomUUID();
    const identity = await genIdentity();
    const signedPreKey = await genPreKey(identity.privateKey, crypto.randomUUID());
    const oneTimePreKeys: StoredPreKey[] = [];
    for (let i = 0; i < ONE_TIME_PREKEY_COUNT; i++) {
      oneTimePreKeys.push(await genOneTimePreKey(crypto.randomUUID()));
    }
    persisted = { deviceId, identity, signedPreKey, oneTimePreKeys };
    await idbPut(db, STORE, "device", persisted);
  }

  const signedPreKey: SignedPreKey = {
    id: persisted.signedPreKey.id,
    pub: await exportPub(persisted.signedPreKey.keyPair.publicKey, "raw"),
    sig: toB64(persisted.signedPreKey.sig),
  };
  const oneTimePreKeys: PublicPreKey[] = await Promise.all(
    persisted.oneTimePreKeys.map(async (pk) => ({
      id: pk.id,
      pub: await exportPub(pk.keyPair.publicKey, "raw"),
    })),
  );

  const bundle: DeviceKeyBundle = {
    userId,
    deviceId: persisted.deviceId,
    identityKey: await exportPub(persisted.identity.publicKey, "spki"),
    signedPreKey,
    oneTimePreKeys,
  };

  return {
    deviceId: persisted.deviceId,
    fingerprint: await deriveFingerprint(persisted.identity.publicKey),
    bundle,
  };
}

/**
 * Load this device's private key material for the message layer. Returns null
 * if no identity has been provisioned yet (call ensureDeviceIdentity first) or
 * WebCrypto is unavailable. The private CryptoKeys are non-extractable.
 */
export async function loadDeviceSecrets(
  userId: string,
): Promise<DeviceSecrets | null> {
  if (!cryptoAvailable()) return null;
  const db = await openDb(userId);
  const p = await idbGet<Persisted>(db, STORE, "device");
  if (!p) return null;
  return {
    deviceId: p.deviceId,
    identityPriv: p.identity.privateKey,
    identityPub: p.identity.publicKey,
    signedPreKey: { id: p.signedPreKey.id, priv: p.signedPreKey.keyPair.privateKey },
    oneTimePreKeys: p.oneTimePreKeys.map((pk) => ({
      id: pk.id,
      priv: pk.keyPair.privateKey,
    })),
  };
}

/**
 * Delete a one-time prekey from this user's device record once it has been used
 * to decrypt a message. Removing it means the message's session key can no
 * longer be re-derived from stored keys — the forward-secrecy guarantee the
 * one-time prekey provides. No-op if already gone.
 */
export async function consumeOneTimePreKey(
  userId: string,
  opkId: string,
): Promise<void> {
  if (!cryptoAvailable()) return;
  const db = await openDb(userId);
  const p = await idbGet<Persisted>(db, STORE, "device");
  if (!p) return;
  const remaining = p.oneTimePreKeys.filter((pk) => pk.id !== opkId);
  if (remaining.length === p.oneTimePreKeys.length) return; // not found
  await idbPut(db, STORE, "device", { ...p, oneTimePreKeys: remaining });
}

/**
 * Top the one-time prekey pool back up to ONE_TIME_PREKEY_COUNT once it has
 * drained to the low watermark (prekeys are consumed for forward secrecy, so
 * without this a device runs out and falls back to signed-prekey-only). Stores
 * the new private halves locally and returns the new PUBLIC prekeys so the
 * caller can publish them to the server. Returns [] when no refill is needed.
 */
export async function replenishOneTimePreKeys(
  userId: string,
): Promise<PublicPreKey[]> {
  if (!cryptoAvailable()) return [];
  const db = await openDb(userId);
  const p = await idbGet<Persisted>(db, STORE, "device");
  if (!p || p.oneTimePreKeys.length > OPK_LOW_WATERMARK) return [];
  const fresh: StoredPreKey[] = [];
  for (let i = p.oneTimePreKeys.length; i < ONE_TIME_PREKEY_COUNT; i++) {
    fresh.push(await genOneTimePreKey(crypto.randomUUID()));
  }
  await idbPut(db, STORE, "device", {
    ...p,
    oneTimePreKeys: [...p.oneTimePreKeys, ...fresh],
  });
  return Promise.all(
    fresh.map(async (pk) => ({
      id: pk.id,
      pub: await exportPub(pk.keyPair.publicKey, "raw"),
    })),
  );
}

/**
 * Verify that a fetched signed prekey was really signed by the claimed identity
 * key. A peer (or this client) should call this before trusting a bundle — it
 * is what stops the relay server from injecting its own prekey.
 */
export async function verifySignedPreKey(
  identityKeyB64: string,
  signedPreKey: SignedPreKey,
): Promise<boolean> {
  try {
    const spki = Uint8Array.from(atob(identityKeyB64), (c) => c.charCodeAt(0));
    const idKey = await crypto.subtle.importKey("spki", spki, ID_CURVE, false, [
      "verify",
    ]);
    const pub = Uint8Array.from(atob(signedPreKey.pub), (c) => c.charCodeAt(0));
    const sig = Uint8Array.from(atob(signedPreKey.sig), (c) => c.charCodeAt(0));
    return crypto.subtle.verify(ID_SIGN, idKey, sig, pub);
  } catch {
    return false;
  }
}

// --- backup / restore (see crypto/backup.ts) -------------------------------

/** Plain, JSON-serializable snapshot of all e2ee key material for backup. */
export type KeyExport = {
  deviceId: string;
  identity: { priv: string; pub: string };
  signedPreKey: { id: string; priv: string; pub: string; sig: string };
  oneTimePreKeys: { id: string; priv: string; pub: string }[];
  /** Group sender-key store entries (seed:/send:/recv:/dist:) verbatim. */
  groups: Record<string, unknown>;
  /** Storage key (b64 raw AES-256) for the server-side encrypted history store.
   *  Absent on exports from devices that predate continuous history. */
  sk?: string;
};

/**
 * Just the group sender-key material — the recoverable *history* keys without
 * the device identity. This is what device-to-device recovery (crypto/recovery.ts)
 * transfers to a new device that keeps its OWN freshly-provisioned identity, so
 * the two devices never share an identity keypair (see the plan's identity model).
 */
export type GroupExport = Pick<KeyExport, "groups">;

/**
 * Delete this user's entire key store (device identity + prekeys + group
 * seeds/chains) from IndexedDB. Used on sign-out so a shared machine doesn't
 * retain the private keys. After this, the next sign-in either restores from an
 * encrypted backup or provisions a brand-new identity — so old messages stay
 * readable ONLY if a backup exists. No-op if WebCrypto/IndexedDB is unavailable.
 */
export function clearDeviceIdentity(userId: string): Promise<void> {
  if (!cryptoAvailable()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName(userId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // Another open connection (e.g. a lingering tab) blocks deletion; resolve
    // anyway so sign-out isn't wedged — the DB is dropped once it closes.
    req.onblocked = () => resolve();
  });
}

/** True once a device identity has been provisioned locally for this user. */
export async function hasDeviceIdentity(userId: string): Promise<boolean> {
  if (!cryptoAvailable()) return false;
  return (
    (await idbGet<Persisted>(await openDb(userId), STORE, "device")) !== undefined
  );
}

/** Export every private key + group secret into a plain bundle (for encryption). */
export async function exportKeys(userId: string): Promise<KeyExport | null> {
  if (!cryptoAvailable()) return null;
  const db = await openDb(userId);
  const p = await idbGet<Persisted>(db, STORE, "device");
  if (!p) return null;
  const expPair = async (kp: CryptoKeyPair, pubFmt: "raw" | "spki") => ({
    priv: await exportPriv(kp.privateKey),
    pub: await exportPub(kp.publicKey, pubFmt),
  });
  // Dump the whole groups object store.
  const groups: Record<string, unknown> = await new Promise((resolve, reject) => {
    const tx = db.transaction(GROUP_STORE, "readonly").objectStore(GROUP_STORE);
    const keysReq = tx.getAllKeys();
    const valsReq = tx.getAll();
    tx.transaction.oncomplete = () => {
      const out: Record<string, unknown> = {};
      (keysReq.result as IDBValidKey[]).forEach((k, i) => {
        out[String(k)] = valsReq.result[i];
      });
      resolve(out);
    };
    tx.transaction.onerror = () => reject(tx.transaction.error);
  });
  const sk = await idbGet<string>(db, STORE, STORAGE_KEY_KEY);
  return {
    deviceId: p.deviceId,
    identity: await expPair(p.identity, "spki"),
    signedPreKey: {
      id: p.signedPreKey.id,
      ...(await expPair(p.signedPreKey.keyPair, "spki")),
      sig: toB64(p.signedPreKey.sig),
    },
    oneTimePreKeys: await Promise.all(
      p.oneTimePreKeys.map(async (pk) => ({
        id: pk.id,
        ...(await expPair(pk.keyPair, "spki")),
      })),
    ),
    groups,
    ...(sk ? { sk } : {}),
  };
}

/** Import a KeyExport into IndexedDB, replacing this user's identity + groups. */
export async function importKeys(userId: string, data: KeyExport): Promise<void> {
  if (!cryptoAvailable()) throw new Error("WebCrypto/IndexedDB unavailable");
  const db = await openDb(userId);
  const impPair = async (
    e: { priv: string; pub: string },
    curve: typeof ID_CURVE | typeof ECDH_CURVE,
    privUsage: KeyUsage[],
    pubUsage: KeyUsage[],
  ): Promise<CryptoKeyPair> => ({
    privateKey: await crypto.subtle.importKey("pkcs8", fromB64(e.priv), curve, true, privUsage),
    publicKey: await crypto.subtle.importKey("spki", fromB64(e.pub), curve, true, pubUsage),
  });
  const persisted: Persisted = {
    deviceId: data.deviceId,
    identity: await impPair(data.identity, ID_CURVE, ["sign"], ["verify"]),
    signedPreKey: {
      id: data.signedPreKey.id,
      keyPair: await impPair(data.signedPreKey, ECDH_CURVE, ["deriveBits"], []),
      sig: fromB64(data.signedPreKey.sig).buffer,
    },
    oneTimePreKeys: await Promise.all(
      data.oneTimePreKeys.map(async (pk) => ({
        id: pk.id,
        keyPair: await impPair(pk, ECDH_CURVE, ["deriveBits"], []),
      })),
    ),
  };
  await idbPut(db, STORE, "device", persisted);
  if (data.sk) await idbPut(db, STORE, STORAGE_KEY_KEY, data.sk);
  await importGroups(userId, data.groups);
}

/**
 * Merge group sender-key entries into this user's `groups` store WITHOUT touching
 * the device identity. Used by device-to-device recovery so the receiving device
 * gains history-decryption capability while keeping its own identity keypair.
 * Last-writer-wins per key, so re-importing the same material is idempotent.
 */
export async function importGroups(
  userId: string,
  groups: Record<string, unknown>,
): Promise<void> {
  if (!cryptoAvailable()) throw new Error("WebCrypto/IndexedDB unavailable");
  const db = await openDb(userId);
  for (const [k, v] of Object.entries(groups)) {
    await idbPut(db, GROUP_STORE, k, v);
  }
}
