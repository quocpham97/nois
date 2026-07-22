"use client";

import { MessageCircle, Plus, Users } from "lucide-react";
import { useChat } from "./chat-context";

/** One of the two primary calls-to-action (New message / New group). */
function ActionCard({
  icon,
  title,
  sub,
  grad,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  grad?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-[260px] items-center gap-3.5 rounded-2xl border border-app-border bg-panel px-[18px] py-3.5 text-left transition-colors hover:border-border-strong hover:bg-app-hover"
    >
      <span
        className={
          "flex size-11 shrink-0 items-center justify-center rounded-full " +
          (grad ? "sent-grad text-white" : "bg-app-accent-soft text-app-accent")
        }
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-bold">{title}</span>
        <span className="mt-px block text-[12.5px] text-app-muted">{sub}</span>
      </span>
    </button>
  );
}

/** Main pane when no conversation is selected (no channel matches the URL). */
export function EmptyChatView() {
  const { openCompose } = useChat();

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
      <div className="sent-grad flex size-[104px] animate-pop items-center justify-center rounded-full shadow-[var(--app-shadow-pop)]">
        <MessageCircle size={52} strokeWidth={1.7} className="text-white" />
      </div>

      <h2 className="mt-[26px] text-[26px] font-extrabold tracking-[-0.02em]">
        Your messages
      </h2>
      <p className="mt-2.5 max-w-[400px] text-[15.5px] leading-[1.5] text-app-muted">
        Pick a conversation from the left, or start a new one to send your first
        message.
      </p>

      <div className="mt-[30px] flex gap-3.5">
        <ActionCard
          icon={<Plus size={22} strokeWidth={1.9} />}
          title="New message"
          sub="Start a 1-on-1 chat"
          grad
          onClick={openCompose}
        />
        <ActionCard
          icon={<Users size={22} strokeWidth={1.9} />}
          title="New group"
          sub="Chat with several people"
          onClick={openCompose}
        />
      </div>
    </div>
  );
}
