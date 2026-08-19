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
  await pruneExpired();
  // Also on a timer: filtering on read keeps behaviour correct, but only the
  // sweep reclaims bytes, and a process that runs for months would otherwise
  // never do it. Unref'd so it never holds the process open.
  setInterval(() => void pruneExpired(), PRUNE_INTERVAL_MS).unref();
}

/** How often to sweep expired packages and undeliverable welcomes. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Drop what expiry has made dead weight: KeyPackages nobody may be added with
 * any more, and Welcomes addressed to devices that can no longer join.
 *
 * Filtering on read is what keeps behaviour correct; this is what keeps the
 * tables from growing without bound. A Welcome for an expired device is the
 * expensive case — it holds a full ratchet tree and nothing will ever drain it,
 * which is how `mls_welcome` reached 446 MB in one deployment.
 *
 * Run at boot rather than on a timer: a long-lived process re-reads nothing, and
 * a deployment that never restarts has bigger problems. Grace on the Welcome
 * sweep is deliberately wider than the package TTL, so a device that returns
 * right at the edge still finds its mail.
 */
export async function pruneExpired(): Promise<void> {
  try {
    const kp = await getPool().query(
      `DELETE FROM mls_key_package WHERE created_at < now() - ($1::bigint * interval '1 millisecond')`,
      [PACKAGE_TTL_MS],
    );
    const w = await getPool().query(
      `DELETE FROM mls_welcome WHERE created_at < now() - ($1::bigint * interval '1 millisecond')`,
      [PACKAGE_TTL_MS * 2],
    );
    // Blobs outlive their pointers (a drain deletes only the pointer), so the
    // bytes are only actually reclaimed here.
    const b = await getPool().query(
      `DELETE FROM mls_welcome_blob b
        WHERE NOT EXISTS (
          SELECT 1 FROM mls_welcome w
           WHERE w.group_id = b.group_id AND w.seq = b.seq
        )`,
    );
    if (kp.rowCount || w.rowCount || b.rowCount) {
      console.log(
        `[mls-ds] pruned ${kp.rowCount ?? 0} expired key packages, ` +
          `${w.rowCount ?? 0} undeliverable welcomes, ${b.rowCount ?? 0} orphaned blobs`,
      );
    }
  } catch (e) {
    console.error("[mls-ds] prune failed:", (e as Error).message);
  }
}

// --- KeyPackages (one long-lived package per user DEVICE) --------------------
// Multi-device MLS: every device is its own group leaf, so packages are
// per-device and a republish REPLACES that device's package (its private half
// persists client-side, so the same package stays addable indefinitely).
// Fetch is non-destructive — adding a device to several groups reuses it.

/**
 * How long a device's published KeyPackage stays valid after its last publish.
 *
 * Every MLS-capable device republishes on connect (`mls:publishKeyPackage`
 * refreshes `created_at`), so this doubles as device liveness — and liveness is
 * load-bearing, because a device is an MLS LEAF. A dead device whose package
 * lingers gets added to every group its user belongs to and is never removed, so
 * the ratchet tree only grows; a Welcome embeds the whole tree
 * (`ratchetTreeExtension: true`), so every join blob grows with it. That
 * compounds: admitting N devices to a group of N leaves queues N Welcomes of
 * O(N) bytes, which is how one deployment reached 446 MB of undrained Welcomes.
 *
 * Generous by default, because expiry is not free. A device that returns after
 * the window republishes and is re-added, but at the CURRENT epoch — so it can't
 * derive keys for messages sent while it was away, and recovers those from the
 * user's own encrypted history store instead (crypto/backup + user_history),
 * which is device-independent.
 */
