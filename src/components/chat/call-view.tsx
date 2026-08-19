"use client";

// Call UI, following the comp (`Messenger Chat.dc.html`), which draws two
// distinct surfaces rather than one that grows:
//
//   * A DOCKED CARD (bottom-right, non-blocking) for every state where the call
//     hasn't connected — placing one and receiving one. You can keep reading the
//     conversation while it rings, which is the whole point of it being a card.
//   * A FULL-SCREEN PANEL once media is up, because at that point the call *is*
//     what you're doing.
//
// The panel can also be popped into its own window, the way Messenger does —
// see call-window.tsx for why that's a portal rather than a second route.
//
// All state lives in call-context; this file is presentational plus ring tones.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  SquareArrowOutUpRight,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { type User } from "@/lib/chat-data";
import { useCallStore } from "@/stores/call-store";
import { useCallActions } from "./call-actions";
import type { CallInfo, CallParticipant } from "./lib/call-types";
import { useCallPopout } from "./call-window";

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

/**
 * Round call control, per the comp: translucent + blurred over the call
 * backdrop, growing slightly on hover. The "off" state (muted mic, camera off)
 * inverts to solid white, and the hang-up button is bigger and red.
 */
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
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: danger ? 64 : 58,
        height: danger ? 64 : 58,
        backdropFilter: "blur(8px)",
        transition: "transform 0.12s, background 0.15s",
        transform: hover ? "scale(1.08)" : "none",
        ...(danger
          ? { background: hover ? "#d81f36" : "#F4364C", color: "#fff" }
          : active
            ? {
                background: hover ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.14)",
                color: "#fff",
              }
            : { background: hover ? "#f0f0f0" : "#fff", color: "#111" }),
      }}
    >
      {children}
    </button>
  );
}

/** Expanding rings behind the avatar while a call is still ringing. */
function RingPulse() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute inset-0 rounded-full"
          style={{
            border: "2px solid rgba(255,255,255,0.4)",
            animation: `callRing 2s ${i * 0.6}s ease-out infinite`,
          }}
        />
      ))}
    </>
  );
}

/** Small equalizer under a connected voice call, so silence still looks live. */
function VoiceBars() {
  return (
    <div className="mt-1 flex h-5 items-center gap-[3px]">
      {[0.1, 0.4, 0.7, 0.3, 0.55, 0.2].map((d, i) => (
        <span
          key={i}
          className="block rounded-sm"
          style={{
            width: 3.5,
            height: 20,
            background: "var(--app-accent)",
            transformOrigin: "center",
            animation: `barsPulse ${0.7 + d}s ${i * 0.12}s ease-in-out infinite`,
          }}
        />
      ))}
    </div>
  );
}

/** The card's own rings — tighter and slower than the panel's, and green while
 *  a call is coming in so "someone wants you" reads before any text does. */
function CardRings({ incoming }: { incoming: boolean }) {
  return (
    <>
      {[0, 1].map((i) => (
        <span
          key={i}
          className="pointer-events-none absolute rounded-full"
          style={{
            inset: -3,
            border: `2px solid ${incoming ? "rgba(49,162,76,0.55)" : "rgba(255,255,255,0.35)"}`,
            animation: `callRing 1.9s ${i * 0.75}s ease-out infinite`,
          }}
        />
      ))}
    </>
  );
}

/** One of the card's paired actions, per the comp: full-width halves, pill
 *  shaped, lifting slightly on hover. */
