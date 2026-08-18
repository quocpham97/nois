// Custom Next.js server that also hosts the Socket.IO WebSocket server in the
// same process. A long-running Node process is required because persistent
// WebSocket connections can't live in serverless route handlers.
//
// Run with `npm run dev` / `npm start` (both invoke tsx server.ts).
// Phase A: connection lifecycle + an `echo` health-check round-trip only.

import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { parse } from "node:url";
import { loadEnvConfig } from "@next/env";
import next from "next";
import { getToken } from "next-auth/jwt";
import { Server as IOServer } from "socket.io";
import webpush from "web-push";

// Load .env.local (AUTH_SECRET, REDIS_URL, DATABASE_URL) into this custom
// process — Next does this for its own runtime, but we read them here too.
loadEnvConfig(process.cwd());
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SfuFailure,
} from "./src/lib/socket-events";
import {
  type Group,
  type User,
  deriveUser,
  CHAT_GRADIENTS,
} from "./src/lib/chat-data";
import { dmIdFor } from "./src/lib/dm-id";
import * as store from "./src/server/store";
import * as keyStore from "./src/server/key-store";
import * as mlsDs from "./src/server/mls-ds";
import {
  sessionCookieName,
  secureCookies,
} from "./src/server/session-cookie";
import {
  getPool,
  listPushSubscriptions,
  deletePushSubscription,
  type PushSub,
} from "./src/lib/db";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT) || 4000;

// Call limits (see docs/group-calls-plan.md). Media is a full mesh, so every
// participant uploads N−1 streams: the caps are about uplink and CPU, not policy.
// A call is capped by what it CARRIES, not by the group it's in — a video call
// at 4, a voice call at 6 — and the ceiling is enforced when someone joins, so
// a call that starts small can't quietly grow past it and degrade people already
// talking. Which one applies is read off the callId (see `capacityOf`).
const CALL_MAX_VOICE = 6;
const CALL_MAX_VIDEO = 4;
/** Largest private group whose members' devices ring; above this it's a huddle. */
const CALL_RING_MAX = 6;
/** Joins refused for being at capacity — the agreed trigger for building an SFU. */
let callCapRejections = 0;
/**
 * How long a dropped participant keeps their place before the rest of the call
 * is told they're gone.
 *
 * Signaling and media are separate: the PeerConnections are peer-to-peer and
 * survive a websocket blip untouched. Evicting on `disconnecting` therefore
 * ended a call that was still perfectly capable of carrying audio — and worse,
 * it cascaded, because the eviction emptied everyone else's roster in turn.
 * Wi-Fi-to-cellular handoff is exactly this case.
 */
const CALL_DROP_GRACE_MS = Number(process.env.CALL_DROP_GRACE_MS) || 10_000;

/**
 * Seats held for devices whose socket dropped, keyed `<room>|<deviceId>`.
 *
 * The room alone can't express this. A blip usually hits everyone at once (a
 * server hiccup, not one bad phone), and a socket leaves its rooms the moment
 * it disconnects — so the room goes EMPTY and there is nothing for the first
 * client back to rejoin. Holding the seats keeps the call addressable across a
 * total signaling outage, and keeps `call:over` from firing on a call that
 * everyone is in the middle of returning to.
 *
 * Node-local, which suits a deployment that is deliberately single-node
 * (REDIS_URL unset — see render.yaml). Behind the Redis adapter a reconnect
 * landing on another node would not see the held seat and would be told the
 * call is gone: correct-but-pessimistic, and the point to revisit if this ever
 * scales out.
 */
const heldSeats = new Map<string, { userId: string; expiresAt: number }>();
const seatKey = (room: string, deviceId: string) => `${room}|${deviceId}`;
/** Is anyone expected back in this room? */
const roomHasHeldSeat = (room: string): boolean => {
  const now = Date.now();
  for (const [key, seat] of heldSeats) {
    if (key.startsWith(room + "|") && seat.expiresAt > now) return true;
  }
  return false;
};
/** A seat this user is expected back in, tolerating an unannounced deviceId. */
const heldSeatFor = (room: string, userId: string, deviceId: string): string | null => {
  const now = Date.now();
  const exact = heldSeats.get(seatKey(room, deviceId));
  if (exact && exact.expiresAt > now) return seatKey(room, deviceId);
  for (const [key, seat] of heldSeats) {
    if (key.startsWith(room + "|") && seat.userId === userId && seat.expiresAt > now) {
      return key; // one device per user per call, so this is unambiguous
    }
  }
  return null;
};

// TURN credentials are minted HERE, not inlined into the client bundle. The key
// never leaves this process; clients ask for `ice:servers` over their already
// authenticated socket and get a credential that expires on its own, so a
// leaked one stops being an open relay instead of staying one forever.
// Cloudflare issues no static credentials at all, which is what forces this
// shape — see docs/calls-production.md.
const TURN_KEY_ID = process.env.TURN_KEY_ID;
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN;
/** Credential lifetime. Long enough that no call outlives its own credential
 *  (ICE re-checks during a call would fail), short enough that a leak is
 *  self-limiting. */
const TURN_TTL_S = Number(process.env.TURN_TTL_S) || 3600;
/** Refetch this far ahead of expiry so a call never starts on a credential
 *  that dies mid-negotiation. */
const TURN_REFRESH_MARGIN_S = 300;

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

// Cloudflare Realtime SFU (phase C — flag-gated, see docs/calls-production.md).
//
// The app token is app-WIDE: Cloudflare issues no room-scoped, per-participant
// token the way LiveKit does. So it can never be handed to a client, and every
// SFU call is proxied through this process. That is the whole reason the SFU
// needs server surface at all — the mesh needed none.
const SFU_APP_ID = process.env.SFU_APP_ID;
const SFU_APP_TOKEN = process.env.SFU_APP_TOKEN;
const SFU_BASE = "https://rtc.live.cloudflare.com/v1";

/** One proxied Realtime API call. Throws on transport or HTTP failure; the
 *  caller turns that into an `ok: false` ack rather than a dropped call. */
