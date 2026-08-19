"use client";

/**
 * The chat composition root. It renders nothing of its own: it wires the logic
 * hooks together in dependency order, mirrors the socket session into the store,
 * and publishes the effectful actions through a stable context.
 *
 * The order below IS the dependency graph — key material underpins MLS, MLS and
 * sender-keys together decide how a body is sealed, sealing feeds the decrypt
 * path and the send actions, and the socket-event hooks sit on top of all of it.
 * Each layer takes what it needs as an argument rather than reaching for a shared
 * mutable scope, which is what makes the pieces readable (and movable) on their
 * own.
 */
import { useCallback, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { uiActions } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionActions } from "./session-actions";
import { ChatActionsProvider, type ChatActionsValue } from "./chat-actions";
import { useOutbox } from "./hooks/use-outbox";
import { useKeyMaterial } from "./hooks/use-key-material";
import { useMls } from "./hooks/use-mls";
import { useSeal } from "./hooks/use-seal";
import { useDecrypt } from "./hooks/use-decrypt";
import { useReceipts } from "./hooks/use-receipts";
import { useHistory } from "./hooks/use-history";
import { usePendingMessages } from "./hooks/use-pending-messages";
import { useMessageEvents } from "./hooks/use-message-events";
import { useRosterEvents } from "./hooks/use-roster-events";
import { useKeyEvents } from "./hooks/use-key-events";
import { useTyping } from "./hooks/use-typing";
import { useSessionSync } from "./hooks/use-session-sync";
import { useChatRouting } from "./hooks/use-chat-routing";
import { useRosterCache } from "./hooks/use-roster-cache";
import { useDrafts } from "./hooks/use-drafts";
import { useMessageActions } from "./hooks/use-message-actions";
import { useGroupActions } from "./hooks/use-group-actions";
import { useWorkspaceActions } from "./hooks/use-workspace-actions";
import { useProfileActions } from "./hooks/use-profile-actions";
import { useCompose } from "./hooks/use-compose";

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { socket, status, userId, sessionDeviceId } = useSessionStore(
    useShallow((s) => ({
      socket: s.socket,
      status: s.status,
      userId: s.userId,
      sessionDeviceId: s.deviceId,
    })),
  );
  const { backupNow, replenishKeys } = useSessionActions();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // --- crypto layers -------------------------------------------------------
  const outbox = useOutbox(userId);
  const keys = useKeyMaterial({ socket, userId, backupNow, replenishKeys });
  const mls = useMls({ socket, userId, sessionDeviceId, getSecrets: keys.getSecrets });
  const seal = useSeal({ socket, userId, keys, mls });
  const decrypt = useDecrypt({ socket, userId, keys, mls, outbox });
  const { scheduleReceipt } = useReceipts({ socket, userId, keys, decrypt, seal });

  // --- local history + live events -----------------------------------------
  const history = useHistory({ scrollToBottom });
  const pending = usePendingMessages();
  const typing = useTyping({ socket });

  useMessageEvents({
    socket,
    userId,
    outbox,
    history,
    pending,
    scheduleReceipt,
    scheduleBackup: keys.scheduleBackup,
  });
  useRosterEvents({ socket, history, pending });
  useKeyEvents({ socket, userId, keys });
  useSessionSync({ socket, status, history, outbox, scheduleReceipt });

  // --- view-facing concerns ------------------------------------------------
  useChatRouting();
  useRosterCache({ userId });
  useDrafts({ userId });

  const messages = useMessageActions({ socket, outbox, seal, typing, scrollToBottom });
  const groupActions = useGroupActions({ socket });
  const workspace = useWorkspaceActions({ socket });
  const profile = useProfileActions({ socket });
  const compose = useCompose({ socket, keys, outbox, scrollToBottom });

  const actions = useMemo<ChatActionsValue>(
    () => ({
      // The store's transitions and setters are created once with the store, so
      // folding them in here keeps this value stable while giving views a single
      // behaviour surface.
      ...uiActions(),
      ...messages,
      loadOlder: history.loadOlder,
      jumpToMessage: history.jumpToMessage,
      ...groupActions,
      ...workspace,
      ...profile,
      ...compose,
      notifyTyping: typing.notifyTyping,
      acknowledgeKeyAlert: keys.acknowledgeKeyAlert,
      exportCallKey: mls.exportCallKey,
      scrollRef,
    }),
    [
      messages,
      history.loadOlder,
      history.jumpToMessage,
      groupActions,
      workspace,
      profile,
      compose,
      typing.notifyTyping,
      keys.acknowledgeKeyAlert,
      mls.exportCallKey,
    ],
  );

  return <ChatActionsProvider value={actions}>{children}</ChatActionsProvider>;
}
