"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { ChevronDown } from "lucide-react";
import { useMounted } from "@/lib/use-mounted";
import { CHAT_GRADIENTS, type NotifPrefs } from "@/lib/chat-data";
import {
  currentPushState,
  disablePush,
  enablePush,
  type PushState,
} from "@/lib/push";
import { useChat } from "./chat-context";
import { useSocket } from "./socket-context";
import { BackupPanel } from "./key-backup";
import { Avatar } from "./bits";
import { AvatarCropModal } from "./avatar-crop-modal";

const TIME_ZONES = [
  "(UTC-12:00) International Date Line West",
  "(UTC-11:00) Midway Island, American Samoa",
  "(UTC-10:00) Hawaii",
  "(UTC-09:00) Alaska",
  "(UTC-08:00) Pacific Time (US & Canada)",
  "(UTC-07:00) Mountain Time (US & Canada)",
  "(UTC-07:00) Arizona",
  "(UTC-06:00) Central Time (US & Canada)",
  "(UTC-05:00) Eastern Time (US & Canada)",
  "(UTC-04:00) Atlantic Time (Canada)",
  "(UTC-03:00) Buenos Aires, São Paulo",
  "(UTC-01:00) Azores",
  "(UTC+00:00) London, Dublin, Lisbon",
  "(UTC+01:00) Berlin, Paris, Madrid, Rome",
  "(UTC+02:00) Athens, Cairo, Johannesburg",
  "(UTC+03:00) Moscow, Istanbul, Nairobi",
  "(UTC+03:30) Tehran",
  "(UTC+04:00) Dubai, Abu Dhabi",
  "(UTC+05:00) Karachi, Tashkent",
  "(UTC+05:30) India (Mumbai, New Delhi)",
  "(UTC+06:00) Dhaka, Almaty",
  "(UTC+07:00) Bangkok, Hanoi, Jakarta",
  "(UTC+08:00) Beijing, Singapore, Hong Kong",
  "(UTC+09:00) Tokyo, Seoul",
  "(UTC+09:30) Adelaide, Darwin",
  "(UTC+10:00) Sydney, Melbourne",
  "(UTC+12:00) Auckland, Fiji",
];

/** Read an image file as a data URL (for the crop step). */
function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

