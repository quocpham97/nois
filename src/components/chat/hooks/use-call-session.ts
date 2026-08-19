"use client";

/**
 * The call state machine: placing a call, joining one, answering or declining a
 * ring, leaving, and the mic/cam controls.
 *
 * Also the thread record — every finished call leaves one row in its
 * conversation, written by the side that STARTED it (see docs/calls.md).
 * Caller-only keeps it to exactly one row even though every participant observes
 * the same hang-up, and a call missed while the callee was offline still reaches
 * them.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { type CallEvent, formatCallDuration } from "@/lib/chat-data";
import { callState } from "@/stores/call-store";
import { chat } from "@/stores/chat-store";
import { frameCryptoSupported } from "../call-frame-crypto";
import type { TypedSocket } from "@/stores/session-store";
import { callKind, resolveUser, sfuFor, titleFor } from "../lib/call-identity";
import {
  type CallInfo,
  RING_TIMEOUT_MS,
  getMedia,
} from "../lib/call-types";
import type { CallIce } from "./use-call-ice";
import type { CallMedia } from "./use-call-media";

/**
 * A browser that can't do Encoded Transform can't seal frames, and an SFU call it
 * couldn't seal would be a call the server can read. There is no downgrade path on
 * purpose — refuse, and say why.
 *
 * Asked per call rather than per build, because a DM never reaches the SFU: its
 * media is peer-to-peer, so an old browser can still place one.
 */
function sfuUnavailable(usesSfu: boolean): boolean {
  if (!usesSfu || frameCryptoSupported()) return false;
  toast.error("This browser can't encrypt call media — calls need a newer version");
  return true;
}

const mediaDenied = (video: boolean) =>
  toast.error(
    video
      ? "Camera or microphone unavailable — check permissions"
      : "Microphone unavailable — check permissions",
  );

export type CallSession = ReturnType<typeof useCallSession>;

export function useCallSession({
  socket,
  userId,
  deviceId,
  ice,
  media,
  endCallRef,
  logCallEvent,
}: {
  socket: TypedSocket | null;
  userId: string;
  deviceId: string | null;
  ice: CallIce;
  media: CallMedia;
  endCallRef: React.RefObject<() => void>;
  logCallEvent: (groupId: string, call: CallEvent) => void;
}) {
  const { teardown, clearRingTimer, setLocalStream, openTransport, ringTimerRef } =
    media;

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

  /** Forget a call's record slot without writing one (device migration). */
  const suppressRecord = useCallback((callId: string) => {
    loggedCallsRef.current.add(callId);
  }, []);

  /** Leave the call: tell the room, write the record if we own it, tear down. */
  const endCall = useCallback(() => {
    const c = callState().call;
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

  const startCall = useCallback(
    async (groupId: string, video: boolean) => {
      if (callState().call) {
        toast.error("You're already in a call");
        return;
      }
      if (!socket || sfuUnavailable(sfuFor(groupId))) return;
      // Fetched alongside the permission prompt rather than before it, so a cold
      // credential cache costs nothing the user can perceive.
      const icePromise = ice.ensureIceServers();
      const ch = chat().groups[groupId];
      let stream: MediaStream;
      try {
        stream = await getMedia(video);
      } catch {
        mediaDenied(video);
        return;
      }
      setLocalStream(stream);
      const me = resolveUser(userId);
      await icePromise;
      socket.timeout(8000).emit("call:start", { groupId, video }, (err, res) => {
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
        callState().setCall({
          callId: res.callId,
          groupId,
          kind: callKind(groupId),
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
        // Ready before anyone can join: `call:joined` is what triggers our offer,
        // and it can land immediately. `start` only after the ack, because the
        // server authorizes SFU calls on call-room membership and we are only in
        // the room once `call:start` has succeeded.
        void openTransport(res.callId, groupId, stream).start();
        // Nobody rang (a huddle) → no ring timeout; the call just waits.
        if (res.ringing) {
          ringTimerRef.current = setTimeout(() => {
            const c = callState().call;
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
      ice,
      recordCall,
      teardown,
      setLocalStream,
      openTransport,
      ringTimerRef,
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
      if (!socket || sfuUnavailable(sfuFor(target.groupId))) return;
      const icePromise = ice.ensureIceServers();
      const { callId, groupId, video, starterId } = target;
      let stream = target.stream ?? null;
      if (!stream) {
        try {
          stream = await getMedia(video);
        } catch {
          mediaDenied(video);
          return;
        }
      }
      setLocalStream(stream);
      const ch = chat().groups[groupId];
      // Incumbents offer the moment `call:joined` lands, so both the credentials
      // and the transport must be in place before we announce ourselves — their
      // offers can beat our own join ack.
      await icePromise;
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
          .filter((p) => p.deviceId && p.deviceId !== deviceId)
          .map((p) => ({
            userId: p.userId,
            deviceId: p.deviceId,
            user: resolveUser(p.userId),
            stream: null,
            connected: false,
          }));
        callState().setCall({
          callId,
          groupId,
          kind: callKind(groupId),
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
        // media, which both sides do independently. It waits for the ack because
        // the server authorizes on call-room membership.
        void transport.start();
      });
    },
    [socket, userId, deviceId, ice, teardown, setLocalStream, openTransport],
  );

  const acceptCall = useCallback(async () => {
    const c = callState().call;
    if (!c || !socket || c.phase !== "incoming") return;
    clearRingTimer();
    let stream: MediaStream;
    try {
      stream = await getMedia(c.video);
    } catch {
      mediaDenied(c.video);
      socket.emit("call:decline", {
        callId: c.callId,
        groupId: c.groupId,
        reason: "declined",
      });
      teardown();
      return;
    }
    // The call may have ended while the permission prompt was open.
    if (callState().call?.callId !== c.callId) {
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
    const c = callState().call;
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
      if (callState().call) {
        toast.error("You're already in a call");
        return;
      }
      const live = callState().ongoing[groupId];
      if (!live) return;
      await joinCall({
        callId: live.callId,
        groupId,
        video: live.video,
        starterId: live.starterId,
      });
    },
    [joinCall],
  );

  // Camera/mic toggles flip track.enabled, so no renegotiation is ever needed and
  // every peer's tracks are fixed at setup.
  const toggleMic = useCallback(() => {
    const stream = media.localStreamRef.current;
    if (!stream) return;
    const next = !callState().micOn;
    stream.getAudioTracks().forEach((t) => (t.enabled = next));
    callState().setMicOn(next);
  }, [media.localStreamRef]);

  const toggleCam = useCallback(() => {
    const stream = media.localStreamRef.current;
    if (!stream) return;
    const next = !callState().camOn;
    stream.getVideoTracks().forEach((t) => (t.enabled = next));
    callState().setCamOn(next);
  }, [media.localStreamRef]);

  // The media layer ends calls on a failed leg or an un-sealable SFU call, and it
  // is built before this hook — so keep it pointed at the current closure.
  useEffect(() => {
    endCallRef.current = endCall;
  });

  return useMemo(
    () => ({
      startCall,
      joinCall,
      acceptCall,
      declineCall,
      joinOngoing,
      endCall,
      toggleMic,
      toggleCam,
      recordCall,
      suppressRecord,
    }),
    [
      startCall,
      joinCall,
      acceptCall,
      declineCall,
      joinOngoing,
      endCall,
      toggleMic,
      toggleCam,
      recordCall,
      suppressRecord,
    ],
  );
}
