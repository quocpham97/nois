"use client";

import { useEffect } from "react";

// Tags <html> with `desktop` when running inside the Electron shell
// (window.desktop is set by the preload bridge), mirroring how next-themes
// sets `.dark`. Desktop-only styling keys off it via the `desktop:` Tailwind
// variant and the .app-drag rules in globals.css; the web build never gets
// the class, so its UI is untouched.
export function DesktopMode() {
  useEffect(() => {
    if (window.desktop) document.documentElement.classList.add("desktop");
  }, []);
  return null;
}
