"use client";

/**
 * ICE servers for a call, minted by the server and held until they near expiry.
 *
 * Resolved BEFORE a call is placed or joined, because the transport is built with
 * them: an RTCPeerConnection's ICE config is fixed at construction, so
 * credentials arriving late would mean a peer built without TURN.
 *
 * TURN credentials come from the SERVER (`ice:servers`), not from the bundle —
 * Cloudflare issues short-lived ones only, and a static credential shipped in
 * the JavaScript is an open relay for anyone who opens devtools. The
 * NEXT_PUBLIC_* vars are the fallback for deployments pointed at a provider with
 * static credentials (e.g. ExpressTURN, self-hosted coturn). See
 * docs/calls-production.md.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { IceServersResult } from "@/lib/socket-events";
import type { TypedSocket } from "@/stores/session-store";

// Public STUN is enough for most NATs; symmetric NATs need a TURN relay. A mesh
// multiplies the NAT failure modes, so TURN matters more here than it did for 1:1.
const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function envIceServers(): RTCIceServer[] {
  const turn = process.env.NEXT_PUBLIC_TURN_URL;
  if (!turn) return STUN_ONLY;
  return [
    ...STUN_ONLY,
    {
      urls: turn,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    },
  ];
}

export type CallIce = ReturnType<typeof useCallIce>;

export function useCallIce({ socket }: { socket: TypedSocket | null }) {
  const cacheRef = useRef<{ servers: RTCIceServer[]; expiresAt: number } | null>(
    null,
  );

  const ensureIceServers = useCallback(async (): Promise<void> => {
    if (!socket) return;
    const cached = cacheRef.current;
    if (cached && cached.expiresAt > Date.now()) return;
    const res = await new Promise<IceServersResult | null>((resolve) => {
      socket.timeout(5000).emit("ice:servers", (err, r) => resolve(err ? null : r));
    });
    // No credentials is a DEGRADED call (build-time vars, else STUN only), not a
    // failed one — placing the call must never block on this.
    if (!res?.iceServers.length) return;
    cacheRef.current = {
      servers: res.iceServers as RTCIceServer[],
      expiresAt: Date.now() + Math.max(res.ttl, 30) * 1000,
    };
  }, [socket]);

  /** What the transport should be constructed with, right now. */
  const iceServers = useCallback(
    (): RTCIceServer[] => cacheRef.current?.servers ?? envIceServers(),
    [],
  );

  // Warm the cache on connect so the common case pays no round trip at call time.
  useEffect(() => {
    void ensureIceServers();
  }, [ensureIceServers]);

  return useMemo(
    () => ({ ensureIceServers, iceServers }),
    [ensureIceServers, iceServers],
  );
}
