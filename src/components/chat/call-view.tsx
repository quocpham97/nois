"use client";

// Call UI: a floating incoming-call card (top-right, non-blocking) and the
// in-call panel (bottom-right) with remote video / voice avatar, local PiP,
// mute/camera/hang-up controls and a duration timer. All state lives in
// call-context; this file is purely presentational plus the ring tones.

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { type User } from "@/lib/chat-data";
import {
  useCall,
  type CallInfo,
  type CallParticipant,
} from "./call-context";

/** Attach a MediaStream to a <video>. `mirror` for the self-view. */
function StreamVideo({
  stream,
  muted = false,
  mirror = false,
  className,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`${className ?? ""} ${mirror ? "-scale-x-100" : ""}`}
    />
  );
}

/** Hidden sink so voice-call audio plays without a video element. */
function StreamAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
  }, [stream]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

// Synthesized ring tones (no audio assets): an incoming two-tone chime and an
// outgoing single ringback tone, looped. Best-effort — if the browser's
// autoplay policy suspends the AudioContext (no prior gesture), the call
// still rings visually.
function useRingTone(kind: "incoming" | "outgoing" | null) {
  useEffect(() => {
    if (!kind) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    void ctx.resume().catch(() => {});
    const beep = (freq: number, at: number, dur: number, vol: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(vol, at + 0.03);
      gain.gain.setValueAtTime(vol, at + dur - 0.05);
      gain.gain.linearRampToValueAtTime(0, at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + dur);
    };
    const ring = () => {
      const t = ctx.currentTime + 0.05;
      if (kind === "incoming") {
        beep(880, t, 0.3, 0.07);
        beep(660, t + 0.4, 0.3, 0.07);
      } else {
        beep(440, t, 1.2, 0.04);
      }
    };
    ring();
    const iv = setInterval(ring, kind === "incoming" ? 2500 : 4000);
    return () => {
      clearInterval(iv);
      void ctx.close().catch(() => {});
    };
  }, [kind]);
}

function PeerAvatar({ user, size }: { user: User; size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        background: user.bg,
        width: size,
        height: size,
        fontSize: size * 0.38,
      }}
    >
      {user.initials}
    </span>
  );
}

