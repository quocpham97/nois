"use client";

/**
 * Workspace identity + membership. Server-backed and shared, so these only emit;
 * `workspace:updated` brings the canonical document back to every client.
 */
import { useCallback, useMemo } from "react";
import type { TypedSocket } from "@/stores/session-store";

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;

export function useWorkspaceActions({ socket }: { socket: TypedSocket | null }) {
  const renameWorkspace = useCallback(
    (name: string, onError?: (msg: string) => void) => {
      socket?.emit("workspace:rename", { name }, (res) => {
        if (!res.ok) onError?.(res.error);
      });
    },
    [socket],
  );

  const inviteWorkspaceMember = useCallback(
    (memberId: string) => {
      socket?.emit("workspace:invite", { userId: memberId }, () => {});
    },
    [socket],
  );

  const removeWorkspaceMember = useCallback(
    (memberId: string) => {
      socket?.emit("workspace:removeMember", { userId: memberId }, () => {});
    },
    [socket],
  );

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      renameWorkspace,
      inviteWorkspaceMember,
      removeWorkspaceMember,
    }),
    [renameWorkspace, inviteWorkspaceMember, removeWorkspaceMember],
  );
}
