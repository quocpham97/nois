# Research: #15 — Real auth + multi-node scale (Redis adapter)

_Created 2026-06-15 · Research & design (not yet implemented)_

This is the deferred "later" task. It has three independent strands — **authentication**,
**authorization**, and **horizontal scale** — plus a follow-up (**group-list sync**)
that auth naturally subsumes. Each is grounded in the code we built in Phases A–E.

## Where the code is today (the gaps)

- **Identity is spoofable.** `SocketProvider` sends `auth: { userId }` resolved from
  `?as=<key>` (default `alex`); the server trusts it verbatim (`server.ts`
  `socket.handshake.auth?.userId`). Anyone can connect as anyone.
- **No authorization.** `group:join` accepts *any* `groupId` that exists
  (`store.groupExists`). Private groups (`launch-q3`) and other people's DMs are
  joinable by any client. `message:send` / `reaction:toggle` / `thread:reply` aren't
  membership-checked either.
- **State is per-process.** Rooms live in one Socket.IO instance; presence is an
  in-memory `online` Map in `server.ts`. A second node wouldn't share broadcasts or
  presence. SQLite (`chat.db`) is a single local file — also single-node.
- **`self` / reaction `mine` are per-mock-identity**, not genuinely per-user.

---

## Part A — Real authentication

**Pattern (verified):** a Socket.IO handshake middleware `io.use((socket, next) => …)`
runs once per connection. Read the credential, verify it, attach the user to
`socket.data.user`, then `next()` — or `next(new Error("unauthorized"))` to reject.

**Credential transport — two options:**

| Option | How it reaches the handshake | Notes |
|---|---|---|
| **httpOnly session cookie** (recommended) | Cookies are sent automatically on the Engine.IO handshake (same-origin custom server). | No token handling in client JS; not readable by XSS. Pairs with a normal Next.js login route / Auth.js (NextAuth). |
| **JWT in `auth.token`** | Client sets `io({ auth: { token } })`; server reads `socket.handshake.auth.token`. | Explicit; avoid the query-string variant (intermediaries log URLs). Good if auth is already token-based. |

**Recommendation:** since this is a Next.js custom server on one origin, use an
**httpOnly session cookie** issued by a real login flow (Auth.js/NextAuth is the
lowest-friction fit), verified in the Socket.IO middleware. Replace the `?as=` mock
and `store.userById(mockId)` with `socket.data.user` derived from the verified session.

**Touch points:** `socket-context.tsx` (drop `?as=`, rely on cookie), `server.ts`
(add `io.use` auth middleware; derive author from `socket.data.user`), a login
page + session issuance, and a `users` table (replace the seeded `users` map).

---

## Part B — Authorization & per-user correctness

**Membership model:** add a `group_members(group_id, user_id, role)` table. Then
authorize every room-scoped action against it:

- `group:join` / `history:more` → must be a member (reject otherwise). Closes the
  private-group and DM leakage.
- `message:send` / `thread:reply` / `reaction:toggle` → must be a member; ignore the
  client-sent author entirely and use `socket.data.user`.
- `dm:create` → both participants become members of the DM group.

**Per-user reactions:** the current single `mine` flag on a reaction is viewer-relative
and only correct for one identity. Replace with a `message_reactions(message_id,
user_id, emoji)` table; compute counts and the viewer's `mine` per request. This
finally makes reactions correct across real users (the limitation flagged in Phase C/D).

**`self`:** already computed viewer-relative on the client (`withSelf`); once identity
is real, it's correct for free.

---

## Part C — Horizontal scale (Redis adapter)

**Why it's needed:** with >1 node, the in-memory adapter only broadcasts to clients on
the *same* node. A cross-node pub/sub layer is required so a message on node A reaches
a subscriber on node B.

**Official adapter options (verified against socket.io/docs/v4/adapter):**

| Package | Best for |
|---|---|
| **`@socket.io/redis-adapter`** (recommended) | Standard multi-node pub/sub via Redis. Needs two Redis clients (pub + sub). |
| `@socket.io/redis-streams-adapter` | Redis Streams variant (at-least-once delivery semantics). |
| `@socket.io/cluster-adapter` | Multiple processes on a *single* machine (Node `cluster`). |
| `@socket.io/postgres-adapter`, `@socket.io/mongo-adapter` | Reuse an existing Postgres/Mongo instead of adding Redis. |
| GCP Pub/Sub, AWS SQS, Azure Service Bus | Cloud-native messaging backends. |

