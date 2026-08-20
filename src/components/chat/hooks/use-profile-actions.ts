"use client";

/**
 * The viewer's profile document, and the Messenger customization that lives
 * inside it: chat color, the composer's Like emoji, and archived conversations.
 * Writes are optimistic; the server echo (`profile:updated`) reconciles the
 * canonical document (trimming + empty-value deletion).
 */
import { useCallback, useEffect, useMemo } from "react";
import { gradientFor, type UserProfile } from "@/lib/chat-data";
import { withNotifDefaults } from "@/lib/notif-policy";
import { EMPTY_IDS, chat, useChatStore } from "@/stores/chat-store";
import type { TypedSocket } from "@/stores/session-store";

export type ProfileActions = ReturnType<typeof useProfileActions>;

export function useProfileActions({ socket }: { socket: TypedSocket | null }) {
  const bubbleTheme = useChatStore((s) => s.profile.bubbleTheme ?? "default");

  const updateProfile = useCallback(
    (patch: Partial<UserProfile>) => {
      chat().setProfile((p) => ({ ...p, ...patch }));
      socket?.emit("profile:update", { patch });
    },
    [socket],
  );

  const setBubbleTheme = useCallback(
    (t: string) => updateProfile({ bubbleTheme: t }),
    [updateProfile],
  );

  const setLikeEmoji = useCallback(
    (e: string) => updateProfile({ likeEmoji: e }),
    [updateProfile],
  );

  const toggleArchived = useCallback(
    (id: string) => {
      const cur = chat().profile.archived ?? EMPTY_IDS;
      updateProfile({
        archived: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
      });
    },
    [updateProfile],
  );

  // Quiet hours are enforced where the push is sent — on the server, for a
  // device with no socket to ask — but "10 PM" means the USER's 10 PM, and the
  // server has no other way to learn which one that is. So the browser's own
  // UTC offset rides along in the saved preferences, refreshed while connected
  // so travel and DST correct themselves. Without it the server falls back to
  // its own clock (see notif-policy.ts).
  const notifPrefs = useChatStore((s) => s.profile.notif);
  // The server's copy of the profile arrives with `profileUser`; writing before
  // it lands would push client defaults over preferences we haven't seen yet.
  const profileLoaded = useChatStore((s) => s.profileUser !== null);
  useEffect(() => {
    if (!socket || !profileLoaded) return;
    const tzOffset = -new Date().getTimezoneOffset();
    if (notifPrefs?.tzOffset === tzOffset) return;
    updateProfile({ notif: { ...withNotifDefaults(notifPrefs), tzOffset } });
  }, [socket, profileLoaded, notifPrefs, updateProfile]);

  // The chat color drives the shared --sent-grad variable, so bubbles, the send
  // button, and the app logo all follow the chosen gradient.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--sent-grad",
      gradientFor(bubbleTheme),
    );
  }, [bubbleTheme]);

  // Memoised so the object identity is stable: it lands in other hooks'
  // dependency arrays, and a fresh one each render would re-run their effects.
  return useMemo(
    () => ({
      updateProfile,
      setBubbleTheme,
      setLikeEmoji,
      toggleArchived,
    }),
    [updateProfile, setBubbleTheme, setLikeEmoji, toggleArchived],
  );
}
