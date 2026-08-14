# Running calls in production — TURN and SFU

Short version:

- **TURN** is a real, required piece of configuration and it is **not** something
  the current Render deployment can host. Use a managed provider, or run coturn
  on a VM.
- **SFU**: there is nothing to configure. The app has no SFU and doesn't call one
  — media is a peer-to-peer mesh. Adopting one is a project, not a setting; the
  trigger and the shape of that work are at the bottom.

## TURN and SFU solve different problems

Easy to conflate, so: **TURN is useful with or without an SFU, and an SFU needs
TURN too.**

| | TURN | SFU |
| --- | --- | --- |
| Problem | *Can these two peers reach each other at all?* | *How many streams must each participant upload?* |
| Without it | Calls between peers that can't connect directly **fail outright** | Calls still work, just capped (mesh uplink is N−1 streams) |
| Needed when | One side is behind symmetric NAT / CGNAT / a UDP-blocking firewall | Participant counts outgrow a mesh |
| Still needed with the other? | **Yes** — a client that can't reach the SFU directly relays to it | No — mesh works fine without one, up to the caps |

So configuring TURN without an SFU is exactly right, and it is doing real work
today: without it, any call where one side can't be reached directly simply never
connects. An SFU would not have helped those calls at all — it would still have
needed a relay to reach the blocked client.

What TURN does *not* change is the 6 voice / 4 video cap. That comes from every
participant uploading a stream per peer in a mesh, and only an SFU changes it.

If you want to know how much your TURN relay is actually earning its place, the
share of calls needing a relay depends entirely on your users' networks (mobile
and corporate are the heavy cases). Rather than trust a rule of thumb, read the
selected candidate pair's `candidateType` from `getStats()` on real calls — the
same field `scripts/turn-check.mts` asserts on — and count how often it's `relay`.

## TURN

### What the app reads today

There are two credential paths, and the client prefers the first:

1. **Server-minted (preferred).** The server holds a Cloudflare TURN key
   (`TURN_KEY_ID` + `TURN_KEY_API_TOKEN`), mints a short-lived credential, and
   hands it to authenticated clients over the socket (`ice:servers`). Nothing
   about TURN reaches the bundle, and a leaked credential expires on its own.
2. **Build-time fallback.** If the server has no key, `envIceServers()` in
   `src/components/chat/call-context.tsx` falls back to the `NEXT_PUBLIC_TURN_*`
   vars, which is how a static-credential provider (ExpressTURN, self-hosted
   coturn) is configured. STUN-only if those are unset too.

Two properties of the **fallback** path to know before you set those vars:

1. **`NEXT_PUBLIC_*` is inlined at build time.** Next bakes these into the client
   bundle during `next build`, so setting them only in a running container does
   nothing — the value has to be present when the app is *built*. On Render,
   changing an env var triggers a redeploy (which rebuilds), so that works; if you
   ever build an image elsewhere and ship it, rebuild it.
2. **The credential is public.** It ships inside the JavaScript every visitor
   downloads. A long-lived coturn user/password there is an open relay for anyone
   who opens devtools, and TURN relays cost bandwidth. Treat the static env vars
   as fine for a staging/private deploy and not for a public one.

Neither applies to the server-minted path: the key is read by the server process
only, so changing it takes effect on **restart**, with no rebuild.

### Why Render can't host coturn

TURN needs UDP ingress on 3478 plus a range of relay ports (and ideally a public
IPv4 of its own). Render's web services terminate HTTP/TCP for you and give you
no UDP listener or port range, so coturn can't run beside the app there. The app
stays on Render; TURN lives somewhere with real network access.

### Option A — managed TURN (recommended)

Surveyed August 2026. "Free" here means a standing free allowance, not a trial.

| Service | Free allowance | Credentials | TLS (`turns:`) on free | Works with the code as it stands |
| --- | --- | --- | --- | --- |
| **Cloudflare Realtime TURN** | **1,000 GB/mo** (shared with their SFU), then $0.05/GB | **Short-lived only**, minted server-side via REST | Yes — 5349 and **443** | **Yes** — this is the path the code now prefers |
| ExpressTURN | 1,000 GB/mo | Static user/password (shared-secret is premium) | **No** — TLS is premium ($9/mo) | Yes |
| Metered Open Relay | 20 GB/mo | API-issued, or a shared public static credential | Yes | Yes |
| Xirsys | Developer tier (allowance not published; check the dashboard) | Static | Yes | Yes |
| Turnix.io | 10 GB/mo | API-issued | Yes | Needs the credential change |

