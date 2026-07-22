-- Postgres schema for the multi-node deployment (ported from the single-file
-- SQLite store in src/server/store.ts). The shape is intentionally identical:
-- channels/messages keep a JSONB blob alongside the columns we order/query by.
--
-- Migration note: the runtime store (better-sqlite3) is synchronous; a Postgres
-- backend uses the async `pg` driver, so adopting this requires converting the
-- store's functions to async and awaiting them in server.ts. The schema and
-- queries map 1:1 — only the driver and sync/async boundary change.

CREATE TABLE IF NOT EXISTS channels (
  id   TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  seq        BIGSERIAL PRIMARY KEY,
  id         TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  parent_id  TEXT,
  client_id  TEXT,
  data       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_top
  ON messages (channel_id, seq) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_parent
  ON messages (parent_id, seq);
-- Idempotency key for retried/duplicated sends (see store.addMessage).
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client
  ON messages (channel_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
