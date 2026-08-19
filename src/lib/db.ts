import { Pool } from "pg";

// Postgres (Neon) connection. Stores transcoded video HLS bytes (media_file)
// and the durable relay state (groups, membership, messages). Singleton
// across dev hot-reloads via globalThis so we don't leak pools.
// NOTE: intentionally NOT `import "server-only"` — the custom Node server
// (server.ts → store.ts) imports this transitively, and server-only throws
// outside the Next bundler. The pool is only ever used server-side regardless.
const g = globalThis as unknown as {
  _pgPool?: Pool;
  _schemaReady?: Promise<void>;
};

export function getPool(): Pool {
  if (!g._pgPool) {
    g._pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon serves a publicly-trusted cert; rejectUnauthorized:false keeps the
      // demo robust against local CA quirks (tighten for production).
      ssl: { rejectUnauthorized: false },
      max: 5,
      // Recycle idle connections before Neon's server-side idle timeout drops
      // them out from under us (a long-running server otherwise hands out dead
      // clients and every query fails until restart).
      idleTimeoutMillis: 30_000,
    });
    // An idle client erroring (e.g. Neon closed it) emits 'error' on the pool.
    // Without a listener Node treats it as an uncaught exception; pg already
    // evicts the bad client, so we just log and let the next query reconnect.
    g._pgPool.on("error", (err) => {
      console.error("[db] idle client error (will reconnect):", err.message);
    });
  }
  return g._pgPool;
}

