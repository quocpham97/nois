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
  Group,
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

export type GroupJoinPayload = { groupId: string };
export type GroupLeavePayload = { groupId: string };

/** Request a page of older messages before the given cursor (a message seq). */
export type HistoryMorePayload = { groupId: string; beforeSeq: number };

/** Request a window of messages centred on a specific message (jump-to). */
export type HistoryAroundPayload = { groupId: string; msgId: string };

export type MessageSendPayload = {
  groupId: string;
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
  groupId: string;
  parentId: string;
  text: string;
  clientId: string;
  /** Optional Lexical editor-state JSON for rich-text rendering. */
  rich?: string;
};

export type ReactionTogglePayload = {
  groupId: string;
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

export type GroupCreatePayload = {
  name: string;
  topic?: string;
  /** Workspace members to seed the roster with (the creator is added by the
   *  server). A group is visible ONLY to its roster, so this can't be empty. */
  memberIds: string[];
};

/** Ack for group:create — carries the server-assigned id on success. */
export type GroupCreateResult =
  | { ok: true; groupId: string }
  | { ok: false; error: string };

export type GroupUpdatePayload = {
  groupId: string;
  name?: string;
  topic?: string;
};
export type GroupDeletePayload = { groupId: string };
export type GroupMemberPayload = { groupId: string; userId: string };

/** Generic ack for group mutations. */
export type GroupOpResult = { ok: true } | { ok: false; error: string };

export type TypingPayload = { groupId: string };

export type PinTogglePayload = { groupId: string; msgId: string };
export type PinsClearPayload = { groupId: string };
/** theme = a CHAT_GRADIENTS key, or null to fall back to each member's default. */
export type GroupThemePayload = { groupId: string; theme: string | null };

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

// Group (sender-keys) key distribution. `keys:fetchGroup` returns the prekey
// bundles of every device of every member of a group (so a sender can wrap
// its sender key for each). `group:senderKey` relays a sender-key distribution
// — a pairwise-encrypted envelope (opaque to the server) — to the room.
export type KeysFetchGroupPayload = { groupId: string };
export type GroupSenderKeyPayload = {
  groupId: string;
  /** The distributing device's id, so the server can persist one env per
   *  sender device for offline replay. Not secret (it's in the key directory). */
  sender: string;
  env: string;
};
export type GroupSenderKeyRelay = {
  groupId: string;
  /** Sender userId, so recipients can route/verify; the env stays opaque. */
  fromUserId: string;
  env: string;
};
// Pull-on-miss: a member that can't decrypt a message asks the sender device to
// re-distribute its sender key. `sender` is the sender's deviceId (from the
// undecryptable envelope). The server relays it to the group's members; only
// the matching sender device responds (with a fresh `group:senderKey`).

// E2EE read receipts (Phase 2). A receipt is a per-group READ CURSOR
// ("I've seen up to seq N"), sealed with the same envelope crypto as messages
// (group sender-key / DM pairwise / MLS) so the server relays it opaquely and
// never learns who read what. The server stores the latest blob per
// (group, user, device) — no ordering needed, latest wins — and replays them
// on (re)join. `deviceId` is public key-directory data (the server can't derive
// it from the opaque env), so the client includes it; recipients merge the max
// readSeq per user across that user's devices.
export type ReceiptUpdatePayload = {
  groupId: string;
  deviceId: string;
  env: string;
};
export type ReceiptRelayPayload = {
  groupId: string;
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
  /** The REQUESTER's DM group id (not viewer-symmetric — echoed back so the
   *  offer applies to the right conversation on the requester's side). */
  groupId: string;
  msgId: string;
  /** The DM peer, so the server can route the request to that user's devices. */
  peerId: string;
};
export type DmRehealRequestRelay = {
  groupId: string;
  msgId: string;
  /** The requester — whom the responder re-encrypts the plaintext to. */
  fromUserId: string;
};
export type DmRehealOfferPayload = {
  groupId: string;
  msgId: string;
  /** The requester (server routes the offer to that user's room). */
  toUserId: string;
  /** Envelope re-sealed to the requester's current devices. */
  enc: string;
};
export type DmRehealOfferRelay = { groupId: string; msgId: string; enc: string };

// Voice/video calls. Media is a peer-to-peer mesh (DTLS-SRTP) and never touches
// the server; the server relays signaling (SDP + trickle ICE as opaque `data`
// strings) and owns nothing but the participant roster — which is literally a
// socket room, `call:<groupId>:<callId>`, so there is no per-call server state to
// keep consistent across nodes. See docs/calls.md + docs/group-calls-plan.md.
//
// Every event carries `callId` and clients drop events for ids they don't
// recognize. The two events that create UI out of nothing (`call:start` and
// `call:join`) are server-validated against the group's *member* roster.

/** A device in a call. Signaling is addressed per device, never per user: two
 *  devices of one user must never both be treated as "the peer". */
export type CallPeer = { userId: string; deviceId: string };

/** Announce this browser's E2EE device id so the server can route signaling to
 *  it (`device:<deviceId>` room). Emitted on every connect. */
export type DeviceAnnouncePayload = { deviceId: string };

/** Shaped like the DOM's `RTCIceServer`, spelled out here because this module is
 *  shared with the server and must not depend on DOM lib types. */
export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};
/** ICE servers for a call, minted server-side and never baked into the bundle.
 *  Cloudflare issues short-lived credentials only, so they're fetched per
 *  session and expire on their own; `ttl` is the remaining lifetime in seconds
 *  and the client refetches before it runs out. An EMPTY `iceServers` means the
 *  server has no TURN key configured — the client then falls back to the
 *  `NEXT_PUBLIC_TURN_*` build-time vars, and to STUN-only if those are unset
 *  too. See docs/calls-production.md. */