function CallTimer({ startedAt }: { startedAt: number }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const update = () =>
      setSecs(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [startedAt]);
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");
  return (
    <span className="font-mono tabular-nums">
      {mm >= 60 ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}:${ss}` : `${mm}:${ss}`}
    </span>
  );
}

function ControlButton({
  onClick,
  title,
  active = true,
  danger = false,
  children,
}: {
  onClick: () => void;
  title: string;
  /** Inactive = the "off" state (muted mic / camera off) — shown filled white. */
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex size-11 items-center justify-center rounded-full transition-colors"
      style={
        danger
          ? { background: "var(--app-red)", color: "#fff" }
          : active
            ? { background: "rgba(255,255,255,0.18)", color: "#fff" }
            : { background: "#fff", color: "#111" }
      }
    >
      {children}
    </button>
  );
}

function IncomingCallCard({ call }: { call: CallInfo }) {
  const { acceptCall, declineCall } = useCall();
  useRingTone("incoming");
  // In a group the caller and the conversation are different things, and you
  // need both to decide whether to pick up.
  const subtitle =
    call.kind === "group"
      ? `${call.starter.name} · ${call.video ? "video" : "voice"} call`
      : `Incoming ${call.video ? "video" : "voice"} call…`;
  return (
    <div className="animate-fade-in fixed right-5 top-5 z-50 w-[320px] rounded-2xl border border-app-border bg-panel-2 p-4 shadow-[var(--app-shadow-lg)]">
      <div className="flex items-center gap-3">
        <PeerAvatar user={call.starter} size={44} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold text-app-text">
            {call.title}
          </div>
          <div className="truncate text-[12.5px] text-app-muted">{subtitle}</div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={declineCall}
          className="flex flex-1 items-center justify-center gap-2 rounded-full py-2 text-[13px] font-semibold text-white"
          style={{ background: "var(--app-red)" }}
        >
          <PhoneOff size={15} /> Decline
        </button>
        <button
          onClick={() => void acceptCall()}
          className="flex flex-1 items-center justify-center gap-2 rounded-full py-2 text-[13px] font-semibold text-white"
          style={{ background: "var(--app-green)" }}
        >
          {call.video ? <Video size={15} /> : <Phone size={15} />} Accept
        </button>
      </div>
    </div>
  );
}

/** One remote participant: their video if it's a video call, else their avatar. */
function ParticipantTile({
  p,
  video,
}: {
  p: CallParticipant;
  video: boolean;
}) {
  return (
    <div
      data-participant={p.deviceId}
      data-connected={p.connected ? "1" : "0"}
      className="relative overflow-hidden rounded-xl bg-black/60"
      style={{ aspectRatio: "4 / 3" }}
    >
      {video && p.stream && p.connected ? (
        // Not muted: in a video call the remote audio rides these elements.
        <StreamVideo stream={p.stream} className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <PeerAvatar user={p.user} size={44} />
          {/* Voice call (or video not up yet) — the audio sink lives here. */}
          {!video && <StreamAudio stream={p.stream} />}
        </div>
      )}
      <div className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-12px)] truncate rounded-full bg-black/55 px-2 py-0.5 text-[11.5px] font-semibold text-white">
        {p.user.name.split(" ")[0]}
        {!p.connected && <span className="ml-1.5 font-normal text-white/60">connecting…</span>}
      </div>
    </div>
  );
}

function CallPanel({ call }: { call: CallInfo }) {
  const { localStream, micOn, camOn, endCall, toggleMic, toggleCam } = useCall();
  const ringing = call.phase === "outgoing";
  useRingTone(ringing ? "outgoing" : null);
  const peers = call.participants;
  const status =
    call.phase === "outgoing"
      ? call.kind === "group"
        ? "Waiting for others…"
        : "Ringing…"
      : call.phase === "connecting"
        ? "Connecting…"
        : call.startedAt
          ? undefined // the timer renders instead
          : "";

  const controls = (
    <div className="flex items-center justify-center gap-3">
      <ControlButton
        onClick={toggleMic}
        title={micOn ? "Mute microphone" : "Unmute microphone"}
        active={micOn}
      >
        {micOn ? <Mic size={19} /> : <MicOff size={19} />}
      </ControlButton>
      {call.video && (
        <ControlButton
          onClick={toggleCam}
          title={camOn ? "Turn camera off" : "Turn camera on"}
          active={camOn}
        >
          {camOn ? <Video size={19} /> : <VideoOff size={19} />}
        </ControlButton>
      )}
      <ControlButton onClick={endCall} title="End call" danger>
        <PhoneOff size={19} />
      </ControlButton>
    </div>
  );

  // The panel is a floating card, so it grows with the mesh rather than shrinking
  // everyone to thumbnails: one column for a 1:1, two or three for a group.
  const cols = peers.length <= 1 ? 1 : peers.length <= 4 ? 2 : 3;
  const width = peers.length <= 1 ? 400 : peers.length <= 4 ? 520 : 620;
  const headline = (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="truncate text-[13px] font-semibold text-white">{call.title}</span>
      <span className="shrink-0 text-[12px] font-normal text-white/70">
        {status ?? (call.startedAt ? <CallTimer startedAt={call.startedAt} /> : null)}
      </span>
      {call.kind === "group" && peers.length > 0 && (
        <span className="shrink-0 text-[12px] font-normal text-white/70">
          · {peers.length + 1} on the call
        </span>
      )}
    </div>
  );

  return (
    <div
      className="animate-fade-in fixed bottom-5 right-5 z-50 max-w-[calc(100vw-40px)] overflow-hidden rounded-2xl border border-app-border shadow-[var(--app-shadow-lg)]"
      style={{ width, background: "#1c1e21" }}
    >
      <div className="px-4 pb-1 pt-3">{headline}</div>
      <div className="p-3">
        {peers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <PeerAvatar user={call.kind === "dm" ? call.starter : call.starter} size={72} />
            <div className="text-[13px] text-white/60">
              {ringing
                ? call.kind === "group"
                  ? "Nobody has joined yet"
                  : "Ringing…"
                : "Connecting…"}
            </div>
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {peers.map((p) => (
              <ParticipantTile key={p.deviceId} p={p} video={call.video} />
            ))}
          </div>
        )}
        {call.video && (
          <div className="mt-2 flex justify-end">
            <StreamVideo
              stream={localStream}
              muted
              mirror
              className="w-[104px] rounded-lg border border-white/20 object-cover"
            />
          </div>
        )}
      </div>
      <div className="bg-black/40 py-3">{controls}</div>
    </div>
  );
}

/** Mounted once in the Shell — renders whichever call surface applies. */
export function CallUI() {
  const { call } = useCall();
  if (!call) return null;
  if (call.phase === "incoming") return <IncomingCallCard call={call} />;
  return <CallPanel call={call} />;
}
