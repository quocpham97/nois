"use client";

/**
 * How media gets between people, and the per-frame keys that seal it.
 *
 * This hook owns the transport (a mesh of RTCPeerConnections, or the SFU), the
 * frame-crypto worker, our own local stream, and the teardown that stops all of
 * it. It deliberately does NOT own the call state machine — that's
 * use-call-session — so swapping the mesh for an SFU is swapping the factory
 * called in `openTransport`.
 *
 * `patchCall` no-ops once the call is gone or replaced, so a straggling event
 * from a torn-down transport can't touch a later call.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { CallPeer } from "@/lib/socket-events";
import { callState, useCallStore } from "@/stores/call-store";
import {
  type CallTransport,
  type SignalMsg,
  type TransportEvents,
  createMeshTransport,
} from "../call-transport";
import { createSfuTransport } from "../call-transport-sfu";
import { type FrameCrypto, createFrameCrypto } from "../call-frame-crypto";
import type { TypedSocket } from "@/stores/session-store";
import { resolveUser, sfuFor } from "../lib/call-identity";
import {
  MLS_KEY_RETRY_MAX_MS,
  MLS_KEY_RETRY_MS,
  MLS_KEY_WAIT_MS,
  SFU_ENABLED,
} from "../lib/call-types";
import type { CallIce } from "./use-call-ice";
import type { CallSfu } from "./use-call-sfu-api";

export type CallMedia = ReturnType<typeof useCallMedia>;

export function useCallMedia({
  socket,
  ice,
  sfu,
  exportCallKey,
  endCallRef,
}: {
  socket: TypedSocket | null;
  ice: CallIce;
  sfu: CallSfu;
  exportCallKey: (
    groupId: string,
    callId: string,
  ) => Promise<{ epoch: number; key: Uint8Array } | null>;
  /** Ending a call needs the session hook, which is built on top of this one —
   *  so the two are joined by a ref the provider owns. */
  endCallRef: React.RefObject<() => void>;
}) {
  const transportRef = useRef<CallTransport | null>(null);
  const frameCryptoRef = useRef<FrameCrypto | null>(null);
  /** Epochs already handed to the worker, so re-deriving is idempotent. */
  const keyEpochsRef = useRef<Set<number>>(new Set());
  const localStreamRef = useRef<MediaStream | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    callState().resetCall();
  }, [clearRingTimer]);

  /** Adopt a freshly acquired local stream. */
  const setLocalStream = useCallback((stream: MediaStream | null) => {
    localStreamRef.current = stream;
    callState().setLocalStream(stream);
  }, []);

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

  /**
   * Feed the frame-crypto worker the current epoch's media key.
   *
   * Called at call start and then periodically, which is how rekeying works: the
   * key follows the group's MLS EPOCH, not the call roster. A call joiner is
   * already a member and derives it themselves; the person who must be locked out
   * is one REMOVED from the group, and that removal is exactly what advances the
   * epoch. Frames carry their epoch, and the worker keeps the previous key briefly
   * so media in flight across a commit still opens.
   */
  const pumpKeys = useCallback(
    async (callId: string, groupId: string) => {
      const fc = frameCryptoRef.current;
      if (!fc) return;
      const derived = await exportCallKey(groupId, callId);
      // A rotation check that finds nothing must NOT end a call that is already
      // running on a key it holds — the epoch it would rotate to simply isn't
      // available yet, and the frames in flight are still openable.
      if (!derived || keyEpochsRef.current.has(derived.epoch)) return;
      keyEpochsRef.current.add(derived.epoch);
      fc.addKey(derived.epoch, derived.key);
    },
    [exportCallKey],
  );

  /**
   * Get the FIRST media key, waiting for MLS to converge rather than refusing on
   * the spot.
   *
   * Establishing a group's MLS state is a round trip, not a lookup: key packages
   * have to be published, a commit ordered and Welcomes delivered. In a group that
   * was just created — or that this device only just joined — none of that has
   * happened at the instant somebody presses call, and refusing immediately made
   * "create a group, call in it" fail permanently even though it would have worked
   * moments later.
   *
   * Waiting is safe rather than a compromise: the worker DROPS frames it can't
   * seal, so a call with no key yet is silent, never readable. The cost of
   * retrying is latency; the cost of not waiting was the feature.
   */
  const awaitFirstKey = useCallback(
    async (callId: string, groupId: string) => {
      const deadline = Date.now() + MLS_KEY_WAIT_MS;
      let wait = MLS_KEY_RETRY_MS;
      for (;;) {
        if (callState().call?.callId !== callId) return; // call went away
        if (!frameCryptoRef.current) return;
        await pumpKeys(callId, groupId);
        if (keyEpochsRef.current.size > 0) return;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, MLS_KEY_RETRY_MAX_MS);
      }
      // Out of time. Refusing is still right — running the call through a server
      // we can't encrypt for is the one thing that isn't allowed — but now it
      // means "couldn't", not "won't".
      if (callState().call?.callId !== callId) return;
      toast.error("Couldn't set up encryption for this call");
      endCallRef.current?.();
    },
    [pumpKeys, endCallRef],
  );

  /** Build the media layer for one call and wire its events into call state. */
  const openTransport = useCallback(
    (callId: string, groupId: string, stream: MediaStream): CallTransport => {
      transportRef.current?.close();
      const patchCall = callState().patchCall;
      const common: {
        localStream: MediaStream;
        iceServers: RTCIceServer[];
        events: TransportEvents;
      } = {
        localStream: stream,
        iceServers: ice.iceServers(),
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
            // One leg failing is not the whole call failing — drop that peer and
            // keep talking to everyone else. If it was the last one, end.
            patchCall(callId, (c) => ({
              participants: c.participants.filter((p) => p.deviceId !== deviceId),
            }));
            const c = callState().call;
            if (c?.callId === callId && c.participants.length === 0) {
              toast.error("Call connection lost");
              endCallRef.current?.();
            }
          },
        },
      };
      // The one line that chooses how media travels. The mesh is the default and
      // the only path for DMs, and media never reaches a server on it; the SFU
      // pairs with per-frame encryption so it can forward what it cannot read, and
      // needs the group's MLS state to key that.
      if (!sfuFor(groupId)) {
        const transport = createMeshTransport(common);
        transportRef.current = transport;
        return transport;
      }
      const frameCrypto = createFrameCrypto();
      frameCryptoRef.current = frameCrypto;
      // Keys arrive a moment later — possibly several seconds later, if this
      // group's MLS state has to be established first. Frames until then fail to
      // seal and are dropped by the worker rather than sent in the clear.
      void awaitFirstKey(callId, groupId);
      const transport = createSfuTransport({
        ...common,
        api: sfu.sfuApi(callId, groupId),
        frameCrypto,
      });
      transportRef.current = transport;
      return transport;
    },
    [sendSignal, ice, sfu, awaitFirstKey, endCallRef],
  );

  /** Add a participant row (idempotent) and keep the peak count. */
  const addParticipant = useCallback((callId: string, peer: CallPeer) => {
    callState().patchCall(callId, (c) => {
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
  }, []);

  // Rekey while a call is up. Polling rather than subscribing to MLS commits: the
  // check is a cheap read of state we already hold, and it self-heals if a commit
  // lands while we're mid-call regardless of how it got there.
  const activeCallId = useCallStore((s) => s.call?.callId);
  const activeGroupId = useCallStore((s) => s.call?.groupId);
  const activeKind = useCallStore((s) => s.call?.kind);
  useEffect(() => {
    // A DM is on the mesh with no frame crypto to rekey, so don't poll for one.
    if (!SFU_ENABLED || activeKind !== "group") return;
    if (!activeCallId || !activeGroupId) return;
    const id = setInterval(() => void pumpKeys(activeCallId, activeGroupId), 5000);
    return () => clearInterval(id);
  }, [activeCallId, activeGroupId, activeKind, pumpKeys]);

  return useMemo(
    () => ({
      transportRef,
      localStreamRef,
      ringTimerRef,
      clearRingTimer,
      teardown,
      setLocalStream,
      openTransport,
      addParticipant,
    }),
    [clearRingTimer, teardown, setLocalStream, openTransport, addParticipant],
  );
}
