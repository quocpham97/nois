"use client";

// Voice-note recorder: getUserMedia → MediaRecorder, with the duration and a
// small normalized peaks array computed from the PLAINTEXT recording before it
// is encrypted (recipients render the waveform without decoding the audio).
// The finished File flows through the exact same encryptFile + UploadThing
// path as picked files — the server/CDN only ever hold ciphertext.

import { useCallback, useEffect, useRef, useState } from "react";

/** Recording longer than this auto-stops (opus at ~24kbps ≈ 1MB/5min — far
 *  under the 16MB UploadThing blob cap; the cap here is UX, not size). */
const MAX_SECONDS = 300;
/** Waveform resolution: number of amplitude buckets. */
const PEAK_BUCKETS = 48;

export type VoiceNote = {
  file: File;
  mime: string;
  duration: number;
  peaks?: number[];
};

// Safari records AAC-in-MP4; Chrome/Firefox record webm/opus. Probe in order.
function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

// Decode the recording and bucket absolute sample amplitudes into a small
// normalized array. Best-effort: some Safari builds can't decode their own
// fresh mp4 blobs — the player falls back to a plain progress bar without peaks.
async function computePeaks(
  blob: Blob,
): Promise<{ duration: number; peaks?: number[] }> {
  try {
    const ctx = new AudioContext();
    try {
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      const data = buf.getChannelData(0);
      const per = Math.max(1, Math.floor(data.length / PEAK_BUCKETS));
      const peaks: number[] = [];
      for (let i = 0; i < PEAK_BUCKETS; i++) {
        let sum = 0;
        const start = i * per;
        const end = Math.min(start + per, data.length);
        for (let j = start; j < end; j++) sum += Math.abs(data[j]);
        peaks.push(end > start ? sum / (end - start) : 0);
      }
      const max = Math.max(...peaks, 1e-6);
      return {
        duration: buf.duration,
        peaks: peaks.map((p) => Math.round((p / max) * 100) / 100),
      };
    } finally {
      void ctx.close();
    }
  } catch {
    return { duration: 0 };
  }
}

export function useVoiceRecorder(onFinish: (note: VoiceNote) => void) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  });

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    pickMime() !== null;

  const teardown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const rec = recorderRef.current;
    recorderRef.current = null;
    // Release the microphone (the red "recording" tab indicator).
    rec?.stream.getTracks().forEach((t) => t.stop());
    setRecording(false);
    setElapsed(0);
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    const mime = pickMime();
    if (!mime) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return; // permission denied — the mic button simply does nothing more
    }
    cancelledRef.current = false;
    chunksRef.current = [];
    const rec = new MediaRecorder(stream, { mimeType: mime });
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const wasCancelled = cancelledRef.current;
      const wallSeconds = (Date.now() - startedAtRef.current) / 1000;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      teardown();
      if (wasCancelled || !chunks.length) return;
      const blob = new Blob(chunks, { type: mime });
      void computePeaks(blob).then(({ duration, peaks }) => {
        const ext = mime.startsWith("audio/mp4") ? "m4a" : "webm";
        onFinishRef.current({
          file: new File([blob], `voice-${Date.now()}.${ext}`, { type: mime }),
          mime,
          // decode failure → fall back to the wall-clock length
          duration: duration || Math.round(wallSeconds * 10) / 10,
          peaks,
        });
      });
    };
    startedAtRef.current = Date.now();
    rec.start(250); // small timeslices so cancel/stop never loses buffered audio
    setRecording(true);
    setElapsed(0);
    timerRef.current = setInterval(() => {
      const secs = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(Math.floor(secs));
      if (secs >= MAX_SECONDS) recorderRef.current?.stop();
    }, 250);
  }, [teardown]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    recorderRef.current?.stop();
  }, []);

  // Unmount (group switch) while recording → discard, release the mic.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      recorderRef.current?.stop();
    },
    [],
  );

  return { supported, recording, elapsed, start, stop, cancel };
}