async function sfuFetch<T>(
  path: string,
  method: "POST" | "PUT",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${SFU_BASE}/apps/${SFU_APP_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SFU_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`sfu ${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}
// Cached per process: the credential is not user-scoped, so one fetch serves
// every client until it nears expiry. `inflight` collapses a thundering herd
// (many clients connecting at once) into a single upstream request.
let iceCache: { servers: IceServerConfig[]; expiresAt: number } | null = null;
let iceInflight: Promise<IceServerConfig[]> | null = null;

async function fetchCloudflareIceServers(): Promise<IceServerConfig[]> {
  if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) return [];
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!res.ok) {
    throw new Error(`cloudflare turn ${res.status} ${await res.text()}`);
  }
  // Their response nests a single object under `iceServers`; normalise to the
  // array shape RTCPeerConnection wants either way, since one object and a
  // list of them are both plausible readings of that field.
  const body = (await res.json()) as {
    iceServers?: IceServerConfig | IceServerConfig[];
  };
  const raw = body.iceServers;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Current ICE servers, or [] if TURN isn't configured (the client then falls
 *  back to its build-time vars). Never throws: no TURN is a degraded call, but
 *  a thrown error here would be no call at all. */
async function iceServersFor(): Promise<{ servers: IceServerConfig[]; ttl: number }> {
  const now = Date.now();
  if (iceCache && iceCache.expiresAt > now) {
    return { servers: iceCache.servers, ttl: Math.floor((iceCache.expiresAt - now) / 1000) };
  }
  if (!iceInflight) {
    iceInflight = fetchCloudflareIceServers()
      .then((servers) => {
        iceCache = {
          servers,
          expiresAt: Date.now() + (TURN_TTL_S - TURN_REFRESH_MARGIN_S) * 1000,
        };
        return servers;
      })
      .catch((e) => {
        console.warn("[turn] could not mint credentials:", (e as Error).message);
        // Negative-cache briefly: with the provider down, every call start
        // would otherwise re-attempt and pay the timeout before falling back.
        iceCache = { servers: [], expiresAt: Date.now() + 30_000 };
        return [];
      })
      .finally(() => {
        iceInflight = null;
      });
  }
  const servers = await iceInflight;
  const ttl = iceCache ? Math.floor((iceCache.expiresAt - Date.now()) / 1000) : 0;
  return { servers, ttl: Math.max(ttl, 0) };
}

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  // Hydrate the durable relay state (groups/membership/seq) from Postgres and
  // ensure the schema before accepting connections.
  await store.init();
  // Hydrate the public device-key directory too (schema created by store.init).
  await keyStore.init();
  // Hydrate MLS group heads (epoch + last seq) for the delivery service.
  await mlsDs.init();

  const httpServer = createServer((req, res) => {
    handle(req, res, parse(req.url || "/", true));
  });

  const io = new IOServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    {
      // Default path is /socket.io — Socket.IO intercepts its own path and the
      // HTTP upgrade handshake before requests reach the Next handler.
      cors: { origin: true },
      // Ping more often than the default (25s) so a genuinely dead peer is
      // noticed within ~30s, but keep a generous pong timeout so a busy main
      // thread / GC pause / brief stall does NOT get falsely dropped (a too-low
      // timeout caused spurious disconnects and "failed to send").
      pingInterval: 10000,
      pingTimeout: 20000,
      // Resume a briefly-dropped session and replay missed packets, so short
      // blips don't lose the message:ack (no visible failure at all).
      connectionStateRecovery: { maxDisconnectionDuration: 60000 },
    },
  );

  // Multi-node scale (opt-in via REDIS_URL): the Redis adapter relays
  // broadcasts across server instances, and presence is tracked in Redis so it
  // reflects connections on every node. Without REDIS_URL the app runs
  // single-node with the in-memory adapter + map (the default here).
  const redisUrl = process.env.REDIS_URL;
  let redis: import("redis").RedisClientType | null = null;
  if (redisUrl) {
    const { createClient } = await import("redis");
    const { createAdapter } = await import("@socket.io/redis-adapter");
    const pub = createClient({ url: redisUrl });
    const sub = pub.duplicate();
    redis = pub.duplicate() as import("redis").RedisClientType;
    await Promise.all([pub.connect(), sub.connect(), redis.connect()]);
    io.adapter(createAdapter(pub, sub));
    console.log("[ws] Redis adapter enabled (multi-node)");
  }

  // Presence backend: Redis hash (cross-node) when configured, else in-memory.
  const memOnline = new Map<string, number>();
  const presence = redis
    ? {
        async connect(uid: string) {
          return (await redis!.hIncrBy("presence", uid, 1)) === 1;
        },
        async disconnect(uid: string) {
          const n = await redis!.hIncrBy("presence", uid, -1);
          if (n <= 0) await redis!.hDel("presence", uid);
          return n <= 0;
        },
        async list() {
          const all = await redis!.hGetAll("presence");
          return Object.keys(all).filter((k) => Number(all[k]) > 0);
        },
      }
    : {
        async connect(uid: string) {
          const p = memOnline.get(uid) ?? 0;
          memOnline.set(uid, p + 1);
          return p === 0;
        },
        async disconnect(uid: string) {
          const n = (memOnline.get(uid) ?? 1) - 1;
          if (n <= 0) memOnline.delete(uid);
          else memOnline.set(uid, n);
          return n <= 0;
        },
        async list() {
          return [...memOnline.keys()];
        },
      };

  // Authenticate every connection: verify the Auth.js session cookie from the
  // handshake and attach the resolved user. Unauthenticated sockets are
  // rejected before any event handler runs.
  io.use(async (socket, nextFn) => {
    try {
      const cookie = socket.handshake.headers.cookie || "";
      // Cookie name/salt follow the AUTH_URL scheme (secure prefix over
      // https) so the same code authenticates sockets in dev and behind TLS.
      const token = await getToken({
        req: { headers: { cookie } } as never,
        secret: process.env.AUTH_SECRET,
        secureCookie: secureCookies(),
        cookieName: sessionCookieName(),
        salt: sessionCookieName(),
      });
      const uid = token?.uid as string | undefined;
      if (!uid) return nextFn(new Error("unauthorized"));
      const sd = socket.data as { userId?: string; user?: User };
      sd.userId = uid;
      // Build the profile from the verified token (seeded users keep their
      // fixed profile; real Google users get a derived one).
      sd.user = deriveUser(uid, token?.name as string | undefined);
      nextFn();
    } catch {
      nextFn(new Error("unauthorized"));
    }
  });

  // Notify everyone who can see a group — but isn't currently in its room
  // (i.e. not viewing it) — that it has a new unread message. Public groups
  // reach the whole workspace; private groups only their members' rooms.
  const bumpUnread = (groupId: string) => {
    if (store.isPublicGroup(groupId)) {
      io.except(groupId).emit("unread:bump", { groupId });
    } else {
      const rooms = store.listMemberIds(groupId).map((id) => "user:" + id);
      if (rooms.length) {
        io.to(rooms).except(groupId).emit("unread:bump", { groupId });
      }
    }
  };

  // The per-user rooms of every group member. Message events are delivered
  // here — NOT to the group room (`socket.to(groupId)`) — so a member
  // receives (and locally stores) messages for ALL their groups even while
  // they're viewing a different one. The group room is reserved for "currently
  // viewing" signals (typing, and the unread-bump exclusion above). Delivering
  // to members rather than just current viewers stops a message vanishing when
  // the recipient is looking at another group; a member who is fully offline
  // recovers missed messages + sender keys via replay on reconnect (see below).
  const memberRooms = (groupId: string) =>
    store.listMemberIds(groupId).map((id) => "user:" + id);

  // Audience for a group's *durable* state — pins, reactions, roster changes,
  // deletion. Same rule as messages: everyone who can see the group, not just
  // the sockets currently in its room. A member reading another conversation
  // still holds this group in memory, and a room-only broadcast left them with
  // stale pins/reactions until they reloaded.
  //
  // Public groups go to the whole workspace (anyone may open one, so anyone may
  // be showing its state); private groups and DMs go to their members' user
  // rooms. Null when a private group has no members to notify — `io.to([])`
  // would broadcast to EVERY socket, not none.
  const groupAudience = (groupId: string, rooms = memberRooms(groupId)) => {
    if (store.isPublicGroup(groupId)) return io;
    return rooms.length ? io.to(rooms) : null;
  };

  // --- Web Push (Phase 6) ----------------------------------------------------
  const pushReady = !!(
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
  );
  if (pushReady) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
  }

  // Should this recipient get a push for a message in `groupId` right now?
  // E2EE means the server can't read content, so prefs are honored only for
  // what it CAN know: quiet hours, and group type (DM vs group). At level 1
  // ("DMs & mentions") it can't detect a mention in an encrypted group, so it
  // pushes DMs only. Level 0 = everything; level 2 = nothing.
  const wantsPush = (uid: string, isDm: boolean): boolean => {
    const prefs = (store.getProfile(uid).notif ?? { level: 1, dnd: true }) as {
      level?: number;
      dnd?: boolean;
    };
    const level = prefs.level ?? 1;
    if (level === 2) return false;
    if (prefs.dnd) {
      const h = new Date().getHours(); // server-local quiet hours 22:00–07:00
      if (h >= 22 || h < 7) return false;
    }
    if (level === 1 && !isDm) return false;
    return true;
  };

  // Fire-and-forget contentless pushes to a group's OFFLINE members (no live
  // socket). Payload carries only server-known routing metadata — never message
  // content (which the server can't decrypt).
  const maybePush = (groupId: string, senderId: string, senderName: string) => {
    if (!pushReady) return;
    void (async () => {
      const online = new Set(await presence.list());
      const isDm = store.isDm(groupId);
      const groupName = isDm ? undefined : store.getGroupName(groupId);
      const recipients = store
        .listMemberIds(groupId)
        .filter((id) => id !== senderId && !online.has(id) && wantsPush(id, isDm));
      const payload = JSON.stringify({
        type: "message",
        // Deep-link routing keys the service worker (public/sw.js) reads; kept
        // as channelId/channelName because sw.js is a separately-cached artifact
        // that isn't renamed in lockstep with this bundle.
        channelId: groupId,
        channelName: groupName,
        senderId,
        senderName,
      });
      for (const uid of recipients) {
        let subs: PushSub[] = [];
        try {
          subs = await listPushSubscriptions(uid);
        } catch {
          continue;
        }
        for (const sub of subs) {
          webpush
            .sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload)
            .catch((err: { statusCode?: number }) => {
              // 404/410 → the subscription is dead; prune it.
              if (err?.statusCode === 404 || err?.statusCode === 410) {
                void deletePushSubscription(sub.endpoint);
              }
            });
        }
      }
    })();
  };

  io.on("connection", (socket) => {
    const sd = socket.data as { userId: string; user: User };
    const userId = sd.userId;
    // `me` reflects the user's saved profile (display name); reassigned when
    // they edit it mid-session so new messages use the latest name.
    let me = store.applyProfile(sd.user, userId);
    console.log(`[ws] connect    ${socket.id} user=${userId}`);

    // Per-user room so we can notify a user (e.g. a new DM) on any of their
    // sockets even before they've joined the relevant group room.
    socket.join("user:" + userId);

    // This browser's E2EE device id, announced on every connect. Call signaling
    // is addressed per DEVICE (`device:<id>`), never per user — see call:signal.
    socket.on("device:announce", ({ deviceId }) => {
      if (typeof deviceId !== "string" || !deviceId) return;
      socket.data.deviceId = deviceId;
      socket.join("device:" + deviceId);
    });

    // Short-lived TURN credentials for this session. Authenticated by virtue of
    // being on an authenticated socket — which is the whole point: the previous
    // shape shipped a static credential to every visitor inside the JS bundle.
    socket.on("ice:servers", async (ack) => {
      if (typeof ack !== "function") return;
      const { servers, ttl } = await iceServersFor();
      ack({ iceServers: servers, ttl });
    });

    // Replay a group's durable state to THIS socket: missed messages/replies
    // (from the read cursor) plus every stored sender-key envelope, so a member
    // who was offline can both see and decrypt what they missed — even if the
    // senders are now offline. Idempotent on the client (backfills only missing
    // messages; sender keys are stable).
    const replayGroup = async (groupId: string) => {
      try {
        const [messages, replies] = await Promise.all([
          store.fetchHistory(groupId, userId),
          store.fetchReplies(groupId, userId),
        ]);
        if (messages.length || replies.length) {
          socket.emit("history:replay", { groupId, messages, replies });
        }
        for (const { fromUserId, env } of store.fetchSenderKeys(groupId)) {
          socket.emit("group:senderKey", { groupId, fromUserId, env });
        }
        // Replay sealed read-cursors so "seen by" rehydrates after reconnect;
        // idempotent — the client merges the max readSeq per user.
        for (const { fromUserId, deviceId, env } of store.fetchReceipts(groupId)) {
          socket.emit("receipt:update", { groupId, fromUserId, deviceId, env });
        }
      } catch (e) {
        console.error("[ws] replay failed:", (e as Error).message);
      }
    };

    // Health check: echo the client's timestamp plus the server's.
    socket.on("echo", (payload, ack) => {
      if (typeof ack === "function") {
        ack({ t: payload.t, serverTime: Date.now() });
      }
    });

    // Authorization guard for room-scoped actions.
    const authorized = (groupId: string) => store.canAccess(groupId, userId);

    // Broadcast a group's updated meta/roster: to the whole workspace for
    // public groups (everyone can see them), else to each member individually.
    // Strip messages throughout — recipients keep their own viewer-correct
    // history; this only carries meta + roster.
    const emitGroupUpdated = (group: Group) => {
      if (group.type === "group" && !group.private) {
        io.emit("group:updated", { group: { ...group, messages: [] } });
        return;
      }
      // Private group or DM: every member, not just the sockets currently in the
      // room — and each gets its OWN view, since a DM's `name`/`user` are the
      // other participant and the client merges this over its roster entry.
      for (const memberId of store.listMemberIds(group.id)) {
        const view = store.getGroup(group.id, memberId) ?? group;
        io.to("user:" + memberId).emit("group:updated", {
          group: { ...view, messages: [] },
        });
      }
    };

    // The workspace (name + roster) is shared by everyone — broadcast to all.
    const emitWorkspace = () =>
      io.emit("workspace:updated", {
        name: store.getWorkspaceName(),
        members: store.listWorkspaceMembers(),
      });

    // Join a group's room, then replay durable history from Postgres to this
    // socket (backfills messages missed while offline / on a new device). The
    // client merges it into its local cache and decrypts locally.
    socket.on("group:join", ({ groupId }) => {
      if (!authorized(groupId)) return;
      socket.join(groupId);
      // Public-group access is implicit (anyone may read), but E2EE
      // sender-key distribution targets the *explicit* member roster. Record
      // the joiner as a member so they receive sender keys (and senders see the
      // roster change and re-key on their next message). Without this, viewers
      // of a public group who never created it only ever see 🔒.
      if (store.isPublicGroup(groupId) && store.addMember(groupId, userId)) {
        const group = store.getGroup(groupId, userId);
        if (group) emitGroupUpdated(group);
      }
      void replayGroup(groupId);
    });

    socket.on("group:leave", ({ groupId }) => {
      socket.leave(groupId);
    });

    // Construct + relay a top-level message, ack the sender (optimistic
    // reconcile), and broadcast it to everyone else in the room. The server
    // keeps no copy of the body.
    socket.on("message:send", ({ groupId, text, clientId, attachment, rich, enc }) => {
      const trimmed = (text || "").trim();
      // An encrypted message carries an `enc` envelope and empty text — still valid.
      if ((!trimmed && !attachment && !enc) || !authorized(groupId)) return;
      const message = store.addMessage(
        groupId,
        me,
        trimmed,
        clientId,
        attachment,
        rich,
        enc,
      );
      if (!message) return;
      // The sender has, by definition, read up to their own message.
      store.markRead(groupId, userId);
      socket.emit("message:ack", { clientId, message });
      // Deliver to every member (their user rooms), not just current viewers, so
      // members viewing another group still receive + store it. `socket.to`
      // excludes this socket (it already has the ack + optimistic render).
      socket.to(memberRooms(groupId)).emit("message:new", { groupId, message });
      bumpUnread(groupId);
      maybePush(groupId, userId, me.name);
    });

    // Mark a group read for this user (cursor jumps to its latest message).
    socket.on("group:read", ({ groupId }) => {
      if (!authorized(groupId)) return;
      store.markRead(groupId, userId);
    });

    // Update the viewer's profile. Re-derives `me` so subsequent messages use
    // the new display name, and echoes the saved profile back to their sockets.
    socket.on("profile:update", ({ patch }) => {
      const profile = store.setProfile(userId, patch);
      me = store.applyProfile(sd.user, userId);
      io.to("user:" + userId).emit("profile:updated", {
        profile,
        user: { ...me, avatar: profile.avatar },
      });
    });

    // Delete a message. The body lives only in clients' IndexedDB, so the
    // server just drops its metadata (reactions/pin) and relays the removal;
    // each client applies the tombstone locally. The client sends parentId
    // (it knows whether this was a thread reply) since the server has no copy.
    socket.on("message:delete", async ({ groupId, msgId, parentId }) => {
      if (!authorized(groupId)) return;
      // Author-only: the check runs inside the UPDATE (the server holds no
      // message copy) — a non-author's delete matches no row and is dropped.
      if (!(await store.deleteMessage(groupId, msgId, userId))) return;
      // To all members (incl. deleter — they have no optimistic tombstone) so
      // the removal applies for everyone who stored the message, not just
      // current viewers.
      io.to(memberRooms(groupId)).emit("message:deleted", {
        groupId,
        msgId,
        parentId: parentId ?? null,
      });
      groupAudience(groupId)?.emit("pins:updated", {
        groupId,
        pinIds: store.listPins(groupId),
      });
    });

    // Edit: the author re-encrypted the body; merge the new envelope into the
    // stored row (author-only, checked inside the UPDATE like delete) and relay
    // it to ALL members including the editor — their other devices decrypt it;
    // the editing device itself short-circuits via its local plaintext cache.
    socket.on("message:edit", async ({ groupId, msgId, enc }) => {
      if (!authorized(groupId)) return;
      if (typeof enc !== "string" || !enc) return;
      const editedTs = Date.now();
      const res = await store.editMessage(groupId, msgId, userId, enc, editedTs);
      if (!res.ok) return;
      io.to(memberRooms(groupId)).emit("message:edited", {
        groupId,
        msgId,
        parentId: res.parentId, // the stored row's parent wins over the client's claim
        enc,
        editedTs,
      });
    });

    // Thread reply: broadcast to the whole room (incl. sender) — no optimistic
    // render on the client, so a single broadcast keeps everyone consistent.
    socket.on("thread:reply", ({ groupId, parentId, text, rich }) => {
      const trimmed = (text || "").trim();
      if (!trimmed || !authorized(groupId)) return;
      const res = store.addThreadReply(groupId, parentId, me, trimmed, rich);
      if (!res) return;
      // Deliver to all members (incl. the sender — no optimistic render for
      // thread replies) so replies reach members not currently in the group.
      io.to(memberRooms(groupId)).emit("thread:new", {
        groupId,
        parentId,
        reply: res.reply,
        threadCount: res.threadCount,
        threadLastTime: res.threadLastTime,
      });
    });

    // Reaction toggle: the sender's reaction is recorded per-user; the
    // aggregated list (with reactor ids) is broadcast so each client derives
    // its own `mine`.
    socket.on("reaction:toggle", ({ groupId, msgId, emoji }) => {
      if (!authorized(groupId)) return;
      const reactions = store.toggleReaction(groupId, msgId, emoji, userId);
      if (reactions === null) return;
      groupAudience(groupId)?.emit("reaction:updated", { groupId, msgId, reactions });
    });

    // Compose a new 1:1 DM (or post into an existing one). Announces brand-new
    // DMs to everyone so they appear in sidebars, then posts the first message.
    socket.on("dm:create", ({ recipientId, text, clientId, enc }) => {
      const trimmed = (text || "").trim();
      const recipient = store.userByKey(recipientId);
      if ((!trimmed && !enc) || !recipient) return;
      // The DM id is derived from BOTH participants (no "dm-" prefix); the
      // group's `type: "dm"` is what distinguishes it from a group. Keying it
      // by the recipient alone merged every sender who messaged the same
      // person into one thread — see `dmIdFor`.
      const dmId = dmIdFor(userId, recipientId);
      const isNew = !store.groupExists(dmId);
      store.ensureDm(dmId, recipient);
      // Both participants are members of the DM.
      store.addMember(dmId, userId);
      store.addMember(dmId, recipientId);
      socket.join(dmId);
      const message = store.addMessage(dmId, me, trimmed, clientId, undefined, undefined, enc);
      if (!message) return;
      store.markRead(dmId, userId);
      socket.emit("message:ack", { clientId, message });
      if (isNew) {
        // Announce to both participants (any of their sockets), not the whole
        // workspace — DMs are private. A DM's meta is viewer-relative (`name`
        // and `user` are *the other person*), so each side gets its own view:
        // sending the creator's copy to the recipient made their sidebar entry
        // name themselves as the peer, and their client then sealed to their own
        // devices instead of the sender's.
        //
        // This MUST precede the message: `group:created` carries no bodies, and
        // a client drops message:new for a conversation it doesn't have yet — so
        // announcing afterwards left the recipient with an empty DM ("Say hi 👋"
        // in the sidebar) until they reloaded.
        for (const viewerId of new Set([userId, recipientId])) {
          const group = store.getGroup(dmId, viewerId);
          if (group) io.to("user:" + viewerId).emit("group:created", { group });
        }
      }
      // Deliver to both participants' user rooms (not just the DM room) so the
      // recipient receives it even while viewing another conversation.
      socket.to(memberRooms(dmId)).emit("message:new", { groupId: dmId, message });
      bumpUnread(dmId);
      maybePush(dmId, userId, me.name);
    });

    // Create a group. Public groups are announced to the whole workspace so
    // they appear in everyone's sidebar; private groups only to the creator.
    socket.on("group:create", ({ name, topic, private: isPrivate }, ack) => {
      const group = store.createGroup(name, {
        topic,
        private: isPrivate,
        creatorId: userId,
      });
      if (!group) {
        ack?.({ ok: false, error: "Enter a valid group name." });
        return;
      }
      socket.join(group.id);
      if (isPrivate) {
        io.to("user:" + userId).emit("group:created", { group });
      } else {
        io.emit("group:created", { group });
      }
      ack?.({ ok: true, groupId: group.id });
    });

    // Edit a group's name/topic.
    socket.on("group:update", ({ groupId, name, topic }, ack) => {
      if (!authorized(groupId)) {
        ack?.({ ok: false, error: "You can't edit this group." });
        return;
      }
      const group = store.updateGroup(groupId, { name, topic });
      if (!group) {
        ack?.({ ok: false, error: "Couldn't update the group." });
        return;
      }
      emitGroupUpdated(group);
      ack?.({ ok: true });
    });

    // Delete a group (not DMs). Announce removal to whoever could see it.
    socket.on("group:delete", ({ groupId }, ack) => {
      const group = authorized(groupId)
        ? store.getGroup(groupId, userId)
        : null;
      if (!group || group.type === "dm") {
        ack?.({ ok: false, error: "This group can't be deleted." });
        return;
      }
      const isPublic = !group.private;
      // Capture the roster BEFORE deleting — afterwards there are no members
      // left to address, and a private group's removal has to reach members who
      // aren't currently viewing it.
      const rooms = memberRooms(groupId);
      store.deleteGroup(groupId);
      if (isPublic) io.emit("group:deleted", { groupId });
      else groupAudience(groupId, rooms)?.emit("group:deleted", { groupId });
      ack?.({ ok: true });
    });

    // Add a member to a group.
    socket.on("group:addMember", ({ groupId, userId: memberId }, ack) => {
      if (!authorized(groupId)) {
        ack?.({ ok: false, error: "You can't manage this group." });
        return;
      }
      store.addMember(groupId, memberId);
      const group = store.getGroup(groupId, userId);
      if (group) {
        emitGroupUpdated(group);
        // A new private-group member needs the group surfaced for them
        // (messages stripped — they'll load fresh history when they open it).
        if (group.private) {
          io.to("user:" + memberId).emit("group:created", {
            group: { ...group, messages: [] },
          });
        }
      }
      ack?.({ ok: true });
    });

    // Remove a member from a group.
    socket.on("group:removeMember", ({ groupId, userId: memberId }, ack) => {
      if (!authorized(groupId)) {
        ack?.({ ok: false, error: "You can't manage this group." });
        return;
      }
      const wasPrivate = store.getGroup(groupId, userId)?.private;
      store.removeMember(groupId, memberId);
      const group = store.getGroup(groupId, userId);
      if (group) emitGroupUpdated(group);
      // A removed private-group member loses access — drop it from their UI.
      if (wasPrivate) {
        io.to("user:" + memberId).emit("group:deleted", { groupId });
      }
      ack?.({ ok: true });
    });

    // Workspace: rename + membership. Shared state, broadcast to everyone.
    socket.on("workspace:rename", ({ name }, ack) => {
      if (!store.setWorkspaceName(name)) {
        ack?.({ ok: false, error: "Enter a workspace name." });
        return;
      }
      emitWorkspace();
      ack?.({ ok: true });
    });
    socket.on("workspace:invite", ({ userId: memberId }, ack) => {
      store.addWorkspaceMember(memberId);
      emitWorkspace();
      ack?.({ ok: true });
    });
    socket.on("workspace:removeMember", ({ userId: memberId }, ack) => {
      store.removeWorkspaceMember(memberId);
      emitWorkspace();
      ack?.({ ok: true });
    });

    // Typing: ephemeral, broadcast to the room excluding the sender.
    socket.on("typing:start", ({ groupId }) => {
      socket.to(groupId).emit("typing:update", {
        groupId,
        userId,
        isTyping: true,
      });
    });
    socket.on("typing:stop", ({ groupId }) => {
      socket.to(groupId).emit("typing:update", {
        groupId,
        userId,
        isTyping: false,
      });
    });

    // Pin/unpin a message; broadcast the new pin list to the room.
    socket.on("pin:toggle", ({ groupId, msgId }) => {
      if (!authorized(groupId)) return;
      const pinIds = store.togglePin(groupId, msgId, userId);
      if (pinIds === null) return;
      groupAudience(groupId)?.emit("pins:updated", { groupId, pinIds });
    });

    // Chat color is a property of the CONVERSATION, not of the person who set
    // it: every member's bubbles follow it. Allowed for DMs too (group:update,
    // which only handles name/topic, refuses those).
    socket.on("group:setTheme", ({ groupId, theme }) => {
      if (!authorized(groupId)) return;
      if (theme !== null && !(theme in CHAT_GRADIENTS)) return;
      if (!store.setGroupTheme(groupId, theme)) return;
      const group = store.getGroup(groupId, userId);
      if (group) emitGroupUpdated(group);
    });

    // Unpin everything in one shot — the pinned bar's dismiss clears the bar for
    // the whole group, so it can't be a per-message loop that races itself.
    socket.on("pins:clear", ({ groupId }) => {
      if (!authorized(groupId)) return;
      const pinIds = store.clearPins(groupId);
      if (pinIds === null) return;
      groupAudience(groupId)?.emit("pins:updated", { groupId, pinIds });
    });

    // E2EE key distribution (Phase 0). The server is a public-key directory: it
    // stores bundles and hands out per-device prekey bundles, but never sees
    // private keys or plaintext. A device may only publish under its own user.
    socket.on("keys:publish", ({ bundle }) => {
      if (!bundle || bundle.userId !== userId) return;
      keyStore.publish(bundle);
      console.log(`[e2ee] published keys user=${userId} device=${bundle.deviceId}`);
    });
    // Replenishment: append fresh one-time prekeys to the caller's OWN device
    // (keeps forward secrecy alive once the initial pool is consumed).
    socket.on("keys:supplement", ({ deviceId, oneTimePreKeys }) => {
      if (!deviceId || !Array.isArray(oneTimePreKeys) || !oneTimePreKeys.length) return;
      keyStore.addOneTimePreKeys(userId, deviceId, oneTimePreKeys);
    });
    socket.on("keys:fetch", ({ userId: target }, ack) => {
      if (typeof ack === "function") ack({ bundles: keyStore.fetchBundles(target) });
    });
    // Group (sender-keys): return every device bundle of every group member so
    // a sender can wrap its sender key for each. Members with no published keys
    // (e.g. seeded bots) simply contribute nothing.
    socket.on("keys:fetchGroup", ({ groupId }, ack) => {
      if (typeof ack !== "function") return;
      if (!authorized(groupId)) return ack({ bundles: [] });
      const bundles = store
        .listMemberIds(groupId)
        .flatMap((id) => keyStore.fetchBundles(id));
      ack({ bundles });
    });
    // Relay a sender-key distribution (opaque pairwise-encrypted envelope) to the
    // rest of the group room. The server cannot read it.
    socket.on("group:senderKey", ({ groupId, sender, env }) => {
      if (!authorized(groupId)) return;
      // Persist the opaque envelope so a member who is offline now can fetch it
      // on reconnect — without this sender having to be online to answer a pull.
      if (sender) store.persistSenderKey(groupId, sender, userId, env);
      // To member rooms (not just the group room) so a member who received an
      // encrypted message while viewing elsewhere can still get the key.
      socket
        .to(memberRooms(groupId))
        .emit("group:senderKey", { groupId, fromUserId: userId, env });
    });
    // E2EE read receipt: the sealed read-cursor is opaque. Persist the latest
    // per (group, user, device) and relay to the group's member rooms so
    // "seen by" updates live. deviceId comes from the client (public directory
    // data; the server can't read the env to derive it).
    socket.on("receipt:update", ({ groupId, deviceId, env }) => {
      if (!authorized(groupId)) return;
      if (!deviceId || typeof env !== "string" || !env) return;
      store.persistReceipt(groupId, userId, deviceId, env);
      socket
        .to(memberRooms(groupId))
        .emit("receipt:update", { groupId, fromUserId: userId, deviceId, env });
    });

    // Pull-on-miss: relay a key request to the group's members (by their user
    // rooms, so the asked-for sender hears it even if not currently in the
    // group room). Only the matching sender device responds with a fresh key.
    socket.on("group:senderKey:request", ({ groupId, sender }) => {
      if (!authorized(groupId)) return;
      const rooms = store.listMemberIds(groupId).map((id) => "user:" + id);
      if (rooms.length) {
        socket
          .to(rooms)
          .emit("group:senderKey:request", { groupId, sender, fromUserId: userId });
      }
    });

    // Device-to-device recovery — relay ONLY between this user's own devices
    // (`socket.to("user:"+userId)` excludes the sender and never crosses users).
    // Payloads stay opaque: the request carries just a device id + fingerprint,
    // and the offer's env is sealed to the requesting device.
    socket.on("recovery:request", ({ deviceId, fingerprint }) => {
      socket.to("user:" + userId).emit("recovery:request", { deviceId, fingerprint });
    });
    socket.on("recovery:offer", ({ toDeviceId, env }) => {
      socket.to("user:" + userId).emit("recovery:offer", { fromDeviceId: toDeviceId, env });
    });

    // DM self-heal: relay a reheal request to the DM peer's devices AND the
    // requester's own OTHER devices (either may hold the plaintext). Opaque
    // relay — the responder authorizes (re-encrypts only to a genuine DM
    // participant), so routing by the client-claimed peerId can't leak: an
    // unrelated user's device won't recognize the requester as a DM party.
    socket.on("dm:reheal:request", ({ groupId, msgId, peerId }) => {
      if (!msgId || !peerId) return;
      const relay = { groupId, msgId, fromUserId: userId };
      socket.to("user:" + peerId).emit("dm:reheal:request", relay);
      socket.to("user:" + userId).emit("dm:reheal:request", relay); // own other devices
    });
    socket.on("dm:reheal:offer", ({ groupId, msgId, toUserId, enc }) => {
      if (!toUserId || typeof enc !== "string" || !enc) return;
      socket.to("user:" + toUserId).emit("dm:reheal:offer", { groupId, msgId, enc });
    });

    // Calls — roster + signaling relay only. SDP/ICE blobs stay opaque and the
    // media is a peer-to-peer mesh (DTLS-SRTP), so it never touches the server.
    //
    // A call IS a socket room, `call:<groupId>:<callId>`: the room is the
    // participant list, `fetchSockets` on it is adapter-aware (correct across
    // nodes behind the Redis adapter), the groupId is recoverable from the name,
    // and a crashed participant leaves it automatically. That leaves NO per-call
    // server state to keep consistent — every rule below is derived from the
    // group's roster or the room's current occupancy.
    //
    // `call:start` and `call:join` are the server-validated steps (they create
    // UI out of nothing); everything after is dropped client-side for callIds a
    // client doesn't recognize.
    const callRoom = (groupId: string, callId: string) =>
      `call:${groupId}:${callId}`;

    // Who may be rung: the members who are ONLINE right now, provided they'd all
    // fit in the call. Ringing is about reaching people who can actually answer,
    // and a roster is a poor proxy for that — a 40-person group with three
    // people online is, for the purposes of a call, a three-person group.
    //
    // The cap still does the load-bearing work. It bounds a ring to at most the
    // voice cap, so "everyone rung can get in" stays true and no group, however
    // large, can be turned into a notification cannon. Note this is NOT much of
    // a new capability for an attacker: a stranger can already ring you one to
    // one by opening a DM, so the ceiling here is an amplification of something
    // already possible, not a new door.
    const ringEligible = (online: string[]) =>
      online.length > 0 && online.length <= CALL_RING_MAX - 1;

    /** Small enough to tell every member's devices directly rather than only
     *  whoever has the conversation open. About fanout cost, not about ringing. */
    const compactGroup = (groupId: string) =>
      store.listMemberIds(groupId).length <= CALL_RING_MAX;
    // Video needs the whole group to fit under the video cap, so a call can
    // never grow past it mid-session and degrade someone already talking.
    // Video follows presence too: offered when everyone who could answer right
    // now would fit under the video cap (starter + up to 3).
    //
    // That loses the structural guarantee the roster gave us — the group could
    // no longer outgrow the cap, so nothing had to be counted — because people
    // who were offline at start time can come online, see the banner and join.
    // The cap is therefore enforced at JOIN instead, which needs one fact the
    // room can't answer: whether this call is a video call. That fact rides in
    // the callId rather than a server-side map, so the "no per-call state to
    // keep consistent across nodes" property survives intact.
    const videoEligible = (online: string[]) => online.length <= CALL_MAX_VIDEO - 1;
    const VIDEO_CALL = "v-";
    const newCallId = (video: boolean) => (video ? VIDEO_CALL : "") + randomUUID();
    const isVideoCall = (callId: string) => callId.startsWith(VIDEO_CALL);
    /** How many people this call can hold, given what it carries. */
    const capacityOf = (callId: string) =>
      isVideoCall(callId) ? CALL_MAX_VIDEO : CALL_MAX_VOICE;

    // Conversation-level liveness for the "Ongoing call · Join" affordance. For
    // ring-eligible groups (≤6 members) every member's own room gets it, so a
    // declined ring can still be joined later; for a huddle it goes to the group
    // room only — whoever has the conversation open — rather than fanning out to
    // a 500-member roster.
    const notifyCallLive = (
      groupId: string,
      payload: { callId: string; video: boolean; starterId: string },
    ) => {
      if (compactGroup(groupId)) {
        for (const id of store.listMemberIds(groupId)) {
          io.to("user:" + id).emit("call:ongoing", { groupId, ...payload });
        }
      } else {
        io.to(groupId).emit("call:ongoing", { groupId, ...payload });
      }
    };
    const notifyCallOver = (groupId: string, callId: string) => {
      if (compactGroup(groupId)) {
        for (const id of store.listMemberIds(groupId)) {
          io.to("user:" + id).emit("call:over", { groupId, callId });
        }
      } else {
        io.to(groupId).emit("call:over", { groupId, callId });
      }
    };

    socket.on("call:start", async ({ groupId, video }, ack) => {
      const reply = (r: Parameters<typeof ack>[0]) => {
        if (typeof ack === "function") ack(r);
      };
      // Membership, not `canAccess`: read access to a public group must not be
      // enough to place a call in it.
      if (typeof groupId !== "string" || !store.isMember(groupId, userId)) {
        return reply({ ok: false, reason: "unauthorized" });
      }
      const others = store.listMemberIds(groupId).filter((id) => id !== userId);
      // Adapter-aware, so this is the real answer across nodes rather than the
      // one this process happens to know.
      const presence = await Promise.all(
        others.map(async (id) => ((await io.in("user:" + id).fetchSockets()).length > 0 ? id : null)),
      );
      const online = presence.filter((id): id is string => id !== null);
      const effectiveVideo = !!video && videoEligible(online);
      const callId = newCallId(effectiveVideo);
      // A 1:1 call with nobody on the other end has failed; a GROUP call with
      // nobody online is a huddle you can legitimately sit in and wait.
      if (store.isDm(groupId) && online.length === 0) {
        return reply({ ok: false, reason: "offline" });
      }
      const ringing = ringEligible(online);
      socket.join(callRoom(groupId, callId));
      if (ringing) {
        // Only the people who can pick up. Ringing a device that isn't there
        // achieves nothing, and counting them towards the cap would silence
        // calls in groups whose roster is mostly dormant.
        for (const id of online) {
          io.to("user:" + id).emit("call:invite", {
            callId,
            groupId,
            fromUserId: userId,
            video: effectiveVideo,
          });
        }
      }
      notifyCallLive(groupId, {
        callId,
        video: effectiveVideo,
        starterId: userId,
      });
      reply({ ok: true, callId, video: effectiveVideo, ringing });
    });

    socket.on("call:join", async ({ callId, groupId }, ack) => {
      const reply = (r: Parameters<typeof ack>[0]) => {
        if (typeof ack === "function") ack(r);
      };
      if (typeof callId !== "string" || !callId || typeof groupId !== "string") {
        return reply({ ok: false, reason: "error" });
      }
      if (!store.isMember(groupId, userId)) {
        return reply({ ok: false, reason: "unauthorized" });
      }
      const room = callRoom(groupId, callId);
      const present = await io.in(room).fetchSockets();
      if (present.length === 0) return reply({ ok: false, reason: "gone" });
      // One device per user per call, newest wins: two live devices would feed
      // back acoustically. ORDER IS THE GUARANTEE — the displaced device is out
      // of the room and its `call:left` is broadcast BEFORE this device is
      // announced, so incumbents never hold live legs to both and no audio is
      // ever negotiated for the second one.
      const displaced = present.filter((s) => s.data.userId === userId);
      for (const old of displaced) {
        old.leave(room);
        old.emit("call:kicked", { callId, reason: "joined_on_another_device" });
        io.to(room).emit("call:left", {
          callId,
          userId,
          deviceId: (old.data.deviceId as string | undefined) ?? "",
        });
      }
      const remaining = present.filter((s) => s.data.userId !== userId);
      if (remaining.length >= capacityOf(callId)) {
        // Counted, not just refused: "frequent cap rejections" is the agreed
        // trigger for building an SFU, and a trigger nobody can observe is not
        // a trigger (see docs/group-calls-plan.md).
        callCapRejections += 1;
        console.log(
          `[call] capacity reject group=${groupId} call=${callId} user=${userId} (total ${callCapRejections})`,
        );
        return reply({ ok: false, reason: "full" });
      }
      socket.join(room);
      const deviceId = (socket.data.deviceId as string | undefined) ?? "";
      socket.to(room).emit("call:joined", { callId, userId, deviceId });
      // This ring was handled here — stop our own other devices ringing.
      socket.to("user:" + userId).emit("call:handled", { callId });
      reply({
        ok: true,
        video: isVideoCall(callId),
        participants: remaining.map((s) => ({
          userId: s.data.userId as string,
          deviceId: (s.data.deviceId as string | undefined) ?? "",
        })),
      });
    });

    // Reclaim a seat after a websocket blip. Distinct from `call:join` in two
    // ways that matter: it does NOT displace the user's other devices (nobody
    // switched devices — the same one came back), and it tolerates a call it
    // was already part of.
    //
    // It DOES announce `call:joined`. If the grace period expired first, peers
    // tore our leg down and need to rebuild it; if it hadn't, they still hold a
    // live PeerConnection and the announcement costs one harmless
    // renegotiation. Making it unconditional keeps this correct across nodes,
    // where the node handling the reconnect may not be the one that saw the
    // drop and cannot know which case it is in.
    socket.on("call:rejoin", async ({ callId, groupId }, ack) => {
      const reply = (r: Parameters<typeof ack>[0]) => {
        if (typeof ack === "function") ack(r);
      };
      if (typeof callId !== "string" || !callId || typeof groupId !== "string") {
        return reply({ ok: false, reason: "error" });
      }
      if (!store.isMember(groupId, userId)) {
        return reply({ ok: false, reason: "unauthorized" });
      }
      const room = callRoom(groupId, callId);
      const present = (await io.in(room).fetchSockets()).filter((s) => s.id !== socket.id);
      const deviceId = (socket.data.deviceId as string | undefined) ?? "";
      const seat = heldSeatFor(room, userId, deviceId);
      // Nobody present AND nobody expected back: the call really did end while
      // we were away. If a seat is still held, an outage took everyone out at
      // once and we're simply the first one back.
      if (present.length === 0 && !seat) return reply({ ok: false, reason: "gone" });
      const others = present.filter((s) => s.data.userId !== userId);
      if (others.length >= capacityOf(callId)) {
        // Our seat was taken during the outage. Rare, and honest.
        callCapRejections += 1;
        return reply({ ok: false, reason: "full" });
      }
      if (seat) heldSeats.delete(seat); // reclaimed
      socket.join(room);
      socket.to(room).emit("call:joined", { callId, userId, deviceId });
      reply({
        ok: true,
        participants: others.map((s) => ({
          userId: s.data.userId as string,
          deviceId: (s.data.deviceId as string | undefined) ?? "",
        })),
      });
    });

    socket.on("call:decline", ({ callId, groupId, reason }) => {
      if (!callId || typeof groupId !== "string") return;
      io.to(callRoom(groupId, callId)).emit("call:declined", {
        callId,
        userId,
        reason: reason === "busy" ? "busy" : "declined",
      });
      socket.to("user:" + userId).emit("call:handled", { callId });
    });

    socket.on("call:leave", async ({ callId, groupId }) => {
      if (!callId || typeof groupId !== "string") return;
      const room = callRoom(groupId, callId);
      socket.leave(room);
      io.to(room).emit("call:left", {
        callId,
        userId,
        deviceId: (socket.data.deviceId as string | undefined) ?? "",
      });
      const left = await io.in(room).fetchSockets();
      // Someone mid-reconnect still counts as being on the call.
      if (left.length === 0 && !roomHasHeldSeat(room)) notifyCallOver(groupId, callId);
    });

    socket.on("call:signal", ({ callId, toDeviceId, data }) => {
      if (!callId || !toDeviceId) return;
      // SDP + one ICE candidate per event — 256 KiB is far above any real
      // payload; the cap just keeps the relay from being a byte cannon.
      if (typeof data !== "string" || !data || data.length > 256 * 1024) return;
      // Addressed to ONE device. Routing by user would deliver a peer's offer to
      // every device that person has online, which is unsound in a mesh: a
      // sibling device is also ringing, knows the callId, and would act on an
      // offer meant for its peer.
      socket.to("device:" + toDeviceId).emit("call:signal", {
        callId,
        fromUserId: userId,
        fromDeviceId: (socket.data.deviceId as string | undefined) ?? "",
        data,
      });
    });

    // SFU proxy. Authorization is the call room itself — `socket.rooms.has`
    // answers "is this user in this call" with no extra state, the same trick
    // the roster uses, and it is strictly stronger than group membership: a
    // member who never joined the call cannot pull anyone's media.
    //
    // Sessions are additionally bound to the socket that created them, because
    // `tracks/close` against someone else's session is exactly the abuse
    // Cloudflare's docs warn about. A client never gets to name a session it
    // did not open.
    const sfuSessions = new Set<string>();
    const sfuGuard = (
      groupId: unknown,
      callId: unknown,
      sessionId?: unknown,
    ): SfuFailure["reason"] | null => {
      // Authorization BEFORE configuration, deliberately: whether this
      // deployment has an SFU is not something an unauthorized caller should
      // be able to probe, and checking it first would also make the
      // authorization tests pass vacuously on a deployment without one.
      if (typeof groupId !== "string" || typeof callId !== "string") return "error";
      const room = callRoom(groupId, callId);
      // In the room, OR holding a seat in it. Room membership is per-CONNECTION,
      // so a websocket blip puts a participant outside it until `call:rejoin`
      // lands — and unlike the mesh, whose signaling is fire-and-forget, every
      // SFU step is a request that would be refused in that window and leave the
      // call with no media. A held seat means "was a participant moments ago and
      // is expected back", which is the same claim the room makes, minus the
      // dependency on one TCP connection surviving.
      const deviceId = (socket.data.deviceId as string | undefined) ?? "";
      if (!socket.rooms.has(room) && !heldSeatFor(room, userId, deviceId)) {
        return "unauthorized";
      }
      if (sessionId !== undefined) {
        if (typeof sessionId !== "string" || !sfuSessions.has(sessionId)) {
          return "unauthorized";
        }
      }
      if (!SFU_APP_ID || !SFU_APP_TOKEN) return "unconfigured";
      return null;
    };

    socket.on("sfu:session", async ({ groupId, callId }, ack) => {
      if (typeof ack !== "function") return;
      const bad = sfuGuard(groupId, callId);
      if (bad) return ack({ ok: false, reason: bad });
      try {
        const res = await sfuFetch<{ sessionId: string }>("/sessions/new", "POST");
        sfuSessions.add(res.sessionId);
        ack({ ok: true, sessionId: res.sessionId });
      } catch (e) {
        console.warn("[sfu] session failed:", (e as Error).message);
        ack({ ok: false, reason: "error" });
      }
    });

    // Both halves of the SFU go through here: `location: "local"` publishes our
    // own tracks, `location: "remote"` subscribes to a peer's. The SDP stays
    // opaque to us, exactly like call:signal.
    socket.on("sfu:tracks", async ({ groupId, callId, sessionId, body }, ack) => {
      if (typeof ack !== "function") return;
      const bad = sfuGuard(groupId, callId, sessionId);
      if (bad) return ack({ ok: false, reason: bad });
      try {
        const res = await sfuFetch<Record<string, unknown>>(
          `/sessions/${sessionId}/tracks/new`,
          "POST",
          body,
        );
        ack({ ok: true, result: res });
      } catch (e) {
        console.warn("[sfu] tracks failed:", (e as Error).message);
        ack({ ok: false, reason: "error" });
      }
    });

    socket.on("sfu:renegotiate", async ({ groupId, callId, sessionId, body }, ack) => {
      if (typeof ack !== "function") return;
      const bad = sfuGuard(groupId, callId, sessionId);
      if (bad) return ack({ ok: false, reason: bad });
      try {
        await sfuFetch(`/sessions/${sessionId}/renegotiate`, "PUT", body);
        ack({ ok: true });
      } catch (e) {
        console.warn("[sfu] renegotiate failed:", (e as Error).message);
        ack({ ok: false, reason: "error" });
      }
    });

    socket.on("sfu:close", async ({ groupId, callId, sessionId, body }, ack) => {
      const bad = sfuGuard(groupId, callId, sessionId);
      if (bad) {
        if (typeof ack === "function") ack({ ok: false, reason: bad });
        return;
      }
      try {
        await sfuFetch(`/sessions/${sessionId}/tracks/close`, "PUT", body);
        if (typeof ack === "function") ack({ ok: true });
      } catch (e) {
        console.warn("[sfu] close failed:", (e as Error).message);
        if (typeof ack === "function") ack({ ok: false, reason: "error" });
      }
    });

    // MLS delivery service (Phase 4, feature-flagged) — the server ORDERS
    // commits per group (single-accept-per-epoch), queues Welcomes, and serves
    // catch-up. Payloads stay opaque; see server/mls-ds.ts.
    socket.on("mls:publishKeyPackage", ({ deviceId, keyPackage }) => {
      if (typeof deviceId !== "string" || !deviceId) return;
      mlsDs.publishKeyPackage(userId, deviceId, keyPackage);
    });
    // Every member's per-device packages (including the REQUESTER's other
    // devices — they're group leaves too) plus the authoritative member-user
    // roster, so a committer can diff group leaves against real membership.
    socket.on("mls:fetchGroup", async ({ groupId }, ack) => {
      if (typeof ack !== "function") return;
      if (!authorized(groupId)) return ack({ packages: [], memberIds: [] });
      const memberIds = store.listMemberIds(groupId);
      const packages: { userId: string; deviceId: string; keyPackage: string }[] = [];
      for (const id of memberIds) {
        for (const p of await mlsDs.fetchKeyPackages(id)) {
          packages.push({ userId: id, deviceId: p.deviceId, keyPackage: p.keyPackage });
        }
      }
      ack({ packages, memberIds });
    });
    socket.on("mls:commit", async ({ groupId, fromEpoch, commit, welcomes }, ack) => {
      const reply = (r: Parameters<typeof ack>[0]) => {
        if (typeof ack === "function") ack(r);
      };
      if (!authorized(groupId)) return reply({ ok: false, reason: "error", currentEpoch: 0 });
      const res = await mlsDs.submitCommit({ groupId, senderUser: userId, fromEpoch, commit });
      if (!res.ok) return reply(res);
      // Accepted: fan the commit out to members in order, and deliver Welcomes
      // (live to online targets + queued so offline members get them on connect).
      socket.to(memberRooms(groupId)).emit("mls:commit", { groupId, seq: res.seq, commit });
      for (const w of welcomes ?? []) {
        if (!w.toUserId || !w.toDeviceId) continue;
        mlsDs.queueWelcome(groupId, w.toUserId, w.toDeviceId, w.welcome, res.seq);
        socket.to("user:" + w.toUserId).emit("mls:welcome", {
          groupId,
          welcome: w.welcome,
          seq: res.seq,
          toDeviceId: w.toDeviceId,
        });
      }
      reply(res);
    });
    socket.on("mls:fetchCommits", async ({ groupId, sinceSeq }, ack) => {
      if (typeof ack !== "function") return;
      if (!authorized(groupId)) return ack({ commits: [] });
      ack({ commits: await mlsDs.commitsSince(groupId, sinceSeq) });
    });
    socket.on("mls:drainWelcomes", async ({ deviceId }, ack) => {
      if (typeof ack !== "function") return;
      if (typeof deviceId !== "string" || !deviceId) return ack({ welcomes: [] });
      ack({ welcomes: await mlsDs.drainWelcomes(userId, deviceId) });
    });

    // Passphrase-encrypted key backup. The server stores an opaque blob for the
    // authenticated user only — it can't decrypt it (no passphrase). Releasing
    // it is gated by the unlock vault below: backup:get returns only the KDF
    // params; backup:unlock compares a PIN-derived proof (kcv) with a guess
    // counter + lockout before handing the ciphertext over. This turns PIN
    // guessing by a stolen-session attacker into rate-limited online attempts.
    socket.on("backup:put", async ({ blob, kcv }, ack) => {
      const reply = (r: {
        ok: boolean;
        updatedAt: string | null;
        error?: string;
      }) => {
        if (typeof ack === "function") ack(r);
      };
      if (!blob) {
        reply({ ok: false, updatedAt: null, error: "Empty backup" });
        return;
      }
      try {
        const { rows } = await getPool().query(
          `INSERT INTO key_backup (user_id, blob, kcv, attempts, locked_until, updated_at)
           VALUES ($1,$2,$3,0,NULL,now())
           ON CONFLICT (user_id) DO UPDATE
             SET blob=EXCLUDED.blob, kcv=EXCLUDED.kcv, attempts=0,
                 locked_until=NULL, updated_at=now()
           RETURNING updated_at`,
          [userId, JSON.stringify(blob), typeof kcv === "string" ? kcv : null],
        );
        reply({
          ok: true,
          updatedAt: new Date(rows[0].updated_at).toISOString(),
        });
      } catch (e) {
        const msg = (e as Error).message;
        console.error("[backup] put failed:", msg);
        reply({ ok: false, updatedAt: null, error: "Server could not save backup" });
      }
    });
    socket.on("backup:get", async (ack) => {
      if (typeof ack !== "function") return;
      const none = { updatedAt: null, salt: null, iters: null };
      try {
        const { rows } = await getPool().query(
          "SELECT blob, kcv, updated_at FROM key_backup WHERE user_id=$1",
          [userId],
        );
        if (!rows.length) return ack(none);
        const blob = rows[0].blob as { salt?: string; iters?: number };
        const updatedAt = new Date(rows[0].updated_at).toISOString();
        // Pre-vault rows have no kcv to verify against — return the blob
        // directly (old behavior) so existing backups keep restoring; the next
        // backup:put upgrades them to the vault.
        if (!rows[0].kcv) {
          return ack({ updatedAt, salt: null, iters: null, legacyBlob: rows[0].blob });
        }
        ack({ updatedAt, salt: blob.salt ?? null, iters: blob.iters ?? null });
      } catch {
        ack(none);
      }
    });
    socket.on("backup:unlock", async ({ kcv }, ack) => {
      if (typeof ack !== "function") return;
      const MAX_ATTEMPTS = 10;
      const LOCK_MS = 15 * 60 * 1000;
      try {
        if (typeof kcv !== "string" || !kcv) {
          return ack({ ok: false, error: "Missing unlock proof" });
        }
        const { rows } = await getPool().query(
          "SELECT blob, kcv, attempts, locked_until FROM key_backup WHERE user_id=$1",
          [userId],
        );
        if (!rows.length || !rows[0].kcv) {
          return ack({ ok: false, error: "No backup found" });
        }
        const lockedUntil = rows[0].locked_until
          ? new Date(rows[0].locked_until).getTime()
          : 0;
        if (lockedUntil > Date.now()) {
          const lockedForSec = Math.ceil((lockedUntil - Date.now()) / 1000);
          return ack({
            ok: false,
            error: `Too many attempts. Try again in ${Math.ceil(lockedForSec / 60)} min.`,
            lockedForSec,
          });
        }
        const a = Buffer.from(String(rows[0].kcv));
        const b = Buffer.from(kcv);
        const match = a.length === b.length && timingSafeEqual(a, b);
        if (!match) {
          const attempts = Number(rows[0].attempts) + 1;
          const lock = attempts >= MAX_ATTEMPTS;
          await getPool().query(
            `UPDATE key_backup SET attempts=$2,
               locked_until=${lock ? "now() + interval '15 minutes'" : "NULL"}
             WHERE user_id=$1`,
            [userId, lock ? MAX_ATTEMPTS - 1 : attempts], // after a lockout expires, grant one attempt before re-locking
          );
          const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
          return ack(
            lock
              ? {
                  ok: false,
                  error: "Too many attempts. Try again in 15 min.",
                  lockedForSec: LOCK_MS / 1000,
                }
              : {
                  ok: false,
                  error: `Incorrect PIN — ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
                  remainingAttempts: remaining,
                },
          );
        }
        await getPool().query(
          "UPDATE key_backup SET attempts=0, locked_until=NULL WHERE user_id=$1",
          [userId],
        );
        ack({ ok: true, blob: rows[0].blob });
      } catch (e) {
        console.error("[backup] unlock failed:", (e as Error).message);
        ack({ ok: false, error: "Server could not unlock backup" });
      }
    });
    socket.on("backup:delete", async (ack) => {
      const reply = (r: { ok: boolean; error?: string }) => {
        if (typeof ack === "function") ack(r);
      };
      try {
        // The history store is only recoverable through the blob's storage key,
        // so deleting the backup also drops the (now-unreachable) history rows.
        await getPool().query("DELETE FROM key_backup WHERE user_id=$1", [userId]);
        await getPool().query("DELETE FROM user_history WHERE user_id=$1", [userId]);
        reply({ ok: true });
      } catch (e) {
        console.error("[backup] delete failed:", (e as Error).message);
        reply({ ok: false, error: "Server could not delete backup" });
      }
    });

    // Continuous encrypted history store: opaque per-user rows encrypted under
    // the client-held storage key (see crypto/backup.ts). Upsert-by-msg_id so
    // edits/tombstones written later simply replace the row.
    socket.on("history:append", async ({ rows }) => {
      if (!Array.isArray(rows) || !rows.length) return;
      const batch = rows
        .filter(
          (r) =>
            r &&
            typeof r.msgId === "string" &&
            typeof r.iv === "string" &&
            typeof r.ct === "string",
        )
        .slice(0, 200); // bound one append's write amplification
      if (!batch.length) return;
      try {
        // One multi-row upsert per append.
        const values: string[] = [];
        const params: string[] = [userId];
        batch.forEach((r, i) => {
          const base = i * 3;
          values.push(`($1,$${base + 2},$${base + 3},$${base + 4},now())`);
          params.push(r.msgId, r.iv, r.ct);
        });
        await getPool().query(
          `INSERT INTO user_history (user_id, msg_id, iv, ct, updated_at)
           VALUES ${values.join(",")}
           ON CONFLICT (user_id, msg_id)
           DO UPDATE SET iv=EXCLUDED.iv, ct=EXCLUDED.ct, updated_at=now()`,
          params,
        );
      } catch (e) {
        console.error("[history] append failed:", (e as Error).message);
      }
    });

    // Page through this user's encrypted history rows (restore on a new
    // device). msg_id is time-sortable, so id-cursor paging is stable.
    socket.on("history:fetchMine", async ({ afterMsgId }, ack) => {
      if (typeof ack !== "function") return;
      const PAGE = 500;
      try {
        const { rows } = await getPool().query(
          afterMsgId
            ? `SELECT msg_id, iv, ct FROM user_history
               WHERE user_id=$1 AND msg_id > $2 ORDER BY msg_id ASC LIMIT $3`
            : `SELECT msg_id, iv, ct FROM user_history
               WHERE user_id=$1 ORDER BY msg_id ASC LIMIT $2`,
          afterMsgId ? [userId, afterMsgId, PAGE] : [userId, PAGE],
        );
        const out = rows.map((r) => ({ msgId: r.msg_id, iv: r.iv, ct: r.ct }));
        ack({
          rows: out,
          nextCursor: out.length === PAGE ? out[out.length - 1].msgId : null,
        });
      } catch (e) {
        console.error("[history] fetch failed:", (e as Error).message);
        ack({ rows: [], nextCursor: null });
      }
    });

    // Leaving a call by crashing or closing the tab must eventually look like
    // leaving it normally — but NOT immediately, because a dropped websocket is
    // usually a blip, not a departure (see CALL_DROP_GRACE_MS). `disconnecting`
    // still has the socket's rooms, so the call rooms are recoverable here (in
    // `disconnect` they're already gone).
    socket.on("disconnecting", () => {
      const goneDeviceId = (socket.data.deviceId as string | undefined) ?? "";
      for (const room of socket.rooms) {
        if (!room.startsWith("call:")) continue;
        const rest = room.slice("call:".length);
        const cut = rest.lastIndexOf(":");
        if (cut <= 0) continue;
        const groupId = rest.slice(0, cut);
        const callId = rest.slice(cut + 1);
        heldSeats.set(seatKey(room, goneDeviceId), {
          userId,
          expiresAt: Date.now() + CALL_DROP_GRACE_MS,
        });
        setTimeout(() => {
          void (async () => {
            heldSeats.delete(seatKey(room, goneDeviceId));
            const present = await io.in(room).fetchSockets();
            const back = present.some(
              (s) =>
                s.data.userId === userId &&
                ((s.data.deviceId as string | undefined) ?? "") === goneDeviceId,
            );
            if (back) return; // reconnected in time — nobody else ever knew
            io.to(room).emit("call:left", { callId, userId, deviceId: goneDeviceId });
            // Only truly over once nobody is present AND nobody is expected.
            if (present.length === 0 && !roomHasHeldSeat(room)) {
              notifyCallOver(groupId, callId);
            }
          })();
        }, CALL_DROP_GRACE_MS);
      }
    });

    socket.on("disconnect", async (reason) => {
      console.log(`[ws] disconnect ${socket.id} (${reason})`);
      const last = await presence.disconnect(userId);
      if (last) {
        io.emit("presence:update", { userId, status: "offline" });
      }
    });

    // Startup (after handlers are registered): mark online, replay the current
    // presence roster, and send this user's authorized group/DM list.
    void (async () => {
      // A signed-in user is a member of the workspace. Idempotent — adds them
      // to the roster on first connect so it reflects real users.
      const addedToWorkspace = store.addWorkspaceMember(userId);
      // Auto-join the default groups so a new user lands in shared, populated
      // groups as an explicit member (visibility + E2EE membership). Announce
      // each newly-joined group's roster to its room so existing senders
      // re-key for the new member on their next message.
      for (const id of store.joinDefaultGroups(userId)) {
        const group = store.getGroup(id, userId);
        if (group) emitGroupUpdated(group);
      }
      // Roster first — it carries each group's presence, so the
      // presence:update events below must come *after* to take effect.
      socket.emit("groups:list", {
        groups: store.listGroupsForUser(userId),
      });
      socket.emit("workspace:updated", {
        name: store.getWorkspaceName(),
        members: store.listWorkspaceMembers(),
      });
      // If this user is newly in the roster, let everyone else's sidebar know.
      if (addedToWorkspace) socket.broadcast.emit("workspace:updated", {
        name: store.getWorkspaceName(),
        members: store.listWorkspaceMembers(),
      });
      // Baseline read cursors (first connect = caught up), then send unread.
      store.initUserReads(userId);
      socket.emit("unread:state", { counts: store.unreadState(userId) });
      // Catch-up: replay missed messages + sender keys for ALL the user's
      // groups (not just the one they open), so an offline gap is recovered
      // everywhere. Runs once per connect; the client backfills only what's
      // missing. The active group is also replayed via its group:join.
      void (async () => {
        for (const ch of store.listGroupsForUser(userId)) {
          await replayGroup(ch.id);
        }
      })();
      const prof0 = store.getProfile(userId);
      socket.emit("profile:updated", {
        profile: prof0,
        user: { ...me, avatar: prof0.avatar },
      });
      if (await presence.connect(userId)) {
        io.emit("presence:update", { userId, status: "active" });
      }
      for (const id of await presence.list()) {
        socket.emit("presence:update", { userId: id, status: "active" });
      }
    })();
  });

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port} (ws attached)`);
  });
});
