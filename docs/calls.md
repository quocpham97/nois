# Voice & video calls

Calls in DMs and groups. Media is a peer-to-peer WebRTC **mesh** (DTLS-SRTP) and
never touches the server; the server relays signaling blobs it can't read and
owns nothing but the participant roster. A finished call leaves a record in the
conversation.

A DM call is a mesh of one peer — there is a single engine, not a 1:1 path plus a
group path. The sizing rules below and the reasoning behind them are in
[group-calls-plan.md](./group-calls-plan.md).

| | |
| --- | --- |
| Client engine | `src/components/chat/call-context.tsx` (phases, roster, records) |
| Media transport | `src/components/chat/call-transport.ts` (`CallTransport`, `createMeshTransport`) |
| UI | `src/components/chat/call-view.tsx` (`CallUI`, mounted by both shells) |
| Thread record | `src/components/chat/message.tsx` (`CallEventRow`), `src/lib/chat-data.ts` (`CallEvent`) |
| Server relay | `server.ts`, the `call:*` handlers |
| Wire types | `src/lib/socket-events.ts` (`Call*Payload` / `Call*Relay`) |
| Tests | `scripts/call-harness.mts` (server rules), `scripts/call-event-harness.mts` (1:1 in two browsers), `scripts/group-call-harness.mts` (3-way mesh in three browsers) |

## Limits

| | |
| --- | --- |
| Participants | 6 voice, 4 video |
| Rings | private groups of ≤6 members (a DM is 2) |
| Huddle — no ring, joinable from the conversation | private groups of 7+, and **every** public group at any size |
| Video offered | only when the whole group is ≤4 members, so a call can't outgrow the cap mid-session and degrade someone already talking |
| Devices per user per call | 1 — a second device displaces the first |

## The call state machine

One call at a time per client. `CallInfo.phase` is the whole lifecycle:

```
        startCall()                  someone joins             media connects
outgoing ──────────► (ringing) ─────────────────────► connecting ──────────► active
                                                           ▲                    │
incoming ─────────────────────────►  acceptCall()  ─────────┘                    ▼
   ▲                                 joinOngoing()                          teardown()
   └── call:invite relay                    declineCall / timeout / hang-up ─────┘
```

`CallInfo.outgoing` is derived from `starterId === us` rather than from who
clicked, so a starter who migrates devices keeps ownership of the thread record.

Ringing lasts `RING_TIMEOUT_MS` (45s). Mic/camera toggles flip `track.enabled`,
so every peer's tracks are fixed at setup and **no renegotiation ever happens**.
Handlers read live state through `callRef`/`handlersRef` so the socket listeners
(registered once per socket) never close over stale state.

### The mesh

Media sits behind `CallTransport` (`call-transport.ts`), so the engine above it
— phases, roster, ring timeouts, device migration, the thread record — doesn't
know how media travels. The interface is five calls: `start`, `addPeer`,
`removePeer`, `handleSignal`, `close`.

The one implementation is `createMeshTransport`: one `RTCPeerConnection` per
remote **device**, keyed by deviceId. Exactly one side of each pair offers:
**whoever is already in the call offers to a joiner, and the joiner only ever
answers** — carried by the `offering` argument to `addPeer`. That single rule
keeps the mesh glare-free with no tie-breaking. A leg that fails is dropped on
its own (`onFailed`); the call ends only when the last peer goes.

