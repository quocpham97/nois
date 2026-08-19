"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Search,
  X,
} from "lucide-react";
import { presenceLabel, type Attachment, type User } from "@/lib/chat-data";
import { Avatar } from "./bits";
import { ConvAvatar, previewOf } from "./sidebar";
import { useDecryptedImage } from "./message";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/chat-store";
import { useArchivedIds, useMyUser, useUserId } from "@/stores/chat-selectors";
import { useChatActions } from "./chat-actions";
import {
  searchMedia,
  searchMessages,
  SNIPPET_OPEN,
  SNIPPET_CLOSE,
  type MediaHit,
  type SearchHit,
} from "@/lib/message-db";

type Filter = "all" | "people" | "messages" | "media";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "people", label: "People" },
  { id: "messages", label: "Messages" },
  { id: "media", label: "Media" },
];

const RECENTS_MAX = 6;

/** Render an FTS snippet, turning the sentinel-wrapped matched terms into
 *  <mark>. Sentinels can't occur in real text, so this can't inject markup. */
function renderSnippet(snippet: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let rest = snippet;
  let key = 0;
  while (true) {
    const open = rest.indexOf(SNIPPET_OPEN);
    if (open < 0) {
      if (rest) parts.push(rest);
      break;
    }
    if (open > 0) parts.push(rest.slice(0, open));
    const close = rest.indexOf(SNIPPET_CLOSE, open + 1);
    if (close < 0) {
      parts.push(rest.slice(open + 1));
      break;
    }
    parts.push(<Mark key={key++}>{rest.slice(open + 1, close)}</Mark>);
    rest = rest.slice(close + 1);
  }
  return <>{parts}</>;
}

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <mark
      className="rounded-[3px] px-0.5"
      style={{ background: "var(--app-accent-soft)", color: "var(--app-accent)" }}
    >
      {children}
    </mark>
  );
}

/** Highlight the first case-insensitive occurrence of `q` in `text`. */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <Mark>{text.slice(i, i + q.length)}</Mark>
      {text.slice(i + q.length)}
    </>
  );
}

const MEDIA_ICON: Record<Attachment["kind"], typeof ImageIcon> = {
  image: ImageIcon,
  file: FileText,
  video: Film,
  audio: Music,
};

/** 40px media preview: decrypted image thumb (or a video's poster frame) when
 *  available, else a kind icon. useDecryptedImage no-ops without key material,
 *  so it's safe to call for every kind. */
function MediaThumb({ a }: { a: Attachment }) {
  const { src } = useDecryptedImage(a);
  const Icon = MEDIA_ICON[a.kind] ?? FileText;
  // Encrypted images decrypt to an object URL; plaintext images and video
  // posters render their URL directly (plain <img>, no CORS needed).
  const img =
    a.kind === "image" ? (a.encrypted ? src : (a.url ?? null)) :
    a.kind === "video" ? (a.poster ?? null) :
    null;
  if (img) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={img}
        alt={a.name}
        className="size-10 shrink-0 rounded-[10px] border border-app-border object-cover"
      />
    );
  }
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-panel text-app-faint">
      <Icon size={18} strokeWidth={1.8} />
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-4 items-center justify-center rounded-[5px] border border-app-border bg-panel px-1.5 py-0.5 text-center font-mono text-[11px] text-app-muted">
      {children}
    </span>
  );
}

function GroupHead({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1.5 pt-3 text-[11.5px] font-bold uppercase tracking-[0.05em] text-app-muted">
      {label}
      {count != null && (
        <span className="rounded-full bg-panel px-[7px] py-px text-[11px] font-semibold text-app-faint">
          {count}
        </span>
      )}
    </div>
  );
}

/** Messenger-style command palette: centered modal (⌘K / Esc) with filter tabs,
 *  recent searches, jump-to, and keyboard navigation. Messages come from the
 *  on-device FTS index (all history), people from the workspace roster, and
 *  media from the local message store. */
