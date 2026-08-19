"use client";

/**
 * The conversation ROSTER and the things that hang off it: which conversations
 * this user may see, their meta, presence, pins, unread counts, and the
 * workspace/profile documents the server owns.
 *
 * The roster is authoritative and complete — anything in state that isn't in it
 * is a conversation we've since been removed from, so its local history is
 * dropped for the same reason a deletion drops it: we can no longer open it, so
 * its ciphertext shouldn't sit on disk.
 */
import { useEffect } from "react";
import * as msgdb from "@/lib/message-db";
import type { Group, GroupMap, User, UserProfile } from "@/lib/chat-data";
import { chat } from "@/stores/chat-store";
import { withSelf } from "@/stores/chat-selectors";
import type { TypedSocket } from "@/stores/session-store";
import { resolvePins } from "../lib/pins";
import type { History } from "./use-history";
import type { PendingMessages } from "./use-pending-messages";

export function useRosterEvents({
  socket,
  history,
  pending,
}: {
  socket: TypedSocket | null;
  history: History;
  pending: PendingMessages;
}) {
  const { latestByGroupRef, seedPreviews, applyResolvedPins } = history;
  const { withHeld } = pending;

  useEffect(() => {
    if (!socket) return;

    // Authorized roster from the server — drives the sidebar lists.
    const onGroupsList = ({ groups: roster }: { groups: Group[] }) => {
      const visible = new Set(roster.map((c) => c.id));
      for (const id of Object.keys(chat().groups)) {
        if (!visible.has(id)) void msgdb.removeGroup(id);
      }
      chat().setGroups((s) => {
        // Drop what's no longer visible before merging: the sidebar reads the
        // roster-derived order (so it would hide these anyway), but the
        // Mentions/Drafts badges count Object.values(groups) and would keep
        // scoring messages from conversations that are gone.
        const next: GroupMap = {};
        for (const [id, ch] of Object.entries(s)) {
          if (visible.has(id)) next[id] = ch;
        }
        for (const c of roster) {
          // Apply server meta (incl. viewer-correct DM partner) but keep any
          // messages already loaded for this group. When none are loaded, seed the
          // last message from the prefetched local map so the row shows its
          // correct preview + recency order on this very first render.
          const loaded = next[c.id]?.messages;
          const seed = latestByGroupRef.current.get(c.id);
          // A roster-cache placeholder doesn't count as loaded: prefer the real
          // last message from local history when we have one.
          const hasReal = loaded?.some((m) => !m.snapshot);
          next[c.id] = {
            ...c,
            messages: withHeld(
              c.id,
              hasReal ? loaded! : seed ? [withSelf(seed)] : loaded ?? [],
            ),
          };
        }
        return next;
      });
      chat().setGroupOrder(roster.filter((c) => c.type === "group").map((c) => c.id));
      chat().setDmOrder(roster.filter((c) => c.type === "dm").map((c) => c.id));
      chat().setRosterLoaded(true);
      // Resolve pin snippets from local history for each group.
      for (const c of roster) {
        if (c.pinIds?.length) void applyResolvedPins(c.id, c.pinIds);
      }
      // Fallback/refresh: re-read local history and upgrade any conversation whose
      // preview is missing or stale (e.g. the socket beat the cold DB worker, or
      // the persisted snapshot lagged). Opening a conversation later replaces the
      // seed with its full page; live arrivals keep it current.
      void msgdb.getLatestPerGroup().then((latest) => {
        latestByGroupRef.current = new Map(latest.map((x) => [x.groupId, x.message]));
        seedPreviews(latest);
      });
    };

    // A group or DM someone created — surface it in the right sidebar list.
    const onGroupCreated = ({ group }: { group: Group }) => {
      chat().setGroups((s) =>
        s[group.id]
          ? s
          : {
              ...s,
              [group.id]: {
                ...group,
                messages: withHeld(group.id, group.messages.map(withSelf)),
              },
            },
      );
      const setOrder =
        group.type === "dm" ? chat().setDmOrder : chat().setGroupOrder;
      setOrder((order) => (order.includes(group.id) ? order : [...order, group.id]));
      if (group.pinIds?.length) void applyResolvedPins(group.id, group.pinIds);
    };

    // A group's meta/roster changed — merge it in, keeping loaded messages.
    const onGroupUpdated = ({ group }: { group: Group }) => {
      chat().setGroups((s) => {
        const existing = s[group.id];
        if (!existing) return s;
        return {
          ...s,
          [group.id]: { ...existing, ...group, messages: existing.messages },
        };
      });
    };

    // A group was deleted — drop it everywhere; navigate off it if current.
    const onGroupDeleted = ({ groupId }: { groupId: string }) => {
      void msgdb.removeGroup(groupId);
      const before = chat().groups;
      chat().removeGroup(groupId);
      chat().setGroupOrder((o) => o.filter((id) => id !== groupId));
      chat().setDmOrder((o) => o.filter((id) => id !== groupId));
      if (chat().currentGroupId === groupId) {
        const next = Object.keys(before).find(
          (id) => id !== groupId && before[id].type === "group",
        );
        chat().navigateTo(next ?? "");
        chat().setThreadFor(null);
        chat().setGroupInfoOpen(false);
      }
    };

    // Presence: reflect a user's online state on every DM group with them.
    const onPresence = ({
      userId: uid,
      status: presence,
    }: {
      userId: string;
      status: "active" | "idle" | "offline";
    }) => {
      chat().setGroups((s) => {
        let changed = false;
        const next: GroupMap = { ...s };
        for (const id of Object.keys(next)) {
          const ch = next[id];
          if (ch.type === "dm" && ch.user?.id === uid) {
            next[id] = { ...ch, presence };
            changed = true;
          }
        }
        return changed ? next : s;
      });
    };

    const onWorkspace = ({ name, members }: { name: string; members: User[] }) => {
      chat().setWorkspaceName(name);
      chat().setWorkspaceMembers(members);
    };

    const onProfile = ({
      profile,
      user,
    }: {
      profile: UserProfile;
      user: User;
    }) => {
      chat().setProfile(profile);
      chat().setProfileUser(user);
    };

    const onUnreadState = ({ counts }: { counts: Record<string, number> }) =>
      chat().setUnreadByGroup(counts);

    const onUnreadBump = ({ groupId }: { groupId: string }) => {
      // Ignore the group we're actively viewing (it stays read).
      if (groupId === chat().currentGroupId) return;
      chat().setUnreadByGroup((s) => ({ ...s, [groupId]: (s[groupId] ?? 0) + 1 }));
    };

    const onPins = async ({
      groupId,
      pinIds,
    }: {
      groupId: string;
      pinIds: string[];
    }) => {
      const pinned = await resolvePins(pinIds);
      chat().setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        return { ...s, [groupId]: { ...ch, pinIds, pinned } };
      });
    };

    socket.on("groups:list", onGroupsList);
    socket.on("group:created", onGroupCreated);
    socket.on("group:updated", onGroupUpdated);
    socket.on("group:deleted", onGroupDeleted);
    socket.on("presence:update", onPresence);
    socket.on("workspace:updated", onWorkspace);
    socket.on("profile:updated", onProfile);
    socket.on("unread:state", onUnreadState);
    socket.on("unread:bump", onUnreadBump);
    socket.on("pins:updated", onPins);
    return () => {
      socket.off("groups:list", onGroupsList);
      socket.off("group:created", onGroupCreated);
      socket.off("group:updated", onGroupUpdated);
      socket.off("group:deleted", onGroupDeleted);
      socket.off("presence:update", onPresence);
      socket.off("workspace:updated", onWorkspace);
      socket.off("profile:updated", onProfile);
      socket.off("unread:state", onUnreadState);
      socket.off("unread:bump", onUnreadBump);
      socket.off("pins:updated", onPins);
    };
  }, [socket, latestByGroupRef, seedPreviews, applyResolvedPins, withHeld]);
}
