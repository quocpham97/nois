// Custom Next.js server that also hosts the Socket.IO WebSocket server in the
// same process. A long-running Node process is required because persistent
// WebSocket connections can't live in serverless route handlers.
//
// Run with `npm run dev` / `npm start` (both invoke tsx server.ts).
// Phase A: connection lifecycle + an `echo` health-check round-trip only.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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
  CallEndReason,
  ClientToServerEvents,
  ServerToClientEvents,
} from "./src/lib/socket-events";
import { type Group, type User, deriveUser } from "./src/lib/chat-data";
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
    // public groups (everyone can see them), or to its room for private ones.
    const emitGroupUpdated = (group: Group) => {
      const target =
        group.type === "group" && !group.private ? io : io.to(group.id);
      // Strip messages — recipients keep their own viewer-correct history; this
      // only carries meta + roster.
      target.emit("group:updated", { group: { ...group, messages: [] } });
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
      io.to(groupId).emit("pins:updated", {
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
      io.to(groupId).emit("reaction:updated", { groupId, msgId, reactions });
    });

    // Compose a new 1:1 DM (or post into an existing one). Announces brand-new
    // DMs to everyone so they appear in sidebars, then posts the first message.
    socket.on("dm:create", ({ recipientId, text, clientId, enc }) => {
      const trimmed = (text || "").trim();
      const recipient = store.userByKey(recipientId);
      if ((!trimmed && !enc) || !recipient) return;
      // The DM id is the recipient's bare key (no "dm-" prefix); the group's
      // `type: "dm"` is what distinguishes it from a group.
      const dmId = recipientId;
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
      // Deliver to both participants' user rooms (not just the DM room) so the
      // recipient receives it even while viewing another conversation.
      socket.to(memberRooms(dmId)).emit("message:new", { groupId: dmId, message });
      bumpUnread(dmId);
      maybePush(dmId, userId, me.name);
      if (isNew) {
        const group = store.getGroup(dmId, userId);
        // Announce to both participants (any of their sockets), not the whole
        // workspace — DMs are private.
        if (group) {
          io.to("user:" + userId)
            .to("user:" + recipientId)
            .emit("group:created", { group });
        }
      }
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
      store.deleteGroup(groupId);
      if (isPublic) io.emit("group:deleted", { groupId });
      else io.to(groupId).emit("group:deleted", { groupId });
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
      io.to(groupId).emit("pins:updated", { groupId, pinIds });
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

    // 1:1 calls — signaling relay only. SDP/ICE blobs stay opaque and the
    // media itself is peer-to-peer (DTLS-SRTP), so it never touches the
    // server. The INVITE is the one server-validated step: the group must
    // be a DM the caller belongs to, and the callee is derived from the DM
    // roster (never client-claimed), so a call can only ring an actual DM
    // counterpart. Everything after routes by callId + toUserId and is
    // dropped client-side for unknown callIds.
    socket.on("call:invite", async ({ callId, groupId, video }, ack) => {
      const reply = (r: Parameters<typeof ack>[0]) => {
        if (typeof ack === "function") ack(r);
      };
      if (typeof callId !== "string" || !callId) {
        return reply({ ok: false, reason: "error" });
      }
      if (!store.isDm(groupId) || !authorized(groupId)) {
        return reply({ ok: false, reason: "unauthorized" });
      }
      const peerId = store
        .listMemberIds(groupId)
        .find((id) => id !== userId);
      if (!peerId) return reply({ ok: false, reason: "error" });
      // Adapter-aware online check (works across nodes with the Redis
      // adapter) so the caller gets instant "unavailable" feedback instead of
      // ringing an empty room.
      const peerSockets = await io.in("user:" + peerId).fetchSockets();
      if (peerSockets.length === 0) return reply({ ok: false, reason: "offline" });
      socket.to("user:" + peerId).emit("call:invite", {
        callId,
        groupId,
        fromUserId: userId,
        video: !!video,
      });
      reply({ ok: true });
    });
    socket.on("call:answer", ({ callId, toUserId, accept }) => {
      if (!callId || !toUserId) return;
      socket.to("user:" + toUserId).emit("call:answer", {
        callId,
        fromUserId: userId,
        accept: !!accept,
      });
      // The invite rang on ALL of the answerer's devices — tell their OWN
      // other devices it was handled here so they stop ringing.
      socket.to("user:" + userId).emit("call:end", {
        callId,
        fromUserId: userId,
        reason: "handled",
      });
    });
    const CALL_END_REASONS: CallEndReason[] = [
      "ended",
      "cancelled",
      "busy",
      "timeout",
      "handled",
    ];
    socket.on("call:end", ({ callId, toUserId, reason }) => {
      if (!callId || !toUserId) return;
      socket.to("user:" + toUserId).emit("call:end", {
        callId,
        fromUserId: userId,
        reason: CALL_END_REASONS.includes(reason) ? reason : "ended",
      });
    });
    socket.on("call:signal", ({ callId, toUserId, data }) => {
      if (!callId || !toUserId) return;
      // SDP + one ICE candidate per event — 256 KiB is far above any real
      // payload; the cap just keeps the relay from being a byte cannon.
      if (typeof data !== "string" || !data || data.length > 256 * 1024) return;
      socket.to("user:" + toUserId).emit("call:signal", {
        callId,
        fromUserId: userId,
        data,
      });
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