The seam exists so an SFU can replace the mesh without disturbing the engine —
it would publish once in `start` and subscribe per device in `addPeer`. Why
that's deferred, and what it would cost, is in
[calls-production.md](./calls-production.md#the-concrete-path-if-you-want-to-build-it).

### Signaling

A call *is* a socket room, `call:<groupId>:<callId>`. The room is the roster, so
there is **no per-call server state** to keep consistent: `fetchSockets()` on it
is adapter-aware (correct across nodes behind the Redis adapter), the groupId is
recoverable from the room name, and a crashed participant leaves automatically.

| Event | Direction | Server does |
| --- | --- | --- |
| `call:start` | starter → server | **validates membership**, opens the room, rings if eligible, acks `{callId, video, ringing}` or `offline`/`unauthorized` |
| `call:invite` | server → members' devices | rings (ring-eligible groups only) |
| `call:join` | joiner → server | validates membership, refuses `full`/`gone`, displaces the joiner's own other device, acks the current roster |
| `call:joined` / `call:left` | server → the room | roster changes, per device |
| `call:decline` | invitee → server | relays `call:declined` into the room (`declined` or `busy`) |
| `call:handled` | server → the actor's other devices | this ring was handled here, stop |
| `call:kicked` | server → displaced device | the same user joined elsewhere |
| `call:ongoing` / `call:over` | server → conversation | drives the "Ongoing call · Join" bar |
| `call:signal` | device → device | relays blobs ≤256 KiB to `device:<toDeviceId>` |

`call:start` and `call:join` are the server-validated steps — they create UI out
of nothing — and both check **membership**, never `canAccess`: read access to a
public group must not be enough to place a call in it. The online check uses
`fetchSockets()` and fast-fails `offline` rather than ringing an empty room;
huddles skip it, since starting one alone and waiting for people is the point.
Everything after routes by `callId` and is dropped client-side for ids a client
doesn't recognize.

Signaling is addressed **per device**. Routing by user would deliver a peer's
offer to every device that person has online, which is unsound in a mesh: a
sibling device is also ringing, knows the `callId`, and would act on an offer
meant for its peer. Clients announce their device id on connect
(`device:announce` → a `device:<id>` room).

### The call surface

`call-view.tsx` follows the comp's `renderCallOverlay`: a full-screen overlay
(fade-in, radial backdrop that lifts once video is up), the conversation title,
self picture-in-picture at 150×200, and 58px translucent controls floating at the
bottom (hang-up bigger and red). An unanswered call pulses three expanding rings
behind the avatar; a connected voice call shows a small equalizer so silence still
looks live. Those three animations are CSS keyframes in `globals.css`
(`callIn`, `callRing`, `barsPulse`).

The comp only draws a 1:1 call, so the mesh **extends** that language rather than
replacing it: one peer keeps the comp's centred layout (their video full-bleed
when it's a video call), and two or more become a grid of 4:3 tiles with the same
rounded corners, name labels and backdrop. Every layout that shows a remote
participant marks itself `data-participant`/`data-connected`, so "who is on
screen" is answerable without knowing which layout is in play.

Two deliberate departures from the comp:

- **No speaker toggle.** The comp has one, but it's a mobile idiom — the web has
  no earpiece/speaker concept, only `setSinkId` device selection. A control that
  did nothing would be worse than its absence.
- **The overlay is modal.** The comp gives it `z-index: 300` over everything with
  no minimize, so a call takes the whole window and you can't read the
  conversation while you're in one. Worth revisiting with a design pass if
  multitasking during calls matters.

The incoming-call card is not from the comp (the mock has no incoming state) — it
stays a non-blocking card in the top-right so a ringing call doesn't seize the UI
before you've accepted it.

### Multi-device

An invite rings **every** device of the invitee; whichever one answers or declines
wins, and the rest get `call:handled`. A device already in a call auto-declines a
second invite as `busy`.

Joining from a second device **displaces** the first (`call:kicked`), because two
live devices for one user would feed back acoustically. The displacement is
ordered ahead of the new device's announcement — the old socket leaves the room
and its `call:left` is broadcast first — so incumbents never hold legs to both
devices and no audio is ever negotiated for the second one.
`scripts/call-harness.mts` asserts that ordering, not just the end state.

## The thread record

A finished call leaves one row in the conversation — the Messenger-style call
card, not a bubble.

**The starter writes it.** `recordCall` (call-context) hands the outcome to
`logCallEvent` (chat-context), which seals it into an ordinary E2EE message
carrying `MessageContent.call`. Starter-only is deliberate: everyone observes the
same hang-up, so letting each participant log its own row would multiply it. Going
through the message path — rather than generating a card locally the way the
comp's single-user mock does — means the row is persisted, reaches every device of
everyone in the conversation, and reaches someone who was offline when the call
came in.

In a group the row therefore describes the call **as the starter experienced it**:
they were present from `t0`, so duration and the peak participant count are exact,
but if they leave while others carry on, the row stops there. The alternative —
having the last participant out write it — needs the call's start time and peak
count to be shared state, which the room model deliberately doesn't have (a
node-local map would be wrong the moment participants land on different nodes
behind the Redis adapter).

Group rows carry `joined` (peak simultaneous participants → "4 on the call") and
render a "<Name> started a call" label above the card. A DM's "2 on the call" says
nothing, so it's omitted.