/** Create all tables once per process. Idempotent. */
export function ensureSchema(): Promise<void> {
  if (!g._schemaReady) {
    const pool = getPool();
    g._schemaReady = (async () => {
      // Transcoded video bytes (HLS playlists/segments/poster).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS media_file (
           key        text PRIMARY KEY,
           mime       text NOT NULL,
           bytes      bytea NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Idempotent migration (2026-07): the DB's "channel" naming became
      // "group" — rename pre-rename tables/columns in place so existing data
      // carries over. No-ops on a fresh or already-migrated database. NB:
      // `group` is a reserved word in SQL, so the table is always quoted.
      await pool.query(
        `DO $$
         DECLARE t text;
         BEGIN
           IF to_regclass('channel') IS NOT NULL AND to_regclass('"group"') IS NULL THEN
             ALTER TABLE channel RENAME TO "group";
           END IF;
           IF to_regclass('channel_member') IS NOT NULL AND to_regclass('group_member') IS NULL THEN
             ALTER TABLE channel_member RENAME TO group_member;
           END IF;
           FOREACH t IN ARRAY ARRAY[
             'group_member','message','reaction','pin','read_cursor',
             'sender_key','message_receipt','mls_group','mls_commit','mls_welcome'
           ] LOOP
             IF EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = t AND column_name = 'channel_id'
             ) THEN
               EXECUTE format('ALTER TABLE %I RENAME COLUMN channel_id TO group_id', t);
             END IF;
           END LOOP;
         END $$`,
      );
      await pool.query(
        `ALTER INDEX IF EXISTS message_channel_seq RENAME TO message_group_seq`,
      );
      await pool.query(
        `ALTER INDEX IF EXISTS reaction_channel RENAME TO reaction_group`,
      );
      // Durable relay state. `message.data` holds the wire Message (ciphertext
      // `enc` for E2EE messages; `text`/`rich` empty there → no plaintext).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS "group" (
           id         text PRIMARY KEY,
           type       text NOT NULL,
           name       text NOT NULL,
           icon       text,
           topic      text,
           private    boolean NOT NULL DEFAULT false,
           dm_user    jsonb,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Existing deployments: add the conversation chat color.
      await pool.query(
        `ALTER TABLE "group" ADD COLUMN IF NOT EXISTS bubble_theme text`,
      );
      // Groups are member-only: visibility comes from group_member, and
      // store.canAccess no longer reads `private` at all. Backfill it anyway so
      // rows left over from the public-group era are fail-closed rather than
      // fail-open if a reader ever returns (or this ships alongside a rollback).
      await pool.query(
        `UPDATE "group" SET private = true WHERE type = 'group' AND private = false`,
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS group_member (
           group_id text NOT NULL,
           user_id  text NOT NULL,
           PRIMARY KEY (group_id, user_id)
         )`,
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS message (
           id         text PRIMARY KEY,
           group_id   text NOT NULL,
           seq        bigint,
           parent_id  text,
           ts         bigint,
           deleted    boolean NOT NULL DEFAULT false,
           data       jsonb NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS message_group_seq ON message (group_id, seq)`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS message_parent ON message (parent_id)`,
      );
      // Per-message reactions (emoji ↔ reactor ids, no content).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS reaction (
           group_id text NOT NULL,
           msg_id   text NOT NULL,
           emoji    text NOT NULL,
           user_id  text NOT NULL,
           PRIMARY KEY (msg_id, emoji, user_id)
         )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS reaction_group ON reaction (group_id)`,
      );
      // Pinned message ids per group (ordered by created_at).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS pin (
           group_id   text NOT NULL,
           msg_id     text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (group_id, msg_id)
         )`,
      );
      // Per-user read cursor (last-read top-level seq) per group.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS read_cursor (
           group_id text NOT NULL,
           user_id  text NOT NULL,
           seq      bigint NOT NULL,
           PRIMARY KEY (group_id, user_id)
         )`,
      );
      // Per-user profile + preferences (display name, avatar, status, chat
      // color, quick emoji, archived chat ids) as one jsonb document.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS user_profile (
           user_id    text PRIMARY KEY,
           data       jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Passphrase-encrypted key backup (opaque to the server; see crypto/backup).
      // kcv/attempts/locked_until implement the rate-limited unlock vault:
      // the blob is released only after a PIN-derived proof matches `kcv`,
      // with a guess counter + lockout (backup:unlock in server.ts). Legacy
      // rows (kcv NULL) predate the vault and are returned directly.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS key_backup (
           user_id      text PRIMARY KEY,
           blob         jsonb NOT NULL,
           kcv          text,
           attempts     int NOT NULL DEFAULT 0,
           locked_until timestamptz,
           updated_at   timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Existing deployments: CREATE TABLE IF NOT EXISTS won't add columns.
      await pool.query(
        `ALTER TABLE key_backup
           ADD COLUMN IF NOT EXISTS kcv text,
           ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS locked_until timestamptz`,
      );
      // Continuous encrypted history store (crypto/backup.ts): every decrypted
      // message row, re-encrypted client-side under the user's storage key and
      // appended as it flows. Opaque to the server — even channel/thread
      // membership of a row rides inside the ciphertext. Restoring device:
      // unlock backup → storage key → page through rows by msg_id.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS user_history (
           user_id    text NOT NULL,
           msg_id     text NOT NULL,
           iv         text NOT NULL,
           ct         text NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, msg_id)
         )`,
      );
      // One-time codes for the desktop (Electron) login handoff: a signed-in
      // browser mints a code bound to the app's PKCE challenge; the app
      // exchanges it (single-use, 60s TTL enforced at exchange) for a fresh
      // session cookie. Only the code's hash is stored. `token` holds the
      // captured session-JWT claims to re-encode for the app.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS desktop_auth_code (
           code_hash  text PRIMARY KEY,
           token      jsonb NOT NULL,
           challenge  text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Latest group sender-key distribution envelope per (group, sender
      // device). `env` is the opaque pairwise-encrypted envelope (server can't
      // read it). Persisted so a member who was offline when the key was
      // distributed can still fetch it on reconnect — without the sender being
      // online to answer a live pull. One row per sender device (stable seed,
      // so re-distribution just overwrites).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS sender_key (
           group_id      text NOT NULL,
           sender_device text NOT NULL,
           sender_user   text NOT NULL,
           env           text NOT NULL,
           updated_at    timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (group_id, sender_device)
         )`,
      );
      // E2EE read receipts (Phase 2): the latest opaque sealed read-cursor per
      // (group, user, device). Latest wins — no ordering — so a plain upsert.
      // The server can't read `env`; it only relays + replays it.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS message_receipt (
           group_id   text NOT NULL,
           user_id    text NOT NULL,
           device_id  text NOT NULL,
           env        text NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (group_id, user_id, device_id)
         )`,
      );
      // Web Push subscriptions (Phase 6): one row per browser push endpoint,
      // keyed by the endpoint URL. `keys` holds the p256dh/auth pair web-push
      // needs to encrypt the push. Multiple devices per user → index on user_id.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS push_subscription (
           endpoint   text PRIMARY KEY,
           user_id    text NOT NULL,
           keys       jsonb NOT NULL,
           ua         text,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscription(user_id)`,
      );
      // Public device key directory (see server/key-store.ts). Only PUBLIC key
      // material — the server can't decrypt anything. Persisted so a server
      // restart doesn't blank the directory until every client reconnects.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS device_key (
           user_id           text NOT NULL,
           device_id         text NOT NULL,
           identity_key      text NOT NULL,
           signed_prekey     jsonb NOT NULL,
           one_time_prekeys  jsonb NOT NULL,
           updated_at        timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, device_id)
         )`,
      );
      // --- MLS delivery service (Phase 4) --------------------------------
      // Published MLS KeyPackages (opaque wire strings): ONE current package
      // per (user, device), replaced on republish. Devices are separate MLS
      // leaves, so packages are device-granular; fetch is non-destructive (the
      // package is long-lived — its private half persists client-side).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_key_package (
           id          bigserial PRIMARY KEY,
           user_id     text NOT NULL,
           key_package text NOT NULL,
           created_at  timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_mls_kp_user ON mls_key_package(user_id, id)`,
      );
      // Idempotent migration (2026-07, multi-device MLS): packages became
      // per-device. Legacy rows (no device_id) belonged to in-memory-only
      // keypairs from before keypair persistence — unusable by definition
      // (their private halves died with the session) — so they're purged.
      await pool.query(
        `ALTER TABLE mls_key_package ADD COLUMN IF NOT EXISTS device_id text`,
      );
      await pool.query(`DELETE FROM mls_key_package WHERE device_id IS NULL`);
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_kp_user_device
           ON mls_key_package(user_id, device_id)`,
      );
      // Per-group MLS state: current epoch + highest commit seq. One row =
      // one established MLS group; its existence gates re-creation (join instead).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_group (
           group_id text PRIMARY KEY,
           epoch    bigint NOT NULL,
           last_seq bigint NOT NULL
         )`,
      );
      // Totally-ordered commit log per group. `seq` is the global order; a commit
      // is only accepted when its `from_epoch` equals the group's current epoch
      // (single-accept-per-epoch), which is what serializes concurrent commits.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_commit (
           group_id    text NOT NULL,
           seq         bigint NOT NULL,
           from_epoch  bigint NOT NULL,
           sender_user text NOT NULL,
           commit_msg  text NOT NULL,
           created_at  timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (group_id, seq)
         )`,
      );
      // Welcomes queued for members to join on (re)connect (opaque wire strings).
      await pool.query(
        `CREATE TABLE IF NOT EXISTS mls_welcome (
           id         bigserial PRIMARY KEY,
           group_id   text NOT NULL,
           to_user    text NOT NULL,
           welcome    text NOT NULL,
           seq        bigint NOT NULL DEFAULT 0,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      // Idempotent migration: add `seq` to an mls_welcome that predates it.
      await pool.query(
        `ALTER TABLE mls_welcome ADD COLUMN IF NOT EXISTS seq bigint NOT NULL DEFAULT 0`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_mls_welcome_user ON mls_welcome(to_user, id)`,
      );
      // Idempotent migration (2026-07, multi-device MLS): welcomes are sealed
      // to ONE device's KeyPackage, so queue + drain are device-granular now
      // (a user-level drain let one device consume a sibling device's welcome).
      // Legacy device-less rows targeted dead in-memory keypairs — purged.
      await pool.query(
        `ALTER TABLE mls_welcome ADD COLUMN IF NOT EXISTS to_device text`,
      );
      await pool.query(`DELETE FROM mls_welcome WHERE to_device IS NULL`);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_mls_welcome_device ON mls_welcome(to_user, to_device, id)`,
      );
      // Idempotent migration (2026-07): DMs used a "dm-<key>" channel id; they
      // now share the flat "<key>" id space with groups (a channel's `type` —
      // 'group'|'dm' — is the sole discriminator, and 'channel' was renamed to
      // 'group'). Strip the legacy prefix across every channel-keyed table and
      // rename the type value. Re-running is a no-op: the WHERE clauses stop
      // matching once the data is migrated.
      await pool.query(
        `UPDATE "group"         SET id       = substring(id       from 4) WHERE id       LIKE 'dm-%';
         UPDATE group_member    SET group_id = substring(group_id from 4) WHERE group_id LIKE 'dm-%';
         UPDATE message         SET group_id = substring(group_id from 4) WHERE group_id LIKE 'dm-%';
         UPDATE reaction        SET group_id = substring(group_id from 4) WHERE group_id LIKE 'dm-%';
         UPDATE pin             SET group_id = substring(group_id from 4) WHERE group_id LIKE 'dm-%';
         UPDATE read_cursor     SET group_id = substring(group_id from 4) WHERE group_id LIKE 'dm-%';
         UPDATE message_receipt SET group_id = substring(group_id from 4) WHERE group_id LIKE 'dm-%';
         UPDATE "group"         SET type = 'group' WHERE type = 'channel';`,
      );
    })().catch((e) => {
      // Reset so a transient failure can be retried on the next call.
      g._schemaReady = undefined;
      throw e;
    });
  }
  return g._schemaReady;
}

// --- Web Push subscriptions (Phase 6) --------------------------------------

export type PushKeys = { p256dh: string; auth: string };
export type PushSub = { endpoint: string; keys: PushKeys };

/** Upsert a browser push subscription for a user (idempotent by endpoint). */
export async function savePushSubscription(
  userId: string,
  endpoint: string,
  keys: PushKeys,
  ua?: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO push_subscription (endpoint, user_id, keys, ua)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, keys=EXCLUDED.keys, ua=EXCLUDED.ua`,
    [endpoint, userId, JSON.stringify(keys), ua ?? null],
  );
}

/** Remove a subscription (on unsubscribe, or when a push returns 404/410). */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await getPool().query("DELETE FROM push_subscription WHERE endpoint=$1", [endpoint]);
}

/** All push endpoints for a user (a user may have several devices/browsers). */
export async function listPushSubscriptions(userId: string): Promise<PushSub[]> {
  const { rows } = await getPool().query(
    "SELECT endpoint, keys FROM push_subscription WHERE user_id=$1",
    [userId],
  );
  return rows.map((r) => ({ endpoint: r.endpoint, keys: r.keys as PushKeys }));
}
