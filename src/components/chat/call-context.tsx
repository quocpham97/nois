"use client";

// Voice/video calls, 1:1 and group. This context owns the whole call state
// machine — phases, the participant roster, ring timeouts, device migration and
// the thread record — but NOT how media gets between people. That sits behind
// `CallTransport` (call-transport.ts), which today is a full mesh of
// RTCPeerConnections and could be an SFU without this file changing much.
//
// The server only ever relays signaling blobs (see the call:* handlers in
// server.ts); with the mesh transport it never touches media at all.
//
// A DM call is just a mesh of one peer: there is a single engine here, not a 1:1
// path plus a group path.
//
// The invariant to keep in mind when editing: signaling is addressed per DEVICE.
// Two devices of one user must never both be treated as "the peer" (see
// docs/group-calls-plan.md). The glare rule that goes with it — incumbents
// offer, joiners answer — is enforced by the `offering` argument to `addPeer`.
//
// Camera/mic toggles flip track.enabled, so no renegotiation is ever needed and
// every peer's tracks are fixed at setup.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  type CallEvent,
  type User,
  deriveUser,
  formatCallDuration,
} from "@/lib/chat-data";
import type {
  CallDeclinedRelay,
  CallHandledRelay,
  CallInviteRelay,
  CallJoinedRelay,
  CallKickedRelay,
  CallLeftRelay,
  CallOngoingRelay,
  CallOverRelay,
  CallPeer,
  CallSignalRelay,
  IceServersResult,
} from "@/lib/socket-events";
import {
  type CallTransport,
  type SignalMsg,
  type TransportEvents,
  createMeshTransport,
} from "./call-transport";
import { type SfuApi, createSfuTransport } from "./call-transport-sfu";
import {
  type FrameCrypto,
  createFrameCrypto,
  frameCryptoSupported,
} from "./call-frame-crypto";
import { useChat } from "./chat-context";
import { useSocket } from "./socket-context";

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

type CallContextValue = {
  call: CallInfo | null;
  localStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  /** Live calls we could join, by groupId. */
  ongoing: Record<string, OngoingCall>;
  /** Start a call in a DM or group. `video` is ignored in groups too large for
   *  the video cap (the server decides; the UI hides the button). */
  startCall: (groupId: string, video: boolean) => Promise<void>;
  /** Answer the ringing invite. */
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  /** Join a call already in progress (the conversation's join banner). */
  joinOngoing: (groupId: string) => Promise<void>;
  /** Leave (active) or cancel/hang up (still ringing). */
  endCall: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}

/** How long an unanswered call rings before it's treated as missed. */
const RING_TIMEOUT_MS = 45_000;

// Public STUN is enough for most NATs; symmetric NATs need a TURN relay. A mesh
// multiplies the NAT failure modes, so TURN matters more here than it did for
// 1:1.
//
// TURN credentials come from the SERVER (`ice:servers`), not from this bundle —
// Cloudflare issues short-lived ones only, and a static credential shipped in
// the JavaScript is an open relay for anyone who opens devtools. The
// NEXT_PUBLIC_* vars below are the fallback for deployments pointed at a
// provider with static credentials (e.g. ExpressTURN, self-hosted coturn), and
// they keep those working unchanged. See docs/calls-production.md.
const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** Route media through the SFU instead of a peer mesh. OFF by default and
 *  deliberately build-time, because this is not a user-facing setting: until
 *  phase D (per-frame E2EE) the SFU can see media, so turning this on trades
 *  the product's central promise for participant headroom. */
const SFU_ENABLED = process.env.NEXT_PUBLIC_CALL_TRANSPORT === "sfu";

/** A browser that can't do Encoded Transform can't seal frames, and an SFU call
 *  it couldn't seal would be a call the server can read. There is no downgrade
 *  path on purpose — refuse, and say why. */
function sfuUnavailable(): boolean {
  if (!SFU_ENABLED || frameCryptoSupported()) return false;
  toast.error("This browser can't encrypt call media — calls need a newer version");
  return true;
}

function envIceServers(): RTCIceServer[] {
  const turn = process.env.NEXT_PUBLIC_TURN_URL;
  if (!turn) return STUN_ONLY;
  return [
    ...STUN_ONLY,
    {
      urls: turn,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    },
  ];
}

