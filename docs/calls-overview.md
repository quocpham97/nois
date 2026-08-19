# Calls at a glance — 1:1 and group

A summary of the voice/video feature as it stands **2026-08-19**: what ships, how
the pieces fit, and where 1:1 and group genuinely differ. The long-form docs stay
authoritative for detail — [calls.md](./calls.md) for behaviour,
[calls-production.md](./calls-production.md) for TURN/SFU operations,
[group-calls-plan.md](./group-calls-plan.md) for why it's shaped this way.

**There is one engine, not two.** A DM call is a mesh of one peer, so the phases,
roster, ring timeout, device migration and thread record are the same code for
both. Everything in the "1:1 vs group" table below is a *rule* difference, never
a second implementation.

## What ships

| | |
| --- | --- |
| Voice + video | DMs and groups, browser + Electron desktop; iOS/Android permissions in place, never exercised on a device |
| Media path | peer-to-peer **mesh**, DTLS-SRTP per pair — no server in the media path |
| Signaling | socket relay; a call *is* a socket room, so there is almost no per-call server state |
| Capacity | **6 voice / 4 video**, enforced when someone joins |
| Ringing | the members who are **online**, when they'd all fit in the call; otherwise a joinable huddle |
| Records | one call row in the conversation, written by the starter, sealed as an ordinary E2EE message |
| TURN | required, live since 2026-08-14 — credentials minted server-side from a Cloudflare Realtime key |
| SFU | group calls only, behind an off-by-default build flag; **media path verified working 2026-08-19**, per-frame encrypted end-to-end. Still off by default — the caps and the failure handling in gap 2 come first |

## 1:1 vs group

| | DM | Group |
| --- | --- | --- |
| Who rings | the peer's devices; nobody online **fast-fails `offline`** | the online members, if they'd all fit (≤5 others); nobody online is a legitimate huddle you can sit in |
| No ring case | — | more online members than fit → silent "Ongoing call · Join" bar in the conversation |
| Video offered | always | server offers it when the online members fit under the video cap (≤3 others); the cap then holds at **join**, refusing the 5th rather than degrading everyone |
| Call layout | the comp's centred single-peer surface | 4:3 tile grid from two peers up, name labels per tile |
| Thread row | status only ("Voice call · 11:42", "No answer") | plus `joined` peak count ("4 on the call") and a "<Name> started a call" label |
| What the server learns | only that signaling happened — the row itself is ciphertext | the roster and duration, because it manages join/leave (disclosed in Settings → Privacy) |
| Transport | **always the mesh**, whatever the flag says — two parties have no uplink problem, and DTLS-SRTP is already end-to-end | mesh by default; the SFU when `NEXT_PUBLIC_CALL_TRANSPORT=sfu`, keyed from MLS (see gap 2) |

Both paths share: 45s ring timeout, one device per user per call (a second device
displaces the first), a 10s grace for a dropped socket, membership checked
server-side on `call:start`/`call:join` (`isMember`, never `canAccess`), and
per-device signal routing.

## Lifecycle

```
        startCall()                  someone joins             media connects
outgoing ──────────► (ringing) ─────────────────────► connecting ──────────► active
                                                           ▲                    │
incoming ─────────────────────────►  acceptCall()  ─────────┘                    ▼
   ▲                                 joinOngoing()                          teardown()
   └── call:invite relay                    declineCall / timeout / hang-up ─────┘
```

`outgoing` is derived from `starterId === us`, so a starter who migrates devices
keeps ownership of the thread record. Mic/camera toggles flip `track.enabled`, so
tracks are fixed at setup and **no renegotiation ever happens** on the mesh.

Outcomes recorded: `answered` (media connected), `declined` (declined, capture
failed, or busy), `unanswered` (rang out, cancelled, or accepted-but-never-
connected). A call that never reached anyone records nothing.

## Layers

```
call-context.tsx      phases · roster · ring · device migration · thread record
      │
      ├── CallTransport  (call-transport.ts)  ── start/addPeer/removePeer/handleSignal/close
      │     ├── createMeshTransport   one RTCPeerConnection per remote DEVICE  (default)
      │     └── createSfuTransport    publisher + subscriber session via a server proxy (flag)
      │            └── FrameCrypto  (call-frame-crypto.ts → worker → call-frame-codec.ts)
      │
      └── server.ts   call:* room protocol · ice:servers · sfu:* proxy
```

