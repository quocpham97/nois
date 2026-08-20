"use client";

/**
 * Cross-TAB mutual exclusion, via the Web Locks API.
 *
 * Several client-side stores are single-writer by construction: an MLS
 * ClientState advances a ratchet per message, and a capped IndexedDB record
 * (the outbox, a decrypted-plaintext window) is a read-modify-write of one
 * value. In-tab those sections are already serialized — but IndexedDB is shared
 * by every tab of the origin, and each tab holds its OWN in-memory copy, so two
 * tabs of one login fork the state and the last writer silently wins.
 *
 * For MLS that is not a cosmetic race: a forked sender ratchet re-uses a
 * generation, and every OTHER member rejects the duplicate for good
 * ("Desired gen in the past"), so the message is unreadable for everyone
 * forever — a second tab quietly corrupting the first tab's conversation.
 *
 * Locks are held per ORIGIN, so they also cover the desktop/mobile shells (same
 * origin in a WebView) and a second window of the same app.
 *
 * Two rules for callers:
 *   * RE-READ the shared state inside the lock. Ordering the writers doesn't
 *     refresh anyone's cache — a stale in-memory copy written back under a
 *     perfectly good lock forks the state just the same.
 *   * NEVER nest the same name. Web Locks are not re-entrant, so a locked
 *     section that asks for the lock it already holds deadlocks itself.
 */

/** Run `fn` while holding the named cross-tab lock. */
export function withTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { locks?: LockManager }).locks;
  // Pre-Web-Locks browser (Safari < 15.4), or a non-secure context: run
  // unserialized, which is exactly what every tab did before this existed. The
  // in-tab serialization each caller keeps is unaffected.
  if (!locks) return fn();
  // Deliberately UNBOUNDED wait. Every section this guards is bounded by its own
  // socket timeouts (5–8s each), and a tab that crashes or closes drops its locks
  // automatically — so the queue always drains. Aborting the wait instead would
  // mean either failing the operation or, far worse, proceeding unserialized into
  // the fork this exists to prevent.
  // The lib.dom callback type is `() => T`, so an async callback types the result
  // as Promise<Promise<T>>; the runtime awaits it, so the cast states what the
  // call actually resolves to.
  return locks.request(name, fn) as Promise<T>;
}
