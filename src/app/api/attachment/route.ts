import { auth } from "@/auth";

// Same-origin proxy for downloading encrypted attachment ciphertext. UploadThing's
// CDN (*.ufs.sh) sends no CORS headers, so the browser can't `fetch()` the bytes
// cross-origin to decrypt them — it routes the read through here instead. The
// bytes are ciphertext, so this server still never sees plaintext.
export async function GET(req: Request) {
  const session = await auth();
  if (!(session?.user as { id?: string } | undefined)?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const raw = new URL(req.url).searchParams.get("u");
  if (!raw) return new Response("Missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Bad url", { status: 400 });
  }
  // SSRF guard: only proxy UploadThing's CDN over https.
  if (target.protocol !== "https:" || !target.hostname.endsWith(".ufs.sh")) {
    return new Response("Forbidden host", { status: 403 });
  }

  const upstream = await fetch(target.toString());
  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream error", { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
