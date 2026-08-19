"use client";

/**
 * This device's E2EE identity: provisioning it, publishing its public bundle, and
 * topping the one-time-prekey pool back up.
 *
 * `keys:publish` seeds the server's one-time-prekey pool only on a device's FIRST
 * publish — it no longer replaces the pool on reconnect, which used to re-add
 * already-consumed prekeys and cause permanent "Unable to decrypt" (see
 * key-store.ts `publish`). So refills for a returning device are sent as an
 * APPEND via `keys:supplement`, the same path post-consume replenishment uses.
 */
import { useCallback, useMemo, useRef } from "react";
import {
  cryptoAvailable,
  ensureDeviceIdentity,
  replenishOneTimePreKeys,
} from "@/lib/crypto/identity";
import { session, type TypedSocket } from "@/stores/session-store";

export type DeviceIdentity = ReturnType<typeof useDeviceIdentity>;

export function useDeviceIdentity({
  userId,
  socketRef,
}: {
  userId: string;
  socketRef: React.RefObject<TypedSocket | null>;
}) {
  /** True once this device's identity has been provisioned this session, so a
   *  reconnect doesn't redo the bootstrap. */
  const provisionedRef = useRef(false);

  const provisionAndPublish = useCallback(
    async (s: TypedSocket) => {
      const fresh = await replenishOneTimePreKeys(userId);
      const identity = await ensureDeviceIdentity(userId);
      provisionedRef.current = true;
      session().setDevice(identity.deviceId, identity.fingerprint);
      s.emit("keys:publish", { bundle: identity.bundle });
      // Call signaling is addressed per device, so the server needs to know which
      // device this socket is (it joins a `device:<id>` room). Announced on every
      // connect, not just the first publish.
      s.emit("device:announce", { deviceId: identity.deviceId });
      // First publish carries the full pool in the bundle; on reconnect the
      // bundle's prekeys are ignored server-side, so append any refill here.
      if (fresh.length) {
        s.emit("keys:supplement", {
          deviceId: identity.deviceId,
          oneTimePreKeys: fresh,
        });
      }
    },
    [userId],
  );

  /** Mid-session top-up: when the pool has drained (prekeys consumed for forward
   *  secrecy), generate fresh ones and APPEND their publics to the server pool. */
  const replenishKeys = useCallback(async () => {
    const s = socketRef.current;
    const deviceId = session().deviceId;
    if (!s || !cryptoAvailable() || !deviceId) return;
    const fresh = await replenishOneTimePreKeys(userId);
    if (fresh.length) s.emit("keys:supplement", { deviceId, oneTimePreKeys: fresh });
  }, [userId, socketRef]);

  return useMemo(
    () => ({ provisionedRef, provisionAndPublish, replenishKeys }),
    [provisionAndPublish, replenishKeys],
  );
}
