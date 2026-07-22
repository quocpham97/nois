// Client-side message store — SQLite (WASM) persisted in the Origin Private
// File System (OPFS), NOT IndexedDB. The server is a pure relay and never
// persists message bodies; this is the only durable home for a conversation's
// content on a given device.
//
// SQLite runs in a dedicated Web Worker (public/sqlite-wasm/db-worker.mjs) using
// the OPFS SAHPool VFS — a real SQLite file in OPFS. It MUST be a worker because
// OPFS `createSyncAccessHandle` is worker-only (main thread and Safari don't
// expose it). This module is the main-thread client: it posts SQL over an RPC
// channel. No COOP/COEP headers or SharedArrayBuffer needed (SAHPool avoids the
// async-proxy OPFS VFS that requires them).
//
// The public API is byte-for-byte the same as the previous IndexedDB version so
// callers (chat-context, key-backup) need no changes. Every export is async and
// degrades to a no-op / empty result when Workers/OPFS are unavailable (SSR, or
// an old browser). One record per message: top-level messages carry
// conv_id = channelId (parent_id NULL); thread replies carry parent_id
// (conv_id NULL) so they never leak into channel history. Ordering is by the
// time-sortable message `id` (see store.newId).
//
// KNOWN LIMIT: the SAHPool VFS takes exclusive OPFS access handles, so the DB is
// effectively single-tab. A second tab won't be able to open it (its worker
// init rejects and this module degrades to empty results in that tab).

"use client";

import type { Attachment, Message } from "./chat-data";

type Row = { data: string };

let worker: Worker | null = null;
let workerFailed = false;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

/** Lazily spawn the DB worker. Null under SSR or when Workers are unavailable. */
function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker("/sqlite-wasm/db-worker.mjs", { type: "module" });
      worker.onmessage = (e: MessageEvent) => {
        const { id, ok, result, error } = e.data as {
          id: number;
          ok: boolean;
          result: unknown;
          error?: string;
        };
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (ok) p.resolve(result);
        else p.reject(new Error(error || "db error"));
      };
      worker.onerror = () => {
        // Worker failed to load/run (e.g. OPFS unavailable) — fail every pending
        // call and stop using the worker so callers degrade gracefully.
        workerFailed = true;
        for (const p of pending.values()) p.reject(new Error("db worker error"));
        pending.clear();
      };
    } catch {
      workerFailed = true;
      return null;
    }
  }
  return worker;
}

/** Post one op to the worker; resolves with its result, or `fallback` on failure. */
function rpc<T>(msg: Record<string, unknown>, fallback: T): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.resolve(fallback);
  const id = ++seq;
  return new Promise<T>((resolve) => {
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject: () => resolve(fallback), // degrade, never throw to callers
    });
    w.postMessage({ id, ...msg });
  });
}

/** Strip client-only/render-only fields before persisting. */
function clean(msg: Message): Message {
  const {
    pending: _p,
    failed: _f,
    sameAuthor: _s,
    self: _self,
    threadReplies: _tr,
    ...rest
  } = msg;
  void _p;
  void _f;
  void _s;
  void _self;
  void _tr;
  return rest;
}

const UPSERT = `INSERT INTO messages (id, channel_id, conv_id, parent_id, data)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     channel_id=excluded.channel_id,
     conv_id=excluded.conv_id,
     parent_id=excluded.parent_id,
     data=excluded.data`;

// --- continuous history sink -------------------------------------------------
// Every row persisted here also flows to a registered sink (socket-context),
// which re-encrypts it under the user's storage key and appends it to the
// server-side history store — the recovery copy for new devices. Fire-and-
// forget: local persistence never waits on (or fails with) the mirror.
// Restore-imported rows (importMessages) do NOT sink — they just came from it.

export type HistorySink = (rows: BackupMessageRow[]) => void;
let historySink: HistorySink | null = null;

/** Register (or clear, with null) the continuous-history mirror. */
export function setHistorySink(fn: HistorySink | null): void {
  historySink = fn;
}