export type IceServersResult = { iceServers: IceServerConfig[]; ttl: number };

export type CallStartPayload = { groupId: string; video: boolean };
/** `video` in the ack is the EFFECTIVE mode: the server downgrades a video
 *  request to voice in groups too large for the video cap. `ringing` is false
 *  for a huddle (nobody's device rings; the conversation shows a join banner). */
export type CallStartResult =
  | { ok: true; callId: string; video: boolean; ringing: boolean }
  | { ok: false; reason: "offline" | "unauthorized" | "error" };

export type CallInviteRelay = {
  callId: string;
  groupId: string;
  fromUserId: string;
  video: boolean;
};

export type CallJoinPayload = { callId: string; groupId: string };
/** `participants` are the devices already in the call — the joiner answers
 *  their offers (see the glare rule in call-context). `gone` means the call
 *  ended before this join landed; `full` means the participant cap. */
export type CallJoinResult =
  | { ok: true; participants: CallPeer[]; video: boolean }
  | { ok: false; reason: "full" | "unauthorized" | "gone" | "error" };

/** Not joining. `busy` is an automatic decline (already on another call) and is
 *  recorded the same as a tapped decline — see docs/calls.md. */
export type CallDeclinePayload = {
  callId: string;
  groupId: string;
  reason: "declined" | "busy";
};
export type CallDeclinedRelay = {
  callId: string;
  userId: string;
  reason: "declined" | "busy";
};

export type CallLeavePayload = { callId: string; groupId: string };

/** Reclaim a seat after a websocket blip. Media is peer-to-peer and survives a
 *  signaling drop, so a reconnect should restore the call rather than end it —
 *  the server holds the seat for a grace period, and this is how a client takes
 *  it back. Unlike `call:join` it never displaces the user's other devices. */
export type CallRejoinPayload = { callId: string; groupId: string };
export type CallRejoinResult =
  | { ok: true; participants: CallPeer[] }
  | { ok: false; reason: "full" | "unauthorized" | "gone" | "error" };

