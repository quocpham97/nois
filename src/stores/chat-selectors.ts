/**
 * Narrow reads over the chat store.
 *
 * Views should reach for these rather than pulling a wide object out of the
 * store: each hook subscribes to the smallest slice that answers its question,
 * so a keystroke in the composer can't re-render the sidebar. Derived values
 * that would otherwise allocate on every run (`profile.archived ?? []`,
 * `Object.values(keyAlerts)`) are memoised or share a stable empty constant, so
 * they compare equal between renders.
 *
 * The plain (non-hook) helpers at the bottom read the same state from outside
 * React — socket handlers, timers and the crypto paths use them instead of the
 * refs the old provider had to mirror state into.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Group, GroupMeta, Message, User } from "@/lib/chat-data";
import type { Pin } from "@/lib/crypto/pinning";
import { EMPTY_IDS, chat, useChatStore } from "./chat-store";
import { session, useSessionStore } from "./session-store";

// --- conversations ---------------------------------------------------------

export const useGroup = (groupId: string): Group | undefined =>
  useChatStore((s) => s.groups[groupId]);

export const useCurrentGroup = (): Group | undefined =>
  useChatStore((s) => s.groups[s.currentGroupId]);

export const useCurrentGroupId = (): string =>
  useChatStore((s) => s.currentGroupId);

/**
 * A conversation's metadata — everything except its message list.
 *
 * Shallow-compared, so a header, a pinned bar or a typing indicator re-renders
 * when the group is renamed or its pins change, but NOT every time a message
 * arrives. Passing the whole `Group` down as a prop is what made those re-render
 * on every message, since the group object is replaced on each new one.
 */
export function useGroupMeta(groupId: string): GroupMeta | undefined {
  return useChatStore(
    useShallow((s) => {
      const ch = s.groups[groupId];
      if (!ch) return undefined;
      const { messages: _messages, ...meta } = ch;
      void _messages;
      return meta;
    }),
  );
}

/** One conversation's messages — the only slice a message list needs. */
export const useGroupMessages = (groupId: string): Message[] =>
  useChatStore((s) => s.groups[groupId]?.messages ?? EMPTY_MESSAGES);

const EMPTY_MESSAGES: Message[] = [];

// --- viewer identity ------------------------------------------------------

/** The viewer's effective display identity: the edited profile wins over the
 *  session so a renamed display name shows everywhere the viewer is rendered.
 *  Returns one of two stored objects, so its identity is stable. */
export function useMyUser(): User {
  const profileUser = useChatStore((s) => s.profileUser);
  const sessionUser = useSessionStore((s) => s.user);
  return profileUser ?? sessionUser;
}

export const useUserId = (): string => useSessionStore((s) => s.userId);

// --- profile-backed customization -----------------------------------------

export const useBubbleTheme = (): string =>
  useChatStore((s) => s.profile.bubbleTheme ?? "default");

export const useLikeEmoji = (): string =>
  useChatStore((s) => s.profile.likeEmoji ?? "👍");

export const useArchivedIds = (): string[] =>
  useChatStore((s) => s.profile.archived ?? EMPTY_IDS);

export const useIsArchived = (groupId: string): boolean =>
  useChatStore((s) => (s.profile.archived ?? EMPTY_IDS).includes(groupId));

// --- E2EE surfacing -------------------------------------------------------

/** TOFU alerts as a list. Shallow-compared: the store keeps them keyed by
 *  deviceId, and `Object.values` would otherwise be a new array every render. */
export const useKeyAlerts = (): Pin[] =>
  useChatStore(useShallow((s) => Object.values(s.keyAlerts)));

// --- derived views --------------------------------------------------------

/** The message currently being edited, resolved from live state so the composer
 *  seeds from the freshest body. */
export function useEditingMessage(): Message | null {
  const editing = useChatStore((s) => s.editing);
  const group = useChatStore((s) => (editing ? s.groups[editing.groupId] : undefined));
  return useMemo(() => {
    if (!editing || !group) return null;
    return (
      (editing.parentId
        ? group.messages
            .find((m) => m.id === editing.parentId)
            ?.threadReplies?.find((r) => r.id === editing.msgId)
        : group.messages.find((m) => m.id === editing.msgId)) ?? null
    );
  }, [editing, group]);
}

/**
 * For the CURRENT group, place each other user's "seen by" avatar on the newest
 * top-level message their cursor covers (Messenger-style). Keyed by msgId for
 * O(1) lookup in the message row.
 */
export function useSeenByMsgId(): Record<string, User[]> {
  const currentGroupId = useChatStore((s) => s.currentGroupId);
  const messages = useGroupMessages(currentGroupId);
  const cursors = useChatStore((s) => s.receiptsByGroup[currentGroupId]);
  const userId = useSessionStore((s) => s.userId);
  const members = useChatStore((s) => s.workspaceMembers);
  const dmPartner = useChatStore((s) => s.groups[currentGroupId]?.user);

  return useMemo(() => {
    if (!cursors) return {};
    const tops = messages.filter((m) => typeof m.seq === "number" && !m.deleted);
    if (!tops.length) return {};
    const out: Record<string, User[]> = {};
    for (const [uid, { readSeq }] of Object.entries(cursors)) {
      if (uid === userId) continue; // never render our own receipt
      let best: Message | null = null;
      for (const m of tops) {
        if (m.seq! <= readSeq && (!best || m.seq! > best.seq!)) best = m;
      }
      if (!best) continue;
      if (best.author?.id === uid) continue; // don't badge a user's own message
      (out[best.id] ||= []).push(receiptUser(uid, members, dmPartner));
    }
    return out;
  }, [messages, cursors, userId, members, dmPartner]);
}

/** Resolve a receipt's userId to a display User for its "seen by" avatar. */
function receiptUser(
  uid: string,
  members: User[],
  dmPartner: User | undefined,
): User {
  const m = members.find((u) => u.id === uid);
  if (m) return m;
  if (dmPartner?.id === uid) return dmPartner;
  const at = uid.indexOf("@");
  const label = at > 0 ? uid.slice(0, at) : uid;
  return {
    id: uid,
    name: label,
    initials: label.slice(0, 2).toUpperCase(),
    bg: "#8b8b8b",
  };
}

// --- reads from outside React ---------------------------------------------

/**
 * Whether a conversation is a 1:1 DM (vs a group). The `type` field is the sole
 * discriminator now that ids no longer carry a "dm-" prefix, so this reads the
 * live roster — which is always populated by the time an E2EE send/receipt path
 * runs (the conversation must be selected/loaded first). Unknown id → group.
 */
export const isDm = (groupId: string): boolean =>
  chat().groups[groupId]?.type === "dm";

/**
 * The DM peer's uid for a group, from its viewer-corrected partner. The
 * partner's `id` is the key their E2EE bundles are published under — derive it
 * from there, never from the display name (real users are keyed by email) and
 * never from the group id, which is an opaque hash of the pair. Empty when the
 * partner isn't known yet; callers treat that as "can't seal".
 */
export const dmPeerId = (groupId: string): string =>
  chat().groups[groupId]?.user?.id ?? "";

/** The viewer's effective identity, outside React. */
export const myUser = (): User => chat().profileUser ?? session().user;

/** `self` is viewer-relative, so it's computed on arrival from the wire rather
 *  than trusted from the server. */
export const withSelf = (m: Message): Message => ({
  ...m,
  self: m.author.name === myUser().name,
});