const sinkRows = (rows: BackupMessageRow[]) => {
  if (historySink && rows.length) {
    try {
      historySink(rows);
    } catch {
      /* mirror must never break local persistence */
    }
  }
};

const toRow = (
  id: string,
  channelId: string,
  convId: string | null,
  parentId: string | null,
  msg: Message,
): BackupMessageRow => ({
  id,
  channel_id: channelId,
  conv_id: convId,
  parent_id: parentId,
  data: JSON.stringify(clean(msg)),
});

const upsertBind = (row: BackupMessageRow) => [
  row.id,
  row.channel_id,
  row.conv_id,
  row.parent_id,
  row.data,
];

const dec = (rows: Row[]) => rows.map((r) => JSON.parse(r.data) as Message);

/**
 * Persist (or replace) a top-level message. Only acked messages (those carrying
 * a server `seq`) are stored — optimistic temps are skipped until reconciled.
 */
export async function putMessage(channelId: string, msg: Message): Promise<void> {
  if (msg.seq == null) return;
  const row = toRow(msg.id, channelId, channelId, null, msg);
  await rpc({ op: "run", sql: UPSERT, bind: upsertBind(row) }, null);
  sinkRows([row]);
}

/** Persist (or replace) a thread reply under its parent. */
export async function putReply(
  channelId: string,
  parentId: string,
  reply: Message,
): Promise<void> {
  const row = toRow(reply.id, channelId, null, parentId, reply);
  await rpc({ op: "run", sql: UPSERT, bind: upsertBind(row) }, null);
  sinkRows([row]);
}

/** Bulk-persist top-level messages (each must carry seq). */
export async function putMessages(
  channelId: string,
  msgs: Message[],
): Promise<void> {
  const rows = msgs
    .filter((m) => m.seq != null)
    .map((m) => toRow(m.id, channelId, channelId, null, m));
  if (!rows.length) return;
  await rpc(
    { op: "runBatch", items: rows.map((r) => ({ sql: UPSERT, bind: upsertBind(r) })) },
    null,
  );
  sinkRows(rows);
}

/**
 * A page of top-level messages for a conversation, chronological order.
 * `beforeId` pages older (exclusive); null returns the latest page. `nextCursor`
 * is the message id to request next (null when no older messages remain
 * locally). Ordering is by the time-sortable id, so it reflects send time.
 */
