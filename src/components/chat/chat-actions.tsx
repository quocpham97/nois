"use client";

/**
 * The effectful half of the chat API.
 *
 * State reads go through the store (`useChatStore` / the selectors in
 * stores/chat-selectors), but anything that needs the socket, the crypto stores
 * or a React ref can't live there. Those land here, in a context whose value is
 * REFERENTIALLY STABLE: it's built once from `useCallback`-stable functions, so a
 * component that only needs `sendMessage` never re-renders because a message
 * arrived. That split is the point — subscribe to data, not to behaviour.
 */
import { createContext, useContext } from "react";
import type { CallEvent, LinkPreview, Message, UserProfile } from "@/lib/chat-data";
import type { ChatUiActions } from "@/stores/chat-store";

/** The half that needs the socket, the crypto stores, or a React ref. */
type EffectfulActions = {
  // --- messages ---
  sendMessage: (text: string, rich?: string, preview?: LinkPreview) => void;
  retrySend: (groupId: string, msgId: string) => void;
  deleteMessage: (groupId: string, msgId: string) => void;
  startEdit: (groupId: string, msg: Message) => void;
  submitEdit: (text: string, rich?: string) => void;
  forwardMessage: (toGroupIds: string[]) => void;
  sendThreadMessage: (text: string, rich?: string) => void;
  toggleReaction: (msgId: string, emoji: string) => void;
  clearPins: (groupId: string) => void;
  togglePin: (groupId: string, msgId: string) => void;
  /** Append a finished call to a conversation as an E2EE message. Caller-side
   *  only — CallProvider owns when this fires (one row per call). */
  logCallEvent: (groupId: string, call: CallEvent) => void;

  // --- history ---
  loadOlder: (groupId: string) => void;
  /** Jump to a message (loads a window around it, scrolls + highlights). Pass
   *  parentId for a thread-reply target (opens the thread panel instead). */
  jumpToMessage: (
    groupId: string,
    msgId: string,
    parentId?: string | null,
  ) => void;

  // --- groups ---
  createGroup: (
    name: string,
    topic: string,
    memberIds: string[],
    onError?: (msg: string) => void,
  ) => void;
  updateGroup: (
    groupId: string,
    patch: { name?: string; topic?: string },
    onError?: (msg: string) => void,
  ) => void;
  deleteGroup: (groupId: string, onError?: (msg: string) => void) => void;
  addGroupMember: (groupId: string, memberId: string) => void;
  removeGroupMember: (groupId: string, memberId: string) => void;
  /** This conversation's chat color, for every member. null → each member's own
   *  default. */
  setGroupTheme: (groupId: string, theme: string | null) => void;

  // --- workspace ---
  renameWorkspace: (name: string, onError?: (msg: string) => void) => void;
  inviteWorkspaceMember: (memberId: string) => void;
  removeWorkspaceMember: (memberId: string) => void;

  // --- profile ---
  updateProfile: (patch: Partial<UserProfile>) => void;
  setBubbleTheme: (t: string) => void;
  setLikeEmoji: (e: string) => void;
  toggleArchived: (groupId: string) => void;

  // --- compose / typing ---
  sendCompose: () => void;
  notifyTyping: (groupId: string) => void;

  // --- E2EE ---
  /** Accept a flagged key change and re-pin to the new key. */
  acknowledgeKeyAlert: (deviceId: string) => Promise<void>;
  /**
   * Media key for a call in this group, derived from the group's MLS exporter
   * secret so every member at the same epoch gets the same bytes with no extra
   * round trip. Null when the group has no MLS state (DMs are pairwise), which is
   * what confines SFU calls to MLS groups. See docs/calls-production.md.
   */
  exportCallKey: (
    groupId: string,
    callId: string,
  ) => Promise<{ epoch: number; key: Uint8Array } | null>;

  /** The conversation scroll container, for scroll-position reads/writes. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
};

/**
 * One behaviour surface for views: the effectful actions above, plus the store's
 * own pure transitions and setters. A view never has to know which half a call
 * belongs to — it reads with `useChatStore` and acts with `useChatActions`.
 */
export type ChatActionsValue = EffectfulActions & ChatUiActions;

const ChatActionsContext = createContext<ChatActionsValue | null>(null);

export const ChatActionsProvider = ChatActionsContext.Provider;

export function useChatActions(): ChatActionsValue {
  const ctx = useContext(ChatActionsContext);
  if (!ctx) throw new Error("useChatActions must be used within ChatProvider");
  return ctx;
}
