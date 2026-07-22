// Trust-on-first-use (TOFU) pinning of peer *device* identity keys — the app's
// analogue of Messenger's "your security code with X changed" warning.
//
// The server IS the key directory, so a malicious/compromised server could hand
// us a swapped identity key for a peer device and silently MITM. We can't stop
// the server lying, but we can NOTICE: the first time we see a given device's
// identity key we pin it; if that device's key later differs, we flag it and
// surface a warning for the human to resolve out-of-band (compare safety
// numbers) before trusting it.
//
// Keyed by deviceId (a random UUID, globally unique). A device's identity
// keypair is fixed for its lifetime, so a change means the key was swapped — or
// the peer re-provisioned that device (e.g. after clearing data), which is a
// legitimate "started using a new device"-style change the user should still be
// told about. Brand-new deviceIds are first-seen → trusted silently.

"use client";

import { deriveFingerprintFromSpki, pinGet, pinPut } from "./identity";

export type Pin = {
  deviceId: string;
  /** Best-known owner of the device (may be "" when only a device id is known). */
  peerUserId: string;
  /** The TRUSTED identity key (SPKI base64) — what we compare future keys to. */
  identityKey: string;
  fingerprint: string;
  firstSeen: number;
  status: "trusted" | "changed";
  /** When status==="changed": the new key seen that differs from `identityKey`. */
  pendingKey?: string;
  pendingFingerprint?: string;
};

export type PinResult = "first-seen" | "match" | "mismatch";

/** Observe a peer device's identity key; pin on first sight, flag on change. */
export async function checkAndPin(
  viewerUserId: string,
  peer: { deviceId: string; peerUserId: string; identityKey: string },
): Promise<PinResult> {
  const { deviceId, peerUserId, identityKey } = peer;
  if (!deviceId || !identityKey) return "match"; // nothing to key on
  const existing = await pinGet<Pin>(viewerUserId, deviceId);
  if (!existing) {
    await pinPut(viewerUserId, deviceId, {
      deviceId,
      peerUserId,
      identityKey,
      fingerprint: await deriveFingerprintFromSpki(identityKey),
      firstSeen: Date.now(),
      status: "trusted",
    });
    return "first-seen";
  }
  if (existing.identityKey === identityKey) {
    // Peer reverted to the trusted key after a flagged change → clear the flag.
    if (existing.status === "changed") {
      await pinPut(viewerUserId, deviceId, {
        ...existing,
        status: "trusted",
        pendingKey: undefined,
        pendingFingerprint: undefined,
      });
    }
    return "match";
  }
  // Mismatch: KEEP the trusted key pinned, record the new one as pending, flag.
  await pinPut(viewerUserId, deviceId, {
    ...existing,
    peerUserId: peerUserId || existing.peerUserId,
    status: "changed",
    pendingKey: identityKey,
    pendingFingerprint: await deriveFingerprintFromSpki(identityKey),
  });
  return "mismatch";
}

/** Accept a flagged key change — re-pin to the pending key as the new trusted one. */
export async function acknowledgePin(
  viewerUserId: string,
  deviceId: string,
): Promise<void> {
  const existing = await pinGet<Pin>(viewerUserId, deviceId);
  if (!existing || existing.status !== "changed" || !existing.pendingKey) return;
  await pinPut(viewerUserId, deviceId, {
    ...existing,
    identityKey: existing.pendingKey,
    fingerprint: existing.pendingFingerprint ?? existing.fingerprint,
    status: "trusted",
    pendingKey: undefined,
    pendingFingerprint: undefined,
  });
}
