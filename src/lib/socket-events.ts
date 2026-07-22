// Shared WebSocket event contract — imported by both the server (server.ts)
// and the client (socket-context). Payload types reuse the domain types from
// chat-data so the wire format matches the in-app shapes.
//
// Phase A implements only the connection lifecycle + `echo` health check.
// The message/thread/reaction/presence/typing events below are the agreed
// contract for Phases B–D and are typed here up front so both ends compile
// against a single source of truth.

import type {
  Attachment,
  Channel,
  Message,
  User,
  UserProfile,
} from "./chat-data";
import type {
  DeviceKeyBundle,
  PreKeyBundle,
  PublicPreKey,
} from "./crypto/types";

/** Identity handed to the server in the connection handshake (mock for now). */
export type Handshake = {
  userId: string;
};

// ---------------------------------------------------------------------------
// Client → server payloads
// ---------------------------------------------------------------------------

export type EchoPayload = { t: number };

export type ChannelJoinPayload = { channelId: string };
export type ChannelLeavePayload = { channelId: string };

/** Request a page of older messages before the given cursor (a message seq). */
export type HistoryMorePayload = { channelId: string; beforeSeq: number };

/** Request a window of messages centred on a specific message (jump-to). */
export type HistoryAroundPayload = { channelId: string; msgId: string };

export type MessageSendPayload = {
  channelId: string;
  text: string;
  /** Client-generated id used to reconcile the optimistic message on ack. */
  clientId: string;
  /** Optional attachment metadata (no file bytes are transferred). */
  attachment?: Attachment;
  /** Optional Lexical editor-state JSON for rich-text rendering. */
  rich?: string;
  /** E2EE envelope (JSON). When present, `text`/`rich` are empty (ciphertext only). */
  enc?: string;
};

export type ThreadReplyPayload = {
  channelId: string;
  parentId: string;
  text: string;
  clientId: string;
  /** Optional Lexical editor-state JSON for rich-text rendering. */
  rich?: string;
};

export type ReactionTogglePayload = {
  channelId: string;
  msgId: string;
  emoji: string;
};

export type DmCreatePayload = {
  recipientId: string;
  text: string;
  clientId: string;
  /** E2EE envelope (JSON). When present, `text` is empty (ciphertext only). */
  enc?: string;
};

export type ChannelCreatePayload = {
  name: string;
  topic?: string;
  private?: boolean;
};

/** Ack for channel:create — carries the server-assigned id on success. */
export type ChannelCreateResult =
  | { ok: true; channelId: string }
  | { ok: false; error: string };

export type ChannelUpdatePayload = {
  channelId: string;
  name?: string;
  topic?: string;
};
export type ChannelDeletePayload = { channelId: string };
export type ChannelMemberPayload = { channelId: string; userId: string };

/** Generic ack for channel mutations. */
export type ChannelOpResult = { ok: true } | { ok: false; error: string };

export type TypingPayload = { channelId: string };

export type PinTogglePayload = { channelId: string; msgId: string };

// E2EE key distribution (Phase 0). Devices publish public key bundles and
// fetch peers' prekey bundles to bootstrap sessions. Public material only —
// the server never sees private keys or plaintext.
export type KeysPublishPayload = { bundle: DeviceKeyBundle };
export type KeysFetchPayload = { userId: string };
export type KeysFetchResult = { bundles: PreKeyBundle[] };
/** Append fresh one-time prekeys to this device's pool (replenishment). */
export type KeysSupplementPayload = {
  deviceId: string;
  oneTimePreKeys: PublicPreKey[];
};

// Group (sender-keys) key distribution. `keys:fetchChannel` returns the prekey
// bundles of every device of every member of a channel (so a sender can wrap
// its sender key for each). `group:senderKey` relays a sender-key distribution
// — a pairwise-encrypted envelope (opaque to the server) — to the room.
export type KeysFetchChannelPayload = { channelId: string };
export type GroupSenderKeyPayload = {
  channelId: string;
  /** The distributing device's id, so the server can persist one env per
   *  sender device for offline replay. Not secret (it's in the key directory). */
  sender: string;
  env: string;
};
export type GroupSenderKeyRelay = {
  channelId: string;
  /** Sender userId, so recipients can route/verify; the env stays opaque. */
  fromUserId: string;
  env: string;
};
// Pull-on-miss: a member that can't decrypt a message asks the sender device to
// re-distribute its sender key. `sender` is the sender's deviceId (from the
// undecryptable envelope). The server relays it to the channel's members; only
// the matching sender device responds (with a fresh `group:senderKey`).

