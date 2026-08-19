"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useChatStore } from "@/stores/chat-store";
import { useChatActions } from "./chat-actions";

const PRESETS = [
  { emoji: "📅", text: "In a meeting" },
  { emoji: "🚌", text: "Commuting" },
  { emoji: "🤒", text: "Out sick" },
  { emoji: "🌴", text: "Vacationing" },
  { emoji: "🏡", text: "Working remotely" },
];

const EMOJIS = [
  "💬", "📅", "🚌", "🚗", "🤒", "🌴", "🏡", "🎧",
  "🥪", "☕", "🏃", "📞", "🎯", "🌙", "✈️", "💻",
];

export function StatusModal() {
  const profile = useChatStore((s) => s.profile);
  const workspaceName = useChatStore((s) => s.workspaceName);
  const { updateProfile, closeStatus } = useChatActions();
  const [emoji, setEmoji] = useState(profile.statusEmoji || "💬");
  const [text, setText] = useState(profile.statusText || "");
  const [pickerOpen, setPickerOpen] = useState(false);

  const save = () => {
    const t = text.trim();
    updateProfile({ statusEmoji: t ? emoji : "", statusText: t });
    closeStatus();
  };
  const clear = () => {
    updateProfile({ statusEmoji: "", statusText: "" });
    closeStatus();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && closeStatus()}>
      <DialogContent className="flex w-[480px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <div className="flex h-14 shrink-0 items-center border-b border-app-border px-5">
          <DialogTitle className="text-[16px] font-bold">Set a status</DialogTitle>
        </div>

        <div className="px-5 py-4">
          {/* status input */}
          <div className="relative flex items-center gap-1 rounded-lg border border-app-border bg-panel-2 pl-1.5 focus-within:border-app-accent">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="flex size-8 items-center justify-center rounded-md text-[18px] hover:bg-panel-hover"
            >
              {emoji}
            </button>
            <input
              value={text}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              maxLength={100}
              placeholder="What's your status?"
              className="flex-1 bg-transparent py-2.5 pr-3 text-[14px] text-app-text outline-none"
            />
          </div>
          {pickerOpen && (
            <div className="mt-2 flex flex-wrap gap-1 rounded-lg border border-app-border bg-panel-2 p-2">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    setEmoji(e);
                    setPickerOpen(false);
                  }}
                  className="flex size-8 items-center justify-center rounded-md text-[18px] hover:bg-panel-hover"
                >
                  {e}
                </button>
              ))}
            </div>
          )}

          {/* suggestions */}
          <div className="mt-5 mb-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
            For {workspaceName}
          </div>
          <div className="-mx-2">
            {PRESETS.map((p) => (
              <button
                key={p.text}
                onClick={() => {
                  setEmoji(p.emoji);
                  setText(p.text);
                }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-panel-hover"
              >
                <span className="text-[18px]">{p.emoji}</span>
                <span className="text-[13.5px] font-semibold text-app-text">
                  {p.text}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-app-border px-5 py-3">
          {profile.statusText && (
            <button
              onClick={clear}
              className="mr-auto text-[13px] font-medium text-app-muted hover:text-app-red"
            >
              Clear status
            </button>
          )}
          <button
            onClick={closeStatus}
            className="ml-auto rounded-md border border-app-border px-4 py-1.5 text-[13.5px] font-medium text-app-muted hover:bg-panel-hover"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded-md px-4 py-1.5 text-[13.5px] font-semibold"
            style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
          >
            Save
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
