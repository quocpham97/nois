// Group-group encryption via sender keys (Phase 2 of the E2EE plan).
//
// This is the scheme Signal and WhatsApp use for groups: instead of encrypting
// every message once per recipient (O(N) per message), each sender device holds
// a single symmetric "sender key" — a chain key it ratchets forward per message
// — and encrypts each message once under it. The chain key is distributed to
// every other member device ONCE (and on rotation) using the Phase 1 pairwise
// envelope (crypto/session.ts), so distribution is O(N) but only on membership
// change, not per message.
//
// Ratchet (Signal symmetric-key ratchet, HKDF variant):
//   messageKey   = HKDF(chainKey, "msg")   → AES-GCM key for this message
//   nextChainKey = HKDF(chainKey, "chain") → replaces the chain key
// The SENDER ratchets per message (each message uses a distinct key derived
// from the chain at its index).
//
// DISTRIBUTION POLICY (chosen for this app — reliability over secrecy): a
// sender keeps ONE stable seed (index 0) per group and distributes THAT seed
// to every member device, re-distributing on membership change and on demand
// when a member can't decrypt (pull-on-miss; see chat-context). A recipient
// therefore decrypts every message from a sender by ratcheting a copy forward
// from the seed to the message index WITHOUT advancing its stored state
// (decryptGroupMessage) — so decryption is order-independent, survives reloads,
// and a key fetched late recovers the sender's whole history.
//
// TRADE-OFF (deliberate): this drops forward secrecy and removed-member
// backward secrecy within a group — anyone who ever holds a sender's seed can
// read all of that sender's messages in that group. The forward-secret
// variant (rotate + discard + skipped-key cache) and MLS/TreeKEM (O(log N)
// membership) remain droppable behind this same interface later.

"use client";

import { decodeContent, encodeContent } from "./content";
import type { MessageContent } from "./types";

const HKDF_SALT = new Uint8Array(0);

/** A sender-key ratchet position: the current chain key + its message index. */
export type SenderKeyState = {
  chainKey: Uint8Array<ArrayBuffer>;
  index: number;
};

/** Serializable form for IndexedDB persistence and pairwise distribution. */
export type SenderKeyWire = { chainKey: string; index: number };

/** The opaque envelope stored in a group message's `enc` field. */
export type GroupEnvelope = {
  t: "grp";
  /** Sender device id — identifies which sender-key chain to use. */
  s: string;
  /** Message index within the sender's chain (for ratchet catch-up). */
  i: number;
  iv: string;
  ct: string;
};

/** Distribution payload (carried as plaintext inside a Phase 1 pairwise envelope). */
export type SenderKeyDistribution = {
  skd: 1;
  groupId: string;
  sender: string;
  chainKey: string;
  index: number;
};

// --- base64 ----------------------------------------------------------------

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function serializeState(s: SenderKeyState): SenderKeyWire {
  return { chainKey: toB64(s.chainKey), index: s.index };
}

export function deserializeState(w: SenderKeyWire): SenderKeyState {
  return { chainKey: fromB64(w.chainKey), index: w.index };
}

// --- ratchet ---------------------------------------------------------------

async function hkdf(
  chainKey: Uint8Array<ArrayBuffer>,
  info: string,
  bytes: number,
): Promise<ArrayBuffer> {
  const hk = await crypto.subtle.importKey("raw", chainKey, "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: new TextEncoder().encode(info),
    },
    hk,
    bytes * 8,
  );
}

async function nextChainKey(
  chainKey: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await hkdf(chainKey, "sender-chain", 32));
}

async function messageKey(chainKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const raw = await hkdf(chainKey, "sender-msg", 32);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// --- public API ------------------------------------------------------------

/** Generate a fresh sender key (random 32-byte chain key at index 0). */
export function generateSenderKey(): SenderKeyState {
  return { chainKey: crypto.getRandomValues(new Uint8Array(32)), index: 0 };
}

/**
 * Encrypt one group message under the sender's current chain key, returning the
 * envelope and the ADVANCED state (chain ratcheted forward, index incremented).
 * The caller must persist the returned state for the next message.
 */
export async function encryptGroupMessage(
  state: SenderKeyState,
  senderDeviceId: string,
  content: MessageContent,
): Promise<{ env: GroupEnvelope; next: SenderKeyState }> {
  const key = await messageKey(state.chainKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encodeContent(content),
  );
  const env: GroupEnvelope = {
    t: "grp",
    s: senderDeviceId,
    i: state.index,
    iv: toB64(iv),
    ct: toB64(ct),
  };
  const next: SenderKeyState = {
    chainKey: await nextChainKey(state.chainKey),
    index: state.index + 1,
  };
  return { env, next };
}

/**
 * Decrypt a group message using the stored sender-key SEED for its sender. The
 * stored `state` is a stable seed (see the distribution policy in
 * chat-context): we ratchet a COPY forward from the seed's index to the
 * message's index and decrypt, WITHOUT advancing or discarding the stored
 * state. That makes decryption order-independent and repeatable — messages
 * decrypt no matter what order they arrive in, and stay decryptable across
 * reloads and re-fetches. Returns the plaintext plus the (unchanged) state to
 * persist, or null on auth failure / a seed newer than the message.
 */
export async function decryptGroupMessage(
  state: SenderKeyState,
  env: GroupEnvelope,
): Promise<(MessageContent & { next: SenderKeyState }) | null> {
  if (env.i < state.index) return null; // seed is past this message (shouldn't happen for an index-0 seed)
  let chainKey = state.chainKey;
  for (let idx = state.index; idx < env.i; idx++) {
    chainKey = await nextChainKey(chainKey);
  }
  try {
    const key = await messageKey(chainKey);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(env.iv) },
      key,
      fromB64(env.ct),
    );
    return {
      ...decodeContent(pt),
      next: state, // stable seed — never advanced, so order/reloads don't matter
    };
  } catch {
    return null;
  }
}
