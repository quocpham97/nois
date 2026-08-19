"use client";

/**
 * The viewer's profile document, and the Messenger customization that lives
 * inside it: chat color, the composer's Like emoji, and archived conversations.
 * Writes are optimistic; the server echo (`profile:updated`) reconciles the
 * canonical document (trimming + empty-value deletion).
 */
import { useCallback, useEffect, useMemo } from "react";
import { gradientFor, type UserProfile } from "@/lib/chat-data";
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
