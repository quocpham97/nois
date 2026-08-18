// MLS (RFC 9420) group encryption via ts-mls — the standards-based successor
// to the Phase 2 sender-keys scheme (crypto/group.ts). Pure TypeScript (no
// WASM), MIT-licensed, so it runs in the Next.js client with ordinary imports.
//
// This module is the protocol engine only: it exposes group lifecycle (create,
// add/remove via Commit + Welcome, process), application-message encrypt/
// decrypt, and ClientState (de)serialization for persistence. Everything that
// crosses the network is wire-encoded to an MLSMessage (base64) — the server
// relays these opaquely, exactly like the sender-keys envelopes.
//
// MIGRATION NOTE: this implements the same conceptual surface as
// crypto/group.ts (a per-group group cipher) and is intended to replace it
// behind chat-context. The cutover swaps three things vs. sender keys:
//   * published key material: an MLS KeyPackage instead of prekeys (Phase 0)
//   * membership: a Commit + Welcome (relayed) instead of a sender-key rotation
//   * per message: an MLS application message instead of a sender-key ciphertext
// MLS gives O(log N) membership changes plus forward secrecy AND post-compromise
// security (the ratchet tree heals after a member updates), which sender keys
// do not.

"use client";

import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  decodeGroupState,
  defaultCryptoProvider,
  joinGroup,
  mlsExporter,
  processPrivateMessage,
  processMessage,
  type CiphersuiteImpl,
  type ClientState,
  type KeyPackage,
  type MLSMessage,
  type PrivateKeyPackage,
  type Proposal,
} from "ts-mls";
import { toLeafIndex } from "ts-mls/treemath.js";
import { defaultClientConfig } from "ts-mls/clientConfig.js";

import { decodeContent, encodeContent } from "./content";
import type { MessageContent } from "./types";

// One ciphersuite for the whole app. X25519 + AES-128-GCM + Ed25519 — the MLS
// mandatory-to-implement suite, supported by ts-mls's default WebCrypto/@hpke
// provider with no extra dependencies.
const CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

// One ts-mls client config for the whole app. It must be passed at BOTH ends of
// a state's life: clientConfig is not part of the serialized group state, so a
// state reloaded from IndexedDB reverts to ts-mls's defaults unless it is
// reattached (see mlsDeserializeState) — which silently undid any tuning here.
//
// keyRetentionConfig is the knob that decides which late messages still open:
//   * retainKeysForEpochs (4) — how many past epochs keep their receiver data.
//     A message from further back than this fails with "epoch too old", forever;
//     that is what a device offline across several membership commits hits.
//   * retainKeysForGenerations (10) — how many SKIPPED generations of a sender's
//     ratchet stay openable, for out-of-order delivery.
// Raising retainKeysForEpochs is not free: the historical receiver data holds a
// secret tree AND a ratchet tree per epoch, and the whole state is re-serialized
// into IndexedDB on every send and every decrypt. Measured serialized sizes:
//   epochs=4  → 13KB (5 members) / 48KB (20 members)
//   epochs=16 → 22KB (5 members) / 161KB (20 members)
//   epochs=32 → 57KB (5 members) / 270KB (20 members)
// So it trades a per-message write cost (and a longer window in which a stolen
// local state can open old traffic) for recovering late messages.
const clientConfig = defaultClientConfig;

let cipherSuiteImpl: Promise<CiphersuiteImpl> | null = null;
/** Resolve (and cache) the ciphersuite implementation. */
export function mlsCiphersuite(): Promise<CiphersuiteImpl> {
  return (cipherSuiteImpl ??= getCiphersuiteImpl(
    getCiphersuiteFromName(CIPHERSUITE),
    defaultCryptoProvider,
  ));
}

export type MlsKeyPair = {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
};

// --- base64 / wire ---------------------------------------------------------

function toB64(bytes: Uint8Array<ArrayBuffer>): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function encodeMessage(msg: MLSMessage): string {
  return toB64(encodeMlsMessage(msg) as Uint8Array<ArrayBuffer>);
}

function decodeMessage(b64: string): MLSMessage | null {
  return decodeMlsMessage(fromB64(b64), 0)?.[0] ?? null;
}

// --- identities --------------------------------------------------------------
// Every DEVICE is its own MLS leaf (multi-device users hold one leaf per
// device), so the credential identity is "<userId>#<deviceId>". Legacy states
// from the pre-multi-device wiring used the bare userId; parseIdentity
// tolerates both (missing deviceId decodes as "").

export function mlsIdentity(userId: string, deviceId: string): string {
  return `${userId}#${deviceId}`;
}

export function mlsParseIdentity(identity: string): {
  userId: string;
  deviceId: string;
} {
  const hash = identity.lastIndexOf("#");
  return hash === -1
    ? { userId: identity, deviceId: "" }
    : { userId: identity.slice(0, hash), deviceId: identity.slice(hash + 1) };
}

