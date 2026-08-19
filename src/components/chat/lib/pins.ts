/**
 * Pin resolution: the server holds only pinned message ids, so each one has to
 * be resolved to a display snippet from what this device actually holds.
 */
import * as msgdb from "@/lib/message-db";
import type { Message, Pinned } from "@/lib/chat-data";

// The server holds only pinned message ids; resolve each to a display snippet.
// The local store comes first, then whatever the group has in memory: a client
// whose store is unavailable (see message-db.ts) holds its messages only in
// state, and store-only resolution left it with no pins at all. A message that
// is still encrypted resolves to nothing so a later pass can pick it up once
// the decrypt effect has run.
export async function resolvePins(
  pinIds: string[],
  lookup?: (id: string) => Message | undefined,
): Promise<Pinned[]> {
  const out: Pinned[] = [];
  for (const id of pinIds) {
    const m = (await msgdb.getMessage(id)) ?? lookup?.(id);
    if (m && (m.text || !m.enc)) out.push({ id, author: m.author, text: m.text });
  }
  return out;
}

