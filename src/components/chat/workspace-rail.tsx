"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { Archive, LogOut, MessageCircle, Moon, Settings, Sun, Users } from "lucide-react";
import { useMounted } from "@/lib/use-mounted";
import { useChat, type NavPanel } from "./chat-context";
import { Avatar } from "./bits";
import { SignOutDialog } from "./key-backup";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV: { key: NavPanel | null; icon: typeof MessageCircle; label: string }[] = [
  { key: null, icon: MessageCircle, label: "Chats" },
  { key: "people", icon: Users, label: "People" },
  { key: "archived", icon: Archive, label: "Archived" },
];

export function WorkspaceRail() {
  const {
    openSettings,
    myUser,
    workspaceName,
    activePanel,
    openPanel,
    closePanel,
    settingsOpen,
    archivedIds,
  } = useChat();
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const [signOutOpen, setSignOutOpen] = useState(false);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    // desktop:pt-12 clears the macOS traffic lights (hiddenInset frame) that
    // overlay this corner in the Electron shell; app-drag makes the rail the
    // window's grab area.
    <aside className="app-drag flex w-[68px] shrink-0 flex-col items-center gap-2 border-r border-app-border bg-rail py-3.5 desktop:pt-12">
      {/* Messenger-style app mark — click returns to Chats */}
      <button
        title={workspaceName}
        onClick={closePanel}
        className="sent-grad mb-1 flex size-10 items-center justify-center rounded-full text-white"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 2C6.5 2 2 6.14 2 11.25c0 2.88 1.43 5.45 3.67 7.14V22l3.36-1.84c.95.26 1.95.4 2.97.4 5.5 0 10-4.14 10-9.25S17.5 2 12 2zm1.03 12.44l-2.55-2.72-4.98 2.72 5.48-5.82 2.61 2.72 4.92-2.72-5.48 5.82z" />
        </svg>
      </button>

      {NAV.map(({ key, icon: Icon, label }) => {
        const active = key === null ? !activePanel && !settingsOpen : activePanel === key;
        const badge = key === "archived" ? archivedIds.length : 0;
        return (
          <button
            key={label}
            title={label}
            onClick={() => (key === null ? closePanel() : openPanel(key))}
            className={`relative flex size-11 items-center justify-center rounded-full ${
              active
                ? "bg-app-accent-soft text-app-accent"
                : "text-rail-text hover:bg-rail-hover"
            }`}
          >
            <Icon
              size={22}
              strokeWidth={active ? 2.1 : 1.9}
              fill={active && key === null ? "currentColor" : "none"}
            />
            {badge > 0 && (
              <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-app-accent px-1 text-[10px] font-bold text-on-accent">
                {badge}
              </span>
            )}
          </button>
        );
      })}

      <div className="flex-1" />

      <button
        onClick={() => setTheme(isDark ? "light" : "dark")}
        title="Toggle theme"
        className="flex size-11 items-center justify-center rounded-full text-rail-text hover:bg-rail-hover"
      >
        {isDark ? <Sun size={21} strokeWidth={1.8} /> : <Moon size={21} strokeWidth={1.8} />}
      </button>
      <button
        onClick={openSettings}
        title="Preferences"
        className={`flex size-11 items-center justify-center rounded-full ${
          settingsOpen
            ? "bg-app-accent-soft text-app-accent"
            : "text-rail-text hover:bg-rail-hover"
        }`}
      >
        <Settings size={21} strokeWidth={1.8} />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          title="You"
          className="relative mt-1 flex size-10 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-app-accent/70"
        >
          <Avatar
            initials={myUser.initials}
            bg={myUser.bg}
            src={myUser.avatar}
            size={40}
            radius={999}
          />
          <span
            className="absolute bottom-0 right-0 size-3 rounded-full bg-app-green"
            style={{ border: "2.5px solid var(--rail)" }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate text-sm font-semibold text-foreground">
                {myUser.name}
              </span>
              {myUser.id && (
                <span className="truncate text-xs font-normal text-muted-foreground">
                  {myUser.id}
                </span>
              )}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              openSettings();
            }}
          >
            <Settings />
            Preferences
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setSignOutOpen(true)}
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </aside>
  );
}