**Recommendation:** `@socket.io/redis-adapter` for true multi-node; `cluster-adapter`
if scaling is only multi-core on one box.

**Two gotchas the adapter does *not* solve (must handle explicitly):**

1. **Presence.** Our `online` Map is per-process. The adapter broadcasts events but
   doesn't share presence *state*. Move presence to **Redis** (e.g. a per-user
   connection counter / set) so a user shows online if connected to *any* node, and
   flips offline only when their last socket on any node drops. Alternatively derive it
   from the adapter's `io.fetchSockets()` (cross-node), but a Redis counter is simpler.
2. **Persistence.** Single-file SQLite is single-node. Multi-node needs a shared DB —
   migrate `store.ts` to **Postgres** (or hosted SQLite like Turso/libSQL). The store's
   JSON-blob-plus-indexed-columns schema ports cleanly.

**Sticky sessions (verified):** required only while **HTTP long-polling** is enabled,
because the polling handshake spans multiple HTTP requests that must hit the same node.
Configure session affinity at the load balancer (nginx `ip_hash`, or ALB/HAProxy
cookie routing). **If you force WebSocket-only transport, sticky sessions aren't
needed** — a reasonable simplification for a modern client.

**Complementary:** Socket.IO's built-in **Connection State Recovery** restores rooms +
missed packets after a short disconnect and works alongside the adapter — overlaps with
our Phase #14 resend/catch-up and could replace part of it.

**Deployment reality (verified):** WebSockets need a long-running process, so this stays
on a **Node platform** (Docker on Railway/Render/Fly/VM) — **not Vercel/serverless**.
That was already true for our custom server; scale just adds Redis + a shared DB + a
load balancer.

---

## Part D — Group-list sync (folds in here)

The deferred follow-up: the client still seeds its group/DM list from
`seedGroups()` locally, so a persisted new DM doesn't reappear after restart. With
auth + membership, the server can send each client **its authorized roster** on connect
(`groups:list`), and the client builds the sidebar from that instead of the seed.
This both fixes the restart gap and enforces authorization on what's even listed.

---

## Suggested sequencing (if implemented)

1. **Auth foundation** — login flow + session, `users` table, `io.use` verification,
   author from `socket.data.user`, drop `?as=`.
2. **Authorization** — `group_members`, enforce on join/send/history; per-user
   `message_reactions`.
3. **Group-list sync** — server-driven roster on connect (depends on 1–2).
4. **Shared persistence** — migrate SQLite → Postgres.
5. **Redis adapter + Redis presence** — multi-node broadcast + cross-node presence.
6. **Deploy** — Docker + Redis + Postgres + LB (WebSocket-only to skip sticky sessions,
   or configure affinity).

Strands are independent: auth/authorization (1–3) deliver security value on a single
node; scale (4–6) is only needed at real traffic.

## Open decisions

1. **Auth library:** Auth.js/NextAuth (recommended) vs. custom session/JWT.
2. **Credential transport:** httpOnly cookie (recommended) vs. JWT in `auth.token`.
3. **Scale backend:** `@socket.io/redis-adapter` (multi-node) vs. `cluster-adapter`
   (single machine) — drives whether Redis is needed at all.
4. **Shared DB:** Postgres vs. hosted SQLite (Turso/libSQL).
5. **Transport:** WebSocket-only (no sticky sessions) vs. keep long-polling fallback
   (needs LB affinity).

## Sources

- Socket.IO — Adapter (official): https://socket.io/docs/v4/adapter/
- Socket.IO — Scaling horizontally (tutorial step 9): https://socket.io/docs/v4/tutorial/step-9
- Socket.IO — Middlewares (handshake auth): https://socket.io/docs/v4/middlewares/
- Socket.IO — How to use with Next.js: https://socket.io/how-to/use-with-nextjs
- Ably — Scaling Socket.IO (challenges & strategies): https://ably.com/topic/scaling-socketio
- WebSocket.org — WebSockets with Next.js (SSR, App Router, Vercel): https://websocket.org/guides/frameworks/nextjs/
