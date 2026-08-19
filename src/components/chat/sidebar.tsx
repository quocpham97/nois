"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  AtSign,
  Building2,
  FileText,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Smile,
  SquarePen,
} from "lucide-react";
import {
  callEventTitle,
  groupMembers,
  presenceColor,
  presenceLabel,
  type Group,
  type Presence,
  type User,
} from "@/lib/chat-data";
import { useChat, type ChatFilter, type NavPanel } from "./chat-context";
import { ConnectionStatus } from "./socket-context";
import { Avatar, GroupIcon, GroupAvatar } from "./bits";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MENU_PANELS: { key: NavPanel; icon: typeof AtSign; label: string }[] = [
  { key: "mentions", icon: AtSign, label: "Mentions" },
  { key: "drafts", icon: FileText, label: "Drafts" },
];

const FILTERS: { key: ChatFilter; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "unread", label: "Unread" },
  { key: "groups", label: "Groups" },
];

// Last-message preview line for a conversation row, Messenger-style
// ("You: Knew it 😄 …" / "Lena: Dropping the cover"). Encrypted messages that
// haven't decrypted yet show a lock; attachment-only messages show a label.
export function previewOf(ch: Group): { text: string; time: string } | null {
  const m = ch.messages[ch.messages.length - 1];
  if (!m) return null;
  // A call event reads as its own line ("Missed voice call") — no "You:" prefix,
  // which would make the caller's own row say "You: No answer".
  if (m.call) {
    return { text: callEventTitle(m.call, m.self), time: m.time };
  }
  const who = m.self
    ? "You: "
    : ch.type === "dm"
      ? ""
      : m.author.name.split(" ")[0] + ": ";
  let body = m.text;
  if (m.deleted) body = "Message deleted";
  else if (!body && m.enc) body = "🔒 Message";
  else if (!body && m.attachment) body = "📎 " + m.attachment.name;
  return { text: who + (body || ""), time: m.time };
}

/** Conversation avatar: DM presence avatar, group overlap, or # circle. */
export function ConvAvatar({
  ch,
  me,
  size = 40,
}: {
  ch: Group;
  me: User;
  size?: number;
}) {
  if (ch.type === "dm" && ch.user) {
    return (
      <span className="relative shrink-0">
        <Avatar initials={ch.user.initials} bg={ch.user.bg} size={size} radius={999} />
        <span
          className="absolute -bottom-px -right-px rounded-full"
          style={{
            width: Math.max(11, size * 0.27),
            height: Math.max(11, size * 0.27),
            background: presenceColor(ch.presence),
            border: "2.5px solid var(--app-bg)",
          }}
        />
      </span>
    );
  }
  const others = groupMembers(ch, me).filter((u) => u.name !== me.name);
  if (others.length >= 2) return <GroupAvatar members={others} size={size} />;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-panel"
      style={{ width: size, height: size }}
    >
      <GroupIcon group={ch} color="var(--app-muted)" size={Math.round(size * 0.4)} />
    </span>
  );
}

