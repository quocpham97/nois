// Wire types for the E2EE key-distribution layer (Phase 0).
//
// These describe ONLY public key material — private keys never appear here and
// never leave the device (they live in IndexedDB as non-extractable
// CryptoKeys; see crypto/identity.ts). This file has no DOM/Node dependencies
// so it can be imported by both the browser client and the Node server.
//
// The shape deliberately mirrors a Signal-style prekey bundle (identity key +
// a signed prekey + a pool of one-time prekeys). It is protocol-agnostic
// scaffolding: when the message layer later adopts MLS (e.g. via
// @wireapp/core-crypto), the published artifact becomes an MLS KeyPackage, but
// the publish/fetch transport and the device registry below are unchanged.

import type { LinkPreview, ReplyRef } from "../chat-data";

/**
 * The plaintext content sealed inside every E2EE envelope (DM pairwise, group
 * sender-key, and MLS — see crypto/content.ts for the shared codec). Absent
 * fields serialize as null; decoders pass unknown keys through, so ADDING an
 * optional field here is backward compatible: old envelopes simply lack it and
 * old clients ignore it. No version bump needed.
 */
export type MessageContent = {
  text: string;
  /** Lexical editor-state JSON for rich-text rendering. */
  rich?: string | null;
  /** AES-GCM key/iv of an encrypted attachment — they travel only in here. */
  att?: { key: string; iv: string } | null;
  /** Sender-generated link preview (never leaves the envelope). */
  preview?: LinkPreview | null;
  /** Quoted-reply reference (see chat-data ReplyRef) — travels E2EE so the
   *  server never learns which message a reply quotes. */
  replyTo?: ReplyRef | null;
  /** Marks a forwarded message so the recipient shows a "Forwarded" label. */
  forwarded?: boolean | null;
};

/** A bare ECDH public prekey: `pub` is the base64 of the raw P-256 public key. */
export type PublicPreKey = { id: string; pub: string };

/** A prekey signed by the device's long-term identity key (ECDSA P-256). */
export type SignedPreKey = PublicPreKey & {
  /** base64 ECDSA signature over the raw prekey bytes, by the identity key. */
  sig: string;
};

/**
 * Everything a device publishes to the server so others can start a session
 * with it asynchronously (while it is offline). Public material only.
 */
export type DeviceKeyBundle = {
  userId: string;
  deviceId: string;
  /** base64 SPKI of the long-term ECDSA P-256 identity public key. */
  identityKey: string;
  signedPreKey: SignedPreKey;
  oneTimePreKeys: PublicPreKey[];
};

/**
 * What a peer fetches to initiate a session with one device: the identity key,
 * the current signed prekey, and at most one (server-popped) one-time prekey.
 * `oneTimePreKey` is null once the device's pool is exhausted.
 */
export type PreKeyBundle = {
  userId: string;
  deviceId: string;
  identityKey: string;
  signedPreKey: SignedPreKey;
  oneTimePreKey: PublicPreKey | null;
};
