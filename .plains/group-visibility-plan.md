# Group visibility: member-only groups

**Problem.** Creating a group announces it to the entire workspace. Anyone can
see it in their sidebar, open it, read its history, and post in it — without
ever being added.

**Target.** A group is visible to, and usable by, exactly its explicit member
roster. The `private` flag stops gating access; membership is the only gate.
`general` / `random` stay visible to everyone because `joinDefaultGroups`
already adds every user to them as a real member.

## Why it happens today (Slack-shaped model)

| Site | Behavior |
| --- | --- |
| `src/server/store.ts:493` `canAccess` | returns `true` for any non-private group, for any user |
| `src/server/store.ts:568` `listGroupsForUser` | hands every user every public group in the connect snapshot |
| `server.ts:786` `group:create` | `io.emit("group:created")` — whole workspace |
| `server.ts:613` `group:join` | opening a public group silently **adds you as a member** |
| `server.ts:396` `bumpUnread`, `:428` `groupAudience`, `:579` `emitGroupUpdated` | broadcast public-group state to `io` |
| `create-group-view.tsx` | "Make private" toggle defaults **off**; no member picker at all |

The client is not implicated: every list (`sidebar.tsx:447`,
`mobile/chats-screen.tsx:32`) derives from the `groups` map, which is filled
only by `groups:list` and `group:created`. Fix the server's answer and the UI
follows.

## Changes

### 1. Wire contract — `src/lib/socket-events.ts`
- `GroupCreatePayload`: `{ name; topic?; memberIds: string[] }`. Drop `private`.
- `GroupCreateResult` unchanged.

### 2. Store — `src/server/store.ts`
- `canAccess` → `groupExists(groupId) && isMember(groupId, userId)`. One rule for
  groups and DMs.
- `listGroupsForUser` → drop the `isPublic` disjunct; members only.
- `createGroup(name, { topic, creatorId, memberIds })` → add the creator plus
  each member id before returning. Set `private: true` on the meta (fail-closed
  marker if any reader ever comes back) but keep `icon: "hash"` — with every
  group member-only, a lock badge on all of them is noise.
- Delete `isPublicGroup` (:927) once its three callers are gone.
- Seed `DEFAULT_GROUPS` with `private=true` in `init()`.

### 3. Socket handlers — `server.ts`
- `bumpUnread` (:394) — drop the public branch; always member rooms.
- `groupAudience` (:427) — drop `return io`; always member rooms, `null` when
  empty (the existing `io.to([])` guard still matters).
- `emitGroupUpdated` (:579) — drop the public `io.emit` branch; always the
  per-member viewer-correct loop.
- `group:create` (:786) — shape-validate `memberIds` (non-empty, deduped, minus
  the creator), reject an empty roster, create, then emit `group:created` to
  **each** member's `user:<id>` room using that member's own
  `store.getGroup(id, memberId)` view. Creator's socket joins the room as today.
  *Implementation note:* ids are deliberately NOT checked against the workspace
  roster, as first drafted. That roster is process-memory and refills as users
  reconnect, so after a restart the check would silently drop an invitee who
  simply hasn't reconnected yet. `dm:create` accepts any recipient key for the
  same reason, and a roster entry grants nothing a client couldn't already do.
- `group:join` (:605) — delete the public auto-add block (:611–617).
  `authorized()` now rejects non-members outright.
- `group:delete` (:821) — drop the `isPublic` branch; always the roster captured
  before deletion.
- `group:addMember` (:841) — emit `group:created` to the new member
  unconditionally (drop the `if (group.private)` gate), in that member's own
  view. Also return early when `store.addMember` reports they were already on
  the roster: nothing changed, and a redundant roster broadcast makes every
  member's client re-diff its MLS membership for no reason.
- `group:removeMember` (:862) — emit `group:deleted` unconditionally (drop the
  `wasPrivate` gate), **and** evict their sockets from the room:
  `io.in("user:" + memberId).socketsLeave(groupId)`. Today a removed member's
  socket keeps receiving typing/room traffic until they navigate away.

### 4. Client — `src/components/chat/chat-context.tsx`
- `createGroup(name, topic, memberIds, onError)` — signature change (:4260).
- `onGroupsList` (:2007) — **prune**: drop `groups[id]` entries absent from the
  roster and `void msgdb.removeGroup(id)` for them. Without this a user keeps
  stale local meta + ciphertext for groups they can no longer see; the entries
  fall out of the sidebar (order is replaced from the roster) but still inflate
  the Mentions/Threads badges via `Object.values(groups)` in `sidebar.tsx:414`.

### 5. Create UI — `src/components/chat/create-group-view.tsx`
- Replace the "Make private" toggle with a member picker: chips + filter input
  over `workspaceMembers` minus self, the same shape as `compose-view.tsx`'s
  `To:` row.
- `canCreate = slug.length > 0 && selected.length >= 1`.
- Blurb → "Only the people you add can see this group."

### 6. `src/components/chat/group-info-panel.tsx`
- Line 315: drop the `ch.private` branch; the copy is always "Only invited
  members can see this group."

### 7. Harnesses — `scripts/`
- `mls-harness.mts:133-135,197` — bob and carol currently become members by
  *joining a public group*. Switch to `group:addMember` from alice.
- `pin-visibility-harness.mts:73` — creates a public group a different user then
  browses; pass `memberIds: [VIEWER]`.
- `call-harness.mts:125` — replace the `isPrivate` param with `memberIds`. Its
  "a PUBLIC group rings too — reachability, not privacy, decides" case is
  removed: there is no privacy flag left for ringing to be independent of, and
  it was otherwise a duplicate of the small-group case above it.
- `chat-color`, `conversation-layout`, `group-send-fallback`, `group-call`,
  `group-state` — already private + explicit `addMember`; only the payload
  field changes.
- New `scripts/group-visibility-harness.mts`: A creates a group with B; assert C
  gets no `group:created`, C's `groups:list` excludes it, and C's `group:join`,
  `message:send`, and `history:more` are all no-ops.

## E2EE / MLS

No protocol change — MLS is already roster-driven (`ensureMlsGroup` /
`mlsSyncMembership` diff against `mls:fetchGroup`'s `memberIds`). Two things get
*better*: members exist at creation time, so the creator's first send can
establish the MLS group with everyone in one commit instead of falling back to
sender-keys during the create-then-add gap; and deleting the public auto-join
removes the hack at `server.ts:611-617`, whose own comment explains it exists
only so public-group viewers stop seeing 🔒.

## Migration

Correctness needs no data migration — visibility becomes roster-derived. Add a
fail-closed backfill in `ensureSchema`:
`UPDATE "group" SET private = true WHERE type = 'group'`.

User-visible effect: a public group you never opened disappears from your
sidebar. A group you *did* open kept you on its roster (via the auto-add being
removed here), so it stays. `general` / `random` are unaffected.

## Verification

- `pnpm lint`, `pnpm exec tsc --noEmit`
- `scripts/`: group-state, mls, pin-visibility, group-send-fallback, group-call
- new group-visibility harness
- Manual, three signed-in profiles: A creates a group with B → B sees it, C does
  not; C deep-linking `/<id>` lands on the empty state; C cannot post.

## Deliberately out of scope

- **Who may add members.** `authorized()` means *any* member can add or remove
  anyone, including removing the creator. There is no owner/admin concept and no
  `created_by` column. Worth a follow-up; not part of this fix.
- Invite links / join requests / a browsable group directory.
- Mobile has no create-group entry point, so nothing to change there.
