// MLS Delivery Service (Phase 4) — the server-side ordering layer MLS needs
// before it's safe for real multi-user use.
//
// MLS epochs advance linearly: every membership change (Commit) is built against
// a specific epoch, and all members must apply commits in the SAME order or
// their ratchet trees diverge irrecoverably. A pure relay can't guarantee that.
// This service does:
//   1. GROUP CREATION GATING — the first commit for a group establishes the
//      one canonical group; later "create" attempts are rejected so those
//      members JOIN (via Welcome) instead of forking a second group.
//   2. TOTAL COMMIT ORDERING — a commit is accepted only when its `fromEpoch`
//      equals the group's current epoch (single-accept-per-epoch). Concurrent
//      commits: first wins, the rest get `conflict` + the current epoch and must
//      rebase. Accepted commits get a monotonic `seq` (the global order).
//   3. CATCH-UP — members fetch commits with seq > their last-applied seq and
//      apply them in order (covers offline gaps).
//   4. WELCOME QUEUEING — Welcomes are stored so a newly-added member can join
//      even if they were offline when added.
//
// The server only ever sees opaque wire-encoded MLSMessages; it orders them, it
// can't read them. Durable in Postgres; a small in-memory epoch cache + a
// per-group mutex serialize submissions within this process.

import { getPool } from "../lib/db";

type GroupHead = { epoch: number; lastSeq: number };