| Piece | File |
| --- | --- |
| Engine | `src/components/chat/call-context.tsx` |
| Transports | `call-transport.ts` (mesh), `call-transport-sfu.ts` |
| Frame crypto | `call-frame-crypto.ts`, `call-frame-crypto.worker.ts`, `call-frame-codec.ts` |
| UI | `call-view.tsx` (docked card while ringing, full-screen panel once connecting), `call-window.tsx` (pop-out via a React portal into `window.open()`) |
| Entry points | `group-view.tsx` header, `mobile/conversation-screen.tsx`, `mobile/calls-screen.tsx` |
| Thread row | `message.tsx` (`CallEventRow`), `chat-data.ts` (`CallEvent`) |
| Server | `server.ts` (`call:*`, `ice:servers`, `sfu:*`), wire types in `lib/socket-events.ts` |

### Signaling, in one table

| Event | Server does |
| --- | --- |
| `call:start` | validates membership, opens the room, rings if eligible, acks `{callId, video, ringing}` / `offline` / `unauthorized` |
| `call:invite` → `call:decline` / `call:handled` | rings each online member's devices; the first device to answer or decline wins, siblings stop |
| `call:join` | validates membership, refuses `full` at the call's cap or `gone`, displaces the joiner's own other device (`call:kicked`) **before** announcing the new one |
| `call:rejoin` | reclaims a seat held for 10s after a websocket blip; never displaces another device |
| `call:joined` / `call:left` | roster changes, per device |
| `call:ongoing` / `call:over` | drives the "Ongoing call · Join" bar |
| `call:signal` | relays blobs ≤256 KiB to `device:<toDeviceId>` |

Whether a call is video rides in the **callId** (`v-` prefix) rather than a
server-side map, which is what lets the cap be enforced at join without any
per-call state to keep consistent across nodes.

## Encryption

| Layer | Status |
| --- | --- |
| Mesh media | end-to-end by construction (DTLS-SRTP per pair); the server is never in the path |
| SFU media | **verified 2026-08-19**: sealed per frame with AES-GCM before it leaves the browser — key derived from the group's **MLS epoch exporter secret** (`"chat-app call media"`, context = callId), epoch carried in the frame, VP8 pinned so the clear codec header is the right length, and that header signed as AAD |
| Rekeying | follows the MLS **epoch**, not the call roster — a removal advances the epoch, which is exactly the person who must lose access; the worker holds two epochs so frames in flight across a commit still open |
| First key | waits up to 20s for MLS to converge (a just-created group has no state yet); unsealed frames are **dropped**, so a call without a key is silent, never readable |
| Signaling | **not sealed.** SDP and DTLS fingerprints transit the server in plaintext, so a malicious server could MITM mesh media |
| Metadata | group call roster + duration are visible to the server; DM calls leak only "some signaling happened" |
| No downgrade | a browser without Encoded Transform is refused an SFU **group** call rather than joining in the clear; DM calls are unaffected, being on the mesh |

## Configuration

```bash
# TURN — required in production. Server-minted (preferred): nothing reaches the bundle.
TURN_KEY_ID=…            # Cloudflare Realtime TURN key
TURN_KEY_API_TOKEN=…
TURN_TTL_S=3600          # optional

# Fallback, only when the above are unset — inlined at BUILD time, world-readable.
NEXT_PUBLIC_TURN_URL=turns:turn.example.com:5349
NEXT_PUBLIC_TURN_USERNAME=…
NEXT_PUBLIC_TURN_CREDENTIAL=…

# SFU — off by default, and not declared in render.yaml on purpose. Applies to
# GROUP calls only: DMs have no MLS group to key frame encryption from, so they
# stay on the mesh whatever this says.
NEXT_PUBLIC_CALL_TRANSPORT=sfu
SFU_APP_ID=…             # a DIFFERENT credential from the TURN key
SFU_APP_TOKEN=…

CALL_DROP_GRACE_MS=10000 # optional: how long a dropped socket keeps its seat
```

A failed TURN mint is never a failed call: it logs, negative-caches for 30s and
falls back. With nothing set at all, ICE is Google STUN only and calls between
symmetric NATs fail outright.

## Testing

```bash
npx tsx --env-file=.env.local scripts/call-harness.mts          # server rules (~48 checks)
npx tsx --env-file=.env.local scripts/call-event-harness.mts    # 1:1 in 2 browsers (16)
npx tsx --env-file=.env.local scripts/group-call-harness.mts    # 3-way mesh in 3 browsers (19)
npx tsx scripts/frame-crypto-harness.mts                        # frame format, no browser (22)
npx tsx --env-file=.env.local scripts/turn-check.mts             # relay actually carries media
```

