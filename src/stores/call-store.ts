/**
 * Call state — the live call, our own media, and the calls we could join.
 *
 * Small, but it was the state most expensive to keep in a context: the call
 * value object was rebuilt on every provider render, so a mic toggle (or any
 * conversation update, since the provider reads the chat store) re-rendered
 * every component calling `useCall()` — including each message row. Here a
 * message row can subscribe to `call?.groupId` alone.
 *
 * It also replaces the provider's `callRef`: the socket handlers used a ref
 * mirror because they're registered once and would otherwise close over stale
 * state. `callStore.getState().call` is that same live read without the mirror,
 * so there is one source of truth instead of two kept in step by hand.
 */
import { create } from "zustand";
import type { CallInfo, OngoingCall } from "@/components/chat/lib/call-types";

type CallData = {
  call: CallInfo | null;
  localStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  /** Live calls we could join, by groupId. */
  ongoing: Record<string, OngoingCall>;
};

type CallActions = {
  setCall: (c: CallInfo | null) => void;
  /** Patch the live call — a no-op if it's already gone or a different call. */
  patchCall: (
    callId: string,
    patch: Partial<CallInfo> | ((c: CallInfo) => Partial<CallInfo>),
  ) => void;
  setLocalStream: (s: MediaStream | null) => void;
  setMicOn: (on: boolean) => void;
  setCamOn: (on: boolean) => void;
  addOngoing: (c: OngoingCall) => void;
  dropOngoing: (groupId: string, callId: string) => void;
  /** Back to "no call", leaving `ongoing` alone (those are other people's). */
  resetCall: () => void;
};

export type CallState = CallData & CallActions;

export const useCallStore = create<CallState>((set, get) => ({
  call: null,
  localStream: null,
  micOn: true,
  camOn: true,
  ongoing: {},

  setCall: (call) => set({ call }),

  patchCall: (callId, patch) => {
    const c = get().call;
    if (!c || c.callId !== callId) return;
    set({ call: { ...c, ...(typeof patch === "function" ? patch(c) : patch) } });
  },

  setLocalStream: (localStream) => set({ localStream }),
  setMicOn: (micOn) => set({ micOn }),
  setCamOn: (camOn) => set({ camOn }),

  addOngoing: (c) =>
    set((s) => ({ ongoing: { ...s.ongoing, [c.groupId]: c } })),
  dropOngoing: (groupId, callId) =>
    set((s) => {
      if (s.ongoing[groupId]?.callId !== callId) return {};
      const { [groupId]: _gone, ...rest } = s.ongoing;
      void _gone;
      return { ongoing: rest };
    }),

  resetCall: () =>
    set({ call: null, localStream: null, micOn: true, camOn: true }),
}));

/** Read call state outside React (socket handlers, transport events, timers). */
export const callState = () => useCallStore.getState();