// Placeholder rows shown on a first-ever load (no local roster cache yet) while
// the server roster is still in flight — so the list reads as "loading", not
// empty. Once cache or the roster populates the list, real rows replace these.
function ConversationSkeleton() {
  const widths = ["w-1/3", "w-2/5", "w-1/4", "w-1/2", "w-1/3", "w-2/5"];
  return (
    <div className="animate-pulse" aria-hidden="true">
      {widths.map((w, i) => (
        <div
          key={i}
          className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2"
        >
          <div className="size-11 shrink-0 rounded-full bg-app-hover-strong" />
          <div className="min-w-0 flex-1">
            <div className={`h-3.5 rounded-md bg-app-hover-strong ${w}`} />
            <div className="mt-2 h-3 w-3/5 rounded-md bg-app-hover-strong" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A round person avatar with a presence dot in the corner (roster/active-now). */
export function PresenceAvatar({
  user,
  presence,
  size,
}: {
  user: User;
  presence?: Presence;
  size: number;
}) {
  return (
    <span className="relative shrink-0">
      <Avatar
        initials={user.initials}
        bg={user.bg}
        src={user.avatar}
        size={size}
        radius={999}
      />
      <span
        className="absolute -bottom-px -right-px rounded-full"
        style={{
          width: Math.max(10, size * 0.28),
          height: Math.max(10, size * 0.28),
          background: presenceColor(presence),
          border: "2.5px solid var(--app-bg)",
        }}
      />
    </span>
  );
}

/**
 * Sidebar "People" mode: the workspace roster, Messenger-style — an "Active now"
 * strip plus an alphabetical Contacts list. Clicking a row opens (or starts) a DM.
 */
function PeopleSidebarBody() {
  const {
    workspaceMembers,
    myUser,
    groups,
    dmOrder,
    selectGroup,
    openCompose,
    addRecipient,
  } = useChat();
  const [q, setQ] = useState("");

  // Presence is tracked per DM group, keyed by the partner's id; fold those
  // into a lookup so a roster row shows live presence even without a DM open.
  const presenceOf = useMemo(() => {
    const map: Record<string, Presence> = {};
    Object.values(groups).forEach((ch) => {
      if (ch.type === "dm" && ch.user?.id && ch.presence) {
        map[ch.user.id] = ch.presence;
      }
    });
    return (u: User) => (u.id ? map[u.id] : undefined);
  }, [groups]);

  const dmFor = (name: string, id?: string) =>
    dmOrder.find((chId) => {
      const u = groups[chId]?.user;
      return u && (u.id ? u.id === id : u.name === name);
    });

  const openPerson = (p: User) => {
    const dmId = dmFor(p.name, p.id);
    if (dmId) selectGroup(dmId);
    else {
      openCompose();
      addRecipient(p.name);
    }
  };

  // Everyone but the viewer (matched by stable id), alphabetical, filtered.
  const people = useMemo(() => {
    const meId = myUser.id ?? myUser.name;
    const needle = q.trim().toLowerCase();
    return workspaceMembers
      .filter((u) => (u.id ?? u.name) !== meId)
      .filter((u) => !needle || u.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workspaceMembers, myUser, q]);

  const activeNow = q.trim()
    ? []
    : people.filter((p) => presenceOf(p) === "active");

  return (
    <>
      <div className="px-3 py-1.5">
        <label className="flex h-[38px] items-center gap-2.5 rounded-full bg-panel px-3.5">
          <Search size={16} strokeWidth={2} className="shrink-0 text-app-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people"
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] text-app-text outline-none placeholder:text-app-muted"
          />
        </label>
      </div>
      <div className="app-scroll flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {people.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13.5px] text-app-muted">
            {q.trim()
              ? `No people match “${q.trim()}”.`
              : "Nobody else is here yet."}
          </div>
        ) : (
          <>
            {activeNow.length > 0 && (
              <div className="pb-1 pt-1">
                <div className="px-3 pb-2 text-[12px] font-bold uppercase tracking-[0.04em] text-app-faint">
                  Active now
                </div>
                <div className="app-scroll flex gap-3.5 overflow-x-auto px-3 pb-2">
                  {activeNow.map((p) => (
                    <button
                      key={p.id ?? p.name}
                      onClick={() => openPerson(p)}
                      title={p.name}
                      className="flex w-[60px] shrink-0 flex-col items-center gap-1.5"
                    >
                      <PresenceAvatar user={p} presence="active" size={56} />
                      <span className="max-w-[60px] truncate text-[12.5px] text-app-text">
                        {p.name.split(" ")[0]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="px-3 pb-2 pt-1 text-[12px] font-bold uppercase tracking-[0.04em] text-app-faint">
              Contacts
            </div>
            {people.map((p) => {
              const presence = presenceOf(p);
              const dmId = dmFor(p.name, p.id);
              return (
                <div
                  key={p.id ?? p.name}
                  className="flex items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-app-hover"
                >
                  <button
                    onClick={() => openPerson(p)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <PresenceAvatar user={p} presence={presence} size={46} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-app-text">
                        {p.name}
                      </span>
                      <span
                        className={`block truncate text-[12.5px] ${
                          presence === "active"
                            ? "text-app-green"
                            : "text-app-muted"
                        }`}
                      >
                        {presence
                          ? presenceLabel(presence)
                          : dmId
                            ? "Chat"
                            : "Start a chat"}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => openPerson(p)}
                    title="Message"
                    className="flex size-[38px] shrink-0 items-center justify-center rounded-full bg-panel text-app-accent hover:bg-app-accent-soft"
                  >
                    <MessageCircle size={18} strokeWidth={1.9} />
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

/** Sidebar "Archived" mode: archived chats; unarchive or jump back in. */
function ArchivedSidebarBody() {
  const { groups, archivedIds, toggleArchived, selectGroup, myUser } =
    useChat();
  // Newest-archived first — toggleArchived appends, so reverse for recency.
  const rows = useMemo(
    () => [...archivedIds].reverse().filter((id) => groups[id]),
    [archivedIds, groups],
  );

  return (
    <div className="app-scroll flex-1 overflow-y-auto px-2 pb-3 pt-1">
      <div className="flex items-center gap-2 px-4 pb-2 pt-1 text-[12.5px] text-app-faint">
        <Archive size={14} strokeWidth={1.8} className="shrink-0" />
        Archived chats stay hidden from your inbox.
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13.5px] text-app-muted">
          No archived chats yet.
        </div>
      ) : (
        rows.map((id) => {
          const ch = groups[id];
          const preview = previewOf(ch);
          return (
            <div
              key={id}
              className="flex items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-app-hover"
            >
              <button
                onClick={() => selectGroup(id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <ConvAvatar ch={ch} me={myUser} size={52} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-app-text">
                    {ch.type === "dm" && ch.user ? ch.user.name : ch.name}
                  </span>
                  <span className="mt-px flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-app-muted">
                      {preview?.text || "No messages yet"}
                    </span>
                    {preview?.time && (
                      <span className="shrink-0 whitespace-nowrap text-[12px] text-app-muted">
                        · {preview.time}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              <button
                onClick={() => toggleArchived(id)}
                title="Unarchive"
                className="flex size-[38px] shrink-0 items-center justify-center rounded-full bg-panel text-app-muted hover:bg-app-hover-strong hover:text-app-text"
              >
                <ArchiveRestore size={18} strokeWidth={1.8} />
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

export function Sidebar() {
  const {
    groups,
    currentGroupId,
    selectGroup,
    settingsOpen,
    composeOpen,
    openCompose,
    openSearch,
    openCreateGroup,
    dmOrder,
    groupOrder,
    rosterLoaded,
    activePanel,
    openPanel,
    createGroupOpen,
    drafts,
    workspaceName,
    openWorkspace,
    unreadByGroup,
    myUser,
    profile,
    openStatus,
    chatFilter,
    setChatFilter,
    isArchived,
    toggleArchived,
  } = useChat();

  // Live counts for the options-menu badges, from in-memory group state.
  let threadsCount = 0;
  let mentionsCount = 0;
  Object.values(groups).forEach((ch) =>
    ch.messages.forEach((m) => {
      if (m.snapshot) return; // sidebar preview line, not a real message
      if ((m.threadCount ?? 0) > 0) threadsCount++;
      if (
        !m.self &&
        (m.mentions?.includes(myUser.name) ||
          (m.text?.includes("@" + myUser.name) ?? false))
      )
        mentionsCount++;
    }),
  );
  const badges: Record<string, number> = {
    threads: threadsCount,
    mentions: mentionsCount,
    drafts: Object.keys(drafts).length,
  };

  // Search is a modal overlay, so it doesn't clear the active row.
  const isActive = (id: string) =>
    currentGroupId === id &&
    !settingsOpen &&
    !composeOpen &&
    !activePanel &&
    !createGroupOpen;

  // One Messenger-style list: groups + DMs together, newest activity first,
  // archived chats hidden (they live under the rail's Archived view).
  const lastTs = (id: string) => {
    const msgs = groups[id]?.messages ?? [];
    return msgs.length ? (msgs[msgs.length - 1].ts ?? 0) : 0;
  };
  let ids = [...groupOrder, ...dmOrder].filter(
    (id) => groups[id] && !isArchived(id),
  );
  if (chatFilter === "unread") ids = ids.filter((id) => (unreadByGroup[id] ?? 0) > 0);
  if (chatFilter === "groups") ids = ids.filter((id) => groups[id].type !== "dm");
  ids.sort((a, b) => lastTs(b) - lastTs(a));

  // People & Archived are rail-level nav items that take over the sidebar
  // column (Messenger-style), sharing this header + footer chrome. Mentions and
  // Drafts stay as main-area panels, so the sidebar keeps showing Chats there.
  const peopleMode = activePanel === "people";
  const archivedMode = activePanel === "archived";

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-r border-app-border bg-app-bg">
      {/* Header — doubles as window-drag chrome in the Electron shell */}
      <div className="app-drag flex items-center justify-between px-4 pb-1.5 pt-4 desktop:pt-5">
        <h1 className="m-0 text-[24px] font-bold tracking-[-0.02em] text-app-text">
          {peopleMode ? "People" : archivedMode ? "Archived" : "Chats"}
        </h1>
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              title="Options"
              className="flex size-9 items-center justify-center rounded-full bg-panel text-app-text outline-none hover:bg-panel-hover"
            >
              <MoreHorizontal size={18} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" sideOffset={6} className="w-56">
              {MENU_PANELS.map(({ key, icon: Icon, label }) => (
                <DropdownMenuItem key={key} onClick={() => openPanel(key)}>
                  <Icon />
                  {label}
                  {badges[key] > 0 && (
                    <span className="ml-auto flex h-4 min-w-[18px] items-center justify-center rounded-full bg-app-accent px-[5px] text-[11px] font-semibold text-on-accent">
                      {badges[key]}
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openCreateGroup}>
                <Plus />
                Create a group
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openWorkspace}>
                <Building2 />
                {workspaceName} settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            onClick={openCompose}
            title="New message"
            className="flex size-9 items-center justify-center rounded-full bg-panel text-app-text hover:bg-panel-hover"
          >
            <SquarePen size={17} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {peopleMode && <PeopleSidebarBody />}
      {archivedMode && <ArchivedSidebarBody />}

      {!peopleMode && !archivedMode && (
        <>
      {/* Search */}
      <div className="px-3 py-1.5">
        <button
          onClick={openSearch}
          className="flex h-[38px] w-full items-center gap-2.5 rounded-full bg-panel px-3.5 text-left text-[14px] text-app-muted hover:bg-panel-hover"
        >
          <Search size={16} strokeWidth={2} />
          Search {workspaceName}
          <span className="ml-auto rounded-full border border-app-border px-2 py-px font-mono text-[11px] text-app-faint">
            ⌘K
          </span>
        </button>
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 px-3 pb-2 pt-1.5">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setChatFilter(key)}
            className={`rounded-full px-3.5 py-[7px] text-[13.5px] font-semibold whitespace-nowrap ${
              chatFilter === key
                ? "bg-app-accent-soft text-app-accent"
                : "bg-panel text-app-muted hover:bg-panel-hover"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Conversations */}
      <div className="app-scroll flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {ids.map((id) => {
          const ch = groups[id];
          const active = isActive(id);
          const unread = unreadByGroup[id] ?? 0;
          const preview = previewOf(ch);
          return (
            <div key={id} className="group relative">
              <button
                onClick={() => selectGroup(id)}
                title={unread ? `${unread} unread` : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                  active ? "bg-app-accent-soft" : "hover:bg-app-hover"
                }`}
              >
                <ConvAvatar ch={ch} me={myUser} size={44} />
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[15px] text-app-text"
                    style={{ fontWeight: unread ? 700 : 600 }}
                  >
                    {ch.type === "dm" && ch.user ? ch.user.name : ch.name}
                  </span>
                  <span className="mt-px flex items-center gap-1.5">
                    <span
                      className="min-w-0 flex-1 truncate text-[13px]"
                      style={{
                        color: unread ? "var(--app-text)" : "var(--app-muted)",
                        fontWeight: unread ? 600 : 400,
                      }}
                    >
                      {preview?.text ||
                        (ch.type === "dm" ? "Say hi 👋" : ch.topic || "No messages yet")}
                    </span>
                    {preview?.time && (
                      <span
                        className="whitespace-nowrap text-[12px] group-hover:opacity-0"
                        style={{ color: unread ? "var(--app-text)" : "var(--app-muted)" }}
                      >
                        · {preview.time}
                      </span>
                    )}
                  </span>
                </span>
                {unread > 0 && (
                  <span className="size-3 shrink-0 rounded-full bg-app-accent" />
                )}
              </button>
              <button
                onClick={() => toggleArchived(id)}
                title={isArchived(id) ? "Unarchive" : "Archive"}
                className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-panel-2 text-app-muted opacity-0 shadow-[var(--app-shadow-sm)] hover:text-app-text group-hover:opacity-100"
              >
                {isArchived(id) ? (
                  <ArchiveRestore size={15} strokeWidth={1.8} />
                ) : (
                  <Archive size={15} strokeWidth={1.8} />
                )}
              </button>
            </div>
          );
        })}
        {ids.length === 0 &&
          (!rosterLoaded && groupOrder.length === 0 && dmOrder.length === 0 ? (
            <ConversationSkeleton />
          ) : (
            <div className="px-4 py-10 text-center text-[13.5px] text-app-muted">
              {chatFilter === "unread"
                ? "You're all caught up 🎉"
                : chatFilter === "groups"
                  ? "No group chats yet."
                  : "No conversations yet."}
            </div>
          ))}
      </div>
        </>
      )}

      {/* Connection status */}
      <div className="border-t border-app-border">
        <ConnectionStatus />
      </div>

      {/* User footer */}
      <div className="flex items-center gap-2.5 border-t border-app-border px-3 py-2.5">
        <span className="relative">
          <Avatar
            initials={myUser.initials}
            bg={myUser.bg}
            src={myUser.avatar}
            size={36}
            radius={999}
          />
          <span
            className="absolute -bottom-px -right-px size-[11px] rounded-full bg-app-green"
            style={{ border: "2.5px solid var(--app-bg)" }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{myUser.name}</div>
          <div className="truncate text-[12px] text-app-muted">
            {profile.statusText ? (
              <>
                {profile.statusEmoji && <span>{profile.statusEmoji} </span>}
                {profile.statusText}
              </>
            ) : (
              "Active now"
            )}
          </div>
        </div>
        <button
          onClick={openStatus}
          title="Set status"
          className="flex size-8 items-center justify-center rounded-full text-app-muted hover:bg-app-hover hover:text-app-text"
        >
          <Smile size={16} strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
}
