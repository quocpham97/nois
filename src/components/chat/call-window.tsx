"use client";

// Pop the call surface out into its own OS window, the way Messenger does.
//
// The window is opened blank and the SAME React tree is portalled into it, so
// nothing about the call restarts: the MediaStreams, the PeerConnections and
// every bit of call state stay exactly where they are in the opener. Navigating
// a second window to a call route would instead mean a second socket, a second
// device identity and a renegotiated call — the thing this deliberately avoids.
//
// The cost is that the popup starts with an empty document, so its styles have
// to be adopted from the opener and kept in sync (dev HMR rewrites them, and
// the theme toggle rewrites the root attributes).

import { useCallback, useEffect, useRef, useState } from "react";

const FEATURES = "width=1024,height=720,menubar=no,toolbar=no,location=no,status=no";
/** Marks the clones so re-adopting can replace them without touching the rest. */
const ADOPTED = "data-call-adopted";

/** Mirror the opener's stylesheets and theme attributes into the popup. */
function adoptStyles(src: Document, dst: Document): void {
  dst.querySelectorAll(`[${ADOPTED}]`).forEach((node) => node.remove());
  src.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const copy = dst.importNode(node, true) as HTMLElement;
    copy.setAttribute(ADOPTED, "");
    dst.head.appendChild(copy);
  });
  // Theme lives on <html> as a class and/or data-theme; without these the
  // popup would render the light palette under a dark call backdrop.
  dst.documentElement.className = src.documentElement.className;
  const theme = src.documentElement.getAttribute("data-theme");
  if (theme) dst.documentElement.setAttribute("data-theme", theme);
  else dst.documentElement.removeAttribute("data-theme");
}

export type CallPopout = {
  /** Where to portal the call UI, or null when it belongs inline. */
  container: HTMLElement | null;
  /** True while a popup is open — the opener should show a placeholder. */
  popped: boolean;
  /** Must be called from a user gesture, or the browser blocks the window. */
  popOut: () => void;
  popIn: () => void;
};

export function useCallPopout(): CallPopout {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const winRef = useRef<Window | null>(null);

  const popIn = useCallback(() => {
    const w = winRef.current;
    winRef.current = null;
    setContainer(null);
    if (w && !w.closed) w.close();
  }, []);

  const popOut = useCallback(() => {
    if (winRef.current && !winRef.current.closed) {
      winRef.current.focus();
      return;
    }
    const w = window.open("", "nois-call", FEATURES);
    if (!w) return; // blocked — the caller keeps rendering inline
    winRef.current = w;
    const doc = w.document;
    doc.title = "Call";
    doc.body.style.margin = "0";
    // Paint the call backdrop immediately so there's no white flash before
    // React commits.
    doc.body.style.background = "#0b0f16";
    adoptStyles(document, doc);

    const root = doc.createElement("div");
    root.style.cssText = "position:fixed;inset:0;";
    doc.body.appendChild(root);
    setContainer(root);
  }, []);

  // Keep styles in sync, notice the user closing the popup, and never outlive
  // the opener. `closed` polling is the only reliable close signal across
  // browsers — `pagehide` fires on reloads too.
  useEffect(() => {
    const w = winRef.current;
    if (!container || !w) return;

    const observer = new MutationObserver(() => adoptStyles(document, w.document));
    observer.observe(document.head, { childList: true, subtree: true });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    const poll = setInterval(() => {
      if (w.closed) {
        winRef.current = null;
        setContainer(null);
      }
    }, 500);

    // A popup left behind after the opener goes away can't be controlled by
    // anything, so it must not survive us.
    const closeIt = () => w.close();
    window.addEventListener("pagehide", closeIt);

    return () => {
      observer.disconnect();
      clearInterval(poll);
      window.removeEventListener("pagehide", closeIt);
    };
  }, [container]);

  // The call ended (or this provider unmounted) — take the window with it.
  useEffect(() => {
    return () => {
      const w = winRef.current;
      winRef.current = null;
      if (w && !w.closed) w.close();
    };
  }, []);

  return { container, popped: container !== null, popOut, popIn };
}
