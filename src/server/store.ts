// Relay state for the WebSocket server, backed by Postgres (src/lib/db.ts).
//
// Channels, membership, and messages are now DURABLE: the in-memory Maps below
// act as a write-through read cache (hydrated from Postgres in init(), updated
// + persisted on every mutation), and messages are persisted on send and
// replayed from the DB on channel join. E2EE is preserved — for encrypted
// messages the stored `data` holds only the `enc` ciphertext (text/rich are
// empty), and private/sender keys never reach the server.
//
// Profiles (+ preferences: chat color, quick emoji, archived chats) are also
// durable via the user_profile table. Still process-memory only (reset on
// restart): the workspace name. Workspace membership self-heals as users
// reconnect.
//
// Relative imports only — this runs under tsx/node, not the Next bundler.

import { randomBytes } from "node:crypto";
import {
  type Attachment,
  type Channel,
  type Message,
  type User,
  type UserProfile,
  deriveUser,
  initialsOf,
  nowTime,
} from "../lib/chat-data";
import { ensureSchema, getPool } from "../lib/db";

/** Names mentioned in the text (matched against known workspace members). */
function deriveMentions(text: string): string[] {
  if (!text.includes("@")) return [];
  return listWorkspaceMembers()
    .map((m) => m.name)
    .filter((n) => text.includes("@" + n));
}

export const PAGE_SIZE = 30;

/** Aggregated reaction for the wire: who reacted, so each client derives `mine`. */
export type ReactionAgg = { e: string; n: number; by: string[] };

// --- in-memory state -------------------------------------------------------

type ChannelMeta = Omit<Channel, "messages" | "pinned" | "pinIds">;

const channels = new Map<string, ChannelMeta>();
const members = new Map<string, Set<string>>(); // channelId -> userIds
const seqOf = new Map<string, number>(); // channelId -> last top-level seq
const reads = new Map<string, Map<string, number>>(); // channelId -> userId -> lastReadSeq
const pins = new Map<string, string[]>(); // channelId -> ordered msg ids
const reactions = new Map<string, Map<string, Set<string>>>(); // msgId -> emoji -> userIds
const threadCounts = new Map<string, number>(); // parentId -> reply count
// channelId -> senderDevice -> { fromUserId, env }. Latest opaque sender-key
// distribution envelope per sender device, for offline replay on (re)join.
const senderKeys = new Map<
  string,
  Map<string, { fromUserId: string; env: string }>
>();
// channelId -> "userId|deviceId" -> { fromUserId, deviceId, env }. Latest opaque
// sealed read-cursor per user device (E2EE read receipts), for replay on join.
const receipts = new Map<
  string,
  Map<string, { fromUserId: string; deviceId: string; env: string }>
>();
const profiles = new Map<string, UserProfile>();
const workspace: { name: string; members: Set<string> } = {
  name: "Northwind Studio",
  members: new Set(),
};

// Default public channels every signed-in user is auto-joined to, so a brand
// new user always lands in shared, populated channels (rather than an empty
// workspace) and — because membership is explicit — E2EE sender keys are
// distributed to them. Stable ids (not opaque hashes) so they're consistent
// across restarts; the non-hex slugs can't collide with newChannelId() output.
export const DEFAULT_CHANNELS: { id: string; name: string; topic: string }[] = [
  { id: "general", name: "general", topic: "Company-wide announcements and general chatter" },
  { id: "random", name: "random", topic: "Non-work banter and watercooler talk" },
];
export const DEFAULT_CHANNEL_IDS = DEFAULT_CHANNELS.map((c) => c.id);

// Time-sortable message id: a zero-padded millisecond timestamp (so plain
// lexicographic ordering == chronological ordering), a per-process counter to
// order messages within the same millisecond, and a short random suffix for
// uniqueness across processes. Sorting messages by id therefore sorts them by
// send time — independent of the in-memory `seq` counter, which resets on
// restart and otherwise scrambles ordering once the client merges history from
// multiple server lifetimes.
let idCounter = 0;
const newId = () =>
  `${Date.now().toString().padStart(15, "0")}-${(idCounter++)
    .toString(36)
    .padStart(4, "0")}-${randomBytes(3).toString("hex")}`;

