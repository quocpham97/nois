"use client";

import { useEffect } from "react";
import { setupMobileBridge } from "@/lib/mobile/capacitor-bridge";

// Mobile counterpart of DesktopMode. Sets up the Capacitor bridge (which tags
// <html> with `mobile` and installs window.mobile) once on mount. Both the
// setup and the class-add are no-ops in a plain browser and inside the Electron
// shell, so the web and desktop builds are untouched; mobile-only styling keys
// off the `mobile` class via the `mobile:` Tailwind variant (see globals.css).
export function MobileMode() {
  useEffect(() => {
    void setupMobileBridge();
  }, []);
  return null;
}
