"use client";

import { useState } from "react";
import { Check, UserPlus, X } from "lucide-react";
import type { User } from "@/lib/chat-data";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/chat-store";
import { useChatActions } from "./chat-actions";

const memberId = (u: User) => u.id ?? u.name.split(" ")[0].toLowerCase();

function Avatar({ user, size = 32 }: { user: User; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md font-semibold text-white"
      style={{ background: user.bg, width: size, height: size, fontSize: size * 0.4 }}
    >
      {user.initials}
    </span>
  );
}

export function WorkspaceView() {
  const { workspaceName, workspaceMembers } = useChatStore(
    useShallow((s) => ({
      workspaceName: s.workspaceName,
      workspaceMembers: s.workspaceMembers,
    })),
  );
  const {
    closeWorkspace,
    renameWorkspace,
    inviteWorkspaceMember,
    removeWorkspaceMember,
  } = useChatActions();

  const [name, setName] = useState(workspaceName);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  const save = () => {
    setError(null);
    renameWorkspace(name, setError);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };
  const invite = () => {
    const e = email.trim();
    if (!e) return;
    inviteWorkspaceMember(e);
    setEmail("");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && closeWorkspace()}>
      <DialogContent className="flex max-h-[85vh] w-[600px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
        <div className="flex h-14 shrink-0 items-center border-b border-app-border px-5">
          <DialogTitle className="text-[16px] font-bold">
            Workspace settings
          </DialogTitle>
        </div>

        <div className="app-scroll flex-1 overflow-y-auto">
          <div className="px-6 py-6">
          {/* Name */}
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
            Workspace name
          </label>
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) save();
              }}
              maxLength={60}
              className="flex-1 rounded-lg border border-app-border bg-panel-2 px-3 py-2.5 text-[14px] font-medium text-app-text outline-none focus:border-border-strong"
            />
            <button
              onClick={save}
              disabled={!name.trim() || name.trim() === workspaceName}
              className="flex h-[42px] items-center gap-1.5 rounded-lg px-4 text-[13.5px] font-semibold disabled:cursor-not-allowed"
              style={{
                background:
                  name.trim() && name.trim() !== workspaceName
                    ? "var(--app-accent)"
                    : "var(--panel-hover)",
                color:
                  name.trim() && name.trim() !== workspaceName
                    ? "var(--on-accent)"
                    : "var(--app-faint)",
              }}
            >
              {savedFlash ? <Check size={14} strokeWidth={2.4} /> : null}
              {savedFlash ? "Saved" : "Save"}
            </button>
          </div>
          {error && <div className="mt-2 text-[13px] text-app-red">{error}</div>}

          {/* Invite */}
          <div className="mt-8">
            <div className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
              <UserPlus size={13} strokeWidth={2} /> Invite by email
            </div>
            <div className="flex items-center gap-2">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") invite();
                }}
                type="email"
                placeholder="name@company.com"
                className="flex-1 rounded-lg border border-app-border bg-panel-2 px-3 py-2.5 text-[14px] text-app-text outline-none focus:border-border-strong"
              />
              <button
                onClick={invite}
                disabled={!email.trim()}
                className="h-[42px] rounded-lg border border-app-border px-4 text-[13.5px] font-semibold text-app-text hover:bg-panel-hover disabled:cursor-not-allowed disabled:text-app-faint"
              >
                Invite
              </button>
            </div>
          </div>

          {/* Members */}
          <div className="mt-8">
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
              Members · {workspaceMembers.length}
            </div>
            <div className="overflow-hidden rounded-lg border border-app-border">
              {workspaceMembers.map((u, i) => (
                <div
                  key={u.name + i}
                  className="group flex items-center gap-3 border-b border-app-border px-3 py-2.5 last:border-b-0 hover:bg-panel-hover"
                >
                  <Avatar user={u} size={32} />
                  <span className="flex-1 text-[13.5px] font-medium text-app-text">
                    {u.name}
                  </span>
                  <button
                    onClick={() => removeWorkspaceMember(memberId(u))}
                    title={`Remove ${u.name}`}
                    className="flex size-7 items-center justify-center rounded text-app-muted opacity-0 hover:bg-panel hover:text-app-red group-hover:opacity-100"
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                </div>
              ))}
              {workspaceMembers.length === 0 && (
                <div className="px-3 py-3 text-[13px] text-app-muted">
                  No members yet.
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