const PACKAGE_TTL_MS =
  (Number(process.env.MLS_DEVICE_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

/** SQL fragment: a package still inside its TTL. */
const FRESH = `created_at > now() - ($2::bigint * interval '1 millisecond')`;

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

/**
 * A user's published packages, one per device — LIVE devices only.
 *
 * Filtered rather than returning everything, because the caller uses this to
 * decide who becomes a group leaf: a package for a browser profile that no longer
 * exists would add a leaf nobody can ever occupy, and it would stay. See
 * PACKAGE_TTL_MS.
 */
export async function fetchKeyPackages(
  userId: string,
): Promise<{ deviceId: string; keyPackage: string }[]> {
  try {
    const { rows } = await getPool().query(
      `SELECT device_id, key_package FROM mls_key_package
       WHERE user_id=$1 AND ${FRESH} ORDER BY device_id`,
      [userId, PACKAGE_TTL_MS],
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

/**
 * Queue a Welcome for one recipient device.
 *
 * The blob is stored ONCE per commit and pointed at, because one commit yields
 * one Welcome however many devices it adds — so (groupId, seq) names it. Inlining
 * it per device meant N copies of a payload that carries the whole ratchet tree,
 * i.e. O(N²) bytes to admit N devices.
 *
 * `DO NOTHING` on the blob is safe because every caller for a given commit
 * passes the same bytes: the client sends one blob with its target list, and the
 * legacy per-device shape repeated an identical copy.
 *
 * AWAITABLE, and the caller must await it before relaying the Welcome live: an
 * online recipient can join and report the copy consumed faster than a
 * fire-and-forget insert completes, and a delete that arrives first matches
 * nothing — leaving a row that is then written behind it and never collected.
 */
export async function queueWelcome(
  groupId: string,
  toUser: string,
  toDevice: string,
  welcome: string,
  seq: number,
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO mls_welcome_blob (group_id, seq, welcome) VALUES ($1,$2,$3)
       ON CONFLICT (group_id, seq) DO NOTHING`,
      [groupId, seq, welcome],
    );
    await pool.query(
      "INSERT INTO mls_welcome (group_id, to_user, to_device, seq) VALUES ($1,$2,$3,$4)",
      [groupId, toUser, toDevice, seq],
    );
  } catch (e) {
    console.error("[mls-ds] queueWelcome:", (e as Error).message);
  }
}

/**
 * Drop a device's queued Welcome for one commit, because it already joined from
 * the live relay.
 *
 * Without this the row sits until that device's NEXT connect drains it — and if
 * it never reconnects, forever. Called on the client's ack after a successful
 * join, so it is only ever removed once it is provably not needed.
 */
export function dropWelcome(
  groupId: string,
  toUser: string,
  toDevice: string,
  seq: number,
): void {
  void getPool()
    .query(
      `DELETE FROM mls_welcome
        WHERE group_id=$1 AND to_user=$2 AND to_device=$3 AND seq=$4`,
      [groupId, toUser, toDevice, seq],
    )
    .catch((e) => console.error("[mls-ds] dropWelcome:", (e as Error).message));
}

/** Fetch and remove all queued welcomes for one DEVICE (delivered on connect —
 *  device-granular so one device can't consume a sibling device's welcome).
 *  The `seq` is the commit that added it — where the joiner resumes catch-up. */
export async function drainWelcomes(
  toUser: string,
  toDevice: string,
): Promise<{ groupId: string; welcome: string; seq: number }[]> {
  try {
    // Claim the pointers and read their blobs in ONE statement: a separate
    // read-then-delete could drop a row queued in between without ever
    // delivering it. The payload lives in the other table, so the delete's
    // RETURNING feeds a join rather than carrying the blob itself.
    const { rows } = await getPool().query(
      `WITH claimed AS (
         DELETE FROM mls_welcome
          WHERE to_user=$1 AND to_device=$2
          RETURNING group_id, seq, id
       )
       SELECT c.group_id, c.seq, b.welcome
         FROM claimed c
         JOIN mls_welcome_blob b
           ON b.group_id = c.group_id AND b.seq = c.seq
        ORDER BY c.id`,
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
