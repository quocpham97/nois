"use client";

/**
 * The session composition root: opens the socket, provisions this device's E2EE
 * identity, and publishes the backup/recovery actions.
 *
 * Identity comes from the authenticated session (passed from the server). The
 * handshake itself is authorized via the session cookie, not these values.
 */
import { useEffect, useMemo, useRef } from "react";
import { deriveUser } from "@/lib/chat-data";
import { session, useSessionStore, type TypedSocket } from "@/stores/session-store";
import {
  SessionActionsProvider,
  type SessionActionsValue,
} from "./session-actions";
import { useBackupVault } from "./hooks/use-backup-vault";
import { useHistorySync } from "./hooks/use-history-sync";
import { useDeviceIdentity } from "./hooks/use-device-identity";
import { useDeviceRecovery } from "./hooks/use-device-recovery";
import { useKeyBackup } from "./hooks/use-key-backup";
import { useConnection } from "./hooks/use-connection";

export function SessionProvider({
  meId,
  meName,
  children,
}: {
  meId: string;
  meName?: string;
  children: React.ReactNode;
}) {
  const user = useMemo(() => deriveUser(meId, meName), [meId, meName]);

  // Seed the store before anything reads it. `useSessionStore.setState` outside
  // React is safe here (it isn't React state), and doing it during render rather
  // than in an effect means the very first paint already knows who we are.
  if (session().userId !== meId) session().setIdentity(meId, user);
  useEffect(() => {
    if (session().userId !== meId || session().user !== user) {
      session().setIdentity(meId, user);
    }
  }, [meId, user]);

  /** The socket, for the hooks whose callbacks outlive a render. */
  const socketRef = useRef<TypedSocket | null>(null);

  const vault = useBackupVault();
  const history = useHistorySync({ userId: meId, socketRef });
  const identity = useDeviceIdentity({ userId: meId, socketRef });
  const recovery = useDeviceRecovery({ userId: meId, socketRef, history });
  const backup = useKeyBackup({
    userId: meId,
    socketRef,
    vault,
    identity,
    history,
  });

  useConnection({ userId: meId, socketRef, vault, identity, recovery, history });

  const actions = useMemo<SessionActionsValue>(
    () => ({
      ...backup,
      replenishKeys: identity.replenishKeys,
      approveDevice: recovery.approveDevice,
      denyDevice: recovery.denyDevice,
    }),
    [backup, identity.replenishKeys, recovery.approveDevice, recovery.denyDevice],
  );

  return (
    <SessionActionsProvider value={actions}>{children}</SessionActionsProvider>
  );
}

/** Re-exported so views keep a single import for "am I connected". */
export { useSessionStore };
