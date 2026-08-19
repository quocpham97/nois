/**
 * Who and what a call is about, answered from the chat store.
 *
 * These were `resolveUser` / `titleFor` / `sfuFor` inside the call provider,
 * each reading a ref that mirrored `groups` and `workspaceMembers` so the
 * once-registered socket handlers wouldn't see stale state. Reading the store
 * directly is the same live read with no mirror to maintain, and it makes them
 * plain functions rather than hooks.
 */
import { deriveUser, type User } from "@/lib/chat-data";
import { chat } from "@/stores/chat-store";
import { SFU_ENABLED } from "./call-types";

/** Best display identity for a user: their DM partner entry (profile name +
 *  colour), else the workspace roster, else derived from the id. */
export function resolveUser(id: string): User {
  const s = chat();
  for (const ch of Object.values(s.groups)) {
    if (ch.type === "dm" && ch.user?.id === id) return ch.user;
  }
  return s.workspaceMembers.find((u) => u.id === id) ?? deriveUser(id);
}

/** What the call UI calls this conversation. */
export function titleFor(groupId: string, starterId: string): string {
  const ch = chat().groups[groupId];
  if (!ch) return resolveUser(starterId).name;
  if (ch.type === "dm") return ch.user?.name ?? ch.name;
  return ch.name;
}

/** The conversation kind, as the call state machine labels it. */
export function callKind(groupId: string): "dm" | "group" {
  return chat().groups[groupId]?.type === "group" ? "group" : "dm";
}

/**
 * Does THIS call go through the SFU?
 *
 * Groups only, even with the flag on. A DM has no MLS group behind it, so
 * `exportCallKey` has nothing to derive a media key from — and the SFU is only
 * safe to use because every frame is sealed before it leaves the browser. Routed
 * through it anyway, a DM call would seal nothing, drop every frame it couldn't
 * seal, and die after MLS_KEY_WAIT_MS. Mesh is not a fallback here but the right
 * answer: a two-party call has no uplink problem to solve, so nothing is given up
 * by keeping the server out of the media path entirely.
 *
 * Frame encryption therefore follows the transport, not the flag. Sealing a mesh
 * DM would add nothing — DTLS-SRTP already makes it end-to-end — so there is no
 * key to establish and no wait before the call connects.
 */
export function sfuFor(groupId: string): boolean {
  return SFU_ENABLED && chat().groups[groupId]?.type === "group";
}
