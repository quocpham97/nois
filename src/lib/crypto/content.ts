// Shared codec for the plaintext sealed inside every E2EE envelope. All three
// schemes (DM pairwise in session.ts, group sender-key in group.ts, MLS in
// mls.ts) encrypt exactly these bytes, so the content shape is defined once:
// adding an optional MessageContent field automatically reaches all of them.
//
// Wire compatibility: fields absent from old envelopes decode as undefined and
// unknown fields from newer senders survive JSON.parse untouched — so this
// codec can gain optional fields without a version bump (see MessageContent).

import type { MessageContent } from "./types";

export function encodeContent(c: MessageContent): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      text: c.text,
      rich: c.rich ?? null,
      att: c.att ?? null,
      preview: c.preview ?? null,
      replyTo: c.replyTo ?? null,
      forwarded: c.forwarded ?? null,
    }),
  );
}

export function decodeContent(pt: ArrayBuffer | Uint8Array): MessageContent {
  const obj = JSON.parse(
    new TextDecoder().decode(pt),
  ) as Partial<Record<keyof MessageContent, unknown>>;
  return {
    text: typeof obj.text === "string" ? obj.text : "",
    rich: (obj.rich as string | null | undefined) ?? undefined,
    att: (obj.att as MessageContent["att"]) ?? undefined,
    preview: (obj.preview as MessageContent["preview"]) ?? undefined,
    replyTo: (obj.replyTo as MessageContent["replyTo"]) ?? undefined,
    forwarded: typeof obj.forwarded === "boolean" ? obj.forwarded : undefined,
  };
}
