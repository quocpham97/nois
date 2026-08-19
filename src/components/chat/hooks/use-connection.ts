"use client";

/**
 * The socket itself: opening it, tracking its status, and what happens the moment
 * it connects.
 *
 * On connect, a returning device provisions normally. A FRESH device publishes a
 * new identity, then tries device-to-device recovery (another online device of
 * ours), then falls back to the PIN restore modal, then to a clean start.
 *
 * The connect handler is registered once for the life of the socket, so the
 * bootstrap and the recovery relays are dispatched through refs kept current each
 * render — otherwise a reconnect would run last render's closures.
 */
import { useCallback, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { cryptoAvailable, hasDeviceIdentity } from "@/lib/crypto/identity";
import { session, type TypedSocket } from "@/stores/session-store";
import type { BackupVault } from "./use-backup-vault";
import type { DeviceIdentity } from "./use-device-identity";
import type { DeviceRecovery } from "./use-device-recovery";
import type { HistorySync } from "./use-history-sync";

export function useConnection({
  userId,
  socketRef,
  vault,
  identity,
  recovery,
  history,
}: {
  userId: string;
  socketRef: React.RefObject<TypedSocket | null>;
  vault: BackupVault;
  identity: DeviceIdentity;
  recovery: DeviceRecovery;
  history: HistorySync;
}) {
  const bootstrapIdentity = useCallback(
    async (s: TypedSocket) => {
      if (identity.provisionedRef.current || !cryptoAvailable()) return;
      const res = await vault.getBackup(s);
      session().setBackupUpdatedAt(res.updatedAt);
      if (await hasDeviceIdentity(userId)) {
        await identity.provisionAndPublish(s);
        // Existing install that already holds a storage key but predates continuous
        // appends: seed the history store once (marker-guarded).
        void history.syncUp();
        return;
      }
      // Publish a fresh identity so peers can target it.
      await identity.provisionAndPublish(s);
      if (await recovery.tryRecovery(s)) {
        // Reload so the chat hooks re-read the imported seeds and 🔒 history
        // re-decrypts cleanly (same approach as the manual PIN restore).
        window.location.reload();
        return;
      }
      if (res.updatedAt) session().setNeedsRestore(true); // fall back to PIN restore
    },
    [vault, identity, recovery, history, userId],
  );

  const bootstrapRef = useRef(bootstrapIdentity);
  const onRequestRef = useRef(recovery.onRequest);
  const onOfferRef = useRef(recovery.onOffer);
  useEffect(() => {
    bootstrapRef.current = bootstrapIdentity;
    onRequestRef.current = recovery.onRequest;
    onOfferRef.current = recovery.onOffer;
  });

  useEffect(() => {
    // Same-origin connection — the session cookie is sent automatically and
    // verified by the server's handshake middleware.
    const s: TypedSocket = io({
      withCredentials: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    session().setSocket(s);
    socketRef.current = s;

    const runHealthCheck = () => {
      const t = Date.now();
      s.emit("echo", { t }, (reply) => {
        session().setLatencyMs(Date.now() - reply.t);
      });
    };

    s.on("connect", () => {
      session().setStatus("connected");
      runHealthCheck();
      // Provision keys (or pause for restore if a backup exists and this device has
      // none). Best-effort: a runtime without WebCrypto just skips it.
      void bootstrapRef.current(s).catch((err) =>
        console.warn("[e2ee] key bootstrap failed", err),
      );
    });
    s.on("disconnect", () => session().setStatus("disconnected"));
    s.io.on("reconnect_attempt", () => session().setStatus("reconnecting"));

    // Device-to-device recovery relays (same-user devices only, server-enforced).
    s.on("recovery:request", (p) => void onRequestRef.current(p));
    s.on("recovery:offer", (p) => void onOfferRef.current(p));

    // Proactively reconnect when the network / tab comes back (e.g. after sleep),
    // rather than waiting for the ping timeout to notice the dead connection.
    const nudge = () => {
      if (!s.connected) s.connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") nudge();
    };
    window.addEventListener("online", nudge);
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("online", nudge);
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", onVisible);
      s.removeAllListeners();
      s.io.removeAllListeners();
      s.close();
      session().setSocket(null);
    };
  }, [socketRef]);
}