/** Broadcast inside the call room as the roster changes. */
export type CallJoinedRelay = { callId: string } & CallPeer;
export type CallLeftRelay = { callId: string } & CallPeer;

/** Server → the answerer's OTHER devices: this ring was handled here, stop. */
export type CallHandledRelay = { callId: string };
/** Server → a device displaced because the same user joined elsewhere. */
export type CallKickedRelay = {
  callId: string;
  reason: "joined_on_another_device";
};

/** Conversation-level liveness, so a group can show "Ongoing call · Join".
 *  Sent to members' user rooms for ring-eligible groups, and to the group room
 *  (i.e. whoever currently has it open) for huddles. */
export type CallOngoingRelay = {
  groupId: string;
  callId: string;
  video: boolean;
  starterId: string;
};
export type CallOverRelay = { groupId: string; callId: string };

/** Opaque signaling blob (JSON: offer / answer / ICE candidate), addressed to
 *  one device. */
export type CallSignalPayload = {
  callId: string;
  toDeviceId: string;
  data: string;
};
export type CallSignalRelay = {
  callId: string;
  fromUserId: string;
  fromDeviceId: string;
  data: string;
};

// SFU (phase C, flag-gated). Cloudflare Realtime's app token is app-wide — no
// room-scoped per-participant token exists — so the client never holds it and
// every call is proxied through the server, which authorizes on call-room
// membership. Shapes mirror Cloudflare's Realtime API; the SDP is as opaque to
// us here as it is in `call:signal`.
export type SfuSessionDescription = { type: "offer" | "answer"; sdp: string };
export type SfuTrackObject = {
  location?: "local" | "remote";
  trackName?: string;
  sessionId?: string;
  mid?: string | null;
};
export type SfuTracksBody = {
  tracks: SfuTrackObject[];
  sessionDescription?: SfuSessionDescription;
};
export type SfuTracksResponse = {
  sessionDescription?: SfuSessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: (SfuTrackObject & { errorCode?: string; errorDescription?: string })[];
  errorCode?: string;
  errorDescription?: string;
};

/** `unconfigured` means the deployment has no SFU app — the client falls back
 *  to the mesh rather than failing the call. */
export type SfuFailure = {
  ok: false;
  reason: "unconfigured" | "unauthorized" | "error";
};
/** Every SFU call is scoped to a call the caller is currently in. */
type SfuScope = { groupId: string; callId: string };

export type SfuSessionPayload = SfuScope;
export type SfuSessionResult = { ok: true; sessionId: string } | SfuFailure;

export type SfuTracksPayload = SfuScope & {
  sessionId: string;
  body: SfuTracksBody;
};
export type SfuTracksResult = { ok: true; result: SfuTracksResponse } | SfuFailure;

export type SfuRenegotiatePayload = SfuScope & {
  sessionId: string;
  body: { sessionDescription: SfuSessionDescription };
};
export type SfuClosePayload = SfuScope & {
  sessionId: string;
  body: { tracks: { mid?: string }[]; force: boolean };
};
export type SfuOkResult = { ok: true } | SfuFailure;

export type RecoveryRequestPayload = { deviceId: string; fingerprint: string };
// Responder → requester: `env` is an `encryptForDevices` envelope sealed to the
// requesting device only (opaque to the server), carrying the group seeds.
export type RecoveryOfferPayload = { toDeviceId: string; env: string };
export type RecoveryOfferRelay = { fromDeviceId: string; env: string };

