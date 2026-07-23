# Plan: Real-time backend with WebSockets

_Created 2026-06-15 · Product Owner plan_

## Context & starting point

`chat-app` is currently **client-only with in-memory mock data**:

- All groups/messages live in React state, seeded from `seedGroups()`
  (`src/lib/chat-data.ts`). Sending appends to local state and resets on refresh.
- Other users never reply; the typing indicator is a `setInterval` toggle and
  "Seen" is hardcoded.
- Identity is hardcoded as `users.alex` ("Alex Rivera").

Goal: introduce a **server that owns conversation state** and pushes changes to
all connected clients in real time over WebSockets, so two browsers see each
other's messages, reactions, presence, and typing live.

## Recommended stack (defaults — see "Open decisions")

- **Socket.IO** (server + client) — gives rooms (one per group/DM), automatic
  reconnection with backoff, heartbeats, and an event API that maps cleanly to
  chat. Raw `ws` would mean hand-rolling all of that.
- **Custom Next.js server** (`server.ts`) that creates the HTTP server, attaches
  Socket.IO, and delegates HTTP to the Next handler — single process on port
  4000. Serverless can't hold persistent connections, so a long-running Node
  process is required. (Standalone WS service is the alternative for prod scale.)
- **Persistence:** phase in — start with an authoritative **in-memory store** on
  the server (seeded from `seedGroups()`), then move to **SQLite**
  (`better-sqlite3`) for durability. Postgres + Redis adapter when scaling to
  multiple nodes.
- **Identity:** mock identity now (userId passed in the socket handshake), real
  auth later.

## Event protocol (the contract)

**Client → server**
- `group:join { groupId }` → server replies with history
- `group:leave { groupId }`
- `message:send { groupId, text, clientId }`
- `thread:reply { groupId, parentId, text, clientId }`
- `reaction:toggle { groupId, msgId, emoji }`
- `dm:create { recipientId, text, clientId }`
- `typing:start | typing:stop { groupId }`

**Server → client**
- `history { groupId, messages }`
- `message:new { groupId, message }`
- `message:ack { clientId, message }` (replace optimistic temp with canonical)
- `reaction:updated { groupId, msgId, reactions }`
- `group:created { group }`
- `presence:update { userId, status }`
- `typing:update { groupId, userId, isTyping }`

**Optimistic send:** client renders immediately with a temp id + `pending` flag;
server echoes `message:ack` to swap in the canonical id/time; on timeout/failure
mark `failed` with a retry affordance.

## Epics & phases

- **A — Transport foundation:** custom server + Socket.IO; client `SocketProvider`
  with connect/disconnect/reconnect lifecycle + a connection-status indicator;
  echo round-trip health check.
- **B — Server as source of truth (messages):** server-side store seeded from
  chat-data, room-per-group; `group:join` returns history; `message:send`
  validates, stamps canonical id/time, broadcasts `message:new`. Rewire client
  send to optimistic emit + ack reconcile.
- **C — Threads, reactions, DMs over the wire:** broadcast/merge thread replies
  and reactions; `dm:create` (server creates the DM, joins both users,
  broadcasts `group:created`) — integrates the existing Compose feature.
- **D — Presence & typing:** connection-based presence tracking + broadcast
  (replaces static `presence`); debounced typing events (replaces the fake
  `setInterval` indicator).
- **E — Persistence:** swap in SQLite for groups/messages/reactions with
  migrations + seed; history pagination (load older on scroll).
- **F — Auth & scale (later):** real identity (session/JWT) in the handshake +
  group authorization (private groups, DMs); Redis adapter for multi-node
  Socket.IO; sticky-session / horizontal-scale notes.

**Cross-cutting:** reconnection & missed-message catch-up (cursor by last
message id/time), error handling/backpressure, env config, tests.

## Acceptance criteria (story-level)

- Two browser sessions in the same group see each other's messages within ~1s.
- Sent messages appear instantly (optimistic) and reconcile to a server id; a
  failed send is visibly marked and retryable.
- Reactions and thread replies sync across sessions.
- Composing a DM creates a server-side conversation both participants receive.
- Presence dots and the typing indicator reflect real connected users.
- A client that drops and reconnects re-joins its rooms and catches up on
  messages it missed.
- (Phase E) Messages survive a server restart.

## Open decisions (recommended default first)

1. **WS library:** Socket.IO (recommended) vs raw `ws`.
2. **Server topology:** custom Next single-process server (recommended for dev)
   vs standalone WS service.
3. **Persistence:** in-memory → SQLite (recommended) vs straight to Postgres.
4. **Auth:** mock identity now, real auth later (recommended) vs real auth now.