// Opaque channel id: a random hex hash so the id (and thus the /<id> URL)
// never leaks the channel name. DMs share this flat id space but are keyed by
// the peer's (non-hex) user key, so the two effectively never collide.
const newChannelId = () => randomBytes(8).toString("hex");

/** Next per-channel sequence for a top-level message. */
function nextSeq(channelId: string): number {
  const n = (seqOf.get(channelId) ?? 0) + 1;
  seqOf.set(channelId, n);
  return n;
}

// --- Postgres persistence (durable channels/membership/messages) -----------
// The Maps above are a write-through cache; these helpers persist mutations and
// hydrate on boot. Mutations fire-and-forget the DB write (memory is the
// authority for the live request; the DB catches up + survives restart).

/** Run a background DB write, logging (not throwing) on failure. */
function bg(p: Promise<unknown>): void {
  void p.catch((e) => console.error("[store] db write failed:", (e as Error).message));
}

/** Upsert a channel's metadata row. */
function persistChannel(m: ChannelMeta): void {
  bg(
    getPool().query(
      `INSERT INTO "group" (id, type, name, icon, topic, private, dm_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         type=EXCLUDED.type, name=EXCLUDED.name, icon=EXCLUDED.icon,
         topic=EXCLUDED.topic, private=EXCLUDED.private, dm_user=EXCLUDED.dm_user`,
      [
        m.id,
        m.type,
        m.name,
        m.icon ?? null,
        m.topic ?? null,
        !!m.private,
        m.user ? JSON.stringify(m.user) : null,
      ],
    ),
  );
}

/** Persist a message row (`data` is the wire Message; enc-only for E2EE). */
function persistMessage(
  channelId: string,
  message: Message,
  parentId: string | null,
): void {
  bg(
    getPool().query(
      `INSERT INTO message (id, group_id, seq, parent_id, ts, deleted, data)
       VALUES ($1,$2,$3,$4,$5,false,$6)
       ON CONFLICT (id) DO NOTHING`,
      [
        message.id,
        channelId,
        message.seq ?? null,
        parentId,
        message.ts ?? null,
        JSON.stringify(message),
      ],
    ),
  );
}

/** Hydrate the in-memory caches from Postgres (channels, members, seq). */
async function loadFromDb(): Promise<void> {
  const pool = getPool();
  const ch = await pool.query(
    `SELECT id, type, name, icon, topic, private, dm_user FROM "group"`,
  );
  for (const r of ch.rows) {
    channels.set(r.id, {
      id: r.id,
      type: r.type,
      name: r.name,
      ...(r.icon ? { icon: r.icon } : {}),
      ...(r.topic ? { topic: r.topic } : {}),
      ...(r.private ? { private: true } : {}),
      ...(r.dm_user ? { user: r.dm_user as User, presence: "active" } : {}),
    } as ChannelMeta);
  }
  const mem = await pool.query("SELECT group_id, user_id FROM group_member");
  for (const r of mem.rows) {
    let s = members.get(r.group_id);
    if (!s) {
      s = new Set();
      members.set(r.group_id, s);
    }
    s.add(r.user_id);
  }
  // Resume per-group seq from the highest stored top-level message.
  const sq = await pool.query(
    "SELECT group_id, max(seq) AS maxseq FROM message WHERE parent_id IS NULL GROUP BY group_id",
  );
  for (const r of sq.rows) seqOf.set(r.group_id, Number(r.maxseq) || 0);

  // Reactions: msgId → emoji → Set<userId>.
  const rx = await pool.query("SELECT msg_id, emoji, user_id FROM reaction");
  for (const r of rx.rows) {
    let byEmoji = reactions.get(r.msg_id);
    if (!byEmoji) {
      byEmoji = new Map();
      reactions.set(r.msg_id, byEmoji);
    }
    let by = byEmoji.get(r.emoji);
    if (!by) {
      by = new Set();
      byEmoji.set(r.emoji, by);
    }
    by.add(r.user_id);
  }
  // Pins: channelId → ordered msg ids (insertion order).
  const pn = await pool.query(
    "SELECT group_id, msg_id FROM pin ORDER BY created_at",
  );
  for (const r of pn.rows) {
    const list = pins.get(r.group_id) ?? [];
    list.push(r.msg_id);
    pins.set(r.group_id, list);
  }
  // Read cursors: channelId → userId → seq.
  const rc = await pool.query("SELECT group_id, user_id, seq FROM read_cursor");
  for (const r of rc.rows) {
    let m = reads.get(r.group_id);
    if (!m) {
      m = new Map();
      reads.set(r.group_id, m);
    }
    m.set(r.user_id, Number(r.seq));
  }
  // Sender-key envelopes: channelId → senderDevice → { fromUserId, env }.
  const sk = await pool.query(
    "SELECT group_id, sender_device, sender_user, env FROM sender_key",
  );
  for (const r of sk.rows) {
    let m = senderKeys.get(r.group_id);
    if (!m) {
      m = new Map();
      senderKeys.set(r.group_id, m);
    }
    m.set(r.sender_device, { fromUserId: r.sender_user, env: r.env });
  }
  // Read-receipt cursors: channelId → "userId|deviceId" → { …, env }.
  const rcpt = await pool.query(
    "SELECT group_id, user_id, device_id, env FROM message_receipt",
  );
  for (const r of rcpt.rows) {
    let m = receipts.get(r.group_id);
    if (!m) {
      m = new Map();
      receipts.set(r.group_id, m);
    }
    m.set(`${r.user_id}|${r.device_id}`, {
      fromUserId: r.user_id,
      deviceId: r.device_id,
      env: r.env,
    });
  }
  // Profiles + preferences (display name, avatar, chat color, archived, …).
  const pf = await pool.query("SELECT user_id, data FROM user_profile");
  for (const r of pf.rows) {
    profiles.set(r.user_id, r.data as UserProfile);
  }
}

