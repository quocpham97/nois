"use client";

import { ChevronLeft, Info, Phone, Video } from "lucide-react";
import {
  type Group,
  gradientFor,
  groupMembers,
  presenceColor,
  presenceLabel,
} from "@/lib/chat-data";
import { useChat } from "../chat/chat-context";
import { useSocket } from "../chat/socket-context";
import { useCall } from "../chat/call-context";
import { GroupIcon } from "../chat/bits";
import { Message } from "../chat/message";
import { Composer } from "../chat/composer";
import { KeyChangeBanner, RecoveryWaitingBanner } from "../chat/key-backup";

// Full-screen conversation (the "isChat" screen). The tab bar is hidden while
// this is open (see MobileApp). Header + composer are mobile-shaped, but the
// message list reuses the real <Message> component and the send path reuses the
// real <Composer>, so E2EE decrypt, reactions, replies, edits and drafts are
// exactly the desktop behavior — nothing about messaging is re-implemented.
export function ConversationScreen({ ch }: { ch: Group }) {
  const { selectGroup, toggleGroupInfo, scrollRef, bubbleTheme } = useChat();
  const { user: me } = useSocket();
  const { startCall, call } = useCall();

  const isDm = ch.type === "dm";
  const inCall = call != null;
  const members = groupMembers(ch, me);
  const status = isDm
    ? ch.presence === "active"
      ? "Active now"
      : presenceLabel(ch.presence)
    : `${members.length} members`;

  return (
    // Same conversation-scoped chat color as the desktop GroupView.
    <div
      className="flex h-full flex-col bg-app-bg"
      style={
        { "--sent-grad": gradientFor(ch.bubbleTheme ?? bubbleTheme) } as React.CSSProperties
      }
    >
      {/* header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-app-border px-3 pb-2.5 pt-1">
        <button
          onClick={() => selectGroup("")}
          aria-label="Back"
          className="flex size-9 shrink-0 items-center justify-center text-app-accent"
        >
          <ChevronLeft size={26} strokeWidth={2.2} />
        </button>
        <span className="relative shrink-0">
          {isDm ? (
            <span
              className="flex size-10 items-center justify-center rounded-full text-[15px] font-semibold text-white"
              style={{ background: ch.user!.bg }}
            >
              {ch.user!.initials}
            </span>
          ) : (
            <span className="flex size-10 items-center justify-center rounded-full bg-panel">
              <GroupIcon group={ch} color="var(--app-text)" size={16} />
            </span>
          )}
          {isDm && (
            <span
              className="absolute -bottom-px -right-px size-[11px] rounded-full border-[2.5px] border-app-bg"
              style={{ background: presenceColor(ch.presence) }}
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-bold text-app-text">
            {isDm ? ch.user!.name : ch.name}
          </div>
          <div className="truncate text-[12px] text-app-muted">{status}</div>
        </div>
        {isDm ? (
          <>
            <button
              onClick={() => void startCall(ch.id, false)}
              disabled={inCall}
              aria-label="Voice call"
              className="flex size-[38px] items-center justify-center text-app-accent disabled:opacity-40"
            >
              <Phone size={22} strokeWidth={1.9} />
            </button>
            <button
              onClick={() => void startCall(ch.id, true)}
              disabled={inCall}
              aria-label="Video call"
              className="flex size-[38px] items-center justify-center text-app-accent disabled:opacity-40"
            >
              <Video size={24} strokeWidth={1.9} />
            </button>
          </>
        ) : (
          <button
            onClick={toggleGroupInfo}
            aria-label="Conversation info"
            className="flex size-[38px] items-center justify-center text-app-accent"
          >
            <Info size={22} strokeWidth={1.9} />
          </button>
        )}
      </div>

      <KeyChangeBanner />
      <RecoveryWaitingBanner />

      {/* messages — real <Message> rows; scrollRef drives context autoscroll */}
      <div
        ref={scrollRef}
        className="app-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-2 pt-3.5"
      >
        {ch.messages.map((m) => (
          <Message key={m.id} msg={m} />
        ))}
        <div className="h-1" />
      </div>

      <Composer group={ch} />
    </div>
  );
}