const TABS = [
  { id: "general", label: "General" },
  { id: "profile", label: "Profile" },
  { id: "privacy", label: "Privacy" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
] as const;

// Profile field that saves on blur / Enter. Uncontrolled, keyed on the saved
// value so it re-syncs when the server echoes an update back.
function EditableField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
}) {
  return (
    <div className="mt-4">
      <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
        {label}
      </label>
      <input
        key={value}
        defaultValue={value}
        onBlur={(e) => {
          if (e.target.value !== value) onSave(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-app-border bg-panel-2 px-3 text-[14px] text-app-text outline-none focus:border-border-strong"
      />
    </div>
  );
}

function ToggleRow({
  label,
  sub,
  on,
  checked,
  onCheckedChange,
}: {
  label: string;
  sub?: string;
  on?: boolean;
  /** Controlled value; falls back to internal state seeded from `on`. */
  checked?: boolean;
  onCheckedChange?: (next: boolean) => void;
}) {
  const [internal, setInternal] = useState(on ?? false);
  const value = checked ?? internal;
  const toggle = () => {
    if (onCheckedChange) onCheckedChange(!value);
    else setInternal((c) => !c);
  };
  return (
    <div className="flex items-center border-t border-app-border py-3">
      <div className="flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {sub && <div className="text-[12.5px] text-app-muted">{sub}</div>}
      </div>
      <button
        onClick={toggle}
        className="relative h-[22px] w-10 rounded-xl transition-colors"
        style={{ background: value ? "var(--app-accent)" : "var(--border-strong)" }}
      >
        <span
          className="absolute top-0.5 size-[18px] rounded-full bg-white transition-[left] duration-150"
          style={{ left: value ? 20 : 2, boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}
        />
      </button>
    </div>
  );
}

function ProfilePanel() {
  const { myUser, profile, updateProfile, workspaceName, openStatus } = useChat();
  const subtitle = profile.title ?? "";
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      setCropSrc(await readImageFile(file)); // open the crop modal
    } catch {
      /* ignore unreadable images */
    }
  };

  return (
    <div className="max-w-[640px]">
      <h1 className="m-0 text-[22px] font-bold">Profile</h1>
      <p className="mb-6 mt-1 text-[13.5px] text-app-muted">
        This information is visible to other members of {workspaceName}.
      </p>
      <div className="flex items-center gap-5 rounded-[10px] border border-app-border bg-panel-2 p-5">
        <Avatar
          initials={myUser.initials}
          bg={myUser.bg}
          src={myUser.avatar}
          size={76}
          radius={999}
        />
        <div className="flex-1">
          <div className="text-[18px] font-semibold">{myUser.name}</div>
          {subtitle && (
            <div className="text-[13px] text-app-muted">{subtitle}</div>
          )}
        </div>
        {/* Visually hidden (not display:none) so .click() reliably opens the
            native file dialog across browsers/webviews. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={onPickPhoto}
          tabIndex={-1}
          aria-hidden
          className="absolute size-px overflow-hidden opacity-0"
          style={{ clip: "rect(0 0 0 0)" }}
        />
        <div className="flex flex-col items-end gap-1.5">
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-[5px] border border-app-border px-3 py-1.5 text-[13px] font-medium hover:bg-panel-hover"
          >
            {myUser.avatar ? "Change photo" : "Upload photo"}
          </button>
          {myUser.avatar && (
            <button
              onClick={() => updateProfile({ avatar: "" })}
              className="text-[12px] text-app-muted hover:text-app-red"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <EditableField
        label="Full name"
        value={profile.fullName ?? myUser.name}
        onSave={(v) => updateProfile({ fullName: v })}
      />
      <EditableField
        label="Display name"
        value={profile.displayName ?? myUser.name}
        onSave={(v) => updateProfile({ displayName: v })}
      />
      <EditableField
        label="What I do"
        value={profile.title ?? ""}
        placeholder="e.g. Senior Product Designer"
        onSave={(v) => updateProfile({ title: v })}
      />
      <div className="mt-4">
        <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.04em] text-app-muted">
          Time zone
        </label>
        <div className="relative">
          <select
            value={profile.timezone ?? ""}
            onChange={(e) => updateProfile({ timezone: e.target.value })}
            className="h-9 w-full appearance-none rounded-md border border-app-border bg-panel-2 pl-3 pr-9 text-[14px] text-app-text outline-none focus:border-border-strong"
          >
            <option value="">Select a time zone…</option>
            {/* keep a previously-saved free-text value selectable */}
            {profile.timezone && !TIME_ZONES.includes(profile.timezone) && (
              <option value={profile.timezone}>{profile.timezone}</option>
            )}
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            strokeWidth={2}
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-app-muted"
          />
        </div>
        <p className="mt-1.5 text-[12.5px] text-app-muted">
          Used for times in your activity feeds and reminders.
        </p>
      </div>

      <h3 className="mb-2.5 mt-8 text-[14px] font-semibold">Status</h3>
      <button
        onClick={openStatus}
        className="flex w-full items-center gap-2.5 rounded-lg border border-app-border bg-panel-2 px-3 py-2.5 text-left hover:bg-panel-hover"
      >
        {profile.statusText ? (
          <>
            <span className="text-[16px]">{profile.statusEmoji}</span>
            <span className="text-[13.5px] font-medium text-app-text">
              {profile.statusText}
            </span>
            <span className="ml-auto text-[12.5px] text-app-muted">Edit</span>
          </>
        ) : (
          <>
            <span className="text-[16px]">😀</span>
            <span className="text-[13.5px] text-app-muted">Set a status</span>
          </>
        )}
      </button>

      {cropSrc && (
        <AvatarCropModal
          src={cropSrc}
          onCancel={() => setCropSrc(null)}
          onSave={(dataUrl) => {
            updateProfile({ avatar: dataUrl });
            setCropSrc(null);
          }}
        />
      )}
    </div>
  );
}

// End-to-end encryption status for this device. The safety number is derived
// locally from this device's identity public key — two people compare theirs
// out of band to confirm no one (not even the server) swapped a key. Key
// CHANGES for peer devices are surfaced separately by the KeyChangeBanner (the
// only actionable event); we don't render a passive per-device directory here.
function SecurityCard() {
  const { deviceId, fingerprint } = useSocket();
  return (
    <>
      <h3 className="mb-2.5 mt-8 text-[14px] font-semibold">Security</h3>
      <div className="rounded-lg border border-app-border bg-panel-2 px-3 py-3">
        <div className="flex items-center gap-2">
          <span
            className="size-[7px] shrink-0 rounded-full"
            style={{ background: fingerprint ? "var(--app-green)" : "var(--app-faint)" }}
          />
          <span className="text-[13.5px] font-medium">
            {fingerprint ? "Encryption keys active on this device" : "Provisioning keys…"}
          </span>
        </div>
        {fingerprint && (
          <>
            <div className="mt-3 text-[12.5px] text-app-muted">
              Your safety number — compare it with a contact (out of band) to
              verify no one is intercepting your keys.
            </div>
            <div className="mt-1.5 select-all font-mono text-[13px] tracking-wide text-app-text">
              {fingerprint}
            </div>
            {deviceId && (
              <div className="mt-2 text-[11px] text-app-faint">
                Device {deviceId.slice(0, 8)}
              </div>
            )}
          </>
        )}
      </div>
      <div className="mt-3">
        <BackupPanel />
      </div>
    </>
  );
}

function AppearancePanel() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { bubbleTheme, setBubbleTheme } = useChat();
  const mounted = useMounted();
  const current = mounted ? theme : "light";

  return (
    <div className="max-w-[640px]">
      <h1 className="m-0 text-[24px] font-bold">Appearance</h1>
      <p className="mb-6 mt-1 text-[14px] text-app-muted">
        Customize how Messenger looks.
      </p>
      <div className="grid grid-cols-3 gap-3">
        {(["light", "dark", "system"] as const).map((t) => {
          const active = current === t;
          const isLight =
            t === "light" || (t === "system" && resolvedTheme === "light");
          return (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className="rounded-xl bg-panel-2 p-3 text-left"
              style={{
                border: `2px solid ${active ? "var(--app-accent)" : "var(--app-border)"}`,
              }}
            >
              <div
                className="mb-2.5 flex h-[70px] flex-col gap-1.5 rounded-lg border border-app-border p-2"
                style={{
                  background:
                    t === "system"
                      ? "linear-gradient(90deg, #FFFFFF 50%, #1C1C1D 50%)"
                      : isLight
                        ? "#FFFFFF"
                        : "#1C1C1D",
                }}
              >
                <div
                  className="h-3 w-1/2 self-start rounded-lg"
                  style={{ background: isLight ? "#EFEFF3" : "#303032" }}
                />
                <div
                  className="sent-grad h-3 w-2/5 self-end rounded-lg"
                />
              </div>
              <div className="text-[14px] font-semibold capitalize">{t}</div>
            </button>
          );
        })}
      </div>

      <h3 className="mb-1 mt-8 text-[15px] font-semibold">Default chat color</h3>
      <div className="mt-3 flex gap-3">
        {Object.entries(CHAT_GRADIENTS).map(([key, grad]) => (
          <button
            key={key}
            title={key}
            onClick={() => setBubbleTheme(key)}
            className="size-[38px] rounded-full"
            style={{
              background: grad,
              boxShadow:
                bubbleTheme === key
                  ? "0 0 0 2px var(--app-bg), 0 0 0 4px var(--app-accent)"
                  : "none",
            }}
          />
        ))}
      </div>
    </div>
  );
}

type GeneralPrefs = { activeStatus: boolean; readReceipts: boolean; enterToSend: boolean };
const GENERAL_DEFAULTS: GeneralPrefs = {
  activeStatus: true,
  readReceipts: true,
  enterToSend: true,
};

function GeneralPanel() {
  const { userId, profile, updateProfile } = useChat();
  const key = `chat:general:${userId}`;
  const [prefs, setPrefs] = useState<GeneralPrefs>(() => {
    if (typeof window === "undefined") return GENERAL_DEFAULTS;
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...GENERAL_DEFAULTS, ...JSON.parse(raw) } : GENERAL_DEFAULTS;
    } catch {
      return GENERAL_DEFAULTS;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch {}
  }, [key, prefs]);
  const set = (patch: Partial<GeneralPrefs>) => setPrefs((p) => ({ ...p, ...patch }));

  return (
    <div className="max-w-[640px]">
      <h1 className="m-0 text-[24px] font-bold">General</h1>
      <p className="mb-6 mt-1 text-[14px] text-app-muted">
        How Messenger behaves day to day.
      </p>
      <ToggleRow
        label="Active status"
        sub="Let others see when you're active"
        checked={prefs.activeStatus}
        onCheckedChange={(v) => set({ activeStatus: v })}
      />
      <ToggleRow
        label="Read receipts"
        sub="Let others know when you've seen messages"
        checked={prefs.readReceipts}
        onCheckedChange={(v) => set({ readReceipts: v })}
      />
      <ToggleRow
        label="Enter to send"
        sub="Press Enter to send a message (Shift+Enter for a new line)"
        checked={prefs.enterToSend}
        onCheckedChange={(v) => set({ enterToSend: v })}
      />
      <ToggleRow
        label="Link previews"
        sub="Generate previews for links you send. Fetching one shares that URL with the server; the preview itself stays end-to-end encrypted."
        checked={profile.linkPreviews === true}
        onCheckedChange={(v) => updateProfile({ linkPreviews: v })}
      />
    </div>
  );
}

