// Server-side public-key registry for the E2EE key-distribution layer.
//
// The server is a DIRECTORY, not a trust anchor: it stores and hands out only
// PUBLIC key material so devices can start sessions asynchronously. It cannot
// decrypt anything. Clients defend against a malicious directory by (a)
// verifying the signed-prekey signature against the identity key and (b)
// comparing identity-key fingerprints (safety numbers) out of band.
//
// In-memory Map as a read cache, write-through to the Postgres `device_key`
// table so the directory survives a server restart (otherwise every fetch
// misses until each client reconnects and republishes). DB writes are
// best-effort/background — the in-memory map is the runtime authority, exactly
// like src/server/store.ts.

import type {
  DeviceKeyBundle,
  PreKeyBundle,
  PublicPreKey,
} from "../lib/crypto/types";
import { getPool } from "../lib/db";

// Fire-and-forget a background DB write; a directory that lags the cache by one
// write is fine (clients republish on connect), so never block on persistence.
function bg(p: Promise<unknown>): void {
  void p.catch((e) => console.error("[key-store] persist failed:", (e as Error).message));
}

type StoredDevice = {
  userId: string;
  deviceId: string;
  identityKey: string;
  signedPreKey: DeviceKeyBundle["signedPreKey"];
  // FIFO pool; each fetch consumes one. When empty, sessions fall back to the
  // (reusable) signed prekey — weaker, so clients should replenish the pool.
  oneTimePreKeys: PublicPreKey[];
};

// userId -> deviceId -> device record.
const devices = new Map<string, Map<string, StoredDevice>>();

function put(d: StoredDevice): void {
  let byDevice = devices.get(d.userId);
  if (!byDevice) {
    byDevice = new Map();
    devices.set(d.userId, byDevice);
  }
  byDevice.set(d.deviceId, d);
}

/** Persist a device's current pool (identity/signed prekey + remaining OTKs). */
function persist(d: StoredDevice): void {
  bg(
    getPool().query(
      `INSERT INTO device_key (user_id, device_id, identity_key, signed_prekey, one_time_prekeys, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         identity_key=EXCLUDED.identity_key,
         signed_prekey=EXCLUDED.signed_prekey,
         one_time_prekeys=EXCLUDED.one_time_prekeys,
         updated_at=now()`,
      [
        d.userId,
        d.deviceId,
        d.identityKey,
        JSON.stringify(d.signedPreKey),
        JSON.stringify(d.oneTimePreKeys),
      ],
    ),
  );
}

/** Hydrate the in-memory directory from Postgres on boot. */
export async function init(): Promise<void> {
  try {
    const { rows } = await getPool().query(
      "SELECT user_id, device_id, identity_key, signed_prekey, one_time_prekeys FROM device_key",
    );
    for (const r of rows) {
      put({
        userId: r.user_id,
        deviceId: r.device_id,
        identityKey: r.identity_key,
        signedPreKey: r.signed_prekey,
        oneTimePreKeys: r.one_time_prekeys ?? [],
      });
    }
  } catch (e) {
    console.error("[key-store] hydrate failed:", (e as Error).message);
  }
}

/**
 * Register or refresh a device's published public key bundle.
 *
 * One-time prekeys are SERVER-AUTHORITATIVE once a device exists. A client
 * republishes its FULL local pool on every (re)connect; if that were allowed to
 * REPLACE our pool it would re-add one-time prekeys we already handed out
 * (`fetchBundles` pops them). A later fetch would then hand the same prekey to a
 * second sender — but the recipient consumed that prekey's private half on first
 * use, so its copy of the second message can't be decrypted (a permanent
 * "Unable to decrypt", with no DM retry path). This hit reconnecting secondary
 * devices hard while an always-on device stayed fine.
 *
 * So we seed the pool ONLY on a device's first publish. Afterwards it grows
 * solely via `keys:supplement` (append fresh keys) and shrinks solely via
 * `fetchBundles` (pop) — a consumed prekey can never be resurrected. The
 * identity key + signed prekey still refresh on every publish (idempotent).
 */
export function publish(bundle: DeviceKeyBundle): void {
  const existing = devices.get(bundle.userId)?.get(bundle.deviceId);
  // A device's bundle lists exactly the one-time prekeys whose private half it
  // still holds. For an existing device we RECONCILE (never replace): keep our
  // pool entries the client still holds, drop ones it has since consumed, and
  // never re-add a prekey we already handed out. This both prevents reuse and
  // self-heals a pool that a pre-fix republish had polluted with consumed ids —
  // dropping a key the client no longer holds can only avert a future failure
  // (a message sealed to a key it lacks would fail anyway). A brand-new device
  // seeds its pool from the bundle; refills thereafter arrive via keys:supplement.
  let oneTimePreKeys: PublicPreKey[];
  if (existing) {
    const held = new Set(bundle.oneTimePreKeys.map((b) => b.id));
    oneTimePreKeys = existing.oneTimePreKeys.filter((k) => held.has(k.id));
  } else {
    oneTimePreKeys = [...bundle.oneTimePreKeys];
  }
  const d: StoredDevice = {
    userId: bundle.userId,
    deviceId: bundle.deviceId,
    identityKey: bundle.identityKey,
    signedPreKey: bundle.signedPreKey,
    oneTimePreKeys,
  };
  put(d);
  persist(d);
}

/**
 * Fetch a per-device prekey bundle for every device a user has registered,
 * popping (consuming) one one-time prekey per device. Returns [] for unknown
 * users. The popped prekey is removed so it is never reused across sessions.
 */
export function fetchBundles(userId: string): PreKeyBundle[] {
  const byDevice = devices.get(userId);
  if (!byDevice) return [];
  return [...byDevice.values()].map((d) => {
    const oneTimePreKey = d.oneTimePreKeys.shift() ?? null;
    if (oneTimePreKey) persist(d); // consumed one → persist so it isn't reused after restart
    return {
      userId: d.userId,
      deviceId: d.deviceId,
      identityKey: d.identityKey,
      signedPreKey: d.signedPreKey,
      oneTimePreKey,
    };
  });
}

/**
 * Append freshly-generated one-time prekeys to a device's pool (replenishment).
 * Unlike `publish`, this keeps the existing (unconsumed) prekeys rather than
 * replacing them. No-op for an unknown device.
 */
export function addOneTimePreKeys(
  userId: string,
  deviceId: string,
  keys: PublicPreKey[],
): void {
  const d = devices.get(userId)?.get(deviceId);
  if (!d) return;
  // Dedup by id: a prekey already in the pool must not be added twice (a
  // duplicate id would let the same one-time prekey be handed out to two
  // senders — the reuse this module exists to prevent).
  const have = new Set(d.oneTimePreKeys.map((k) => k.id));
  const add = keys.filter((k) => k && !have.has(k.id));
  if (!add.length) return;
  d.oneTimePreKeys.push(...add);
  persist(d);
}

/** Device ids a user has registered (for multi-device UIs / debugging). */
export function listDevices(userId: string): string[] {
  return [...(devices.get(userId)?.keys() ?? [])];
}

/** How many one-time prekeys remain for a device (so clients know to top up). */
export function preKeyCount(userId: string, deviceId: string): number {
  return devices.get(userId)?.get(deviceId)?.oneTimePreKeys.length ?? 0;
}

// NOTE: MLS KeyPackages moved to the durable delivery service (server/mls-ds.ts,
// Postgres-backed, single-use pop) so they survive restarts and integrate with
// commit ordering. The old in-memory pool here was removed.
