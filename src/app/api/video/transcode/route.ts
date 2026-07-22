import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auth } from "@/auth";
import { ensureSchema, getPool } from "@/lib/db";

export const runtime = "nodejs";

const MAX_BYTES = 64 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".jpg": "image/jpeg",
};

/** Spawn a process and resolve with stdout, or reject on non-zero exit. */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${bin} exited ${code}: ${err.slice(-600)}`)),
    );
  });
}

// Transcode an uploaded video to an adaptive HLS ladder (720p + 360p). Video is
// PLAINTEXT (not E2EE) — adaptive streaming requires the transcoder to read the
// raw video. Returns the master-playlist + poster URLs and dimensions.
export async function POST(req: Request) {
  const session = await auth();
  if (!(session?.user as { id?: string } | undefined)?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.type.startsWith("video/")) {
    return new Response("Expected a video file", { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return new Response("Video too large (max 64MB)", { status: 413 });
  }

  const id = randomUUID();
  // ffmpeg must write to a filesystem; we transcode into a temp dir, ingest the
  // output into Postgres, then delete the temp dir (DB is the source of truth).
  const out = path.join(os.tmpdir(), `hls-${id}`);
  const tmp = path.join(os.tmpdir(), `upload-${id}`);
  await mkdir(out, { recursive: true });
  await writeFile(tmp, Buffer.from(await file.arrayBuffer()));

  try {
    // Probe dimensions/duration + whether there's an audio track.
    const probe = JSON.parse(
      await run("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=width,height,codec_type",
        "-show_entries", "format=duration",
        "-of", "json",
        tmp,
      ]),
    ) as {
      streams?: { width?: number; height?: number; codec_type?: string }[];
      format?: { duration?: string };
    };
    const v = probe.streams?.find((s) => s.codec_type === "video");
    const hasAudio = !!probe.streams?.some((s) => s.codec_type === "audio");
    const width = v?.width;
    const height = v?.height;
    const duration = probe.format?.duration
      ? Math.round(Number(probe.format.duration))
      : undefined;

    // Adaptive ladder: split → scale to 720p/360p (aspect-preserving), one audio
    // copy per variant when present. Command validated against ffmpeg 8.1.2.
    await run("ffmpeg", [
      "-y", "-i", tmp,
      "-filter_complex",
      "[0:v]split=2[v1][v2];[v1]scale=-2:720[v1out];[v2]scale=-2:360[v2out]",
      "-map", "[v1out]", "-map", "[v2out]",
      ...(hasAudio ? ["-map", "a:0", "-map", "a:0"] : []),
      "-c:v", "libx264", "-crf", "21", "-preset", "veryfast",
      ...(hasAudio ? ["-c:a", "aac", "-ar", "48000"] : []),
      "-hls_time", "4",
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", path.join(out, "v%v_seg%d.ts"),
      "-master_pl_name", "master.m3u8",
      "-var_stream_map",
      hasAudio
        ? "v:0,a:0,name:720p v:1,a:1,name:360p"
        : "v:0,name:720p v:1,name:360p",
      path.join(out, "v%v.m3u8"),
    ]);

    // Poster from the first frame.
    await run("ffmpeg", [
      "-y", "-i", tmp,
      "-vf", "scale=-2:480",
      "-frames:v", "1",
      path.join(out, "poster.jpg"),
    ]);

    // Ingest every output file into Postgres, keyed "<id>/<filename>" (matches
    // the /api/hls/<id>/<file> request paths). Playlists reference siblings by
    // bare filename, so this flat layout serves correctly.
    await ensureSchema();
    const pool = getPool();
    const files = await readdir(out);
    // Ingest ONE segment at a time. A parallel Promise.all here read every
    // output file into memory at once AND (with the 5-connection pool) queued
    // the excess pool.query calls, each retaining its full file Buffer — a
    // re-encoded HLS ladder can total more than the 64MB source, so that
    // buffered the whole thing in the heap and OOM'd the shared ws/Next process.
    // Sequential keeps only one segment buffer resident at a time.
    for (const name of files) {
      const bytes = await readFile(path.join(out, name));
      await pool.query(
        `INSERT INTO media_file (key, mime, bytes) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes`,
        [`${id}/${name}`, MIME[path.extname(name)] ?? "application/octet-stream", bytes],
      );
    }

    return Response.json({
      id,
      hls: `/api/hls/${id}/master.m3u8`,
      poster: `/api/hls/${id}/poster.jpg`,
      width,
      height,
      duration,
    });
  } catch (e) {
    return new Response(`Transcode failed: ${(e as Error).message}`, {
      status: 500,
    });
  } finally {
    await unlink(tmp).catch(() => {});
    await rm(out, { recursive: true, force: true }).catch(() => {});
  }
}
