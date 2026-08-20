"use client";

/**
 * Push plumbing, checked once per load.
 *
 * Everything about a push subscription can rot while the app isn't running: the
 * browser retires the endpoint, the server row is lost or still bound to the
 * account that used this browser last, or the service worker was never
 * registered because this user never opened the settings panel. None of it is
 * visible — the symptom is silence — so the repair runs unprompted at startup.
 *
 * syncPush() never asks for permission (that stays behind the settings toggle,
 * which needs a gesture); it only acts on what has already been granted.
 */
import { useEffect } from "react";
import { syncPush } from "@/lib/push";

export function usePushSync(): void {
  useEffect(() => {
    void syncPush().catch(() => {
      // Best-effort: a device that can't register is one that gets no push,
      // which is exactly where it already was.
    });
  }, []);
}
