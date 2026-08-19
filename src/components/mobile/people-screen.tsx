"use client";

import { useMemo, useState } from "react";
import { MessageCircle, Search } from "lucide-react";
import {
  type Presence,
  type User,
  presenceColor,
  presenceLabel,
} from "@/lib/chat-data";
import { Avatar } from "../chat/bits";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/chat-store";
import { useMyUser } from "@/stores/chat-selectors";
import { useChatActions } from "../chat/chat-actions";

// People tab. Same model as the desktop sidebar's People panel: fold DM-group
// presence into a by-user lookup, list the workspace roster alphabetically, and
// open (or start) a DM on tap.
function PresenceAvatar({
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
      />
      <span
        className="absolute -bottom-px -right-px rounded-full border-[2.5px] border-app-bg"
        style={{
          width: Math.max(11, size * 0.28),
          height: Math.max(11, size * 0.28),
          background: presenceColor(presence),
        }}
      />
    </span>
  );
}

export function PeopleScreen() {
  const { workspaceMembers, groups, dmOrder } = useChatStore(
    useShallow((s) => ({
      workspaceMembers: s.workspaceMembers,
      groups: s.groups,
      dmOrder: s.dmOrder,
    })),
  );
  const myUser = useMyUser();
  const { selectGroup, openCompose, addRecipient } = useChatActions();
  const [q, setQ] = useState("");

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
    <div className="flex h-full flex-col">
      <div className="px-[18px] pb-2.5 pt-1">
        <h1 className="m-0 text-[26px] font-extrabold tracking-[-0.02em] text-app-text">
          People
        </h1>
      </div>
      <div className="px-4 pb-2">
        <label className="flex h-10 items-center gap-2.5 rounded-[20px] bg-panel px-3.5">
          <Search size={18} strokeWidth={2} className="shrink-0 text-app-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people"
            className="min-w-0 flex-1 border-none bg-transparent text-[15px] text-app-text outline-none placeholder:text-app-faint"
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
              <>
                <div className="px-3 pb-1 pt-1 text-[13px] font-bold uppercase tracking-[0.04em] text-app-muted">
                  Active now
                </div>
                <div className="app-scroll flex gap-4 overflow-x-auto px-3 pb-3">
                  {activeNow.map((p) => (
                    <button
                      key={p.id ?? p.name}
                      onClick={() => openPerson(p)}
                      className="flex w-[60px] shrink-0 flex-col items-center gap-1.5"
                    >
                      <PresenceAvatar user={p} presence="active" size={56} />
                      <span className="max-w-[60px] truncate text-[12px] text-app-text">
                        {p.name.split(" ")[0]}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {people.map((p) => {
              const presence = presenceOf(p);
              const online = presence === "active";
              return (
                <div
                  key={p.id ?? p.name}
                  className="flex items-center gap-3 rounded-2xl px-2.5 py-2"
                >
                  <button
                    onClick={() => openPerson(p)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <PresenceAvatar user={p} presence={presence} size={50} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[16px] font-semibold text-app-text">
                        {p.name}
                      </span>
                      <span
                        className={`block truncate text-[13px] ${
                          online ? "text-app-green" : "text-app-muted"
                        }`}
                      >
                        {presence ? presenceLabel(presence) : "Start a chat"}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => openPerson(p)}
                    aria-label={`Message ${p.name}`}
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-app-accent-soft text-app-accent"
                  >
                    <MessageCircle size={20} strokeWidth={1.9} />
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