/** Boot: ensure schema, durably seed default channels, hydrate caches. */
export async function init(): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  for (const c of DEFAULT_CHANNELS) {
    await pool.query(
      `INSERT INTO "group" (id, type, name, icon, topic, private)
       VALUES ($1,'group',$2,'hash',$3,false) ON CONFLICT (id) DO NOTHING`,
      [c.id, c.name, c.topic],
    );
  }
  await loadFromDb();
}

/** This message's stored reactions as the wire shape, with the viewer's `mine`. */
function reactionsForViewer(msgId: string, viewerId: string) {
  return reactionAgg(msgId).map((r) => ({
    e: r.e,
    n: r.n,
    mine: r.by.includes(viewerId),
  }));
}

/**
 * A channel's recent top-level messages (chronological), with `threadCount` and
 * the viewer's `reactions` populated — for replay to a joining client. (Pins ride
 * channels:list and read cursors ride unread:state, so they need no replay.)
 */
export async function fetchHistory(
  channelId: string,
  viewerId: string,
  limit = 200,
): Promise<Message[]> {
  const pool = getPool();
  const since = readCursor(channelId, viewerId);
  const max = channelMaxSeq(channelId);
  const CAP = 1000; // hard bound on one replay payload
  const CONTEXT = 25; // a little history before the cursor, for screen context
  let rows: { data: Message }[];
  if (since !== undefined && max - since > 0) {
    // Unread messages exist (e.g. they arrived while this viewer was offline).
    // Replay them ALL — from a little before the cursor — rather than only the
    // last `limit`, so a long absence doesn't drop missed messages. Keep the
    // newest CAP if the gap is enormous (logged so it's not a silent cap).
    const fromSeq = Math.max(0, since - CONTEXT);
    const want = max - fromSeq;
    if (want > CAP) {
      console.warn(
        `[store] history replay ${channelId} for ${viewerId}: ${want} msgs since cursor, capped at ${CAP}`,
      );
    }
    ({ rows } = await pool.query(
      `SELECT data FROM (
         SELECT data, seq FROM message
         WHERE group_id=$1 AND parent_id IS NULL AND seq > $2
         ORDER BY seq DESC LIMIT $3
       ) t ORDER BY seq ASC`,
      [channelId, fromSeq, CAP],
    ));
  } else {
    // Caught up (or never opened) — last `limit` for on-screen context.
    const res = await pool.query(
      `SELECT data FROM message
       WHERE group_id=$1 AND parent_id IS NULL
       ORDER BY seq DESC LIMIT $2`,
      [channelId, limit],
    );
    res.rows.reverse();
    rows = res.rows;
  }
  const counts = await pool.query(
    `SELECT parent_id, count(*)::int AS n FROM message
     WHERE group_id=$1 AND parent_id IS NOT NULL GROUP BY parent_id`,
    [channelId],
  );
  const byParent = new Map<string, number>(
    counts.rows.map((r) => [r.parent_id as string, r.n as number]),
  );
  // `rows` is already in ascending seq order.
  return rows.map((r) => {
    const m = r.data as Message;
    const reactions = reactionsForViewer(m.id, viewerId);
    const n = byParent.get(m.id);
    return { ...m, ...(n ? { threadCount: n } : {}), ...(reactions.length ? { reactions } : {}) };
  });
}

