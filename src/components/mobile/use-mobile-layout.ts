"use client";

import { useEffect, useState } from "react";

// Decides whether to render the phone-optimized mobile screen set (Messenger
// Mobile design) instead of the desktop Shell. True when EITHER the Capacitor
// shell is present (<html class="mobile">, set by MobileMode) OR the viewport is
// phone-width — so the same screens serve the native app and a narrow browser.
//
// SSR-safe by construction: returns false on the server AND on the first client
// render (matching the server HTML → no hydration mismatch), then flips in an
// effect after mount. A one-frame desktop→mobile swap is acceptable and avoids
// the mismatch a matchMedia-during-render read would cause.
const MOBILE_QUERY = "(max-width: 768px)";

export function useMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const compute = () =>
      setIsMobile(
        mql.matches ||
          document.documentElement.classList.contains("mobile"),
      );
    compute();
    mql.addEventListener("change", compute);
    return () => mql.removeEventListener("change", compute);
  }, []);

  return isMobile;
}
