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
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        conv_id    TEXT,
        parent_id  TEXT,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv    ON messages(conv_id, id);
      CREATE INDEX IF NOT EXISTS idx_parent  ON messages(parent_id, id);
      CREATE INDEX IF NOT EXISTS idx_channel ON messages(channel_id);
    `);
    setupFts(db);
    return db;
  })();
  return dbPromise;
}

// Full-text search over decrypted message bodies (on-device only — the server
// never has plaintext). A standalone FTS5 table kept in sync by triggers: the
// indexed text is extracted from the JSON `data` column with json_extract, so
// EVERY write path (putMessage/patchMessage/importMessages/removeChannel/…)
// stays indexed automatically without touching the RPC layer. `text` is the
// message plaintext (present even for rich messages) plus any attachment name.
// msg_id/channel_id/parent_id ride along UNINDEXED so a hit maps back to a row.
function setupFts(db) {
  const insText = "coalesce(json_extract(new.data,'$.text'),'') || ' ' || coalesce(json_extract(new.data,'$.attachment.name'),'')";
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      msg_id UNINDEXED,
      channel_id UNINDEXED,
      parent_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, msg_id, channel_id, parent_id)
      VALUES (new.rowid, ${insText}, new.id, new.channel_id, new.parent_id);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
      INSERT INTO messages_fts(rowid, text, msg_id, channel_id, parent_id)
      VALUES (new.rowid, ${insText}, new.id, new.channel_id, new.parent_id);
    END;
  `);
  // One-time backfill for rows written before the index existed. Guarded by
  // user_version so it runs once; wrapped in a transaction so a big local store
  // rebuilds in a single commit rather than per-row.
  const version = Number(db.selectValue("PRAGMA user_version") ?? 0);
  if (version < 1) {
    db.transaction(() => {
      db.exec(`DELETE FROM messages_fts`);
      db.exec(
        `INSERT INTO messages_fts(rowid, text, msg_id, channel_id, parent_id)
         SELECT rowid,
           coalesce(json_extract(data,'$.text'),'') || ' ' || coalesce(json_extract(data,'$.attachment.name'),''),
           id, channel_id, parent_id
         FROM messages`,
      );
      db.exec(`PRAGMA user_version = 1`);
    });
  }
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
