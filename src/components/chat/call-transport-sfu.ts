// SFU transport — media through Cloudflare Realtime instead of a peer mesh.
//
// PHASE C. This is NOT safe to ship to users on its own: media is decrypted at
// the SFU, so until per-frame E2EE lands (phase D) the server sees everything
// and the product's central promise is broken. It exists behind a flag so the
// harder half can be built against something that works. See
// docs/calls-production.md.
//
// Two Realtime sessions, each one PeerConnection:
//   - PUBLISHER: our own tracks, pushed once regardless of how many people are
//     listening. That single fact is the whole point of an SFU — mesh uplink is
//     N−1 streams, this is 1.
//   - SUBSCRIBER: every remote track we pull, on one connection. Keeping pulls
//     off the publisher connection means renegotiation (which happens on every
//     join and leave) never disturbs our own outbound media.
//
// Peers learn each other's session id over the existing `call:signal` relay as
// an `sfu-hello`, so the server gains no new knowledge of the roster and the
// engine above this file is unchanged.

import type {
  SfuTracksBody,
  SfuTracksResponse,
  SfuSessionDescription,
} from "@/lib/socket-events";
import type { CallTransport, SignalMsg, TransportEvents } from "./call-transport";

/** The socket-backed proxy to Cloudflare's Realtime API. The app token is
 *  app-wide, so none of this can happen in the browser — see server.ts. */
export type SfuApi = {
  /** New Realtime session (one PeerConnection). Null if it couldn't be made. */
  session: () => Promise<string | null>;
  /** `tracks/new` — publishes when `location: "local"`, subscribes when
   *  `"remote"`. Null on failure. */
  tracks: (sessionId: string, body: SfuTracksBody) => Promise<SfuTracksResponse | null>;
  renegotiate: (sessionId: string, sdp: SfuSessionDescription) => Promise<boolean>;
  closeTracks: (sessionId: string, mids: string[]) => void;
};

type PeerState = {
  userId: string;
  /** Their publisher session, learned from their `sfu-hello`. */
  sessionId?: string;
  trackNames?: string[];
  /** Transceiver mids we pulled for them, so we can close just theirs. */
  mids: string[];
  /** Accumulates their audio + video into one stream, like mesh `ontrack`. */
  stream?: MediaStream;
  pulled: boolean;
  announced: boolean;
};

