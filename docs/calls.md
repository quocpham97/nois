# Voice & video calls

1:1 calls between DM counterparts. Media is peer-to-peer WebRTC (DTLS-SRTP) and
never touches the server; the server only relays signaling blobs it can't read.
A finished call leaves a record in the conversation.

Calls are **DM-only** — group calls would need an SFU (see [Not built](#not-built)).

| | |
| --- | --- |
| Client engine | `src/components/chat/call-context.tsx` |
| UI | `src/components/chat/call-view.tsx` (`CallUI`, mounted by both shells) |
| Thread record | `src/components/chat/message.tsx` (`CallEventRow`), `src/lib/chat-data.ts` (`CallEvent`) |
| Server relay | `server.ts`, the `call:*` handlers |
| Wire types | `src/lib/socket-events.ts` (`Call*Payload` / `Call*Relay`) |
| Tests | `scripts/call-harness.mts` (relay), `scripts/call-event-harness.mts` (calls end-to-end in two browsers) |

## The call state machine

One call at a time per client. Roles are fixed at setup: the **caller** creates
the offer, the **callee** answers. `CallInfo.phase` is the whole lifecycle:

```
        startCall()                    peer accepts              ICE connects
outgoing ──────────► (ringing) ──────────────────────► connecting ──────────► active
                                                            ▲                    │
incoming ──────────────────────────► acceptCall() ───────────┘                    ▼
   ▲                                                                          teardown()
   └── call:invite relay                     declineCall / timeout / hang-up ─────┘
```

`CallInfo.outgoing` records who placed the call — the phase alone can't tell you
once a call is connected, and the thread record depends on it.

Both sides ring for `RING_TIMEOUT_MS` (45s) before giving up. Mic/camera toggles
flip `track.enabled`, so tracks are fixed at setup and **no renegotiation ever
happens**. Handlers read live state through `callRef`/`handlersRef` so the socket
listeners (registered once per socket) never close over stale state.

### Signaling

Trickle ICE, relayed as opaque JSON strings through Socket.IO:

| Event | Direction | Server does |
| --- | --- | --- |
| `call:invite` | caller → callee (all their devices) | **validates** (below), acks `ok` / `offline` / `unauthorized` / `error` |
| `call:answer` | callee → caller | relays; also fans `call:end{reason:"handled"}` to the answerer's *other* devices so they stop ringing |
| `call:signal` | both ways | relays blobs ≤256 KiB (SDP offer/answer, one ICE candidate per event) |
| `call:end` | both ways | relays; unknown `reason` sanitized to `"ended"` |

The **invite is the only server-validated step**: the group must be a DM the
caller belongs to, and the callee is derived from the DM roster server-side,
never client-claimed — so a call can only ring an actual DM counterpart. The
online check uses `fetchSockets()` (adapter-aware, so it works across nodes
behind the Redis adapter) and fast-fails with `offline` instead of ringing an
empty room. Everything after the invite routes by `callId` + `toUserId` and is
dropped client-side for unknown `callId`s.

`call:end` reasons: `ended` (hang-up), `cancelled` (caller gave up while
ringing), `timeout` (rang out), `busy` (callee already on a call), `handled`
(server-generated, to the answerer's own other devices).

### Multi-device

An invite rings **every** device of the callee. Whichever one answers or declines
wins; the rest get `reason: "handled"` and stop ringing. A device that's already
in a call auto-declines a second invite with `reason: "busy"`.

## The thread record

A finished call leaves one row in the conversation — the Messenger-style call
card, not a bubble.

**The caller writes it.** `recordCall` (call-context) hands the outcome to
`logCallEvent` (chat-context), which seals it into an ordinary E2EE message
carrying `MessageContent.call`. Caller-only is deliberate: both ends observe the
same hang-up, so letting each side log its own row would double it. Going
through the message path — rather than generating a card locally the way the
comp's single-user mock does — means the row is persisted, reaches every device
of both parties, and reaches a callee who was offline when the call came in.

The server never learns a call happened, let alone how long it ran: `call` rides
inside the envelope like `text`, so all it ever stores is ciphertext.

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

```bash
# Optional, but required in production. Without a TURN relay, symmetric NATs
# never connect (public STUN alone isn't enough).
NEXT_PUBLIC_TURN_URL=turns:turn.example.com:5349
NEXT_PUBLIC_TURN_USERNAME=…
NEXT_PUBLIC_TURN_CREDENTIAL=…
```

The default ICE config is `stun:stun.l.google.com:19302` only.

Media capture needs platform permission plumbing, not just browser permission:

| Shell | Status |
| --- | --- |
| Browser | works (getUserMedia prompt) |
| Desktop (Electron) | works — `media` in `ALLOWED_PERMISSIONS` (`desktop/src/main.ts`), mic + camera entitlements in `desktop/build/entitlements.mac.plist`, usage strings in `desktop/electron-builder.yml` |
| iOS (Capacitor) | **calls will fail** — `mobile/ios/App/App/Info.plist` has no `NSMicrophoneUsageDescription`/`NSCameraUsageDescription`, so iOS denies capture |

## Testing

```bash
# server relay: invite authorization, ring fanout, signal/end routing (18 checks)
npx tsx --env-file=.env.local scripts/call-harness.mts

# real calls in two browsers with fake capture devices, then reads the thread
# on each side: answered / cancelled / declined / busy (15 checks)
# needs the dev server on :4000
npx tsx --env-file=.env.local scripts/call-event-harness.mts [--headed] [--shots]
```

`call-event-harness.mts` launches Chromium with
`--use-fake-device-for-media-stream`, so it exercises the actual WebRTC path —
ICE, DTLS, media — not a mock. `--shots` writes both threads to `/tmp` for a
visual check against the design comp.

## Not built

- **TURN is unset** (see above). This is the production blocker.
- **Signaling isn't E2EE-sealed.** SDP (including DTLS fingerprints) transits
  the server in plaintext, so a malicious *server* could MITM media. The fix is
  to seal `call:signal` blobs in the existing envelope crypto — see the E2EE
  notes for the machinery this would reuse.
- **No push/wake for incoming calls.** `call:invite` fast-fails `offline` when
  the callee has no connected socket, and unlike `message:send` it sends no web
  push — so a closed or backgrounded app can't be rung at all.
- **Group calls.** Would need an SFU; the current design is strictly pairwise.
- **The mobile Calls tab isn't a call log.** `calls-screen.tsx` is a "start a
  call" contact list. It predates the thread record, and call history now exists,
  so backing that tab with real history is a straightforward follow-up.
