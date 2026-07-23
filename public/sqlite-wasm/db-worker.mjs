// Web Worker that owns the OPFS SQLite database. OPFS `createSyncAccessHandle`
// (which the SAHPool VFS needs) is only available in a Worker, not the main
// thread — so all SQLite lives here and the page talks to it over postMessage.
// Served from /public and co-located with index.mjs + sqlite3.wasm so the ESM
// resolves its own wasm relative to this directory.

import sqlite3InitModule from "./index.mjs";

const DB_FILE = "/chat-messages.sqlite3";
let dbPromise = null;
let poolUtil = null; // kept so we can exportFile() a real .sqlite3 for inspection

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const sqlite3 = await sqlite3InitModule();
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "opfs-chat" });
    poolUtil = pool;
    const db = new pool.OpfsSAHPoolDb(DB_FILE);
    // Fresh installs get the current schema (group_id) directly; on an existing
    // install this is a no-op (the table already exists, possibly with the old
    // channel_id column) and migrate() brings it up to date.
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        group_id   TEXT NOT NULL,
        conv_id    TEXT,
        parent_id  TEXT,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv    ON messages(conv_id, id);
      CREATE INDEX IF NOT EXISTS idx_parent  ON messages(parent_id, id);
    `);
    migrate(db);
    return db;
  })();
  return dbPromise;
}

// (Re)create the FTS5 index and its sync triggers. Idempotent (IF NOT EXISTS),
// so it's safe to call on every open once the schema is current.
//
// Full-text search over decrypted message bodies (on-device only — the server
// never has plaintext). A standalone FTS5 table kept in sync by triggers: the
// indexed text is extracted from the JSON `data` column with json_extract, so
// EVERY write path (putMessage/patchMessage/importMessages/removeGroup/…)
// stays indexed automatically without touching the RPC layer. `text` is the
// message plaintext (present even for rich messages) plus any attachment name.
// msg_id/group_id/parent_id ride along UNINDEXED so a hit maps back to a row.
function ensureFts(db) {
  const insText =
    "coalesce(json_extract(new.data,'$.text'),'') || ' ' || coalesce(json_extract(new.data,'$.attachment.name'),'')";
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      msg_id UNINDEXED,
      group_id UNINDEXED,
      parent_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, msg_id, group_id, parent_id)
      VALUES (new.rowid, ${insText}, new.id, new.group_id, new.parent_id);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
      INSERT INTO messages_fts(rowid, text, msg_id, group_id, parent_id)
      VALUES (new.rowid, ${insText}, new.id, new.group_id, new.parent_id);
    END;
  `);
}

// Schema migrations, gated by PRAGMA user_version so each runs once.
//   v1: initial FTS5 index (backfilled the pre-index rows).
//   v2: rename the on-device column channel_id -> group_id, to match the
//       app-layer + Postgres rename (2026-07). Forward-only: once a device is
//       at v2, an OLDER bundle that queries channel_id will not work against it.
function migrate(db) {
  const version = Number(db.selectValue("PRAGMA user_version") ?? 0);
  if (version >= 2) {
    // Up to date — just make sure the FTS objects exist (they persist in the
    // file, so this is a no-op in the common case).
    ensureFts(db);
    return;
  }
  // One transaction so the whole upgrade either fully applies or rolls back,
  // leaving the DB readable by the current bundle either way.
  db.transaction(() => {
    // Triggers reference the column being renamed; drop them (and the FTS
    // table) first so SQLite doesn't auto-rewrite them mid-migration.
    // ensureFts() recreates both against the new column name below.
    db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TABLE IF EXISTS messages_fts;
    `);
    const cols = db
      .selectObjects("PRAGMA table_info(messages)")
      .map((c) => c.name);
    if (cols.includes("channel_id") && !cols.includes("group_id")) {
      db.exec(`ALTER TABLE messages RENAME COLUMN channel_id TO group_id`);
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_channel;
      CREATE INDEX IF NOT EXISTS idx_group ON messages(group_id);
    `);
    ensureFts(db);
    // FTS table was just dropped, so rebuild its content from every row.
    db.exec(
      `INSERT INTO messages_fts(rowid, text, msg_id, group_id, parent_id)
       SELECT rowid,
         coalesce(json_extract(data,'$.text'),'') || ' ' || coalesce(json_extract(data,'$.attachment.name'),''),
         id, group_id, parent_id
       FROM messages`,
    );
    db.exec(`PRAGMA user_version = 2`);
  });
}

self.onmessage = async (e) => {
  const { id, op, sql, bind, items } = e.data;
  try {
    const db = await openDb();
    let result = null;
    if (op === "all") result = db.selectObjects(sql, bind);
    else if (op === "one") result = db.selectObject(sql, bind) ?? null;
    else if (op === "run") db.exec({ sql, bind });
    else if (op === "runBatch")
      db.transaction(() => {
        for (const it of items) db.exec({ sql: it.sql, bind: it.bind });
      });
    else if (op === "export") result = await poolUtil.exportFile(DB_FILE); // real .sqlite3 bytes
    else throw new Error("unknown op: " + op);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