function PrivacyPanel() {
  return (
    <div className="max-w-[640px]">
      <h1 className="m-0 text-[24px] font-bold">Privacy</h1>
      <p className="mb-2 mt-1 text-[14px] text-app-muted">
        End-to-end encryption, device keys, and backups.
      </p>
      <SecurityCard />
    </div>
  );
}

const NOTIF_DEFAULTS: NotifPrefs = { level: 1, sound: false, dnd: true };

// "Enable on this device" — the real Web Push permission + subscribe flow.
// Tri-state so a blocked permission is explained rather than silently failing.
function PushToggle() {
  const [state, setState] = useState<PushState | "loading" | "working">("loading");
  useEffect(() => {
    void currentPushState().then(setState);
  }, []);

  const label =
    state === "unsupported"
      ? "Push notifications aren’t supported in this browser."
      : state === "denied"
        ? "Blocked in your browser settings — re-allow notifications for this site."
        : state === "enabled"
          ? "Push notifications are on for this device."
          : "Get notified on this device when the app is closed.";

  const busy = state === "loading" || state === "working";
  const toggle = async () => {
    setState("working");
    setState(state === "enabled" ? await disablePush() : await enablePush());
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-app-border bg-panel px-4 py-3">
      <div className="flex-1">
        <div className="text-[14px] font-medium">Push on this device</div>
        <div className="text-[12.5px] text-app-muted">{label}</div>
      </div>
      <button
        onClick={toggle}
        disabled={busy || state === "unsupported" || state === "denied"}
        className="shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50"
        style={{
          background: state === "enabled" ? "var(--panel-hover)" : "var(--app-accent)",
          color: state === "enabled" ? "var(--app-text)" : "#fff",
        }}
      >
        {state === "working"
          ? "…"
          : state === "enabled"
            ? "Turn off"
            : "Enable"}
      </button>
    </div>
  );
}

