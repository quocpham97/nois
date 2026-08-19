"use client";

/**
 * Inbound call signaling and roster events.
 *
 * The invariant to keep in mind when editing: signaling is addressed per DEVICE.
 * Two devices of one user must never both be treated as "the peer" (see
 * docs/group-calls-plan.md). The glare rule that goes with it — incumbents offer,
 * joiners answer — is enforced by the `offering` argument to `addPeer`.
 *
 * Handlers are registered once per socket and dispatched through a ref, so they
 * never see a stale closure while staying re-registration-free.
 */
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type {
  CallDeclinedRelay,
  CallHandledRelay,
  CallInviteRelay,
  CallJoinedRelay,
  CallKickedRelay,
  CallLeftRelay,
  CallOngoingRelay,
  CallOverRelay,
  CallSignalRelay,
} from "@/lib/socket-events";
import { callState } from "@/stores/call-store";
import { chat } from "@/stores/chat-store";
import type { SignalMsg } from "../call-transport";
import type { TypedSocket } from "@/stores/session-store";
import { callKind, resolveUser, titleFor } from "../lib/call-identity";
import { RING_TIMEOUT_MS } from "../lib/call-types";
import type { CallMedia } from "./use-call-media";
import type { CallSession } from "./use-call-session";

export function useCallEvents({
  socket,
  userId,
  deviceId,
  media,
  session,
}: {
  socket: TypedSocket | null;
  userId: string;
  deviceId: string | null;
  media: CallMedia;
  session: CallSession;
}) {
  const { transportRef, ringTimerRef, clearRingTimer, teardown, addParticipant } =
    media;
  const { recordCall, suppressRecord } = session;

  /** Someone joined a call we're already in → we offer to them. */
  const onJoined = useCallback(
    async ({
      callId,
      userId: joinerId,
      deviceId: joinerDevice,
    }: CallJoinedRelay) => {
      const c = callState().call;
      if (!c || c.callId !== callId || !joinerDevice) return;
      if (joinerDevice === deviceId) return; // our own echo
      clearRingTimer();
      addParticipant(callId, { userId: joinerId, deviceId: joinerDevice });
      // We were already here, so we offer — the joiner only ever answers.
      await transportRef.current?.addPeer(joinerDevice, joinerId, true);
    },
    [addParticipant, clearRingTimer, deviceId, transportRef],
  );

  const onLeft = useCallback(
    ({ callId, deviceId: goneDevice }: CallLeftRelay) => {
      const c = callState().call;
      if (!c || c.callId !== callId) return;
      transportRef.current?.removePeer(goneDevice);
      const remaining = c.participants.filter((p) => p.deviceId !== goneDevice);
      callState().patchCall(callId, { participants: remaining });
      // Last peer out ends the call for us too.
      if (remaining.length === 0 && c.phase !== "incoming") {
        const latest = callState().call;
        if (latest) {
          if (latest.phase === "active") toast("Call ended");
          recordCall(latest, latest.phase === "active" ? "answered" : "unanswered");
        }
        socket?.emit("call:leave", { callId, groupId: c.groupId });
        teardown();
      }
    },
    [recordCall, socket, teardown, transportRef],
  );

  const onSignal = useCallback(
    async ({ callId, fromUserId, fromDeviceId, data }: CallSignalRelay) => {
      const c = callState().call;
      if (!c || c.callId !== callId || !fromDeviceId) return;
      let msg: SignalMsg;
      try {
        msg = JSON.parse(data) as SignalMsg;
      } catch {
        return;
      }
      // First contact from a device we don't know yet means we're the joiner (or
      // the roster event is still in flight) — give it a tile. Idempotent, and the
      // transport sets itself up for the same reason. `offer` is the mesh's first
      // contact; `sfu-hello` is the SFU's.
      if (msg.type === "offer" || msg.type === "sfu-hello") {
        addParticipant(callId, { userId: fromUserId, deviceId: fromDeviceId });
      }
      await transportRef.current?.handleSignal(fromDeviceId, fromUserId, msg);
    },
    [addParticipant, transportRef],
  );

  const onInvite = useCallback(
    ({ callId, groupId, fromUserId, video }: CallInviteRelay) => {
      const cur = callState().call;
      if (cur) {
        // Already ringing or on a call — auto-decline as busy (unless it's a
        // duplicate relay of the call we're already showing). A busy decline is
        // recorded as a decline, not a no-answer (see docs/calls.md).
        if (cur.callId !== callId) {
          socket?.emit("call:decline", { callId, groupId, reason: "busy" });
        }
        return;
      }
      const starter = resolveUser(fromUserId);
      const ch = chat().groups[groupId];
      callState().setCall({
        callId,
        groupId,
        kind: callKind(groupId),
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
        const c = callState().call;
        if (c?.callId === callId && c.phase === "incoming") {
          toast(`Missed ${c.video ? "video" : "voice"} call from ${starter.name}`);
          teardown();
        }
      }, RING_TIMEOUT_MS);
    },
    [socket, teardown, ringTimerRef],
  );

  /** Someone isn't joining. Only a DM records it — a single decline in a group
   *  says nothing about the call, which carries on without them. */
  const onDeclined = useCallback(
    ({ callId, userId: whoId, reason }: CallDeclinedRelay) => {
      const c = callState().call;
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
          reason === "busy" ? `${who.name} is on another call` : `${who.name} declined`,
        );
      }
    },
    [userId, clearRingTimer, recordCall, socket, teardown],
  );

  /**
   * The socket came back. Media is peer-to-peer, so the call itself probably never
   * stopped — but we're out of the call room, which means we'd miss every roster
   * event from here on. Reclaim the seat rather than let the call rot.
   */
  const onReconnect = useCallback(() => {
    const c = callState().call;
    // A ring we hadn't answered has no seat to reclaim.
    if (!c || !socket || c.phase === "incoming") return;
    socket
      .timeout(8000)
      .emit("call:rejoin", { callId: c.callId, groupId: c.groupId }, (err, res) => {
        if (err || !res?.ok) {
          const reason = !err && res && !res.ok ? res.reason : "error";
          toast(
            reason === "gone"
              ? "The call ended while you were offline"
              : reason === "full"
                ? "Couldn't rejoin — the call is full"
                : "Couldn't rejoin the call",
          );
          recordCall(c, c.phase === "active" ? "answered" : "unanswered");
          teardown();
          return;
        }
        // Anyone who left while we were away really is gone; drop them rather than
        // keep a tile for a leg that no longer exists.
        const here = new Set(res.participants.map((p) => p.deviceId));
        const cur = callState().call;
        if (!cur || cur.callId !== c.callId) return;
        for (const p of cur.participants) {
          if (!here.has(p.deviceId)) transportRef.current?.removePeer(p.deviceId);
        }
        callState().patchCall(c.callId, (cc) => ({
          participants: cc.participants.filter((p) => here.has(p.deviceId)),
        }));
      });
  }, [socket, recordCall, teardown, transportRef]);

  /** Another of our devices took (or refused) this ring — stop ringing here. */
  const onHandled = useCallback(
    ({ callId }: CallHandledRelay) => {
      const c = callState().call;
      if (!c || c.callId !== callId || c.phase !== "incoming") return;
      teardown();
    },
    [teardown],
  );

  /** We joined from another device, so this one is out. */
  const onKicked = useCallback(
    ({ callId }: CallKickedRelay) => {
      const c = callState().call;
      if (!c || c.callId !== callId) return;
      toast("Call moved to your other device");
      // No record: the call continues, and whichever device holds it now owns the
      // row (`outgoing` is derived from starterId, so it migrates too).
      suppressRecord(callId);
      teardown();
    },
    [teardown, suppressRecord],
  );

  const onOngoing = useCallback(
    (p: CallOngoingRelay) => {
      if (p.starterId === userId) return; // our own call — the call UI covers it
      callState().addOngoing(p);
    },
    [userId],
  );

  const onOver = useCallback(
    ({ groupId, callId }: CallOverRelay) => {
      callState().dropOngoing(groupId, callId);
      // Still ringing for a call that's now over (the starter gave up).
      const c = callState().call;
      if (c?.callId === callId && c.phase === "incoming") {
        toast(`Missed ${c.video ? "video" : "voice"} call from ${c.starter.name}`);
        teardown();
      }
    },
    [teardown],
  );

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
    onReconnect,
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
      onReconnect,
    };
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
    // Fires again on every reconnect. On the FIRST connect there's no call yet, so
    // the handler is a no-op — it only matters after a drop.
    const reconnected = () => handlersRef.current.onReconnect();
    socket.on("connect", reconnected);
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
      socket.off("connect", reconnected);
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
}