// --- key packages (published so others can add this device to a group) -----

/** Generate a fresh KeyPackage + its private keys for this device/user. */
export async function mlsGenerateKeyPackage(
  userId: string,
  deviceId: string,
): Promise<MlsKeyPair> {
  const cs = await mlsCiphersuite();
  const credential = {
    credentialType: "basic" as const,
    identity: new TextEncoder().encode(mlsIdentity(userId, deviceId)),
  };
  return generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);
}

// --- keypair persistence -----------------------------------------------------
// The KeyPackage keypair must OUTLIVE the session: a Welcome is sealed to the
// published KeyPackage, so if the private half only lived in memory, a device
// added while offline could never join. PrivateKeyPackage is three raw byte
// strings, so the pair serializes cleanly into the e2ee groups store. The
// default lifetime never expires, so one long-lived pair per device is fine
// (trade-off vs single-use packages: welcome-encryption keys aren't rotated —
// acceptable here, PCS still comes from commits).

export type StoredMlsKeyPair = {
  /** Wire-encoded public KeyPackage (same encoding as published). */
  pub: string;
  priv: { init: string; hpke: string; sig: string };
};

export function mlsExportKeyPair(kp: MlsKeyPair): StoredMlsKeyPair {
  return {
    pub: mlsEncodeKeyPackage(kp.publicPackage),
    priv: {
      init: toB64(kp.privatePackage.initPrivateKey as Uint8Array<ArrayBuffer>),
      hpke: toB64(kp.privatePackage.hpkePrivateKey as Uint8Array<ArrayBuffer>),
      sig: toB64(kp.privatePackage.signaturePrivateKey as Uint8Array<ArrayBuffer>),
    },
  };
}

export function mlsImportKeyPair(stored: StoredMlsKeyPair): MlsKeyPair | null {
  const publicPackage = mlsDecodeKeyPackage(stored.pub);
  if (!publicPackage) return null;
  return {
    publicPackage,
    privatePackage: {
      initPrivateKey: fromB64(stored.priv.init),
      hpkePrivateKey: fromB64(stored.priv.hpke),
      signaturePrivateKey: fromB64(stored.priv.sig),
    },
  };
}

/** Wire-encode a public KeyPackage for publishing to the key directory. */
export function mlsEncodeKeyPackage(keyPackage: KeyPackage): string {
  return encodeMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage });
}

/** Decode a published KeyPackage, or null if malformed / not a key package. */
export function mlsDecodeKeyPackage(b64: string): KeyPackage | null {
  const msg = decodeMessage(b64);
  return msg?.wireformat === "mls_key_package" ? msg.keyPackage : null;
}

// --- group lifecycle -------------------------------------------------------

/** Create a new MLS group for a group, with this device as the sole member. */
export async function mlsCreateGroup(
  groupId: string,
  kp: MlsKeyPair,
): Promise<ClientState> {
  const cs = await mlsCiphersuite();
  return createGroup(
    new TextEncoder().encode(groupId),
    kp.publicPackage,
    kp.privatePackage,
    [],
    cs,
    clientConfig,
  );
}

export type AddMemberResult = {
  state: ClientState;
  /** Relay to existing members so they apply the membership change. */
  commit: string;
  /** Deliver to the added member so they can join. */
  welcome: string;
};

/** Add a member by their published KeyPackage: returns the new state, the
 *  Commit (for existing members) and the Welcome (for the newcomer). */
export async function mlsAddMember(
  state: ClientState,
  memberKeyPackage: KeyPackage,
): Promise<AddMemberResult> {
  const cs = await mlsCiphersuite();
  const add: Proposal = {
    proposalType: "add",
    add: { keyPackage: memberKeyPackage },
  };
  const res = await createCommit(
    { state, cipherSuite: cs },
    { extraProposals: [add], ratchetTreeExtension: true },
  );
  if (!res.welcome) throw new Error("mls: add produced no welcome");
  return {
    state: res.newState,
    commit: encodeMessage(res.commit),
    welcome: encodeMessage({ version: "mls10", wireformat: "mls_welcome", welcome: res.welcome }),
  };
}

/** Add SEVERAL members in ONE commit (one epoch bump, one Welcome covering all
 *  of them) — used to establish a group with its whole initial membership. */
export async function mlsAddMembers(
  state: ClientState,
  memberKeyPackages: KeyPackage[],
): Promise<AddMemberResult> {
  const cs = await mlsCiphersuite();
  const extraProposals: Proposal[] = memberKeyPackages.map((keyPackage) => ({
    proposalType: "add",
    add: { keyPackage },
  }));
  const res = await createCommit(
    { state, cipherSuite: cs },
    { extraProposals, ratchetTreeExtension: true },
  );
  if (!res.welcome) throw new Error("mls: add produced no welcome");
  return {
    state: res.newState,
    commit: encodeMessage(res.commit),
    welcome: encodeMessage({ version: "mls10", wireformat: "mls_welcome", welcome: res.welcome }),
  };
}

