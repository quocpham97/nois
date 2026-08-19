/**
 * Call vocabulary: the phases a call moves through, who's in it, and the tuning
 * constants. Kept apart from the hooks so the store and the views can name a
 * call without importing the machinery that runs one.
 */
import type { User } from "@/lib/chat-data";

/** outgoing → (someone joins) → connecting → (media connects) → active.
 *  incoming → (we join)       → connecting → (media connects) → active. */
export type CallPhase = "outgoing" | "incoming" | "connecting" | "active";

/** One remote device in the call. Keyed by deviceId, never by userId. */
export type CallParticipant = {
  userId: string;
  deviceId: string;
  user: User;
  stream: MediaStream | null;
  connected: boolean;
};

export type CallInfo = {
  callId: string;
  /** The conversation this call belongs to (symmetric for DMs, so both sides
   *  address the same room). */
  groupId: string;
  kind: "dm" | "group";
  /** Headline for the call UI: the DM partner's name, or the group's name. */
  title: string;
  /** Who placed the call — drives who writes the thread record. */
  starterId: string;
  starter: User;
  /** The DM partner, or null in a group. The call UI shows the CONVERSATION, not
   *  the caller: on an outgoing DM call the starter is us, and our own face is
   *  not what you want to look at while you wait for someone to pick up. */
  peer: User | null;
  video: boolean;
  phase: CallPhase;
  /** True when WE placed this call (`starterId === us`), so this device owns the
   *  thread record. Survives device migration, since it's derived from the id. */
  outgoing: boolean;
  /** Epoch-ms when the first peer connected; drives the in-call timer. */
  startedAt: number | null;
  /** Remote participants, never including us. */
  participants: CallParticipant[];
  /** Peak simultaneous participants INCLUDING us — the thread record's "N on
   *  the call". Monotonic for the life of the call. */
  peak: number;
};

/** A live call in a conversation we're not (yet) in — powers "Ongoing call · Join". */
export type OngoingCall = {
  groupId: string;
  callId: string;
  video: boolean;
  starterId: string;
};

/** How long an unanswered call rings before it's treated as missed. */
export const RING_TIMEOUT_MS = 45_000;

/** Route media through the SFU instead of a peer mesh. OFF by default and
 *  deliberately build-time, because this is not a user-facing setting: until
 *  phase D (per-frame E2EE) the SFU can see media, so turning this on trades
 *  the product's central promise for participant headroom. */
export const SFU_ENABLED = process.env.NEXT_PUBLIC_CALL_TRANSPORT === "sfu";

/** How long to wait for a group's MLS state to converge before giving up on an
 *  encrypted call. Seconds, because establishing it means publishing key
 *  packages, ordering a commit and delivering Welcomes — not a local lookup. */
export const MLS_KEY_WAIT_MS = 20_000;
/** First delay between attempts, then doubling to MLS_KEY_RETRY_MAX_MS.
 *
 *  Backoff rather than a fixed interval because a retry is not a cheap poll: in
 *  a group with no MLS state yet, every attempt fetches key packages, creates a
 *  group and submits a commit — WASM crypto on the main thread, with all the
 *  callers racing to be the one that wins. Hammering that at a fixed 750ms
 *  starved the event loop enough to drop the websocket, which on the SFU path
 *  (where every setup step needs an ack) cost the call its media. */
export const MLS_KEY_RETRY_MS = 750;
export const MLS_KEY_RETRY_MAX_MS = 5_000;

/** A dropped socket costs the SFU transport its media entirely, where the mesh
 *  only loses an ICE candidate — so its requests ride out a reconnect. */
export const SFU_RETRIES = 5;
export const SFU_RETRY_MS = 600;
/** Budget for requests that provably never happened, so are safe to repeat —
 *  wide enough to ride out a reconnect plus the `call:rejoin` that follows it. */
export const SFU_REFUSAL_RETRIES = 10;
/** How long to wait for a reconnect before placing an SFU request anyway. */
export const SFU_SOCKET_WAIT_MS = 5_000;

export const getMedia = (video: boolean): Promise<MediaStream> =>
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
