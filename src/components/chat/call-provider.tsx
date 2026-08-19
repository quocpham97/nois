"use client";

/**
 * Voice/video calls, 1:1 and group — the composition root.
 *
 * The call state machine lives in stores/call-store (state) plus the hooks below
 * (behaviour); how media gets between people sits behind `CallTransport`
 * (call-transport.ts), which today is a full mesh of RTCPeerConnections and could
 * be an SFU without these files changing much.
 *
 * The server only ever relays signaling blobs (see the call:* handlers in
 * server.ts); with the mesh transport it never touches media at all.
 *
 * A DM call is just a mesh of one peer: there is a single engine here, not a 1:1
 * path plus a group path.
 */
import { useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/stores/session-store";
import { useChatActions } from "./chat-actions";
import { CallActionsProvider, type CallActionsValue } from "./call-actions";
import { useCallIce } from "./hooks/use-call-ice";
import { useCallSfuApi } from "./hooks/use-call-sfu-api";
import { useCallMedia } from "./hooks/use-call-media";
import { useCallSession } from "./hooks/use-call-session";
import { useCallEvents } from "./hooks/use-call-events";

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { socket, userId, deviceId } = useSessionStore(
    useShallow((s) => ({
      socket: s.socket,
      userId: s.userId,
      deviceId: s.deviceId,
    })),
  );
  const { logCallEvent, exportCallKey } = useChatActions();

  // Media can end a call (a failed leg, an un-sealable SFU call) but is built
  // before the session that knows how — so the two meet through this ref.
  const endCallRef = useRef<() => void>(() => {});

  const ice = useCallIce({ socket });
  const sfu = useCallSfuApi({ socket });
  const media = useCallMedia({ socket, ice, sfu, exportCallKey, endCallRef });
  const session = useCallSession({
    socket,
    userId,
    deviceId,
    ice,
    media,
    endCallRef,
    logCallEvent,
  });
  useCallEvents({ socket, userId, deviceId, media, session });

  const actions = useMemo<CallActionsValue>(
    () => ({
      startCall: session.startCall,
      acceptCall: session.acceptCall,
      declineCall: session.declineCall,
      joinOngoing: session.joinOngoing,
      endCall: session.endCall,
      toggleMic: session.toggleMic,
      toggleCam: session.toggleCam,
    }),
    [session],
  );

  return <CallActionsProvider value={actions}>{children}</CallActionsProvider>;
}
