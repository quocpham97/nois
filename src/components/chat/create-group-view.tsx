"use client";

import { useMemo, useState } from "react";
import { Hash, Users, X } from "lucide-react";
import type { User } from "@/lib/chat-data";
import { useChat } from "./chat-context";
import { Avatar } from "./bits";

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

export function CreateGroupView() {
  const { closeCreateGroup, createGroup, workspaceMembers, myUser } = useChat();
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
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter(
      (u) =>
        !selected.includes(memberId(u)) &&
        (!q || u.name.toLowerCase().includes(q)),
    );
  }, [candidates, selected, query]);

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

  return (
    <>
      <div className="flex h-14 items-center gap-3 border-b border-app-border px-4">
        <h2 className="m-0 text-[16px] font-bold">Create a group</h2>
        <button
          onClick={closeCreateGroup}
          className="ml-auto rounded-[5px] border border-app-border px-2.5 py-1 text-[13px] text-app-muted hover:bg-panel-hover"
        >
          Cancel
        </button>
      </div>

      <div className="app-scroll flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[560px] px-6 py-6">
          <p className="m-0 mb-6 text-[13.5px] text-app-muted">
            Groups are where your team communicates. They&apos;re best
            organized around a topic — #marketing, for example. Only the people
            you add can see the group.
          </p>

          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
            Name
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-app-border bg-panel-2 px-3 focus-within:border-border-strong">
            <span className="text-app-muted">
              <Hash size={15} strokeWidth={1.8} />
            </span>
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
              className="flex-1 bg-transparent py-2.5 text-[14px] text-app-text outline-none"
            />
          </div>
          {slug && (
            <div className="mt-1.5 text-[12px] text-app-faint">
              Will be created as{" "}
              <span className="font-medium text-app-accent">#{slug}</span>
            </div>
          )}

          <label className="mb-1.5 mt-5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
            Topic <span className="font-normal normal-case">(optional)</span>
          </label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) submit();
            }}
            maxLength={120}
            placeholder="What's this group about?"
            className="w-full rounded-lg border border-app-border bg-panel-2 px-3 py-2.5 text-[14px] text-app-text outline-none focus:border-border-strong"
          />

          <label className="mb-1.5 mt-5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
            People{" "}
            <span className="font-normal normal-case">
              ({selected.length} added)
            </span>
          </label>
          <div className="rounded-lg border border-app-border bg-panel-2 focus-within:border-border-strong">
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
              {selected.map((id) => {
                const u = byId.get(id);
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1.5 rounded-full bg-app-accent-soft py-1 pl-2.5 pr-1.5 text-[13px] font-semibold text-app-accent"
                  >
                    {u?.name ?? id}
                    <button
                      onClick={() => toggle(id)}
                      title={`Remove ${u?.name ?? id}`}
                      className="flex text-app-accent"
                    >
                      <X size={13} strokeWidth={2.4} />
                    </button>
                  </span>
                );
              })}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={selected.length ? "Add another" : "Type a name"}
                className="min-w-[120px] flex-1 bg-transparent py-1 text-[14px] text-app-text outline-none placeholder:text-app-faint"
              />
            </div>
            <div className="app-scroll max-h-[210px] overflow-y-auto border-t border-app-border p-1">
              {filtered.length === 0 ? (
                <div className="px-2 py-2 text-[12.5px] text-app-muted">
                  {candidates.length === 0
                    ? "Nobody else is in this workspace yet."
                    : query
                      ? `No people match "${query}".`
                      : "Everyone's already added."}
                </div>
              ) : (
                filtered.map((u) => (
                  <button
                    key={memberId(u)}
                    onClick={() => toggle(memberId(u))}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-panel-hover"
                  >
                    <Avatar initials={u.initials} bg={u.bg} size={28} radius={999} />
                    <span className="text-[13.5px] font-medium">{u.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-app-faint">
            <Users size={12} strokeWidth={2} />
            Nobody outside this list will see the group.
          </div>

          {error && (
            <div className="mt-4 text-[13px] text-app-red">{error}</div>
          )}

          <div className="mt-6 flex justify-end">
            <button
              onClick={submit}
              disabled={!canCreate}
              className="flex h-9 items-center gap-1.5 rounded-md px-4 text-[13.5px] font-semibold disabled:cursor-not-allowed"
              style={{
                background: canCreate
                  ? "var(--app-accent)"
                  : "var(--panel-hover)",
                color: canCreate ? "var(--on-accent)" : "var(--app-faint)",
              }}
            >
              Create group
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