export async function getTopPage(
  channelId: string,
  beforeId: string | null,
  limit: number,
): Promise<{ messages: Message[]; nextCursor: string | null }> {
  // Walk newest-first so we can stop at `limit`, then reverse to chronological.
  const rows = await rpc<Row[]>(
    beforeId
      ? {
          op: "all",
          sql: `SELECT data FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
          bind: [channelId, beforeId, limit],
        }
      : {
          op: "all",
          sql: `SELECT data FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?`,
          bind: [channelId, limit],
        },
    [],
  );
  const messages = dec(rows).reverse();
  const nextCursor =
    messages.length === limit && messages.length > 0 ? messages[0].id : null;
  return { messages, nextCursor };
}

// --- full-text search ------------------------------------------------------

/** Sentinels wrapping each matched term in a snippet, for safe UI highlighting
 *  (they can't appear in real text, so no HTML-injection risk). */
export const SNIPPET_OPEN = "";
export const SNIPPET_CLOSE = "";

export type SearchHit = {
  id: string;
  channelId: string;
  /** Parent id when the hit is a thread reply (else null → top-level). */
  parentId: string | null;
  /** Matched text with terms wrapped in SNIPPET_OPEN/CLOSE. */
  snippet: string;
  /** Pre-formatted display time of the message (from the stored row). */
  time?: string;
};

// Turn free text into a safe FTS5 MATCH expression: quote each term (so FTS
// operators/quotes in user input can't throw or inject syntax) and add a prefix
// `*` so "enc" matches "encrypted". Empty when the query has no usable terms.
function toMatchQuery(q: string): string {
  const terms = q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ""))
    .filter(Boolean);
  if (!terms.length) return "";
  return terms.map((t) => `"${t}"*`).join(" ");
}

/**
 * Full-text search across ALL locally-stored (decrypted) messages — top-level
 * and thread replies — ranked by relevance. Covers history that isn't currently
 * loaded in memory, unlike the old in-view scan. Returns [] for an empty query.
 */
export async function searchMessages(
  q: string,
  limit = 50,
): Promise<SearchHit[]> {
  const match = toMatchQuery(q);
  if (!match) return [];
  const rows = await rpc<
    {
      msg_id: string;
      channel_id: string;
      parent_id: string | null;
      snip: string;
      time: string | null;
    }[]
  >(
    {
      op: "all",
      // The FTS rowid mirrors messages.rowid (see the db-worker triggers), so a
      // join recovers row fields the index doesn't carry — here the display time.
      sql: `SELECT messages_fts.msg_id, messages_fts.channel_id, messages_fts.parent_id,
              snippet(messages_fts, 0, char(1), char(2), '…', 12) AS snip,
              json_extract(m.data, '$.time') AS time
            FROM messages_fts
            JOIN messages m ON m.rowid = messages_fts.rowid
            WHERE messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
      bind: [match, limit],
    },
    [],
  );
  return rows.map((r) => ({
    id: r.msg_id,
    channelId: r.channel_id,
    parentId: r.parent_id ?? null,
    snippet: r.snip,
    time: r.time ?? undefined,
  }));
}

export type MediaHit = {
  id: string;
  channelId: string;
  /** Parent id when the attachment lives on a thread reply (else null). */
  parentId: string | null;
  attachment: Attachment;
  /** Caption text sent alongside the attachment (may be empty). */
  text: string;
  /** Pre-formatted display time of the carrying message. */
  time: string;
};

/**
 * Search attachments ("media") across ALL locally-stored messages, newest
 * first. Matches the attachment label/name or the message caption against `q`
 * (case-insensitive substring); an empty query returns the most recent media.
 * The FTS index only covers message text, so this scans the message rows
 * directly — pre-filtered with a cheap LIKE so we only parse rows that actually
 * carry an attachment. Locked (undecryptable) messages have no attachment
 * metadata locally and so never match.
 */
