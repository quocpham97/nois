"use client";

/**
 * The socket-backed proxy the SFU transport calls.
 *
 * Every request is scoped to a call the server can see us in, and the Cloudflare
 * app token stays on the server — it is app-wide, so it could never be handed to
 * a browser.
 *
 * The retry policy is the interesting part, and it is deliberately not uniform:
 * see the two budgets in `attempt`.
 */
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { SfuTracksResponse } from "@/lib/socket-events";
import type { SfuApi } from "../call-transport-sfu";
import type { TypedSocket } from "@/stores/session-store";
import {
  SFU_REFUSAL_RETRIES,
  SFU_RETRIES,
  SFU_RETRY_MS,
  SFU_SOCKET_WAIT_MS,
} from "../lib/call-types";

export type CallSfu = ReturnType<typeof useCallSfuApi>;

export function useCallSfuApi({ socket }: { socket: TypedSocket | null }) {
  const sfuApi = useCallback(
    (callId: string, groupId: string): SfuApi => {
      const scope = { callId, groupId };
      /**
       * Hold a request until the socket is actually up.
       *
       * socket.io fails an ack emit immediately when the socket is down, so a
       * request placed mid-blip is never sent at all — and on the mutating
       * steps, which cannot be repeated blind, that used to end the call. The
       * socket comes back on its own in about a second, so wait for it.
       */
      const awaitSocket = async (): Promise<void> => {
        if (!socket || socket.connected) return;
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            socket.off("connect", finish);
            resolve();
          };
          const timer = setTimeout(finish, SFU_SOCKET_WAIT_MS);
          socket.on("connect", finish);
        });
      };

      /**
       * One proxied request, retried across a websocket blip.
       *
       * Every SFU step is a request/ack round trip where the mesh's signaling
       * was fire-and-forget, which makes this transport far more brittle than
       * the mesh in exactly the situation calls meet most: a socket that drops
       * for a second. The mesh shrugs that off (ICE retries, and `call:rejoin`
       * puts us back in the room); an SFU setup that lost its ack would leave
       * the call running with NO media, permanently. The socket comes back on
       * its own in about a second, so these simply wait for it.
       *
       * Two budgets, because the two failures mean different things:
       *
       * `tries` covers AMBIGUOUS failures — a lost ack, a dropped socket. It is
       * 1 for anything that mutates SFU signaling state, because a lost ack
       * doesn't tell us whether the request landed, and re-sending a
       * `tracks/new` that actually succeeded desynchronises the session (the
       * SFU then refuses the next one with 406
       * invalid_session_description). Creating a session is the only safe thing
       * to repeat blind: the worst case is an orphan carrying no tracks.
       *
       * `SFU_REFUSAL_RETRIES` covers `unauthorized`, which is the one failure
       * that is provably a NO-OP: the guard runs before configuration and
       * before any upstream call, so nothing at Cloudflare moved and repeating
       * the request cannot desynchronise anything. That matters because a
       * reconnect puts us briefly outside the call room until `call:rejoin`
       * lands, and a mutating request that met that window used to end the
       * call outright. Upstream failures ack `error`, never `unauthorized`, so
       * they stay under the strict limit. Only `unconfigured` is final.
       */
      const attempt = async <T,>(
        once: () => Promise<{ value: T } | { fail: string }>,
        tries = SFU_RETRIES,
      ): Promise<T | null> => {
        let ambiguous = 0;
        let refused = 0;
        for (;;) {
          await awaitSocket();
          // Read BEFORE the request: a socket that was already down could not
          // have transmitted anything, which is what makes repeating the
          // request safe. An ack error on a socket that WAS up is ambiguous —
          // the server may have acted on it and only the reply was lost.
          const sent = !!socket?.connected;
          const r = await once();
          if ("value" in r) return r.value;
          if (r.fail === "unconfigured") {
            console.warn("[call] sfu request failed: unconfigured");
            toast.error("This deployment has no SFU configured");
            return null;
          }
          // `unauthorized` comes from the guard, which runs before any upstream
          // call, so nothing at Cloudflare moved. `!sent` means the request
          // never left this browser. Both are no-ops, and repeating a no-op
          // cannot desynchronise a session.
          const refusal = r.fail === "unauthorized" || !sent;
          const budget = refusal ? SFU_REFUSAL_RETRIES : tries;
          const used = refusal ? ++refused : ++ambiguous;
          console.warn(
            `[call] sfu request failed: ${r.fail} (${refusal ? "no-op" : "no ack"} ${used}/${budget})`,
          );
          if (used >= budget) return null;
          await new Promise((res) => setTimeout(res, SFU_RETRY_MS));
        }
      };

      return {
        session: () =>
          attempt<string>(
            () =>
              new Promise((resolve) => {
                if (!socket) return resolve({ fail: "no socket" });
                socket
                  .timeout(10_000)
                  .emit("sfu:session", scope, (err, res) => {
                    if (err) return resolve({ fail: String(err) });
                    if (!res?.ok)
                      return resolve({ fail: res?.reason ?? "error" });
                    resolve({ value: res.sessionId });
                  });
              }),
          ),
        tracks: (sessionId, body) =>
          attempt<SfuTracksResponse>(
            () =>
              new Promise((resolve) => {
                if (!socket) return resolve({ fail: "no socket" });
                socket
                  .timeout(10_000)
                  .emit(
                    "sfu:tracks",
                    { ...scope, sessionId, body },
                    (err, res) => {
                      if (err) return resolve({ fail: String(err) });
                      if (!res?.ok)
                        return resolve({ fail: res?.reason ?? "error" });
                      resolve({ value: res.result });
                    },
                  );
              }),
            1,
          ),
        renegotiate: async (sessionId, sessionDescription) =>
          (await attempt<true>(
            () =>
              new Promise((resolve) => {
                if (!socket) return resolve({ fail: "no socket" });
                socket
                  .timeout(10_000)
                  .emit(
                    "sfu:renegotiate",
                    { ...scope, sessionId, body: { sessionDescription } },
                    (err, res) => {
                      if (err) return resolve({ fail: String(err) });
                      if (!res?.ok)
                        return resolve({ fail: res?.reason ?? "error" });
                      resolve({ value: true });
                    },
                  );
              }),
            1,
          )) === true,
        closeTracks: (sessionId, mids) => {
          socket?.emit("sfu:close", {
            ...scope,
            sessionId,
            body: { tracks: mids.map((mid) => ({ mid })), force: false },
          });
        },
      };
    },
    [socket],
  );

  return useMemo(() => ({ sfuApi }), [sfuApi]);
}