// MLS (RFC 9420) group encryption — Phase 4, feature-flagged (see MLS_ENABLED in
// hooks/use-mls; sender-keys stays the default). Payloads are opaque wire-encoded
// MLSMessages the server ORDERS but can't read (see server/mls-ds.ts, the MLS
// Delivery Service). Commits are submitted with the epoch they were built
// against; the server accepts one per epoch and assigns a global `seq`.
// Multi-device: every device is its own MLS leaf, so KeyPackages, Welcomes and
// the drain are DEVICE-granular. `mls:fetchGroup` also returns the group's
// member USER ids (the server-authoritative roster) so a committer can diff
// the group's leaves against actual membership and remove departed users.
export type MlsPublishKeyPackagePayload = { deviceId: string; keyPackage: string };
export type MlsFetchGroupPayload = { groupId: string };
export type MlsMemberPackage = { userId: string; deviceId: string; keyPackage: string };
export type MlsFetchGroupResult = {
  /** Every member's published packages, INCLUDING the requester's other devices. */
  packages: MlsMemberPackage[];
  /** The group's member user ids (roster), including the requester. */
  memberIds: string[];
};
// Submit a commit (+ any Welcomes for newly-added member devices). Ack tells the
// client whether it was accepted (with its ordering `seq`+new `epoch`) or
// rejected as a stale/concurrent commit (`conflict`) so it can catch up + rebase.
export type MlsCommitPayload = {
  groupId: string;
  fromEpoch: number;
  commit: string;
  /** Legacy shape: one entry per target device, each carrying its own copy of
   *  the blob. Still accepted, because an older client may send it. */
  welcomes?: { toUserId: string; toDeviceId: string; welcome: string }[];
  /**
   * Preferred shape: each distinct Welcome once, with the devices it is for.
   *
   * One add-commit produces ONE Welcome covering every member it adds, so the
   * legacy shape multiplied the payload by the device count. With members that
   * had accumulated many devices that reached 30 MB for a three-person group —
   * past `ws`'s frame limit, which does not reject the message but tears the
   * SOCKET down, so every call and commit riding on it died too.
   */
  welcomeFor?: {
    welcome: string;
    targets: { toUserId: string; toDeviceId: string }[];
  }[];
};
export type MlsCommitAck =
  | { ok: true; seq: number; epoch: number }
  | { ok: false; reason: "conflict" | "no_group" | "error"; currentEpoch: number };
// Server → members: an accepted commit to apply, in `seq` order.
export type MlsCommitRelay = { groupId: string; seq: number; commit: string };
// Server → a newly-added member device: a Welcome to join with. `toDeviceId`
// lets the target device act on it (siblings ignore it — theirs arrives
// separately). `seq` is the commit that added them — catch-up resumes there.
export type MlsWelcomeRelay = {
  groupId: string;
  welcome: string;
  seq: number;
  toDeviceId: string;
};
// Catch-up: fetch ordered commits after the last one this client applied.
export type MlsFetchCommitsPayload = { groupId: string; sinceSeq: number };
export type MlsFetchCommitsResult = { commits: { seq: number; commit: string }[] };
// Drain THIS DEVICE's queued Welcomes on (re)connect (added while offline).
export type MlsDrainWelcomesPayload = { deviceId: string };
export type MlsDrainWelcomesResult = {
  welcomes: { groupId: string; welcome: string; seq: number }[];
};

export type GroupSenderKeyRequestPayload = { groupId: string; sender: string };
export type GroupSenderKeyRequestRelay = {
  groupId: string;
  sender: string;
  fromUserId: string;
};

// ---------------------------------------------------------------------------
// Server → client payloads
// ---------------------------------------------------------------------------

export type EchoReply = { t: number; serverTime: number };

/** `nextCursor` is the seq to pass to history:more for older messages, or null. */
export type HistoryPayload = {
  groupId: string;
  messages: Message[];
  nextCursor: number | null;
};

export type HistoryPagePayload = {
  groupId: string;
  messages: Message[];
  nextCursor: number | null;
};

/** A window of messages centred on `focusId`, to scroll to and highlight. */
export type HistoryFocusPayload = {
  groupId: string;
  messages: Message[];
  nextCursor: number | null;
  focusId: string;
};

/** Durable history replayed to a socket on group join (server-persisted). */
export type HistoryReplayPayload = {
  groupId: string;
  messages: Message[];
  replies: { parentId: string; reply: Message }[];
};