/** A channel's thread replies (with parent ids + viewer reactions), for replay. */
export async function fetchReplies(
  channelId: string,
  viewerId: string,
): Promise<{ parentId: string; reply: Message }[]> {
  const { rows } = await getPool().query(
    `SELECT parent_id, data FROM message
     WHERE group_id=$1 AND parent_id IS NOT NULL ORDER BY created_at`,
    [channelId],
  );
  return rows.map((r) => {
    const reply = r.data as Message;
    const reactions = reactionsForViewer(reply.id, viewerId);
    return {
      parentId: r.parent_id as string,
      reply: reactions.length ? { ...reply, reactions } : reply,
    };
  });
}

// --- group sender-key persistence ------------------------------------------

/** Store/replace a sender device's latest distribution envelope (opaque). */
export function persistSenderKey(
  channelId: string,
  senderDevice: string,
  fromUserId: string,
  env: string,
): void {
  let m = senderKeys.get(channelId);
  if (!m) {
    m = new Map();
    senderKeys.set(channelId, m);
  }
  m.set(senderDevice, { fromUserId, env });
  bg(
    getPool().query(
      `INSERT INTO sender_key (group_id, sender_device, sender_user, env, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (group_id, sender_device)
         DO UPDATE SET sender_user=EXCLUDED.sender_user, env=EXCLUDED.env, updated_at=now()`,
      [channelId, senderDevice, fromUserId, env],
    ),
  );
}

/** All stored sender-key envelopes for a channel, for replay on (re)join. */
export function fetchSenderKeys(
  channelId: string,
): { fromUserId: string; env: string }[] {
  const m = senderKeys.get(channelId);
  return m ? [...m.values()] : [];
}

// --- read-receipt cursors (Phase 2) ----------------------------------------

/** Store/replace a user device's latest sealed read-cursor (opaque). */
export function persistReceipt(
  channelId: string,
  userId: string,
  deviceId: string,
  env: string,
): void {
  let m = receipts.get(channelId);
  if (!m) {
    m = new Map();
    receipts.set(channelId, m);
  }
  m.set(`${userId}|${deviceId}`, { fromUserId: userId, deviceId, env });
  bg(
    getPool().query(
      `INSERT INTO message_receipt (group_id, user_id, device_id, env, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (group_id, user_id, device_id)
         DO UPDATE SET env=EXCLUDED.env, updated_at=now()`,
      [channelId, userId, deviceId, env],
    ),
  );
}

/** All stored read-cursor envelopes for a channel, for replay on (re)join. */
export function fetchReceipts(
  channelId: string,
): { fromUserId: string; deviceId: string; env: string }[] {
  const m = receipts.get(channelId);
  return m ? [...m.values()] : [];
}

// --- helpers ---------------------------------------------------------------

function isMember(channelId: string, userId: string): boolean {
  return members.get(channelId)?.has(userId) ?? false;
}

/** Resolve a member's stored id to a display User, with any saved profile. */
function resolveMember(id: string): User {
  return applyProfile(deriveUser(id), id);
}

/**
 * A DM's display partner is the *other* member relative to the viewer — so each
 * participant sees the person they're talking to.
 */
function dmForViewer(meta: ChannelMeta, viewerId: string): ChannelMeta {
  if (meta.type !== "dm") return meta;
  const others = [...(members.get(meta.id) ?? [])].filter((m) => m !== viewerId);
  const other = others.length ? resolveMember(others[0]) : undefined;
  return other ? { ...meta, user: other, name: other.name } : meta;
}

