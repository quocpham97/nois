"use client";

import { useEffect, useState } from "react";

/**
 * Returns true once the component has mounted on the client. Used to guard
 * theme-dependent rendering (next-themes) against hydration mismatches.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount flag is a one-time client signal
    setMounted(true);
  }, []);
  return mounted;
}