/** Remove a member by leaf index: returns the new state and the Commit to relay. */
export async function mlsRemoveMember(
  state: ClientState,
  leafIndex: number,
): Promise<{ state: ClientState; commit: string }> {
  const cs = await mlsCiphersuite();
  const remove: Proposal = {
    proposalType: "remove",
    remove: { removed: toLeafIndex(leafIndex) },
  };
  const res = await createCommit(
    { state, cipherSuite: cs },
    { extraProposals: [remove], ratchetTreeExtension: true },
  );
  return { state: res.newState, commit: encodeMessage(res.commit) };
}

// --- membership inspection + roster sync -------------------------------------

export type MlsMemberInfo = {
  identity: string;
  userId: string;
  deviceId: string;
  leafIndex: number;
  /** b64 of the leaf's signature public key — a device that reset its keys
   *  republishes a DIFFERENT one, which is how a stale leaf is detected. */
  sigKey: string;
};

/** The group's current members, one per leaf (leaves live at even node
 *  indexes of the ratchet tree; leafIndex = nodeIndex / 2). */
export function mlsGroupMembers(state: ClientState): MlsMemberInfo[] {
  const out: MlsMemberInfo[] = [];
  for (let i = 0; i < state.ratchetTree.length; i += 2) {
    const node = state.ratchetTree[i];
    if (!node || node.nodeType !== "leaf") continue;
    const cred = node.leaf.credential;
    if (cred.credentialType !== "basic") continue;
    const identity = new TextDecoder().decode(cred.identity);
    out.push({
      identity,
      ...mlsParseIdentity(identity),
      leafIndex: i / 2,
      sigKey: toB64(node.leaf.signaturePublicKey as Uint8Array<ArrayBuffer>),
    });
  }
  return out;
}

/** The signature public key a KeyPackage's leaf would carry (for comparing a
 *  published package against an existing leaf of the same identity). This is
 *  also what MLS itself uses to decide whether two KeyPackages represent the
 *  SAME client — a commit carrying two Adds with one signature key is invalid
 *  (RFC 9420 §12.2), so callers must dedupe on it before proposing. */
export function mlsKeyPackageSigKey(kp: KeyPackage): string {
  return toB64(kp.leafNode.signaturePublicKey as Uint8Array<ArrayBuffer>);
}

/** The credential identity ("<userId>#<deviceId>") a KeyPackage claims, or null
 *  when it carries a credential type we don't issue. A published package whose
 *  identity disagrees with the directory row it was filed under is stale. */
export function mlsKeyPackageIdentity(kp: KeyPackage): string | null {
  const cred = kp.leafNode.credential;
  if (cred.credentialType !== "basic") return null;
  return new TextDecoder().decode(cred.identity);
}

/** Current epoch of a group state (what a commit must be submitted against). */
export function mlsEpoch(state: ClientState): number {
  return Number(state.groupContext.epoch);
}

/**
 * RFC 9420 §8.5 exporter: derive key material for a protocol OUTSIDE MLS from
 * the group's current epoch secret.
 *
 * This is what lets call media be end-to-end encrypted through an SFU without
 * inventing a key-agreement protocol: every member at the same epoch derives
 * the same bytes with no extra round trip, and a member removed from the group
 * can't derive the next epoch's. Reading it does NOT advance any ratchet (it's
 * a pure derivation from `keySchedule.exporterSecret`), so unlike encrypt and
 * decrypt this needs no lock — and epoch and secret come from one state
 * snapshot, so they always describe each other.
 */
export async function mlsExportSecret(
  state: ClientState,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const cs = await mlsCiphersuite();
  return mlsExporter(state.keySchedule.exporterSecret, label, context, length, cs);
}

export type SyncCommitResult = {
  state: ClientState;
  commit: string;
  /** Present only when members were added. */
  welcome?: string;
};

/** Build ONE commit that applies a membership diff: remove the given leaves
 *  (departed users / reset devices) and add the given KeyPackages. Returns
 *  null when there is nothing to change. */
