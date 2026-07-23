"use client";

import { useState } from "react";
import { Hash, Lock } from "lucide-react";
import { useChat } from "./chat-context";

/** Mirror of the server's slug rule, for a live preview of the group id. */
const toSlug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function CreateGroupView() {
  const { closeCreateGroup, createGroup } = useChat();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = toSlug(name);
  const canCreate = slug.length > 0;

  const submit = () => {
    setError(null);
    createGroup(name, topic, isPrivate, setError);
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
            organized around a topic — #marketing, for example.
          </p>

          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
            Name
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-app-border bg-panel-2 px-3 focus-within:border-border-strong">
            <span className="text-app-muted">
              {isPrivate ? (
                <Lock size={15} strokeWidth={1.8} />
              ) : (
                <Hash size={15} strokeWidth={1.8} />
              )}
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
              <span className="font-medium text-app-accent">
                {isPrivate ? "🔒" : "#"}
                {slug}
              </span>
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

          <button
            onClick={() => setIsPrivate((v) => !v)}
            className="mt-5 flex w-full items-start gap-3 rounded-lg border border-app-border bg-panel-2 p-3.5 text-left hover:bg-panel-hover"
          >
            <span className="mt-0.5 text-app-muted">
              <Lock size={16} strokeWidth={1.8} />
            </span>
            <span className="flex-1">
              <span className="block text-[13.5px] font-semibold">
                Make private
              </span>
              <span className="block text-[12.5px] text-app-muted">
                When a group is private, it can only be viewed or joined by
                invitation.
              </span>
            </span>
            <span
              className="mt-0.5 flex h-[18px] w-[30px] items-center rounded-full p-0.5 transition-colors"
              style={{
                background: isPrivate
                  ? "var(--app-accent)"
                  : "var(--app-border)",
              }}
            >
              <span
                className="size-[14px] rounded-full bg-white transition-transform"
                style={{ transform: isPrivate ? "translateX(12px)" : "none" }}
              />
            </span>
          </button>

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
