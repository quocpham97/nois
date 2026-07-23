import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { auth } from "@/auth";

// Sender-side unfurl proxy for link previews. The SENDER's browser calls this
// once while composing (browser CORS blocks fetching arbitrary pages directly);
// the resulting preview travels to recipients ONLY inside the E2EE envelope, so
// they never fetch anything and the server never learns which message/group
// carries the URL. This endpoint is the deliberate, opt-in residual leak of the
// design (the server sees "this user fetched this URL once") — so it must never
// log the URL, forward credentials upstream, or be reachable unauthenticated.
//
// Modes: default returns extracted OpenGraph metadata as JSON; `&image=1`
// proxies the og:image bytes (so the composer can canvas-downscale it) with a
// hard size cap.

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Private/loopback/link-local/CGNAT ranges — SSRF targets, never fetched.
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    return (
      low === "::1" ||
      low === "::" ||
      low.startsWith("fc") ||
      low.startsWith("fd") ||
      low.startsWith("fe80") ||
      // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
      (low.startsWith("::ffff:") && isPrivateIp(low.slice(7)))
    );
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Reject non-http(s) URLs and anything resolving to a private/local address. */
async function validateTarget(target: URL): Promise<boolean> {
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;
  if (target.username || target.password) return false;
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  if (isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

/** Follow ≤MAX_REDIRECTS manually, re-validating EVERY hop (a public host may
 *  redirect to an internal address — each location gets the same SSRF check). */
async function guardedFetch(
  start: URL,
  accept: string,
): Promise<Response | null> {
  let target = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await validateTarget(target))) return null;
    const res = await fetch(target.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept,
        // A recognizable bot UA (many sites gate OG tags on it) — and no
        // cookies/credentials of any kind are ever forwarded.
        "user-agent": "Mozilla/5.0 (compatible; chat-app-unfurl/1.0)",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      try {
        target = new URL(loc, target);
      } catch {
        return null;
      }
      continue;
    }
    return res.ok ? res : null;
  }
  return null;
}

/** Read a body up to `cap` bytes (a huge page/image can't buffer unbounded). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      void reader.cancel();
      // For HTML we can still parse what we have (OG tags live in <head>);
      // callers decide. Return the truncated bytes.
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, out.length - off));
    out.set(slice, off);
    off += slice.length;
    if (off >= out.length) break;
  }
  return out;
}

const metaRe = (names: string) =>
  new RegExp(
    `<meta[^>]+(?:property|name)=["'](?:${names})["'][^>]*?content=["']([^"']*)["']` +
      `|<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["'](?:${names})["']`,
    "i",
  );

function pick(html: string, names: string): string | undefined {
  const m = html.match(metaRe(names));
  const v = (m?.[1] ?? m?.[2])?.trim();
  return v ? decodeEntities(v) : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

// POST (not GET) so the target URL travels in the request BODY, never the
// request line — otherwise it would land in server/proxy access logs even
// though this handler itself never logs it (the residual-leak mitigation).
export async function POST(req: Request) {
  const session = await auth();
  if (!(session?.user as { id?: string } | undefined)?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  let raw: string | undefined;
  let imageMode = false;
  try {
    const body = (await req.json()) as { url?: string; image?: boolean };
    raw = body.url;
    imageMode = body.image === true;
  } catch {
    return new Response("Bad body", { status: 400 });
  }
  if (!raw) return new Response("Missing url", { status: 400 });
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Bad url", { status: 400 });
  }

  // Image mode: proxy the og:image bytes so the sender's canvas can read them
  // cross-origin. Same SSRF guards; hard byte cap; image/* only.
  if (imageMode) {
    const res = await guardedFetch(target, "image/*").catch(() => null);
    if (!res) return new Response("Fetch failed", { status: 502 });
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return new Response("Not an image", { status: 415 });
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_IMAGE_BYTES) return new Response("Too large", { status: 413 });
    const bytes = await readCapped(res, MAX_IMAGE_BYTES);
    if (!bytes) return new Response("Fetch failed", { status: 502 });
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": type, "Cache-Control": "private, max-age=300" },
    });
  }

  const res = await guardedFetch(target, "text/html,application/xhtml+xml").catch(
    () => null,
  );
  if (!res) return new Response("Fetch failed", { status: 502 });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/html") && !type.includes("application/xhtml")) {
    return new Response("Not a page", { status: 415 });
  }
  const bytes = await readCapped(res, MAX_HTML_BYTES);
  if (!bytes) return new Response("Fetch failed", { status: 502 });
  const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  const title =
    pick(html, "og:title|twitter:title") ??
    decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "");
  if (!title) return new Response("No preview", { status: 404 });
  const description = pick(html, "og:description|twitter:description|description");
  const siteName = pick(html, "og:site_name");
  let image = pick(html, "og:image|og:image:url|twitter:image");
  if (image) {
    try {
      image = new URL(image, res.url || target).toString();
    } catch {
      image = undefined;
    }
  }

  return Response.json(
    {
      url: target.toString(),
      title: title.slice(0, 300),
      description: description?.slice(0, 500),
      siteName: siteName?.slice(0, 100),
      image,
    },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
