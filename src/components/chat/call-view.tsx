"use client";

// Call UI: a floating incoming-call card (top-right, non-blocking) and the
// in-call panel (bottom-right) with remote video / voice avatar, local PiP,
// mute/camera/hang-up controls and a duration timer. All state lives in
// call-context; this file is purely presentational plus the ring tones.

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { type User } from "@/lib/chat-data";
import { useCall, type CallInfo } from "./call-context";

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
  return (
    <div className="animate-fade-in fixed right-5 top-5 z-50 w-[320px] rounded-2xl border border-app-border bg-panel-2 p-4 shadow-[var(--app-shadow-lg)]">
      <div className="flex items-center gap-3">
        <PeerAvatar user={call.peer} size={44} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold text-app-text">
            {call.peer.name}
          </div>
          <div className="text-[12.5px] text-app-muted">
            Incoming {call.video ? "video" : "voice"} call…
          </div>
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

function CallPanel({ call }: { call: CallInfo }) {
  const {
    localStream,
    remoteStream,
    micOn,
    camOn,
    endCall,
    toggleMic,
    toggleCam,
  } = useCall();
  const ringing = call.phase === "outgoing";
  useRingTone(ringing ? "outgoing" : null);
  const status =
    call.phase === "outgoing" ? (
      "Ringing…"
    ) : call.phase === "connecting" ? (
      "Connecting…"
    ) : call.startedAt ? (
      <CallTimer startedAt={call.startedAt} />
    ) : (
      ""
    );

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

  if (call.video) {
    return (
      <div className="animate-fade-in fixed bottom-5 right-5 z-50 w-[400px] overflow-hidden rounded-2xl border border-app-border bg-black shadow-[var(--app-shadow-lg)]">
        <div className="relative aspect-video">
          {remoteStream && call.phase === "active" ? (
            <StreamVideo
              stream={remoteStream}
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <PeerAvatar user={call.peer} size={64} />
            </div>
          )}
          <StreamVideo
            stream={localStream}
            muted
            mirror
            className="absolute bottom-3 right-3 w-[104px] rounded-lg border border-white/20 object-cover"
          />
          <div className="absolute left-3 top-3 rounded-full bg-black/50 px-3 py-1 text-[12.5px] font-semibold text-white">
            {call.peer.name}
            <span className="ml-2 font-normal text-white/70">{status}</span>
          </div>
        </div>
        <div className="bg-black/90 py-3">{controls}</div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in fixed bottom-5 right-5 z-50 w-[300px] rounded-2xl border border-app-border p-5 shadow-[var(--app-shadow-lg)]"
      style={{ background: "#1c1e21" }}
    >
      <StreamAudio stream={remoteStream} />
      <div className="flex flex-col items-center gap-2 pb-5 pt-2">
        <PeerAvatar user={call.peer} size={72} />
        <div className="text-[16px] font-bold text-white">{call.peer.name}</div>
        <div className="text-[13px] text-white/60">{status}</div>
      </div>
      {controls}
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
