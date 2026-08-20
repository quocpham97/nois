"use client";

/**
 * The URL is the source of truth for the main view — a conversation (/<id>) or a
 * nav panel (/mentions, /drafts, …). This hook syncs state FROM the path on first
 * load, deep links, and browser back/forward; the store's navigation actions push
 * the URL, which re-triggers the same effect.
 *
 * It also owns the two global input surfaces that move the view: the ⌘K / Escape
 * shortcuts, and notification deep links (service worker, native shell, or a
 * cold open carrying ?channel=<id>).
 */
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { getShellBridge } from "@/lib/shell";
import { chat } from "@/stores/chat-store";
import { pathToId, pathToPanel } from "../lib/nav-paths";

export function useChatRouting() {
  const pathname = usePathname();

  useEffect(() => {
    const isSettings = pathname.replace(/^\/+|\/+$/g, "") === "settings";
    const panel = pathToPanel(pathname);
    const s = chat();
    if (isSettings || panel) {
      // Settings and panel paths keep the underlying group selection so closing
      // them returns to it; only the overlay layer changes.
      s.setActivePanel(panel);
    } else {
      s.setCurrentGroupId(pathToId(pathname));
      s.setActivePanel(null);
    }
    // The path owns the main view: dismiss state-only full-screen overlays so
    // back/forward reveals the routed view instead of a stale overlay.
    s.setThreadFor(null);
    s.setSearchOpen(false);
    s.setComposeOpen(false);
    s.setSettingsOpen(isSettings);
    s.setNewChatOpen(false);
    s.setWorkspaceOpen(false);
    // A quoted reply is scoped to the conversation it was started in — drop it
    // when the routed view changes so it can't carry into another group.
    s.setReplyingTo(null);
  }, [pathname]);

  // ⌘K / Esc keyboard shortcuts.
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        chat().setSearchOpen(true);
      } else if (e.key === "Escape") {
        chat().dismissOverlays();
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, []);

  // Deep link from a notification: the service worker postMessages `open-channel`
  // when its notification is clicked (browser), the Electron main process sends
  // the same via the desktop bridge (native notification click), and a cold open
  // arrives as `?channel=<id>`. All route to selectGroup. (The deep-link
  // vocabulary stays "channel"/channelId to match public/sw.js and the installed
  // desktop binary, which aren't renamed here.)
  useEffect(() => {
    const select = (id: string) => chat().selectGroup(id);
    const offDesktop = getShellBridge()?.onOpenChannel(select);
    const sw =
      typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; channelId?: string } | undefined;
      if (d?.type === "open-channel" && d.channelId) select(d.channelId);
    };
    sw?.addEventListener("message", onSwMessage);
    const param = new URLSearchParams(window.location.search).get("channel");
    if (param) {
      select(param);
      // Strip the param so a refresh doesn't re-trigger the jump.
      window.history.replaceState(null, "", window.location.pathname);
    }
    return () => {
      offDesktop?.();
      sw?.removeEventListener("message", onSwMessage);
    };
  }, []);
}