export type MessageNewPayload = { groupId: string; message: Message };

/** Echoed to the sender so the optimistic temp message can be swapped out. */
export type MessageAckPayload = { clientId: string; message: Message };

export type ThreadNewPayload = {
  groupId: string;
  parentId: string;
  reply: Message;
  threadCount: number;
  threadLastTime: string;
};

/** Aggregated reaction: reactor ids let each client derive its own `mine`. */
export type ReactionAggWire = { e: string; n: number; by: string[] };

export type ReactionUpdatedPayload = {
  groupId: string;
  msgId: string;
  reactions: ReactionAggWire[];
};

/** The groups/DMs an authenticated user is authorized to see (roster). */
export type GroupsListPayload = { groups: Group[] };

/** Pinned message ids; clients resolve snippets from their local IndexedDB. */
export type PinsUpdatedPayload = { groupId: string; pinIds: string[] };

export type GroupCreatedPayload = { group: Group };
export type GroupUpdatedPayload = { group: Group };
export type GroupDeletedPayload = { groupId: string };

export type WorkspaceRenamePayload = { name: string };
export type WorkspaceMemberPayload = { userId: string };
export type WorkspaceInfoPayload = { name: string; members: User[] };

export type ProfileUpdatePayload = { patch: Partial<UserProfile> };
/** The viewer's profile fields + their resolved display User (name/initials). */
export type ProfileInfoPayload = { profile: UserProfile; user: User };

export type MessageDeletePayload = {
  groupId: string;
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
  groupId: string;
  msgId: string;
  /** Thread-reply edits carry the parent id; the server's stored row wins. */
  parentId?: string | null;
  /** Re-encrypted MessageContent envelope (JSON) — the new body. */
  enc: string;
};

export type MessageEditedPayload = {
  groupId: string;
  msgId: string;
  parentId: string | null;
  enc: string;
  /** Server-stamped epoch-ms: orders concurrent edits, drives "(edited)". */
  editedTs: number;
};
export type MessageDeletedPayload = {
  groupId: string;
  msgId: string;
  parentId: string | null;
};

export type GroupReadPayload = { groupId: string };
/** Full unread snapshot (sent on connect), keyed by group id. */
export type UnreadStatePayload = { counts: Record<string, number> };
/** A group gained a new message the recipient hasn't seen. */
export type UnreadBumpPayload = { groupId: string };

export type PresenceStatus = "active" | "idle" | "offline";
export type PresenceUpdatePayload = { userId: string; status: PresenceStatus };

export type TypingUpdatePayload = {
  groupId: string;
  userId: string;
  isTyping: boolean;
};

// ---------------------------------------------------------------------------
// Typed event maps for Socket.IO generics
// ---------------------------------------------------------------------------

