# Deploy & scale (#15 — scale strand)

_Created 2026-06-15_

The auth + authorization strands are implemented and verified on a single node.
This documents the multi-node scale strand. **Note on verification:** this
environment has no Redis, Postgres, or Docker, so the scale path is shipped as
correct, env-gated code (verified not to disturb the single-node path) plus the
artifacts below — it has **not** been run multi-node here.

## What's implemented in code

- **Redis adapter (env-gated).** `server.ts` enables `@socket.io/redis-adapter`
  when `REDIS_URL` is set (two Redis clients: pub + sub). Without it, the app
  uses the in-memory adapter (single-node) — the default verified here.
- **Redis-backed presence (env-gated).** Presence is a Redis hash
  (`HINCRBY`/`HDEL`) when `REDIS_URL` is set, so a user shows online if connected
  to *any* node and offline only when their last socket on any node drops.
  Falls back to the in-memory `Map` otherwise. (The adapter relays the
  `presence:update` broadcasts across nodes.)

## What's documented, not coded (and why)

- **Postgres store.** `deploy/schema.postgres.sql` is the Postgres DDL, ported
  1:1 from the SQLite schema (JSONB blobs + the same indexes, including the
  `client_id` idempotency key). The runtime store stays on `better-sqlite3`
  because it is **synchronous**; `pg` is **asynchronous**, so adopting it means
  converting every `store.*` function to async and awaiting it in `server.ts`.
  That refactor can't be verified without a Postgres instance and would risk the
  working, verified SQLite path — so it's deliberately left as a documented
  migration rather than an untested rewrite.

## Sticky sessions

Required **only** if HTTP long-polling is enabled (the polling handshake spans
multiple requests that must hit the same node). This app can force
WebSocket-only transport (`io(url, { transports: ["websocket"] })` client-side
and matching server config), which removes the need for session affinity. If you
keep the long-polling fallback, configure the LB for affinity (nginx `ip_hash`,
or ALB/HAProxy cookie routing).

## Deployment topology

WebSockets need a long-running process, so deploy on a **Node platform**
(Docker/Railway/Render/Fly/VM) — **not Vercel/serverless**.

```
            ┌── app (node) ──┐
client ── LB ┼── app (node) ──┼── Redis (adapter + presence)
            └── app (node) ──┘── Postgres (persistence)
```

`deploy/docker-compose.yml` sketches this: Redis, Postgres (auto-loads the
schema), 3 app replicas, and an nginx front. Set `AUTH_SECRET`, `AUTH_URL`,
`REDIS_URL`, `DATABASE_URL` in the environment.

## Env vars

| Var | Purpose | Absent ⇒ |
|---|---|---|
| `AUTH_SECRET` | Auth.js session signing/encryption | required |
| `AUTH_URL`, `AUTH_TRUST_HOST` | Auth.js base URL for the custom port | login redirects break |
| `REDIS_URL` | Enables Redis adapter + Redis presence | single-node in-memory |
| `DATABASE_URL` | Postgres store (after the async migration) | local SQLite (`chat.db`) |

## Remaining to be production-multi-node

1. Convert `store.ts` to the async Postgres backend (schema ready).
2. Stand up Redis + Postgres + LB (compose provided) and load-test broadcast
   across nodes.
3. Force WebSocket-only transport (or configure LB sticky sessions).
