// The media layer under a call, behind one interface.
//
// Everything ABOVE this seam — call phases, the participant roster, ring
// timeouts, device migration, the thread record — is transport-agnostic and
// lives in call-context.tsx. Everything BELOW it is how media actually gets
// between people.
//
// Today there is one implementation: a full mesh of RTCPeerConnections, one per
// remote DEVICE. That is what keeps media peer-to-peer and end-to-end encrypted
// by construction (DTLS-SRTP per pair, no server in the media path) and it is
// also what caps a call at 6 voice / 4 video, since every participant uploads
// N−1 streams.
//
// An SFU implementation would publish once and subscribe N times instead, and
// would slot in here without the engine above knowing: `start` publishes,
// `addPeer` subscribes to that device's track, `handleSignal` is a no-op because
// negotiation runs against the media server rather than between peers. See
// docs/calls-production.md for why that is deferred and what it would cost.

/** Wire shape of a `call:signal` `data` blob. Opaque to the server. */
export type SignalMsg =
  | { type: "offer" | "answer"; sdp?: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

/** What a transport tells the engine above it. All are dropped after `close`. */
export type TransportEvents = {
  /** Media arrived from a remote device. */
  onStream: (deviceId: string, stream: MediaStream) => void;
  /** That device's media is up. */
  onConnected: (deviceId: string) => void;
  /** That leg is gone for good. The transport has already released it; the
   *  engine decides whether anyone is left to talk to. */
  onFailed: (deviceId: string) => void;
  /** Outbound signaling blob, addressed to one device. */
  sendSignal: (toDeviceId: string, msg: SignalMsg) => void;
};

export type CallTransport = {
  /** Entering the call, before any peer is known. */
  start: () => Promise<void>;
  /** A remote device is in the call. `offering` is true when WE are the
   *  incumbent and must send the offer — see the glare rule below. */
  addPeer: (deviceId: string, userId: string, offering: boolean) => Promise<void>;
  /** A remote device left. */
  removePeer: (deviceId: string) => void;
  /** Inbound signaling from one device. */
  handleSignal: (
    fromDeviceId: string,
    fromUserId: string,
    msg: SignalMsg,
  ) => Promise<void>;
  /** Tear down every leg. The transport is single-use after this. */
  close: () => void;
};

/** Per-remote-device connection state. */
type PeerState = {
  pc: RTCPeerConnection;
  userId: string;
  /** Candidates that arrived before the remote description was set. */
  pendingIce: RTCIceCandidateInit[];
};

/**
 * Full-mesh transport: one RTCPeerConnection per remote device.
 *
 * Glare-free by construction: whoever is ALREADY in the call offers to a
 * joiner, and the joiner only ever answers. Each pair therefore has exactly one
 * offerer and no tie-breaking is needed.
 *
 * Camera/mic toggles flip `track.enabled` upstream, so no renegotiation is ever
 * needed and every peer's tracks are fixed at setup.
 */
export function createMeshTransport({
  localStream,
  iceServers,
  events,
}: {
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  events: TransportEvents;
}): CallTransport {
  const peers = new Map<string, PeerState>();
  let closed = false;

  const release = (deviceId: string) => {
    const p = peers.get(deviceId);
    if (!p) return;
    p.pc.close();
    peers.delete(deviceId);
  };

  const ensure = (deviceId: string, userId: string): PeerState => {
    const existing = peers.get(deviceId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers });
    const state: PeerState = { pc, userId, pendingIce: [] };
    peers.set(deviceId, state);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        events.sendSignal(deviceId, { type: "ice", candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      if (closed) return;
      events.onStream(deviceId, e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (closed) return;
      // A connection we've already replaced for this device must not report.
      if (peers.get(deviceId)?.pc !== pc) return;
      if (pc.connectionState === "connected") {
        events.onConnected(deviceId);
      } else if (pc.connectionState === "failed") {
        // One leg failing is not the whole call failing — release it and keep
        // talking to everyone else.
        release(deviceId);
        events.onFailed(deviceId);
      }
    };
    return state;
  };

  return {
    async start() {
      // A mesh negotiates per peer, so there is nothing to do up front. An SFU
      // would publish the local stream here.
    },

    async addPeer(deviceId, userId, offering) {
      if (closed) return;
      const state = ensure(deviceId, userId);
      if (!offering) return; // the joiner only ever answers
      try {
        const offer = await state.pc.createOffer();
        await state.pc.setLocalDescription(offer);
        events.sendSignal(deviceId, { type: "offer", sdp: offer.sdp });
      } catch (err) {
        console.warn("[call] offer failed", deviceId, err);
        release(deviceId);
      }
    },

    removePeer(deviceId) {
      release(deviceId);
    },

    async handleSignal(fromDeviceId, fromUserId, msg) {
      if (closed) return;
      // An offer from a device we don't know yet means we're the joiner (or the
      // roster event is still in flight) — set the peer up as the answerer.
      if (msg.type === "offer") ensure(fromDeviceId, fromUserId);
      const state = peers.get(fromDeviceId);
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
          events.sendSignal(fromDeviceId, { type: "answer", sdp: answer.sdp });
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

    close() {
      closed = true;
      for (const [id] of peers) release(id);
      peers.clear();
    },
  };
}
