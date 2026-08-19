/**
 * MLS engine loading + the key-directory reducer that decides which published
 * KeyPackages can safely ride in ONE commit. Kept separate from the MLS hook so
 * the pure reduction is readable (and testable) on its own.
 */
import type { KeyPackage as MlsKeyPackage } from "ts-mls";
import type { MlsMemberPackage } from "@/lib/socket-events";

// MLS (RFC 9420) is the LIVE group-encryption scheme: group sends go through
// MLS whenever a group's whole membership is MLS-capable (every member has
// published a KeyPackage), with an automatic per-group sender-keys fallback
// until then — see buildGroupEnc/ensureMlsGroup. Ordering comes from the
// server-side delivery service (server/mls-ds.ts); membership drift is synced
// on send (mlsSyncMembership). Typed `boolean` (not a literal) so the
// sender-keys branch stays reachable to the compiler — it's still the decrypt
// path for pre-cutover history and the fallback for not-yet-covered groups.
export const MLS_ENABLED: boolean = true;
/** Lazy import so ts-mls is only fetched (as its own chunk) when MLS is used. */
export const loadMls = () => import("@/lib/crypto/mls");
export type MlsModule = Awaited<ReturnType<typeof loadMls>>;

/** One member device to add, resolved from the key directory. */
export type MlsAddCandidate = {
  userId: string;
  deviceId: string;
  identity: string;
  sigKey: string;
  kp: MlsKeyPackage;
};

/**
 * Reduce the key directory's published packages to a set that can safely go in
 * ONE commit: at most one package per client, none of them ours.
 *
 * MLS decides "same client" by the leaf SIGNATURE KEY, and a commit carrying
 * two Adds that share one is invalid (RFC 9420 §12.2) — ts-mls rejects the
 * whole commit, which took the group's MLS establishment down with it and
 * silently dropped every send back to sender-keys. The directory can hold such
 * rows: it is keyed by (user, device), so a device that changes its id — a PIN
 * restore adopts the backed-up one — leaves its old row behind holding a
 * package with the same signature key as its new one.
 *
 * So: drop a package whose credential identity disagrees with the row it was
 * filed under (that mismatch IS the stale copy), then keep the first package
 * per identity and per signature key. Rows arrive ordered by device id, so
 * every member reduces the same directory to the same set.
 */
export function mlsAddCandidates(
  mls: MlsModule,
  packages: MlsMemberPackage[],
  ownIdentity: string,
): MlsAddCandidate[] {
  const out: MlsAddCandidate[] = [];
  const seenIdentity = new Set<string>([ownIdentity]);
  const seenSigKey = new Set<string>();
  for (const p of packages) {
    const identity = mls.mlsIdentity(p.userId, p.deviceId);
    if (seenIdentity.has(identity)) continue;
    const kp = mls.mlsDecodeKeyPackage(p.keyPackage);
    if (!kp) continue;
    const claimed = mls.mlsKeyPackageIdentity(kp);
    if (claimed === null) continue;
    // The package must belong to the row it was filed under: same user, and
    // either this device or a legacy (pre-multi-device) package, which carries
    // the bare userId. Anything else is a leftover from a device whose id
    // changed, and its signature key collides with that device's current row.
    const claimedBy = mls.mlsParseIdentity(claimed);
    if (claimedBy.userId !== p.userId) continue;
    if (claimedBy.deviceId !== "" && claimedBy.deviceId !== p.deviceId) continue;
    const sigKey = mls.mlsKeyPackageSigKey(kp);
    if (seenSigKey.has(sigKey)) continue;
    seenIdentity.add(identity);
    seenSigKey.add(sigKey);
    out.push({ userId: p.userId, deviceId: p.deviceId, identity, sigKey, kp });
  }
  return out;
}