export function createSfuTransport({
  localStream,
  iceServers,
  events,
  api,
}: {
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  events: TransportEvents;
  api: SfuApi;
}): CallTransport {
  const peers = new Map<string, PeerState>();
  /** Which peer a pulled transceiver belongs to, so `ontrack` can route. */
  const midToDevice = new Map<string, string>();
  let closed = false;

  let pubPc: RTCPeerConnection | null = null;
  let subPc: RTCPeerConnection | null = null;
  let pubSession: string | null = null;
  let subSession: string | null = null;
  let localTrackNames: string[] = [];

  /** Resolves once publishing is done, so `addPeer` can be called at any time
   *  and simply wait rather than racing the session setup. */
  let ready: Promise<void> | null = null;

  const peer = (deviceId: string, userId: string): PeerState => {
    const existing = peers.get(deviceId);
    if (existing) return existing;
    const state: PeerState = { userId, mids: [], pulled: false, announced: false };
    peers.set(deviceId, state);
    return state;
  };

  /** A remote leg counts as up only when the subscriber connection is live AND
   *  we actually have media for that device. `connectionState === "connected"`
   *  alone means "connected to Cloudflare", which under an SFU is true in an
   *  empty room — reporting that as an active call would be a lie. */
  const reportConnected = (deviceId: string) => {
    if (closed || subPc?.connectionState !== "connected") return;
    if (!peers.get(deviceId)?.stream) return;
    events.onConnected(deviceId);
  };

  // The failure mode an SFU cannot soften: one dead connection is every leg at
  // once, where a mesh loses only the pair that broke. The engine above turns a
  // drained roster into "Call connection lost".
  const failAll = () => {
    if (closed) return;
    for (const deviceId of [...peers.keys()]) {
      peers.delete(deviceId);
      events.onFailed(deviceId);
    }
  };

  const watch = (pc: RTCPeerConnection) => {
    pc.onconnectionstatechange = () => {
      if (closed) return;
      if (pc.connectionState === "failed") failAll();
      else if (pc.connectionState === "connected") {
        for (const deviceId of peers.keys()) reportConnected(deviceId);
      }
    };
  };

  /** Publish our stream once, then open the connection we pull everyone on. */
  const setup = async (): Promise<void> => {
    const pub = new RTCPeerConnection({ iceServers });
    pubPc = pub;
    watch(pub);
    // sendonly: this connection never carries anyone else's media.
    const senders = localStream.getTracks().map((track) => ({
      track,
      transceiver: pub.addTransceiver(track, { direction: "sendonly" }),
    }));
    const offer = await pub.createOffer();
    await pub.setLocalDescription(offer);
    if (closed) return;

    pubSession = await api.session();
    if (!pubSession || closed) return;

    // mids only exist after setLocalDescription, which is why publishing can't
    // be folded into the constructor.
    const tracks = senders.map(({ track, transceiver }) => ({
      location: "local" as const,
      mid: transceiver.mid,
      trackName: track.kind === "video" ? "cam" : "mic",
    }));
    localTrackNames = tracks.map((t) => t.trackName);

    const res = await api.tracks(pubSession, {
      sessionDescription: { type: "offer", sdp: pub.localDescription?.sdp ?? "" },
      tracks,
    });
    if (!res?.sessionDescription || closed) return;
    await pub.setRemoteDescription(res.sessionDescription);

    // The subscriber connection starts empty — its first offer arrives from the
    // SFU in response to our first pull.
    const sub = new RTCPeerConnection({ iceServers });
    subPc = sub;
    watch(sub);
    sub.ontrack = (e) => {
      if (closed) return;
      const mid = e.transceiver.mid;
      const deviceId = mid ? midToDevice.get(mid) : undefined;
      if (!deviceId) return;
      const state = peers.get(deviceId);
      if (!state) return;
      // One stream per device, gaining mic then cam as they arrive.
      const stream = state.stream ?? new MediaStream();
      stream.addTrack(e.track);
      state.stream = stream;
      events.onStream(deviceId, stream);
      reportConnected(deviceId);
    };
    subSession = await api.session();
  };

  /** Subscribe to one peer's published tracks. */
  const pull = async (deviceId: string): Promise<void> => {
    const state = peers.get(deviceId);
    const sub = subPc;
    if (closed || !state || !sub || !subSession) return;
    if (state.pulled || !state.sessionId || !state.trackNames?.length) return;
    state.pulled = true;

    const res = await api.tracks(subSession, {
      tracks: state.trackNames.map((trackName) => ({
        location: "remote" as const,
        sessionId: state.sessionId,
        trackName,
      })),
    });
    if (!res || closed) {
      state.pulled = false;
      return;
    }
    for (const t of res.tracks ?? []) {
      if (t.mid) {
        midToDevice.set(t.mid, deviceId);
        state.mids.push(t.mid);
      }
    }
    // Pulling always makes the SFU offer, because it is adding transceivers to
    // our subscriber connection.
    if (res.requiresImmediateRenegotiation && res.sessionDescription) {
      await sub.setRemoteDescription(res.sessionDescription);
      const answer = await sub.createAnswer();
      await sub.setLocalDescription(answer);
      if (closed) return;
      await api.renegotiate(subSession, {
        type: "answer",
        sdp: sub.localDescription?.sdp ?? "",
      });
    }
  };

  /** Tell a peer where to pull us from. Both sides send this — unlike the mesh
   *  there is no offerer/answerer asymmetry to exploit, since each side pulls
   *  independently. */
  const announce = (deviceId: string) => {
    const state = peers.get(deviceId);
    if (!state || state.announced || !pubSession || !localTrackNames.length) return;
    state.announced = true;
    events.sendSignal(deviceId, {
      type: "sfu-hello",
      sessionId: pubSession,
      tracks: localTrackNames,
    });
  };

  return {
    async start() {
      if (closed || ready) return ready ?? undefined;
      ready = setup().catch((err) => {
        console.warn("[call] sfu setup failed", err);
      });
      await ready;
      // Anyone added while we were setting up still needs telling.
      for (const deviceId of peers.keys()) {
        announce(deviceId);
        void pull(deviceId);
      }
    },

    async addPeer(deviceId, userId) {
      if (closed) return;
      peer(deviceId, userId);
      // `offering` is meaningless here: an SFU has no glare to avoid, because
      // each side negotiates with the server rather than with the other.
      if (ready) await ready;
      if (closed) return;
      announce(deviceId);
      await pull(deviceId);
    },

    removePeer(deviceId) {
      const state = peers.get(deviceId);
      if (!state) return;
      if (subSession && state.mids.length) api.closeTracks(subSession, state.mids);
      for (const mid of state.mids) midToDevice.delete(mid);
      peers.delete(deviceId);
    },

    async handleSignal(fromDeviceId, fromUserId, msg: SignalMsg) {
      if (closed || msg.type !== "sfu-hello") return;
      const state = peer(fromDeviceId, fromUserId);
      state.sessionId = msg.sessionId;
      state.trackNames = msg.tracks;
      // They may have announced before we knew about them, so make sure they
      // can find us too.
      if (ready) await ready;
      if (closed) return;
      announce(fromDeviceId);
      await pull(fromDeviceId);
    },

    close() {
      closed = true;
      pubPc?.close();
      subPc?.close();
      pubPc = null;
      subPc = null;
      peers.clear();
      midToDevice.clear();
    },
  };
}
