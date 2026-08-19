/**
 * Session state: who we are, the socket, and this device's E2EE standing.
 *
 * Split out of the old socket context for the same reason as the chat store —
 * that context's value object was rebuilt on every render, so a connect, a
 * latency reading or a backup timestamp re-rendered every consumer, including the
 * conversation view and the sidebar. Here `ConnectionStatus` subscribes to
 * `status` and `latencyMs`, and the backup modals subscribe to the backup fields.
 *
 * This is also the single home for the viewer's identity: the chat store holds
 * the PROFILE the viewer edits, and `chat-selectors.useMyUser()` layers the two.
 */
import { create } from "zustand";
import type { Socket } from "socket.io-client";
import { deriveUser, type User } from "@/lib/chat-data";
import type { ClientToServerEvents, ServerToClientEvents } from "@/lib/socket-events";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** A device of ours asking to recover, awaiting a human's approval here. */
export type PendingApproval = { deviceId: string; fingerprint: string };

type SessionData = {
  socket: TypedSocket | null;
  status: ConnectionStatus;
  /** Round-trip time of the last echo health check, in ms. */
  latencyMs: number | null;

  /** The viewer's identity key (their session uid — an email for real users). */
  userId: string;
  /** The viewer as the session knows them, before any profile edits. */
  user: User;

  /** This browser's E2EE device id, once its identity is provisioned. */
  deviceId: string | null;
  /** Safety number for out-of-band identity verification (null until ready). */
  fingerprint: string | null;

  /** True when this device has no local keys but a server backup exists → prompt
   *  to restore. */
  needsRestore: boolean;
  /** Last-updated time of the server backup (null = none), for the Settings UI. */
  backupUpdatedAt: string | null;
  /** True once a passphrase is held this session (enables auto re-backup). */
  backupEnabled: boolean;

  /** True while a fresh device waits for one of the user's other devices. */
  recovering: boolean;
  /** Set on an EXISTING device when a new device asks to recover. */
  pendingApproval: PendingApproval | null;
};

type SessionActions = {
  setSocket: (s: TypedSocket | null) => void;
  setStatus: (s: ConnectionStatus) => void;
  setLatencyMs: (ms: number | null) => void;
  setIdentity: (userId: string, user: User) => void;
  setDevice: (deviceId: string, fingerprint: string) => void;
  setNeedsRestore: (v: boolean) => void;
  setBackupUpdatedAt: (at: string | null) => void;
  setBackupEnabled: (v: boolean) => void;
  setRecovering: (v: boolean) => void;
  setPendingApproval: (p: PendingApproval | null) => void;
};

export type SessionState = SessionData & SessionActions;

export const useSessionStore = create<SessionState>((set) => ({
  socket: null,
  status: "connecting",
  latencyMs: null,
  userId: "",
  user: deriveUser(""),
  deviceId: null,
  fingerprint: null,
  needsRestore: false,
  backupUpdatedAt: null,
  backupEnabled: false,
  recovering: false,
  pendingApproval: null,

  setSocket: (socket) => set({ socket }),
  setStatus: (status) => set({ status }),
  setLatencyMs: (latencyMs) => set({ latencyMs }),
  setIdentity: (userId, user) => set({ userId, user }),
  setDevice: (deviceId, fingerprint) => set({ deviceId, fingerprint }),
  setNeedsRestore: (needsRestore) => set({ needsRestore }),
  setBackupUpdatedAt: (backupUpdatedAt) => set({ backupUpdatedAt }),
  setBackupEnabled: (backupEnabled) => set({ backupEnabled }),
  setRecovering: (recovering) => set({ recovering }),
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),
}));

/** Read session state outside React (crypto paths, socket handlers, timers). */
export const session = () => useSessionStore.getState();