/** Aggregate a message's reactions: emoji → count + reactor ids. */
function reactionAgg(msgId: string): ReactionAgg[] {
  const byEmoji = reactions.get(msgId);
  if (!byEmoji) return [];
  return [...byEmoji.entries()]
    .filter(([, by]) => by.size > 0)
    .map(([e, by]) => ({ e, n: by.size, by: [...by] }));
}

// --- public API ------------------------------------------------------------

export function channelExists(channelId: string): boolean {
  return channels.has(channelId);
}

/** Whether a channel is a 1:1 DM (vs a group). `type` is the sole
 *  discriminator — ids no longer carry a "dm-" prefix. */
export function isDm(channelId: string): boolean {
  return channels.get(channelId)?.type === "dm";
}

/** A channel's display name (for push routing metadata; undefined for DMs and
 *  unknown channels — a DM's "name" is viewer-specific, so it's left out). */
export function getChannelName(channelId: string): string | undefined {
  const meta = channels.get(channelId);
  return meta && meta.type === "group" ? meta.name : undefined;
}

/** Authorization: may this user see/act in this channel? */
export function canAccess(channelId: string, userId: string): boolean {
  const meta = channels.get(channelId);
  if (!meta) return false;
  if (meta.type === "group" && !meta.private) return true; // public channel
  return isMember(channelId, userId);
}

