"use client";

import { MessageCircle, Phone, UserRound, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type MobileTab = "chats" | "people" | "calls" | "profile";

const TABS: { key: MobileTab; label: string; icon: LucideIcon }[] = [
  { key: "chats", label: "Chats", icon: MessageCircle },
  { key: "people", label: "People", icon: Users },
  { key: "calls", label: "Calls", icon: Phone },
  { key: "profile", label: "Profile", icon: UserRound },
];

// Bottom tab bar. Hidden while a conversation is open (see MobileApp), matching
// the design's `showTabbar = !isChat`. The Chats tab carries an unread badge.
export function TabBar({
  active,
  onSelect,
  unreadCount,
}: {
  active: MobileTab;
  onSelect: (t: MobileTab) => void;
  unreadCount: number;
}) {
  return (
    <div className="flex shrink-0 border-t border-app-border bg-app-bg px-1.5 pb-1 pt-2">
      {TABS.map(({ key, label, icon: Icon }) => {
        const on = active === key;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`flex flex-1 flex-col items-center gap-[3px] py-1 ${
              on ? "text-app-accent" : "text-app-faint"
            }`}
          >
            <span className="relative inline-flex">
              <Icon size={26} strokeWidth={on ? 2.3 : 1.9} />
              {key === "chats" && unreadCount > 0 && (
                <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-lg bg-app-red px-1 text-[10px] font-bold text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </span>
            <span className="text-[10.5px] font-semibold">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
