/**
 * URL <-> conversation mapping and the nav-panel route table. Pure functions:
 * the routing hook owns the effects, this module owns the vocabulary.
 */
import type { NavPanel } from "./types";

// The nav panels route as top-level paths, e.g. /drafts. They replace the
// conversation view but don't carry a conversation id. `people` and `archived`
// are the Messenger rail destinations; the rest live in the Chats options menu.
export const NAV_PANELS = [
  "mentions",
  "drafts",
  "people",
  "archived",
] as const;
export function pathToPanel(pathname: string): NavPanel | null {
  const seg = pathname.replace(/^\/+|\/+$/g, "");
  return (NAV_PANELS as readonly string[]).includes(seg)
    ? (seg as NavPanel)
    : null;
}

// Top-level paths that belong to their own routes, never to a conversation.
// A conversation whose id equals one of these would be shadowed by that route.
export const RESERVED_SEGMENTS = new Set<string>(["settings", ...NAV_PANELS]);

// URL <-> conversation-id mapping. Every conversation — group or DM — lives at
// the root as /<id>; there is no /c or /dm prefix and the id carries no type
// marker (ch.type is the sole group/DM discriminator). The empty id (no
// selection) is the app root "/".
export function idToPath(id: string): string {
  return id ? "/" + encodeURIComponent(id) : "/";
}
export function pathToId(pathname: string): string {
  const seg = pathname.replace(/^\/+|\/+$/g, "");
  if (!seg || seg.includes("/") || RESERVED_SEGMENTS.has(seg)) return "";
  return decodeURIComponent(seg);
}