export type ClientToServerEvents = {
  echo: (payload: EchoPayload, ack: (reply: EchoReply) => void) => void;
  "group:join": (payload: GroupJoinPayload) => void;
  "group:leave": (payload: GroupLeavePayload) => void;
  "history:more": (payload: HistoryMorePayload) => void;
  "history:around": (payload: HistoryAroundPayload) => void;
  "message:send": (payload: MessageSendPayload) => void;
  "thread:reply": (payload: ThreadReplyPayload) => void;
  "reaction:toggle": (payload: ReactionTogglePayload) => void;
  "dm:create": (payload: DmCreatePayload) => void;
  "group:create": (
    payload: GroupCreatePayload,
    ack: (result: GroupCreateResult) => void,
  ) => void;
  "group:update": (
    payload: GroupUpdatePayload,
    ack: (result: GroupOpResult) => void,
  ) => void;
  "group:delete": (
    payload: GroupDeletePayload,
    ack: (result: GroupOpResult) => void,
  ) => void;
  "group:addMember": (
    payload: GroupMemberPayload,
    ack: (result: GroupOpResult) => void,
  ) => void;
  "group:removeMember": (
    payload: GroupMemberPayload,
    ack: (result: GroupOpResult) => void,
  ) => void;
  "workspace:rename": (
    payload: WorkspaceRenamePayload,
    ack: (result: GroupOpResult) => void,
  ) => void;
  "workspace:invite": (
    payload: WorkspaceMemberPayload,
    ack: (result: GroupOpResult) => void,
  ) => void;
  "workspace:removeMember": (
    payload: WorkspaceMemberPayload,
    ack: (result: GroupOpResult) => void,
  ) => void;
  "group:read": (payload: GroupReadPayload) => void;
  "message:delete": (payload: MessageDeletePayload) => void;
  "message:edit": (payload: MessageEditPayload) => void;
  "profile:update": (payload: ProfileUpdatePayload) => void;
  "typing:start": (payload: TypingPayload) => void;
  "typing:stop": (payload: TypingPayload) => void;
  "pin:toggle": (payload: PinTogglePayload) => void;
  /** Unpin everything in a group (the pinned bar's dismiss, for everyone). */
  "pins:clear": (payload: PinsClearPayload) => void;
  /** Set this conversation's chat color for every member. */
  "group:setTheme": (payload: GroupThemePayload) => void;
  "keys:publish": (payload: KeysPublishPayload) => void;
  "keys:supplement": (payload: KeysSupplementPayload) => void;
  "keys:fetch": (
    payload: KeysFetchPayload,
    ack: (result: KeysFetchResult) => void,
  ) => void;
  "keys:fetchGroup": (
    payload: KeysFetchGroupPayload,
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
  "device:announce": (payload: DeviceAnnouncePayload) => void;
  "ice:servers": (ack: (result: IceServersResult) => void) => void;
  "call:start": (
    payload: CallStartPayload,
    ack: (result: CallStartResult) => void,
  ) => void;
  "call:join": (
    payload: CallJoinPayload,
    ack: (result: CallJoinResult) => void,
  ) => void;
  "call:rejoin": (
    payload: CallRejoinPayload,
    ack: (result: CallRejoinResult) => void,
  ) => void;
  "call:decline": (payload: CallDeclinePayload) => void;
  "call:leave": (payload: CallLeavePayload) => void;
  "call:signal": (payload: CallSignalPayload) => void;
  "sfu:session": (
    payload: SfuSessionPayload,
    ack: (result: SfuSessionResult) => void,
  ) => void;
  "sfu:tracks": (
    payload: SfuTracksPayload,
    ack: (result: SfuTracksResult) => void,
  ) => void;
  "sfu:renegotiate": (
    payload: SfuRenegotiatePayload,
    ack: (result: SfuOkResult) => void,
  ) => void;
  "sfu:close": (payload: SfuClosePayload, ack?: (result: SfuOkResult) => void) => void;
  "mls:publishKeyPackage": (payload: MlsPublishKeyPackagePayload) => void;
  "mls:fetchGroup": (
    payload: MlsFetchGroupPayload,
    ack: (res: MlsFetchGroupResult) => void,
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
  "groups:list": (payload: GroupsListPayload) => void;
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
  "group:created": (payload: GroupCreatedPayload) => void;
  "group:updated": (payload: GroupUpdatedPayload) => void;
  "group:deleted": (payload: GroupDeletedPayload) => void;
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
  "call:joined": (payload: CallJoinedRelay) => void;
  "call:left": (payload: CallLeftRelay) => void;
  "call:declined": (payload: CallDeclinedRelay) => void;
  "call:handled": (payload: CallHandledRelay) => void;
  "call:kicked": (payload: CallKickedRelay) => void;
  "call:ongoing": (payload: CallOngoingRelay) => void;
  "call:over": (payload: CallOverRelay) => void;
  "call:signal": (payload: CallSignalRelay) => void;
  "mls:commit": (payload: MlsCommitRelay) => void;
  "mls:welcome": (payload: MlsWelcomeRelay) => void;
};
