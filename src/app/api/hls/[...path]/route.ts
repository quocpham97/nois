import { ensureSchema, getPool } from "@/lib/db";

export const runtime = "nodejs";

// Serve transcoded HLS (master/variant playlists, .ts segments, poster) from
// Postgres. Rows are keyed "<id>/<filename>"; the catch-all path maps straight
// to that key. Content is plaintext video (no auth), like a public CDN.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: parts } = await params;
  const key = parts.join("/");
  try {
    await ensureSchema();
    const { rows } = await getPool().query<{ mime: string; bytes: Buffer }>(
      "SELECT mime, bytes FROM media_file WHERE key = $1",
      [key],
    );
    if (!rows.length) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(rows[0].bytes), {
      headers: {
        "Content-Type": rows[0].mime,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Server error", { status: 500 });
  }
}