// E2EE read receipts (Phase 2). A receipt is a per-channel READ CURSOR
// ("I've seen up to seq N"), sealed with the same envelope crypto as messages
// (group sender-key / DM pairwise / MLS) so the server relays it opaquely and
// never learns who read what. The server stores the latest blob per
// (channel, user, device) — no ordering needed, latest wins — and replays them
// on (re)join. `deviceId` is public key-directory data (the server can't derive
// it from the opaque env), so the client includes it; recipients merge the max
// readSeq per user across that user's devices.
export type ReceiptUpdatePayload = {
  channelId: string;
  deviceId: string;
  env: string;
};
export type ReceiptRelayPayload = {
  channelId: string;
  fromUserId: string;
  deviceId: string;
  env: string;
};

// Passphrase-encrypted key backup (opaque blob; server can't read it).
// `kcv` is the PIN-derived key-check value for the rate-limited unlock vault
// (crypto/backup.ts computeKcv) — stored alongside the blob at put time.
export type BackupPutPayload = { blob: unknown; kcv?: string };
/** Ack for backup:put — confirms the server actually persisted the blob. */
export type BackupPutResult = {
  ok: boolean;
  updatedAt: string | null;
  error?: string;
};
/**
 * backup:get no longer returns the ciphertext — only the KDF params needed to
 * derive the unlock proof. The blob itself is released by backup:unlock after
 * a matching kcv (rate-limited). `legacyBlob` is the pre-vault fallback: rows
 * stored without a kcv are returned directly so old backups keep restoring.
 */
export type BackupGetResult = {
  updatedAt: string | null;
  salt: string | null;
  iters: number | null;
  legacyBlob?: unknown;
};
export type BackupUnlockPayload = { kcv: string };
export type BackupUnlockResult =
  | { ok: true; blob: unknown }
  | {
      ok: false;
      error: string;
      /** Wrong proof: guesses left before lockout. */
      remainingAttempts?: number;
      /** Locked out: seconds until attempts are accepted again. */
      lockedForSec?: number;
    };
export type BackupDeleteResult = { ok: boolean; error?: string };

// Continuous encrypted history store (crypto/backup.ts): rows are message rows
// re-encrypted client-side under the user's storage key; the server upserts and
// pages them per-user but can't read them. Deleted alongside the backup blob.
export type HistoryRowWire = { msgId: string; iv: string; ct: string };
export type HistoryAppendPayload = { rows: HistoryRowWire[] };
export type HistoryFetchPayload = { afterMsgId?: string | null };
export type HistoryFetchResult = {
  rows: HistoryRowWire[];
  /** Pass back as afterMsgId to fetch the next page; null when done. */
  nextCursor: string | null;
};

// Device-to-device recovery (Messenger-style): a freshly-provisioned device asks
// this user's OTHER online devices to hand over recoverable key material. The
// server only relays between the SAME user's devices — it never crosses users.
// `fingerprint` lets the responder cross-check that the directory bundle for
// `deviceId` really is the requester's (defends against a lying server), and the
// human approves by comparing it to the code shown on the new device.
// DM self-heal ("reheal"): a device that can't decrypt its per-device copy of a
// DM message (the copy was sealed to a key it no longer holds — a consumed
// one-time prekey, or the device didn't exist at send time) asks the DM's other
// party AND its own other devices to RE-ENCRYPT that message's plaintext to its
// current keys. The responder answers only for a requester that is a genuine
// participant of the DM the message lives in, so a DM can't leak to a third
// party. Complements the group sender-key pull-on-miss (which has no DM analog).
export type DmRehealRequestPayload = {
  /** The REQUESTER's DM channel id (not viewer-symmetric — echoed back so the
   *  offer applies to the right conversation on the requester's side). */
  channelId: string;
  msgId: string;
  /** The DM peer, so the server can route the request to that user's devices. */
  peerId: string;
};
export type DmRehealRequestRelay = {
  channelId: string;
  msgId: string;
  /** The requester — whom the responder re-encrypts the plaintext to. */
  fromUserId: string;
};
export type DmRehealOfferPayload = {
  channelId: string;
  msgId: string;
  /** The requester (server routes the offer to that user's room). */
  toUserId: string;
  /** Envelope re-sealed to the requester's current devices. */
  enc: string;
};
export type DmRehealOfferRelay = { channelId: string; msgId: string; enc: string };

