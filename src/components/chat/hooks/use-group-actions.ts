"use client";

/**
 * Group management: create, edit meta, delete, membership, and the shared chat
 * color. All of it is server-authoritative — these emit and let the broadcast
 * come back, rather than writing optimistically — so every member converges on
 * the same group state.
 */
import { useCallback, useMemo } from "react";
import { chat } from "@/stores/chat-store";
import type { TypedSocket } from "@/stores/session-store";

export type GroupActions = ReturnType<typeof useGroupActions>;

export function useGroupActions({ socket }: { socket: TypedSocket | null }) {
  const createGroup = useCallback(
    (
      name: string,
      topic: string,
      memberIds: string[],
      onError?: (msg: string) => void,
    ) => {
      const trimmed = name.trim();
      if (!trimmed) {
        onError?.("Enter a group name.");
        return;
      }
      if (!memberIds.length) {
        onError?.("Add at least one person to the group.");
        return;
      }
      socket?.emit(
        "group:create",
        { name: trimmed, topic: topic.trim() || undefined, memberIds },
        (res) => {
          if (res.ok) {
            chat().setCreateGroupOpen(false);
            chat().selectGroup(res.groupId);
          } else {
            onError?.(res.error);
          }
        },
      );
    },
    [socket],
  );

  const updateGroup = useCallback(
    (
      groupId: string,
      patch: { name?: string; topic?: string },
      onError?: (msg: string) => void,
    ) => {
      socket?.emit("group:update", { groupId, ...patch }, (res) => {
        if (!res.ok) onError?.(res.error);
      });
    },
    [socket],
  );

  const deleteGroup = useCallback(
    (groupId: string, onError?: (msg: string) => void) => {
      socket?.emit("group:delete", { groupId }, (res) => {
        if (!res.ok) onError?.(res.error);
      });
    },
    [socket],
  );

  const addGroupMember = useCallback(
    (groupId: string, memberId: string) => {
      socket?.emit("group:addMember", { groupId, userId: memberId }, () => {});
    },
    [socket],
  );

  const removeGroupMember = useCallback(
    (groupId: string, memberId: string) => {
      socket?.emit("group:removeMember", { groupId, userId: memberId }, () => {});
    },
    [socket],
  );

  /** A conversation's chat color is shared: the server stores it on the group and
   *  broadcasts group:updated to every member, so all of them re-render. No
   *  optimistic write — the broadcast comes back to us too. */
  const setGroupTheme = useCallback(
    (groupId: string, theme: string | null) => {
      socket?.emit("group:setTheme", { groupId, theme });
    },
    [socket],
  );

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      createGroup,
      updateGroup,
      deleteGroup,
      addGroupMember,
      removeGroupMember,
      setGroupTheme,
    }),
    [createGroup, updateGroup, deleteGroup, addGroupMember, removeGroupMember, setGroupTheme],
  );
}
