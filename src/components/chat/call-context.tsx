"use client";

// Voice/video calls, 1:1 and group. This context owns the whole call state
// machine. Media is a full-mesh of RTCPeerConnections — one per remote DEVICE,
// no media server — so media stays peer-to-peer over DTLS-SRTP and the server
// only ever relays signaling blobs (see the call:* handlers in server.ts).
//
// A DM call is just a mesh of one peer: there is a single engine here, not a 1:1
// path plus a group path.
//
// Two invariants worth keeping in mind when editing:
//  - Signaling is addressed per DEVICE. Two devices of one user must never both
//    be treated as "the peer" (see docs/group-calls-plan.md).
//  - Exactly one side of each pair offers: whoever is ALREADY in the call offers
//    to a joiner, and the joiner only ever answers. That's what keeps a mesh
//    glare-free without any tie-breaking.
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
} from "@/lib/socket-events";
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

// Public STUN is enough for most NATs; symmetric NATs need a TURN relay —
// point NEXT_PUBLIC_TURN_URL (+ USERNAME/CREDENTIAL) at one to cover those.
// A mesh multiplies the NAT failure modes, so TURN matters more here than it
// did for 1:1.
function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turn = process.env.NEXT_PUBLIC_TURN_URL;
  if (turn) {
    servers.push({
      urls: turn,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

const getMedia = (video: boolean): Promise<MediaStream> =>
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });

/** Wire shape of a call:signal `data` blob. */
type SignalMsg =
  | { type: "offer" | "answer"; sdp?: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

/** Per-remote-device connection state. */
type PeerState = {
  pc: RTCPeerConnection;
  userId: string;
  /** Candidates that arrived before the remote description was set. */
  pendingIce: RTCIceCandidateInit[];
};

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { socket, userId, deviceId } = useSocket();
  const { groups, workspaceMembers, logCallEvent } = useChat();

  const [call, setCall] = useState<CallInfo | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [ongoing, setOngoing] = useState<Record<string, OngoingCall>>({});

  // Handlers read call state through refs so the socket listeners (registered
  // once per socket) never see stale closures.
  const callRef = useRef<CallInfo | null>(null);
  const peersRef = useRef<Map<string, PeerState>>(new Map());
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

  const closePeer = useCallback((peerDeviceId: string) => {
    const p = peersRef.current.get(peerDeviceId);
    if (!p) return;
    p.pc.close();
    peersRef.current.delete(peerDeviceId);
  }, []);

  const teardown = useCallback(() => {
    clearRingTimer();
    for (const [id] of peersRef.current) closePeer(id);
    peersRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setMicOn(true);
    setCamOn(true);
    setCallBoth(null);
  }, [clearRingTimer, closePeer, setCallBoth]);

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

  // --- mesh ------------------------------------------------------------------

  /** Create (or reuse) the connection to one remote device. `offering` marks us
   *  as the side that sends the offer — the incumbent, never the joiner. */
  const ensurePeer = useCallback(
    (peerDeviceId: string, peerUserId: string, callId: string): PeerState | null => {
      const existing = peersRef.current.get(peerDeviceId);
      if (existing) return existing;
      const stream = localStreamRef.current;
      if (!stream) return null;
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      const state: PeerState = { pc, userId: peerUserId, pendingIce: [] };
      peersRef.current.set(peerDeviceId, state);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendSignal(peerDeviceId, callId, {
            type: "ice",
            candidate: e.candidate.toJSON(),
          });
        }
      };
      pc.ontrack = (e) => {
        const s = e.streams[0] ?? new MediaStream([e.track]);
        patchCall(callId, (c) => ({
          participants: c.participants.map((p) =>
            p.deviceId === peerDeviceId ? { ...p, stream: s } : p,
          ),
        }));
      };
      pc.onconnectionstatechange = () => {
        if (callRef.current?.callId !== callId) return;
        if (peersRef.current.get(peerDeviceId)?.pc !== pc) return;
        if (pc.connectionState === "connected") {
          patchCall(callId, (c) => ({
            phase: "active",
            startedAt: c.startedAt ?? Date.now(),
            participants: c.participants.map((p) =>
              p.deviceId === peerDeviceId ? { ...p, connected: true } : p,
            ),
          }));
        } else if (pc.connectionState === "failed") {
          // One leg failing is not the whole call failing — drop that peer and
          // keep talking to everyone else. If it was the last one, end the call.
          closePeer(peerDeviceId);
          patchCall(callId, (c) => ({
            participants: c.participants.filter((p) => p.deviceId !== peerDeviceId),
          }));
          const c = callRef.current;
          if (c?.callId === callId && c.participants.length === 0) {
            toast.error("Call connection lost");
            endCallRef.current();
          }
        }
      };
      return state;
    },
    [sendSignal, patchCall, closePeer],
  );

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
      const state = ensurePeer(joinerDevice, joinerId, callId);
      if (!state) return;
      try {
        const offer = await state.pc.createOffer();
        await state.pc.setLocalDescription(offer);
        sendSignal(joinerDevice, callId, { type: "offer", sdp: offer.sdp });
      } catch (err) {
        console.warn("[call] offer failed", joinerDevice, err);
        closePeer(joinerDevice);
      }
    },
    [addParticipant, clearRingTimer, closePeer, ensurePeer, sendSignal],
  );

  const onLeft = useCallback(
    ({ callId, deviceId: goneDevice }: CallLeftRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId) return;
      closePeer(goneDevice);
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
    [closePeer, patchCall, recordCall, socket, teardown],
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
      // An offer from a device we don't know yet means we're the joiner (or the
      // roster event is still in flight) — set the peer up as the answerer.
      if (msg.type === "offer" && !peersRef.current.has(fromDeviceId)) {
        addParticipant(callId, { userId: fromUserId, deviceId: fromDeviceId });
        ensurePeer(fromDeviceId, fromUserId, callId);
      }
      const state = peersRef.current.get(fromDeviceId);
      if (!state) return;
      const { pc } = state;
      try {
        if (msg.type === "offer") {
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          for (const cand of state.pendingIce.splice(0)) {
            await pc.addIceCandidate(cand);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(fromDeviceId, callId, { type: "answer", sdp: answer.sdp });
        } else if (msg.type === "answer") {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          for (const cand of state.pendingIce.splice(0)) {
            await pc.addIceCandidate(cand);
          }
        } else if (msg.type === "ice" && msg.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
          else state.pendingIce.push(msg.candidate);
        }
      } catch (err) {
        console.warn("[call] signaling failed", fromDeviceId, err);
      }
    },
    [addParticipant, ensurePeer, sendSignal],
  );

  // --- starting / joining ----------------------------------------------------

  const startCall = useCallback(
    async (groupId: string, video: boolean) => {
      if (callRef.current) {
        toast.error("You're already in a call");
        return;
      }
      if (!socket) return;
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
    [socket, userId, resolveUser, titleFor, recordCall, setCallBoth, teardown],
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
      if (!socket) return;
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
      });
    },
    [socket, userId, resolveUser, titleFor, setCallBoth, teardown],
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
