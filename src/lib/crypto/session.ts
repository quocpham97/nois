// Message-layer encryption for 1:1 DMs (Phase 1 of the E2EE plan).
//
// Construction — a pragmatic "X3DH-lite" sealed envelope, NOT the full Signal
// Double Ratchet:
//   * The sender generates a fresh ephemeral ECDH keypair per message.
//   * For each recipient DEVICE it does ECDH(ephemeral_priv, device_signedPreKey_pub)
//     AND, when the device's bundle still has an unused one-time prekey,
//     ECDH(ephemeral_priv, device_oneTimePreKey_pub). Both shared secrets are
//     concatenated and run through HKDF-SHA256 → an AES-GCM key. "Encrypt once
//     per device" fan-out, so every device of both participants (incl. the
//     sender's own) can read it.
//   * Before trusting a device's prekey, the sender verifies its signature
//     against that device's identity key (see identity.verifySignedPreKey) —
//     this is what stops the relay server injecting its own prekey (MITM).
//   * The whole envelope is signed with the sender's ECDSA identity key, so a
//     recipient can confirm it was authored by the holder of that identity key
//     (defeats the server forging a message, since prekeys are public).
//
// FORWARD SECRECY: a message sealed to a one-time prekey gains per-message
// forward secrecy once the recipient deletes that prekey after decrypting (see
// identity.consumeOneTimePreKey): its session key can no longer be re-derived
// from stored keys, so a later compromise of the long-lived signed prekey does
// NOT expose it. The trade-off is recoverability — such a message can't be
// re-decrypted from the relayed ciphertext after the local plaintext cache is
// lost (the one-time key is gone). Group sender-key envelopes are unaffected in
// practice because the recv chain is persisted once derived.
//
// KNOWN LIMITATIONS (deliberately deferred):
//   * The server's one-time-prekey pool is not replenished, so after it is
//     exhausted (≈20 sessions/device) sends fall back to signed-prekey-ONLY —
//     no forward secrecy — until the device republishes fresh prekeys.
//   * No post-compromise security / no Double Ratchet (that is the MLS phase).
//   * Sender authenticity is verified against the identity key EMBEDDED in the
//     envelope. A client should additionally pin that key to the directory /
//     the verified safety number (Phase 0) to be sure of *who* the sender is.

"use client";

import { decodeContent, encodeContent } from "./content";
import type { DeviceSecrets } from "./identity";
import { verifySignedPreKey } from "./identity";
import type { MessageContent, PreKeyBundle } from "./types";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ID_VERIFY = { name: "ECDSA", namedCurve: "P-256" } as const;
const ID_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const HKDF_INFO = new TextEncoder().encode("chat-app-dm-v1");

/** A per-recipient-device encrypted copy of the message content. */
export type EnvelopeCopy = {
  deviceId: string;
  /** Which of the device's signed prekeys this was sealed to (id match required). */
  spkId: string;
  /** Which one-time prekey was mixed in (if any) — the recipient must hold it. */
  opkId?: string;
  iv: string;
  ct: string;
};

/** The opaque blob the server stores and relays (JSON-stringified on the wire). */
export type Envelope = {
  v: 1;
  alg: "ECDH-P256-AESGCM";
  /** Sender's ephemeral ECDH public key (raw, base64) for this message. */
  ek: string;
  /** Sender's identity public key (SPKI, base64) — verify `sig` against this. */
  senderIdentity: string;
  /** ECDSA signature (base64) over ek || each copy's ciphertext. */
  sig: string;
  copies: EnvelopeCopy[];
};

