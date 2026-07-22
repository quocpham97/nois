"use client";

import { useEffect, useRef } from "react";
import { Info, Phone, Pin, Search, Video, X } from "lucide-react";
import {
  type Channel,
  type Message as Msg,
  channelMembers,
  deriveUser,
  presenceColor,
  presenceLabel,
} from "@/lib/chat-data";
import { useChat } from "./chat-context";
import { useSocket } from "./socket-context";
import { useCall } from "./call-context";
import { Avatar, ChannelIcon } from "./bits";
import { ConvAvatar } from "./sidebar";
import { Message } from "./message";
import { Composer } from "./composer";

function ChannelHeader({ ch }: { ch: Channel }) {
  const {
    openSearch,
    pinnedPanelFor,
    togglePinnedPanel,
    togglePin,
    jumpToMessage,
    channelInfoOpen,
    toggleChannelInfo,
  } = useChat();
  const { user: me } = useSocket();
  const { startCall, call } = useCall();
  const inCall = call != null;
  const isDm = ch.type === "dm";
  const members = channelMembers(ch, me);
  const pins = ch.pinned || [];
  const panelOpen = pinnedPanelFor === ch.id;

  // Close the pinned-list popover on a click outside it (ignoring its trigger).
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (panelRef.current?.contains(t) || t.closest("[data-pin-trigger]"))
        return;
      togglePinnedPanel(ch.id);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [panelOpen, ch.id, togglePinnedPanel]);
  return (
    // app-drag: in the Electron shell this header doubles as the title bar.
    <div className="app-drag flex h-16 shrink-0 items-center gap-3 border-b border-app-border px-4">
      <div className="flex min-w-0 items-center gap-3">
        {isDm ? (
          <span className="relative shrink-0">
            <span
              className="flex size-10 items-center justify-center rounded-full text-[15px] font-semibold text-white"
              style={{ background: ch.user!.bg }}
            >
              {ch.user!.initials}
            </span>
            <span
              className="absolute -bottom-px -right-px size-[11px] rounded-full"
              style={{
                background: presenceColor(ch.presence),
                border: "2.5px solid var(--app-bg)",
              }}
            />
          </span>
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-panel">
            <ChannelIcon channel={ch} color="var(--app-text)" size={16} />
          </span>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="m-0 truncate text-[16px] font-bold text-app-text">
              {isDm ? ch.user!.name : ch.name}
            </h1>
            {!isDm && ch.private && (
              <span className="rounded-full border border-app-border px-2 py-px text-[11px] text-app-muted">
                Private
              </span>
            )}
          </div>
          <div className="truncate text-[12.5px] text-app-muted">
            {isDm ? (
              ch.presence === "active" ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-[7px] rounded-full bg-app-green" />
                  Active now
                </span>
              ) : (
                presenceLabel(ch.presence)
              )
            ) : (
              ch.topic
            )}
          </div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        {!isDm && (
          <button
            onClick={toggleChannelInfo}
            title="View members"
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] text-app-muted hover:bg-app-hover"
          >
            <div className="flex">
              {members.slice(0, 4).map((u, i) => (
                <span
                  key={u.name}
                  className="flex size-[22px] items-center justify-center rounded-full text-[10px] font-semibold text-white"
                  style={{
                    background: u.bg,
                    marginLeft: i ? -6 : 0,
                    border: "2px solid var(--app-bg)",
                  }}
                >
                  {u.initials}
                </span>
              ))}
            </div>
            <span className="ml-1">{members.length}</span>
          </button>
        )}
        {isDm && (
          <>
            <button
              onClick={() => void startCall(ch.id, false)}
              disabled={inCall}
              title="Start a voice call"
              className="flex size-10 items-center justify-center rounded-full text-app-accent hover:bg-app-hover disabled:opacity-40"
            >
              <Phone size={19} strokeWidth={1.9} />
            </button>
            <button
              onClick={() => void startCall(ch.id, true)}
              disabled={inCall}
              title="Start a video call"
              className="flex size-10 items-center justify-center rounded-full text-app-accent hover:bg-app-hover disabled:opacity-40"
            >
              <Video size={20} strokeWidth={1.9} />
            </button>
          </>
        )}
        <button
          onClick={openSearch}
          title="Search"
          className="flex size-10 items-center justify-center rounded-full text-app-accent hover:bg-app-hover"
        >
          <Search size={19} strokeWidth={1.9} />
        </button>
        <div className="relative">
          <button
            data-pin-trigger
            onClick={() => togglePinnedPanel(ch.id)}
            title="Pinned"
            className="flex size-10 items-center justify-center rounded-full hover:bg-app-hover"
            style={{ color: panelOpen ? "var(--app-accent-hover)" : "var(--app-accent)" }}
          >
            <Pin size={19} strokeWidth={1.9} />
          </button>
          {panelOpen && (
            <div
              ref={panelRef}
              className="animate-fade-in absolute right-0 top-11 z-20 w-80 rounded-2xl border border-app-border bg-panel-2 p-2 shadow-[var(--app-shadow-lg)]"
            >
              <div className="px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
                Pinned · {pins.length}
              </div>
              {pins.length === 0 ? (
                <div className="px-2 py-3 text-[13px] text-app-muted">
                  No pinned messages yet. Hover a message and choose Pin.
                </div>
              ) : (
                pins.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => jumpToMessage(ch.id, p.id)}
                    className="group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-panel-hover"
                  >
                    <span
                      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
                      style={{ background: p.author.bg }}
                    >
                      {p.author.initials}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-semibold">
                        {p.author.name}
                      </div>
                      <div className="truncate text-[13px] text-app-text">
                        {p.text}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(ch.id, p.id);
                      }}
                      title="Unpin"
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-app-muted opacity-0 hover:bg-panel hover:text-app-text group-hover:opacity-100"
                    >
                      Unpin
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <button
          onClick={toggleChannelInfo}
          title="Channel info"
          className="flex size-10 items-center justify-center rounded-full hover:bg-app-hover"
          style={{
            color: channelInfoOpen ? "var(--app-accent-hover)" : "var(--app-accent)",
          }}
        >
          <Info size={19} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  );
}

