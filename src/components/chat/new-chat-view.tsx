"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { Presence, User } from "@/lib/chat-data";
import { groupNameFrom, presenceLabel } from "@/lib/chat-data";
import { PresenceAvatar } from "./sidebar";
import { useChatStore } from "@/stores/chat-store";
import { useMyUser } from "@/stores/chat-selectors";
import { useChatActions } from "./chat-actions";

/** Stable id for a member/user — the server-provided uid. Mirrors the helper in
 * group-info-panel/workspace-view, including its legacy first-name fallback. */
const memberId = (u: User) => u.id ?? u.name.split(" ")[0].toLowerCase();

/**
 * New conversation — one picker, and who you pick decides what it makes: one
 * person is a DM (their existing thread, or compose pre-addressed to them), two
 * or more is a group named after its members. So there's nothing to name and no
 * choice to make up front — same act either way, just a different number of
 * people in it.
 */
export function NewChatView() {
  const { workspaceMembers, groups } = useChatStore(
    useShallow((s) => ({
      workspaceMembers: s.workspaceMembers,
      groups: s.groups,
    })),
  );
  const myUser = useMyUser();
  const { closeNewChat, createGroup, openDmWith } = useChatActions();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const meId = memberId(myUser);
  // Candidates are the live workspace roster minus ourselves — we're in every
  // conversation we start, so we're never something to pick.
  const candidates = useMemo(
    () => workspaceMembers.filter((u) => memberId(u) !== meId),
    [workspaceMembers, meId],
  );
  const byId = useMemo(
    () => new Map(candidates.map((u) => [memberId(u), u])),
    [candidates],
  );

  // Presence is tracked per DM group, keyed by the partner's id; fold those into
  // a lookup so a suggestion shows live presence even without a DM open (same
  // derivation as the People roster).
  const presenceOf = useMemo(() => {
    const map: Record<string, Presence> = {};
    Object.values(groups).forEach((ch) => {
      if (ch.type === "dm" && ch.user?.id && ch.presence) {
        map[ch.user.id] = ch.presence;
      }
    });
    return (u: User) => (u.id ? map[u.id] : undefined);
  }, [groups]);

  // Anyone already picked is a chip in the To: row, so drop them from the list.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates
      .filter(
        (u) =>
          !selected.includes(memberId(u)) &&
          (!q || u.name.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [candidates, selected, query]);

  const chosen = selected.map((id) => byId.get(id)).filter(Boolean) as User[];
  const isDm = chosen.length === 1;
  const groupName = groupNameFrom(chosen);

  const toggle = (id: string) => {
    setError(null);
    setQuery("");
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const submit = () => {
    setError(null);
    if (!chosen.length) return;
    // One person: no group at all — open the DM (or compose, which creates it
    // on the first message). Both paths close this view via the store.
    if (isDm) {
      openDmWith(chosen[0]);
      return;
    }
    createGroup(groupName, "", selected, setError);
  };

  return (
    <>
      {/* To: row — the chips are the conversation being built */}
      <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-app-border px-4 py-3">
        <div className="text-[15px] font-semibold text-app-muted">To:</div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {chosen.map((u) => (
            <span
              key={memberId(u)}
              className="inline-flex items-center gap-1.5 rounded-full bg-app-accent-soft py-1 pl-2.5 pr-1.5 text-[13.5px] font-semibold text-app-accent"
            >
              {u.name}
              <button
                onClick={() => toggle(memberId(u))}
                title={`Remove ${u.name}`}
                className="flex text-app-accent"
              >
                <X size={13} strokeWidth={2.4} />
              </button>
            </span>
          ))}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // Enter takes the top match while typing; on an empty box it
                // commits what's already picked.
                if (filtered.length && query.trim()) toggle(memberId(filtered[0]));
                else if (!query) submit();
              } else if (e.key === "Backspace" && !query && chosen.length) {
                toggle(memberId(chosen[chosen.length - 1]));
              }
            }}
            placeholder={chosen.length ? "Add another" : "Type a name"}
            className="min-w-[120px] flex-1 bg-transparent text-[15px] text-app-text outline-none placeholder:text-app-faint"
          />
        </div>
        <button
          onClick={closeNewChat}
          className="shrink-0 self-start rounded-full bg-panel px-3.5 py-1.5 text-[13.5px] font-semibold text-app-muted hover:bg-panel-hover"
        >
          Cancel
        </button>
      </div>

      {/* Suggestions */}
      <div className="app-scroll flex-1 overflow-y-auto px-3 py-2">
        <div className="px-2 pb-1 pt-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-muted">
          {query.trim() ? "Results" : "Suggested"}
        </div>
        {filtered.length === 0 ? (
          <div className="px-2 py-2 text-[13px] text-app-muted">
            {candidates.length === 0
              ? "Nobody else is in this workspace yet."
              : query.trim()
                ? `No people match “${query.trim()}”.`
                : "Everyone's already added."}
          </div>
        ) : (
          filtered.map((u) => {
            const presence = presenceOf(u);
            return (
              <button
                key={memberId(u)}
                onClick={() => toggle(memberId(u))}
                className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-app-hover"
              >
                <PresenceAvatar user={u} presence={presence} size={44} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold text-app-text">
                    {u.name}
                  </span>
                  <span
                    className={`block truncate text-[12.5px] ${
                      presence === "active" ? "text-app-green" : "text-app-muted"
                    }`}
                  >
                    {/* Presence only exists for people we have a DM with, so
                        fall back to the handle rather than claiming "Offline". */}
                    {presence
                      ? presenceLabel(presence)
                      : "@" + u.name.toLowerCase().replace(/[' ]/g, "").slice(0, 12)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Footer — the hint bar, carrying the commit action */}
      <div className="flex shrink-0 items-center gap-3 border-t border-app-border px-4 pb-4 pt-3">
        <div
          className={`min-w-0 flex-1 truncate text-[13px] ${
            error ? "text-app-red" : "text-app-faint"
          }`}
        >
          {error ??
            (isDm
              ? `Opens your chat with ${chosen[0].name}.`
              : chosen.length
                ? `Creates “${groupName}” — only these people will see it.`
                : "Pick one person to chat, or several to start a group.")}
        </div>
        <button
          onClick={submit}
          disabled={!chosen.length}
          className="flex h-9 shrink-0 items-center rounded-full px-4 text-[13.5px] font-semibold"
          style={{
            background: chosen.length ? "var(--sent-grad)" : "var(--panel-hover)",
            color: chosen.length ? "#fff" : "var(--app-faint)",
            cursor: chosen.length ? "pointer" : "not-allowed",
          }}
        >
          {isDm ? "Open chat" : "Create group"}
        </button>
      </div>
    </>
  );
}
