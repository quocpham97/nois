"use client";

import { useMemo, useState } from "react";
import { Check, Search, Send, X } from "lucide-react";
import { messageExcerpt } from "@/lib/chat-data";
import { useChat } from "./chat-context";
import { ConvAvatar } from "./sidebar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function ForwardModal() {
  const {
    forwardSource,
    closeForward,
    forwardMessage,
    groups,
    groupOrder,
    dmOrder,
    myUser,
  } = useChat();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Flattened destination list (groups then DMs), resolved to display rows.
  const dests = useMemo(() => {
    const rows = [...groupOrder, ...dmOrder]
      .map((id) => groups[id])
      .filter(Boolean)
      .map((ch) => ({
        ch,
        id: ch.id,
        title: ch.type === "dm" ? (ch.user?.name ?? ch.name) : ch.name,
        subtitle:
          ch.type === "dm"
            ? "Direct message"
            : ch.private
              ? "Private group"
              : "Group",
      }));
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;
  }, [groups, groupOrder, dmOrder, query]);

  if (!forwardSource) return null;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const close = () => {
    setQuery("");
    setSelected(new Set());
    closeForward();
  };

  const send = () => {
    if (selected.size === 0) return;
    forwardMessage([...selected]);
    setQuery("");
    setSelected(new Set());
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[80vh] w-[460px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[460px]">
        <div className="flex shrink-0 items-start justify-between border-b border-app-border px-5 py-3.5">
          <div>
            <DialogTitle className="text-[16px] font-bold">
              Forward message
            </DialogTitle>
            <div className="mt-0.5 text-[13px] text-app-muted">
              Select who to send this to
            </div>
          </div>
          <button
            onClick={close}
            title="Close"
            className="-mr-1 flex size-8 items-center justify-center rounded-full text-app-muted hover:bg-panel-hover hover:text-app-text"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {/* message preview — accent left border */}
        <div className="shrink-0 px-5 pt-3">
          <div className="rounded-xl border-l-[3px] border-app-accent bg-panel-2 px-3 py-2">
            <div className="text-[11.5px] font-bold uppercase tracking-[0.04em] text-app-accent">
              {forwardSource.author.name}
            </div>
            <div className="line-clamp-2 text-[13px] leading-[1.45] text-app-text">
              {messageExcerpt(forwardSource) || "(no text)"}
            </div>
          </div>
        </div>

        {/* search */}
        <div className="shrink-0 px-5 pb-2 pt-3">
          <div className="flex h-[42px] items-center gap-2 rounded-xl bg-panel px-3">
            <Search size={16} strokeWidth={1.9} className="shrink-0 text-app-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-app-faint"
            />
          </div>
        </div>

        <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {dests.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-app-muted">
              No chats found
            </div>
          ) : (
            dests.map((d) => {
              const on = selected.has(d.id);
              return (
                <button
                  key={d.id}
                  onClick={() => toggle(d.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left"
                  style={{ background: on ? "var(--app-accent-soft)" : undefined }}
                >
                  <ConvAvatar ch={d.ch} me={myUser} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold">
                      {d.title}
                    </div>
                    <div className="truncate text-[12.5px] text-app-muted">
                      {d.subtitle}
                    </div>
                  </div>
                  <span
                    className="flex size-[22px] shrink-0 items-center justify-center rounded-full"
                    style={{
                      border: `2px solid ${on ? "var(--app-accent)" : "var(--app-border)"}`,
                      background: on ? "var(--app-accent)" : "transparent",
                    }}
                  >
                    {on && (
                      <Check size={13} strokeWidth={2.6} className="text-white" />
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-app-border px-5 py-3">
          <span className="text-[13px] text-app-muted">
            {selected.size > 0
              ? `${selected.size} selected`
              : "Select at least one chat"}
          </span>
          <button
            onClick={send}
            disabled={selected.size === 0}
            className="flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-semibold"
            style={{
              background: selected.size ? "var(--sent-grad)" : "var(--panel-2)",
              color: selected.size ? "#fff" : "var(--app-faint)",
              opacity: selected.size ? 1 : 0.55,
              cursor: selected.size ? "pointer" : "default",
            }}
          >
            Send
            <Send size={15} strokeWidth={2} />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
