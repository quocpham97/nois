/**
 * Whether a message may raise a notification — the ONE copy of that rule.
 *
 * Two places decide it and they have to agree. The server decides whether to
 * send a Web Push to a member with no live socket (`maybePush` in server.ts),
 * and the page decides whether to raise a banner for a message that arrives
 * while the tab is in the background (src/lib/notify.ts). While the rule lived
 * only in server.ts, the page's own path ignored it entirely: "Nothing" still
 * produced desktop and mobile banners, and quiet hours applied to push but not
 * to anything the page raised itself.
 *
 * Deliberately NOT a client module (no "use client"): server.ts imports it.
 */
import type { NotifPrefs } from "./chat-data";

/** What a user with no saved preferences gets. */
export const NOTIF_DEFAULTS: NotifPrefs = { level: 1, sound: false, dnd: true };

/** Quiet hours, in the user's OWN local time (see `tzOffset`). */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;

export function withNotifDefaults(prefs: NotifPrefs | undefined): NotifPrefs {
  return { ...NOTIF_DEFAULTS, ...(prefs ?? {}) };
}

/** The hour of day (0–23) it is *for this user* right now. */
function userHour(prefs: NotifPrefs, now: number): number {
  // tzOffset is minutes east of UTC, saved by the client (see
  // use-profile-actions.ts). Absent — a profile written before it existed —
  // falls back to this process's own clock, which is what the server did for
  // everyone before: right for a user in the server's timezone, hours off for
  // anyone else.
  if (typeof prefs.tzOffset !== "number") return new Date(now).getHours();
  return new Date(now + prefs.tzOffset * 60_000).getUTCHours();
}

export function inQuietHours(prefs: NotifPrefs, now = Date.now()): boolean {
  const h = userHour(prefs, now);
  // The window wraps midnight, so it's a union, not a range.
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/**
 * Is this conversation muted right now? An entry is either an expiry (epoch ms)
 * or `true` for indefinitely; an expired one reads as unmuted and is cleaned up
 * the next time the user changes a mute.
 */
export function isMuted(
  prefs: NotifPrefs | undefined,
  groupId: string,
  now = Date.now(),
): boolean {
  const until = prefs?.muted?.[groupId];
  return until === true || (typeof until === "number" && until > now);
}

/**
 * The three possible answers. A message is a sealed envelope when it arrives,
 * so "was I mentioned?" often can't be answered yet: `defer` says the level-1
 * question is still open and whoever can open the envelope gets to ask again
 * (src/lib/notify.ts re-asks from the decrypt path). A caller that can never
 * resolve it treats defer as no.
 */
export type NotifDecision = "notify" | "skip" | "defer";

/**
 * Should this user be notified about a message in a DM (or a group) right now?
 *
 * `mentioned` is undefined when the body hasn't been opened yet, which is the
 * normal case for a just-arrived E2EE message and the permanent case for the
 * server. Level 1 ("direct messages & mentions") is the only level that has to
 * ask: 0 takes everything, 2 takes nothing, and a DM qualifies on its own.
 */
export function notifDecision(
  prefs: NotifPrefs | undefined,
  {
    isDm,
    groupId,
    mentioned,
    now = Date.now(),
  }: { isDm: boolean; groupId: string; mentioned?: boolean; now?: number },
): NotifDecision {
  const p = withNotifDefaults(prefs);
  // Mute is the most specific thing the user can say, so nothing outranks it —
  // a mention in a muted conversation stays silent.
  if (isMuted(p, groupId, now)) return "skip";
  if (p.level === 2) return "skip";
  if (p.dnd && inQuietHours(p, now)) return "skip";
  if (p.level === 0 || isDm) return "notify";
  if (mentioned === undefined) return "defer";
  return mentioned ? "notify" : "skip";
}

/**
 * The yes/no form, for a caller that can't come back to a deferral: the server
 * never sees plaintext, so a group message at level 1 is simply not pushed —
 * the recipient's own device raises it after decrypt if they were mentioned.
 */
export function notifAllowed(
  prefs: NotifPrefs | undefined,
  opts: { isDm: boolean; groupId: string; mentioned?: boolean; now?: number },
): boolean {
  return notifDecision(prefs, opts) === "notify";
}
