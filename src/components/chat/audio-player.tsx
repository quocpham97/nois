"use client";

// Voice-note player. The audio rides the E2EE attachment pipeline (ciphertext
// on the CDN; key/iv arrive via the message envelope), so playback follows the
// encrypted-image pattern: fetch ciphertext through the same-origin proxy,
// decrypt locally, feed an object URL into an <audio>. Decryption is LAZY (on
// first play) so scrollback full of voice notes doesn't download everything.

import { useEffect, useRef, useState } from "react";
import { Lock, Pause, Play } from "lucide-react";
import type { Attachment } from "@/lib/chat-data";
import { decryptToBlob } from "@/lib/crypto/attachment";

const BAR_COUNT = 48;

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AudioPlayer({ a }: { a: Attachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [current, setCurrent] = useState(0);
  // Element-reported duration (fallback when the attachment carries none).
  const [mediaDuration, setMediaDuration] = useState(0);

  // The envelope hasn't delivered the key yet (message still decrypting).
  const keyPending = !!a.encrypted && !(a.key && a.iv);

  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src);
    },
    [src],
  );

  const ensureSrc = async (): Promise<string | null> => {
    if (src) return src;
    if (!a.url) return null;
    if (!a.encrypted) return a.url; // plaintext (legacy fallback) — direct
    if (!a.key || !a.iv) return null;
    setLoading(true);
    try {
      const res = await fetch("/api/attachment?u=" + encodeURIComponent(a.url));
      if (!res.ok) throw new Error("proxy fetch failed");
      const blob = await decryptToBlob(await res.arrayBuffer(), a.key, a.iv, a.mime);
      const obj = URL.createObjectURL(blob);
      setSrc(obj);
      return obj;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    const el = audioRef.current;
    if (!el || failed || keyPending) return;
    if (playing) {
      el.pause();
      return;
    }
    const s = await ensureSrc();
    if (!s) return;
    if (el.src !== s) el.src = s;
    void el.play();
  };

  const seek = (frac: number) => {
    const el = audioRef.current;
    if (!el || !el.src || !isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(1, frac)) * el.duration;
  };

  const duration = a.duration ?? mediaDuration;
  const peaks =
    a.peaks && a.peaks.length ? a.peaks : Array(BAR_COUNT).fill(0.45);
  const label = failed
    ? "Unable to decrypt"
    : keyPending
      ? "Encrypted audio"
      : `${fmtTime(playing || current > 0 ? current : duration)}${loading ? " · …" : ""}`;

  return (
    <div className="mt-1.5 flex max-w-[320px] items-center gap-2.5 rounded-2xl border border-app-border bg-panel-2 py-2 pl-2 pr-3">
      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          setCurrent(0);
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (isFinite(d) && d > 0) setMediaDuration(d);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setCurrent(el.currentTime);
          if (isFinite(el.duration) && el.duration > 0) {
            setProgress(el.currentTime / el.duration);
          }
        }}
      />
      <button
        onClick={toggle}
        title={playing ? "Pause" : "Play voice message"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-white"
        style={{
          background:
            failed || keyPending ? "var(--panel-hover)" : "var(--sent-grad, var(--app-accent))",
          color: failed || keyPending ? "var(--app-faint)" : "#fff",
          cursor: failed || keyPending ? "not-allowed" : "pointer",
        }}
      >
        {keyPending || failed ? (
          <Lock size={14} strokeWidth={1.8} />
        ) : playing ? (
          <Pause size={15} strokeWidth={2} fill="currentColor" />
        ) : (
          <Play size={15} strokeWidth={2} fill="currentColor" className="ml-0.5" />
        )}
      </button>
      {/* waveform: clickable bars; filled portion tracks playback */}
      <div
        className="flex h-8 flex-1 cursor-pointer items-center gap-[2px]"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - r.left) / r.width);
        }}
      >
        {peaks.map((p, i) => (
          <span
            key={i}
            className="min-w-[2px] flex-1 rounded-full"
            style={{
              height: `${Math.max(12, p * 100)}%`,
              background:
                i / peaks.length <= progress && progress > 0
                  ? "var(--app-accent)"
                  : "var(--border-strong, var(--app-border))",
            }}
          />
        ))}
      </div>
      <span className="shrink-0 text-[11.5px] tabular-nums text-app-muted">
        {label}
      </span>
    </div>
  );
}