// 1:1 voice/video calls (DMs only). The server relays call signaling (SDP
// offers/answers + trickle ICE, opaque `data` strings) between the two DM
// parties; the media itself flows peer-to-peer over DTLS-SRTP and never
// touches the server. `callId` is a caller-generated UUID — every event
// carries it and clients drop events for ids they don't recognize, so only
// the invite (which creates UI out of nothing) is server-validated: the
// channel must be a DM the caller belongs to, and the server derives the
// callee from the DM roster rather than trusting a client-claimed peer.
export type CallInvitePayload = {
  callId: string;
  channelId: string;
  /** Camera call (true) vs voice-only (false). */
  video: boolean;
};
/** Ack for call:invite — `offline` means the callee has no connected device. */
export type CallInviteResult =
  | { ok: true }
  | { ok: false; reason: "offline" | "unauthorized" | "error" };
export type CallInviteRelay = {
  callId: string;
  /** The CALLER's DM channel id (not viewer-symmetric) — the callee resolves
   *  its own conversation by `fromUserId`, not by this id. */
  channelId: string;
  fromUserId: string;
  video: boolean;
};
/** Callee → caller: accept or decline the ringing invite. */
export type CallAnswerPayload = { callId: string; toUserId: string; accept: boolean };
export type CallAnswerRelay = { callId: string; fromUserId: string; accept: boolean };
/** Opaque signaling blob (JSON: offer / answer / ICE candidate). */
export type CallSignalPayload = { callId: string; toUserId: string; data: string };
export type CallSignalRelay = { callId: string; fromUserId: string; data: string };
/** `handled` is server-generated: sent to the answerer's OWN other devices so
 *  they stop ringing when one device accepts/declines. */
export type CallEndReason =
  | "ended"
  | "cancelled"
  | "busy"
  | "timeout"
  | "handled";
export type CallEndPayload = {
  callId: string;
  toUserId: string;
  reason: CallEndReason;
};
export type CallEndRelay = {
  callId: string;
  fromUserId: string;
  reason: CallEndReason;
};

export type RecoveryRequestPayload = { deviceId: string; fingerprint: string };
// Responder → requester: `env` is an `encryptForDevices` envelope sealed to the
// requesting device only (opaque to the server), carrying the group seeds.
export type RecoveryOfferPayload = { toDeviceId: string; env: string };
export type RecoveryOfferRelay = { fromDeviceId: string; env: string };

// MLS (RFC 9420) group encryption — Phase 4, feature-flagged (see MLS_ENABLED in
// chat-context; sender-keys stays the default). Payloads are opaque wire-encoded
// MLSMessages the server ORDERS but can't read (see server/mls-ds.ts, the MLS
// Delivery Service). Commits are submitted with the epoch they were built
// against; the server accepts one per epoch and assigns a global `seq`.
// Multi-device: every device is its own MLS leaf, so KeyPackages, Welcomes and
// the drain are DEVICE-granular. `mls:fetchChannel` also returns the channel's
// member USER ids (the server-authoritative roster) so a committer can diff
// the group's leaves against actual membership and remove departed users.
export type MlsPublishKeyPackagePayload = { deviceId: string; keyPackage: string };
export type MlsFetchChannelPayload = { channelId: string };
export type MlsMemberPackage = { userId: string; deviceId: string; keyPackage: string };
export type MlsFetchChannelResult = {
  /** Every member's published packages, INCLUDING the requester's other devices. */
  packages: MlsMemberPackage[];
  /** The channel's member user ids (roster), including the requester. */
  memberIds: string[];
};
// Submit a commit (+ any Welcomes for newly-added member devices). Ack tells the
// client whether it was accepted (with its ordering `seq`+new `epoch`) or
// rejected as a stale/concurrent commit (`conflict`) so it can catch up + rebase.
export type MlsCommitPayload = {
  channelId: string;
  fromEpoch: number;
  commit: string;
  welcomes: { toUserId: string; toDeviceId: string; welcome: string }[];
};
export type MlsCommitAck =
  | { ok: true; seq: number; epoch: number }
  | { ok: false; reason: "conflict" | "no_group" | "error"; currentEpoch: number };