/** Add a user to a channel's roster. Returns true only if newly added. */
export function addMember(channelId: string, userId: string): boolean {
  let set = members.get(channelId);
  if (!set) {
    set = new Set();
    members.set(channelId, set);
  }
  if (set.has(userId)) return false;
  set.add(userId);
  bg(
    getPool().query(
      `INSERT INTO group_member (group_id, user_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [channelId, userId],
    ),
  );
  return true;
}

export function removeMember(channelId: string, userId: string): void {
  members.get(channelId)?.delete(userId);
  bg(
    getPool().query(
      "DELETE FROM group_member WHERE group_id=$1 AND user_id=$2",
      [channelId, userId],
    ),
  );
}

/** The explicit member roster of a channel, as resolved Users. */
export function listMembers(channelId: string): User[] {
  return [...(members.get(channelId) ?? [])].map(resolveMember);
}

/** Raw member ids of a channel (for targeting unread bumps to private rooms). */
export function listMemberIds(channelId: string): string[] {
  return [...(members.get(channelId) ?? [])];
}

/** Pinned message ids for a channel (client resolves snippets locally). */
export function listPins(channelId: string): string[] {
  return [...(pins.get(channelId) ?? [])];
}

/** Assemble the wire Channel for a viewer (no message bodies; pins as ids). */
function toChannel(meta: ChannelMeta, viewerId: string): Channel {
  return {
    ...dmForViewer(meta, viewerId),
    pinIds: listPins(meta.id),
    pinned: [],
    memberList: listMembers(meta.id),
    messages: [],
  };
}

/** Channels this user may see: all public channels + private/DMs they're in. */
export function listChannelsForUser(userId: string): Channel[] {
  const out: Channel[] = [];
  for (const meta of channels.values()) {
    const isPublic = meta.type === "group" && !meta.private;
    if (isPublic || isMember(meta.id, userId)) out.push(toChannel(meta, userId));
  }
  return out;
}

/** Full channel metadata (no messages) — used to announce a new channel/DM. */
export function getChannel(
  channelId: string,
  viewerId: string,
): Channel | undefined {
  const meta = channels.get(channelId);
  return meta ? toChannel(meta, viewerId) : undefined;
}

/** Toggle a message's pinned state in a channel; returns the new pin id list. */
export function togglePin(
  channelId: string,
  msgId: string,
  _userId: string,
): string[] | null {
  void _userId;
  if (!channelExists(channelId)) return null;
  const list = pins.get(channelId) ?? [];
  const idx = list.indexOf(msgId);
  if (idx >= 0) {
    list.splice(idx, 1);
    bg(getPool().query("DELETE FROM pin WHERE group_id=$1 AND msg_id=$2", [channelId, msgId]));
  } else {
    list.push(msgId);
    bg(
      getPool().query(
        "INSERT INTO pin (group_id, msg_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [channelId, msgId],
      ),
    );
  }
  pins.set(channelId, list);
  return [...list];
}

/**
 * Construct (but do NOT store) a new top-level message: stamps id/seq/time and
 * derives mentions. The body is returned for relay only — the server keeps no
 * copy. Returns null if the channel doesn't exist.
 */
export function addMessage(
  channelId: string,
  author: User,
  text: string,
  clientId?: string,
  attachment?: Attachment,
  rich?: string,
  enc?: string,
): Message | null {
  void clientId;
  if (!channelExists(channelId)) return null;
  const mentions = deriveMentions(text);
  const message: Message = {
    id: newId(),
    seq: nextSeq(channelId),
    author,
    time: nowTime(),
    ts: Date.now(),
    text,
    reactions: [],
    ...(attachment ? { attachment } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(rich ? { rich } : {}),
    ...(enc ? { enc } : {}),
  };
  persistMessage(channelId, message, null);
  return message;
}

/**
 * Construct (but do NOT store) a thread reply, bumping the parent's in-memory
 * reply count so threadCount stays consistent across clients.
 */
export function addThreadReply(
  channelId: string,
  parentId: string,
  author: User,
  text: string,
  rich?: string,
): { reply: Message; threadCount: number; threadLastTime: string } | null {
  if (!channelExists(channelId)) return null;
  const reply: Message = {
    id: newId(),
    author,
    time: nowTime(),
    ts: Date.now(),
    text,
    reactions: [],
    ...(rich ? { rich } : {}),
  };
  const threadCount = (threadCounts.get(parentId) ?? 0) + 1;
  threadCounts.set(parentId, threadCount);
  persistMessage(channelId, reply, parentId);
  return { reply, threadCount, threadLastTime: "just now" };
}

/** Toggle one user's reaction; returns the aggregated reactions for broadcast. */
export function toggleReaction(
  channelId: string,
  msgId: string,
  emoji: string,
  userId: string,
): ReactionAgg[] | null {
  if (!channelExists(channelId)) return null;
  let byEmoji = reactions.get(msgId);
  if (!byEmoji) {
    byEmoji = new Map();
    reactions.set(msgId, byEmoji);
  }
  let by = byEmoji.get(emoji);
  if (!by) {
    by = new Set();
    byEmoji.set(emoji, by);
  }
  if (by.has(userId)) {
    by.delete(userId);
    bg(
      getPool().query(
        "DELETE FROM reaction WHERE msg_id=$1 AND emoji=$2 AND user_id=$3",
        [msgId, emoji, userId],
      ),
    );
  } else {
    by.add(userId);
    bg(
      getPool().query(
        `INSERT INTO reaction (group_id, msg_id, emoji, user_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [channelId, msgId, emoji, userId],
      ),
    );
  }
  return reactionAgg(msgId);
}

/**
 * Create a new channel. The id is an opaque hash; the slug is the display name.
 * Private channels record the creator as their first member.
 */
export function createChannel(
  name: string,
  opts: { topic?: string; private?: boolean; creatorId?: string } = {},
): Channel | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return null;

  let id = newChannelId();
  while (channelExists(id)) id = newChannelId();

  const meta: ChannelMeta = {
    id,
    type: "group",
    name: slug,
    icon: opts.private ? "lock" : "hash",
    ...(opts.topic?.trim() ? { topic: opts.topic.trim() } : {}),
    ...(opts.private ? { private: true } : {}),
  };
  channels.set(id, meta);
  persistChannel(meta);
  if (opts.creatorId) addMember(id, opts.creatorId);
  return getChannel(id, opts.creatorId ?? "") ?? null;
}

/** Update a channel's display name and/or topic. Returns the updated Channel. */
export function updateChannel(
  channelId: string,
  patch: { name?: string; topic?: string },
): Channel | null {
  const meta = channels.get(channelId);
  if (!meta || meta.type === "dm") return null; // DMs aren't editable
  const next: ChannelMeta = { ...meta };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name) next.name = name;
  }
  if (patch.topic !== undefined) {
    const topic = patch.topic.trim();
    if (topic) next.topic = topic;
    else delete next.topic;
  }
  channels.set(channelId, next);
  persistChannel(next);
  return getChannel(channelId, "") ?? null;
}