const heads = new Map<string, GroupHead>();
// Per-group promise chain so concurrent submitCommit calls for the same
// group are serialized (single-process single-accept-per-epoch guarantee).
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(groupId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    groupId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Hydrate group heads (epoch + last seq) from Postgres on boot. */
export async function init(): Promise<void> {
  try {
    const { rows } = await getPool().query(
      "SELECT group_id, epoch, last_seq FROM mls_group",
    );
    for (const r of rows) {
      heads.set(r.group_id, { epoch: Number(r.epoch), lastSeq: Number(r.last_seq) });
    }
  } catch (e) {
    console.error("[mls-ds] hydrate failed:", (e as Error).message);
  }
}

// --- KeyPackages (one long-lived package per user DEVICE) --------------------
// Multi-device MLS: every device is its own group leaf, so packages are
// per-device and a republish REPLACES that device's package (its private half
// persists client-side, so the same package stays addable indefinitely).
// Fetch is non-destructive — adding a device to several groups reuses it.

export function publishKeyPackage(
  userId: string,
  deviceId: string,
  keyPackage: string,
): void {
  void getPool()
    .query(
      `INSERT INTO mls_key_package (user_id, device_id, key_package)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET key_package = EXCLUDED.key_package, created_at = now()`,
      [userId, deviceId, keyPackage],
    )
    .catch((e) => console.error("[mls-ds] publishKeyPackage:", (e as Error).message));
}

/** All published packages for a user, one per device. */
export async function fetchKeyPackages(
  userId: string,
): Promise<{ deviceId: string; keyPackage: string }[]> {
  try {
    const { rows } = await getPool().query(
      "SELECT device_id, key_package FROM mls_key_package WHERE user_id=$1 ORDER BY device_id",
      [userId],
    );
    return rows.map((r) => ({
      deviceId: r.device_id as string,
      keyPackage: r.key_package as string,
    }));
  } catch (e) {
    console.error("[mls-ds] fetchKeyPackages:", (e as Error).message);
    return [];
  }
}

// --- commit ordering -------------------------------------------------------

export type SubmitResult =
  | { ok: true; seq: number; epoch: number }
  | { ok: false; reason: "conflict" | "no_group" | "error"; currentEpoch: number };

/**
 * Submit a commit. `fromEpoch` is the epoch it was built against. Establishes
 * the group when none exists (only from epoch 0); otherwise requires
 * fromEpoch === current epoch and rejects with `conflict` on a mismatch.
 */
export function submitCommit(args: {
  groupId: string;
  senderUser: string;
  fromEpoch: number;
  commit: string;
}): Promise<SubmitResult> {
  const { groupId, senderUser, fromEpoch, commit } = args;
  return withLock(groupId, async () => {
    const head = heads.get(groupId);
    try {
      if (!head) {
        // Establishment: the first commit for this group creates the group.
        if (fromEpoch !== 0) return { ok: false, reason: "no_group", currentEpoch: 0 };
        const seq = 1;
        const epoch = 1;
        await getPool().query(
          "INSERT INTO mls_commit (group_id, seq, from_epoch, sender_user, commit_msg) VALUES ($1,$2,$3,$4,$5)",
          [groupId, seq, fromEpoch, senderUser, commit],
        );
        await getPool().query(
          "INSERT INTO mls_group (group_id, epoch, last_seq) VALUES ($1,$2,$3) ON CONFLICT (group_id) DO NOTHING",
          [groupId, epoch, seq],
        );
        heads.set(groupId, { epoch, lastSeq: seq });
        return { ok: true, seq, epoch };
      }
      if (fromEpoch !== head.epoch) {
        return { ok: false, reason: "conflict", currentEpoch: head.epoch };
      }
      const seq = head.lastSeq + 1;
      const epoch = head.epoch + 1;
      await getPool().query(
        "INSERT INTO mls_commit (group_id, seq, from_epoch, sender_user, commit_msg) VALUES ($1,$2,$3,$4,$5)",
        [groupId, seq, fromEpoch, senderUser, commit],
      );
      await getPool().query(
        "UPDATE mls_group SET epoch=$2, last_seq=$3 WHERE group_id=$1",
        [groupId, epoch, seq],
      );
      heads.set(groupId, { epoch, lastSeq: seq });
      return { ok: true, seq, epoch };
    } catch (e) {
      console.error("[mls-ds] submitCommit:", (e as Error).message);
      return { ok: false, reason: "error", currentEpoch: head?.epoch ?? 0 };
    }
  });
}

/** Ordered commits with seq strictly greater than `sinceSeq` (for catch-up). */
export async function commitsSince(
  groupId: string,
  sinceSeq: number,
): Promise<{ seq: number; commit: string }[]> {
  try {
    const { rows } = await getPool().query(
      "SELECT seq, commit_msg FROM mls_commit WHERE group_id=$1 AND seq>$2 ORDER BY seq",
      [groupId, sinceSeq],
    );
    return rows.map((r) => ({ seq: Number(r.seq), commit: r.commit_msg as string }));
  } catch (e) {
    console.error("[mls-ds] commitsSince:", (e as Error).message);
    return [];
  }
}

/** Current epoch of a group (0 if it doesn't exist yet). */
export function groupEpoch(groupId: string): number {
  return heads.get(groupId)?.epoch ?? 0;
}

// --- welcomes --------------------------------------------------------------

export function queueWelcome(
  groupId: string,
  toUser: string,
  toDevice: string,
  welcome: string,
  seq: number,
): void {
  void getPool()
    .query(
      "INSERT INTO mls_welcome (group_id, to_user, to_device, welcome, seq) VALUES ($1,$2,$3,$4,$5)",
      [groupId, toUser, toDevice, welcome, seq],
    )
    .catch((e) => console.error("[mls-ds] queueWelcome:", (e as Error).message));
}

/** Fetch and remove all queued welcomes for one DEVICE (delivered on connect —
 *  device-granular so one device can't consume a sibling device's welcome).
 *  The `seq` is the commit that added it — where the joiner resumes catch-up. */
export async function drainWelcomes(
  toUser: string,
  toDevice: string,
): Promise<{ groupId: string; welcome: string; seq: number }[]> {
  try {
    const { rows } = await getPool().query(
      `DELETE FROM mls_welcome WHERE to_user=$1 AND to_device=$2
       RETURNING group_id, welcome, seq`,
      [toUser, toDevice],
    );
    return rows.map((r) => ({
      groupId: r.group_id as string,
      welcome: r.welcome as string,
      seq: Number(r.seq),
    }));
  } catch (e) {
    console.error("[mls-ds] drainWelcomes:", (e as Error).message);
    return [];
  }
}