// Server → members: an accepted commit to apply, in `seq` order.
export type MlsCommitRelay = { channelId: string; seq: number; commit: string };
// Server → a newly-added member device: a Welcome to join with. `toDeviceId`
// lets the target device act on it (siblings ignore it — theirs arrives
// separately). `seq` is the commit that added them — catch-up resumes there.
export type MlsWelcomeRelay = {
  channelId: string;
  welcome: string;
  seq: number;
  toDeviceId: string;
};
// Catch-up: fetch ordered commits after the last one this client applied.
export type MlsFetchCommitsPayload = { channelId: string; sinceSeq: number };
export type MlsFetchCommitsResult = { commits: { seq: number; commit: string }[] };
// Drain THIS DEVICE's queued Welcomes on (re)connect (added while offline).
export type MlsDrainWelcomesPayload = { deviceId: string };
export type MlsDrainWelcomesResult = {
  welcomes: { channelId: string; welcome: string; seq: number }[];
};

export type GroupSenderKeyRequestPayload = { channelId: string; sender: string };
export type GroupSenderKeyRequestRelay = {
  channelId: string;
  sender: string;
  fromUserId: string;
};

// ---------------------------------------------------------------------------
// Server → client payloads
// ---------------------------------------------------------------------------

export type EchoReply = { t: number; serverTime: number };

/** `nextCursor` is the seq to pass to history:more for older messages, or null. */
export type HistoryPayload = {
  channelId: string;
  messages: Message[];
  nextCursor: number | null;
};

export type HistoryPagePayload = {
  channelId: string;
  messages: Message[];
  nextCursor: number | null;
};

/** A window of messages centred on `focusId`, to scroll to and highlight. */
export type HistoryFocusPayload = {
  channelId: string;
  messages: Message[];
  nextCursor: number | null;
  focusId: string;
};

/** Durable history replayed to a socket on channel join (server-persisted). */
export type HistoryReplayPayload = {
  channelId: string;
  messages: Message[];
  replies: { parentId: string; reply: Message }[];
};

export type MessageNewPayload = { channelId: string; message: Message };

/** Echoed to the sender so the optimistic temp message can be swapped out. */
export type MessageAckPayload = { clientId: string; message: Message };

export type ThreadNewPayload = {
  channelId: string;
  parentId: string;
  reply: Message;
  threadCount: number;
  threadLastTime: string;
};

/** Aggregated reaction: reactor ids let each client derive its own `mine`. */
export type ReactionAggWire = { e: string; n: number; by: string[] };

export type ReactionUpdatedPayload = {
  channelId: string;
  msgId: string;
  reactions: ReactionAggWire[];
};

/** The channels/DMs an authenticated user is authorized to see (roster). */
export type ChannelsListPayload = { channels: Channel[] };

/** Pinned message ids; clients resolve snippets from their local IndexedDB. */
export type PinsUpdatedPayload = { channelId: string; pinIds: string[] };

export type ChannelCreatedPayload = { channel: Channel };
export type ChannelUpdatedPayload = { channel: Channel };
export type ChannelDeletedPayload = { channelId: string };

export type WorkspaceRenamePayload = { name: string };
export type WorkspaceMemberPayload = { userId: string };
export type WorkspaceInfoPayload = { name: string; members: User[] };

export type ProfileUpdatePayload = { patch: Partial<UserProfile> };
/** The viewer's profile fields + their resolved display User (name/initials). */
export type ProfileInfoPayload = { profile: UserProfile; user: User };

export type MessageDeletePayload = {
  channelId: string;
  msgId: string;
  /** The client supplies parentId (it knows); the server keeps no message copy. */
  parentId?: string | null;
};

/**
 * Edit = the author re-encrypts the message body and the envelope REPLACES the
 * stored one (the server merges it into the row and relays it; it never sees
 * plaintext). Author-only, enforced server-side against the stored row.
 */
