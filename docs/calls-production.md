# Running calls in production — TURN and SFU

Short version:

- **TURN** is a real, required piece of configuration and it is **not** something
  the current Render deployment can host. Use a managed provider, or run coturn
  on a VM.
- **SFU**: there is nothing to configure. The app has no SFU and doesn't call one
  — media is a peer-to-peer mesh. Adopting one is a project, not a setting; the
  trigger and the shape of that work are at the bottom.

## TURN

### What the app reads today

`iceServers()` in `src/components/chat/call-context.tsx`:

```ts
[{ urls: "stun:stun.l.google.com:19302" }]                       // always
+ { urls: NEXT_PUBLIC_TURN_URL,                                   // if set
    username: NEXT_PUBLIC_TURN_USERNAME,
    credential: NEXT_PUBLIC_TURN_CREDENTIAL }
```

Two properties of that to know before you set anything:

1. **`NEXT_PUBLIC_*` is inlined at build time.** Next bakes these into the client
   bundle during `next build`, so setting them only in a running container does
   nothing — the value has to be present when the app is *built*. On Render,
   changing an env var triggers a redeploy (which rebuilds), so that works; if you
   ever build an image elsewhere and ship it, rebuild it.
2. **The credential is public.** It ships inside the JavaScript every visitor
   downloads. A long-lived coturn user/password there is an open relay for anyone
   who opens devtools, and TURN relays cost bandwidth. See
   [Server-minted credentials](#server-minted-credentials-required-for-cloudflare-recommended-for-everyone)
   — treat the static env vars as fine for a staging/private deploy and not for a
   public one.

### Why Render can't host coturn

TURN needs UDP ingress on 3478 plus a range of relay ports (and ideally a public
IPv4 of its own). Render's web services terminate HTTP/TCP for you and give you
no UDP listener or port range, so coturn can't run beside the app there. The app
stays on Render; TURN lives somewhere with real network access.

### Option A — managed TURN (recommended)

Surveyed August 2026. "Free" here means a standing free allowance, not a trial.

| Service | Free allowance | Credentials | TLS (`turns:`) on free | Works with the code as it stands |
| --- | --- | --- | --- | --- |
| **Cloudflare Realtime TURN** | **1,000 GB/mo** (shared with their SFU), then $0.05/GB | **Short-lived only**, minted server-side via REST | Yes — 5349 and **443** | **No** — needs the credential change below |
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

Endpoints: `turn.cloudflare.com` — 3478/udp, 3478/tcp, 5349/tcp (TLS),
443/tcp (TLS).

**The catch, and it is the deciding one:** Cloudflare issues **no static
credentials at all**. You hold a TURN key server-side and mint short-lived ICE
credentials per session:

```bash
curl https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers \
  --header "Authorization: Bearer $TURN_KEY_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"ttl": 86400}'
```

So the `NEXT_PUBLIC_TURN_*` variables cannot be used with it — the server-minted
credential flow below stops being optional hardening and becomes a prerequisite.
That work is the same either way, and it is the right shape regardless of
provider: nothing about TURN ends up in the client bundle.

**ExpressTURN is what this deployment currently uses** — static credentials in
the existing env vars, no code change, 1,000 GB/mo. Setup and measured limits are
in [Configured provider](#configured-provider-expressturn) below.

**Metered's Open Relay** is the quickest smoke test — it publishes a shared
static credential (`staticauth.openrelay.metered.ca`, secret
`openrelayprojectsecret`) that anyone can point at. Treat it as a dev tool: the
credential is public by design and the allowance is 20 GB/mo, which is a few
hours of relayed video.

### Configured provider: ExpressTURN

From the ExpressTURN dashboard (Free plan), copy the server, username and
password into the environment:

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

### Server-minted credentials (required for Cloudflare, recommended for everyone)

Cloudflare requires this; self-hosted coturn supports it via `use-auth-secret`;
every other provider above is better off with it. With coturn, the app server
derives credentials from the shared secret, valid for a window:

```
username   = <unix-expiry>:<userId>
credential = base64(HMAC_SHA1(static-auth-secret, username))
```

With Cloudflare the server calls their `generate-ice-servers` endpoint instead
and passes the result through unchanged. Either way the secret stays server-side
and a leaked credential expires on its own. **This needs a small code change** —
roughly:

- mint (coturn HMAC) or fetch (Cloudflare REST) the ICE servers in `server.ts`,
  from `TURN_STATIC_AUTH_SECRET` or `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`,
- return them with the existing `call:start` / `call:join` acks, or add a tiny
  `ice:servers` ack,
- have `iceServers()` use what the server sent instead of `NEXT_PUBLIC_*`,
  keeping the env vars as a fallback so self-hosted setups still work.

It is a contained change (~40 lines) and it also removes the build-time inlining
problem, since nothing about TURN would live in the bundle any more. Not done
yet — say the word.

### Verifying it actually works

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

### What adopting one would involve

Not configuration — a project:

- **A media server.** LiveKit (self-hosted or cloud) is the obvious candidate: it
  supports E2EE via insertable streams, which is the property that matters here.
  It needs its own TURN, so the work above is a prerequisite either way.
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
