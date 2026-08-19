"use client";

import { AtSign, FileText, Trash2, X } from "lucide-react";
import type { Group, Message } from "@/lib/chat-data";
import { useSessionStore } from "@/stores/session-store";
import { useChatStore } from "@/stores/chat-store";
import { useChatActions } from "./chat-actions";

const groupLabel = (ch: Group) =>
  ch.type === "dm" ? "@" + (ch.user?.name ?? ch.name) : "#" + ch.name;

/** Shared panel chrome: a titled header with a close button + a scroll body. */
function PanelShell({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  const { closePanel } = useChatActions();
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-app-border px-6 pb-3 pt-3.5">
        <span className="text-app-muted">{icon}</span>
        <h1 className="m-0 text-[17px] font-bold">{title}</h1>
        {count != null && (
          <span className="rounded-[10px] bg-panel-2 px-2 py-0.5 text-[12px] font-semibold text-app-muted">
            {count}
          </span>
        )}
        <button
          onClick={closePanel}
          className="ml-auto flex size-7 items-center justify-center rounded-[5px] text-app-muted hover:bg-panel-hover hover:text-app-text"
          title="Close"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="app-scroll flex-1 overflow-y-auto py-2">{children}</div>
    </>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-app-muted">
      <span className="opacity-40">{icon}</span>
      <p className="m-0 text-[13.5px]">{text}</p>
    </div>
  );
}

/** A message row with author avatar, group context, and text — like search. */
function MessageRow({
  msg,
  groupName,
  meta,
  onClick,
  action,
}: {
  msg: Message;
  groupName: string;
  meta?: string;
  onClick: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="group relative flex items-start gap-3 px-6 py-3 hover:bg-[var(--app-hover)]">
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-[12px] font-semibold text-white"
          style={{ background: msg.author.bg }}
        >
          {msg.author.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-baseline gap-2">
            <span className="font-semibold">{msg.author.name}</span>
            <span className="text-[12px] text-app-muted">
              in <span className="font-medium text-app-accent">{groupName}</span>
            </span>
            <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-app-faint">
              {meta ?? `${msg.date || "Today"} · ${msg.time}`}
            </span>
          </div>
          <div className="line-clamp-2 text-[13.5px] leading-[1.5] text-app-text">
            {msg.text || "(no text)"}
          </div>
        </div>
      </button>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function MentionsView() {
  const groups = useChatStore((s) => s.groups);
  const { selectGroup, jumpToMessage } = useChatActions();
  const user = useSessionStore((s) => s.user);
  const me = user.name;
  const rows: { chId: string; ch: Group; msg: Message }[] = [];
  Object.entries(groups).forEach(([chId, ch]) => {
    ch.messages.forEach((m) => {
      if (m.snapshot) return; // sidebar preview line, not a real message
      const mentioned =
        m.mentions?.includes(me) || (m.text?.includes("@" + me) ?? false);
      if (mentioned && !m.self) rows.push({ chId, ch, msg: m });
    });
  });

  return (
    <PanelShell
      title="Mentions"
      icon={<AtSign size={18} strokeWidth={1.8} />}
      count={rows.length}
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<AtSign size={32} strokeWidth={1.5} />}
          text={`No mentions yet. When someone @${me}s you, it shows up here.`}
        />
      ) : (
        rows.map(({ chId, ch, msg }) => (
          <MessageRow
            key={chId + msg.id}
            msg={msg}
            groupName={groupLabel(ch)}
            onClick={() => {
              selectGroup(chId);
              jumpToMessage(chId, msg.id);
            }}
          />
        ))
      )}
    </PanelShell>
  );
}

export function DraftsView() {
  const groups = useChatStore((s) => s.groups);
  const drafts = useChatStore((s) => s.drafts);
  const { clearDraft, selectGroup } = useChatActions();
  const entries = Object.entries(drafts);

  return (
    <PanelShell
      title="Drafts"
      icon={<FileText size={18} strokeWidth={1.8} />}
      count={entries.length}
    >
      {entries.length === 0 ? (
        <EmptyState
          icon={<FileText size={32} strokeWidth={1.5} />}
          text="No drafts. Unsent messages are saved here per group."
        />
      ) : (
        entries.map(([chId, draft]) => {
          const ch = groups[chId];
          const name = ch ? groupLabel(ch) : chId;
          return (
            <div
              key={chId}
              className="group relative flex items-start gap-3 px-6 py-3 hover:bg-[var(--app-hover)]"
            >
              <button
                onClick={() => selectGroup(chId)}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
              >
                <span className="text-[12px] font-medium text-app-accent">
                  {name}
                </span>
                <span className="line-clamp-2 text-[13.5px] leading-[1.5] text-app-text">
                  {draft.text}
                </span>
              </button>
              <button
                onClick={() => clearDraft(chId)}
                title="Discard draft"
                className="shrink-0 self-center flex size-7 items-center justify-center rounded-[5px] text-app-muted hover:bg-panel-hover hover:text-app-text"
              >
                <Trash2 size={15} strokeWidth={1.8} />
              </button>
            </div>
          );
        })
      )}
    </PanelShell>
  );
}
