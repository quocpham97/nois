/**
 * Who a message @-mentions, derived from its text.
 *
 * A mention serializes to "@Name" (see lexical/MentionNode.ts) and the server
 * derives the same list by the same rule — but only from text it can read, and
 * every real send reaches it as an empty string beside a sealed envelope. So
 * for an E2EE message this pass, on the recipient's own device once it opens
 * the envelope, is the only one that ever produces anything: both the mentions
 * panel and the level-1 notification rule read what it finds.
 */

/** Does this text @-mention `name`? Mirrors deriveMentions in server/store.ts. */
export function mentionsName(text: string | undefined, name: string): boolean {
  if (!text || !name) return false;
  return text.includes("@" + name);
}

/** Which of `names` this text mentions — the shape the `mentions` field holds. */
export function mentionedNames(
  text: string | undefined,
  names: string[],
): string[] {
  if (!text || !text.includes("@")) return [];
  return names.filter((n) => n && text.includes("@" + n));
}

/**
 * Is the viewer mentioned by this message? Prefers the derived list and falls
 * back to the raw text, so a message stored before the list existed — or one
 * whose sender the roster doesn't know — still reads correctly.
 */
export function isMentioned(
  m: { text?: string; mentions?: string[] },
  selfName: string,
): boolean {
  if (!selfName) return false;
  return m.mentions?.includes(selfName) || mentionsName(m.text, selfName);
}