function DockButton({
  onClick,
  label,
  title,
  icon,
  background,
  color = "#fff",
}: {
  onClick: () => void;
  label: string;
  /** Defaults to the label; spelled out where the label is a bare verb. */
  title?: string;
  icon?: React.ReactNode;
  background: string;
  color?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex flex-1 items-center justify-center gap-[9px] text-[15px]"
      style={{
        height: 46,
        borderRadius: 23,
        fontWeight: 650,
        background,
        color,
        transition: "transform .12s, filter .15s",
        transform: hover ? "translateY(-1px)" : "none",
        filter: hover ? "brightness(1.08)" : "none",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The pre-connection surface for BOTH directions, per the comp's
 * `renderCallCard`: a docked card rather than a takeover, so a ringing call
 * never hides the conversation it's about.
 *
 * Receiving offers Decline / Accept; placing offers Mute / End, because those
 * are the only two things worth doing while you wait.
 */
function CallDock({ call }: { call: CallInfo }) {
  const micOn = useCallStore((s) => s.micOn);
  const { acceptCall, declineCall, endCall, toggleMic } = useCallActions();
  const incoming = call.phase === "incoming";
  useRingTone(incoming ? "incoming" : "outgoing");

  // In a group the caller and the conversation are different things, and you
  // need both to decide whether to pick up.
  const subtitle = incoming
    ? call.kind === "group"
      ? `${call.starter.name} · ${call.video ? "video" : "voice"} call`
      : `Incoming ${call.video ? "video" : "voice"} call…`
    : call.kind === "group"
      ? "Waiting for others…"
      : call.video
        ? "Ringing…"
        : "Calling…";

  return (
    <div
      data-call-dock={incoming ? "incoming" : "outgoing"}
      className="fixed z-[400] flex flex-col"
      style={{
        bottom: 26,
        right: 26,
        width: 352,
        padding: 18,
        gap: 16,
        borderRadius: 26,
        background: "rgba(30,31,34,0.97)",
        backdropFilter: "blur(18px)",
        border: "1px solid rgba(255,255,255,0.09)",
        boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        animation: "fadeUp .22s ease-out",
      }}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <div className="relative flex shrink-0">
          <CardRings incoming={incoming} />
          <PeerAvatar user={call.peer ?? call.starter} size={52} />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="truncate text-[16.5px] font-bold text-white">{call.title}</div>
          <div className="truncate text-[13.5px] text-white/60">{subtitle}</div>
        </div>
        <span className="ml-auto shrink-0 text-white/35">
          {call.video ? <Video size={18} /> : <Phone size={18} />}
        </span>
      </div>
      <div className="flex gap-3">
        {incoming ? (
          <>
            <DockButton
              onClick={declineCall}
              label="Decline"
              title="Decline call"
              icon={<PhoneOff size={19} />}
              background="#F4364C"
            />
            <DockButton
              onClick={() => void acceptCall()}
              label="Accept"
              title="Accept call"
              icon={call.video ? <Video size={19} /> : <Phone size={19} />}
              background="#31A24C"
            />
          </>
        ) : (
          <>
            <DockButton
              onClick={toggleMic}
              label={micOn ? "Mute" : "Unmute"}
              title={micOn ? "Mute microphone" : "Unmute microphone"}
              icon={micOn ? <Mic size={18} /> : <MicOff size={18} />}
              background={micOn ? "rgba(255,255,255,0.12)" : "#fff"}
              color={micOn ? "#fff" : "#111"}
            />
            <DockButton
              onClick={endCall}
              label="End"
              title="End call"
              icon={<PhoneOff size={19} />}
              background="#F4364C"
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One remote participant. In a video call their stream fills the tile (and
 * carries their audio); otherwise it's their avatar over the call backdrop, with
 * a hidden audio sink alongside.
 */
function ParticipantTile({
  p,
  video,
  size,
}: {
  p: CallParticipant;
  video: boolean;
  /** Avatar diameter — the sole tile in a call gets a bigger one than a grid. */
  size: number;
}) {
  return (
    <div
      data-participant={p.deviceId}
      data-connected={p.connected ? "1" : "0"}
      className="relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-[18px]"
      style={{ background: "rgba(255,255,255,0.06)", aspectRatio: "4 / 3" }}
    >
      {video && p.stream && p.connected ? (
        // Not muted: in a video call the remote audio rides these elements.
        <StreamVideo stream={p.stream} className="absolute inset-0 size-full object-cover" />
      ) : (
        <PeerAvatar user={p.user} size={size} />
      )}
      <div className="absolute bottom-2.5 left-3 flex items-center gap-2 text-[13px] font-semibold text-white/85">
        {p.user.name.split(" ")[0]}
        {!p.connected && (
          <span className="text-[12px] font-normal text-white/55">connecting…</span>
        )}
      </div>
    </div>
  );
}

/**
 * The call surface: a full-screen overlay, per the comp's renderCallOverlay —
 * radial backdrop, conversation title, self picture-in-picture, and the control
 * row floating at the bottom.
 *
 * The comp only draws a 1:1 call, so the mesh extends its language rather than
 * inventing one: a single peer keeps the comp's centred layout (their video
 * full-bleed when it's a video call), and 2+ peers become a grid of tiles with
 * the same rounded corners, name labels and backdrop.
 */
function CallPanel({
  call,
  popped,
  onPopOut,
  onPopIn,
}: {
  call: CallInfo;
  popped: boolean;
  onPopOut: () => void;
  onPopIn: () => void;
}) {
  const localStream = useCallStore((s) => s.localStream);
  const micOn = useCallStore((s) => s.micOn);
  const camOn = useCallStore((s) => s.camOn);
  const { endCall, toggleMic, toggleCam } = useCallActions();
  // Placing a call rings from the dock, so by the time the panel is on screen
  // somebody has answered — what's left is waiting for their media.
  const ringing = call.phase === "connecting";
  const peers = call.participants;
  const connected = peers.filter((p) => p.connected);
  const isVideo = call.video;
  // Somebody's video actually on screen — that's when the backdrop lifts and the
  // avatar layout gives way to the stream.
  const live = isVideo && connected.length > 0;

  const status = ringing ? "Connecting…" : null;

  const bg = live
    ? "radial-gradient(120% 120% at 50% 0%, #24344f 0%, #0e141d 70%)"
    : "radial-gradient(120% 120% at 50% 30%, #1c2431 0%, #0b0f16 75%)";

  const header = (
    <div className="absolute inset-x-0 top-0 z-[2] flex items-center gap-2.5 px-[26px] py-[22px] text-white">
      <div className="text-[15px] font-semibold opacity-[0.92]">
        {isVideo ? "Video call" : "Voice call"}
      </div>
      {call.kind === "group" && connected.length > 0 && (
        <span className="rounded-xl bg-white/[0.16] px-2.5 py-[3px] text-[12.5px] font-semibold">
          {connected.length + 1} on the call
        </span>
      )}
      {!micOn && (
        <span className="rounded-xl bg-white/[0.16] px-2.5 py-[3px] text-[12.5px] font-semibold">
          Muted
        </span>
      )}
      <button
        onClick={popped ? onPopIn : onPopOut}
        title={popped ? "Return the call to the app window" : "Open call in a new window"}
        className="ml-auto flex size-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/[0.16] hover:text-white"
      >
        {popped ? <Minimize2 size={17} /> : <SquareArrowOutUpRight size={17} />}
      </button>
    </div>
  );

  const selfPip = isVideo && (
    <div
      className="absolute right-6 top-6 z-[2] flex items-center justify-center overflow-hidden rounded-[18px]"
      style={{
        width: 150,
        height: 200,
        border: "2px solid rgba(255,255,255,0.25)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
        background: camOn ? "linear-gradient(150deg, #2a3550, #16202e)" : "#1b1e24",
      }}
    >
      {camOn ? (
        <>
          <StreamVideo
            stream={localStream}
            muted
            mirror
            className="absolute inset-0 size-full object-cover"
          />
          <div className="absolute bottom-2 left-2.5 text-[13px] font-semibold text-white/85">
            You
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 text-white/50">
          <span
            className="flex size-[52px] items-center justify-center rounded-full text-[18px] font-semibold text-white"
            style={{ background: "var(--app-accent)" }}
          >
            You
          </span>
          <span className="text-[11.5px]">Camera off</span>
        </div>
      )}
    </div>
  );

  // One peer: the comp's centred layout, with their video full-bleed once it's
  // up. Several: a grid, sized so tiles stay legible up to the 6-person cap.
  let body: React.ReactNode;
  if (connected.length > 1 || peers.length > 1) {
    const cols = peers.length <= 4 ? 2 : 3;
    body = (
      <div className="absolute inset-0 flex items-center justify-center px-8 pb-[124px] pt-[84px]">
        {/* Tiles keep a 4:3 shape and are sized by the grid's width, so two
            people don't get stretched into full-height columns and six still
            fit without becoming thumbnails. */}
        <div
          className="grid w-full gap-3"
          style={{
            maxWidth: cols === 2 ? 900 : 1120,
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}
        >
          {peers.map((p) => (
            <ParticipantTile key={p.deviceId} p={p} video={isVideo} size={72} />
          ))}
        </div>
      </div>
    );
  } else if (live && peers[0]) {
    body = (
      <div
        className="absolute inset-0"
        data-participant={peers[0].deviceId}
        data-connected={peers[0].connected ? "1" : "0"}
      >
        <StreamVideo
          stream={peers[0].stream}
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute inset-x-0 bottom-[124px] flex flex-col items-center gap-1">
          <div className="text-[20px] font-bold text-white drop-shadow">{call.title}</div>
          {call.startedAt && (
            <div className="text-[14px] text-white/70">
              <CallTimer startedAt={call.startedAt} />
            </div>
          )}
        </div>
      </div>
    );
  } else {
    const solo = peers[0];
    body = (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
        <div
          className="relative flex items-center justify-center"
          // The layouts differ (comp-faithful solo vs grid), but each one that
          // shows a remote participant marks itself the same way, so "who is on
          // screen" is answerable without knowing which layout is in play.
          {...(solo
            ? {
                "data-participant": solo.deviceId,
                "data-connected": solo.connected ? "1" : "0",
              }
            : {})}
        >
          {ringing && <RingPulse />}
          {solo ? (
            <PeerAvatar user={solo.user} size={150} />
          ) : call.peer ? (
            <PeerAvatar user={call.peer} size={150} />
          ) : (
            // A group with nobody on the call yet: the subject is the
            // conversation, and the title beneath already names it.
            <span
              className="flex items-center justify-center rounded-full text-white/80"
              style={{
                width: 150,
                height: 150,
                background: "rgba(255,255,255,0.10)",
                boxShadow: "0 8px 40px rgba(0,0,0,0.35)",
              }}
            >
              <Users size={58} strokeWidth={1.6} />
            </span>
          )}
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <div className="text-[28px] font-bold text-white">{call.title}</div>
          <div className="text-[15px] tabular-nums text-white/70">
            {status ?? (call.startedAt ? <CallTimer startedAt={call.startedAt} /> : null)}
          </div>
          {!status && !isVideo && <VoiceBars />}
        </div>
      </div>
    );
  }

  return (
    <div
      className="animate-call-in fixed inset-0 z-[300]"
      style={{ background: bg }}
    >
      {header}
      {selfPip}
      {body}
      {/* Voice calls have no video element to carry the audio, so each peer gets
          one hidden sink — mounted here rather than inside the tiles so that
          switching between the solo and grid layouts never restarts playback,
          and so a peer can never end up with two sinks playing them twice. */}
      {!isVideo && peers.map((p) => <StreamAudio key={p.deviceId} stream={p.stream} />)}
      <div className="absolute inset-x-0 bottom-[38px] flex justify-center">
        <div className="flex items-center justify-center gap-3">
          <ControlButton
            onClick={toggleMic}
            title={micOn ? "Mute microphone" : "Unmute microphone"}
            active={micOn}
          >
            {micOn ? <Mic size={24} /> : <MicOff size={24} />}
          </ControlButton>
          {isVideo && (
            <ControlButton
              onClick={toggleCam}
              title={camOn ? "Turn camera off" : "Turn camera on"}
              active={camOn}
            >
              {camOn ? <Video size={24} /> : <VideoOff size={24} />}
            </ControlButton>
          )}
          <ControlButton onClick={endCall} title="End call" danger>
            <PhoneOff size={26} />
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

/**
 * What the app window shows while the call lives in its own window. Without
 * this the call would simply vanish from here, which reads as "it dropped" —
 * and if the popup ends up behind the main window, nothing would say otherwise.
 */
function PoppedOutCard({ call, onPopIn }: { call: CallInfo; onPopIn: () => void }) {
  const { endCall } = useCallActions();
  return (
    <div
      data-call-dock="popped"
      className="fixed z-[400] flex flex-col"
      style={{
        bottom: 26,
        right: 26,
        width: 352,
        padding: 18,
        gap: 16,
        borderRadius: 26,
        background: "rgba(30,31,34,0.97)",
        backdropFilter: "blur(18px)",
        border: "1px solid rgba(255,255,255,0.09)",
        boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        animation: "fadeUp .22s ease-out",
      }}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <div className="shrink-0">
          <PeerAvatar user={call.peer ?? call.starter} size={52} />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="truncate text-[16.5px] font-bold text-white">{call.title}</div>
          <div className="truncate text-[13.5px] text-white/60">
            {call.startedAt ? <CallTimer startedAt={call.startedAt} /> : "In another window"}
          </div>
        </div>
        <span className="ml-auto shrink-0 text-white/35">
          {call.video ? <Video size={18} /> : <Phone size={18} />}
        </span>
      </div>
      <div className="flex gap-3">
        <DockButton
          onClick={onPopIn}
          label="Bring back"
          icon={<Minimize2 size={18} />}
          background="rgba(255,255,255,0.12)"
        />
        <DockButton
          onClick={endCall}
          label="End"
          title="End call"
          icon={<PhoneOff size={19} />}
          background="#F4364C"
        />
      </div>
    </div>
  );
}

/** Mounted once in the Shell — renders whichever call surface applies. */
export function CallUI() {
  const call = useCallStore((s) => s.call);
  const { container, popOut, popIn } = useCallPopout();

  // A popped-out window must not outlive the call it belongs to. CallUI stays
  // mounted between calls, so the hook's unmount cleanup never fires here.
  useEffect(() => {
    if (!call) popIn();
  }, [call, popIn]);

  if (!call) return null;
  // Ringing in either direction is a card, not a takeover — see CallDock.
  if (call.phase === "incoming" || call.phase === "outgoing") {
    return <CallDock call={call} />;
  }

  const panel = (
    <CallPanel call={call} popped={container !== null} onPopOut={popOut} onPopIn={popIn} />
  );
  if (!container) return panel;
  return (
    <>
      {createPortal(panel, container)}
      <PoppedOutCard call={call} onPopIn={popIn} />
    </>
  );
}