/** Delete a channel and its attached metadata (members, pins, seq, reads). */
export function deleteChannel(channelId: string): boolean {
  if (!channelExists(channelId)) return false;
  channels.delete(channelId);
  members.delete(channelId);
  pins.delete(channelId);
  seqOf.delete(channelId);
  reads.delete(channelId);
  bg(
    (async () => {
      const pool = getPool();
      await pool.query("DELETE FROM reaction WHERE group_id=$1", [channelId]);
      await pool.query("DELETE FROM pin WHERE group_id=$1", [channelId]);
      await pool.query("DELETE FROM read_cursor WHERE group_id=$1", [channelId]);
      await pool.query("DELETE FROM message WHERE group_id=$1", [channelId]);
      await pool.query("DELETE FROM group_member WHERE group_id=$1", [channelId]);
      await pool.query(`DELETE FROM "group" WHERE id=$1`, [channelId]);
    })(),
  );
  return true;
}

export function ensureDm(dmId: string, recipient: User): void {
  if (channelExists(dmId)) return;
  const meta: ChannelMeta = {
    id: dmId,
    type: "dm",
    name: recipient.name,
    user: recipient,
    presence: "active",
  };
  channels.set(dmId, meta);
  persistChannel(meta);
}

/** Resolve a recipient key to a User, or null for an empty key. */
export function userByKey(key: string): User | null {
  return key ? resolveMember(key) : null;
}

// --- workspace -------------------------------------------------------------

export function getWorkspaceName(): string {
  return workspace.name;
}

export function listWorkspaceMembers(): User[] {
  return [...workspace.members].map(resolveMember);
}

export function setWorkspaceName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  workspace.name = trimmed;
  return true;
}

/**
 * Join a user to every seeded default channel. Returns the ids they were newly
 * added to (so the caller can announce the roster change for E2EE re-keying).
 */
export function joinDefaultChannels(userId: string): string[] {
  const joined: string[] = [];
  for (const id of DEFAULT_CHANNEL_IDS) {
    if (channels.has(id) && addMember(id, userId)) joined.push(id);
  }
  return joined;
}

/** Add a member to the workspace roster. Returns true if newly added. */
export function addWorkspaceMember(memberId: string): boolean {
  const id = memberId.trim();
  if (!id || workspace.members.has(id)) return false;
  workspace.members.add(id);
  return true;
}

export function removeWorkspaceMember(memberId: string): void {
  workspace.members.delete(memberId);
}

// --- unread / read tracking ------------------------------------------------
// Unread = top-level messages newer than the user's read cursor. Both are
// integer per-channel seqs, so this needs no message content.

const channelMaxSeq = (channelId: string): number => seqOf.get(channelId) ?? 0;

function readCursor(channelId: string, userId: string): number | undefined {
  return reads.get(channelId)?.get(userId);
}

function setReadCursor(channelId: string, userId: string, seq: number): void {
  let m = reads.get(channelId);
  if (!m) {
    m = new Map();
    reads.set(channelId, m);
  }
  m.set(userId, seq);
  bg(
    getPool().query(
      `INSERT INTO read_cursor (group_id, user_id, seq) VALUES ($1,$2,$3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET seq=EXCLUDED.seq`,
      [channelId, userId, seq],
    ),
  );
}

/** Baseline a user's read cursor for every channel they can see (caught up). */
export function initUserReads(userId: string): void {
  for (const ch of listChannelsForUser(userId)) {
    if (readCursor(ch.id, userId) === undefined) {
      setReadCursor(ch.id, userId, channelMaxSeq(ch.id));
    }
  }
}

/** Mark a channel fully read for a user (cursor jumps to the latest message). */
export function markRead(channelId: string, userId: string): void {
  setReadCursor(channelId, userId, channelMaxSeq(channelId));
}

export function getUnread(channelId: string, userId: string): number {
  const last = readCursor(channelId, userId);
  if (last === undefined) return 0; // unseen channel → caught up until opened
  return Math.max(0, channelMaxSeq(channelId) - last);
}

