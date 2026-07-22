"use client";

// 1:1 voice/video calls over WebRTC. This context owns the whole call state
// machine — one call at a time, fixed roles (the caller creates the offer, the
// callee answers), trickle ICE relayed through the Socket.IO server (see the
// call:* handlers in server.ts). Media flows peer-to-peer over DTLS-SRTP; the
// server only ever sees the signaling blobs. Camera/mic toggles flip
// track.enabled, so no renegotiation is ever needed and both sides' tracks are
// fixed at call setup.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { type User, deriveUser } from "@/lib/chat-data";
import type {
  CallAnswerRelay,
  CallEndRelay,
  CallInviteRelay,
  CallSignalRelay,
} from "@/lib/socket-events";
import { useChat } from "./chat-context";
import { useSocket } from "./socket-context";

/** outgoing → (peer accepts) → connecting → (ICE connects) → active.
 *  incoming → (we accept)   → connecting → (ICE connects) → active. */
export type CallPhase = "outgoing" | "incoming" | "connecting" | "active";

export type CallInfo = {
  callId: string;
  /** The VIEWER's DM channel id for this conversation ("" if not resolvable —
   *  display/navigation only, never used for signaling). */
  channelId: string;
  peerId: string;
  peer: User;
  video: boolean;
  phase: CallPhase;
  /** Epoch-ms when the connection came up; drives the in-call timer. */
  startedAt: number | null;
};

