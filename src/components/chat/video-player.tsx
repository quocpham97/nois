"use client";

import { useEffect, useRef } from "react";
import type Hls from "hls.js";
import type { Attachment } from "@/lib/chat-data";

// Inline HLS player for video attachments. Uses native HLS where the browser
// supports it (Safari/iOS), otherwise lazy-loads hls.js (browser-only, kept out
// of the main bundle). The source is an HLS master playlist (/api/hls/<id>/…).
export function VideoPlayer({ a }: { a: Attachment }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !a.url) return;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = a.url;
      return;
    }
    let hls: Hls | null = null;
    let cancelled = false;
    void import("hls.js").then(({ default: HlsCtor }) => {
      if (cancelled || !ref.current) return;
      if (HlsCtor.isSupported()) {
        hls = new HlsCtor();
        hls.loadSource(a.url!);
        hls.attachMedia(ref.current);
      } else {
        ref.current.src = a.url!;
      }
    });
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [a.url]);

  const ratio = a.width && a.height ? `${a.width} / ${a.height}` : "16 / 9";
  return (
    <video
      ref={ref}
      controls
      playsInline
      preload="metadata"
      poster={a.poster}
      className="mt-1.5 w-full max-w-[480px] rounded-lg border border-app-border bg-black"
      style={{ aspectRatio: ratio }}
    />
  );
}