The browser harnesses run real WebRTC with `--use-fake-device-for-media-stream`
and need the dev server on :4000. The group harness measures **inbound RTP bytes
per connection**, because a mesh can reach `connected` while no media flows.
`frame-crypto-harness.mts` attacks the frame format directly (wrong key, wrong
epoch, rewritten clear header, truncation, IV reuse) — run 2026-08-18, all pass.

Measured 2026-08-19, all passing: group 19/19 and 1:1 16/16 on the **mesh**,
group 19/19 on the **SFU**, plus `mls-harness.mts`, `call-harness.mts` (48) and
`group-send-fallback-harness.mts` after the MLS wire change.

The group harness's media assertion counts inbound RTP **streams** rather than
peer connections, which is what lets one harness verify both transports: a mesh
has one connection per peer, an SFU has one subscriber connection carrying
everybody plus a publisher that receives nothing by design. "Media from N remote
participants" is N inbound streams with bytes on them either way — a stronger
claim than the old per-connection count, and the reason SFU runs now report two
sources per participant.

## Known gaps

Ordered by how likely they are to bite.

1. **The desktop header's call affordances encode the superseded rules.**
   `group-view.tsx:40-41` still computes `videoEligible = memberCount <= 4` and a
   private-and-≤6 `ringEligible`, while the server has followed **presence**
   since 2026-08-17. A 40-member group with three people online rings all three
   and would carry video, but the header shows no camera button and the phone's
   tooltip says the group is too big to ring. Mobile (`conversation-screen.tsx`)
   offers both unconditionally and is closer to correct. Server-side behaviour is
   right; only the hints lie.
2. **The SFU path works but is not production-ready.** It carries real
   frame-encrypted media as of 2026-08-19 (`group-call-harness.mts` passes on
   it, two distinct media sources per participant), and the three bugs that
   broke it are fixed — see below. What still argues for keeping it off:
   **failure is all-or-nothing** (one dead connection drops the whole roster,
   where a mesh loses one leg) and **there is no session re-establishment**, so a
   long enough outage ends the call rather than healing it. The caps are also
   still 6 voice / 4 video, which the SFU exists to raise — nothing reads them
   from the transport yet.

   What was wrong, since none of it was visible in the code:

   - **Session ownership died with the connection.** `sfuSessions` was a `Set`
     inside the per-connection closure, so a reconnected socket denied owning
     the sessions it had just opened and every later `tracks/new` was refused
     `unauthorized` — permanently. Room membership already survived a blip via
     `heldSeatFor`; sessions now do too, bound to the device and the call.
   - **A 30 MB `mls:commit` was killing the websocket.** One add-commit yields
     ONE Welcome, but the payload carried a copy per target device — 242 devices
     × 125 KB in a single frame. `ws` does not reject an oversized frame, it
     tears the socket down, so every call and commit riding on it died. The
     shared blob now goes once with the devices it is for (`welcomeFor`).
   - **Retries could not tell "never sent" from "no reply".** Mutating requests
     are capped at one attempt so a lost ack can't desynchronise a session, but
     that also killed requests that provably never happened. `unauthorized` (the
     guard runs before any upstream call) and emits placed on a disconnected
     socket now retry on their own budget, and requests wait for the socket
     instead of being fired into a blip.

   Two follow-ups this surfaced, both outside calls: the DS still **stores** one
   Welcome copy per device (`queueWelcome`), so the 30 MB is now on disk rather
   than the wire; and a test user had ~80 stale published devices, which is what
   made a three-person group's commit that large — device pruning would shrink
   both the fan-out and the 120 KB ratchet tree.

3. **Signaling isn't E2EE-sealed** — the remaining hole in the mesh's otherwise
   end-to-end story. The fix is to seal `call:signal` blobs in the existing
   envelope crypto.
4. **No push/wake for incoming calls.** A closed or backgrounded app can't be
   rung at all: `call:invite` fast-fails `offline` and sends no web push.
5. **Huddle discovery is start-time only** for groups too big to fan out to
   (>6 members) — opening such a group after a huddle starts shows no Join bar.
6. **Past 6 participants needs an SFU.** Capacity refusals are counted
   server-side (`[call] capacity reject …`) as the agreed trigger.
7. **The mobile Calls tab is a contact list, not history** — the rows now exist
   in the message store, so backing it with real history is straightforward.
8. **The join bar has no design.** The comp has no ongoing-call state, so
   `OngoingCallBar` is modelled on the pinned bar.
9. **iOS/Android calling is unexercised.** Permission strings are in place;
    nobody has placed a call from a device.