export async function searchMedia(q: string, limit = 50): Promise<MediaHit[]> {
  const ql = q.trim().toLowerCase();
  const rows = await rpc<
    { channel_id: string; parent_id: string | null; data: string }[]
  >(
    {
      op: "all",
      // Over-fetch: the LIKE narrows to rows with an attachment, then JS filters
      // by the query and caps at `limit` (JSON-substring can't rank relevance).
      sql: `SELECT channel_id, parent_id, data FROM messages
            WHERE data LIKE '%"attachment":{%' ORDER BY id DESC LIMIT ?`,
      bind: [Math.max(limit * 4, 200)],
    },
    [],
  );
  const out: MediaHit[] = [];
  for (const r of rows) {
    let m: Message;
    try {
      m = JSON.parse(r.data) as Message;
    } catch {
      continue;
    }
    const a = m.attachment;
    if (!a || m.deleted) continue;
    if (ql) {
      const hay = `${a.label ?? ""} ${a.name ?? ""} ${m.text ?? ""}`.toLowerCase();
      if (!hay.includes(ql)) continue;
    }
    out.push({
      id: m.id,
      channelId: r.channel_id,
      parentId: r.parent_id ?? null,
      attachment: a,
      text: m.text ?? "",
      time: m.time,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A window of top-level messages around `msgId` (for jump-to-message from a
 * search hit that isn't in the loaded page): a little context above the target
 * plus everything from it down to the newest, so the bottom stays the true
 * latest and loadOlder keeps working upward. `nextCursor` is the oldest loaded
 * id when more history exists above the window.
 */
export async function getPageAround(
  channelId: string,
  msgId: string,
  radius = 20,
): Promise<{ messages: Message[]; nextCursor: string | null }> {
  const [older, fromTarget] = await Promise.all([
    rpc<Row[]>(
      {
        op: "all",
        sql: `SELECT data FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        bind: [channelId, msgId, radius],
      },
      [],
    ),
    rpc<Row[]>(
      {
        op: "all",
        sql: `SELECT data FROM messages WHERE conv_id = ? AND id >= ? ORDER BY id ASC`,
        bind: [channelId, msgId],
      },
      [],
    ),
  ]);
  const messages = [...dec(older).reverse(), ...dec(fromTarget)];
  const nextCursor =
    older.length === radius && messages.length ? messages[0].id : null;
  return { messages, nextCursor };
}

/** All replies for a thread parent, chronological (by time-sortable id). */
export async function getReplies(parentId: string): Promise<Message[]> {
  const rows = await rpc<Row[]>(
    {
      op: "all",
      sql: `SELECT data FROM messages WHERE parent_id = ? ORDER BY id ASC`,
      bind: [parentId],
    },
    [],
  );
  return dec(rows);
}

/**
 * The latest top-level message of every conversation with local history, in a
 * single query. Powers the sidebar's last-message preview, timestamp, and
 * recency ordering on boot — without loading each conversation's full history.
 * (conv_id is non-NULL only for top-level rows, so replies never win.)
 */
export async function getLatestPerChannel(): Promise<
  { channelId: string; message: Message }[]
> {
  const rows = await rpc<{ conv_id: string; data: string }[]>(
    {
      op: "all",
      sql: `SELECT conv_id, data FROM messages
            WHERE id IN (SELECT MAX(id) FROM messages
                         WHERE conv_id IS NOT NULL GROUP BY conv_id)`,
    },
    [],
  );
  return rows.map((r) => ({
    channelId: r.conv_id,
    message: JSON.parse(r.data) as Message,
  }));
}

/** Fetch a single message by id (for pin-snippet resolution). */
export async function getMessage(id: string): Promise<Message | undefined> {
  const row = await rpc<Row | null>(
    { op: "one", sql: `SELECT data FROM messages WHERE id = ?`, bind: [id] },
    null,
  );
  return row ? (JSON.parse(row.data) as Message) : undefined;
}

/**
 * A stored message plus the conversation it lives in (this device's view) —
 * used by the DM self-heal responder, which must know the channel (to derive
 * the DM peer for the requester-is-a-participant authorization check). Returns
 * null when the message isn't stored locally.
 */
export async function getMessageMeta(
  id: string,
): Promise<{ message: Message; channelId: string } | null> {
  const row = await rpc<{ channel_id: string; data: string } | null>(
    { op: "one", sql: `SELECT channel_id, data FROM messages WHERE id = ?`, bind: [id] },
    null,
  );
  if (!row) return null;
  return { message: JSON.parse(row.data) as Message, channelId: row.channel_id };
}

/** Apply a partial update to a stored message (e.g. tombstone, threadCount). */
export async function patchMessage(
  id: string,
  patch: Partial<Message>,
): Promise<void> {
  const row = await rpc<BackupMessageRow | null>(
    {
      op: "one",
      sql: `SELECT id, channel_id, conv_id, parent_id, data FROM messages WHERE id = ?`,
      bind: [id],
    },
    null,
  );
  if (!row) return;
  const merged = { ...(JSON.parse(row.data) as Message), ...patch };
  const data = JSON.stringify(merged);
  await rpc(
    { op: "run", sql: `UPDATE messages SET data = ? WHERE id = ?`, bind: [data, id] },
    null,
  );
  // Mirror the patched row (tombstone, edit, reaction change) so the history
  // store converges with local state.
  sinkRows([{ ...row, data }]);
}

/**
 * Wipe the entire local message cache. Used on sign-out so decrypted plaintext
 * isn't left readable on a shared machine. This store is per-ORIGIN (not keyed
 * by user), so it holds only the current session's mirrored traffic — clearing
 * it is safe; messages re-replay from the server (as ciphertext) on next login.
 */
export async function clearAll(): Promise<void> {
  await rpc({ op: "run", sql: `DELETE FROM messages`, bind: [] }, null);
}

/** Drop every message belonging to a channel (e.g. on channel delete). */
export async function removeChannel(channelId: string): Promise<void> {
  await rpc(
    { op: "run", sql: `DELETE FROM messages WHERE channel_id = ?`, bind: [channelId] },
    null,
  );
}

// --- backup / restore ------------------------------------------------------
// The key backup (crypto/backup.ts) can only recover forward-secret DMs if it
// carries the decrypted message CONTENT, not just keys — a one-time prekey is
// consumed on first decrypt, so its ciphertext is unrecoverable afterward.
// These export/import the raw rows (whatever plaintext this device holds) so the
// content rides inside the PIN-encrypted blob.

/** A raw persisted message row — the exact tuple stored in the `messages` table. */
export type BackupMessageRow = {
  id: string;
  channel_id: string;
  conv_id: string | null;
  parent_id: string | null;
  data: string; // JSON of the stored (decrypted-where-possible) Message
};

/** Every stored message row, for inclusion in an encrypted key backup. */
export async function exportBackupMessages(): Promise<BackupMessageRow[]> {
  return rpc<BackupMessageRow[]>(
    {
      op: "all",
      sql: `SELECT id, channel_id, conv_id, parent_id, data FROM messages ORDER BY id`,
    },
    [],
  );
}

/**
 * Restore rows from a backup. Upserts by id, so a backup's decrypted plaintext
 * REPLACES a local 🔒 ciphertext row for the same message (the whole point of
 * recovery). On a fresh device the store is empty, so there's nothing to clobber.
 */
export async function importMessages(rows: BackupMessageRow[]): Promise<void> {
  const items = rows
    .filter((r) => r && r.id && typeof r.data === "string")
    .map((r) => ({
      sql: UPSERT,
      bind: [r.id, r.channel_id, r.conv_id ?? null, r.parent_id ?? null, r.data],
    }));
  if (!items.length) return;
  await rpc({ op: "runBatch", items }, null);
}

// --- dev inspection --------------------------------------------------------
// The DB lives in OPFS (opaque SAHPool files), so you can't open it with a
// desktop tool directly. These let you inspect it: run ad-hoc SELECTs, or
// export a real .sqlite3 file to open in any SQLite browser. Exposed on
// `window.__msgdb` in development only (see below) for use from the console.

/** Run an ad-hoc read query and get plain row objects (dev inspection). */
export async function query(
  sql: string,
  bind: SqlValue[] = [],
): Promise<Record<string, SqlValue>[]> {
  return rpc<Record<string, SqlValue>[]>({ op: "all", sql, bind }, []);
}

/** The live DB as real .sqlite3 bytes (via the SAHPool exportFile). */
export async function exportBytes(): Promise<Uint8Array | null> {
  return rpc<Uint8Array | null>({ op: "export" }, null);
}

/** Download the DB as chat-messages.sqlite3 to open in a SQLite tool. */
export async function downloadDb(): Promise<void> {
  const bytes = await exportBytes();
  if (!bytes) return;
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/x-sqlite3" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "chat-messages.sqlite3";
  a.click();
  URL.revokeObjectURL(url);
}

// SqlValue for the query() bind type (avoids importing the sqlite package here).
type SqlValue = string | number | null | Uint8Array | bigint | boolean;

// Dev-only console handle: `await __msgdb.query("SELECT * FROM messages LIMIT 20")`
// or `__msgdb.downloadDb()`. Never attached in production builds.
if (
  typeof window !== "undefined" &&
  process.env.NODE_ENV !== "production"
) {
  (window as unknown as { __msgdb?: unknown }).__msgdb = {
    query,
    downloadDb,
    exportBytes,
  };
}
