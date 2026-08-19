"use client";

import { useTheme } from "next-themes";
import { signOut } from "next-auth/react";
import { Bell, LogOut, Moon, ShieldCheck, UserRound } from "lucide-react";
import { Avatar } from "../chat/bits";
import { useMounted } from "@/lib/use-mounted";
import { useChatStore } from "@/stores/chat-store";
import { useMyUser } from "@/stores/chat-selectors";
import { useChatActions } from "../chat/chat-actions";

function Row({
  icon,
  label,
  value,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  value?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3.5 rounded-2xl px-3 py-3 text-left active:bg-app-hover"
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-panel ${
          danger ? "text-app-red" : "text-app-text"
        }`}
      >
        {icon}
      </span>
      <span
        className={`flex-1 text-[16px] font-medium ${
          danger ? "text-app-red" : "text-app-text"
        }`}
      >
        {label}
      </span>
      <span className="text-[14px] text-app-muted">{value}</span>
    </button>
  );
}

// Profile tab. Header identity from the live profile/myUser; the settings rows
// deep-link into the real SettingsView tabs, "Dark mode" toggles next-themes
// directly, and "Log out" runs the NextAuth sign-out (same as key-backup.tsx).
export function ProfileScreen() {
  const myUser = useMyUser();
  const profile = useChatStore((s) => s.profile);
  const { openSettings, setSettingsTab } = useChatActions();
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const isDark = mounted && resolvedTheme === "dark";

  const name = profile.displayName || profile.fullName || myUser.name;
  const subtitle = profile.statusText
    ? `${profile.statusEmoji ?? ""} ${profile.statusText}`.trim()
    : "Active now";

  const go = (tab: "profile" | "notifications" | "privacy") => () => {
    setSettingsTab(tab);
    openSettings();
  };

  return (
    <div className="app-scroll h-full overflow-y-auto">
      <div className="flex flex-col items-center gap-3 px-5 pb-6 pt-3">
        <Avatar
          initials={myUser.initials}
          bg={myUser.bg}
          src={profile.avatar ?? myUser.avatar}
          size={96}
          fontSize={34}
        />
        <div className="text-center">
          <div className="text-[22px] font-extrabold tracking-[-0.01em] text-app-text">
            {name}
          </div>
          <div className="mt-0.5 text-[14px] text-app-muted">{subtitle}</div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 px-4 pb-6">
        <Row
          icon={<UserRound size={19} strokeWidth={1.9} />}
          label="Edit profile"
          onClick={go("profile")}
        />
        <Row
          icon={<Bell size={19} strokeWidth={1.9} />}
          label="Notifications"
          onClick={go("notifications")}
        />
        <Row
          icon={<ShieldCheck size={19} strokeWidth={1.9} />}
          label="Privacy"
          onClick={go("privacy")}
        />
        <Row
          icon={<Moon size={19} strokeWidth={1.9} />}
          label="Dark mode"
          value={mounted ? (isDark ? "On" : "Off") : ""}
          onClick={() => setTheme(isDark ? "light" : "dark")}
        />
        <Row
          icon={<LogOut size={19} strokeWidth={1.9} />}
          label="Log out"
          danger
          onClick={() => void signOut({ callbackUrl: "/login" })}
        />
      </div>
    </div>
  );
}