The server never learns what a DM call's row says: `call` rides inside the
envelope like `text`, so all it stores is ciphertext. For group calls it does know
the roster and duration, because it manages join/leave — see
[the privacy note](./group-calls-plan.md#the-thread-record), disclosed in
Settings → Privacy.

### Statuses

`CallEvent.status` is stored **from the caller's point of view**;
`callEventTitle(call, mine)` maps it to the viewer's wording.

| status | caller sees | callee sees | written when |
| --- | --- | --- | --- |
| `answered` | "Voice call" / "Video call" + talk time | same | media connected, then either side hung up |
| `declined` | "Call declined" / "Video call declined" | same | callee tapped Decline, their mic/camera failed, or they were **busy** |
| `unanswered` | "No answer" | "Missed voice call" / "Missed video call" | rang out (45s), or the caller cancelled first |

Two judgment calls worth knowing:

- **`busy` is a decline, not a no-answer.** The callee's client refused the
  invite and it never rang, so "No answer" would describe a 45-second ring that
  didn't happen — and would contradict the "X is on another call" the caller was
  just shown live.
- **An accepted call whose media never connected records as `unanswered`,** not
  as a 0:00 conversation. `answered` requires `startedAt`.

A call that never reached the peer at all (invite acked `offline`, or a transport
error) records **nothing** — nothing rang.

### Consequences elsewhere

- The row's `text` carries a readable rendering ("Missed voice call", "Voice call
  · 11:42"). That's what full-text search indexes, and what a client too old to
  know about `call` would render as a plain bubble.
- The conversation list previews it with no "You:" prefix (`previewOf`), so a
  caller's own row reads "No answer", not "You: No answer".
- `messageExcerpt` renders it as "📞 <title>" for quote/forward previews.
- Persistence is free: `message-db` stores the whole `Message` as JSON, so `call`
  survives reload and rides the encrypted history mirror.
- The card has no bubble affordances — no reactions, edit, or ⋯ menu. Tapping it
  redials the same kind of call (suppressed while another call is up).

## Configuration

Required in production: without a TURN relay, symmetric NATs never connect
(public STUN alone isn't enough). Two ways to supply one, and the client prefers
the first — full detail in [calls-production.md](./calls-production.md).

```bash
# Preferred: a Cloudflare Realtime TURN key. Read by the SERVER process only,
# which mints a short-lived credential per session and hands it to authenticated
# clients over the socket (`ice:servers`). Nothing reaches the client bundle.
TURN_KEY_ID=…
TURN_KEY_API_TOKEN=…
TURN_TTL_S=3600          # optional, default 3600

# Fallback, consulted only when the above are unset: a static-credential
# provider (ExpressTURN, self-hosted coturn). NEXT_PUBLIC_* is inlined at BUILD
# time and the credential is world-readable in the bundle.
NEXT_PUBLIC_TURN_URL=turns:turn.example.com:5349
NEXT_PUBLIC_TURN_USERNAME=…
NEXT_PUBLIC_TURN_CREDENTIAL=…
```

With neither set the ICE config is `stun:stun.l.google.com:19302` only. A
failed mint is never a failed call — it logs, negative-caches, and falls back.

Media capture needs platform permission plumbing, not just browser permission:

| Shell | Status |
| --- | --- |
| Browser | works (getUserMedia prompt) |
| Desktop (Electron) | works — `media` in `ALLOWED_PERMISSIONS` (`desktop/src/main.ts`), mic + camera entitlements in `desktop/build/entitlements.mac.plist`, usage strings in `desktop/electron-builder.yml` |
| iOS (Capacitor) | permission strings are in place (`NSMicrophoneUsageDescription`/`NSCameraUsageDescription` in `mobile/ios/App/App/Info.plist`); not yet exercised on a device |

## Testing

```bash
# server rules: membership, ring vs huddle, video gate, capacity, per-device
# signal routing, ordered device migration, crash-leave (36 checks)
npx tsx --env-file=.env.local scripts/call-harness.mts

# 1:1 in two browsers, then reads the thread on each side:
# answered / cancelled / declined / busy (15 checks)
npx tsx --env-file=.env.local scripts/call-event-harness.mts [--headed] [--shots]

# a real 3-way mesh in three browsers: decline → join from the banner → late
# joiner fully meshed, media flowing on every leg, one thread row (19 checks)
npx tsx --env-file=.env.local scripts/group-call-harness.mts [--headed] [--shots]
```

The browser harnesses launch Chromium with
`--use-fake-device-for-media-stream`, so they exercise the actual WebRTC path —
ICE, DTLS, media — not a mock. Both need the dev server on :4000. `--shots` writes
screenshots to `/tmp` for a visual check against the design comp.

`group-call-harness.mts` measures **inbound RTP bytes per peer connection**, which
is the check that matters for a mesh: connections can reach `connected` while no
media flows. It collects the connections by wrapping `RTCPeerConnection` in a
page init script, so nothing in the app has to expose them for testing.

## Not built

- ~~TURN~~ — **done 2026-08-14.** Credentials are minted server-side from a
  Cloudflare Realtime key, verified end-to-end including relay-to-relay (a call
  where *both* sides need a relay, which ExpressTURN's free tier refused). Still
  set on the deployment, not just locally, before calling this closed in
  production.
- **Signaling isn't E2EE-sealed.** SDP (including DTLS fingerprints) transits
  the server in plaintext, so a malicious *server* could MITM media. The fix is
  to seal `call:signal` blobs in the existing envelope crypto — see the E2EE
  notes for the machinery this would reuse.
- **No push/wake for incoming calls.** `call:invite` fast-fails `offline` when
  the callee has no connected socket, and unlike `message:send` it sends no web
  push — so a closed or backgrounded app can't be rung at all.
- **More than 6 participants.** Would need an SFU (see
  [the plan](./group-calls-plan.md#why-not-an-sfu-first)); capacity refusals are
  counted server-side as the trigger to reconsider.
- **Huddle discovery is start-time only.** `call:ongoing` reaches members' user
  rooms for ring-eligible groups, but for a huddle it only reaches the group room
  — whoever has the conversation open. Someone who opens a big group *after* a
  huddle started sees no Join bar until the next call event. Fixing it needs
  shared state (or a room scan) rather than a derived rule.
- **The mobile Calls tab isn't a call log.** `calls-screen.tsx` is a "start a
  call" contact list. Call history now exists as thread rows, so backing that tab
  with real history is a straightforward follow-up.
- **The join bar has no design.** The comp has no state for an ongoing call, so
  `OngoingCallBar` is modelled on the pinned bar and should get a design pass.
