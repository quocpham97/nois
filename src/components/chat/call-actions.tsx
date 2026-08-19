"use client";

/**
 * What a view can DO to a call. Read call state from the store
 * (`useCallStore`) — this context carries only behaviour, and its value is
 * referentially stable, so a component that only places calls never re-renders
 * because someone toggled their microphone.
 */
import { createContext, useContext } from "react";

export type CallActionsValue = {
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

const CallActionsContext = createContext<CallActionsValue | null>(null);

export const CallActionsProvider = CallActionsContext.Provider;

export function useCallActions(): CallActionsValue {
  const ctx = useContext(CallActionsContext);
  if (!ctx) throw new Error("useCallActions must be used within CallProvider");
  return ctx;
}