export type MessageEditPayload = {
  channelId: string;
  msgId: string;
  /** Thread-reply edits carry the parent id; the server's stored row wins. */
  parentId?: string | null;
  /** Re-encrypted MessageContent envelope (JSON) — the new body. */
  enc: string;
};

export type MessageEditedPayload = {
  channelId: string;
  msgId: string;
  parentId: string | null;
  enc: string;
  /** Server-stamped epoch-ms: orders concurrent edits, drives "(edited)". */
  editedTs: number;
};
export type MessageDeletedPayload = {
  channelId: string;
  msgId: string;
  parentId: string | null;
};

export type ChannelReadPayload = { channelId: string };
/** Full unread snapshot (sent on connect), keyed by channel id. */
export type UnreadStatePayload = { counts: Record<string, number> };
/** A channel gained a new message the recipient hasn't seen. */
export type UnreadBumpPayload = { channelId: string };

export type PresenceStatus = "active" | "idle" | "offline";
export type PresenceUpdatePayload = { userId: string; status: PresenceStatus };

export type TypingUpdatePayload = {
  channelId: string;
  userId: string;
  isTyping: boolean;
};

// ---------------------------------------------------------------------------
// Typed event maps for Socket.IO generics
// ---------------------------------------------------------------------------

export type ClientToServerEvents = {
  echo: (payload: EchoPayload, ack: (reply: EchoReply) => void) => void;
  "channel:join": (payload: ChannelJoinPayload) => void;
  "channel:leave": (payload: ChannelLeavePayload) => void;
  "history:more": (payload: HistoryMorePayload) => void;
  "history:around": (payload: HistoryAroundPayload) => void;
  "message:send": (payload: MessageSendPayload) => void;
  "thread:reply": (payload: ThreadReplyPayload) => void;
  "reaction:toggle": (payload: ReactionTogglePayload) => void;
  "dm:create": (payload: DmCreatePayload) => void;
  "channel:create": (
    payload: ChannelCreatePayload,
    ack: (result: ChannelCreateResult) => void,
  ) => void;
  "channel:update": (
    payload: ChannelUpdatePayload,
    ack: (result: ChannelOpResult) => void,
  ) => void;
  "channel:delete": (
    payload: ChannelDeletePayload,
    ack: (result: ChannelOpResult) => void,
  ) => void;
  "channel:addMember": (
    payload: ChannelMemberPayload,
    ack: (result: ChannelOpResult) => void,
  ) => void;
  "channel:removeMember": (
    payload: ChannelMemberPayload,
    ack: (result: ChannelOpResult) => void,
  ) => void;
  "workspace:rename": (
    payload: WorkspaceRenamePayload,
    ack: (result: ChannelOpResult) => void,
  ) => void;
  "workspace:invite": (
    payload: WorkspaceMemberPayload,
    ack: (result: ChannelOpResult) => void,
  ) => void;
  "workspace:removeMember": (
    payload: WorkspaceMemberPayload,
    ack: (result: ChannelOpResult) => void,
  ) => void;
  "channel:read": (payload: ChannelReadPayload) => void;
  "message:delete": (payload: MessageDeletePayload) => void;
  "message:edit": (payload: MessageEditPayload) => void;
  "profile:update": (payload: ProfileUpdatePayload) => void;
  "typing:start": (payload: TypingPayload) => void;
  "typing:stop": (payload: TypingPayload) => void;
  "pin:toggle": (payload: PinTogglePayload) => void;
  "keys:publish": (payload: KeysPublishPayload) => void;
  "keys:supplement": (payload: KeysSupplementPayload) => void;
  "keys:fetch": (
    payload: KeysFetchPayload,
    ack: (result: KeysFetchResult) => void,
  ) => void;
  "keys:fetchChannel": (
    payload: KeysFetchChannelPayload,
    ack: (result: KeysFetchResult) => void,
  ) => void;
  "group:senderKey": (payload: GroupSenderKeyPayload) => void;
  "group:senderKey:request": (payload: GroupSenderKeyRequestPayload) => void;
  "receipt:update": (payload: ReceiptUpdatePayload) => void;
  "backup:put": (
    payload: BackupPutPayload,
    ack?: (result: BackupPutResult) => void,
  ) => void;
  "backup:get": (ack: (result: BackupGetResult) => void) => void;
  "backup:unlock": (
    payload: BackupUnlockPayload,
    ack: (result: BackupUnlockResult) => void,
  ) => void;
  "backup:delete": (ack?: (result: BackupDeleteResult) => void) => void;
  "history:append": (payload: HistoryAppendPayload) => void;
  "history:fetchMine": (
    payload: HistoryFetchPayload,
    ack: (result: HistoryFetchResult) => void,
  ) => void;
  "recovery:request": (payload: RecoveryRequestPayload) => void;
  "recovery:offer": (payload: RecoveryOfferPayload) => void;
  "dm:reheal:request": (payload: DmRehealRequestPayload) => void;
  "dm:reheal:offer": (payload: DmRehealOfferPayload) => void;
  "call:invite": (
    payload: CallInvitePayload,
    ack: (result: CallInviteResult) => void,
  ) => void;
  "call:answer": (payload: CallAnswerPayload) => void;
  "call:signal": (payload: CallSignalPayload) => void;
  "call:end": (payload: CallEndPayload) => void;
  "mls:publishKeyPackage": (payload: MlsPublishKeyPackagePayload) => void;
  "mls:fetchChannel": (
    payload: MlsFetchChannelPayload,
    ack: (res: MlsFetchChannelResult) => void,
  ) => void;
  "mls:commit": (payload: MlsCommitPayload, ack: (res: MlsCommitAck) => void) => void;
  "mls:fetchCommits": (
    payload: MlsFetchCommitsPayload,
    ack: (res: MlsFetchCommitsResult) => void,
  ) => void;
  "mls:drainWelcomes": (
    payload: MlsDrainWelcomesPayload,
    ack: (res: MlsDrainWelcomesResult) => void,
  ) => void;
};