function PinnedBar({ ch }: { ch: Channel }) {
  const { pinnedBarHidden, hidePinnedBar, jumpToMessage } = useChat();
  if (!ch.pinned || ch.pinned.length === 0 || pinnedBarHidden[ch.id])
    return null;
  const p = ch.pinned[0];
  return (
    <div className="flex items-center gap-2.5 border-b border-app-border bg-panel px-4 py-2 text-[13px]">
      <span className="flex text-app-accent">
        <Pin size={14} strokeWidth={1.8} />
      </span>
      <button
        onClick={() => jumpToMessage(ch.id, p.id)}
        title="Jump to pinned message"
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span className="font-medium text-app-muted">
          {ch.pinned.length} pinned
        </span>
        <span className="text-app-faint">·</span>
        <span className="flex-1 truncate text-app-text">
          <span className="font-semibold">{p.author.name}: </span>
          {p.text}
        </span>
      </button>
      <button
        onClick={() => hidePinnedBar(ch.id)}
        title="Hide"
        className="flex text-app-faint hover:text-app-text"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

function DayDivider({ date }: { date: string }) {
  return (
    <div className="px-4 pb-1 pt-4 text-center text-[12px] font-semibold text-app-faint">
      {date}
    </div>
  );
}

function firstName(uid: string): string {
  return deriveUser(uid).name.split(" ")[0];
}

/** Messenger-style typing indicator: the typer's avatar + a dots bubble. */
function TypingIndicator({ ch }: { ch: Channel }) {
  const { typingByChannel, userId } = useChat();
  const typers = (typingByChannel[ch.id] || []).filter((u) => u !== userId);
  if (typers.length === 0) {
    return <div className="h-2" />;
  }
  const who = deriveUser(typers[0]);
  return (
    <div
      className="flex items-end gap-2 px-4 pb-1"
      title={
        typers.length === 1
          ? `${firstName(typers[0])} is typing…`
          : "Several people are typing…"
      }
    >
      <Avatar initials={who.initials} bg={who.bg} size={28} radius={999} />
      <div
        className="flex gap-1 bg-recv-bubble px-3.5 py-3"
        style={{ borderRadius: "20px 20px 20px 6px" }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-[7px] rounded-full bg-app-faint"
            style={{ animation: "blink 1.3s infinite", animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Intro block at the very start of a conversation's history. */
function ConvIntro({ ch }: { ch: Channel }) {
  const { myUser } = useChat();
  const isDm = ch.type === "dm";
  const members = channelMembers(ch, myUser);
  return (
    <div className="flex flex-col items-center px-5 pb-3 pt-6 text-center">
      <ConvAvatar ch={ch} me={myUser} size={72} />
      <div className="mt-3 text-[19px] font-bold">
        {isDm ? ch.user!.name : ch.name}
      </div>
      <div className="mt-0.5 text-[13px] text-app-muted">
        {isDm
          ? "You're connected on Messenger"
          : `Group · ${members.length} ${members.length === 1 ? "member" : "members"}`}
      </div>
    </div>
  );
}

function EmptyState({ ch }: { ch: Channel }) {
  const { sendMessage } = useChat();
  const isDm = ch.type === "dm";
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
      {isDm ? (
        <div className="relative mb-4">
          <div
            className="flex size-[72px] items-center justify-center rounded-full text-[26px] font-semibold text-white"
            style={{ background: ch.user!.bg }}
          >
            {ch.user!.initials}
          </div>
          <span
            className="absolute bottom-0.5 right-0.5 size-4 rounded-full"
            style={{
              background: presenceColor(ch.presence),
              border: "3px solid var(--app-bg)",
            }}
          />
        </div>
      ) : (
        <div className="mb-4 flex size-[72px] items-center justify-center rounded-full border border-app-border bg-panel text-app-muted">
          <ChannelIcon channel={ch} color="var(--app-muted)" size={28} />
        </div>
      )}
      <h2 className="m-0 text-[22px] font-bold">
        {isDm ? ch.user!.name : "This is #" + ch.name}
      </h2>
      <p className="mb-6 mt-2 max-w-[460px] text-[14px] leading-[1.5] text-app-muted">
        {isDm
          ? `This is the start of your conversation with ${ch.user!.name}. Say hi to kick things off 👋`
          : `You created this group. Say hi to kick things off 👋`}
      </p>
      <button
        onClick={() => sendMessage("👋")}
        className="sent-grad flex items-center gap-2 rounded-full px-[18px] py-2.5 text-[14px] font-semibold text-white"
      >
        Wave to say hi 👋
      </button>
    </div>
  );
}

export function ChannelView({ ch }: { ch: Channel }) {
  const { scrollRef, historyCursor, loadOlder, highlightMsgId, clearHighlight } =
    useChat();
  const empty = ch.messages.length === 0;
  const hasOlder = historyCursor[ch.id] != null;

  // Pin to the latest message on channel open / history load / new bottom
  // message — but not when older pages are prepended (same last id) or while
  // jumping to a highlighted message (which positions itself).
  const lastId = ch.messages[ch.messages.length - 1]?.id;
  const lastSeen = useRef<{ chId: string; lastId?: string }>({ chId: "" });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = lastSeen.current;
    const channelChanged = prev.chId !== ch.id;
    const newBottom = prev.lastId !== lastId;
    lastSeen.current = { chId: ch.id, lastId };
    if ((channelChanged || newBottom) && !highlightMsgId) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [ch.id, lastId, highlightMsgId, scrollRef]);

  // Scroll to and briefly highlight a jumped-to message (e.g. from a pin).
  useEffect(() => {
    if (!highlightMsgId) return;
    const el = scrollRef.current?.querySelector(
      `[data-mid="${CSS.escape(highlightMsgId)}"]`,
    );
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(clearHighlight, 2400);
    return () => clearTimeout(t);
  }, [highlightMsgId, clearHighlight, scrollRef]);

  // group messages by date
  const groups: { date: string; msgs: Msg[] }[] = [];
  let curDate: string | null = null;
  ch.messages.forEach((m) => {
    const d = m.date || curDate || "Today";
    if (d !== curDate) {
      groups.push({ date: d, msgs: [] });
      curDate = d;
    }
    groups[groups.length - 1].msgs.push(m);
  });

  return (
    <>
      <ChannelHeader ch={ch} />
      <PinnedBar ch={ch} />
      <div
        ref={scrollRef}
        className="app-scroll flex flex-1 flex-col overflow-y-auto"
      >
        {empty ? (
          <EmptyState ch={ch} />
        ) : (
          <>
            <div className="flex-1" />
            {hasOlder ? (
              <div className="flex justify-center py-2">
                <button
                  onClick={() => loadOlder(ch.id)}
                  className="rounded-full border border-app-border bg-panel-2 px-3 py-1 text-[12px] font-medium text-app-muted hover:bg-panel-hover hover:text-app-text"
                >
                  Load older messages
                </button>
              </div>
            ) : (
              <ConvIntro ch={ch} />
            )}
            {groups.map((g, i) => (
              <div key={i}>
                <DayDivider date={g.date} />
                {g.msgs.map((m) => (
                  <Message key={m.id} msg={m} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
      {!empty && <TypingIndicator ch={ch} />}
      <Composer channel={ch} inThread={false} />
    </>
  );
}
