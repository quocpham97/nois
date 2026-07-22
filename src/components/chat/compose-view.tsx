"use client";

import { Send, X } from "lucide-react";
import { useChat } from "./chat-context";
import { Avatar } from "./bits";

export function ComposeView() {
  const {
    closeCompose,
    composeQuery,
    setComposeQuery,
    composeText,
    setComposeText,
    composeRecipients,
    addRecipient,
    removeRecipient,
    sendCompose,
    workspaceMembers,
    myUser,
  } = useChat();

  // Lean 1:1: a single recipient per conversation. Candidates are the live
  // workspace roster (every real/seeded member the server knows about), minus
  // ourselves and anyone already selected — so whoever is logged in is
  // discoverable and DM-able.
  const hasRecipient = composeRecipients.length >= 1;
  const available = workspaceMembers.filter(
    (p) =>
      (p.id ?? p.name) !== (myUser.id ?? myUser.name) &&
      !composeRecipients.includes(p.name),
  );
  const filtered = hasRecipient
    ? []
    : available.filter(
        (p) =>
          !composeQuery ||
          p.name.toLowerCase().includes(composeQuery.toLowerCase()),
      );
  const canSend = hasRecipient && composeText.trim().length > 0;

  return (
    <>
      {/* To: row */}
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-app-border px-4">
        <div className="text-[15px] font-semibold text-app-muted">To:</div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {composeRecipients.map((r) => (
            <span
              key={r}
              className="inline-flex items-center gap-1.5 rounded-full bg-app-accent-soft py-1 pl-2.5 pr-1.5 text-[13.5px] font-semibold text-app-accent"
            >
              {r}
              <button
                onClick={() => removeRecipient(r)}
                title="Remove"
                className="flex text-app-accent"
              >
                <X size={13} strokeWidth={2.4} />
              </button>
            </span>
          ))}
          {!hasRecipient && (
            <input
              autoFocus
              value={composeQuery}
              onChange={(e) => setComposeQuery(e.target.value)}
              placeholder="Type a name"
              className="min-w-[120px] flex-1 bg-transparent text-[15px] text-app-text outline-none placeholder:text-app-faint"
            />
          )}
        </div>
        <button
          onClick={closeCompose}
          className="rounded-full bg-panel px-3.5 py-1.5 text-[13.5px] font-semibold text-app-muted hover:bg-panel-hover"
        >
          Cancel
        </button>
      </div>

      {/* Suggestions */}
      <div className="app-scroll flex-1 overflow-y-auto px-3 py-2">
        <div className="px-2 pb-1 pt-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-muted">
          Suggested
        </div>
        {hasRecipient && (
          <div className="px-2 py-2 text-[13px] text-app-muted">
            Remove {composeRecipients[0]} to message someone else.
          </div>
        )}
        {!hasRecipient && filtered.length === 0 && (
          <div className="px-2 py-2 text-[13px] text-app-muted">
            No people match &quot;{composeQuery}&quot;.
          </div>
        )}
        {filtered.map((p) => (
          <button
            key={p.name}
            onClick={() => addRecipient(p.name)}
            className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-app-hover"
          >
            <Avatar initials={p.initials} bg={p.bg} size={44} radius={999} />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold">{p.name}</span>
              <span className="block truncate text-[12.5px] text-app-muted">
                @{p.name.toLowerCase().replace(/[' ]/g, "").slice(0, 12)}
              </span>
            </span>
          </button>
        ))}
      </div>

      {/* First message */}
      <div className="border-t border-app-border px-3 pb-3 pt-2.5">
        <div className="flex items-end gap-1">
          <div className="flex min-w-0 flex-1 items-end rounded-[20px] bg-panel px-4">
            <textarea
              value={composeText}
              onChange={(e) => setComposeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) sendCompose();
                }
              }}
              rows={1}
              placeholder={hasRecipient ? "Aa" : "Select someone to start a chat"}
              className="max-h-28 min-h-[38px] w-full resize-none bg-transparent py-[9px] text-[15px] leading-[1.4] text-app-text outline-none placeholder:text-app-faint"
            />
          </div>
          <button
            onClick={sendCompose}
            disabled={!canSend}
            title="Send"
            className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed"
            style={{
              background: canSend ? "var(--sent-grad)" : "var(--panel-hover)",
              color: canSend ? "#fff" : "var(--app-faint)",
            }}
          >
            <Send size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="pt-2 text-center text-[13px] text-app-faint">
          {hasRecipient
            ? "Type a message to start the conversation"
            : "Select people to start a new chat"}
        </div>
      </div>
    </>
  );
}
