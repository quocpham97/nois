# Plan: group voice & video calls

Status: **implemented 2026-08-13** (Phases 0–3). This file is kept as the design
record — the rationale, the decisions and the trade-offs behind what shipped; for
how the built system behaves, see [calls.md](./calls.md).

Deviations from the plan as written, and why:

- **The starter writes the thread record, not the last participant to leave.** The
  plan had the server tell the last leaver via `call:ended {startedAt, peak}`, but
  those two values are per-call *state* — and a node-local map for them is wrong
  the moment participants land on different nodes behind the Redis adapter. The
  room model's whole point is that every rule is derived, so the record is written
  by the one client guaranteed to have been present from `t0`. Cost: a group call
  that continues after the starter leaves is recorded as the starter's
  participation.
- **Huddle discovery is start-time only.** `call:ongoing` reaches members' user
  rooms for ring-eligible groups, but a huddle's announcement only reaches the
  group room (whoever has the conversation open). Opening a big group *after* a
  huddle starts shows no Join bar. Fixing it needs shared state, which is the same
  trade-off as above.
- **The video cap is enforced structurally**, by only offering video when the whole
  group is ≤4 members, so the participant cap the server counts is just the voice
  cap of 6. Same guarantee, no extra state.
- **TURN**: prerequisite 2 is **met** (2026-08-14). Credentials are minted
  server-side (`ice:servers`) from a Cloudflare Realtime key rather than inlined
  into the bundle, with the old `NEXT_PUBLIC_TURN_*` vars kept as a fallback.
  Relay-to-relay works, so the mesh no longer fails when two participants are
  both behind carrier-grade NAT — which mattered more here than for 1:1, since a
  mesh multiplies the NAT failure modes. See
  [calls-production.md](./calls-production.md#server-minted-credentials-shipped).

## Recommendation in one paragraph

Build group calls as a **full-mesh P2P call, voice-first, capped at 6
participants** (video capped at 4), with the server acting as a roster and
signaling relay only — never a media path. Mesh keeps the product's central
promise intact: media stays peer-to-peer and end-to-end encrypted by
construction, with no new trusted server component. An SFU is the only way past
~6 participants, but it puts a server in the media path, and keeping E2EE there
means per-frame encryption (SFrame / insertable streams) whose support on
WKWebView — i.e. the iOS shell — is not something to bet the feature on. Defer
the SFU behind an explicit trigger rather than designing for it now.

Groups larger than 6, and all public groups, get a **huddle model** instead of
ringing: the call is announced in the thread as joinable and nobody's phone
rings. A call started in a group of 5–6 is **voice-only**, so the video cap can
never be reached by surprise mid-call.

## Why not an SFU first

| | Mesh | SFU |
| --- | --- | --- |
| Participants | ~4 video / ~6 voice | dozens |
| Uplink per participant | N−1 streams | 1 stream |
| Media path | peer-to-peer only | through our server |
| E2EE | inherent (DTLS-SRTP per pair) | needs SFrame/insertable streams |
| iOS (WKWebView) | same as today | per-frame crypto support is doubtful |
| New infra | none (TURN, already required) | media server, ports, capacity, ops |
| Effort | contained in `call-context.tsx` | new service + deploy + monitoring |

**Trigger to revisit:** frequent cap rejections in telemetry, or mesh
CPU/bandwidth proving unacceptable on the mobile shells.

**Update (2026-08-14):** the E2EE half of this objection is weaker than it looked
when written. Cloudflare's Orange Meets does E2EE over an SFU with MLS for group
key agreement plus WebRTC Encoded Transform for frames — and MLS is already live
in this codebase, so that part exists. Encoded Transform also reached baseline
browser availability in late 2025. The remaining reasons to stay on mesh are cost
and operational surface, not "E2EE can't be done over an SFU". The concrete path
is in [calls-production.md](./calls-production.md#the-concrete-path-if-you-want-to-build-it).

Cap rejections are only a usable trigger if they're counted, so Phase 1 must log
one server-side counter when a join is refused for being at capacity. Without it
this decision has no feedback loop.

## Prerequisites

1. **Per-device signal routing.** ✅ done. `call:signal` used to relay to
   `user:<uid>` — *every* device of that user. In a 1:1 call that's harmless
   (non-participating devices drop unknown `callId`s, and the `handled` fanout
   tears them down), but it is unsound for a mesh: a second device of the same
   user is also ringing, so it knows the `callId` and can act on an offer
   addressed to its sibling. Fix by having clients announce their `deviceId` on
   connect and `socket.join("device:" + deviceId)`, then adding
   `toDeviceId`/`fromDeviceId` to the signal payloads. This is worth doing on
   its own merits — it removes a latent race in the existing 1:1 path.
2. **TURN must be configured.** Mesh multiplies NAT failure modes; a call that
   half-connects is worse than one that fails. Already a 1:1 production blocker.
3. **iOS media permissions.** ✅ done — `NSMicrophoneUsageDescription` and
   `NSCameraUsageDescription` are in `mobile/ios/App/App/Info.plist`. Not yet
   exercised on a device.

## Protocol

Model a call as a **socket room** rather than server-held state:
`call:<groupId>:<callId>`. The room *is* the roster — `fetchSockets()` on it is
adapter-aware (works across nodes behind the Redis adapter, same as the existing
online check), `groupId` is derivable from the room name so no callId→group map
is needed, and socket.io removes a crashed participant automatically.

| Event | Who | Server does |
| --- | --- | --- |
| `call:start {groupId, video}` | starter | validate **membership** (`isMember`, not `canAccess` — see below), join starter to the room, ring members iff the group qualifies (below), ack `{callId, participants}` |
| `call:join {callId}` | invitee / late joiner | validate membership of the room's group; refuse at capacity (and count it); **displace the joiner's own other device** (below); join, broadcast `call:joined {userId, deviceId}` to the room |
| `call:leave {callId}` | participant | leave, broadcast `call:left {deviceId}`; if the room is now empty, tell the conversation the call is over (shipped as `call:over`, not the planned `call:ended {startedAt, peak}` — see the deviations at the top) |
| `call:kicked {reason}` | server → displaced device | sent when the same user joins from another device |
| `call:signal` | participants | relay to `device:<toDeviceId>` (unchanged otherwise) |

**Glare-free mesh choreography:** when someone joins, every incumbent offers to
the joiner and the joiner only ever answers. Each pair therefore has exactly one
offerer, and the existing offer/answer/ICE handling works per-pair unchanged.

**One device per user per call — migrate on join.** Two devices of one user in
the same call would feed back acoustically (the phone's mic picks up the
laptop's speaker and returns it to the mesh), so the newest join wins: the server
emits `call:kicked {reason: "joined_on_another_device"}` to the older device,
removes it from the room, and broadcasts its `call:left` so peers tear down that
mesh leg and dial the new device instead. The displaced client tears down and
says so ("Call moved to your other device"). Because signaling is per-device
(prerequisite 1), the swap is just a leave plus a join to the other peers.

**Ordering matters, and it's the whole guarantee.** The displacement must
complete — old socket out of the room, `call:left` broadcast — *before*
`call:joined` for the new device goes out, so incumbents never hold live legs to
both devices and no audio track is ever negotiated for the second one. Handle it
in one synchronous step inside `call:join`, not as a follow-up event. Get that
order right and self-echo is structurally impossible rather than something that
resolves a beat too late; get it wrong and the feedback loop is exactly the bug
the decision was meant to prevent. Worth an explicit harness assertion (below).

### Who rings

**Superseded 2026-08-17 — ringing now follows PRESENCE.** The rule below is kept
because its reasoning still explains the cap; only the thing being counted
changed. See [Revision: ring who can answer](#revision-ring-who-can-answer).

Ring only when the group is **private and has ≤6 members** (1 starter + up to 5
invitees); everything else is a huddle. Concretely: a DM (2 members) rings as it
does today; a private group of 3–6 rings; a private group of 7+ and **every
public group, at any size**, gets the joinable in-thread banner and no audio.

The threshold counts **group members**, not online members, so it's a stable
server-checkable property rather than one that shifts with who happens to be
connected.

Why 6: it pins the ring threshold to the **voice cap**, so everyone rung can
actually get into the call. That leaves the video cap (4) to be reconciled
separately, because a 6-member group whose members all answered with video would
put two of them over it and silently drop them to voice — the fragmented
experience the threshold is meant to avoid.

**Video availability follows group size, decided at call start:** a group of ≤4
can start a video call; a group of 5–6 starts a voice call, with the video button
disabled and a reason ("Video is available in calls of 4 or fewer"). Nobody is
ever degraded mid-call, and "everyone who was rung can participate fully" stays
true. The trade-off is deliberate conservatism: a 5-member group where only three
people actually answer still can't turn on video. The alternative — offer video
and cut it when the 5th joins — trades a predictable limit for a surprise that
lands on people already talking, which is worse. Say the word if you'd rather
have the flexible version.

#### Ring-bombing: dead, but not for the reason you'd expect

The 500-person case is closed by the size cap: the server sees the group exceeds
6 members, skips the fanout entirely, and posts a silent huddle banner. The
attacker sits alone in an empty room and **zero** notifications go out.

The `isMember` layer, however, is **not** a real barrier in this codebase.
`group:join` calls `addMember` for public groups — anyone who so much as *opens*
a public group is recorded as an explicit member, because E2EE sender-key
distribution targets the explicit roster and viewers would otherwise see nothing
but 🔒 (`server.ts:366`). So for a public group, "member" means "has opened it",
and an attacker becomes one by clicking the group. Keep `isMember` for
authorization — it still stops a call being started in a group you've never
opened, and it's the right roster for the ring set — but the size cap is the
load-bearing defense.

That's also the second, stronger reason public groups never ring **regardless of
size**: their roster isn't a list of people who agreed to be reachable, it's a
list of people who once looked. A public group sitting at 3–6 members would
otherwise ring or not depending on who had browsed it that week.

Enforce all of this server-side; the client's copy of the rule is a UI hint only.

The first answer must **not** stop the others' ringing: the current `handled`
fanout has to become per-user (stop *my* other devices), not per-call.

### Revision: ring who can answer

**Changed 2026-08-17.** Ringing now counts the members who are **online** rather
than the roster, and privacy no longer enters into it:

> Ring the online members, provided they'd all fit in the call (≤5 others).
> Otherwise it's a huddle.

What went wrong with the original rule: a roster is a poor proxy for
reachability. Every group in the real workspace was public, so *nothing ever
rang* — a call in a 3-person group was announced by a silent banner nobody was
looking at. Meanwhile a 40-person group with three people online is, for the
purposes of a call, a three-person group; counting the dormant 37 against the cap
silenced exactly the calls that would have worked.

What survives unchanged is the part that was actually load-bearing. **The cap
still bounds a ring to at most the voice cap**, so "everyone rung can get in"
holds and no group, at any size, can be turned into a notification cannon.

What we gave up is the "public groups never ring" defense, and it's worth being
precise about the delta rather than waving it through. The concern was that
opening a public group makes you a member (`server.ts:366`), so its roster is
people who looked, not people who agreed to be reachable — and now those people
can be rung. The mitigating argument: **a stranger can already ring you one-to-one
by opening a DM**, so this is an amplification of an existing capability
(bounded at 5) rather than a new door. If that trade stops looking worth it, the
narrow fix is to reinstate the public-group check for groups above some size —
the presence rule and the public rule are independent.

The instability the original rule warned about is real and accepted: whether a
call rings now depends on who happens to be connected. That is the intended
behaviour rather than a side effect — ringing people who cannot answer was never
the goal.

## Client (`call-context.tsx`)

The state shape assumes one peer throughout — this is the bulk of the work:

- `pcRef: RTCPeerConnection` → `Map<deviceId, RTCPeerConnection>`
- `remoteStream` → `Map<deviceId, MediaStream>`
- `CallInfo` gains `kind: "dm" | "group"` and a participant map (user, stream,
  their mic/cam state); `peer`/`peerId` become per-participant
- `pendingIceRef` becomes per-peer
- One local stream, added to every peer connection (mic/cam toggles still flip
  `track.enabled`, so still no renegotiation)
- Teardown becomes per-peer plus whole-call
- Phases stay, but `active` now means "≥1 peer connected"

Keep the 1:1 path working through the same code (a DM call is a mesh of one
peer), rather than forking two engines.

## UI

- **Header:** drop the `isDm &&` gate on the call buttons; disable with a reason
  above the participant cap.
- **Call panel:** participant grid (1–6 tiles) instead of one remote video +
  PiP; voice-only tiles show the avatar. Per-tile name and muted indicator.
- **Incoming card:** group name, who started, "N on the call".
- **Join affordance:** the huddle case needs an in-thread "Ongoing call · Join"
  row. **The comp doesn't have this** — it needs a design pass before building.
- **Mobile:** the Calls tab is the natural home for "ongoing calls you can join".

## The thread record

The design comp already anticipates group calls: a call row carries
`joined: 4` ("4 on the call") and renders a "<Name> started a call" label above
the card in a group conversation. Both hooks exist in the comp and are
deliberately unused today — `CallEvent` needs a `joined?: number`, and
`CallEventRow`'s group-author path is already guarded and ready.

**Who writes the row?** The 1:1 rule (the caller writes it) doesn't extend: the
starter may leave long before the call ends. Proposal: the server tells the
**last participant to leave** (`call:ended`, carrying start time and peak count)
and that client writes the single row. Exactly one row, accurate duration.

Statuses collapse for groups: `answered` (somebody joined) or `unanswered`
(nobody did). Per-member `declined` is noise in a group.

**Privacy delta — accepted, and disclosed.** Because the server owns the roster,
it learns who was in a group call and for how long. That's unavoidable once it
manages join/leave, and it's the industry norm: Signal, WhatsApp and Matrix all
expose call metadata (participants, duration) to their signaling servers while
keeping the media payload end-to-end encrypted. It remains a real step down from
the 1:1 design, where the server learns nothing beyond "some signaling
happened" — so it gets disclosed in the product, not just in this file. Ship
this sentence with Phase 1, in `PrivacyPanel` (`settings-view.tsx`) alongside the
existing encryption copy:

> Call metadata (participants & duration) is processed by the server; voice and
> video remain end-to-end encrypted.

## Phasing

| Phase | Scope |
| --- | --- |
| 0 | Prerequisites: per-device signal routing, TURN, iOS permissions |
| 1 | Group **voice** mesh: room protocol, join/leave, device migration (`call:kicked`), ring-vs-huddle rule, caps + rejection counter, participant grid (avatar tiles), the metadata disclosure copy |
| 2 | Video: tiles, adaptive degrade (drop to voice above the video cap) |
| 3 | Thread record: `joined`, "started a call" label, huddle join row (needs the design pass) |
| 4 | *If triggered:* SFU with per-frame E2EE |

Phase 1 is the real cost — mostly the `call-context` refactor from one peer to a
map, plus the server room protocol. Phases 2–3 are additive.

## Testing

- Extend `scripts/call-harness.mts`: non-member rejected; a private group of ≤6
  rings every member's devices; a 7-member group and a public group of *any* size
  ring nobody; a call started in a 5–6 member group is voice-only; joining at
  capacity is refused (and counted); per-device signal routing reaches only the
  addressed device; `call:left` on disconnect.
- **Device migration, ordered:** a second device of the same user displaces the
  first — `call:kicked` to the old device and its `call:left` must both be
  observed by an incumbent *before* that incumbent sees `call:joined` for the new
  device. Assert the order, not just the eventual state: the ordering is the
  entire echo guarantee, and a version that fires the events the other way round
  would pass a state-only check while feeding back audio in production.
- New 3-browser harness (the pattern in `scripts/call-event-harness.mts`
  already runs real WebRTC with fake capture devices): A starts, B and C join,
  assert three tiles per client and **inbound bytes > 0 per pair** via
  `getStats()` — that catches a mesh that "connects" without media flowing —
  then leave in order and assert exactly one thread row with `joined: 3`.

## Decisions (settled 2026-08-13)

| Question | Decision |
| --- | --- |
| Participant cap | **6 voice / 4 video.** Covers informal group calling; frequent cap rejections in telemetry are the trigger to build an SFU (hence the counter in Phase 1). |
| Ring vs huddle | ~~Ring at ≤6 group members, private groups only~~ — **superseded 2026-08-17**: ring the members who are ONLINE, when they'd all fit in the call, regardless of privacy (see [the revision](#revision-ring-who-can-answer)). The cap still matches the voice cap so everyone rung can get in; too many online, or none, gets the silent "Join Call" banner. Calls in 5–6 member groups are voice-only, which is what keeps the video cap from being hit mid-call. |
| Multi-device | **Migrate on join.** Two live devices per user would loop audio, so the newer join displaces the older via `call:kicked { reason: "joined_on_another_device" }` — completed before the new device is announced. |
| Roster metadata | **Accepted as standard**, matching Signal/WhatsApp/Matrix, and disclosed in `PrivacyPanel` with the sentence quoted above. |

Two risks these decisions retire, and the caveat on each:

- **Acoustic echo** — structurally impossible once one device per user is
  enforced at the signaling level, *provided* the displacement is ordered ahead
  of the new device's announcement (see the protocol section). The decision
  removes the risk; the ordering is what makes it true in practice.
- **Public-group ring-bombing** — closed by the server-side size cap, which
  skips the fanout entirely for any group over 6. Note that the `isMember` layer
  is not doing this work: opening a public group makes you a member of it
  (`server.ts:366`), so an attacker clears that gate by clicking. The cap, and
  the blanket "public groups never ring", are the real defenses.