**Pick Cloudflare** unless you need something working in the next hour. 1,000 GB
of relayed traffic per month is far more than this app will plausibly use — a
relayed voice leg is ~27 MB/hour and a relayed 720p video leg ~675 MB/hour, and
only the legs that *can't* go peer-to-peer are relayed at all — so in practice
it's free rather than free-tier. Their STUN (`stun.cloudflare.com`) is free and
unlimited, TURN is free outright when paired with their SFU, and they offer TLS
on **443**, which is the port that gets through hotel and corporate networks.
Per-allocation rate limits are ~50–100 Mbps and 5–10 kpps, comfortably above our
6-participant cap.

Endpoints, as actually returned by the API (August 2026):
`stun.cloudflare.com` 3478 + 53, and `turn.cloudflare.com` over 3478/udp,
3478/tcp, 5349/tcp (TLS), 53/udp, 80/tcp and **443/tcp (TLS)**. The client uses
that list verbatim when credentials are minted, so it doesn't fall back to
Google's STUN at all on this path.

**The catch, and it is the deciding one:** Cloudflare issues **no static
credentials at all**. You hold a TURN key server-side and mint short-lived ICE
credentials per session:

```bash
curl https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers \
  --header "Authorization: Bearer $TURN_KEY_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"ttl": 86400}'
```

