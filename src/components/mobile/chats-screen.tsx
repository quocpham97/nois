"use client";

import { useCallback, useMemo } from "react";
import { Search, SquarePen } from "lucide-react";
import { previewOf, ConvAvatar } from "../chat/sidebar";
import { Avatar } from "../chat/bits";
import type { Group } from "@/lib/chat-data";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/chat-store";
import { useArchivedIds, useMyUser } from "@/stores/chat-selectors";
import { useChatActions } from "../chat/chat-actions";

// Chats tab — the mobile home. Mirrors the "Chats" screen of Messenger Mobile:
// big title + compose, a search pill, an "active now" avatar strip, then the
// conversation rows. All data is live from the chat store; rows reuse the desktop
// sidebar's previewOf() and ConvAvatar so previews/avatars stay identical.
function lastTs(ch: Group): number {
  return ch.messages[ch.messages.length - 1]?.ts ?? 0;
}

export function ChatsScreen() {
  const { groups, groupOrder, dmOrder, unreadByGroup } = useChatStore(
    useShallow((s) => ({
      groups: s.groups,
      groupOrder: s.groupOrder,
      dmOrder: s.dmOrder,
      unreadByGroup: s.unreadByGroup,
    })),
  );
  const myUser = useMyUser();
  const archivedIds = useArchivedIds();
  const isArchived = useCallback(
    (id: string) => archivedIds.includes(id),
    [archivedIds],
  );
  const { selectGroup, openNewChat, openSearch } = useChatActions();

  const rows = useMemo(() => {
    const ids = [...groupOrder, ...dmOrder].filter(
      (id) => groups[id] && !isArchived(id),
    );
    return ids
      .map((id) => groups[id])
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [groups, groupOrder, dmOrder, isArchived]);

  // "Active now" strip: DM partners currently online (presence rides on the DM
  // group), tapping opens that DM.
  const active = useMemo(
    () =>
      Object.values(groups).filter(
        (ch) => ch.type === "dm" && ch.presence === "active" && ch.user,
      ),
    [groups],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-[18px] pb-2.5 pt-1">
        <h1 className="m-0 text-[26px] font-extrabold tracking-[-0.02em] text-app-text">
          Chats
        </h1>
        <button
          onClick={openNewChat}
          aria-label="New message"
          className="flex size-[38px] items-center justify-center rounded-full bg-panel text-app-text active:bg-app-hover"
        >
          <SquarePen size={19} strokeWidth={1.9} />
        </button>
      </div>

      <div className="px-4 pb-2.5">
        <button
          onClick={openSearch}
          className="flex h-10 w-full items-center gap-2.5 rounded-[20px] bg-panel px-3.5 text-left text-[15px] text-app-faint"
        >
          <Search size={18} strokeWidth={2} />
          Search
        </button>
      </div>

      {active.length > 0 && (
        <div className="app-scroll flex shrink-0 gap-4 overflow-x-auto px-[18px] pb-3 pt-1">
          {active.map((ch) => (
            <button
              key={ch.id}
              onClick={() => selectGroup(ch.id)}
              className="flex w-[58px] shrink-0 flex-col items-center gap-1.5"
            >
              <span className="relative">
                <Avatar
                  initials={ch.user!.initials}
                  bg={ch.user!.bg}
                  src={ch.user!.avatar}
                  size={56}
                />
                <span className="absolute bottom-0.5 right-0.5 size-[14px] rounded-full border-[2.5px] border-app-bg bg-app-green" />
              </span>
              <span className="max-w-[58px] truncate text-[11.5px] text-app-muted">
                {ch.user!.name.split(" ")[0]}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="app-scroll flex-1 overflow-y-auto px-2 pb-3 pt-0.5">
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13.5px] text-app-muted">
            No conversations yet.
          </div>
        ) : (
          rows.map((ch) => {
            const pv = previewOf(ch);
            const unread = (unreadByGroup[ch.id] ?? 0) > 0;
            const name = ch.type === "dm" ? ch.user?.name ?? ch.name : ch.name;
            return (
              <button
                key={ch.id}
                onClick={() => selectGroup(ch.id)}
                className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left active:bg-app-hover"
              >
                <ConvAvatar ch={ch} me={myUser} size={56} />
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <div
                    className={`truncate text-[16px] text-app-text ${
                      unread ? "font-bold" : "font-semibold"
                    }`}
                  >
                    {name}
                  </div>
                  <div
                    className={`truncate text-[14px] ${
                      unread
                        ? "font-medium text-app-text"
                        : "text-app-muted"
                    }`}
                  >
                    {pv?.text || "No messages yet"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span
                    className={`text-[12.5px] ${
                      unread
                        ? "font-medium text-app-accent"
                        : "text-app-faint"
                    }`}
                  >
                    {pv?.time}
                  </span>
                  {unread && (
                    <span className="size-[11px] rounded-full bg-app-accent" />
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
