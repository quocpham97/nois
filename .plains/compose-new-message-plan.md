# Plan: Make the "New message" (Compose) feature work

_Created 2026-06-15 · Product Owner plan_

## Finding: the non-working feature

`chat-app` is a Slack-style client (Next.js + React, in-memory seed data). Most
features work — group messages, threads, reactions, search, theme switching,
settings toggles. **The Compose ("New message") flow is wired up visually but
does nothing.**

In `src/components/chat/compose-view.tsx`:

- **The message textarea (lines 106–109) is uncontrolled** — no `value`, no
  `onChange`. Anything typed is never captured.
- **The Send button (lines 120–133) has no `onClick`** — it only changes color
  based on recipient count. Clicking it does nothing.
- `ChatContext` has **no action to send** — there's `addRecipient` /
  `removeRecipient` / `composeQuery`, but nothing analogous to the working
  `sendMessage` / `sendThreadMessage`.

Net effect: a user can open New message, pick recipients, type a message, hit
Send — and nothing happens. The feature's entire purpose (start a conversation)
is dead. Recipient selection is the only part that works.

> Note: the `sidebar` / `audio` / `advanced` settings tabs render a "would live
> here" `Placeholder` — those are _intentional_ stubs, not broken features.
> Compose is the real gap.

## Epic

A user can start a new conversation from "New message" and have it actually send.

## User story

> As a member, when I pick a recipient, type a message, and hit Send, I'm dropped
> into that DM with my message posted — so New message is a real entry point, not
> a dead end.

## Tasks (sequenced)

1. **`sendCompose()` action + `composeText` state in ChatContext**
   The missing core logic — find-or-create the DM group, seed the typed
   message, select it, reset compose. Mirrors the existing `sendMessage` pattern.

2. **Wire the textarea + Send button in ComposeView**
   Bind `composeText`, add `onClick={sendCompose}`, Enter-to-send (Shift+Enter
   for newline), disable when empty / no recipients.

3. **Make new DMs show in the sidebar**
   `DM_ORDER` is a static module constant in `chat-data.ts`; a newly created DM
   won't render unless ordering becomes context-derived state.

4. **Recipient scope, validation & group-DM naming**
   Placeholder promises "name or group" but only People work; define group-DM
   display name, block dupes/self, add empty filter state.

5. **Verify end-to-end in the running app**
   Dev server on :4000, exercise happy path + edge cases (no recipient, empty
   text, existing vs new DM).

## Acceptance criteria (story-level)

- Send is disabled until ≥1 recipient **and** non-empty text.
- Clicking Send (or Enter) posts the message into the recipient's DM, closes
  Compose, and selects that DM.
- Sending to someone with an existing DM appends to it rather than duplicating
  the group.
- The DM is visible/selectable in the sidebar afterward.
- Shift+Enter inserts a newline; empty/whitespace-only sends are ignored.

## Open decision (drives tasks 3 & 4)

Scope of recipients:

- **Lean:** people-only, 1:1 DMs (relabel the placeholder, reuse the
  `dm-<firstname>` convention).
- **Full:** multi-recipient group DMs + selecting existing groups as a
  destination — needs a group-DM data shape and naming rule.
