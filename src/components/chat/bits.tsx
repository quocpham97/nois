"use client";

import { Lock, Megaphone } from "lucide-react";
import type { Channel, User } from "@/lib/chat-data";

export function ChannelIcon({
  channel,
  color = "currentColor",
  size = 13,
}: {
  channel: Channel;
  color?: string;
  size?: number;
}) {
  if (channel.icon === "lock") {
    return (
      <span
        className="flex w-[18px] items-center justify-center"
        style={{ color }}
      >
        <Lock size={size} strokeWidth={1.8} />
      </span>
    );
  }
  if (channel.icon === "megaphone") {
    return (
      <span
        className="flex w-[18px] items-center justify-center"
        style={{ color }}
      >
        <Megaphone size={size} strokeWidth={1.8} />
      </span>
    );
  }
  return (
    <span
      className="flex w-[18px] items-center justify-center font-mono font-medium"
      style={{ color, fontSize: 14 }}
    >
      #
    </span>
  );
}

/** Messenger-style group avatar: two overlapping member circles. */
export function GroupAvatar({
  members,
  size = 40,
}: {
  members: User[];
  size?: number;
}) {
  const a = members[0];
  const b = members[1] ?? members[0];
  const s2 = Math.round(size * 0.62);
  const circle = (u: User, style: React.CSSProperties) => (
    <span
      className="absolute flex items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: s2,
        height: s2,
        background: u.bg,
        fontSize: Math.round(s2 * 0.4),
        ...style,
      }}
    >
      {u.initials}
    </span>
  );
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {circle(a, { top: 0, left: 0 })}
      {circle(b, {
        bottom: 0,
        right: 0,
        border: "2px solid var(--app-bg)",
      })}
    </span>
  );
}

export function Avatar({
  initials,
  bg,
  src,
  size = 36,
  radius = 999,
  fontSize,
}: {
  initials: string;
  bg: string;
  /** Optional image (data URL); shown instead of initials when set. */
  src?: string;
  size?: number;
  radius?: number;
  fontSize?: number;
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={initials}
        className="shrink-0 object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: bg,
        fontSize: fontSize ?? Math.round(size * 0.36),
      }}
    >
      {initials}
    </span>
  );
}