function NotificationsPanel() {
  const { profile, updateProfile } = useChat();
  const prefs: NotifPrefs = { ...NOTIF_DEFAULTS, ...(profile.notif ?? {}) };
  const set = (patch: Partial<NotifPrefs>) =>
    updateProfile({ notif: { ...prefs, ...patch } });

  return (
    <div className="max-w-[640px]">
      <h1 className="m-0 text-[22px] font-bold">Notifications</h1>
      <p className="mb-6 mt-1 text-[13.5px] text-app-muted">
        Control when and how you get pinged.
      </p>

      <PushToggle />

      <h3 className="mb-2.5 mt-4 text-[14px] font-semibold">Notify me about…</h3>
      {[
        "All new messages",
        "Direct messages & mentions",
        "Nothing",
      ].map((l, i) => (
        <button
          key={l}
          onClick={() => set({ level: i as NotifPrefs["level"] })}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left hover:bg-panel-hover"
        >
          <span
            className="flex size-4 items-center justify-center rounded-full"
            style={{
              border: `2px solid ${prefs.level === i ? "var(--app-accent)" : "var(--border-strong)"}`,
            }}
          >
            {prefs.level === i && (
              <span className="size-2 rounded-full bg-app-accent" />
            )}
          </span>
          <span className="text-[14px]">{l}</span>
        </button>
      ))}
      {prefs.level === 1 && (
        <p className="mt-1 px-3 text-[12px] text-app-muted">
          Mentions in end-to-end encrypted channels can’t be detected by the
          server, so at this level only direct messages notify you.
        </p>
      )}
      <ToggleRow
        label="Sound on every message"
        checked={prefs.sound}
        onCheckedChange={(v) => set({ sound: v })}
      />
      <ToggleRow
        label="Do not disturb · 10:00 PM – 7:00 AM"
        sub="Pause push notifications overnight"
        checked={prefs.dnd}
        onCheckedChange={(v) => set({ dnd: v })}
      />
    </div>
  );
}

export function SettingsView() {
  const { settingsTab, setSettingsTab, closeSettings } = useChat();
  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="w-[220px] shrink-0 border-r border-app-border px-3 py-5">
        <h2 className="mx-3 mb-4 text-[18px] font-bold">Preferences</h2>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSettingsTab(t.id)}
            className="w-full rounded-lg px-3 py-2 text-left text-[14px]"
            style={{
              color: settingsTab === t.id ? "var(--app-text)" : "var(--app-muted)",
              background: settingsTab === t.id ? "var(--panel)" : "transparent",
              fontWeight: settingsTab === t.id ? 600 : 500,
            }}
          >
            {t.label}
          </button>
        ))}
        <div className="my-3.5 border-t border-app-border" />
        <button
          onClick={closeSettings}
          className="w-full rounded-lg px-3 py-2 text-left text-[14px] text-app-muted hover:bg-app-hover"
        >
          ← Back to chats
        </button>
      </aside>
      <div className="app-scroll flex-1 overflow-y-auto px-10 py-8">
        {settingsTab === "profile" ? (
          <ProfilePanel />
        ) : settingsTab === "appearance" ? (
          <AppearancePanel />
        ) : settingsTab === "privacy" ? (
          <PrivacyPanel />
        ) : settingsTab === "notifications" ? (
          <NotificationsPanel />
        ) : (
          <GeneralPanel />
        )}
      </div>
    </div>
  );
}