export type ServerToClientEvents = {
  "channels:list": (payload: ChannelsListPayload) => void;
  "history:replay": (payload: HistoryReplayPayload) => void;
  history: (payload: HistoryPayload) => void;
  "history:page": (payload: HistoryPagePayload) => void;
  "history:focus": (payload: HistoryFocusPayload) => void;
  "message:new": (payload: MessageNewPayload) => void;
  "message:ack": (payload: MessageAckPayload) => void;
  "message:deleted": (payload: MessageDeletedPayload) => void;
  "message:edited": (payload: MessageEditedPayload) => void;
  "thread:new": (payload: ThreadNewPayload) => void;
  "reaction:updated": (payload: ReactionUpdatedPayload) => void;
  "channel:created": (payload: ChannelCreatedPayload) => void;
  "channel:updated": (payload: ChannelUpdatedPayload) => void;
  "channel:deleted": (payload: ChannelDeletedPayload) => void;
  "workspace:updated": (payload: WorkspaceInfoPayload) => void;
  "profile:updated": (payload: ProfileInfoPayload) => void;
  "unread:state": (payload: UnreadStatePayload) => void;
  "unread:bump": (payload: UnreadBumpPayload) => void;
  "presence:update": (payload: PresenceUpdatePayload) => void;
  "typing:update": (payload: TypingUpdatePayload) => void;
  "pins:updated": (payload: PinsUpdatedPayload) => void;
  "group:senderKey": (payload: GroupSenderKeyRelay) => void;
  "group:senderKey:request": (payload: GroupSenderKeyRequestRelay) => void;
  "receipt:update": (payload: ReceiptRelayPayload) => void;
  "recovery:request": (payload: RecoveryRequestPayload) => void;
  "recovery:offer": (payload: RecoveryOfferRelay) => void;
  "dm:reheal:request": (payload: DmRehealRequestRelay) => void;
  "dm:reheal:offer": (payload: DmRehealOfferRelay) => void;
  "call:invite": (payload: CallInviteRelay) => void;
  "call:answer": (payload: CallAnswerRelay) => void;
  "call:signal": (payload: CallSignalRelay) => void;
  "call:end": (payload: CallEndRelay) => void;
  "mls:commit": (payload: MlsCommitRelay) => void;
  "mls:welcome": (payload: MlsWelcomeRelay) => void;
};