export function SearchView() {
  const { groups, groupOrder, dmOrder, searchQ, workspaceMembers } =
    useChatStore(
      useShallow((s) => ({
        groups: s.groups,
        groupOrder: s.groupOrder,
        dmOrder: s.dmOrder,
        searchQ: s.searchQ,
        workspaceMembers: s.workspaceMembers,
      })),
    );
  const userId = useUserId();
  const myUser = useMyUser();
  const archivedIds = useArchivedIds();
  const isArchived = useCallback(
    (id: string) => archivedIds.includes(id),
    [archivedIds],
  );
  const {
    setSearchQ,
    closeSearch,
    selectGroup,
    jumpToMessage,
    openCompose,
    addRecipient,
  } = useChatActions();
  const q = searchQ.trim();

  const [filter, setFilter] = useState<Filter>("all");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [media, setMedia] = useState<MediaHit[]>([]);
  const [sel, setSel] = useState(0);

  // --- recent searches (persisted per user, like saved/drafts) -------------
  const recentsKey = userId ? `chat:recent-search:${userId}` : null;
  // Hydrate once from localStorage: this modal mounts fresh each time search
  // opens, so a lazy initializer is enough (no re-sync effect needed).
  const [recents, setRecents] = useState<string[]>(() => {
    if (typeof window === "undefined" || !recentsKey) return [];
    try {
      const s = localStorage.getItem(recentsKey);
      return s ? (JSON.parse(s) as string[]) : [];
    } catch {
      return [];
    }
  });
  const pushRecent = (v: string) => {
    const t = v.trim();
    if (!t) return;
    setRecents((prev) => {
      const next = [t, ...prev.filter((x) => x !== t)].slice(0, RECENTS_MAX);
      if (recentsKey) {
        try {
          localStorage.setItem(recentsKey, JSON.stringify(next));
        } catch {
          /* storage full / unavailable — recents are best-effort */
        }
      }
      return next;
    });
  };
  const clearRecents = () => {
    setRecents([]);
    if (recentsKey) {
      try {
        localStorage.removeItem(recentsKey);
      } catch {
        /* ignore */
      }
    }
  };

  // Debounced FTS + media query over all locally-stored decrypted messages. An
  // empty query resolves to [] through the same async path (no synchronous
  // setState in the effect body).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (!q) {
        setHits([]);
        setMedia([]);
        return;
      }
      void searchMessages(q, 50).then((r) => !cancelled && setHits(r));
      void searchMedia(q, 50).then((r) => !cancelled && setMedia(r));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const people = useMemo(
    () =>
      q
        ? workspaceMembers.filter(
            (p) =>
              (p.id ?? p.name) !== (myUser.id ?? myUser.name) &&
              p.name.toLowerCase().includes(q.toLowerCase()),
          )
        : [],
    [q, workspaceMembers, myUser],
  );

  // Conversations for the empty-state "Jump to" list — same ordering as the
  // sidebar (most recent activity first, archived hidden).
  const convIds = useMemo(() => {
    const lastTs = (id: string) => {
      const msgs = groups[id]?.messages ?? [];
      return msgs.length ? (msgs[msgs.length - 1].ts ?? 0) : 0;
    };
    return [...groupOrder, ...dmOrder]
      .filter((id) => groups[id] && !isArchived(id))
      .sort((a, b) => lastTs(b) - lastTs(a));
  }, [groups, groupOrder, dmOrder, isArchived]);

  const convTitle = (groupId: string): string => {
    const ch = groups[groupId];
    if (!ch) return groupId;
    return ch.type === "dm" && ch.user ? ch.user.name : ch.name;
  };
  // Presence for a person, read off any DM group we share with them.
  const presenceOf = (person: User) => {
    for (const id of dmOrder) {
      const ch = groups[id];
      if (ch?.user && (ch.user.id ? ch.user.id === person.id : ch.user.name === person.name))
        return ch.presence;
    }
    return undefined;
  };

  const changeQuery = (v: string) => {
    setSearchQ(v);
    setSel(0);
  };
  const changeFilter = (f: Filter) => {
    setFilter(f);
    setSel(0);
  };

  const openPerson = (person: User) => {
    pushRecent(person.name);
    const dmId = dmOrder.find((chId) => {
      const u = groups[chId]?.user;
      return u && (u.id ? u.id === person.id : u.name === person.name);
    });
    closeSearch();
    if (dmId) selectGroup(dmId);
    else {
      openCompose();
      addRecipient(person.name);
    }
  };
  const openHit = (groupId: string, msgId: string, parentId: string | null) => {
    pushRecent(q);
    closeSearch();
    jumpToMessage(groupId, msgId, parentId);
  };
  const openConv = (groupId: string) => {
    closeSearch();
    selectGroup(groupId);
  };

  // --- keyboard navigation --------------------------------------------------
  // Each render rebuilds a flat list of the actionable rows in visual order;
  // ↑/↓ move `sel`, Enter runs the selected action. The list lives in a ref so
  // the (mount-once) key handler always reads the current one.
  const actionsRef = useRef<(() => void)[]>([]);
  const selRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = actionsRef.current.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (n ? (s + 1) % n : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (n ? (s - 1 + n) % n : 0));
      } else if (e.key === "Enter") {
        const action = actionsRef.current[selRef.current];
        if (action) {
          e.preventDefault();
          action();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The highlight resets to the top whenever the query or filter changes — done
  // in the handlers below (see `changeQuery` / the filter tabs), not in an
  // effect. The key handler clamps modulo the current list, so async result
  // changes never leave it pointing out of range.

  // Keep the selected row visible.
  useEffect(() => {
    const el = scrollRef.current?.querySelector(`[data-nav="${sel}"]`);
    (el as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // --- build rows + parallel action list -----------------------------------
  const actions: (() => void)[] = [];
  const reg = (action: () => void) => {
    const i = actions.length;
    actions.push(action);
    return i;
  };
  const Row = ({
    idx,
    onClick,
    className = "",
    children,
  }: {
    idx: number;
    onClick: () => void;
    className?: string;
    children: React.ReactNode;
  }) => {
    const active = idx === sel;
    return (
      <button
        data-nav={idx}
        onClick={onClick}
        onMouseMove={() => setSel(idx)}
        className={`flex w-full gap-3 rounded-[11px] px-3 py-2.5 text-left ${
          active ? "" : "hover:bg-app-hover"
        } ${className}`}
        style={
          active
            ? {
                background: "var(--app-accent-soft)",
                boxShadow: "inset 0 0 0 1.5px var(--app-accent)",
              }
            : undefined
        }
      >
        {children}
        {active && (
          <span className="ml-auto flex shrink-0 items-center self-center font-mono text-[11px] text-app-accent">
            ↵
          </span>
        )}
      </button>
    );
  };

  const body: React.ReactNode[] = [];
  if (!q) {
    if (recents.length > 0) {
      body.push(
        <div key="recent-head" className="flex items-center px-3 pb-1.5 pt-3">
          <span className="flex-1 text-[11.5px] font-bold uppercase tracking-[0.05em] text-app-muted">
            Recent
          </span>
          <button
            onClick={clearRecents}
            className="rounded px-1.5 py-0.5 text-[12px] text-app-faint hover:text-app-muted"
          >
            Clear
          </button>
        </div>,
        <div key="recent-chips" className="flex flex-wrap gap-2 px-3 pb-2 pt-0.5">
          {recents.map((t) => (
            <button
              key={t}
              onClick={() => {
                setSearchQ(t);
                changeFilter("all");
              }}
              className="flex items-center gap-1.5 rounded-full bg-panel px-3 py-1.5 text-[13px] font-medium text-app-text hover:bg-app-hover-strong"
            >
              <Clock size={13} strokeWidth={2} className="text-app-faint" />
              {t}
            </button>
          ))}
        </div>,
      );
    }
    body.push(<GroupHead key="jump-head" label="Jump to" />);
    convIds.forEach((id) => {
      const ch = groups[id];
      const idx = reg(() => openConv(id));
      body.push(
        <Row key={"j" + id} idx={idx} onClick={() => openConv(id)}>
          <ConvAvatar ch={ch} me={myUser} size={40} />
          <span className="min-w-0 flex-1 self-center">
            <span className="block truncate font-semibold">{convTitle(id)}</span>
            <span className="block truncate text-[12.5px] text-app-muted">
              {previewOf(ch)?.text ||
                (ch.type === "dm" ? "Say hi 👋" : ch.topic || "No messages yet")}
            </span>
          </span>
        </Row>,
      );
    });
  } else {
    const showPeople = (filter === "all" || filter === "people") && people.length > 0;
    const showMsgs = (filter === "all" || filter === "messages") && hits.length > 0;
    const showMedia = (filter === "all" || filter === "media") && media.length > 0;

    if (showPeople) {
      body.push(<GroupHead key="ph" label="People" count={people.length} />);
      people.forEach((p) => {
        const idx = reg(() => openPerson(p));
        const presence = presenceOf(p);
        body.push(
          <Row key={"p" + (p.id ?? p.name)} idx={idx} onClick={() => openPerson(p)}>
            <Avatar initials={p.initials} bg={p.bg} src={p.avatar} size={40} radius={999} />
            <span className="min-w-0 flex-1 self-center">
              <span className="block truncate font-semibold">{highlight(p.name, q)}</span>
              <span className="block truncate text-[12.5px] text-app-muted">
                {presence ? presenceLabel(presence) : "Send a message"}
              </span>
            </span>
          </Row>,
        );
      });
    }

    if (showMsgs) {
      body.push(<GroupHead key="mh" label="Messages" count={hits.length} />);
      hits.forEach((hit) => {
        const idx = reg(() => openHit(hit.groupId, hit.id, hit.parentId));
        const ch = groups[hit.groupId];
        body.push(
          <Row
            key={"m" + hit.id}
            idx={idx}
            onClick={() => openHit(hit.groupId, hit.id, hit.parentId)}
            className="items-start"
          >
            {ch ? (
              <ConvAvatar ch={ch} me={myUser} size={40} />
            ) : (
              <Avatar initials="#" bg="#8b8b8b" size={40} />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate font-semibold">{convTitle(hit.groupId)}</span>
                {hit.parentId && (
                  <span className="text-[12px] text-app-faint">in thread</span>
                )}
                {hit.time && (
                  <span className="ml-auto shrink-0 text-[12px] text-app-faint">
                    {hit.time}
                  </span>
                )}
              </span>
              <span
                className="text-[13.5px] leading-[1.45] text-app-muted"
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {renderSnippet(hit.snippet)}
              </span>
            </span>
          </Row>,
        );
      });
    }

    if (showMedia) {
      body.push(<GroupHead key="mdh" label="Media" count={media.length} />);
      media.forEach((hit) => {
        const idx = reg(() => openHit(hit.groupId, hit.id, hit.parentId));
        body.push(
          <Row
            key={"md" + hit.id}
            idx={idx}
            onClick={() => openHit(hit.groupId, hit.id, hit.parentId)}
          >
            <MediaThumb a={hit.attachment} />
            <span className="min-w-0 flex-1 self-center">
              <span className="block truncate font-semibold text-[14px]">
                {highlight(hit.attachment.label || hit.attachment.name || "Attachment", q)}
              </span>
              <span className="block truncate text-[12.5px] text-app-muted">
                {convTitle(hit.groupId)} · {hit.time}
              </span>
            </span>
          </Row>,
        );
      });
    }

    if (!showPeople && !showMsgs && !showMedia) {
      body.push(
        <div key="none" className="flex flex-col items-center px-5 py-13 text-center">
          <Search size={30} strokeWidth={2} className="mb-3 text-app-faint" />
          <div className="text-[15px] font-semibold text-app-text">
            No results for &ldquo;{q}&rdquo;
          </div>
          <div className="mt-1 text-[13px] text-app-muted">
            Try a different keyword or filter.
          </div>
        </div>,
      );
    }
  }
  // Publish the freshly-built action list for the (mount-once) key handler.
  // Assigned in an effect (not during render) so refs stay render-pure.
  useEffect(() => {
    actionsRef.current = actions;
  });

  const tabCount: Record<Filter, number | null> = {
    all: null,
    people: people.length,
    messages: hits.length,
    media: media.length,
  };

  return (
    <div
      onClick={closeSearch}
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 pt-[9vh]"
      style={{ backdropFilter: "blur(2px)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-fade-in flex max-h-[74vh] w-[640px] max-w-[93vw] flex-col overflow-hidden rounded-[18px] bg-app-bg shadow-[var(--app-shadow-lg)]"
      >
        {/* input */}
        <div className="flex items-center gap-3 px-[18px] pb-3 pt-4">
          <Search size={20} strokeWidth={2} className="shrink-0 text-app-muted" />
          <input
            autoFocus
            value={searchQ}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder="Search people, messages and media"
            className="flex-1 bg-transparent text-[17px] text-app-text outline-none placeholder:text-app-faint"
          />
          {q && (
            <button
              onClick={() => changeQuery("")}
              aria-label="Clear search"
              className="flex shrink-0 text-app-faint hover:text-app-text"
            >
              <X size={18} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* filter tabs */}
        <div className="flex gap-1.5 border-b border-app-border px-4 pb-3">
          {FILTERS.map((t) => {
            const active = filter === t.id;
            const n = q ? tabCount[t.id] : null;
            return (
              <button
                key={t.id}
                onClick={() => changeFilter(t.id)}
                className={`flex items-center gap-1.5 rounded-full px-[13px] py-1.5 text-[13px] font-semibold ${
                  active
                    ? "bg-app-accent text-on-accent"
                    : "bg-panel text-app-muted hover:bg-app-hover-strong"
                }`}
              >
                {t.label}
                {n != null && <span className="text-[11px] font-bold opacity-80">{n}</span>}
              </button>
            );
          })}
        </div>

        {/* results */}
        <div ref={scrollRef} className="app-scroll flex-1 overflow-y-auto px-1.5 pb-2 pt-1">
          {body}
        </div>

        {/* footer */}
        <div className="flex items-center gap-4 border-t border-app-border bg-panel-2 px-4 py-2.5 text-[12px] text-app-muted">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            Open
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>esc</Kbd>
            Close
          </span>
        </div>
      </div>
    </div>
  );
}
