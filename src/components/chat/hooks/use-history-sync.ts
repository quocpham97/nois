"use client";

/**
 * The continuous encrypted history store (crypto/backup.ts).
 *
 * Every locally-persisted plaintext row is mirrored to the server, encrypted
 * under the user's storage key — so a new device that gets approved (or restores
 * a PIN) can pull the whole history back rather than only what the server still
 * holds as undelivered. All of it is a no-op until a storage key exists on this
 * device, i.e. until backup is set up or restored.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { storageKeyGet } from "@/lib/crypto/identity";
import { decryptHistoryRows, encryptHistoryRow } from "@/lib/crypto/backup";
import {
  exportBackupMessages,
  importMessages,
  setHistorySink,
  type BackupMessageRow,
} from "@/lib/message-db";
import type { HistoryFetchResult, HistoryRowWire } from "@/lib/socket-events";
import type { TypedSocket } from "@/stores/session-store";

export type HistorySync = ReturnType<typeof useHistorySync>;

export function useHistorySync({
  userId,
  socketRef,
}: {
  userId: string;
  socketRef: React.RefObject<TypedSocket | null>;
}) {
  const syncingRef = useRef(false);
  const marker = useCallback(() => `chat:histsync:${userId}`, [userId]);

  // Registered as message-db's sink so all persist paths (send ack, receive,
  // replay backfill, edits, tombstones) flow through without the chat hooks
  // knowing about it.
  useEffect(() => {
    setHistorySink((rows: BackupMessageRow[]) => {
      void (async () => {
        const wire: HistoryRowWire[] = [];
        for (const r of rows) {
          const w = await encryptHistoryRow(userId, r);
          if (w) wire.push(w);
        }
        if (wire.length) socketRef.current?.emit("history:append", { rows: wire });
      })();
    });
    return () => setHistorySink(null);
  }, [userId, socketRef]);

  /** One-time UPLOAD of this device's existing local history into the store —
   *  runs when a storage key first becomes available (backup created/unlocked) or
   *  once per device for pre-existing installs, so the store isn't empty for
   *  history that predates continuous appends. Marker-guarded per user. */
  const syncUp = useCallback(async () => {
    const s = socketRef.current;
    if (!s || syncingRef.current) return;
    try {
      if (localStorage.getItem(marker())) return;
    } catch {
      return; // no localStorage → skip (SSR/ancient browser)
    }
    if (!(await storageKeyGet(userId))) return;
    syncingRef.current = true;
    try {
      const rows = await exportBackupMessages();
      for (let i = 0; i < rows.length; i += 100) {
        const wire: HistoryRowWire[] = [];
        for (const r of rows.slice(i, i + 100)) {
          const w = await encryptHistoryRow(userId, r);
          if (w) wire.push(w);
        }
        if (wire.length) s.emit("history:append", { rows: wire });
      }
      try {
        localStorage.setItem(marker(), new Date().toISOString());
      } catch {
        /* best-effort marker */
      }
    } finally {
      syncingRef.current = false;
    }
  }, [userId, marker, socketRef]);

  /** DOWNLOAD the full history store into local SQLite (new-device restore):
   *  page → decrypt with the (just-imported) storage key → upsert. Sets the
   *  sync-up marker so the restored device doesn't re-upload what it just got. */
  const syncDown = useCallback(
    async (s: TypedSocket) => {
      let cursor: string | null = null;
      do {
        const res: HistoryFetchResult = await new Promise((resolve) => {
          const t = setTimeout(() => resolve({ rows: [], nextCursor: null }), 15000);
          s.emit("history:fetchMine", { afterMsgId: cursor }, (r) => {
            clearTimeout(t);
            resolve(r ?? { rows: [], nextCursor: null });
          });
        });
        const rows = await decryptHistoryRows(userId, res.rows);
        if (rows.length) await importMessages(rows);
        cursor = res.nextCursor;
      } while (cursor);
      try {
        localStorage.setItem(marker(), new Date().toISOString());
      } catch {
        /* best-effort marker */
      }
    },
    [userId, marker],
  );

  return useMemo(() => ({ syncUp, syncDown }), [syncUp, syncDown]);
}