const getMedia = (video: boolean): Promise<MediaStream> =>
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { socket, userId, deviceId } = useSocket();
  const { groups, workspaceMembers, logCallEvent, exportCallKey } = useChat();

  const [call, setCall] = useState<CallInfo | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [ongoing, setOngoing] = useState<Record<string, OngoingCall>>({});

  // Handlers read call state through refs so the socket listeners (registered
  // once per socket) never see stale closures.
  const callRef = useRef<CallInfo | null>(null);
  const transportRef = useRef<CallTransport | null>(null);
  const frameCryptoRef = useRef<FrameCrypto | null>(null);
  /** Epochs already handed to the worker, so re-deriving is idempotent. */
  const keyEpochsRef = useRef<Set<number>>(new Set());
  const localStreamRef = useRef<MediaStream | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupsRef = useRef(groups);
  const membersRef = useRef(workspaceMembers);
  const deviceIdRef = useRef(deviceId);
  useEffect(() => {
    groupsRef.current = groups;
    membersRef.current = workspaceMembers;
    deviceIdRef.current = deviceId;
  }, [groups, workspaceMembers, deviceId]);

  // Server-minted ICE servers, held until they near expiry. Resolved BEFORE a
  // call is placed or joined, because the transport is built with them — an
  // RTCPeerConnection's ICE config is fixed at construction, so arriving late
  // would mean a peer built without TURN.
  const iceRef = useRef<{ servers: RTCIceServer[]; expiresAt: number } | null>(null);

  const ensureIceServers = useCallback(async (): Promise<void> => {
    if (!socket) return;
    const cached = iceRef.current;
    if (cached && cached.expiresAt > Date.now()) return;
    const res = await new Promise<IceServersResult | null>((resolve) => {
      socket.timeout(5000).emit("ice:servers", (err, r) => resolve(err ? null : r));
    });
    // No credentials is a DEGRADED call (build-time vars, else STUN only), not
    // a failed one — placing the call must never block on this.
    if (!res?.iceServers.length) return;
    iceRef.current = {
      servers: res.iceServers as RTCIceServer[],
      expiresAt: Date.now() + Math.max(res.ttl, 30) * 1000,
    };
  }, [socket]);

  // Warm the cache on connect so the common case pays no round trip at call time.
  useEffect(() => {
    void ensureIceServers();
  }, [ensureIceServers]);

  const setCallBoth = useCallback((c: CallInfo | null) => {
    callRef.current = c;
    setCall(c);
  }, []);

  /** Patch the live call (no-op if it's already gone or a different call). */
  const patchCall = useCallback(
    (callId: string, patch: Partial<CallInfo> | ((c: CallInfo) => Partial<CallInfo>)) => {
      const c = callRef.current;
      if (!c || c.callId !== callId) return;
      const next = { ...c, ...(typeof patch === "function" ? patch(c) : patch) };
      callRef.current = next;
      setCall(next);
    },
    [],
  );

  // Best display identity for a user: their DM partner entry (profile name +
  // colour), else the workspace roster, else derived from the id.
  const resolveUser = useCallback((id: string): User => {
    for (const ch of Object.values(groupsRef.current)) {
      if (ch.type === "dm" && ch.user?.id === id) return ch.user;
    }
    return membersRef.current.find((u) => u.id === id) ?? deriveUser(id);
  }, []);

  /** What the call UI calls this conversation. */
  const titleFor = useCallback(
    (groupId: string, starterId: string): string => {
      const ch = groupsRef.current[groupId];
      if (!ch) return resolveUser(starterId).name;
      if (ch.type === "dm") return ch.user?.name ?? ch.name;
      return ch.name;
    },
    [resolveUser],
  );

  const clearRingTimer = useCallback(() => {
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    clearRingTimer();
    transportRef.current?.close();
    transportRef.current = null;
    frameCryptoRef.current?.close();
    frameCryptoRef.current = null;
    keyEpochsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setMicOn(true);
    setCamOn(true);
    setCallBoth(null);
  }, [clearRingTimer, setCallBoth]);

  // --- thread record ----------------------------------------------------------
  // Every finished call leaves one row in its conversation, written by the side
  // that STARTED it (see docs/calls.md). Caller-only keeps it to exactly one row
  // even though every participant observes the same hang-up, and a call missed
  // while the callee was offline still reaches them.
  const loggedCallsRef = useRef<Set<string>>(new Set());

  const recordCall = useCallback(
    (c: CallInfo, status: CallEvent["status"]) => {
      if (!c.outgoing || !c.groupId) return;
      if (loggedCallsRef.current.has(c.callId)) return;
      loggedCallsRef.current.add(c.callId);
      const mode = c.video ? "video" : "voice";
      // "answered" means media actually came up: an invite someone accepted but
      // that never connected is a no-answer, not a 0:00 conversation.
      const startedAt = c.startedAt;
      // Groups record how many were on the call; a DM's "2" is not worth saying.
      const joined = c.kind === "group" && c.peak > 1 ? { joined: c.peak } : {};
      if (status === "answered" && startedAt !== null) {
        logCallEvent(c.groupId, {
          mode,
          status: "answered",
          duration: formatCallDuration((Date.now() - startedAt) / 1000),
          ...joined,
        });
        return;
      }
      logCallEvent(c.groupId, {
        mode,
        status: status === "declined" ? "declined" : "unanswered",
        ...joined,
      });
    },
    [logCallEvent],
  );

  const sendSignal = useCallback(
    (toDeviceId: string, callId: string, msg: SignalMsg) => {
      socket?.emit("call:signal", {
        callId,
        toDeviceId,
        data: JSON.stringify(msg),
      });
    },
    [socket],
  );

  /** Leave the call: tell the room, write the record if we own it, tear down. */
  const endCall = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    if (c.phase !== "incoming") {
      socket?.emit("call:leave", { callId: c.callId, groupId: c.groupId });
    } else {
      socket?.emit("call:decline", {
        callId: c.callId,
        groupId: c.groupId,
        reason: "declined",
      });
    }
    if (c.phase === "active") toast("Call ended");
    recordCall(c, c.phase === "active" ? "answered" : "unanswered");
    teardown();
  }, [socket, recordCall, teardown]);
  const endCallRef = useRef(endCall);

  // --- media transport --------------------------------------------------------

  /**
   * Feed the frame-crypto worker the current epoch's media key.
   *
   * Called at call start and then periodically, which is how rekeying works:
   * the key follows the group's MLS EPOCH, not the call roster. A call joiner
   * is already a member and derives it themselves; the person who must be
   * locked out is one REMOVED from the group, and that removal is exactly what
   * advances the epoch. Frames carry their epoch, and the worker keeps the
   * previous key briefly so media in flight across a commit still opens.
   */
  const pumpKeys = useCallback(
    async (callId: string, groupId: string) => {
      const fc = frameCryptoRef.current;
      if (!fc) return;
      const derived = await exportCallKey(groupId, callId);
      if (!derived) {
        // No MLS state means no key agreement, so there is no safe way to run
        // this call through a server. Refuse rather than fall back in the clear.
        if (callRef.current?.callId === callId) {
          toast.error("This conversation can't hold an encrypted group call");
          endCallRef.current();
        }
        return;
      }
      if (keyEpochsRef.current.has(derived.epoch)) return;
      keyEpochsRef.current.add(derived.epoch);
      fc.addKey(derived.epoch, derived.key);
    },
    [exportCallKey],
  );

  /** The socket-backed proxy the SFU transport calls. Every request is scoped
   *  to a call the server can see us in, and the Cloudflare app token stays on
   *  the server — it is app-wide, so it could never be handed to a browser. */
  const sfuApi = useCallback(
    (callId: string, groupId: string): SfuApi => {
      const scope = { callId, groupId };
      const warn = (reason: string) => {
        console.warn("[call] sfu request failed:", reason);
        if (reason === "unconfigured") {
          toast.error("This deployment has no SFU configured");
        }
      };
      return {
        session: () =>
          new Promise((resolve) => {
            if (!socket) return resolve(null);
            socket.timeout(10_000).emit("sfu:session", scope, (err, res) => {
              if (err || !res || !res.ok) {
                warn(!err && res && !res.ok ? res.reason : "timeout");
                return resolve(null);
              }
              resolve(res.sessionId);
            });
          }),
        tracks: (sessionId, body) =>
          new Promise((resolve) => {
            if (!socket) return resolve(null);
            socket
              .timeout(10_000)
              .emit("sfu:tracks", { ...scope, sessionId, body }, (err, res) => {
                if (err || !res || !res.ok) {
                  warn(!err && res && !res.ok ? res.reason : "timeout");
                  return resolve(null);
                }
                resolve(res.result);
              });
          }),
        renegotiate: (sessionId, sessionDescription) =>
          new Promise((resolve) => {
            if (!socket) return resolve(false);
            socket
              .timeout(10_000)
              .emit(
                "sfu:renegotiate",
                { ...scope, sessionId, body: { sessionDescription } },
                (err, res) => resolve(!err && !!res?.ok),
              );
          }),
        closeTracks: (sessionId, mids) => {
          socket?.emit("sfu:close", {
            ...scope,
            sessionId,
            body: { tracks: mids.map((mid) => ({ mid })), force: false },
          });
        },
      };
    },
    [socket],
  );

  /** Build the media layer for one call and wire its events into call state.
   *  Swapping the mesh for an SFU is swapping the factory called here — see
   *  call-transport.ts. `patchCall` no-ops once the call is gone or replaced,
   *  so a straggling event from a torn-down transport can't touch a later call. */
  const openTransport = useCallback(
    (callId: string, groupId: string, stream: MediaStream): CallTransport => {
      transportRef.current?.close();
      const common: {
        localStream: MediaStream;
        iceServers: RTCIceServer[];
        events: TransportEvents;
      } = {
        localStream: stream,
        iceServers: iceRef.current?.servers ?? envIceServers(),
        events: {
          sendSignal: (toDeviceId, msg) => sendSignal(toDeviceId, callId, msg),
          onStream: (deviceId, remote) =>
            patchCall(callId, (c) => ({
              participants: c.participants.map((p) =>
                p.deviceId === deviceId ? { ...p, stream: remote } : p,
              ),
            })),
          onConnected: (deviceId) =>
            patchCall(callId, (c) => ({
              phase: "active",
              startedAt: c.startedAt ?? Date.now(),
              participants: c.participants.map((p) =>
                p.deviceId === deviceId ? { ...p, connected: true } : p,
              ),
            })),
          onFailed: (deviceId) => {
            // One leg failing is not the whole call failing — drop that peer
            // and keep talking to everyone else. If it was the last one, end.
            patchCall(callId, (c) => ({
              participants: c.participants.filter((p) => p.deviceId !== deviceId),
            }));
            const c = callRef.current;
            if (c?.callId === callId && c.participants.length === 0) {
              toast.error("Call connection lost");
              endCallRef.current();
            }
          },
        },
      };
      // The one line that chooses how media travels. Default is the mesh,
      // where media never reaches a server at all; the SFU pairs with
      // per-frame encryption so it can forward what it cannot read.
      if (!SFU_ENABLED) {
        const transport = createMeshTransport(common);
        transportRef.current = transport;
        return transport;
      }
      const frameCrypto = createFrameCrypto();
      frameCryptoRef.current = frameCrypto;
      // Keys arrive a moment later; frames sent before then fail to seal and
      // are dropped by the worker rather than sent in the clear.
      void pumpKeys(callId, groupId);
      const transport = createSfuTransport({
        ...common,
        api: sfuApi(callId, groupId),
        frameCrypto,
      });
      transportRef.current = transport;
      return transport;
    },
    [sendSignal, patchCall, sfuApi, pumpKeys],
  );

  // Rekey while a call is up. Polling rather than subscribing to MLS commits:
  // the check is a cheap read of state we already hold, and it self-heals if a
  // commit lands while we're mid-call regardless of how it got there.
  const activeCallId = call?.callId;
  const activeGroupId = call?.groupId;
  useEffect(() => {
    if (!SFU_ENABLED || !activeCallId || !activeGroupId) return;
    const id = setInterval(() => void pumpKeys(activeCallId, activeGroupId), 5000);
    return () => clearInterval(id);
  }, [activeCallId, activeGroupId, pumpKeys]);

  /** Add a participant row (idempotent) and keep the peak count. */
  const addParticipant = useCallback(
    (callId: string, peer: CallPeer) => {
      patchCall(callId, (c) => {
        if (c.participants.some((p) => p.deviceId === peer.deviceId)) return {};
        const participants = [
          ...c.participants,
          {
            userId: peer.userId,
            deviceId: peer.deviceId,
            user: resolveUser(peer.userId),
            stream: null,
            connected: false,
          },
        ];
        return {
          participants,
          peak: Math.max(c.peak, participants.length + 1),
          phase: c.phase === "outgoing" ? "connecting" : c.phase,
        };
      });
    },
    [patchCall, resolveUser],
  );

  /** Someone joined a call we're already in → we offer to them. */
  const onJoined = useCallback(
    async ({ callId, userId: joinerId, deviceId: joinerDevice }: CallJoinedRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId || !joinerDevice) return;
      if (joinerDevice === deviceIdRef.current) return; // our own echo
      clearRingTimer();
      addParticipant(callId, { userId: joinerId, deviceId: joinerDevice });
      // We were already here, so we offer — the joiner only ever answers.
      await transportRef.current?.addPeer(joinerDevice, joinerId, true);
    },
    [addParticipant, clearRingTimer],
  );

  const onLeft = useCallback(
    ({ callId, deviceId: goneDevice }: CallLeftRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId) return;
      transportRef.current?.removePeer(goneDevice);
      const remaining = c.participants.filter((p) => p.deviceId !== goneDevice);
      patchCall(callId, { participants: remaining });
      // Last peer out ends the call for us too.
      if (remaining.length === 0 && c.phase !== "incoming") {
        const latest = callRef.current;
        if (latest) {
          if (latest.phase === "active") toast("Call ended");
          recordCall(latest, latest.phase === "active" ? "answered" : "unanswered");
        }
        socket?.emit("call:leave", { callId, groupId: c.groupId });
        teardown();
      }
    },
    [patchCall, recordCall, socket, teardown],
  );

  // --- signaling -------------------------------------------------------------

  const onSignal = useCallback(
    async ({ callId, fromUserId, fromDeviceId, data }: CallSignalRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId || !fromDeviceId) return;
      let msg: SignalMsg;
      try {
        msg = JSON.parse(data) as SignalMsg;
      } catch {
        return;
      }
      // First contact from a device we don't know yet means we're the joiner
      // (or the roster event is still in flight) — give it a tile. Idempotent,
      // and the transport sets itself up for the same reason. `offer` is the
      // mesh's first contact; `sfu-hello` is the SFU's.
      if (msg.type === "offer" || msg.type === "sfu-hello") {
        addParticipant(callId, { userId: fromUserId, deviceId: fromDeviceId });
      }
      await transportRef.current?.handleSignal(fromDeviceId, fromUserId, msg);
    },
    [addParticipant],
  );

  // --- starting / joining ----------------------------------------------------

  const startCall = useCallback(
    async (groupId: string, video: boolean) => {
      if (callRef.current) {
        toast.error("You're already in a call");
        return;
      }
      if (!socket || sfuUnavailable()) return;
      // Fetched alongside the permission prompt rather than before it, so a
      // cold credential cache costs nothing the user can perceive.
      const ice = ensureIceServers();
      const ch = groupsRef.current[groupId];
      let stream: MediaStream;
      try {
        stream = await getMedia(video);
      } catch {
        toast.error(
          video
            ? "Camera or microphone unavailable — check permissions"
            : "Microphone unavailable — check permissions",
        );
        return;
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      const me = resolveUser(userId);
      await ice;
      socket
        .timeout(8000)
        .emit("call:start", { groupId, video }, (err, res) => {
          if (err || !res?.ok) {
            const reason = !err && res && !res.ok ? res.reason : "error";
            toast.error(
              reason === "offline"
                ? ch?.type === "dm"
                  ? `${ch.user?.name ?? "They"} isn't online right now`
                  : "Nobody in this conversation is online right now"
                : reason === "unauthorized"
                  ? "You can't start a call here"
                  : "Couldn't start the call",
            );
            teardown();
            return;
          }
          // The server downgrades video in groups above the video cap; drop the
          // camera track so we don't hold the device for nothing.
          if (video && !res.video) {
            stream.getVideoTracks().forEach((t) => {
              t.stop();
              stream.removeTrack(t);
            });
          }
          setCallBoth({
            callId: res.callId,
            groupId,
            kind: ch?.type === "group" ? "group" : "dm",
            title: titleFor(groupId, userId),
            starterId: userId,
            starter: me,
            peer: ch?.type === "dm" ? (ch.user ?? null) : null,
            video: res.video,
            phase: "outgoing",
            outgoing: true,
            startedAt: null,
            participants: [],
            peak: 1,
          });
          // Ready before anyone can join: `call:joined` is what triggers our
          // offer, and it can land immediately. `start` only after the ack,
          // because the server authorizes SFU calls on call-room membership
          // and we are only in the room once `call:start` has succeeded.
          void openTransport(res.callId, groupId, stream).start();
          // Nobody rang (a huddle) → no ring timeout; the call just waits.
          if (res.ringing) {
            ringTimerRef.current = setTimeout(() => {
              const c = callRef.current;
              if (c?.callId === res.callId && c.participants.length === 0) {
                toast(
                  c.kind === "dm"
                    ? `${c.title} didn't answer`
                    : "Nobody joined the call",
                );
                socket.emit("call:leave", { callId: c.callId, groupId });
                recordCall(c, "unanswered");
                teardown();
              }
            }, RING_TIMEOUT_MS);
          }
        });
    },
    [
      socket,
      userId,
      resolveUser,
      titleFor,
      recordCall,
      setCallBoth,
      teardown,
      ensureIceServers,
      openTransport,
    ],
  );

  /** Shared by accepting a ring and joining an ongoing call from the banner. */
  const joinCall = useCallback(
    async (target: {
      callId: string;
      groupId: string;
      video: boolean;
      starterId: string;
      /** Media we already hold (accepting a ring acquires it first). */
      stream?: MediaStream;
    }) => {
      if (!socket || sfuUnavailable()) return;
      const ice = ensureIceServers();
      const { callId, groupId, video, starterId } = target;
      let stream = target.stream ?? null;
      if (!stream) {
        try {
          stream = await getMedia(video);
        } catch {
          toast.error(
            video
              ? "Camera or microphone unavailable — check permissions"
              : "Microphone unavailable — check permissions",
          );
          return;
        }
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      const ch = groupsRef.current[groupId];
      // Incumbents offer the moment `call:joined` lands, so both the
      // credentials and the transport must be in place before we announce
      // ourselves — their offers can beat our own join ack.
      await ice;
      const transport = openTransport(callId, groupId, stream);
      socket.timeout(8000).emit("call:join", { callId, groupId }, (err, res) => {
        if (err || !res?.ok) {
          const reason = !err && res && !res.ok ? res.reason : "error";
          toast.error(
            reason === "full"
              ? "That call is full"
              : reason === "gone"
                ? "That call has ended"
                : reason === "unauthorized"
                  ? "You can't join that call"
                  : "Couldn't join the call",
          );
          teardown();
          return;
        }
        const participants = res.participants
          .filter((p) => p.deviceId && p.deviceId !== deviceIdRef.current)
          .map((p) => ({
            userId: p.userId,
            deviceId: p.deviceId,
            user: resolveUser(p.userId),
            stream: null,
            connected: false,
          }));
        setCallBoth({
          callId,
          groupId,
          kind: ch?.type === "group" ? "group" : "dm",
          title: titleFor(groupId, starterId),
          starterId,
          starter: resolveUser(starterId),
          peer: ch?.type === "dm" ? (ch.user ?? resolveUser(starterId)) : null,
          video: res.video && video,
          phase: "connecting",
          // Derived from the id, not from who clicked: a starter who migrates
          // devices keeps ownership of the thread record.
          outgoing: starterId === userId,
          startedAt: null,
          participants,
          peak: participants.length + 1,
        });
        // We are the joiner, so we do not offer — every incumbent offers to us.
        // The SFU is the exception and doesn't care: `start` publishes our own
        // media, which both sides do independently. It waits for the ack
        // because the server authorizes on call-room membership.
        void transport.start();
      });
    },
    [
      socket,
      userId,
      resolveUser,
      titleFor,
      setCallBoth,
      teardown,
      ensureIceServers,
      openTransport,
    ],
  );

  const acceptCall = useCallback(async () => {
    const c = callRef.current;
    if (!c || !socket || c.phase !== "incoming") return;
    clearRingTimer();
    let stream: MediaStream;
    try {
      stream = await getMedia(c.video);
    } catch {
      toast.error(
        c.video
          ? "Camera or microphone unavailable — check permissions"
          : "Microphone unavailable — check permissions",
      );
      socket.emit("call:decline", {
        callId: c.callId,
        groupId: c.groupId,
        reason: "declined",
      });
      teardown();
      return;
    }
    // The call may have ended while the permission prompt was open.
    if (callRef.current?.callId !== c.callId) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    await joinCall({
      callId: c.callId,
      groupId: c.groupId,
      video: c.video,
      starterId: c.starterId,
      stream,
    });
  }, [socket, clearRingTimer, joinCall, teardown]);

  const declineCall = useCallback(() => {
    const c = callRef.current;
    if (!c || c.phase !== "incoming") return;
    socket?.emit("call:decline", {
      callId: c.callId,
      groupId: c.groupId,
      reason: "declined",
    });
    teardown();
  }, [socket, teardown]);

  const joinOngoing = useCallback(
    async (groupId: string) => {
      if (callRef.current) {
        toast.error("You're already in a call");
        return;
      }
      const live = ongoing[groupId];
      if (!live) return;
      await joinCall({
        callId: live.callId,
        groupId,
        video: live.video,
        starterId: live.starterId,
      });
    },
    [ongoing, joinCall],
  );

  // --- inbound ring / roster events ------------------------------------------

  const onInvite = useCallback(
    ({ callId, groupId, fromUserId, video }: CallInviteRelay) => {
      if (callRef.current) {
        // Already ringing or on a call — auto-decline as busy (unless it's a
        // duplicate relay of the call we're already showing). A busy decline is
        // recorded as a decline, not a no-answer (see docs/calls.md).
        if (callRef.current.callId !== callId) {
          socket?.emit("call:decline", { callId, groupId, reason: "busy" });
        }
        return;
      }
      const starter = resolveUser(fromUserId);
      const ch = groupsRef.current[groupId];
      setCallBoth({
        callId,
        groupId,
        kind: ch?.type === "group" ? "group" : "dm",
        title: titleFor(groupId, fromUserId),
        starterId: fromUserId,
        starter,
        peer: ch?.type === "group" ? null : (ch?.user ?? starter),
        video,
        phase: "incoming",
        outgoing: false,
        startedAt: null,
        participants: [],
        peak: 0,
      });
      ringTimerRef.current = setTimeout(() => {
        const c = callRef.current;
        if (c?.callId === callId && c.phase === "incoming") {
          toast(`Missed ${c.video ? "video" : "voice"} call from ${starter.name}`);
          teardown();
        }
      }, RING_TIMEOUT_MS);
    },
    [socket, resolveUser, titleFor, setCallBoth, teardown],
  );

  /** Someone isn't joining. Only a DM records it — a single decline in a group
   *  says nothing about the call, which carries on without them. */
  const onDeclined = useCallback(
    ({ callId, userId: whoId, reason }: CallDeclinedRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId || whoId === userId) return;
      const who = resolveUser(whoId);
      if (c.kind === "dm") {
        toast(
          reason === "busy"
            ? `${who.name} is on another call`
            : `${who.name} declined the call`,
        );
        clearRingTimer();
        recordCall(c, "declined");
        socket?.emit("call:leave", { callId, groupId: c.groupId });
        teardown();
        return;
      }
      if (c.outgoing) {
        toast(
          reason === "busy"
            ? `${who.name} is on another call`
            : `${who.name} declined`,
        );
      }
    },
    [userId, resolveUser, clearRingTimer, recordCall, socket, teardown],
  );

  /** Another of our devices took (or refused) this ring — stop ringing here. */
  const onHandled = useCallback(
    ({ callId }: CallHandledRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId || c.phase !== "incoming") return;
      teardown();
    },
    [teardown],
  );

  /** We joined from another device, so this one is out. */
  const onKicked = useCallback(
    ({ callId }: CallKickedRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId) return;
      toast("Call moved to your other device");
      // No record: the call continues, and whichever device holds it now owns
      // the row (`outgoing` is derived from starterId, so it migrates too).
      loggedCallsRef.current.add(callId);
      teardown();
    },
    [teardown],
  );

  const onOngoing = useCallback((p: CallOngoingRelay) => {
    if (p.starterId === userId) return; // our own call — the call UI covers it
    setOngoing((s) => ({ ...s, [p.groupId]: p }));
  }, [userId]);

  const onOver = useCallback(
    ({ groupId, callId }: CallOverRelay) => {
      setOngoing((s) => {
        if (s[groupId]?.callId !== callId) return s;
        const next = { ...s };
        delete next[groupId];
        return next;
      });
      // Still ringing for a call that's now over (the starter gave up).
      const c = callRef.current;
      if (c?.callId === callId && c.phase === "incoming") {
        toast(`Missed ${c.video ? "video" : "voice"} call from ${c.starter.name}`);
        teardown();
      }
    },
    [teardown],
  );

  // --- controls ---------------------------------------------------------------

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setMicOn((on) => {
      stream.getAudioTracks().forEach((t) => (t.enabled = !on));
      return !on;
    });
  }, []);

  const toggleCam = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setCamOn((on) => {
      stream.getVideoTracks().forEach((t) => (t.enabled = !on));
      return !on;
    });
  }, []);

  // --- socket wiring -----------------------------------------------------------

  const handlersRef = useRef({
    onInvite,
    onJoined,
    onLeft,
    onDeclined,
    onHandled,
    onKicked,
    onOngoing,
    onOver,
    onSignal,
  });
  useEffect(() => {
    handlersRef.current = {
      onInvite,
      onJoined,
      onLeft,
      onDeclined,
      onHandled,
      onKicked,
      onOngoing,
      onOver,
      onSignal,
    };
    endCallRef.current = endCall;
  });

  useEffect(() => {
    if (!socket) return;
    const invite = (p: CallInviteRelay) => handlersRef.current.onInvite(p);
    const joined = (p: CallJoinedRelay) => void handlersRef.current.onJoined(p);
    const left = (p: CallLeftRelay) => handlersRef.current.onLeft(p);
    const declined = (p: CallDeclinedRelay) => handlersRef.current.onDeclined(p);
    const handled = (p: CallHandledRelay) => handlersRef.current.onHandled(p);
    const kicked = (p: CallKickedRelay) => handlersRef.current.onKicked(p);
    const live = (p: CallOngoingRelay) => handlersRef.current.onOngoing(p);
    const over = (p: CallOverRelay) => handlersRef.current.onOver(p);
    const signal = (p: CallSignalRelay) => void handlersRef.current.onSignal(p);
    socket.on("call:invite", invite);
    socket.on("call:joined", joined);
    socket.on("call:left", left);
    socket.on("call:declined", declined);
    socket.on("call:handled", handled);
    socket.on("call:kicked", kicked);
    socket.on("call:ongoing", live);
    socket.on("call:over", over);
    socket.on("call:signal", signal);
    return () => {
      socket.off("call:invite", invite);
      socket.off("call:joined", joined);
      socket.off("call:left", left);
      socket.off("call:declined", declined);
      socket.off("call:handled", handled);
      socket.off("call:kicked", kicked);
      socket.off("call:ongoing", live);
      socket.off("call:over", over);
      socket.off("call:signal", signal);
    };
  }, [socket]);

  return (
    <CallContext.Provider
      value={{
        call,
        localStream,
        micOn,
        camOn,
        ongoing,
        startCall,
        acceptCall,
        declineCall,
        joinOngoing,
        endCall,
        toggleMic,
        toggleCam,
      }}
    >
      {children}
    </CallContext.Provider>
  );
}
