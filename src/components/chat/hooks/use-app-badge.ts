"use client";

/**
 * The unread count, on the outside of the app.
 *
 * Unread was only ever visible inside the sidebar, which is no use to someone
 * who has the app in another tab or another window — the case notifications
 * exist for. The same number goes to three places, each of which is the only
 * one some viewer will see: the tab title (always available), the Badging API
 * (installed PWAs), and the native shell's dock/taskbar icon.
 *
 * Muted conversations are left out. They still show their unread count in the
 * sidebar — muting silences notifications rather than hiding a conversation —
 * but a badge is a demand for attention, which is the thing being declined.
 * No timer watches a timed mute expire: the count catches up on the next unread
 * change, which is the only moment the number could have been wrong anyway.
 */
import { useEffect } from "react";
import { isMuted } from "@/lib/notif-policy";
import { getShellBridge } from "@/lib/shell";
import { useChatStore } from "@/stores/chat-store";

/** The Badging API, absent from lib.dom and from most browsing contexts. */
type Badged = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** The document title as rendered, captured before anything is prefixed onto it. */
let baseTitle: string | null = null;

export function useAppBadge(): void {
  const unreadByGroup = useChatStore((s) => s.unreadByGroup);
  const notif = useChatStore((s) => s.profile.notif);

  useEffect(() => {
    baseTitle ??= document.title;
    const now = Date.now();
    const total = Object.entries(unreadByGroup).reduce(
      (n, [groupId, count]) => (isMuted(notif, groupId, now) ? n : n + count),
      0,
    );

    document.title = total ? `(${total}) ${baseTitle}` : baseTitle;

    const nav = navigator as Badged;
    // Chrome/Edge on an installed PWA, and Safari 16.4+. A plain tab has
    // nowhere to draw it, so a missing API is the normal case, not a failure.
    void (total ? nav.setAppBadge?.(total) : nav.clearAppBadge?.())?.catch(
      () => {},
    );

    // Native shells own their own icon. Optional-called because an installed
    // desktop binary built before this exists simply won't have the method.
    getShellBridge()?.setBadge?.(total);
  }, [unreadByGroup, notif]);
}