type CallContextValue = {
  call: CallInfo | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  /** Ring the DM peer of `channelId`. `video` = camera call vs voice-only. */
  startCall: (channelId: string, video: boolean) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  /** Hang up (active) or cancel (still ringing). */
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

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { socket, userId } = useSocket();
  const { channels, workspaceMembers } = useChat();

  const [call, setCall] = useState<CallInfo | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  // Handlers read call state through refs so the socket listeners (registered
  // once per socket) never see stale closures.
  const callRef = useRef<CallInfo | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // ICE candidates that arrived before the remote description was set.
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelsRef = useRef(channels);
  const membersRef = useRef(workspaceMembers);
  useEffect(() => {
    channelsRef.current = channels;
    membersRef.current = workspaceMembers;
  }, [channels, workspaceMembers]);

  const setCallBoth = useCallback((c: CallInfo | null) => {
    callRef.current = c;
    setCall(c);
  }, []);

  // Best display identity for a peer: their DM partner entry (profile name +
  // color), else the workspace roster, else derived from the id.
  const resolvePeer = useCallback((peerId: string): User => {
    for (const ch of Object.values(channelsRef.current)) {
      if (ch.type === "dm" && ch.user?.id === peerId) return ch.user;
    }
    return membersRef.current.find((u) => u.id === peerId) ?? deriveUser(peerId);
  }, []);

  /** The viewer's own DM channel with `peerId` (DM ids aren't symmetric, so
   *  the caller's channelId is useless to the callee). */
  const resolveOwnDmChannel = useCallback((peerId: string): string => {
    for (const [id, ch] of Object.entries(channelsRef.current)) {
      if (ch.type === "dm" && ch.user?.id === peerId) return id;
    }
    return "";
  }, []);

  const clearRingTimer = useCallback(() => {
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    clearRingTimer();
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    pendingIceRef.current = [];
    setLocalStream(null);
    setRemoteStream(null);
    setMicOn(true);
    setCamOn(true);
    setCallBoth(null);
  }, [clearRingTimer, setCallBoth]);

  const sendSignal = useCallback(
    (toUserId: string, callId: string, msg: SignalMsg) => {
      socket?.emit("call:signal", {
        callId,
        toUserId,
        data: JSON.stringify(msg),
      });
    },
    [socket],
  );

  const endCall = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    socket?.emit("call:end", {
      callId: c.callId,
      toUserId: c.peerId,
      reason: c.phase === "outgoing" ? "cancelled" : "ended",
    });
    if (c.phase === "active") toast("Call ended");
    teardown();
  }, [socket, teardown]);
  const endCallRef = useRef(endCall);

  const createPeer = useCallback(
    (peerId: string, callId: string, stream: MediaStream) => {
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      pcRef.current = pc;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendSignal(peerId, callId, {
            type: "ice",
            candidate: e.candidate.toJSON(),
          });
        }
      };
      pc.ontrack = (e) => {
        const s = e.streams[0] ?? new MediaStream([e.track]);
        setRemoteStream(s);
      };
      pc.onconnectionstatechange = () => {
        if (callRef.current?.callId !== callId || pcRef.current !== pc) return;
        if (pc.connectionState === "connected") {
          const c = callRef.current;
          setCallBoth({
            ...c,
            phase: "active",
            startedAt: c.startedAt ?? Date.now(),
          });
        } else if (pc.connectionState === "failed") {
          toast.error("Call connection lost");
          endCallRef.current();
        }
      };
      return pc;
    },
    [sendSignal, setCallBoth],
  );

  // --- caller side -----------------------------------------------------------

  const startCall = useCallback(
    async (channelId: string, video: boolean) => {
      if (callRef.current) {
        toast.error("You're already in a call");
        return;
      }
      if (!socket) return;
      const ch = channelsRef.current[channelId];
      const peerId = ch?.user?.id ?? channelId;
      const peer = ch?.user ?? resolvePeer(peerId);
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
      const callId = crypto.randomUUID();
      localStreamRef.current = stream;
      setLocalStream(stream);
      setCallBoth({
        callId,
        channelId,
        peerId,
        peer,
        video,
        phase: "outgoing",
        startedAt: null,
      });
      socket.timeout(8000).emit("call:invite", { callId, channelId, video }, (err, res) => {
        if (callRef.current?.callId !== callId) return;
        if (err || !res?.ok) {
          const reason = !err && res && !res.ok ? res.reason : "error";
          toast.error(
            reason === "offline"
              ? `${peer.name} isn't online right now`
              : "Couldn't start the call",
          );
          teardown();
        }
      });
      ringTimerRef.current = setTimeout(() => {
        const c = callRef.current;
        if (c?.callId === callId && c.phase === "outgoing") {
          socket.emit("call:end", { callId, toUserId: peerId, reason: "timeout" });
          toast(`${peer.name} didn't answer`);
          teardown();
        }
      }, RING_TIMEOUT_MS);
    },
    [socket, resolvePeer, setCallBoth, teardown],
  );

  // Peer accepted or declined our ringing invite.
  const onAnswer = useCallback(
    async ({ callId, fromUserId, accept }: CallAnswerRelay) => {
      const c = callRef.current;
      if (
        !c ||
        c.callId !== callId ||
        fromUserId !== c.peerId ||
        c.phase !== "outgoing"
      )
        return;
      clearRingTimer();
      if (!accept) {
        toast(`${c.peer.name} declined the call`);
        teardown();
        return;
      }
      const stream = localStreamRef.current;
      if (!stream) return teardown();
      setCallBoth({ ...c, phase: "connecting" });
      const pc = createPeer(c.peerId, callId, stream);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(c.peerId, callId, { type: "offer", sdp: offer.sdp });
      } catch (err) {
        console.warn("[call] offer failed", err);
        endCallRef.current();
      }
    },
    [clearRingTimer, createPeer, sendSignal, setCallBoth, teardown],
  );

  // --- callee side -----------------------------------------------------------

  const onInvite = useCallback(
    ({ callId, fromUserId, video }: CallInviteRelay) => {
      if (callRef.current) {
        // Already ringing or on a call — auto-decline as busy (unless it's a
        // duplicate relay of the call we're already showing).
        if (callRef.current.callId !== callId) {
          socket?.emit("call:end", { callId, toUserId: fromUserId, reason: "busy" });
        }
        return;
      }
      setCallBoth({
        callId,
        channelId: resolveOwnDmChannel(fromUserId),
        peerId: fromUserId,
        peer: resolvePeer(fromUserId),
        video,
        phase: "incoming",
        startedAt: null,
      });
      ringTimerRef.current = setTimeout(() => {
        const c = callRef.current;
        if (c?.callId === callId && c.phase === "incoming") {
          toast(`Missed ${c.video ? "video" : "voice"} call from ${c.peer.name}`);
          teardown();
        }
      }, RING_TIMEOUT_MS);
    },
    [socket, resolveOwnDmChannel, resolvePeer, setCallBoth, teardown],
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
      socket.emit("call:answer", {
        callId: c.callId,
        toUserId: c.peerId,
        accept: false,
      });
      teardown();
      return;
    }
    // The caller may have hung up while the permission prompt was open.
    if (callRef.current?.callId !== c.callId) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    localStreamRef.current = stream;
    setLocalStream(stream);
    // Our peer connection waits for the caller's offer (see onSignal).
    createPeer(c.peerId, c.callId, stream);
    setCallBoth({ ...c, phase: "connecting" });
    socket.emit("call:answer", {
      callId: c.callId,
      toUserId: c.peerId,
      accept: true,
    });
  }, [socket, clearRingTimer, createPeer, setCallBoth, teardown]);

  const declineCall = useCallback(() => {
    const c = callRef.current;
    if (!c || c.phase !== "incoming") return;
    socket?.emit("call:answer", {
      callId: c.callId,
      toUserId: c.peerId,
      accept: false,
    });
    teardown();
  }, [socket, teardown]);

  // --- both sides ------------------------------------------------------------

  const onSignal = useCallback(
    async ({ callId, fromUserId, data }: CallSignalRelay) => {
      const c = callRef.current;
      const pc = pcRef.current;
      if (!c || !pc || c.callId !== callId || fromUserId !== c.peerId) return;
      let msg: SignalMsg;
      try {
        msg = JSON.parse(data) as SignalMsg;
      } catch {
        return;
      }
      try {
        if (msg.type === "offer") {
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          for (const cand of pendingIceRef.current.splice(0)) {
            await pc.addIceCandidate(cand);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(c.peerId, callId, { type: "answer", sdp: answer.sdp });
        } else if (msg.type === "answer") {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          for (const cand of pendingIceRef.current.splice(0)) {
            await pc.addIceCandidate(cand);
          }
        } else if (msg.type === "ice" && msg.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
          else pendingIceRef.current.push(msg.candidate);
        }
      } catch (err) {
        console.warn("[call] signaling failed", err);
      }
    },
    [sendSignal],
  );

  const onEnd = useCallback(
    ({ callId, fromUserId, reason }: CallEndRelay) => {
      const c = callRef.current;
      if (!c || c.callId !== callId) return;
      // "handled" comes from OUR other device that answered/declined this
      // ring; everything else must come from the call's peer.
      if (reason === "handled") {
        if (fromUserId !== userId || c.phase !== "incoming") return;
      } else if (fromUserId !== c.peerId) {
        return;
      }
      if (reason === "busy") toast(`${c.peer.name} is on another call`);
      else if (reason === "cancelled" || reason === "timeout") {
        if (c.phase === "incoming") {
          toast(`Missed ${c.video ? "video" : "voice"} call from ${c.peer.name}`);
        }
      } else if (reason === "ended" && (c.phase === "active" || c.phase === "connecting")) {
        toast("Call ended");
      }
      teardown();
    },
    [userId, teardown],
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

  const handlersRef = useRef({ onInvite, onAnswer, onSignal, onEnd });
  useEffect(() => {
    handlersRef.current = { onInvite, onAnswer, onSignal, onEnd };
    endCallRef.current = endCall;
  });

  useEffect(() => {
    if (!socket) return;
    const invite = (p: CallInviteRelay) => handlersRef.current.onInvite(p);
    const answer = (p: CallAnswerRelay) => void handlersRef.current.onAnswer(p);
    const signal = (p: CallSignalRelay) => void handlersRef.current.onSignal(p);
    const end = (p: CallEndRelay) => handlersRef.current.onEnd(p);
    socket.on("call:invite", invite);
    socket.on("call:answer", answer);
    socket.on("call:signal", signal);
    socket.on("call:end", end);
    return () => {
      socket.off("call:invite", invite);
      socket.off("call:answer", answer);
      socket.off("call:signal", signal);
      socket.off("call:end", end);
    };
  }, [socket]);

  return (
    <CallContext.Provider
      value={{
        call,
        localStream,
        remoteStream,
        micOn,
        camOn,
        startCall,
        acceptCall,
        declineCall,
        endCall,
        toggleMic,
        toggleCam,
      }}
    >
      {children}
    </CallContext.Provider>
  );
}