export async function mlsSyncCommit(
  state: ClientState,
  addKeyPackages: KeyPackage[],
  removeLeafIndexes: number[],
): Promise<SyncCommitResult | null> {
  if (!addKeyPackages.length && !removeLeafIndexes.length) return null;
  const cs = await mlsCiphersuite();
  const extraProposals: Proposal[] = [
    ...removeLeafIndexes.map(
      (i): Proposal => ({ proposalType: "remove", remove: { removed: toLeafIndex(i) } }),
    ),
    ...addKeyPackages.map(
      (keyPackage): Proposal => ({ proposalType: "add", add: { keyPackage } }),
    ),
  ];
  const res = await createCommit(
    { state, cipherSuite: cs },
    { extraProposals, ratchetTreeExtension: true },
  );
  if (addKeyPackages.length && !res.welcome) throw new Error("mls: add produced no welcome");
  return {
    state: res.newState,
    commit: encodeMessage(res.commit),
    welcome: res.welcome
      ? encodeMessage({ version: "mls10", wireformat: "mls_welcome", welcome: res.welcome })
      : undefined,
  };
}

/** Join a group from a Welcome (wire-encoded), using this device's KeyPackage. */
export async function mlsJoinFromWelcome(
  welcomeB64: string,
  kp: MlsKeyPair,
): Promise<ClientState> {
  const cs = await mlsCiphersuite();
  const msg = decodeMessage(welcomeB64);
  if (msg?.wireformat !== "mls_welcome") throw new Error("mls: not a welcome");
  return joinGroup(
    msg.welcome,
    kp.publicPackage,
    kp.privatePackage,
    emptyPskIndex,
    cs,
    undefined, // ratchetTree — carried by the Welcome's extension
    undefined, // resumingFromState — not a reinit/branch
    clientConfig,
  );
}

/** Apply a relayed Commit (membership change) to an existing member's state. */
export async function mlsProcessCommit(
  state: ClientState,
  commitB64: string,
): Promise<ClientState> {
  const cs = await mlsCiphersuite();
  const msg = decodeMessage(commitB64);
  if (!msg) throw new Error("mls: undecodable commit");
  const res = await processMessage(
    msg as Extract<MLSMessage, { wireformat: "mls_private_message" | "mls_public_message" }>,
    state,
    emptyPskIndex,
    acceptAll,
    cs,
  );
  return res.newState;
}

// --- application messages --------------------------------------------------

/** Encrypt a chat message; returns the new state and the wire-encoded MLSMessage. */
export async function mlsEncrypt(
  state: ClientState,
  content: MessageContent,
): Promise<{ state: ClientState; wire: string }> {
  const cs = await mlsCiphersuite();
  const res = await createApplicationMessage(state, encodeContent(content), cs);
  return {
    state: res.newState,
    wire: encodeMessage({
      version: "mls10",
      wireformat: "mls_private_message",
      privateMessage: res.privateMessage,
    }),
  };
}

/**
 * True when a decrypt failure can NEVER succeed for this envelope, because the
 * key material it needs is gone rather than merely absent for now:
 *   * "epoch too old" — the message's epoch fell out of historicalReceiverData
 *     (retainKeysForEpochs), or we joined after it and never had that epoch
 *   * "Desired gen in the past" — that generation's key was consumed (a
 *     ratchet only moves forward) or evicted past retainKeysForGenerations
 * Everything else — a message from an epoch AHEAD of ours, a state we haven't
 * loaded yet — is worth retrying once the missing piece arrives.
 *
 * ts-mls raises both as a bare ValidationError with no machine-readable code,
 * so the message text is the only signal available; matching it is deliberate.
 */
export function mlsUnrecoverable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("epoch too old") || msg.includes("Desired gen in the past");
}

export type MlsDecryptResult =
  | ({ kind: "application"; state: ClientState } & MessageContent)
  | { kind: "control"; state: ClientState };

/**
 * Decrypt/process an inbound wire message. An application message yields the
 * plaintext; a handshake (commit/proposal) advances the state only. Returns
 * null if the message can't be decoded or processed.
 */
export async function mlsDecrypt(
  state: ClientState,
  wireB64: string,
): Promise<MlsDecryptResult | null> {
  const cs = await mlsCiphersuite();
  const msg = decodeMessage(wireB64);
  if (msg?.wireformat !== "mls_private_message") return null;
  const res = await processPrivateMessage(state, msg.privateMessage, emptyPskIndex, cs, acceptAll);
  if (res.kind === "applicationMessage") {
    return {
      kind: "application",
      state: res.newState,
      ...decodeContent(res.message),
    };
  }
  return { kind: "control", state: res.newState };
}

// --- persistence (IndexedDB-friendly base64 of the group state) ------------

/** Serialize a ClientState for storage (group state; config is reattached on load). */
export function mlsSerializeState(state: ClientState): string {
  return toB64(encodeGroupState(state) as Uint8Array<ArrayBuffer>);
}

/** Restore a ClientState previously serialized with mlsSerializeState. */
export function mlsDeserializeState(b64: string): ClientState {
  const decoded = decodeGroupState(fromB64(b64), 0);
  if (!decoded) throw new Error("mls: undecodable group state");
  return { ...decoded[0], clientConfig };
}