/** Unread counts for all of a user's channels, keyed by channel id. */
export function unreadState(userId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ch of listChannelsForUser(userId)) {
    out[ch.id] = getUnread(ch.id, userId);
  }
  return out;
}

export function isPublicChannel(channelId: string): boolean {
  const meta = channels.get(channelId);
  return Boolean(meta && meta.type === "group" && !meta.private);
}

// --- message deletion ------------------------------------------------------

/**
 * Tombstone a message (keep the slot/thread so replay shows "deleted") and drop
 * its server-side metadata (reactions, any pin). The body itself lives only in
 * clients' local stores, so the actual tombstone is applied client-side on the
 * broadcast `message:deleted` event.
 *
 * Only the AUTHOR may delete. The server keeps no in-memory message copy, so
 * the authorship check IS the UPDATE's WHERE clause against the stored row —
 * which is why this is awaited rather than fire-and-forget: rowCount tells the
 * caller whether anything was actually deleted (false → don't broadcast).
 */
export async function deleteMessage(
  channelId: string,
  msgId: string,
  userId: string,
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE message SET deleted=true,
       data = data || '{"text":"","rich":null,"attachment":null,"reactions":[],"deleted":true}'::jsonb
     WHERE id=$1 AND group_id=$2 AND data->'author'->>'id'=$3 AND deleted=false`,
    [msgId, channelId, userId],
  );
  if (res.rowCount !== 1) return false;
  reactions.delete(msgId);
  const list = pins.get(channelId);
  if (list) {
    const idx = list.indexOf(msgId);
    if (idx >= 0) {
      list.splice(idx, 1);
      pins.set(channelId, list);
    }
  }
  bg(
    (async () => {
      await pool.query("DELETE FROM reaction WHERE msg_id=$1", [msgId]);
      await pool.query("DELETE FROM pin WHERE group_id=$1 AND msg_id=$2", [channelId, msgId]);
    })(),
  );
  return true;
}

/**
 * Replace a message's encrypted body in place — an edit is a re-encrypted
 * envelope; the server merges it into the stored row and never sees plaintext.
 * Replay (fetchHistory/fetchReplies) returns `data` verbatim, so history
 * automatically serves the edited envelope. Author-only + awaited, exactly
 * like deleteMessage. Returns the row's parent_id (null → top-level) so the
 * caller can route the broadcast to thread panels.
 */
export async function editMessage(
  channelId: string,
  msgId: string,
  userId: string,
  enc: string,
  editedTs: number,
): Promise<{ ok: true; parentId: string | null } | { ok: false }> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE message SET
       data = data || jsonb_build_object(
         'enc', $4::text, 'edited', true, 'editedTs', $5::bigint,
         'text', '', 'rich', null)
     WHERE id=$1 AND group_id=$2 AND data->'author'->>'id'=$3 AND deleted=false
     RETURNING parent_id`,
    [msgId, channelId, userId, enc, editedTs],
  );
  if (res.rowCount !== 1) return { ok: false };
  return { ok: true, parentId: (res.rows[0].parent_id as string | null) ?? null };
}

// --- user profiles ---------------------------------------------------------

export function getProfile(userId: string): UserProfile {
  return profiles.get(userId) ?? {};
}

export function setProfile(
  userId: string,
  patch: Partial<UserProfile>,
): UserProfile {
  const next = { ...getProfile(userId) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    // Strings are trimmed and dropped when empty; arrays (e.g. `archived`)
    // are dropped when empty; anything else nullish is dropped.
    const val = typeof v === "string" ? v.trim() : v;
    const keep = Array.isArray(val) ? val.length > 0 : !!val;
    if (keep) next[k] = val;
    else delete next[k];
  }
  const prof = next as UserProfile;
  profiles.set(userId, prof);
  bg(
    getPool().query(
      `INSERT INTO user_profile (user_id, data) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [userId, JSON.stringify(prof)],
    ),
  );
  return prof;
}

/** Apply a saved display name to a base User (keeps the base avatar colour). */
export function applyProfile(base: User, userId: string): User {
  const name = profiles.get(userId)?.displayName?.trim();
  if (!name) return base;
  return { ...base, name, initials: initialsOf(name, base.initials) };
}