So the `NEXT_PUBLIC_TURN_*` variables cannot be used with it. **That code now
exists** — see [Server-minted
credentials](#server-minted-credentials-shipped) — so switching to Cloudflare is
two environment variables and a restart:

```bash
TURN_KEY_ID=<from the Cloudflare Realtime dashboard>
TURN_KEY_API_TOKEN=<from the same place>
```

Set those and the `NEXT_PUBLIC_TURN_*` vars stop being consulted at all. Note
the response nests its servers in an **array** under `iceServers` (two entries:
STUN-only, then TURN with credentials) — the server normalises a bare object too,
in case that ever changes.

### Configured provider: Cloudflare Realtime TURN

**Live since 2026-08-14.** Measured on this key:

| | |
| --- | --- |
| Mint (`generate-ice-servers`) | HTTP 201, ~6 URLs incl. `turns:443` |
| Relay-pinned call | works — `relay→srflx`, media flowing |
| **Relay ↔ relay** | **works** — the ExpressTURN limitation is closed |
| TLS on 443 | offered |

That relay-to-relay result is the whole reason for the move: a call where *both*
participants sit behind carrier-grade NAT now connects, where on ExpressTURN's
free tier it failed outright. `turn-check.mts` probes it and prints the verdict
either way.

**ExpressTURN is what this deployment used before that** — static credentials in
the env vars, 1,000 GB/mo. It remains supported as the fallback path, and its
setup and measured limits are in
[Fallback provider](#fallback-provider-expressturn) below.

**Metered's Open Relay** is the quickest smoke test — it publishes a shared
static credential (`staticauth.openrelay.metered.ca`, secret
`openrelayprojectsecret`) that anyone can point at. Treat it as a dev tool: the
credential is public by design and the allowance is 20 GB/mo, which is a few
hours of relayed video.

### Fallback provider: ExpressTURN

Used only when `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` are unset. From the
ExpressTURN dashboard (Free plan), copy the server, username and password into
the environment:

```bash
NEXT_PUBLIC_TURN_URL=turn:free.expressturn.com:3478
NEXT_PUBLIC_TURN_USERNAME=<from the dashboard>
NEXT_PUBLIC_TURN_CREDENTIAL=<from the dashboard>
```

Locally that goes in `.env.local` (gitignored) and needs a **dev server restart**;
on Render put the three keys in the dashboard (they're already declared in
`render.yaml` as `sync: false`), which triggers the rebuild that inlines them.

Verify with `npx tsx --env-file=.env.local scripts/turn-check.mts` — it pins one
peer to relay-only and checks its media genuinely traverses the relay. Measured
on this account (August 2026):

| | |
| --- | --- |
| UDP 3478 | works |
| TCP 3478 (`?transport=tcp`) | works |
| Ports 80 / 443 | **refuse connections**, despite being advertised |
| TLS (`turns:`) | premium only |
| Relay ↔ relay | **refused** — see below |

**The limitation that matters:** ExpressTURN's free tier will not relay between
two of its own allocations. A call where one side needs a relay and the other is
directly reachable works (verified: `relay→srflx`, media flowing). A call where
**both** sides need one — both participants behind carrier-grade NAT, which is
not rare on mobile networks — will fail. Self-hosted coturn and Cloudflare both
handle that case; `turn-check.mts` probes it and prints a note either way.

Transcribing credentials from the dashboard, mind that its font renders `l` and
`I` near-identically — a wrong character produces a plain `401 Unauthorized` with
no hint. `turn-check.mts` catches it.

### Option B — self-hosted coturn on a VM

Any small VM with a public IPv4 (Hetzner/DO/EC2, 1–2 vCPU is plenty to start).

`/etc/turnserver.conf`:

```conf
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
# The public address clients should reach. Behind a cloud NAT use PUBLIC/PRIVATE.
external-ip=203.0.113.10
realm=calls.example.com
server-name=calls.example.com
fingerprint

# Time-limited credentials (see below). The secret never leaves the server.
use-auth-secret
static-auth-secret=<64+ random chars>

# Keep the relay range tight and open exactly this in the firewall.
min-port=49160
max-port=49260

# turns: — browsers on corporate networks often only get out over 443/TLS.
cert=/etc/letsencrypt/live/calls.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/calls.example.com/privkey.pem

# Do not let the relay be used to reach your own network (SSRF via TURN).
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

user-quota=12
total-quota=1200
```

Firewall: `3478/udp`, `3478/tcp`, `5349/tcp`, and `49160-49260/udp`.

Then point the app at it:

```bash
NEXT_PUBLIC_TURN_URL=turns:calls.example.com:5349
NEXT_PUBLIC_TURN_USERNAME=…
NEXT_PUBLIC_TURN_CREDENTIAL=…
```

**Capacity.** TURN only relays the legs that can't go peer-to-peer, but a mesh
has many legs: an N-person call is N−1 streams per participant. Budget roughly
50–60 kbps per relayed voice leg and ~1.5 Mbps per relayed 720p video leg. A
fully-relayed 4-person video call is therefore ~9 Mbps each way through the
relay — the reason the video cap is 4 and the voice cap 6.

### Server-minted credentials (shipped)

**Done.** Cloudflare requires this; every other provider is better off with it.
The secret stays server-side and a leaked credential expires on its own.

How it works:

- `server.ts` fetches ICE servers from Cloudflare's `generate-ice-servers`
  endpoint using `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`, and caches the result per
  process until it nears expiry (`TURN_TTL_S`, default 3600s, refetched 5
  minutes ahead). One in-flight request is shared, so a reconnect storm is one
  upstream call, not hundreds.
- Clients ask over their **already authenticated socket** (`ice:servers`), which
  is the security gain: the credential is no longer readable by every visitor,
  only by a signed-in user.
- `call-context.tsx` resolves the credential **before** placing or joining a
  call, because an `RTCPeerConnection`'s ICE config is fixed at construction —
  arriving late would mean a peer built without TURN. It's fetched in parallel
  with the getUserMedia permission prompt, so a cold cache costs nothing
  perceptible, and it's warmed on connect anyway.
- `envIceServers()` remains the fallback whenever the server returns nothing, so
  ExpressTURN and self-hosted coturn setups keep working untouched.

**Degradation is deliberate.** A missing, expired or wrong key never fails a
call: the mint fails, the server logs `[turn] could not mint credentials: …`,
negative-caches for 30s so every call start doesn't re-pay the timeout, and the
client falls back. Verified against a bogus key — the log reads
`cloudflare turn 404 {"error":"cannot find specified key"}` and calls still
connect on the fallback path.

**Not implemented: the coturn HMAC path.** If you ever self-host, that's a
second minting function alongside the Cloudflare one, deriving from
`TURN_STATIC_AUTH_SECRET`:

```
username   = <unix-expiry>:<userId>
credential = base64(HMAC_SHA1(static-auth-secret, username))
```

Everything downstream of it — the `ice:servers` ack, the client cache, the
fallback — is already in place and provider-agnostic.

### Verifying it actually works in production

The failure that only happens in production depends on which path you're on. On
the **server-minted** path it's a bad or missing key: the app has no TURN and the
only evidence is `[turn] could not mint credentials: …` in the service log — check
there first. On the **fallback** path it's the build-time one: the env vars are
set in the dashboard but the bundle serving users was built before them. Both
look exactly like "TURN doesn't work".

**1. Is the deployed build carrying the TURN config?** Open the deployed app,
start a call, and open `chrome://webrtc-internals` in another tab. The peer
connection's entry prints the `RTCConfiguration` it was created with, including
the `iceServers` URLs. No `turn:` entry there means the client never got a
credential: on the server-minted path read the service log, on the fallback path
the deployment predates the env vars — redeploy. Either way, don't debug the
provider yet. A `turn.cloudflare.com` URL confirms the minted path is live.

**2. Does the provider work from a real user network?** The
[Trickle ICE page](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
with your production TURN URL and credentials must produce a candidate of type
`relay`. Do it from mobile data, not just your desk — the NATs that need TURN are
the ones you don't have at home. A `401` here means the credentials are wrong
(watch for `l` vs `I` when copying from a dashboard).

**3. Is the relay actually carrying media?** In `chrome://webrtc-internals`,
find the succeeded candidate pair and read its local `candidateType`. On a normal
network this will say `host` or `srflx` — that's correct and means TURN wasn't
needed, not that it's broken. To see it exercised, place a call from a network
that blocks UDP, or run the harness below.

**4. The automated version.** `scripts/turn-check.mts` accepts `--url`, pins one
peer to relay-only, places a real call and asserts the media went through the
relay:

```bash
AUTH_SECRET=<the deployment's> DATABASE_URL=<the deployment's> \
  npx tsx scripts/turn-check.mts --url=https://your-app.example.com
```

It mints its own session cookies, so it needs that environment's `AUTH_SECRET`
(and matches Auth.js's scheme-dependent cookie name and JWE salt automatically).
Two caveats: it **writes to that database** — two test users and a DM between
them — and cleanup needs `DATABASE_URL`, without which it warns and leaves the
rows behind. Prefer staging if you have one.

**5. Ongoing.** Count how often real calls end up on `relay` by reading the
selected pair's `candidateType` from `getStats()`. That number is the honest
measure of what TURN is doing for your users, and it also tells you when the
provider's limits (relay-to-relay, bandwidth) start to matter.

### Verifying it locally

1. **Trickle-ICE page** — <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>.
   Enter the `turns:` URL and credentials: you must see a candidate of type
   `relay`. If you only see `srflx`/`host`, the credential or the ports are wrong.
2. **Force relay in-app** — temporarily add `iceTransportPolicy: "relay"` to the
   `RTCPeerConnection` config in `call-context.tsx` and place a call. If it
   connects, TURN is genuinely carrying media; revert afterwards.
3. **Run the harness** — `npx tsx --env-file=.env.local scripts/turn-check.mts`
   does (2) and (3) for you: it pins one peer to `relay`, places a real call, and
   asserts the succeeded pair is a relay pair with RTP flowing. Point it at a
   deployed instance by changing `URL`. It also probes relay-to-relay and prints
   whether the provider supports it.

Do (1) from a phone on mobile data, not just your desk — the NATs that need TURN
are exactly the ones you don't have at home.

## SFU

**Nothing to configure.** Calls are a full mesh: every participant connects
directly to every other one, and no media server is involved. There is no SFU
endpoint, token, or setting anywhere in the codebase, and adding env vars would
not change that.

That was a deliberate decision — see
[group-calls-plan.md](./group-calls-plan.md#why-not-an-sfu-first). The short form:
mesh keeps media end-to-end encrypted by construction with no new trusted
component, where an SFU puts a server in the media path and keeping E2EE there
needs per-frame encryption (SFrame / insertable streams) whose WKWebView support
is too shaky to bet the iOS shell on.

### When to revisit

The server counts joins refused for being at capacity and logs them:

```
[call] capacity reject group=… call=… user=… (total N)
```

That counter is the agreed trigger. Rare rejections mean the caps fit how people
actually call; frequent ones mean the mesh is the wrong shape and an SFU is
worth its cost.

### The concrete path, if you want to build it

Two things make this cheaper than the original plan assumed, both learned after
that plan was written:

**This app already has the hard half.** Cloudflare's own E2EE calling app
([Orange Meets](https://blog.cloudflare.com/orange-me2eets-we-made-an-end-to-end-encrypted-video-calling-app-and-it-was/))
keeps media opaque to the SFU using **MLS for group key agreement** plus
per-frame encryption via WebRTC Encoded Transform — and MLS is already live here
for group messaging (`crypto/mls.ts`, ts-mls). The group's existing MLS state can
derive the per-call media key, so the part that would otherwise be a from-scratch
key-agreement design is done. Their frame-encryption layer is client-only and
open source, so it works against any SFU.

**Encoded Transform is no longer exotic.** `RTCRtpScriptTransform` reached
baseline browser availability in late 2025. The iOS shell is still the open
question — it has never been exercised on a device at all — but this is no longer
the "bet the feature on WKWebView" risk the plan described.

**Recommended target: Cloudflare Realtime SFU.** Same 1,000 GB/month free
allowance as their TURN (shared between the two), it forwards rather than
transcodes (which is what makes per-frame E2EE possible at all), and **TURN is
free when used with the SFU** — which also retires the ExpressTURN limitation
above, since Cloudflare relays between its own allocations.

Suggested phasing, keeping the app working throughout:

1. **Transport swap.** `call-context.tsx` publishes one stream and subscribes to
   N instead of maintaining `Map<deviceId, RTCPeerConnection>`. Everything around
   it survives untouched: the room protocol (`call:start`/`join`/`leave`), the
   ring-vs-huddle rule, device migration, the thread record. Ship it behind a
   flag with the mesh as fallback.
2. **Tokens.** The server mints SFU session tokens from the same `isMember`
   check `call:start` already does, so a room can't be joined by a non-member.
3. **E2EE.** Encoded Transform in a worker, keyed from the group's MLS exporter
   secret, re-keyed on join/leave. Until this lands, the SFU can see media — so
   it should stay behind the flag, not shipped to users.
4. **Raise the caps.** 6 voice / 4 video exist because a mesh uploads N−1
   streams; with an SFU each client uploads once and the limits become a product
   decision instead of a physics one.

Effort: phase 1 is comparable to the mesh work itself; phase 3 is the harder
half (codec header handling — VP8 keeps 1–10 unencrypted bytes — plus key
rotation and a fallback path for clients without Encoded Transform).

### What that means in practice

- **A media server.** Cloudflare Realtime (above) or LiveKit — LiveKit also
  supports E2EE via insertable streams and can be self-hosted, but its cloud free
  tier is metered in WebRTC minutes (5,000/month) rather than bandwidth. Either
  needs TURN, so that work is a prerequisite regardless.
- **Client rework.** `call-context.tsx` publishes one stream and subscribes to N
  instead of maintaining a `Map<deviceId, RTCPeerConnection>`. The room protocol
  (`call:start`/`join`/`leave`) survives; the media layer under it doesn't.
- **Tokens.** Access tokens minted server-side from the same membership check
  `call:start` already does, so the SFU can't be joined by non-members.
- **E2EE.** Per-frame encryption keyed off the group's existing key material,
  plus a decision about what to do on clients that can't do insertable streams.
- **Ops.** Capacity planning, region placement, monitoring — an SFU is a
  bandwidth-heavy stateful service, unlike everything else in this deployment.

Until that is built, the honest ceiling is 6 voice / 4 video per call.