// --- base64 helpers ----------------------------------------------------------

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Concatenate the bytes that get signed: ephemeral pub then every ciphertext,
// so the signature binds the sender to this exact ephemeral key and content.
function signedBytes(
  ekRaw: Uint8Array<ArrayBuffer>,
  copies: EnvelopeCopy[],
): Uint8Array<ArrayBuffer> {
  const parts = [ekRaw, ...copies.map((c) => fromB64(c.ct))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// One ECDH(myPriv, theirRawPub) → 256 raw shared bits. ECDH is symmetric, so
// sender and recipient get the same bits from the opposite private/public pair.
async function dhBits(
  myPriv: CryptoKey,
  theirRawPub: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const theirPub = await crypto.subtle.importKey("raw", theirRawPub, ECDH, false, []);
  return crypto.subtle.deriveBits({ name: "ECDH", public: theirPub }, myPriv, 256);
}

// Concatenate the DH shared secrets (signed-prekey DH, then one-time-prekey DH
// if present) and run the result through HKDF → an AES-GCM key. Both sides must
// supply the DH outputs in the SAME order.
async function aesKeyFromSecrets(parts: ArrayBuffer[]): Promise<CryptoKey> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const ikm = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    ikm.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  const hk = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a message for every supplied recipient device. `targets` should
 * include all devices of BOTH participants (so the sender's own devices can
 * read it too). Devices whose signed prekey fails signature verification are
 * skipped. Returns null if no target could be encrypted to (caller should then
 * fall back to plaintext, e.g. when the peer has published no keys).
 */
export async function encryptForDevices(
  content: MessageContent,
  targets: PreKeyBundle[],
  secrets: DeviceSecrets,
  opts?: {
    /**
     * Skip mixing in the recipient's one-time prekey. This trades per-message
     * forward secrecy for REPEATABLE decryption: the envelope stays decryptable
     * from the long-lived signed prekey alone, so it can be replayed and
     * re-decrypted (the recipient never consumes/deletes a key). Used for read
     * receipts, which are ephemeral metadata replayed from the server on every
     * reconnect and so must not depend on a spent one-time prekey.
     */
    skipOneTimePreKey?: boolean;
  },
): Promise<Envelope | null> {
  if (!targets.length) return null;
  const eph = (await crypto.subtle.generateKey(ECDH, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const ekRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const contentBytes = encodeContent(content);

  const copies: EnvelopeCopy[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.deviceId)) continue;
    seen.add(t.deviceId);
    if (!(await verifySignedPreKey(t.identityKey, t.signedPreKey))) continue;
    // Always DH against the signed prekey; additionally DH against a one-time
    // prekey when the bundle still has one (→ forward secrecy for this message).
    const useOpk = !opts?.skipOneTimePreKey && t.oneTimePreKey;
    const dh = [await dhBits(eph.privateKey, fromB64(t.signedPreKey.pub))];
    if (useOpk) {
      dh.push(await dhBits(eph.privateKey, fromB64(t.oneTimePreKey!.pub)));
    }
    const key = await aesKeyFromSecrets(dh);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, contentBytes);
    copies.push({
      deviceId: t.deviceId,
      spkId: t.signedPreKey.id,
      ...(useOpk ? { opkId: t.oneTimePreKey!.id } : {}),
      iv: toB64(iv),
      ct: toB64(ct),
    });
  }
  if (!copies.length) return null;

  const sig = await crypto.subtle.sign(
    ID_SIGN,
    secrets.identityPriv,
    signedBytes(ekRaw, copies),
  );
  const senderIdentity = toB64(
    await crypto.subtle.exportKey("spki", secrets.identityPub),
  );
  return {
    v: 1,
    alg: "ECDH-P256-AESGCM",
    ek: toB64(ekRaw),
    senderIdentity,
    sig: toB64(sig),
    copies,
  };
}

async function verifyEnvelopeSignature(env: Envelope): Promise<boolean> {
  try {
    const idKey = await crypto.subtle.importKey(
      "spki",
      fromB64(env.senderIdentity),
      ID_VERIFY,
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      ID_SIGN,
      idKey,
      fromB64(env.sig),
      signedBytes(fromB64(env.ek), env.copies),
    );
  } catch {
    return false;
  }
}

/**
 * Decrypt an envelope for this device. Returns the plaintext + rich JSON, or
 * null if there is no copy for this device, the signed prekey has rotated, the
 * sender signature is invalid, or AES-GCM authentication fails.
 *
 * Also returns the sender's identity key (SPKI base64) so the caller can pin it
 * against the directory / verified safety number.
 */
export async function decryptEnvelope(
  env: Envelope,
  secrets: DeviceSecrets,
): Promise<
  | (MessageContent & {
      senderIdentity: string;
      /** The one-time prekey this message consumed (caller should delete it). */
      usedOpkId?: string;
    })
  | null
> {
  if (env.v !== 1 || env.alg !== "ECDH-P256-AESGCM") return null;
  const copy = env.copies.find((c) => c.deviceId === secrets.deviceId);
  if (!copy || copy.spkId !== secrets.signedPreKey.id) return null;
  if (!(await verifyEnvelopeSignature(env))) return null;
  // If this copy was sealed to a one-time prekey, we must still hold its private
  // half. If it's already been consumed (or never existed), we can't decrypt —
  // that's the forward-secrecy guarantee in action, not a recoverable error.
  let opk: { id: string; priv: CryptoKey } | undefined;
  if (copy.opkId) {
    opk = secrets.oneTimePreKeys.find((k) => k.id === copy.opkId);
    if (!opk) return null;
  }
  try {
    const dh = [await dhBits(secrets.signedPreKey.priv, fromB64(env.ek))];
    if (opk) dh.push(await dhBits(opk.priv, fromB64(env.ek)));
    const key = await aesKeyFromSecrets(dh);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(copy.iv) },
      key,
      fromB64(copy.ct),
    );
    return {
      ...decodeContent(pt),
      senderIdentity: env.senderIdentity,
      usedOpkId: copy.opkId,
    };
  } catch {
    return null;
  }
}
