"use client";

import { useMemo, useState } from "react";
import { Hash, X } from "lucide-react";
import type { Presence, User } from "@/lib/chat-data";
import { presenceLabel } from "@/lib/chat-data";
import { GroupAvatar } from "./bits";
import { PresenceAvatar } from "./sidebar";
import { useChatStore } from "@/stores/chat-store";
import { useMyUser } from "@/stores/chat-selectors";
import { useChatActions } from "./chat-actions";

/** Mirror of the server's slug rule, for a live preview of the group id. */
const toSlug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Stable id for a member/user — the server-provided uid. Mirrors the helper in
 * group-info-panel/workspace-view, including its legacy first-name fallback. */
const memberId = (u: User) => u.id ?? u.name.split(" ")[0].toLowerCase();

/** Field label: the design's settings-field caption. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
      {children}
    </label>
  );
}

/**
 * Create a group — the compose screen's sibling: pick people, name the room.
 * Follows the same chrome as ComposeView (64px header with a Cancel pill, a
 * To: row of chips, a suggestion list, a footer hint bar), since to a member
 * this is the same act as starting a chat — with more than one person in it.
 */
export function CreateGroupView() {
  const workspaceMembers = useChatStore((s) => s.workspaceMembers);
  const groups = useChatStore((s) => s.groups);
  const myUser = useMyUser();
  const { closeCreateGroup, createGroup } = useChatActions();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const meId = memberId(myUser);
  // Candidates are the live workspace roster minus ourselves — the creator is
  // added by the server, and a group needs at least one other person to exist.
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
  const slug = toSlug(name);
  const canCreate = slug.length > 0 && selected.length > 0;

  const toggle = (id: string) => {
    setError(null);
    setQuery("");
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const submit = () => {
    setError(null);
    createGroup(name, topic, selected, setError);
  };

  // The header carries a live preview of the conversation being built: the same
  // stacked-circle group avatar the sidebar will show it with once it exists.
  const preview =
    chosen.length > 0 ? (
      <GroupAvatar members={[...chosen, myUser]} size={40} />
    ) : (
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-panel">
        <Hash size={17} strokeWidth={2} className="text-app-muted" />
      </span>
    );

  return (
    <>
      {/* Header — screen chrome, with the group's identity as it stands */}
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-app-border px-4">
        {preview}
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-bold leading-tight text-app-text">
            {name.trim() || "New group"}
          </div>
          <div className="truncate text-[12.5px] text-app-muted">
            {selected.length
              ? `${selected.length + 1} members`
              : "Add people to get started"}
          </div>
        </div>
        <button
          onClick={closeCreateGroup}
          className="shrink-0 rounded-full bg-panel px-3.5 py-1.5 text-[13.5px] font-semibold text-app-muted hover:bg-panel-hover"
        >
          Cancel
        </button>
      </div>

      <div className="app-scroll flex-1 overflow-y-auto">
        {/* Left-aligned form column, as the design sets its settings bodies */}
        <div className="max-w-[600px] px-10 py-8">
          <FieldLabel>Group name</FieldLabel>
          <div className="flex h-10 items-center gap-2 rounded-[10px] border border-app-border bg-panel-2 px-3.5 focus-within:border-border-strong">
            <Hash size={15} strokeWidth={1.8} className="shrink-0 text-app-muted" />
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) submit();
              }}
              maxLength={80}
              placeholder="e.g. marketing"
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-app-text outline-none placeholder:text-app-faint"
            />
          </div>
          {slug && (
            <div className="mt-1.5 text-[12px] text-app-faint">
              Will be created as{" "}
              <span className="font-medium text-app-accent">#{slug}</span>
            </div>
          )}

          <div className="mt-5">
            <FieldLabel>
              Topic <span className="font-normal normal-case">(optional)</span>
            </FieldLabel>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) submit();
              }}
              maxLength={120}
              placeholder="What's this group about?"
              className="h-10 w-full rounded-[10px] border border-app-border bg-panel-2 px-3.5 text-[15px] text-app-text outline-none placeholder:text-app-faint focus:border-border-strong"
            />
          </div>

          {/* Members — compose's To: row, as a field alongside the others */}
          <div className="mt-5">
            <FieldLabel>Members</FieldLabel>
            <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-[10px] border border-app-border bg-panel-2 px-3 py-1.5 focus-within:border-border-strong">
              {chosen.map((u) => (
                <span
                  key={memberId(u)}
                  className="inline-flex items-center gap-1.5 rounded-[14px] bg-app-accent-soft px-2 py-1 text-[13.5px] font-semibold text-app-accent"
                >
                  {u.name}
                  <button
                    onClick={() => toggle(memberId(u))}
                    title={`Remove ${u.name}`}
                    className="flex text-app-accent"
                  >
                    <X size={12} strokeWidth={2.4} />
                  </button>
                </span>
              ))}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filtered.length) {
                    e.preventDefault();
                    toggle(memberId(filtered[0]));
                  } else if (e.key === "Backspace" && !query && chosen.length) {
                    toggle(memberId(chosen[chosen.length - 1]));
                  }
                }}
                placeholder={chosen.length ? "Add another" : "Type a name"}
                className="min-w-[90px] flex-1 bg-transparent py-1 text-[15px] text-app-text outline-none placeholder:text-app-faint"
              />
            </div>
          </div>

          <div className="px-2 pb-1 pt-5 text-[12px] font-bold uppercase tracking-[0.04em] text-app-muted">
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
                      {presence ? presenceLabel(presence) : "Add to the group"}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Footer — the compose hint bar, carrying the commit action */}
      <div className="flex shrink-0 items-center gap-3 border-t border-app-border px-4 pb-4 pt-3">
        <div
          className={`min-w-0 flex-1 text-[13px] ${
            error ? "text-app-red" : "text-app-faint"
          }`}
        >
          {error ??
            (selected.length
              ? "Only these people will see the group."
              : "Pick who's in the group — nobody else will see it.")}
        </div>
        <button
          onClick={submit}
          disabled={!canCreate}
          className="flex h-9 shrink-0 items-center rounded-full px-4 text-[13.5px] font-semibold"
          style={{
            background: canCreate ? "var(--sent-grad)" : "var(--panel-hover)",
            color: canCreate ? "#fff" : "var(--app-faint)",
            cursor: canCreate ? "pointer" : "not-allowed",
          }}
        >
          Create group
        </button>
      </div>
    </>
  );
}
