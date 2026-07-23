"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import * as msgdb from "@/lib/message-db";
import { getShellBridge } from "@/lib/shell";
import { toast } from "sonner";
import {
  type Attachment,
  type Group,
  type GroupMap,
  type Message,
  type Pinned,
  type LinkPreview,
  type ReplyRef,
  type User,
  type UserProfile,
  gradientFor,
  messageExcerpt,
  nowTime,
} from "@/lib/chat-data";
import { useSocket } from "./socket-context";
import {
  consumeOneTimePreKey,
  cryptoAvailable,
  groupGet,
  groupPut,
  loadDeviceSecrets,
  pinGet,
  type DeviceSecrets,
} from "@/lib/crypto/identity";
import { checkAndPin, acknowledgePin, type Pin } from "@/lib/crypto/pinning";
import { decryptEnvelope, encryptForDevices, type Envelope } from "@/lib/crypto/session";
import {
  decryptGroupMessage,
  deserializeState,
  encryptGroupMessage,
  generateSenderKey,
  serializeState,
  type GroupEnvelope,
  type SenderKeyDistribution,
  type SenderKeyState,
  type SenderKeyWire,
} from "@/lib/crypto/group";
import type { MessageContent, PreKeyBundle } from "@/lib/crypto/types";
// MLS (Phase 4) types are type-only (erased at build) and the engine is loaded
// lazily (loadMls) so ts-mls stays out of the runtime bundle while MLS is off.
import type { ClientState as MlsClientState, KeyPackage as MlsKeyPackage } from "ts-mls";
import type { MlsKeyPair, StoredMlsKeyPair } from "@/lib/crypto/mls";
import type {
  MlsCommitAck,
  MlsFetchGroupResult,
  ReceiptRelayPayload,
} from "@/lib/socket-events";

// MLS (RFC 9420) is the LIVE group-encryption scheme: group sends go through
// MLS whenever a group's whole membership is MLS-capable (every member has
// published a KeyPackage), with an automatic per-group sender-keys fallback
// until then — see buildGroupEnc/ensureMlsGroup. Ordering comes from the
// server-side delivery service (server/mls-ds.ts); membership drift is synced
// on send (mlsSyncMembership). Typed `boolean` (not a literal) so the
// sender-keys branch stays reachable to the compiler — it's still the decrypt
// path for pre-cutover history and the fallback for not-yet-covered groups.
const MLS_ENABLED: boolean = true;
/** Lazy import so ts-mls is only fetched (as its own chunk) when MLS is used. */
const loadMls = () => import("@/lib/crypto/mls");

/** History page size (mirrors the old server page size). */
const PAGE_SIZE = 30;

/** How long to wait for a pulled sender key before showing 🔒 (unrecoverable). */
const KEY_WAIT_MS = 6000;

/** How long to wait for a DM reheal offer before showing 🔒 (peer/own device
 *  offline, or nobody holds the plaintext). */
const REHEAL_WAIT_MS = 8000;

// The nav panels route as top-level paths, e.g. /drafts. They replace the
// conversation view but don't carry a conversation id. `people` and `archived`
// are the Messenger rail destinations; the rest live in the Chats options menu.
const NAV_PANELS = [
  "mentions",
  "drafts",
  "people",
  "archived",
] as const;
function pathToPanel(pathname: string): NavPanel | null {
  const seg = pathname.replace(/^\/+|\/+$/g, "");
  return (NAV_PANELS as readonly string[]).includes(seg)
    ? (seg as NavPanel)
    : null;
}

// Top-level paths that belong to their own routes, never to a conversation.
// A conversation whose id equals one of these would be shadowed by that route.
const RESERVED_SEGMENTS = new Set<string>(["settings", ...NAV_PANELS]);

// --- sidebar roster cache --------------------------------------------------
// A compact, per-user snapshot of the conversation list (group meta + a
// one-line last-message preview) persisted to localStorage. Rendered instantly
// on reload so the sidebar is populated before the socket connects, instead of
// blank-then-populate. The server roster + local OPFS history reconcile it a
// moment later. Only a single already-rendered preview line per group is
// stored (no ciphertext, no bodies beyond the visible snippet).
const rosterCacheKey = (userId: string) => `chat:roster:${userId}`;

type PreviewCache = {
  id: string;
  self: boolean;
  authorName: string;
  time: string;
  ts: number;
  /** Already-resolved preview body (plain text, "🔒 Message", "📎 name", …). */
  body: string;
  deleted: boolean;
};
type GroupCache = Omit<Group, "messages" | "pinned"> & {
  last?: PreviewCache;
};
type RosterCache = {
  groups: GroupCache[];
  groupOrder: string[];
  dmOrder: string[];
};

function snapshotRoster(
  groups: GroupMap,
  groupOrder: string[],
  dmOrder: string[],
): RosterCache {
  const out: GroupCache[] = [];
  for (const id of [...groupOrder, ...dmOrder]) {
    const ch = groups[id];
    if (!ch) continue;
    const m = ch.messages[ch.messages.length - 1];
    let last: PreviewCache | undefined;
    if (m) {
      let body = m.text ?? "";
      if (!m.deleted) {
        if (!body && m.enc) body = "🔒 Message";
        else if (!body && m.attachment) body = "📎 " + m.attachment.name;
      }
      last = {
        id: m.id,
        self: !!m.self,
        authorName: m.author?.name ?? "",
        time: m.time ?? "",
        ts: m.ts ?? 0,
        body,
        deleted: !!m.deleted,
      };
    }
    const { messages: _msgs, pinned: _pins, ...meta } = ch;
    void _msgs;
    void _pins;
    out.push({ ...meta, last });
  }
  return { groups: out, groupOrder, dmOrder };
}

function restoreRoster(cache: RosterCache): {
  groups: GroupMap;
  groupOrder: string[];
  dmOrder: string[];
} {
  const groups: GroupMap = {};
  for (const c of cache.groups) {
    const { last, ...meta } = c;
    // Rebuild a minimal message just so previewOf/lastTs render the cached
    // snippet + recency. No `enc` — the decrypt effect must never touch these
    // placeholders (opening the conversation replaces them with real history).
    const messages: Message[] = last
      ? [
          {
            id: last.id,
            self: last.self,
            time: last.time,
            ts: last.ts,
            text: last.deleted ? "" : last.body,
            deleted: last.deleted || undefined,
            author: { name: last.authorName } as User,
            reactions: [],
          } as Message,
        ]
      : [];
    groups[meta.id] = { ...meta, messages, pinned: [] } as Group;
  }
  return {
    groups,
    groupOrder: cache.groupOrder,
    dmOrder: cache.dmOrder,
  };
}

// URL <-> conversation-id mapping. Every conversation — group or DM — lives at
// the root as /<id>; there is no /c or /dm prefix and the id carries no type
// marker (ch.type is the sole group/DM discriminator). The empty id (no
// selection) is the app root "/".
function idToPath(id: string): string {
  return id ? "/" + encodeURIComponent(id) : "/";
}
function pathToId(pathname: string): string {
  const seg = pathname.replace(/^\/+|\/+$/g, "");
  if (!seg || seg.includes("/") || RESERVED_SEGMENTS.has(seg)) return "";
  return decodeURIComponent(seg);
}

// The server holds only pinned message ids; resolve each to a display snippet
// from local IndexedDB (a pin whose message isn't stored locally is skipped).
async function resolvePins(pinIds: string[]): Promise<Pinned[]> {
  const out: Pinned[] = [];
  for (const id of pinIds) {
    const m = await msgdb.getMessage(id);
    if (m) out.push({ id, author: m.author, text: m.text });
  }
  return out;
}

type SettingsTab =
  | "general"
  | "profile"
  | "privacy"
  | "notifications"
  | "appearance";

/** Sidebar nav destinations that take over the main pane. */
export type NavPanel =
  | "mentions"
  | "drafts"
  | "people"
  | "archived";

/** Conversation-list filter chips (Messenger: Inbox / Unread / Groups). */
export type ChatFilter = "inbox" | "unread" | "groups";

/** An unsent composer draft, kept per group. */
export type Draft = { text: string; rich?: string };

type ChatContextValue = {
  groups: GroupMap;
  currentGroupId: string;
  selectGroup: (id: string) => void;

  threadFor: string | null;
  openThread: (msgId: string) => void;
  closeThread: () => void;

  /** Group-info right drawer (mutually exclusive with the thread panel). */
  groupInfoOpen: boolean;
  toggleGroupInfo: () => void;
  closeGroupInfo: () => void;

  /** Pagination cursor per group (seq to fetch older, or null when done). */
  historyCursor: Record<string, string | null>;
  loadOlder: (groupId: string) => void;
  /** Jump to a message (loads a window around it, scrolls + highlights). Pass
   *  parentId for a thread-reply target (opens the thread panel instead). */
  jumpToMessage: (
    groupId: string,
    msgId: string,
    parentId?: string | null,
  ) => void;
  highlightMsgId: string | null;
  clearHighlight: () => void;

  composerText: string;
  setComposerText: (v: string) => void;
  composerActive: boolean;
  setComposerActive: (v: boolean) => void;
  composerAttachment: Attachment | null;
  setComposerAttachment: (a: Attachment | null) => void;
  sendMessage: (text: string, rich?: string, preview?: LinkPreview) => void;
  retrySend: (groupId: string, msgId: string) => void;
  deleteMessage: (groupId: string, msgId: string) => void;

  /** Message-edit mode: the composer edits this message instead of sending. */
  editing: { groupId: string; msgId: string; parentId: string | null } | null;
  editingMessage: Message | null;
  startEdit: (groupId: string, msg: Message) => void;
  cancelEdit: () => void;
  submitEdit: (text: string, rich?: string) => void;

  /** Forward a message to one or more groups/DMs via a destination picker. */
  forwardSource: Message | null;
  openForward: (msg: Message) => void;
  closeForward: () => void;
  forwardMessage: (toGroupIds: string[]) => void;

  /** Quoted-reply compose mode (group composer only): the message being
   *  replied to, or null. Mutually exclusive with edit mode. */
  replyingTo: Message | null;
  startReply: (msg: Message) => void;
  cancelReply: () => void;

  threadComposerText: string;
  setThreadComposerText: (v: string) => void;
  sendThreadMessage: (text: string, rich?: string) => void;

  /** Per-message "seen by" users for the current group (E2EE read receipts). */
  seenByMsgId: Record<string, User[]>;

  hoverMsgId: string | null;
  setHoverMsgId: (id: string | null) => void;
  pickerOpenFor: string | null;
  togglePicker: (msgId: string) => void;
  /** Which message's "More" action menu is open (only one at a time). */
  moreOpenFor: string | null;
  toggleMore: (msgId: string) => void;
  closeMore: () => void;
  toggleReaction: (msgId: string, emoji: string) => void;

  /** Per-group dismissal of the pinned bar (id → hidden). */
  pinnedBarHidden: Record<string, boolean>;
  hidePinnedBar: (groupId: string) => void;
  /** Which group's pinned-list popover is open (header button). */
  pinnedPanelFor: string | null;
  togglePinnedPanel: (groupId: string) => void;
  togglePin: (groupId: string, msgId: string) => void;

  /** Mock viewer identity (handshake key, e.g. "alex"). */
  userId: string;
  /** The viewer's effective display identity (profile applied). */
  myUser: User;
  /** The viewer's editable profile fields. */
  profile: UserProfile;
  updateProfile: (patch: Partial<UserProfile>) => void;
  /** "Set a status" modal. */
  statusOpen: boolean;
  openStatus: () => void;
  closeStatus: () => void;
  /** userIds currently typing, keyed by group id. */
  typingByGroup: Record<string, string[]>;
  notifyTyping: (groupId: string) => void;

  /** Unread message counts per group id (server-tracked, live). */
  unreadByGroup: Record<string, number>;

  /** Authorized group ids (from the server roster). */
  groupOrder: string[];
  /** True once the server roster has been received at least once this session
   *  (distinguishes "still loading" from "genuinely no conversations"). */
  rosterLoaded: boolean;
  groupsOpen: boolean;
  toggleGroups: () => void;
  dmsOpen: boolean;
  toggleDms: () => void;

  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  settingsTab: SettingsTab;
  setSettingsTab: (t: SettingsTab) => void;
  /** Controlled open-state of the standalone "Set a backup PIN" modal, lifted
   *  here so the no-backup nudge banner / sign-out dialog can pop it over any
   *  view (it's mounted in the app shell, not inside Settings). */
  backupSetupOpen: boolean;
  setBackupSetupOpen: (open: boolean) => void;

  /** Peer devices whose identity key changed since we pinned it (TOFU alerts). */
  keyAlerts: Pin[];
  /** Accept a flagged key change and re-pin to the new key. */
  acknowledgeKeyAlert: (deviceId: string) => Promise<void>;

  dmOrder: string[];

  composeOpen: boolean;
  openCompose: () => void;
  closeCompose: () => void;
  composeQuery: string;
  setComposeQuery: (v: string) => void;
  composeText: string;
  setComposeText: (v: string) => void;
  composeRecipients: string[];
  addRecipient: (name: string) => void;
  removeRecipient: (name: string) => void;
  sendCompose: () => void;

  /** Create-group dialog + submit. */
  createGroupOpen: boolean;
  openCreateGroup: () => void;
  closeCreateGroup: () => void;
  createGroup: (
    name: string,
    topic: string,
    isPrivate: boolean,
    onError?: (msg: string) => void,
  ) => void;
  /** Group management (edit meta, delete, membership). */
  updateGroup: (
    groupId: string,
    patch: { name?: string; topic?: string },
    onError?: (msg: string) => void,
  ) => void;
  deleteGroup: (groupId: string, onError?: (msg: string) => void) => void;
  addGroupMember: (groupId: string, memberId: string) => void;
  removeGroupMember: (groupId: string, memberId: string) => void;

  /** Workspace identity + membership (shared, server-backed). */
  workspaceName: string;
  workspaceMembers: User[];
  workspaceOpen: boolean;
  openWorkspace: () => void;
  closeWorkspace: () => void;
  renameWorkspace: (name: string, onError?: (msg: string) => void) => void;
  inviteWorkspaceMember: (memberId: string) => void;
  removeWorkspaceMember: (memberId: string) => void;

  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  searchQ: string;
  setSearchQ: (v: string) => void;

  /** Which sidebar nav panel (Threads/Mentions/Drafts) owns the main pane. */
  activePanel: NavPanel | null;
  openPanel: (p: NavPanel) => void;
  closePanel: () => void;

  /** Conversation-list filter chip (Inbox / Unread / Groups). */
  chatFilter: ChatFilter;
  setChatFilter: (f: ChatFilter) => void;

  /** Messenger customization (persisted in the profile). */
  bubbleTheme: string;
  setBubbleTheme: (t: string) => void;
  likeEmoji: string;
  setLikeEmoji: (e: string) => void;

  /** Archived conversation ids (persisted in the profile). */
  archivedIds: string[];
  isArchived: (groupId: string) => boolean;
  toggleArchived: (groupId: string) => void;

  /** Unsent composer drafts keyed by group id, persisted per user. */
  drafts: Record<string, Draft>;
  saveDraft: (groupId: string, draft: Draft) => void;
  clearDraft: (groupId: string) => void;

  scrollRef: React.RefObject<HTMLDivElement | null>;
};

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [groups, setGroups] = useState<GroupMap>({});
  const [currentGroupId, setCurrentGroupId] = useState("");
  const [threadFor, setThreadFor] = useState<string | null>(null);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [composerText, setComposerTextState] = useState("");
  const [composerActive, setComposerActive] = useState(false);
  const [composerAttachment, setComposerAttachment] = useState<Attachment | null>(
    null,
  );
  const [threadComposerText, setThreadComposerTextState] = useState("");
  const [hoverMsgId, setHoverMsgId] = useState<string | null>(null);
  const [pickerOpenFor, setPickerOpenFor] = useState<string | null>(null);
  const [moreOpenFor, setMoreOpenFor] = useState<string | null>(null);
  const [pinnedBarHidden, setPinnedBarHidden] = useState<
    Record<string, boolean>
  >({});
  const [pinnedPanelFor, setPinnedPanelFor] = useState<string | null>(null);
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  // When a jump-to-message is loading a window around a target, the group-join
  // effect must NOT also load the latest page (it would clobber the window).
  // Holds the groupId being jumped into until the window is injected.
  const jumpPendingRef = useRef<string | null>(null);
  const [typingByGroup, setTypingByGroup] = useState<
    Record<string, string[]>
  >({});
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [backupSetupOpen, setBackupSetupOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeQuery, setComposeQuery] = useState("");
  const [composeText, setComposeText] = useState("");
  const [composeRecipients, setComposeRecipients] = useState<string[]>([]);
  const [dmOrder, setDmOrder] = useState<string[]>([]);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [historyCursor, setHistoryCursor] = useState<
    Record<string, string | null>
  >({});
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<NavPanel | null>(null);
  const [workspaceName, setWorkspaceName] = useState("Northwind Studio");
  const [workspaceMembers, setWorkspaceMembers] = useState<User[]>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [unreadByGroup, setUnreadByGroup] = useState<Record<string, number>>(
    {},
  );
  const [forwardSource, setForwardSource] = useState<Message | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  /** Message-edit mode: the composer edits this message instead of sending. */
  const [editing, setEditing] = useState<{
    groupId: string;
    msgId: string;
    parentId: string | null;
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const {
    socket,
    status,
    userId,
    user: sessionUser,
    deviceId: sessionDeviceId,
    backupNow,
    replenishKeys,
  } = useSocket();
  // Debounced re-backup after group key material changes (no-op unless a
  // session passphrase is held). Keeps the encrypted backup current so newly
  // joined groups' seeds stay recoverable.
  const backupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleBackup = useCallback(() => {
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    backupTimerRef.current = setTimeout(() => void backupNow(), 3000);
  }, [backupNow]);
  // Debounced one-time-prekey top-up after prekeys are consumed (for FS), so the
  // pool doesn't run dry past the initial batch. No-op unless below watermark.
  const replenishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReplenish = useCallback(() => {
    if (replenishTimerRef.current) clearTimeout(replenishTimerRef.current);
    replenishTimerRef.current = setTimeout(() => void replenishKeys(), 3000);
  }, [replenishKeys]);
  // The viewer's saved profile + the server-resolved display User it implies.
  // `myUser` prefers the profile identity so a renamed display name shows
  // everywhere the viewer's own identity is rendered.
  const [profile, setProfile] = useState<UserProfile>({});
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const myUser = profileUser ?? sessionUser;
  // `self` is viewer-relative, so it's computed on arrival from the wire
  // rather than trusted from the server.
  const withSelf = useCallback(
    (m: Message): Message => ({ ...m, self: m.author.name === myUser.name }),
    [myUser.name],
  );

  // Resolve pin ids → snippets from IndexedDB and merge into a group's state.
  const applyResolvedPins = useCallback(
    async (groupId: string, pinIds: string[]) => {
      const pinned = await resolvePins(pinIds);
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        return { ...s, [groupId]: { ...ch, pinIds, pinned } };
      });
    },
    [],
  );

  // Load a group's latest history page from IndexedDB into state, keeping any
  // un-acked optimistic tail. Also resolves the thread replies for each loaded
  // message and refreshes the pinned bar. The server never sends history.
  // Conversations whose full history page is loaded in state. Preview-seeding
  // (below) skips these so it never clobbers a fully-loaded/open conversation
  // with a single-message placeholder.
  const loadedFullRef = useRef<Set<string>>(new Set());
  const loadLocalHistory = useCallback(
    async (groupId: string) => {
      const { messages, nextCursor } = await msgdb.getTopPage(
        groupId,
        null,
        PAGE_SIZE,
      );
      loadedFullRef.current.add(groupId);
      const withReplies = await Promise.all(
        messages.map(async (m) =>
          m.threadCount
            ? { ...m, threadReplies: await msgdb.getReplies(m.id) }
            : m,
        ),
      );
      setGroups((s) => {
        const loaded = withReplies.map(withSelf);
        const loadedIds = new Set(loaded.map((m) => m.id));
        // If the group meta hasn't arrived from groups:list yet, seed a
        // placeholder — onGroupsList preserves existing messages when it
        // merges the real meta, so load order doesn't matter.
        // Provisional meta for a group whose real roster entry hasn't arrived
        // yet. Type isn't knowable from the id alone anymore, so assume "group";
        // onGroupsList overwrites it with the server's type (preserving these
        // messages) before any send/receipt path needs the DM/group distinction.
        const ch: Group = s[groupId] ?? {
          id: groupId,
          type: "group",
          name: "",
          pinned: [],
          messages: [],
        };
        // Keep trailing un-acked optimistic messages across the (re)load.
        const pendingTail = ch.messages.filter(
          (m) => (m.pending || m.failed) && !loadedIds.has(m.id),
        );
        return {
          ...s,
          [groupId]: { ...ch, messages: [...loaded, ...pendingTail] },
        };
      });
      setHistoryCursor((c) => ({ ...c, [groupId]: nextCursor }));
    },
    [withSelf],
  );

  // Seed/refresh each conversation's last-message preview from local history,
  // for the sidebar's preview + recency order. Applies only to conversations
  // not fully loaded, and only when the candidate is newer than what's shown —
  // so it upgrades a stale cached snippet without disturbing live/open state.
  const seedPreviews = useCallback(
    (entries: { groupId: string; message: Message }[]) => {
      if (!entries.length) return;
      setGroups((s) => {
        let changed = false;
        const next = { ...s };
        for (const { groupId, message } of entries) {
          const ch = next[groupId];
          if (!ch || loadedFullRef.current.has(groupId)) continue;
          const cur = ch.messages[ch.messages.length - 1];
          if (cur && cur.id >= message.id) continue;
          next[groupId] = { ...ch, messages: [withSelf(message)] };
          changed = true;
        }
        return changed ? next : s;
      });
    },
    [withSelf],
  );

  // Per-message fail timers: a send that isn't acked in time is marked failed.
  const failTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const SEND_TIMEOUT_MS = 10_000;

  // Keep a ref so socket listeners attached once can read the live group id.
  const currentGroupIdRef = useRef(currentGroupId);
  useEffect(() => {
    currentGroupIdRef.current = currentGroupId;
  }, [currentGroupId]);

  // Last top-level message per conversation, from local (OPFS) history. It's
  // prefetched here on mount — in parallel with the socket connect, and warming
  // the DB worker early — so the sidebar can show the right preview + recency
  // order the moment the roster arrives, instead of seconds later when the
  // worker would otherwise cold-start inside onGroupsList. The seed is applied
  // both here (if the roster is already present) and synchronously in
  // onGroupsList from this ref; opening a conversation replaces it in full.
  const latestByGroupRef = useRef<Map<string, Message>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void msgdb.getLatestPerGroup().then((list) => {
      if (cancelled) return;
      latestByGroupRef.current = new Map(
        list.map((x) => [x.groupId, x.message]),
      );
      seedPreviews(list);
    });
    return () => {
      cancelled = true;
    };
  }, [seedPreviews]);

  // Instant paint: hydrate the conversation list from the persisted local
  // snapshot on mount, before the socket connects — so the sidebar is never
  // blank on reload. Only fills empty state; the live roster then reconciles.
  const rosterHydratedRef = useRef(false);
  useEffect(() => {
    if (rosterHydratedRef.current || !userId) return;
    rosterHydratedRef.current = true;
    try {
      const raw = localStorage.getItem(rosterCacheKey(userId));
      if (!raw) return;
      const cache = JSON.parse(raw) as RosterCache;
      const restored = restoreRoster(cache);
      setGroups((s) => (Object.keys(s).length ? s : restored.groups));
      setGroupOrder((o) => (o.length ? o : restored.groupOrder));
      setDmOrder((o) => (o.length ? o : restored.dmOrder));
    } catch {}
  }, [userId]);

  // Persist the roster snapshot (debounced) whenever the list or its previews
  // change, so the next load can paint instantly from it.
  const rosterSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!userId || (!groupOrder.length && !dmOrder.length)) return;
    if (rosterSaveTimer.current) clearTimeout(rosterSaveTimer.current);
    rosterSaveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(
          rosterCacheKey(userId),
          JSON.stringify(snapshotRoster(groups, groupOrder, dmOrder)),
        );
      } catch {}
    }, 500);
  }, [groups, groupOrder, dmOrder, userId]);

  // The URL is the source of truth for the main view — a group/DM (/c, /dm)
  // or a nav panel (/threads, /mentions, /drafts). This syncs state
  // from the path on first load, deep links, and browser back/forward (Next
  // reflects history.pushState in usePathname). In-app navigation pushes the
  // URL via navigateTo / openPanel / closePanel, which re-triggers this.
  const pathname = usePathname();
  useEffect(() => {
    const isSettings = pathname.replace(/^\/+|\/+$/g, "") === "settings";
    const panel = pathToPanel(pathname);
    if (isSettings || panel) {
      // Settings and panel paths keep the underlying group selection so
      // closing them returns to it; only the overlay layer changes.
      setActivePanel(panel);
    } else {
      const id = pathToId(pathname);
      setCurrentGroupId((cur) => (cur === id ? cur : id));
      setActivePanel(null);
    }
    // The path owns the main view: dismiss state-only full-screen overlays so
    // back/forward reveals the routed view instead of a stale overlay.
    setThreadFor(null);
    setSearchOpen(false);
    setComposeOpen(false);
    setSettingsOpen(isSettings);
    setCreateGroupOpen(false);
    setWorkspaceOpen(false);
    // A quoted reply is scoped to the conversation it was started in — drop it
    // when the routed view changes so it can't carry into another group.
    setReplyingTo(null);
  }, [pathname]);

  // Select a group/DM by updating the URL (no remount — the socket and all
  // providers persist). The pathname effect above then sets currentGroupId.
  const navigateTo = useCallback((id: string) => {
    setCurrentGroupId(id);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", idToPath(id));
    }
  }, []);

  // Mirror groups into a ref so the reconnect-resend effect can read the
  // latest state without re-running on every message.
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Mark an optimistic message failed if it isn't acked within the timeout.
  // A late ack (e.g. a resend on reconnect) still reconciles it.
  const armFailTimer = useCallback((clientId: string) => {
    const existing = failTimers.current.get(clientId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      failTimers.current.delete(clientId);
      setGroups((s) => {
        for (const id of Object.keys(s)) {
          const idx = s[id].messages.findIndex((m) => m.id === clientId);
          if (idx >= 0) {
            const m = s[id].messages[idx];
            if (!m.pending) return s; // already resolved
            const msgs = [...s[id].messages];
            msgs[idx] = { ...m, pending: false, failed: true };
            return { ...s, [id]: { ...s[id], messages: msgs } };
          }
        }
        return s;
      });
    }, SEND_TIMEOUT_MS);
    failTimers.current.set(clientId, t);
  }, []);

  // Fail an optimistic message immediately with a reason (e.g. it could not be
  // end-to-end encrypted). Default-E2EE: we never fall back to plaintext, so a
  // send that can't be encrypted fails here (with retry) instead of leaking.
  const markFailed = useCallback((clientId: string, reason: string) => {
    const t = failTimers.current.get(clientId);
    if (t) {
      clearTimeout(t);
      failTimers.current.delete(clientId);
    }
    setGroups((s) => {
      for (const id of Object.keys(s)) {
        const idx = s[id].messages.findIndex((m) => m.id === clientId);
        if (idx >= 0) {
          const msgs = [...s[id].messages];
          msgs[idx] = { ...msgs[idx], pending: false, failed: true, failReason: reason };
          return { ...s, [id]: { ...s[id], messages: msgs } };
        }
      }
      return s;
    });
  }, []);

  // Patch a message in place in group state — top-level or (via parentId) a
  // thread reply. Shared by the edit flow's optimistic/echo/revert paths.
  const applyMessagePatch = useCallback(
    (
      groupId: string,
      msgId: string,
      parentId: string | null | undefined,
      patch: Partial<Message>,
    ) => {
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        const messages = ch.messages.map((m) => {
          if (!parentId && m.id === msgId) return { ...m, ...patch };
          if (parentId && m.id === parentId) {
            return {
              ...m,
              threadReplies: (m.threadReplies || []).map((r) =>
                r.id === msgId ? { ...r, ...patch } : r,
              ),
            };
          }
          return m;
        });
        return { ...s, [groupId]: { ...ch, messages } };
      });
    },
    [],
  );

  // --- E2EE for 1:1 DMs (Phase 1) + group groups (Phase 2) ---------------
  // This device's private keys, loaded once and cached. Provisioned on connect
  // by SocketProvider; null until then or when WebCrypto is unavailable.
  const secretsRef = useRef<DeviceSecrets | null>(null);
  // Received per-sender sender-key chains for group groups, keyed
  // `groupId|senderDeviceId`. Backed by IndexedDB (crypto/identity groupGet).
  const recvChainsRef = useRef<Map<string, SenderKeyState>>(new Map());
  // (groupId|senderDeviceId) we've already asked the sender to (re)distribute
  // its key for, so a flood of undecryptable messages triggers one request, not
  // one per message. Cleared once that sender's key successfully decrypts.
  const requestedKeysRef = useRef<Set<string>>(new Set());
  // When we first requested each (group|sender) key, so a request that goes
  // unanswered past KEY_WAIT_MS resolves to a 🔒 instead of a blank forever
  // (e.g. our OWN messages after a data wipe — the old sender key is gone).
  const requestedAtRef = useRef<Map<string, number>>(new Map());
  // Plaintext of our own outgoing encrypted messages, keyed by clientId, so we
  // render them without self-decrypting (and never see a ciphertext flash).
  const sentPlaintextRef = useRef<
    Map<
      string,
      {
        text: string;
        rich?: string;
        att?: { key: string; iv: string };
        preview?: LinkPreview;
        replyTo?: ReplyRef;
        forwarded?: boolean;
      }
    >
  >(new Map());
  // Our own in-flight edits, keyed by msgId: the echoed message:edited applies
  // the cached plaintext instead of round-tripping our own ciphertext, and
  // `prev` reverts an edit the server never acks (mirrors sentPlaintextRef +
  // armFailTimer for sends).
  const sentEditRef = useRef<
    Map<string, { patch: Partial<Message>; prev: Partial<Message> }>
  >(new Map());
  const editTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Bumped when a new sender-key chain is stored, to re-run the decryption
  // effect and retry group messages that arrived before their key.
  const [chainVersion, setChainVersion] = useState(0);
  // DM self-heal ("reheal"): (groupId|msgId) we've already asked to have
  // re-encrypted, so an undecryptable DM triggers one request (not one per
  // decrypt pass); `rehealAtRef` stamps when, so a request unanswered past
  // REHEAL_WAIT_MS resolves to 🔒 instead of pending forever. `rehealVersion`
  // re-runs the decrypt effect when a reheal offer swaps in a fresh envelope.
  const rehealRequestedRef = useRef<Set<string>>(new Set());
  const rehealAtRef = useRef<Map<string, number>>(new Map());
  const [rehealVersion, setRehealVersion] = useState(0);
  // E2EE read receipts: per-group read cursors, merged to the max readSeq per
  // user across their devices. In-memory only — the server replays sealed
  // cursors on every (re)join, so nothing needs local persistence.
  const [receiptsByGroup, setReceiptsByGroup] = useState<
    Record<string, Record<string, { readSeq: number; ts: number }>>
  >({});
  // Highest readSeq we've already sealed per group (skip redundant reseals).
  const lastSealedSeqRef = useRef<Map<string, number>>(new Map());
  // Debounce timers for sealing our own read cursor (one per group).
  const receiptTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Receipts whose sender key hasn't arrived yet — retried on chainVersion bumps
  // (a reconnect can replay a receipt before its sender-key distribution).
  const pendingReceiptsRef = useRef<ReceiptRelayPayload[]>([]);
  // The receipt callbacks are defined after decryptInbound (which they need),
  // but the socket effect above them wires their handlers — so route through
  // refs kept current each render (same pattern as submitRef/onRecovery*Ref).
  const processReceiptRef = useRef<(p: ReceiptRelayPayload) => Promise<boolean>>(
    async () => true,
  );
  const scheduleReceiptRef = useRef<(groupId: string) => void>(() => {});
  // TOFU: peer devices whose identity key changed since we pinned it, keyed by
  // deviceId. Surfaced as a "safety number changed" warning until acknowledged.
  const [keyAlerts, setKeyAlerts] = useState<Record<string, Pin>>({});
  const getSecrets = useCallback(async (): Promise<DeviceSecrets | null> => {
    if (secretsRef.current) return secretsRef.current;
    if (!cryptoAvailable()) return null;
    secretsRef.current = await loadDeviceSecrets(userId);
    return secretsRef.current;
  }, [userId]);

  // Fetch a user's published prekey bundles (one per device) from the server's
  // key directory. Resolves to [] for users who have published no keys.
  const fetchBundles = useCallback(
    (target: string): Promise<PreKeyBundle[]> =>
      new Promise((resolve) => {
        if (!socket) return resolve([]);
        socket
          .timeout(5000)
          .emit("keys:fetch", { userId: target }, (err, res) =>
            resolve(err || !res ? [] : res.bundles),
          );
      }),
    [socket],
  );

  // TOFU: observe peer device identity keys and, on a mismatch with what we
  // pinned, raise a key-change alert. Never blocks the operation — surfacing is
  // safer than blocking given a legit re-provision also trips it.
  const pinBundles = useCallback(
    async (
      bundles: { userId: string; deviceId: string; identityKey: string }[],
    ) => {
      for (const b of bundles) {
        if (b.userId === userId) continue; // don't pin our own devices
        const res = await checkAndPin(userId, {
          deviceId: b.deviceId,
          peerUserId: b.userId,
          identityKey: b.identityKey,
        });
        if (res === "mismatch") {
          const p = await pinGet<Pin>(userId, b.deviceId);
          if (p) setKeyAlerts((prev) => ({ ...prev, [b.deviceId]: p }));
        }
      }
    },
    [userId],
  );

  const acknowledgeKeyAlert = useCallback(
    async (deviceId: string) => {
      await acknowledgePin(userId, deviceId);
      setKeyAlerts((prev) => {
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    },
    [userId],
  );

  // Build the E2EE envelope (JSON) for a DM message, or null to send plaintext.
  // Encrypts to every device of BOTH the peer and ourselves (so our own devices
  // can read it on reload). `peerId` is the recipient's key — supplied by the
  // caller because the DM group *id* is the creator's view (the recipient's
  // key) and is NOT viewer-symmetric, so the recipient must derive the peer from
  // the viewer-corrected partner, not from the id. Falls back to null when the peer
  // has published no keys (e.g. an offline seeded user) so DMs keep working.
  const buildEnvelope = useCallback(
    async (
      peerId: string,
      content: MessageContent,
      // Receipts pass this so the sealed cursor stays repeatably decryptable
      // from the signed prekey (no one-time prekey to be consumed on replay).
      opts?: { skipOneTimePreKey?: boolean },
    ): Promise<string | null> => {
      const secrets = await getSecrets();
      if (!secrets || !peerId) return null;
      const [peer, mine] = await Promise.all([
        fetchBundles(peerId),
        fetchBundles(userId),
      ]);
      if (!peer.length) return null; // peer has no keys → plaintext fallback
      await pinBundles(peer); // TOFU: catch a swapped key before we seal to it
      const env = await encryptForDevices(content, [...peer, ...mine], secrets, opts);
      return env ? JSON.stringify(env) : null;
    },
    [getSecrets, fetchBundles, pinBundles, userId],
  );

  // Whether a conversation is a 1:1 DM (vs a group). The `type` field is the
  // sole discriminator now that ids no longer carry a "dm-" prefix — so this
  // reads the live roster. Every E2EE send/receipt path routes on it, and the
  // conversation is always in the roster by the time those run (it must be
  // selected/loaded first). Unknown id → treated as a group.
  const isDm = useCallback(
    (groupId: string): boolean =>
      groupsRef.current[groupId]?.type === "dm",
    [],
  );

  // The DM peer's uid for a group, from its viewer-corrected partner (works
  // for both participants, unlike the non-symmetric group id). The partner's
  // `id` is the key their E2EE bundles are published under — derive it from
  // there, never from the display name (real users are keyed by email). The id
  // itself is the creator-side peer key, so it's the correct fallback.
  const dmPeerId = useCallback((groupId: string): string => {
    return groupsRef.current[groupId]?.user?.id ?? groupId;
  }, []);

  // Fetch the prekey bundles of every device of every member of a group
  // (for sender-key distribution). [] when no members have published keys.
  const fetchGroupBundles = useCallback(
    (groupId: string): Promise<PreKeyBundle[]> =>
      new Promise((resolve) => {
        if (!socket) return resolve([]);
        socket
          .timeout(5000)
          .emit("keys:fetchGroup", { groupId }, (err, res) => {
            const bundles = err || !res ? [] : res.bundles;
            void pinBundles(bundles); // TOFU on every member device we may seal to
            resolve(bundles);
          });
      }),
    [socket, pinBundles],
  );

  // Distribute our stable sender-key SEED for a group to the given member
  // devices, wrapped in the Phase 1 pairwise envelope (so only those devices can
  // read it). Reused on first send, on membership change, and when a member
  // explicitly requests the key (pull-on-miss).
  const distributeSenderKey = useCallback(
    async (
      groupId: string,
      seed: SenderKeyWire,
      members: PreKeyBundle[],
      secrets: DeviceSecrets,
    ) => {
      const dist: SenderKeyDistribution = {
        skd: 1,
        groupId,
        sender: secrets.deviceId,
        ...seed,
      };
      const env = await encryptForDevices(
        { text: JSON.stringify(dist) },
        members,
        secrets,
      );
      if (env)
        socket?.emit("group:senderKey", {
          groupId,
          sender: secrets.deviceId,
          env: JSON.stringify(env),
        });
    },
    [socket],
  );

  // Ensure our sender key is distributed to the group's current member device
  // set. We keep ONE stable seed (index 0) per group and never rotate it
  // (chosen policy: reliable decryption for everyone over forward secrecy), and
  // re-distribute that same seed whenever the member-device set changes so a
  // newly-added device can read the whole stream. `send:` is the advancing send
  // pointer used to encrypt; `seed:` is the stable index-0 seed we hand out.
  const ensureSenderKeyDistributed = useCallback(
    async (groupId: string, members: PreKeyBundle[], secrets: DeviceSecrets) => {
      const devices = members.map((m) => m.deviceId).sort();
      let seed = await groupGet<SenderKeyWire>(userId, `seed:${groupId}`);
      const lastDist = await groupGet<string[]>(userId, `dist:${groupId}`);
      const sameSet =
        !!lastDist &&
        lastDist.length === devices.length &&
        lastDist.every((d, i) => d === devices[i]);
      if (seed && sameSet) return;
      if (!seed) {
        const fresh = generateSenderKey();
        seed = serializeState(fresh);
        await groupPut(userId, `seed:${groupId}`, seed); // stable index-0 seed to hand out
        await groupPut(userId, `send:${groupId}`, seed); // advancing send pointer starts at the seed
        // Also store ourselves as a recv chain so we can self-decrypt our OWN
        // group messages from ciphertext (on cache loss / after a key restore) —
        // not just from the live sentPlaintext cache.
        await groupPut(userId, `recv:${groupId}:${secrets.deviceId}`, seed);
        scheduleBackup(); // new key material → refresh the encrypted backup
      }
      await distributeSenderKey(groupId, seed, members, secrets);
      await groupPut(userId, `dist:${groupId}`, devices);
    },
    [distributeSenderKey, scheduleBackup, userId],
  );

  // --- MLS group encryption (Phase 4 — LIVE for group groups) -------------
  // In-memory per-group MLS ClientState (persisted to the groups store under
  // `mls:<groupId>`), plus this DEVICE's long-lived KeyPackage keypair
  // (persisted as `mlskp` so a Welcome sealed to it survives reconnects).
  const mlsStatesRef = useRef<Map<string, MlsClientState>>(new Map());
  const mlsKpRef = useRef<MlsKeyPair | null>(null);
  // Last commit `seq` we've applied per group (persisted as `mls2seq:<id>`), so
  // we apply the delivery service's ordered commits exactly once, in order.
  const mlsSeqRef = useRef<Map<string, number>>(new Map());
  // Per-group throttle for membership drift syncs (see mlsSyncMembership).
  const mlsSyncedAtRef = useRef<Map<string, number>>(new Map());
  // First time we saw an MLS message for a group we hold no group state for —
  // after a grace window those messages lock (they predate our membership).
  const mlsWaitRef = useRef<Map<string, number>>(new Map());
  // Session cache of successfully-decrypted MLS messages, by msgId. MLS decrypt
  // is SINGLE-SHOT (it advances the receiver ratchet — a re-decrypt throws
  // "gen in the past"), unlike the idempotent sender-keys/DM paths, so when
  // overlapping decrypt-effect runs process the same message the second one
  // must return the cached plaintext rather than a spurious 🔒.
  const mlsPlainRef = useRef<
    Map<string, Partial<Message> & { att?: { key: string; iv: string } }>
  >(new Map());

  // Per-group mutex serializing EVERY ClientState mutation (encrypt advances
  // the sender ratchet, decrypt the receiver chain, commits the epoch) — two
  // interleaved awaits advancing from the same state would fork the ratchet.
  // Only the OUTERMOST entry points take the lock (buildMlsEnc, the decrypt
  // branch, onMlsCommit/onMlsWelcome, the connect drain); inner helpers
  // (ensureMlsGroup, mlsApplyCommitsSince, mlsSyncMembership) must be called
  // with it already held.
  const mlsLocksRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const withMlsLock = useCallback(
    <T,>(groupId: string, fn: () => Promise<T>): Promise<T> => {
      const locks = mlsLocksRef.current;
      const prev = locks.get(groupId) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      locks.set(groupId, next.then(() => undefined, () => undefined));
      return next;
    },
    [],
  );

  // Storage keys are VERSIONED (`mls2:` / `mls2seq:`): v1 states from the
  // flagged-off era used bare-userId leaf identities and session-only
  // keypairs — unusable under the multi-device protocol — so they're simply
  // orphaned (same pattern as other storage migrations here).
  const mlsLoadState = useCallback(
    async (groupId: string): Promise<MlsClientState | null> => {
      const cached = mlsStatesRef.current.get(groupId);
      if (cached) return cached;
      const b64 = await groupGet<string>(userId, `mls2:${groupId}`);
      if (!b64) return null;
      const state = (await loadMls()).mlsDeserializeState(b64);
      mlsStatesRef.current.set(groupId, state);
      return state;
    },
    [userId],
  );

  const mlsSaveState = useCallback(
    async (groupId: string, state: MlsClientState) => {
      mlsStatesRef.current.set(groupId, state);
      await groupPut(userId, `mls2:${groupId}`, (await loadMls()).mlsSerializeState(state));
    },
    [userId],
  );

  // This device's KeyPackage keypair — loaded from the groups store, generated
  // (and persisted) once per device. Long-lived on purpose: a Welcome is sealed
  // to the published package, so the private half must survive reconnects for
  // offline adds to be joinable. Never leaves this device (excluded from
  // device-to-device recovery offers; see socket-context approveDevice).
  const mlsKeyPair = useCallback(async (): Promise<MlsKeyPair | null> => {
    if (mlsKpRef.current) return mlsKpRef.current;
    const mls = await loadMls();
    const stored = await groupGet<StoredMlsKeyPair>(userId, "mlskp");
    if (stored) {
      const kp = mls.mlsImportKeyPair(stored);
      if (kp) {
        mlsKpRef.current = kp;
        return kp;
      }
    }
    const secrets = await getSecrets();
    if (!secrets) return null; // device identity not provisioned yet
    const kp = await mls.mlsGenerateKeyPackage(userId, secrets.deviceId);
    mlsKpRef.current = kp;
    await groupPut(userId, "mlskp", mls.mlsExportKeyPair(kp));
    return kp;
  }, [userId, getSecrets]);

  const mlsFetchGroup = useCallback(
    (groupId: string): Promise<MlsFetchGroupResult> =>
      new Promise((resolve) => {
        if (!socket) return resolve({ packages: [], memberIds: [] });
        socket
          .timeout(5000)
          .emit("mls:fetchGroup", { groupId }, (err, res) =>
            resolve(err || !res ? { packages: [], memberIds: [] } : res),
          );
      }),
    [socket],
  );

  /** Submit one commit (+ welcomes) through the delivery service. */
  const mlsSubmitCommit = useCallback(
    (
      groupId: string,
      fromEpoch: number,
      commit: string,
      welcomes: { toUserId: string; toDeviceId: string; welcome: string }[],
    ): Promise<MlsCommitAck> =>
      new Promise((resolve) => {
        if (!socket) return resolve({ ok: false, reason: "error", currentEpoch: 0 });
        socket
          .timeout(8000)
          .emit("mls:commit", { groupId, fromEpoch, commit, welcomes }, (err, r) =>
            resolve(err || !r ? { ok: false, reason: "error", currentEpoch: 0 } : r),
          );
      }),
    [socket],
  );

  const mlsGetSeq = useCallback(
    async (groupId: string): Promise<number> => {
      const cached = mlsSeqRef.current.get(groupId);
      if (cached != null) return cached;
      const stored = (await groupGet<number>(userId, `mls2seq:${groupId}`)) ?? 0;
      mlsSeqRef.current.set(groupId, stored);
      return stored;
    },
    [userId],
  );
  const mlsSetSeq = useCallback(
    async (groupId: string, seq: number) => {
      mlsSeqRef.current.set(groupId, seq);
      await groupPut(userId, `mls2seq:${groupId}`, seq);
    },
    [userId],
  );

  // Apply the delivery service's ordered commits with seq > our last-applied one.
  // Processing a commit built for a different epoch throws — we stop there (a
  // later fetch/relay retries once the missing pieces arrive).
  const mlsApplyCommitsSince = useCallback(
    async (groupId: string) => {
      if (!socket) return;
      const state = await mlsLoadState(groupId);
      if (!state) return;
      const since = await mlsGetSeq(groupId);
      const res = await new Promise<{ seq: number; commit: string }[]>((resolve) => {
        socket
          .timeout(5000)
          .emit("mls:fetchCommits", { groupId, sinceSeq: since }, (err, r) =>
            resolve(err || !r ? [] : r.commits),
          );
      });
      const mls = await loadMls();
      let cur = state;
      for (const { seq, commit } of res) {
        try {
          cur = await mls.mlsProcessCommit(cur, commit);
        } catch {
          break; // wrong epoch for us yet — stop; we'll retry on the next signal
        }
        await mlsSaveState(groupId, cur);
        await mlsSetSeq(groupId, seq);
      }
    },
    [socket, mlsLoadState, mlsGetSeq, mlsSaveState, mlsSetSeq],
  );

  // Sync the group's leaves to the group's ACTUAL membership (call with the
  // group lock held, state already loaded). Diffs the ratchet-tree leaves
  // against the server-authoritative roster + published per-device packages:
  //   * a member device with no leaf → ADD (this is how post-establishment
  //     joiners — and a member's brand-new device — get in)
  //   * a leaf whose user left the group → REMOVE
  //   * a leaf whose device republished a DIFFERENT signature key (device
  //     reset its e2ee store) → REMOVE + re-ADD with the new package
  // All folded into ONE commit through the delivery service; on `conflict`
  // someone else committed first — catch up and re-diff (once). Throttled per
  // group so ordinary sends don't pay a fetch round-trip each time.
  const mlsSyncMembership = useCallback(
    async (groupId: string, state: MlsClientState): Promise<MlsClientState> => {
      const now = Date.now();
      const last = mlsSyncedAtRef.current.get(groupId) ?? 0;
      if (now - last < 30_000) return state;
      mlsSyncedAtRef.current.set(groupId, now);
      const secrets = await getSecrets();
      if (!secrets) return state;
      const { packages, memberIds } = await mlsFetchGroup(groupId);
      if (!memberIds.length) return state;
      const mls = await loadMls();
      const me = mls.mlsIdentity(userId, secrets.deviceId);
      const memberSet = new Set(memberIds);
      let cur = state;
      for (let attempt = 0; attempt < 2; attempt++) {
        const leaves = mls.mlsGroupMembers(cur);
        const leafByIdentity = new Map(leaves.map((l) => [l.identity, l]));
        const adds: MlsKeyPackage[] = [];
        const targets: { toUserId: string; toDeviceId: string }[] = [];
        const removes: number[] = [];
        for (const p of packages) {
          if (!memberSet.has(p.userId)) continue; // package of a non-member
          const identity = mls.mlsIdentity(p.userId, p.deviceId);
          if (identity === me) continue;
          const kp = mls.mlsDecodeKeyPackage(p.keyPackage);
          if (!kp) continue;
          const leaf = leafByIdentity.get(identity);
          if (!leaf) {
            adds.push(kp);
            targets.push({ toUserId: p.userId, toDeviceId: p.deviceId });
          } else if (leaf.sigKey !== mls.mlsKeyPackageSigKey(kp)) {
            removes.push(leaf.leafIndex);
            adds.push(kp);
            targets.push({ toUserId: p.userId, toDeviceId: p.deviceId });
          }
        }
        for (const l of leaves) {
          if (l.identity === me) continue;
          // Never self-evict on a roster hiccup; drop only leaves whose USER
          // is genuinely not a member anymore.
          if (l.userId !== userId && !memberSet.has(l.userId)) {
            removes.push(l.leafIndex);
          }
        }
        const res = await mls.mlsSyncCommit(cur, adds, removes);
        if (!res) return cur; // membership already in sync
        const ack = await mlsSubmitCommit(
          groupId,
          mls.mlsEpoch(cur),
          res.commit,
          res.welcome
            ? targets.map((t) => ({ ...t, welcome: res.welcome! }))
            : [],
        );
        if (ack.ok) {
          await mlsSaveState(groupId, res.state);
          await mlsSetSeq(groupId, ack.seq);
          return res.state;
        }
        if (ack.reason !== "conflict") return cur;
        // Someone else's commit won this epoch — apply it and re-diff.
        await mlsApplyCommitsSince(groupId);
        cur = (await mlsLoadState(groupId)) ?? cur;
      }
      return cur;
    },
    [
      getSecrets,
      mlsFetchGroup,
      userId,
      mlsSubmitCommit,
      mlsSaveState,
      mlsSetSeq,
      mlsApplyCommitsSince,
      mlsLoadState,
    ],
  );

  // Ensure we hold an MLS group for a group (call with the group lock
  // held): load it (then drift-sync membership), else ESTABLISH it — one
  // commit adding every member device, submitted through the delivery service
  // so exactly one member's establishment wins. On `conflict`/`no_group`
  // another member established first: we discard our local attempt and join
  // when their Welcome arrives (onMlsWelcome).
  //
  // Establishment requires EVERY co-member user to have at least one published
  // KeyPackage — otherwise we return null and the send falls back to
  // sender-keys (buildGroupEnc), so a group keeps working until all its
  // members have run MLS-capable clients once. Post-establishment stragglers
  // are handled by mlsSyncMembership instead.
  const ensureMlsGroup = useCallback(
    async (groupId: string): Promise<MlsClientState | null> => {
      const existing = await mlsLoadState(groupId);
      if (existing) return mlsSyncMembership(groupId, existing);
      if (!socket) return null;
      const kp = await mlsKeyPair();
      const secrets = await getSecrets();
      if (!kp || !secrets) return null;
      const mls = await loadMls();
      const { packages, memberIds } = await mlsFetchGroup(groupId);
      const me = mls.mlsIdentity(userId, secrets.deviceId);
      const targets = packages
        .map((p) => ({
          userId: p.userId,
          deviceId: p.deviceId,
          kp: mls.mlsDecodeKeyPackage(p.keyPackage),
        }))
        .filter(
          (m): m is { userId: string; deviceId: string; kp: MlsKeyPackage } =>
            !!m.kp && mls.mlsIdentity(m.userId, m.deviceId) !== me,
        );
      const coveredUsers = new Set(targets.map((t) => t.userId));
      const coMembers = memberIds.filter((id) => id !== userId);
      if (!coMembers.length || !coMembers.every((id) => coveredUsers.has(id))) {
        return null; // not everyone is MLS-capable yet → sender-keys fallback
      }
      const created = await mls.mlsCreateGroup(groupId, kp);
      const added = await mls.mlsAddMembers(created, targets.map((m) => m.kp));
      const ack = await mlsSubmitCommit(
        groupId,
        0,
        added.commit,
        targets.map((m) => ({
          toUserId: m.userId,
          toDeviceId: m.deviceId,
          welcome: added.welcome,
        })),
      );
      if (!ack.ok) {
        // Lost the establishment race (or transport error) — don't keep our fork;
        // we'll join via the winner's Welcome. Catch up any commits meanwhile.
        await mlsApplyCommitsSince(groupId);
        return null;
      }
      await mlsSaveState(groupId, added.state);
      await mlsSetSeq(groupId, ack.seq);
      return added.state;
    },
    [
      socket,
      mlsLoadState,
      mlsSyncMembership,
      mlsKeyPair,
      getSecrets,
      mlsFetchGroup,
      userId,
      mlsSubmitCommit,
      mlsSaveState,
      mlsSetSeq,
      mlsApplyCommitsSince,
    ],
  );

  // Build an MLS application message (tagged `t:"mls"` so decryptInbound routes
  // it to the MLS path). Null when no group exists and one can't be established
  // yet (the caller falls back to sender-keys). Lock-serialized: encryption
  // advances the sender ratchet, so two racing sends must not start from the
  // same state.
  const buildMlsEnc = useCallback(
    (groupId: string, content: MessageContent): Promise<string | null> => {
      if (isDm(groupId)) return Promise.resolve(null);
      return withMlsLock(groupId, async () => {
        const state = await ensureMlsGroup(groupId);
        if (!state) return null;
        const { state: next, wire } = await (await loadMls()).mlsEncrypt(state, content);
        await mlsSaveState(groupId, next);
        return JSON.stringify({ t: "mls", w: wire });
      });
    },
    [ensureMlsGroup, mlsSaveState, isDm, withMlsLock],
  );

  // Build a group group's envelope: MLS first (RFC 9420 — the live scheme),
  // falling back to sender-keys while a group's members aren't all
  // MLS-capable yet (see ensureMlsGroup's coverage rule). Old sender-keys
  // history keeps decrypting regardless — decryptInbound routes by envelope
  // tag, so the two schemes coexist per group during the transition.
  const buildGroupEnc = useCallback(
    async (groupId: string, content: MessageContent): Promise<string | null> => {
      if (isDm(groupId)) return null;
      if (MLS_ENABLED) {
        const mlsEnc = await buildMlsEnc(groupId, content);
        if (mlsEnc) return mlsEnc;
        // No MLS group possible yet → sender-keys below keeps the group E2EE.
      }
      const secrets = await getSecrets();
      if (!secrets || !socket) return null;
      const members = await fetchGroupBundles(groupId);
      const others = members.filter((b) => b.deviceId !== secrets.deviceId);
      if (!others.length) return null; // no real co-member devices → plaintext
      await ensureSenderKeyDistributed(groupId, members, secrets);
      const wire = await groupGet<SenderKeyWire>(userId, `send:${groupId}`);
      if (!wire) return null;
      const { env, next } = await encryptGroupMessage(
        deserializeState(wire),
        secrets.deviceId,
        content,
      );
      await groupPut(userId, `send:${groupId}`, serializeState(next));
      return JSON.stringify(env);
    },
    [getSecrets, socket, fetchGroupBundles, ensureSenderKeyDistributed, userId, buildMlsEnc, isDm],
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Apply server-authoritative message events into local state.
  useEffect(() => {
    if (!socket) return;

    // History is loaded from IndexedDB (see loadLocalHistory below), not the
    // server — the server stores no message bodies.

    // Sender reconcile: swap the optimistic temp (id === clientId) for the
    // canonical server message wherever it lives.
    const onAck = ({
      clientId,
      message,
    }: {
      clientId: string;
      message: Message;
    }) => {
      const timer = failTimers.current.get(clientId);
      if (timer) {
        clearTimeout(timer);
        failTimers.current.delete(clientId);
      }
      // For our own encrypted message the server echoes back only ciphertext;
      // restore the plaintext we cached at send so it renders without
      // self-decryption (and clear `enc` so the decrypt effect ignores it).
      const cached = sentPlaintextRef.current.get(clientId);
      sentPlaintextRef.current.delete(clientId);
      const resolved =
        cached && message.enc
          ? {
              ...message,
              text: cached.text,
              rich: cached.rich,
              preview: cached.preview,
              replyTo: cached.replyTo,
              forwarded: cached.forwarded,
              enc: undefined,
              // The acked attachment came back with key/iv stripped (they rode
              // in the envelope); restore them locally so our own image decrypts.
              ...(message.attachment && cached.att
                ? {
                    attachment: {
                      ...message.attachment,
                      key: cached.att.key,
                      iv: cached.att.iv,
                    },
                  }
                : {}),
            }
          : message;
      setGroups((s) => {
        for (const id of Object.keys(s)) {
          const idx = s[id].messages.findIndex((m) => m.id === clientId);
          if (idx >= 0) {
            const msgs = [...s[id].messages];
            msgs[idx] = withSelf(resolved);
            // Persist our own (now-acked) message — it carries the server seq.
            void msgdb.putMessage(id, resolved);
            scheduleBackup(); // new plaintext locally → capture it in the backup
            return { ...s, [id]: { ...s[id], messages: msgs } };
          }
        }
        return s;
      });
    };

    // Message from another socket: append, de-duping by id.
    const onNew = ({
      groupId,
      message,
    }: {
      groupId: string;
      message: Message;
    }) => {
      void msgdb.putMessage(groupId, message);
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch || ch.messages.some((m) => m.id === message.id)) return s;
        return {
          ...s,
          [groupId]: { ...ch, messages: [...ch.messages, withSelf(message)] },
        };
      });
      if (groupId === currentGroupIdRef.current) {
        requestAnimationFrame(scrollToBottom);
        // We're viewing this group — keep it read on the server + reseal our
        // E2EE read cursor so the sender sees the "seen" avatar advance.
        socket.emit("group:read", { groupId });
        scheduleReceiptRef.current(groupId);
      }
      // Native shell (Electron desktop or Capacitor mobile): OS notification
      // for messages arriving outside the focused group (Web Push doesn't
      // apply in a native shell — src/lib/push.ts reports unsupported there;
      // mobile uses local/native notifications). Copy mirrors public/sw.js and stays
      // generic: the payload may still be an undecrypted E2EE envelope here.
      const shell = getShellBridge();
      if (
        shell &&
        message.author.id !== userId &&
        (groupId !== currentGroupIdRef.current ||
          document.hidden ||
          !document.hasFocus())
      ) {
        const ch = groupsRef.current[groupId];
        const isDm = ch?.type === "dm";
        shell.notify({
          title: isDm
            ? `New message from ${message.author.name}`
            : `New message in #${ch?.name ?? "a group"}`,
          body: isDm ? "Tap to read" : `${message.author.name} sent a message`,
          // Native bridge (desktop/src/preload.ts) reads n.channelId; keep the key.
          channelId: groupId,
        });
      }
    };

    // Thread reply from anyone (incl. self): append to the parent, de-dupe.
    const onThreadNew = ({
      groupId,
      parentId,
      reply,
      threadCount,
      threadLastTime,
    }: {
      groupId: string;
      parentId: string;
      reply: Message;
      threadCount: number;
      threadLastTime: string;
    }) => {
      void msgdb.putReply(groupId, parentId, reply);
      void msgdb.patchMessage(parentId, { threadCount, threadLastTime });
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        const msgs = ch.messages.map((m) => {
          if (m.id !== parentId) return m;
          const existing = m.threadReplies || [];
          if (existing.some((r) => r.id === reply.id)) return m;
          return {
            ...m,
            threadReplies: [...existing, withSelf(reply)],
            threadCount,
            threadLastTime,
          };
        });
        return { ...s, [groupId]: { ...ch, messages: msgs } };
      });
    };

    // Server broadcasts aggregated reactions (with reactor ids); derive our
    // own viewer-relative `mine`.
    const onReaction = ({
      groupId,
      msgId,
      reactions,
    }: {
      groupId: string;
      msgId: string;
      reactions: { e: string; n: number; by: string[] }[];
    }) => {
      const mine = reactions.map((r) => ({
        e: r.e,
        n: r.n,
        mine: r.by.includes(userId),
      }));
      void msgdb.patchMessage(msgId, { reactions: mine });
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        return {
          ...s,
          [groupId]: {
            ...ch,
            messages: ch.messages.map((m) =>
              m.id === msgId ? { ...m, reactions: mine } : m,
            ),
          },
        };
      });
    };

    // Authorized roster from the server — drives the sidebar lists.
    const onGroupsList = ({ groups: roster }: { groups: Group[] }) => {
      setGroups((s) => {
        const next = { ...s };
        for (const c of roster) {
          // Apply server meta (incl. viewer-correct DM partner) but keep any
          // messages already loaded for this group. When none are loaded, seed
          // the last message from the prefetched local map so the row shows its
          // correct preview + recency order on this very first render (not after
          // the async query below resolves).
          const loaded = next[c.id]?.messages;
          const seed = latestByGroupRef.current.get(c.id);
          next[c.id] = {
            ...c,
            messages:
              loaded?.length ? loaded : seed ? [withSelf(seed)] : loaded ?? [],
          };
        }
        return next;
      });
      setGroupOrder(roster.filter((c) => c.type === "group").map((c) => c.id));
      setDmOrder(roster.filter((c) => c.type === "dm").map((c) => c.id));
      setRosterLoaded(true);
      // Resolve pin snippets from local IndexedDB for each group.
      for (const c of roster) {
        if (c.pinIds?.length) void applyResolvedPins(c.id, c.pinIds);
      }
      // Fallback/refresh: re-read local history and upgrade any conversation
      // whose preview is missing or stale (e.g. socket beat the cold DB worker,
      // or the persisted snapshot lagged). Opening a conversation later replaces
      // the seed with its full page; live arrivals keep it current via onNew.
      void msgdb.getLatestPerGroup().then((latest) => {
        latestByGroupRef.current = new Map(
          latest.map((x) => [x.groupId, x.message]),
        );
        seedPreviews(latest);
      });
    };

    // Durable history replayed by the server on group join. Backfill ONLY
    // messages we don't already have locally — never overwrite a message we
    // already hold (our own outgoing messages are stored decrypted; the server
    // copy is ciphertext we couldn't self-decrypt). Exception: converge
    // deletes/edits that happened while we were offline — a server tombstone,
    // or an edit with a newer editedTs, replaces the stale local body (setting
    // `enc` so the decrypt effect derives the new plaintext).
    const mergeStale = async (local: Message, incoming: Message) => {
      if (incoming.deleted && !local.deleted) {
        await msgdb.patchMessage(incoming.id, {
          text: "",
          rich: undefined,
          attachment: undefined,
          reactions: [],
          deleted: true,
        });
        return true;
      }
      if (
        incoming.enc &&
        incoming.edited &&
        (incoming.editedTs ?? 0) > (local.editedTs ?? 0)
      ) {
        await msgdb.patchMessage(incoming.id, {
          enc: incoming.enc,
          edited: true,
          editedTs: incoming.editedTs,
          text: "",
          rich: undefined,
          preview: undefined,
          locked: undefined,
        });
        return true;
      }
      return false;
    };
    const onHistoryReplay = async ({
      groupId,
      messages,
      replies,
    }: {
      groupId: string;
      messages: Message[];
      replies: { parentId: string; reply: Message }[];
    }) => {
      let added = false;
      for (const m of messages) {
        const local = await msgdb.getMessage(m.id);
        if (!local) {
          await msgdb.putMessage(groupId, m);
          added = true;
        } else if (await mergeStale(local, m)) {
          added = true;
        }
      }
      for (const { parentId, reply } of replies) {
        const local = await msgdb.getMessage(reply.id);
        if (!local) {
          await msgdb.putReply(groupId, parentId, reply);
          added = true;
        } else if (await mergeStale(local, reply)) {
          added = true;
        }
      }
      if (added && groupId === currentGroupIdRef.current) {
        void loadLocalHistory(groupId);
      }
    };

    // A group or DM someone created — surface it in the right sidebar list.
    const onGroupCreated = ({ group }: { group: Group }) => {
      setGroups((s) =>
        s[group.id]
          ? s
          : {
              ...s,
              [group.id]: { ...group, messages: group.messages.map(withSelf) },
            },
      );
      const setOrder = group.type === "dm" ? setDmOrder : setGroupOrder;
      setOrder((order) =>
        order.includes(group.id) ? order : [...order, group.id],
      );
      if (group.pinIds?.length) void applyResolvedPins(group.id, group.pinIds);
    };

    // A group's meta/roster changed — merge it in, keeping loaded messages.
    const onGroupUpdated = ({ group }: { group: Group }) => {
      setGroups((s) => {
        const existing = s[group.id];
        if (!existing) return s;
        return {
          ...s,
          [group.id]: { ...existing, ...group, messages: existing.messages },
        };
      });
    };

    // A group was deleted — drop it everywhere; navigate off it if current.
    const onGroupDeleted = ({ groupId }: { groupId: string }) => {
      void msgdb.removeGroup(groupId);
      setGroups((s) => {
        if (!s[groupId]) return s;
        const { [groupId]: _gone, ...rest } = s;
        void _gone;
        return rest;
      });
      setGroupOrder((o) => o.filter((id) => id !== groupId));
      setDmOrder((o) => o.filter((id) => id !== groupId));
      if (currentGroupIdRef.current === groupId) {
        const next = Object.keys(groupsRef.current).find(
          (id) => id !== groupId && groupsRef.current[id].type === "group",
        );
        setCurrentGroupId(next ?? "");
        if (typeof window !== "undefined") {
          window.history.pushState(null, "", idToPath(next ?? ""));
        }
        setThreadFor(null);
        setGroupInfoOpen(false);
      }
    };

    // Presence: reflect a user's online state on every DM group with them.
    const onPresence = ({
      userId: uid,
      status: presence,
    }: {
      userId: string;
      status: "active" | "idle" | "offline";
    }) => {
      setGroups((s) => {
        let changed = false;
        const next: GroupMap = { ...s };
        for (const id of Object.keys(next)) {
          const ch = next[id];
          if (ch.type === "dm" && ch.user?.id === uid) {
            next[id] = { ...ch, presence };
            changed = true;
          }
        }
        return changed ? next : s;
      });
    };

    // Typing: maintain the set of userIds typing per group.
    const onTyping = ({
      groupId,
      userId: uid,
      isTyping,
    }: {
      groupId: string;
      userId: string;
      isTyping: boolean;
    }) => {
      setTypingByGroup((s) => {
        const cur = s[groupId] || [];
        const next = isTyping
          ? cur.includes(uid)
            ? cur
            : [...cur, uid]
          : cur.filter((u) => u !== uid);
        return { ...s, [groupId]: next };
      });
    };

    socket.on("groups:list", onGroupsList);
    socket.on("history:replay", onHistoryReplay);
    socket.on("message:ack", onAck);
    socket.on("message:new", onNew);
    socket.on("thread:new", onThreadNew);
    socket.on("reaction:updated", onReaction);
    const onWorkspace = ({ name, members }: { name: string; members: User[] }) => {
      setWorkspaceName(name);
      setWorkspaceMembers(members);
    };

    const onProfile = ({
      profile,
      user,
    }: {
      profile: UserProfile;
      user: User;
    }) => {
      setProfile(profile);
      setProfileUser(user);
    };

    const onMessageDeleted = ({
      groupId,
      msgId,
      parentId,
    }: {
      groupId: string;
      msgId: string;
      parentId: string | null;
    }) => {
      // Soft delete: turn the message into a tombstone in place (keep its slot
      // and any thread it anchors), rather than removing it.
      const tombstone = (m: Message): Message => ({
        ...m,
        text: "",
        rich: undefined,
        attachment: undefined,
        reactions: [],
        deleted: true,
      });
      void msgdb.patchMessage(msgId, {
        text: "",
        rich: undefined,
        attachment: undefined,
        reactions: [],
        deleted: true,
      });
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        const messages = ch.messages.map((m) => {
          if (!parentId && m.id === msgId) return tombstone(m);
          if (parentId && m.id === parentId) {
            return {
              ...m,
              threadReplies: (m.threadReplies || []).map((r) =>
                r.id === msgId ? tombstone(r) : r,
              ),
            };
          }
          return m;
        });
        return { ...s, [groupId]: { ...ch, messages } };
      });
    };

    // An edit arrived (possibly our own echo). Ours: apply the cached
    // plaintext — no ciphertext flash. Others': swap in the new envelope;
    // setting `enc` re-triggers the decrypt effect, which decrypts the new
    // body and re-persists the plaintext locally.
    const onMessageEdited = ({
      groupId,
      msgId,
      parentId,
      enc,
      editedTs,
    }: {
      groupId: string;
      msgId: string;
      parentId: string | null;
      enc: string;
      editedTs: number;
    }) => {
      const own = sentEditRef.current.get(msgId);
      if (own) {
        sentEditRef.current.delete(msgId);
        const t = editTimersRef.current.get(msgId);
        if (t) {
          clearTimeout(t);
          editTimersRef.current.delete(msgId);
        }
        const patch: Partial<Message> = { edited: true, editedTs };
        void msgdb.patchMessage(msgId, patch);
        applyMessagePatch(groupId, msgId, parentId, patch);
        return;
      }
      const patch: Partial<Message> = {
        enc,
        edited: true,
        editedTs,
        text: "",
        rich: undefined,
        preview: undefined,
        locked: undefined,
      };
      void msgdb.patchMessage(msgId, patch);
      applyMessagePatch(groupId, msgId, parentId, patch);
    };

    const onUnreadState = ({ counts }: { counts: Record<string, number> }) =>
      setUnreadByGroup(counts);
    const onUnreadBump = ({ groupId }: { groupId: string }) => {
      // Ignore the group we're actively viewing (it stays read).
      if (groupId === currentGroupIdRef.current) return;
      setUnreadByGroup((s) => ({ ...s, [groupId]: (s[groupId] ?? 0) + 1 }));
    };

    socket.on("group:created", onGroupCreated);
    socket.on("group:updated", onGroupUpdated);
    socket.on("group:deleted", onGroupDeleted);
    socket.on("workspace:updated", onWorkspace);
    socket.on("profile:updated", onProfile);
    socket.on("unread:state", onUnreadState);
    socket.on("unread:bump", onUnreadBump);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("message:edited", onMessageEdited);
    const onPins = async ({
      groupId,
      pinIds,
    }: {
      groupId: string;
      pinIds: string[];
    }) => {
      const pinned = await resolvePins(pinIds);
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        return { ...s, [groupId]: { ...ch, pinIds, pinned } };
      });
    };

    // A peer distributed its group sender key to us: decrypt the pairwise
    // envelope, store the chain for that (group, sender), and bump
    // chainVersion so the decrypt effect retries any messages awaiting it.
    const onGroupSenderKey = async ({
      groupId,
      env,
    }: {
      groupId: string;
      env: string;
    }) => {
      const secrets = await getSecrets();
      if (!secrets) return;
      try {
        const res = await decryptEnvelope(JSON.parse(env) as Envelope, secrets);
        if (!res) return;
        const dist = JSON.parse(res.text) as SenderKeyDistribution;
        if (dist.skd !== 1 || dist.groupId !== groupId) return;
        recvChainsRef.current.set(
          `${groupId}|${dist.sender}`,
          deserializeState({ chainKey: dist.chainKey, index: dist.index }),
        );
        await groupPut(userId, `recv:${groupId}:${dist.sender}`, {
          chainKey: dist.chainKey,
          index: dist.index,
        });
        // We now hold a working key for this sender — allow future re-requests
        // and reset its wait clock.
        requestedKeysRef.current.delete(`${groupId}|${dist.sender}`);
        requestedAtRef.current.delete(`${groupId}|${dist.sender}`);
        // Forward secrecy: consume the one-time prekey this envelope used (we've
        // persisted the recv chain, so we never need to re-decrypt the envelope).
        if (res.usedOpkId) {
          await consumeOneTimePreKey(userId, res.usedOpkId);
          scheduleReplenish();
        }
        scheduleBackup(); // received key material → refresh the encrypted backup
        setChainVersion((v) => v + 1);
      } catch {
        // malformed/foreign distribution — ignore
      }
    };

    // A member couldn't decrypt one of OUR messages and asked us to re-send our
    // sender key. If we're the requested sender and hold a seed for the group,
    // re-distribute it to the current member set (reaching the requester).
    const onGroupSenderKeyRequest = async ({
      groupId,
      sender,
    }: {
      groupId: string;
      sender: string;
      fromUserId?: string;
    }) => {
      const secrets = await getSecrets();
      if (!secrets || secrets.deviceId !== sender) return;
      const seed = await groupGet<SenderKeyWire>(userId, `seed:${groupId}`);
      if (!seed) return;
      const members = await fetchGroupBundles(groupId);
      if (members.length) await distributeSenderKey(groupId, seed, members, secrets);
    };

    // DM self-heal responder: a peer (or our own other device) can't decrypt a
    // DM message. If we hold its plaintext AND the requester is a genuine party
    // to the DM the message lives in (our view), re-encrypt it to the
    // requester's CURRENT devices. The participant check is what stops a DM
    // being leaked to a third party that guessed a msgId.
    const onDmRehealRequest = async ({
      groupId: reqGroupId,
      msgId,
      fromUserId,
    }: {
      groupId: string;
      msgId: string;
      fromUserId: string;
    }) => {
      const meta = await msgdb.getMessageMeta(msgId);
      if (!meta || !isDm(meta.groupId)) return;
      const { message, groupId } = meta;
      // Only hand over a readable body (skip tombstones / still-encrypted here).
      if (message.deleted || message.enc || message.locked) return;
      if (!message.text && !message.attachment) return;
      const peer = groupsRef.current[groupId]?.user?.id ?? dmPeerId(groupId);
      if (fromUserId !== userId && fromUserId !== peer) return; // not a DM party
      const secrets = await getSecrets();
      if (!secrets) return;
      const bundles = await fetchBundles(fromUserId);
      if (!bundles.length) return;
      const att =
        message.attachment?.encrypted &&
        message.attachment.key &&
        message.attachment.iv
          ? { key: message.attachment.key, iv: message.attachment.iv }
          : undefined;
      const env = await encryptForDevices(
        {
          text: message.text,
          rich: message.rich,
          att,
          preview: message.preview,
          replyTo: message.replyTo,
          forwarded: message.forwarded,
        },
        bundles,
        secrets,
      );
      if (!env) return;
      socket.emit("dm:reheal:offer", {
        groupId: reqGroupId,
        msgId,
        toUserId: fromUserId,
        enc: JSON.stringify(env),
      });
    };

    // DM self-heal requester side: an envelope re-sealed to us arrived — swap it
    // in and re-run decryption (it now opens with a key we hold).
    const onDmRehealOffer = ({
      groupId,
      msgId,
      enc,
    }: {
      groupId: string;
      msgId: string;
      enc: string;
    }) => {
      void msgdb.patchMessage(msgId, { enc, locked: undefined });
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        let found = false;
        const messages = ch.messages.map((m) => {
          if (m.id !== msgId) return m;
          found = true;
          return { ...m, enc, locked: undefined };
        });
        return found ? { ...s, [groupId]: { ...ch, messages } } : s;
      });
      setRehealVersion((v) => v + 1);
    };

    // MLS (Phase 4): apply a relayed Commit (membership change) to our state, or
    // join a group from a Welcome. No-ops until we hold / can join the group.
    // Apply an accepted commit in seq order. In-order → apply directly; a gap
    // (we missed one) → fetch and apply the ordered range; already-applied →
    // ignore. This is what keeps every member's ratchet tree in lockstep.
    const onMlsCommit = ({
      groupId,
      seq,
      commit,
    }: {
      groupId: string;
      seq: number;
      commit: string;
    }) =>
      withMlsLock(groupId, async () => {
        const state = await mlsLoadState(groupId);
        if (!state) return;
        const last = await mlsGetSeq(groupId);
        if (seq <= last) return; // already applied
        if (seq === last + 1) {
          try {
            await mlsSaveState(groupId, await (await loadMls()).mlsProcessCommit(state, commit));
            await mlsSetSeq(groupId, seq);
          } catch {
            return; // not our epoch yet — a catch-up will retry
          }
        } else {
          await mlsApplyCommitsSince(groupId); // gap → fetch + apply in order
        }
        setChainVersion((v) => v + 1);
      });
    const onMlsWelcome = async ({
      groupId,
      welcome,
      seq,
      toDeviceId,
    }: {
      groupId: string;
      welcome: string;
      seq: number;
      toDeviceId: string;
    }) => {
      // Welcomes are sealed per DEVICE — this one is a sibling device's.
      const secrets = await getSecrets();
      if (!secrets || (toDeviceId && toDeviceId !== secrets.deviceId)) return;
      await withMlsLock(groupId, async () => {
        if (await mlsLoadState(groupId)) return; // already a member
        const kp = await mlsKeyPair();
        if (!kp) return; // no device KeyPackage → can't join
        try {
          await mlsSaveState(groupId, await (await loadMls()).mlsJoinFromWelcome(welcome, kp));
          await mlsSetSeq(groupId, seq); // resume catch-up after the commit that added us
          mlsWaitRef.current.delete(groupId);
          setChainVersion((v) => v + 1);
          await mlsApplyCommitsSince(groupId); // apply any commits after our add
        } catch (err) {
          // Welcome for a stale KeyPackage of this device / malformed. Surfaced
          // in the console because an unjoinable welcome means this group
          // stays locked until a membership sync re-adds us.
          console.warn("[mls] welcome join failed", groupId, err);
        }
      });
    };

    // A peer's sealed read cursor: decrypt + merge (retry via chainVersion if
    // its sender key hasn't landed). We ignore our own device's receipts here.
    const onReceipt = (p: ReceiptRelayPayload) => {
      if (p.fromUserId === userId) return;
      void processReceiptRef.current(p).then((handled) => {
        if (!handled) {
          pendingReceiptsRef.current = pendingReceiptsRef.current.filter(
            (q) => !(q.groupId === p.groupId && q.deviceId === p.deviceId),
          );
          pendingReceiptsRef.current.push(p);
        }
      });
    };

    socket.on("presence:update", onPresence);
    socket.on("typing:update", onTyping);
    socket.on("pins:updated", onPins);
    socket.on("receipt:update", onReceipt);
    socket.on("group:senderKey", onGroupSenderKey);
    socket.on("group:senderKey:request", onGroupSenderKeyRequest);
    socket.on("mls:commit", onMlsCommit);
    socket.on("mls:welcome", onMlsWelcome);
    socket.on("dm:reheal:request", onDmRehealRequest);
    socket.on("dm:reheal:offer", onDmRehealOffer);
    return () => {
      socket.off("groups:list", onGroupsList);
      socket.off("history:replay", onHistoryReplay);
      socket.off("message:ack", onAck);
      socket.off("message:new", onNew);
      socket.off("thread:new", onThreadNew);
      socket.off("reaction:updated", onReaction);
      socket.off("group:created", onGroupCreated);
      socket.off("group:updated", onGroupUpdated);
      socket.off("group:deleted", onGroupDeleted);
      socket.off("workspace:updated", onWorkspace);
      socket.off("profile:updated", onProfile);
      socket.off("unread:state", onUnreadState);
      socket.off("unread:bump", onUnreadBump);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("message:edited", onMessageEdited);
      socket.off("presence:update", onPresence);
      socket.off("typing:update", onTyping);
      socket.off("pins:updated", onPins);
      socket.off("receipt:update", onReceipt);
      socket.off("group:senderKey", onGroupSenderKey);
      socket.off("group:senderKey:request", onGroupSenderKeyRequest);
      socket.off("mls:commit", onMlsCommit);
      socket.off("mls:welcome", onMlsWelcome);
      socket.off("dm:reheal:request", onDmRehealRequest);
      socket.off("dm:reheal:offer", onDmRehealOffer);
    };
  }, [
    socket,
    scrollToBottom,
    withSelf,
    userId,
    getSecrets,
    applyMessagePatch,
    applyResolvedPins,
    fetchBundles,
    dmPeerId,
    fetchGroupBundles,
    distributeSenderKey,
    loadLocalHistory,
    scheduleBackup,
    scheduleReplenish,
    mlsLoadState,
    mlsSaveState,
    mlsGetSeq,
    mlsSetSeq,
    mlsApplyCommitsSince,
    mlsKeyPair,
    withMlsLock,
    isDm,
    seedPreviews,
  ]);

  // On connect, publish this DEVICE's MLS KeyPackage (so others can add us)
  // and drain the Welcomes queued for this device while it was offline
  // (joining each group + catching up its commits).
  useEffect(() => {
    // sessionDeviceId turning non-null is the "identity provisioned" signal —
    // the effect re-runs then, so the publish never races provisioning.
    if (!MLS_ENABLED || !socket || !sessionDeviceId) return;
    const s = socket;
    let cancelled = false;
    void (async () => {
      const kp = await mlsKeyPair();
      if (cancelled || !kp) return;
      const mls = await loadMls();
      s.emit("mls:publishKeyPackage", {
        deviceId: sessionDeviceId,
        keyPackage: mls.mlsEncodeKeyPackage(kp.publicPackage),
      });
      const { welcomes } = await new Promise<{
        welcomes: { groupId: string; welcome: string; seq: number }[];
      }>((resolve) => {
        s.timeout(5000).emit("mls:drainWelcomes", { deviceId: sessionDeviceId }, (err, r) =>
          resolve(err || !r ? { welcomes: [] } : r),
        );
      });
      for (const w of welcomes) {
        if (cancelled) return;
        await withMlsLock(w.groupId, async () => {
          if (await mlsLoadState(w.groupId)) return; // already joined
          try {
            await mlsSaveState(w.groupId, await mls.mlsJoinFromWelcome(w.welcome, kp));
            await mlsSetSeq(w.groupId, w.seq);
            mlsWaitRef.current.delete(w.groupId);
            await mlsApplyCommitsSince(w.groupId);
          } catch {
            // welcome for a stale KeyPackage of this device — skip
          }
        });
      }
      if (welcomes.length) setChainVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [socket, sessionDeviceId, mlsKeyPair, mlsLoadState, mlsSaveState, mlsSetSeq, mlsApplyCommitsSince, withMlsLock]);

  // Join the active group's room (and re-join on reconnect); leave on switch.
  // Opening a group marks it read: clear its badge locally + tell the server.
  useEffect(() => {
    if (!socket || status !== "connected") return;
    const groupId = currentGroupId;
    if (!groupId) return;
    socket.emit("group:join", { groupId });
    socket.emit("group:read", { groupId });
    scheduleReceiptRef.current(groupId);
    setUnreadByGroup((s) => (s[groupId] ? { ...s, [groupId]: 0 } : s));
    // History lives locally (OPFS SQLite), not on the server — load it. Skip the
    // default latest-page load when a jump-to-message is loading a window around
    // a specific target for this group (jumpToMessage owns the load instead).
    if (jumpPendingRef.current !== groupId) {
      void loadLocalHistory(groupId).then(() =>
        requestAnimationFrame(scrollToBottom),
      );
    }
    return () => {
      socket.emit("group:leave", { groupId });
    };
  }, [socket, status, currentGroupId, loadLocalHistory, scrollToBottom]);

  // On (re)connect, resend any optimistic messages that were never acked.
  // Server idempotency (by clientId) makes this safe from duplicates, so this
  // is the reliable delivery path rather than socket.io's offline buffer.
  useEffect(() => {
    if (!socket || status !== "connected") return;
    const all = groupsRef.current;
    const resend: {
      groupId: string;
      id: string;
      text: string;
      attachment?: Message["attachment"];
      rich?: string;
    }[] = [];
    for (const groupId of Object.keys(all)) {
      for (const m of all[groupId].messages) {
        if (m.pending || m.failed) {
          resend.push({
            groupId,
            id: m.id,
            text: m.text,
            attachment: m.attachment,
            rich: m.rich,
          });
        }
      }
    }
    if (resend.length === 0) return;
    resend.forEach(({ groupId, id, text, attachment, rich }) => {
      socket.emit("message:send", { groupId, text, clientId: id, attachment, rich });
      armFailTimer(id);
    });
    setGroups((s) => {
      let next = s;
      for (const { groupId, id } of resend) {
        const ch = next[groupId];
        if (!ch) continue;
        next = {
          ...next,
          [groupId]: {
            ...ch,
            messages: ch.messages.map((m) =>
              m.id === id ? { ...m, pending: true, failed: false } : m,
            ),
          },
        };
      }
      return next;
    });
  }, [socket, status, armFailTimer]);

  // Outgoing typing signals: emit typing:start on first keystroke, auto-stop
  // after a short idle, and stop explicitly on send.
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingSentRef = useRef(false);

  const stopTyping = useCallback(
    (groupId: string) => {
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      if (typingSentRef.current) {
        typingSentRef.current = false;
        socket?.emit("typing:stop", { groupId });
      }
    },
    [socket],
  );

  const notifyTyping = useCallback(
    (groupId: string) => {
      if (!typingSentRef.current) {
        typingSentRef.current = true;
        socket?.emit("typing:start", { groupId });
      }
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        typingTimerRef.current = null;
        typingSentRef.current = false;
        socket?.emit("typing:stop", { groupId });
      }, 2500);
    },
    [socket],
  );

  // ⌘K / Esc keyboard shortcuts
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
        setSettingsOpen(false);
        setComposeOpen(false);
        setThreadFor(null);
        setPickerOpenFor(null);
        setActivePanel(null);
        setCreateGroupOpen(false);
        setGroupInfoOpen(false);
        setWorkspaceOpen(false);
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, []);

  // Drafts persist per user in localStorage. Hydrate once the viewer id is
  // known; re-hydrate if it changes (e.g. account switch).
  useEffect(() => {
    if (!userId) return;
    try {
      const d = localStorage.getItem(`chat:drafts:${userId}`);
      setDrafts(d ? (JSON.parse(d) as Record<string, Draft>) : {});
    } catch {
      setDrafts({});
    }
  }, [userId]);
  useEffect(() => {
    if (!userId) return;
    try {
      localStorage.setItem(`chat:drafts:${userId}`, JSON.stringify(drafts));
    } catch {}
  }, [userId, drafts]);

  const openPanel = useCallback((p: NavPanel) => {
    setActivePanel(p);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", "/" + p);
    }
    setThreadFor(null);
    setSettingsOpen(false);
    setComposeOpen(false);
    setSearchOpen(false);
    setCreateGroupOpen(false);
    setWorkspaceOpen(false);
  }, []);
  // Closing a panel returns to the group/DM that was open underneath it.
  const closePanel = useCallback(() => {
    setActivePanel(null);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", idToPath(currentGroupIdRef.current));
    }
  }, []);

  const saveDraft = useCallback((groupId: string, draft: Draft) => {
    setDrafts((d) => {
      // Empty draft → drop the entry so the badge/list stay accurate.
      if (!draft.text.trim()) {
        if (!(groupId in d)) return d;
        const { [groupId]: _gone, ...rest } = d;
        void _gone;
        return rest;
      }
      const cur = d[groupId];
      if (cur && cur.text === draft.text && cur.rich === draft.rich) return d;
      return { ...d, [groupId]: draft };
    });
  }, []);
  const clearDraft = useCallback((groupId: string) => {
    setDrafts((d) => {
      if (!(groupId in d)) return d;
      const { [groupId]: _gone, ...rest } = d;
      void _gone;
      return rest;
    });
  }, []);

  const selectGroup = useCallback((id: string) => {
    navigateTo(id);
    setThreadFor(null);
    setSettingsOpen(false);
    setComposeOpen(false);
    setSearchOpen(false);
    setActivePanel(null);
    setCreateGroupOpen(false);
    setWorkspaceOpen(false);
  }, [navigateTo]);

  // Deep-link from a notification: the service worker postMessages
  // `open-channel` when its notification is clicked (browser), the Electron
  // main process sends the same via the desktop bridge (native notification
  // click), and a cold open arrives as `?channel=<id>`. All route to
  // selectGroup. (The deep-link vocabulary stays "channel"/channelId to match
  // public/sw.js and the installed desktop binary, which aren't renamed here.)
  useEffect(() => {
    const offDesktop = getShellBridge()?.onOpenChannel((id) => selectGroup(id));
    const sw =
      typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; channelId?: string } | undefined;
      if (d?.type === "open-channel" && d.channelId) selectGroup(d.channelId);
    };
    sw?.addEventListener("message", onSwMessage);
    const param = new URLSearchParams(window.location.search).get("channel");
    if (param) {
      selectGroup(param);
      // Strip the param so a refresh doesn't re-trigger the jump.
      window.history.replaceState(null, "", window.location.pathname);
    }
    return () => {
      offDesktop?.();
      sw?.removeEventListener("message", onSwMessage);
    };
  }, [selectGroup]);

  const setComposerText = useCallback((v: string) => setComposerTextState(v), []);
  const setThreadComposerText = useCallback(
    (v: string) => setThreadComposerTextState(v),
    [],
  );

  // Ask a sender to (re)distribute its group key (pull-on-miss), throttled to
  // one request per (group, sender) until we hold a working key. Because the
  // distributed seed is the stable index-0 seed, getting it recovers the
  // sender's whole history, not just messages from here on.
  const requestSenderKey = useCallback(
    (groupId: string, sender: string) => {
      const k = `${groupId}|${sender}`;
      if (!socket || requestedKeysRef.current.has(k)) return;
      requestedKeysRef.current.add(k);
      requestedAtRef.current.set(k, Date.now());
      socket.emit("group:senderKey:request", { groupId, sender });
      // Re-run the decrypt pass after the grace window so an unanswered request
      // can resolve to 🔒 (the key may never come — e.g. our own pre-wipe keys).
      setTimeout(() => setChainVersion((v) => v + 1), KEY_WAIT_MS + 200);
    },
    [socket],
  );

  // Decrypt one inbound envelope. Returns the patch to apply, or null when the
  // message can't be decrypted YET (a group message whose sender key hasn't
  // arrived) — the caller leaves `enc` in place so it retries after the next
  // sender-key distribution. A definitive failure returns a 🔒 patch.
  // DM self-heal: ask the DM peer (and our own other devices) to re-encrypt a
  // message we can't open to our current keys. Throttled to one request per
  // (group|msg); schedules a rehealVersion bump so the decrypt effect re-runs
  // after the grace window (to lock it if no offer arrived).
  const requestReheal = useCallback(
    (groupId: string, msgId: string) => {
      const k = `${groupId}|${msgId}`;
      if (rehealRequestedRef.current.has(k)) return;
      rehealRequestedRef.current.add(k);
      rehealAtRef.current.set(k, Date.now());
      socket?.emit("dm:reheal:request", {
        groupId,
        msgId,
        peerId: dmPeerId(groupId),
      });
      setTimeout(() => setRehealVersion((v) => v + 1), REHEAL_WAIT_MS);
    },
    [socket, dmPeerId],
  );

  const decryptInbound = useCallback(
    async (
      groupId: string,
      enc: string,
      secrets: DeviceSecrets,
      /** Message id — enables DM self-heal on an undecryptable copy (omitted for
       *  ephemeral receipts, which must not trigger a reheal). */
      msgId?: string,
    ): Promise<
      (Partial<Message> & { att?: { key: string; iv: string } }) | null
    > => {
      const locked = { text: "🔒 Unable to decrypt", enc: undefined, locked: true };
      let parsed: unknown;
      try {
        parsed = JSON.parse(enc);
      } catch {
        return locked;
      }
      // MLS application message. Needs the group state; without it (no
      // Welcome/Commit processed yet) stay pending briefly — if no Welcome
      // materializes inside the grace window the message predates our
      // membership (or our leaf is unreachable) and locks. Lock-serialized
      // against sends/commits: decryption advances the receiver chains.
      if (parsed && (parsed as { t?: string }).t === "mls") {
        return withMlsLock(groupId, async () => {
          // Already decrypted this session (overlapping effect runs) → replay
          // the cached plaintext instead of re-ratcheting (which would throw).
          const cached = msgId && mlsPlainRef.current.get(msgId);
          if (cached) return cached;
          const state = await mlsLoadState(groupId);
          if (!state) {
            const since = mlsWaitRef.current.get(groupId);
            if (since === undefined) {
              mlsWaitRef.current.set(groupId, Date.now());
              return null;
            }
            return Date.now() - since > KEY_WAIT_MS ? locked : null;
          }
          mlsWaitRef.current.delete(groupId);
          try {
            const res = await (await loadMls()).mlsDecrypt(state, (parsed as { w: string }).w);
            if (!res) return locked;
            await mlsSaveState(groupId, res.state);
            if (res.kind !== "application") return null; // control msg — state advanced
            const patch = {
              text: res.text,
              rich: res.rich ?? undefined,
              preview: res.preview ?? undefined,
              replyTo: res.replyTo ?? undefined,
              forwarded: res.forwarded ?? undefined,
              enc: undefined,
              att: res.att ?? undefined,
            };
            if (msgId) mlsPlainRef.current.set(msgId, patch);
            return patch;
          } catch (err) {
            // ts-mls throws on a message we can't process (wrong epoch, our own
            // message, foreign/stale group) — lock it rather than crash decrypt.
            console.warn("[mls] decrypt failed", groupId, msgId, err);
            return locked;
          }
        });
      }
      // Group (sender-keys) message.
      if (parsed && (parsed as GroupEnvelope).t === "grp") {
        const env = parsed as GroupEnvelope;
        const k = `${groupId}|${env.s}`;
        let chain = recvChainsRef.current.get(k);
        if (!chain) {
          const wire = await groupGet<SenderKeyWire>(userId, `recv:${groupId}:${env.s}`);
          if (wire) {
            chain = deserializeState(wire);
            recvChainsRef.current.set(k, chain);
          }
        }
        if (!chain) {
          // No key for this sender. If a pull has gone unanswered past the
          // grace window, give up and lock it (e.g. our own messages whose
          // sender key was wiped — no device can ever answer). Otherwise pull
          // and keep waiting; it retries when the key arrives.
          const since = requestedAtRef.current.get(k);
          if (since !== undefined && Date.now() - since > KEY_WAIT_MS) {
            return locked;
          }
          requestSenderKey(groupId, env.s);
          return null;
        }
        const res = await decryptGroupMessage(chain, env);
        if (!res) {
          // Key present but it didn't decrypt (e.g. a stale seed from before a
          // re-key). Ask once for the current seed; if it still fails, lock it.
          if (requestedKeysRef.current.has(k)) return locked;
          requestSenderKey(groupId, env.s);
          return null;
        }
        recvChainsRef.current.set(k, res.next);
        await groupPut(userId, `recv:${groupId}:${env.s}`, serializeState(res.next));
        requestedKeysRef.current.delete(k);
        requestedAtRef.current.delete(k);
        return {
          text: res.text,
          rich: res.rich ?? undefined,
          preview: res.preview ?? undefined,
          replyTo: res.replyTo ?? undefined,
          forwarded: res.forwarded ?? undefined,
          enc: undefined,
          att: res.att ?? undefined,
        };
      }
      // 1:1 DM envelope.
      const res = await decryptEnvelope(parsed as Envelope, secrets);
      if (!res) {
        // Our per-device copy won't open (sealed to a key we no longer hold — a
        // consumed one-time prekey, or we weren't a recipient at send time). Try
        // to self-heal: ask the peer / our own other devices to re-encrypt it to
        // our current keys. Stay pending (null → retry) until the grace window
        // elapses, then lock. Skipped for receipts (no msgId).
        if (msgId && isDm(groupId)) {
          const since = rehealAtRef.current.get(`${groupId}|${msgId}`);
          if (since === undefined || Date.now() - since <= REHEAL_WAIT_MS) {
            requestReheal(groupId, msgId);
            return null;
          }
        }
        return locked;
      }
      // Forward secrecy: drop the one-time prekey this message consumed so its
      // key can't be re-derived from stored keys later, then top the pool back up.
      if (res.usedOpkId) {
        await consumeOneTimePreKey(userId, res.usedOpkId);
        scheduleReplenish();
      }
      return {
        text: res.text,
        rich: res.rich ?? undefined,
        preview: res.preview ?? undefined,
        enc: undefined,
        att: res.att ?? undefined,
      };
    },
    [requestSenderKey, userId, scheduleReplenish, mlsLoadState, mlsSaveState, requestReheal, isDm, withMlsLock],
  );

  // --- E2EE read receipts (Phase 2) -----------------------------------------
  // Merge an incoming read cursor, taking the max readSeq per user across their
  // devices — cursors never regress (out-of-order device replay is harmless).
  const mergeReceipt = useCallback(
    (groupId: string, fromUserId: string, readSeq: number, ts: number) => {
      setReceiptsByGroup((s) => {
        const ch = s[groupId] ?? {};
        const cur = ch[fromUserId];
        if (cur && cur.readSeq >= readSeq) return s;
        return { ...s, [groupId]: { ...ch, [fromUserId]: { readSeq, ts } } };
      });
    },
    [],
  );

  // Decrypt + apply one sealed receipt. Returns false when its sender key hasn't
  // arrived yet (caller parks it for a chainVersion retry); true once handled or
  // definitively undecryptable (dropped). Reuses decryptInbound so a receipt
  // rides the exact same group/DM/MLS path as a message of the same group.
  const processReceipt = useCallback(
    async (p: ReceiptRelayPayload): Promise<boolean> => {
      const secrets = await getSecrets();
      if (!secrets) return false;
      const patch = await decryptInbound(p.groupId, p.env, secrets);
      if (patch === null) return false; // no key yet → park + retry
      if (patch.locked) return true; // undecryptable → drop
      try {
        const c = JSON.parse(patch.text ?? "") as {
          rcpt?: number;
          groupId?: string;
          readSeq?: number;
          ts?: number;
        };
        if (c.rcpt === 1 && c.groupId === p.groupId && typeof c.readSeq === "number") {
          mergeReceipt(p.groupId, p.fromUserId, c.readSeq, c.ts ?? 0);
        }
      } catch {
        // Not a receipt payload (shouldn't happen on this event) — ignore.
      }
      return true;
    },
    [getSecrets, decryptInbound, mergeReceipt],
  );

  // Seal THIS device's read cursor for a group and relay it, debounced. Skips
  // when the cursor hasn't advanced past what we last sealed, and when the
  // group isn't E2EE (buildEnvelope/buildGroupEnc return null → no plaintext).
  const sealReceipt = useCallback(
    async (groupId: string) => {
      if (!socket) return;
      const ch = groupsRef.current[groupId];
      if (!ch) return;
      let readSeq = 0;
      for (const m of ch.messages) {
        if (typeof m.seq === "number" && m.seq > readSeq) readSeq = m.seq;
      }
      if (readSeq <= 0) return;
      if ((lastSealedSeqRef.current.get(groupId) ?? 0) >= readSeq) return;
      const secrets = await getSecrets();
      if (!secrets) return;
      const payload = {
        text: JSON.stringify({ rcpt: 1, groupId, readSeq, ts: Date.now() }),
      };
      const enc = isDm(groupId)
        ? await buildEnvelope(dmPeerId(groupId), payload, { skipOneTimePreKey: true })
        : await buildGroupEnc(groupId, payload);
      if (!enc) return;
      lastSealedSeqRef.current.set(groupId, readSeq);
      socket.emit("receipt:update", { groupId, deviceId: secrets.deviceId, env: enc });
    },
    [socket, getSecrets, buildEnvelope, buildGroupEnc, dmPeerId, isDm],
  );

  // Debounce receipt sealing (2s) — piggybacks the group:read emit sites, so
  // rapidly reading many messages seals once, not once per message.
  const scheduleReceipt = useCallback(
    (groupId: string) => {
      const t = receiptTimersRef.current.get(groupId);
      if (t) clearTimeout(t);
      receiptTimersRef.current.set(
        groupId,
        setTimeout(() => {
          receiptTimersRef.current.delete(groupId);
          void sealReceipt(groupId);
        }, 2000),
      );
    },
    [sealReceipt],
  );

  // Keep the refs the socket/join effects call pointed at the latest closures.
  useEffect(() => {
    processReceiptRef.current = processReceipt;
    scheduleReceiptRef.current = scheduleReceipt;
  });

  // Retry parked receipts when a sender key arrives (chainVersion bump).
  useEffect(() => {
    if (!pendingReceiptsRef.current.length) return;
    const items = pendingReceiptsRef.current;
    pendingReceiptsRef.current = [];
    void (async () => {
      for (const p of items) {
        if (!(await processReceipt(p))) pendingReceiptsRef.current.push(p);
      }
    })();
  }, [chainVersion, processReceipt]);

  // Resolve a receipt's userId to a display User for its "seen by" avatar.
  const resolveReceiptUser = useCallback(
    (uid: string): User => {
      const m = workspaceMembers.find((u) => u.id === uid);
      if (m) return m;
      const dm = groupsRef.current[currentGroupIdRef.current]?.user;
      if (dm?.id === uid) return dm;
      const at = uid.indexOf("@");
      const label = at > 0 ? uid.slice(0, at) : uid;
      return {
        id: uid,
        name: label,
        initials: label.slice(0, 2).toUpperCase(),
        bg: "#8b8b8b",
      };
    },
    [workspaceMembers],
  );

  // For the CURRENT group, place each other user's "seen by" avatar on the
  // newest top-level message their cursor covers (Messenger-style). Keyed by
  // msgId for O(1) lookup in the message row.
  const seenByMsgId = useMemo((): Record<string, User[]> => {
    const cid = currentGroupId;
    const ch = groups[cid];
    const cursors = receiptsByGroup[cid];
    if (!ch || !cursors) return {};
    const tops = ch.messages.filter(
      (m) => typeof m.seq === "number" && !m.deleted,
    );
    if (!tops.length) return {};
    const out: Record<string, User[]> = {};
    for (const [uid, { readSeq }] of Object.entries(cursors)) {
      if (uid === userId) continue; // never render our own receipt
      let best: Message | null = null;
      for (const m of tops) {
        if (m.seq! <= readSeq && (!best || m.seq! > best.seq!)) best = m;
      }
      if (!best) continue;
      if (best.author?.id === uid) continue; // don't badge a user's own message
      (out[best.id] ||= []).push(resolveReceiptUser(uid));
    }
    return out;
  }, [currentGroupId, groups, receiptsByGroup, userId, resolveReceiptUser]);

  // Decrypt inbound E2EE messages on this device, patching the plaintext into
  // place. Runs whenever messages change and quickly no-ops once nothing is
  // pending — decryption clears `enc`, so each message is processed at most
  // once and the loop converges.
  useEffect(() => {
    if (!cryptoAvailable()) return;
    const pending: {
      groupId: string;
      id: string;
      enc: string;
      /** Set when the encrypted message is a thread reply under this parent. */
      parentId?: string;
    }[] = [];
    for (const [cid, ch] of Object.entries(groups)) {
      for (const m of ch.messages) {
        if (m.enc) pending.push({ groupId: cid, id: m.id, enc: m.enc });
        for (const r of m.threadReplies || []) {
          if (r.enc)
            pending.push({ groupId: cid, id: r.id, enc: r.enc, parentId: m.id });
        }
      }
    }
    if (!pending.length) return;
    let cancelled = false;
    void (async () => {
      const secrets = await getSecrets();
      for (const { groupId, id, enc, parentId } of pending) {
        if (cancelled) return;
        let result:
          | (Partial<Message> & { att?: { key: string; iv: string } })
          | null;
        if (!secrets) {
          result = { text: "🔒 Encrypted message", enc: undefined, locked: true };
        } else {
          result = await decryptInbound(groupId, enc, secrets, id);
        }
        // null → not decryptable yet (group key not received); leave `enc` so a
        // later chainVersion bump retries. Skip the state write.
        if (result === null || cancelled) continue;
        // Separate the envelope-carried attachment key from the message patch:
        // it's merged onto the message's attachment so an encrypted image can be
        // fetched + decrypted on display.
        const { att, ...msgPatch } = result;
        const existing = parentId
          ? groups[groupId]?.messages
              .find((m) => m.id === parentId)
              ?.threadReplies?.find((r) => r.id === id)
          : groups[groupId]?.messages.find((m) => m.id === id);
        const patch: Partial<Message> =
          att && existing?.attachment
            ? {
                ...msgPatch,
                attachment: {
                  ...existing.attachment,
                  key: att.key,
                  iv: att.iv,
                },
              }
            : msgPatch;
        // Persist the decrypted plaintext (+ attachment key) so revisiting this
        // group reloads cleartext from IndexedDB instead of re-decrypting the
        // ciphertext — a group message's sender-key ratchet only moves forward
        // (no skipped-key cache), so a second decrypt against the now-advanced
        // chain fails and would flip every prior message back to "🔒 Unable to
        // decrypt". Only successful decrypts are stored; a transient lock
        // (secrets not loaded yet) keeps `enc` so it retries.
        if (!patch.locked) {
          void msgdb.patchMessage(id, patch);
          scheduleBackup(); // decrypted plaintext cached → refresh the backup so
          // this message survives device loss even if its one-time prekey is spent
        }
        setGroups((s) => {
          const ch = s[groupId];
          if (!ch) return s;
          let found = false;
          const messages = ch.messages.map((m) => {
            if (!parentId) {
              if (m.id !== id || !m.enc) return m;
              found = true;
              return { ...m, ...patch };
            }
            if (m.id !== parentId) return m;
            const threadReplies = (m.threadReplies || []).map((r) => {
              if (r.id !== id || !r.enc) return r;
              found = true;
              return { ...r, ...patch };
            });
            return found ? { ...m, threadReplies } : m;
          });
          return found ? { ...s, [groupId]: { ...ch, messages } } : s;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groups, getSecrets, decryptInbound, chainVersion, rehealVersion, scheduleBackup]);

  // socket.io buffers emits while disconnected and flushes on reconnect.
  // Shared by first-send and retry so the wire shape + fail timer stay in sync.
  const emitSend = useCallback(
    (
      groupId: string,
      clientId: string,
      text: string,
      attachment?: Attachment | null,
      rich?: string,
      preview?: LinkPreview,
      replyTo?: ReplyRef,
      forwarded?: boolean,
    ) => {
      armFailTimer(clientId);
      // An encrypted attachment's key/iv travel inside the message envelope, so
      // strip them from the wire attachment (the server only ever gets ciphertext
      // + an opaque blob). Default-E2EE: there is no plaintext send path.
      const att =
        attachment?.encrypted && attachment.key && attachment.iv
          ? { key: attachment.key, iv: attachment.iv }
          : undefined;
      const strippedAttachment = attachment
        ? (() => {
            const { key: _k, iv: _iv, ...rest } = attachment;
            void _k;
            void _iv;
            return rest;
          })()
        : undefined;
      const sendEnc = (enc: string) =>
        socket?.emit("message:send", {
          groupId,
          text: "",
          clientId,
          attachment: strippedAttachment,
          enc,
        });
      // Default-E2EE: the server only ever sees ciphertext. If we can't encrypt
      // (no recipient has published keys, or WebCrypto is unavailable) we FAIL
      // the message with a reason — never fall back to plaintext.
      const NO_KEYS =
        "Not sent — end-to-end encryption isn’t available here yet (the other side hasn’t set up their keys).";
      if (cryptoAvailable() && socket) {
        // The preview travels ONLY inside the envelope — never a wire field.
        const build = isDm(groupId)
          ? buildEnvelope(dmPeerId(groupId), { text, rich, att, preview, replyTo, forwarded })
          : buildGroupEnc(groupId, { text, rich, att, preview, replyTo, forwarded });
        build
          .then((enc) => (enc ? sendEnc(enc) : markFailed(clientId, NO_KEYS)))
          .catch(() => markFailed(clientId, NO_KEYS));
      } else {
        markFailed(clientId, "Not sent — encryption isn’t available on this device.");
      }
    },
    [socket, armFailTimer, buildEnvelope, buildGroupEnc, dmPeerId, markFailed, isDm],
  );

  const sendMessage = useCallback(
    (text: string, rich?: string, preview?: LinkPreview) => {
      const trimmed = text.trim();
      const attachment = composerAttachment;
      if (!trimmed && !attachment) return;
      // Quoted reply: snapshot the message being replied to (consumed here so
      // the reply banner clears on send). Rides the E2EE envelope via emitSend.
      const replyTo: ReplyRef | undefined = replyingTo
        ? {
            msgId: replyingTo.id,
            author: replyingTo.author.name,
            authorId: replyingTo.author.id,
            text: messageExcerpt(replyingTo),
          }
        : undefined;
      // Optimistic: render immediately with a temp id that doubles as the
      // clientId for reconcile. The server ack swaps in the canonical message.
      const clientId = "tmp-" + Date.now();
      const optimistic: Message = {
        id: clientId,
        author: myUser,
        self: true,
        time: nowTime(),
        ts: Date.now(),
        text: trimmed,
        reactions: [],
        pending: true,
        ...(attachment ? { attachment } : {}),
        ...(rich ? { rich } : {}),
        ...(preview ? { preview } : {}),
        ...(replyTo ? { replyTo } : {}),
      };
      setGroups((s) => {
        const ch = { ...s[currentGroupId] };
        ch.messages = [...ch.messages, optimistic];
        return { ...s, [currentGroupId]: ch };
      });
      setComposerAttachment(null);
      stopTyping(currentGroupId);
      requestAnimationFrame(scrollToBottom);
      // Remember our own plaintext (and the attachment key, which rides the
      // envelope and is stripped from the acked attachment) so the ack renders
      // without self-decryption.
      sentPlaintextRef.current.set(clientId, {
        text: trimmed,
        rich,
        preview,
        ...(replyTo ? { replyTo } : {}),
        ...(attachment?.encrypted && attachment.key && attachment.iv
          ? { att: { key: attachment.key, iv: attachment.iv } }
          : {}),
      });
      setReplyingTo(null);
      emitSend(currentGroupId, clientId, trimmed, attachment, rich, preview, replyTo);
    },
    [
      composerAttachment,
      currentGroupId,
      replyingTo,
      scrollToBottom,
      myUser,
      stopTyping,
      emitSend,
    ],
  );

  const retrySend = useCallback(
    (groupId: string, msgId: string) => {
      const msg = groups[groupId]?.messages.find((m) => m.id === msgId);
      if (!msg) return;
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        const msgs = ch.messages.map((m) =>
          m.id === msgId ? { ...m, pending: true, failed: false } : m,
        );
        return { ...s, [groupId]: { ...ch, messages: msgs } };
      });
      emitSend(
        groupId,
        msgId,
        msg.text,
        msg.attachment,
        msg.rich,
        msg.preview,
        msg.replyTo,
        msg.forwarded,
      );
    },
    [groups, emitSend],
  );

  const deleteMessage = useCallback(
    (groupId: string, msgId: string) => {
      // The server keeps no message copy, so tell it whether this is a thread
      // reply (and under which parent) by inspecting the loaded tree.
      const ch = groupsRef.current[groupId];
      const parent = ch?.messages.find((m) =>
        (m.threadReplies || []).some((r) => r.id === msgId),
      );
      socket?.emit("message:delete", {
        groupId,
        msgId,
        parentId: parent?.id ?? null,
      });
    },
    [socket],
  );

  // --- message editing -------------------------------------------------------
  // An edit is a re-encrypted body: the FULL MessageContent (text, rich, the
  // attachment's key/iv, preview) is re-sealed and the server REPLACES the
  // stored envelope — so the attachment key must ride along, or a device
  // replaying history later could never decrypt the (kept) attachment.
  const startEdit = useCallback((groupId: string, msg: Message) => {
    const ch = groupsRef.current[groupId];
    const parent = ch?.messages.find((m) =>
      (m.threadReplies || []).some((r) => r.id === msg.id),
    );
    setEditing({ groupId, msgId: msg.id, parentId: parent?.id ?? null });
  }, []);
  const cancelEdit = useCallback(() => setEditing(null), []);

  const submitEdit = useCallback(
    (text: string, rich?: string) => {
      const ed = editing;
      if (!ed || !socket) return;
      setEditing(null);
      const { groupId, msgId, parentId } = ed;
      const ch = groupsRef.current[groupId];
      const msg = parentId
        ? ch?.messages
            .find((m) => m.id === parentId)
            ?.threadReplies?.find((r) => r.id === msgId)
        : ch?.messages.find((m) => m.id === msgId);
      // Only own, delivered, already-decrypted messages are editable.
      if (!msg || !msg.self || msg.deleted || msg.pending || msg.enc) return;
      const trimmed = text.trim();
      if (!trimmed || (trimmed === msg.text && rich === msg.rich)) return;

      const prev: Partial<Message> = {
        text: msg.text,
        rich: msg.rich,
        edited: msg.edited,
        editedTs: msg.editedTs,
      };
      const patch: Partial<Message> = {
        text: trimmed,
        rich,
        edited: true,
        editedTs: Date.now(), // provisional — the echo applies the server stamp
      };
      // Optimistic apply; the echoed message:edited short-circuits via this
      // cache (no ciphertext round-trip for the editing device).
      sentEditRef.current.set(msgId, { patch, prev });
      applyMessagePatch(groupId, msgId, parentId, patch);
      void msgdb.patchMessage(msgId, patch);

      const revert = () => {
        sentEditRef.current.delete(msgId);
        editTimersRef.current.delete(msgId);
        applyMessagePatch(groupId, msgId, parentId, prev);
        void msgdb.patchMessage(msgId, prev);
      };
      // Default-E2EE, same as sends: an edit that can't be encrypted is
      // reverted — never sent as plaintext.
      if (!cryptoAvailable()) return revert();
      const att =
        msg.attachment?.encrypted && msg.attachment.key && msg.attachment.iv
          ? { key: msg.attachment.key, iv: msg.attachment.iv }
          : undefined;
      const content: MessageContent = {
        text: trimmed,
        rich,
        att,
        preview: msg.preview,
      };
      const build = isDm(groupId)
        ? buildEnvelope(dmPeerId(groupId), content)
        : buildGroupEnc(groupId, content);
      build
        .then((enc) => {
          if (!enc) return revert();
          editTimersRef.current.set(msgId, setTimeout(revert, SEND_TIMEOUT_MS));
          socket.emit("message:edit", { groupId, msgId, parentId, enc });
        })
        .catch(revert);
    },
    [
      editing,
      socket,
      applyMessagePatch,
      buildEnvelope,
      buildGroupEnc,
      dmPeerId,
      SEND_TIMEOUT_MS,
      isDm,
    ],
  );

  // The message currently being edited, resolved from live state (so the
  // composer seeds from the freshest body).
  const editingMessage = useMemo((): Message | null => {
    if (!editing) return null;
    const ch = groups[editing.groupId];
    if (!ch) return null;
    return (
      (editing.parentId
        ? ch.messages
            .find((m) => m.id === editing.parentId)
            ?.threadReplies?.find((r) => r.id === editing.msgId)
        : ch.messages.find((m) => m.id === editing.msgId)) ?? null
    );
  }, [editing, groups]);

  const openForward = useCallback((msg: Message) => setForwardSource(msg), []);
  const closeForward = useCallback(() => setForwardSource(null), []);
  // Forward to any number of conversations. Each target gets its own optimistic
  // message + E2EE send (via emitSend) — the same default-E2EE path as a normal
  // send, so a forward is never relayed as plaintext. Marked `forwarded` so the
  // recipient renders the "Forwarded" label.
  const forwardMessage = useCallback(
    (toGroupIds: string[]) => {
      const src = forwardSource;
      if (!src || toGroupIds.length === 0) return;
      toGroupIds.forEach((toId, i) => {
        const clientId = `tmp-${Date.now()}-${i}`;
        const optimistic: Message = {
          id: clientId,
          author: myUser,
          self: true,
          time: nowTime(),
          ts: Date.now(),
          text: src.text,
          reactions: [],
          pending: true,
          forwarded: true,
          ...(src.attachment ? { attachment: src.attachment } : {}),
          ...(src.rich ? { rich: src.rich } : {}),
        };
        setGroups((s) => {
          const ch = s[toId];
          if (!ch) return s;
          return { ...s, [toId]: { ...ch, messages: [...ch.messages, optimistic] } };
        });
        sentPlaintextRef.current.set(clientId, {
          text: src.text,
          rich: src.rich,
          forwarded: true,
          ...(src.attachment?.encrypted && src.attachment.key && src.attachment.iv
            ? { att: { key: src.attachment.key, iv: src.attachment.iv } }
            : {}),
        });
        emitSend(toId, clientId, src.text, src.attachment, src.rich, undefined, undefined, true);
      });
      setForwardSource(null);
      if (toGroupIds.length === 1) {
        selectGroup(toGroupIds[0]);
      } else {
        toast.success(`Forwarded to ${toGroupIds.length} chats`);
      }
    },
    [forwardSource, myUser, emitSend, selectGroup],
  );

  const startReply = useCallback((msg: Message) => {
    // Reply and edit are mutually exclusive compose modes.
    setEditing(null);
    setReplyingTo(msg);
  }, []);
  const cancelReply = useCallback(() => setReplyingTo(null), []);

  const sendThreadMessage = useCallback(
    (text: string, rich?: string) => {
      const trimmed = text.trim();
      if (!trimmed || !threadFor) return;
      stopTyping(currentGroupId);
      // The server broadcasts thread:new back to the whole room (incl. us), so
      // we don't render optimistically — one broadcast keeps everyone in sync.
      socket?.emit("thread:reply", {
        groupId: currentGroupId,
        parentId: threadFor,
        text: trimmed,
        clientId: "tmp-" + Date.now(),
        rich,
      });
    },
    [threadFor, currentGroupId, socket, stopTyping],
  );

  const toggleReaction = useCallback(
    (msgId: string, emoji: string) => {
      // Server owns the count; it broadcasts reaction:updated back to the room.
      socket?.emit("reaction:toggle", { groupId: currentGroupId, msgId, emoji });
      setPickerOpenFor(null);
    },
    [currentGroupId, socket],
  );

  const togglePicker = useCallback((msgId: string) => {
    setPickerOpenFor((cur) => (cur === msgId ? null : msgId));
    setMoreOpenFor(null); // one popover at a time
  }, []);
  const toggleMore = useCallback((msgId: string) => {
    setMoreOpenFor((cur) => (cur === msgId ? null : msgId));
    setPickerOpenFor(null);
  }, []);
  const closeMore = useCallback(() => setMoreOpenFor(null), []);

  const openThread = useCallback((msgId: string) => {
    setThreadFor(msgId);
    setGroupInfoOpen(false);
  }, []);
  const closeThread = useCallback(() => setThreadFor(null), []);
  const toggleGroupInfo = useCallback(() => {
    setGroupInfoOpen((v) => {
      if (!v) setThreadFor(null); // only one right drawer at a time
      return !v;
    });
  }, []);
  const closeGroupInfo = useCallback(() => setGroupInfoOpen(false), []);

  const hidePinnedBar = useCallback(
    (groupId: string) =>
      setPinnedBarHidden((s) => ({ ...s, [groupId]: true })),
    [],
  );
  const togglePinnedPanel = useCallback(
    (groupId: string) =>
      setPinnedPanelFor((cur) => (cur === groupId ? null : groupId)),
    [],
  );
  const togglePin = useCallback(
    (groupId: string, msgId: string) => {
      socket?.emit("pin:toggle", { groupId, msgId });
    },
    [socket],
  );

  // Page older messages from IndexedDB (prepend, de-dupe, advance the cursor).
  const loadOlder = useCallback(
    async (groupId: string) => {
      const cursor = historyCursor[groupId];
      if (cursor == null) return;
      const { messages, nextCursor } = await msgdb.getTopPage(
        groupId,
        cursor,
        PAGE_SIZE,
      );
      setGroups((s) => {
        const ch = s[groupId];
        if (!ch) return s;
        const have = new Set(ch.messages.map((m) => m.id));
        const older = messages.filter((m) => !have.has(m.id)).map(withSelf);
        if (older.length === 0) return s;
        return { ...s, [groupId]: { ...ch, messages: [...older, ...ch.messages] } };
      });
      setHistoryCursor((c) => ({ ...c, [groupId]: nextCursor }));
    },
    [historyCursor, withSelf],
  );

  // Jump to a message (e.g. a pinned one). History lives locally, so just
  // highlight it if it's loaded; otherwise the latest page is already shown.
  const jumpToMessage = useCallback(
    async (groupId: string, msgId: string, parentId?: string | null) => {
      setPinnedPanelFor(null);
      // Thread-reply hit: open its parent's thread panel (replies live there,
      // not in the group scroll) and highlight it within the thread.
      if (parentId) {
        if (groupId !== currentGroupIdRef.current) navigateTo(groupId);
        setThreadFor(parentId);
        setHighlightMsgId(msgId);
        return;
      }
      // Top-level hit: if it's already loaded, just highlight; otherwise load a
      // window around it (guarding the join effect from clobbering with the
      // latest page), then highlight once it's in state.
      const loaded = groupsRef.current[groupId]?.messages.some(
        (m) => m.id === msgId,
      );
      if (groupId === currentGroupIdRef.current && loaded) {
        setHighlightMsgId(msgId);
        return;
      }
      jumpPendingRef.current = groupId;
      if (groupId !== currentGroupIdRef.current) navigateTo(groupId);
      try {
        const { messages, nextCursor } = await msgdb.getPageAround(
          groupId,
          msgId,
          PAGE_SIZE,
        );
        const withReplies = await Promise.all(
          messages.map(async (m) =>
            m.threadCount
              ? { ...m, threadReplies: await msgdb.getReplies(m.id) }
              : m,
          ),
        );
        setGroups((s) => {
          const ch = s[groupId];
          if (!ch) return s;
          const loadedMsgs = withReplies.map(withSelf);
          const ids = new Set(loadedMsgs.map((m) => m.id));
          const pendingTail = ch.messages.filter(
            (m) => (m.pending || m.failed) && !ids.has(m.id),
          );
          return {
            ...s,
            [groupId]: { ...ch, messages: [...loadedMsgs, ...pendingTail] },
          };
        });
        setHistoryCursor((c) => ({ ...c, [groupId]: nextCursor }));
      } finally {
        jumpPendingRef.current = null;
      }
      requestAnimationFrame(() => setHighlightMsgId(msgId));
    },
    [navigateTo, withSelf],
  );
  const clearHighlight = useCallback(() => setHighlightMsgId(null), []);

  const openSettings = useCallback(() => {
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", "/settings");
    }
    setSettingsOpen(true);
    setActivePanel(null);
    setCreateGroupOpen(false);
    setWorkspaceOpen(false);
  }, []);
  // Closing settings returns to the group/DM that was open underneath it.
  const closeSettings = useCallback(() => {
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", idToPath(currentGroupIdRef.current));
    }
    setSettingsOpen(false);
  }, []);

  const openCompose = useCallback(() => {
    setComposeOpen(true);
    setComposeQuery("");
    setComposeText("");
    setComposeRecipients([]);
    setActivePanel(null);
    setWorkspaceOpen(false);
  }, []);
  const closeCompose = useCallback(() => setComposeOpen(false), []);

  const openCreateGroup = useCallback(() => {
    setCreateGroupOpen(true);
    setSettingsOpen(false);
    setComposeOpen(false);
    setSearchOpen(false);
    setActivePanel(null);
    setWorkspaceOpen(false);
  }, []);

  const openWorkspace = useCallback(() => {
    setWorkspaceOpen(true);
    setSettingsOpen(false);
    setComposeOpen(false);
    setSearchOpen(false);
    setCreateGroupOpen(false);
    setActivePanel(null);
  }, []);
  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);
  const renameWorkspace = useCallback(
    (name: string, onError?: (msg: string) => void) => {
      socket?.emit("workspace:rename", { name }, (res) => {
        if (!res.ok) onError?.(res.error);
      });
    },
    [socket],
  );
  const inviteWorkspaceMember = useCallback(
    (memberId: string) => {
      socket?.emit("workspace:invite", { userId: memberId }, () => {});
    },
    [socket],
  );
  const removeWorkspaceMember = useCallback(
    (memberId: string) => {
      socket?.emit("workspace:removeMember", { userId: memberId }, () => {});
    },
    [socket],
  );
  const updateProfile = useCallback(
    (patch: Partial<UserProfile>) => {
      // Optimistic merge; the server echo (profile:updated) reconciles the
      // canonical document (trimming + empty-value deletion).
      setProfile((p) => ({ ...p, ...patch }));
      socket?.emit("profile:update", { patch });
    },
    [socket],
  );

  // --- Messenger customization + archived chats (live in the profile) ------
  const bubbleTheme = profile.bubbleTheme ?? "default";
  const likeEmoji = profile.likeEmoji ?? "👍";
  const archivedIds = useMemo(() => profile.archived ?? [], [profile.archived]);
  const setBubbleTheme = useCallback(
    (t: string) => updateProfile({ bubbleTheme: t }),
    [updateProfile],
  );
  const setLikeEmoji = useCallback(
    (e: string) => updateProfile({ likeEmoji: e }),
    [updateProfile],
  );
  const isArchived = useCallback(
    (id: string) => archivedIds.includes(id),
    [archivedIds],
  );
  const toggleArchived = useCallback(
    (id: string) => {
      const next = archivedIds.includes(id)
        ? archivedIds.filter((x) => x !== id)
        : [...archivedIds, id];
      updateProfile({ archived: next });
    },
    [archivedIds, updateProfile],
  );
  const [chatFilter, setChatFilter] = useState<ChatFilter>("inbox");

  // The chat color drives the shared --sent-grad variable, so bubbles, the
  // send button, and the app logo all follow the chosen gradient.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--sent-grad",
      gradientFor(bubbleTheme),
    );
  }, [bubbleTheme]);

  const openStatus = useCallback(() => setStatusOpen(true), []);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  const closeCreateGroup = useCallback(() => setCreateGroupOpen(false), []);
  const createGroup = useCallback(
    (
      name: string,
      topic: string,
      isPrivate: boolean,
      onError?: (msg: string) => void,
    ) => {
      const trimmed = name.trim();
      if (!trimmed) {
        onError?.("Enter a group name.");
        return;
      }
      socket?.emit(
        "group:create",
        { name: trimmed, topic: topic.trim() || undefined, private: isPrivate },
        (res) => {
          if (res.ok) {
            setCreateGroupOpen(false);
            selectGroup(res.groupId);
          } else {
            onError?.(res.error);
          }
        },
      );
    },
    [socket, selectGroup],
  );

  const updateGroup = useCallback(
    (
      groupId: string,
      patch: { name?: string; topic?: string },
      onError?: (msg: string) => void,
    ) => {
      socket?.emit("group:update", { groupId, ...patch }, (res) => {
        if (!res.ok) onError?.(res.error);
      });
    },
    [socket],
  );
  const deleteGroup = useCallback(
    (groupId: string, onError?: (msg: string) => void) => {
      socket?.emit("group:delete", { groupId }, (res) => {
        if (!res.ok) onError?.(res.error);
      });
    },
    [socket],
  );
  const addGroupMember = useCallback(
    (groupId: string, memberId: string) => {
      socket?.emit("group:addMember", { groupId, userId: memberId }, () => {});
    },
    [socket],
  );
  const removeGroupMember = useCallback(
    (groupId: string, memberId: string) => {
      socket?.emit(
        "group:removeMember",
        { groupId, userId: memberId },
        () => {},
      );
    },
    [socket],
  );

  const sendCompose = useCallback(() => {
    const text = composeText.trim();
    const recipient = composeRecipients[0];
    if (!recipient || !text) return;

    const user = workspaceMembers.find((u) => u.name === recipient);
    if (!user?.id) return;

    // The recipient key is the partner's stable uid (the id the server routes
    // DMs by and that their E2EE bundles are published under) — never guessed
    // from the display name, which fails for real users keyed by email.
    const recipientId = user.id;
    // DM id == the peer's stable uid (no "dm-" prefix): the flat id space is
    // shared with groups, and `type` distinguishes them.
    const dmId = recipientId;
    const clientId = "tmp-" + Date.now();
    const optimistic: Message = {
      id: clientId,
      author: myUser,
      self: true,
      time: nowTime(),
      ts: Date.now(),
      text,
      reactions: [],
      pending: true,
    };

    setGroups((s) => {
      const existing = s[dmId];
      if (existing) {
        return {
          ...s,
          [dmId]: { ...existing, messages: [...existing.messages, optimistic] },
        };
      }
      const newDm: Group = {
        id: dmId,
        type: "dm",
        name: user.name,
        user,
        presence: "active",
        pinned: [],
        messages: [optimistic],
      };
      return { ...s, [dmId]: newDm };
    });

    setDmOrder((order) => (order.includes(dmId) ? order : [...order, dmId]));
    setComposeText("");
    setComposeQuery("");
    setComposeRecipients([]);
    navigateTo(dmId);
    setComposeOpen(false);
    requestAnimationFrame(scrollToBottom);
    armFailTimer(clientId);
    sentPlaintextRef.current.set(clientId, { text });
    // Server creates/joins the DM, acks our optimistic message, and announces
    // brand-new DMs to other clients via group:created. Default-E2EE: only
    // send once encrypted; if the recipient has no keys yet, fail (no plaintext).
    const NO_KEYS =
      "Not sent — end-to-end encryption isn’t available yet (they haven’t set up their keys).";
    if (cryptoAvailable() && socket) {
      buildEnvelope(recipientId, { text })
        .then((enc) =>
          enc
            ? socket.emit("dm:create", { recipientId, text: "", clientId, enc })
            : markFailed(clientId, NO_KEYS),
        )
        .catch(() => markFailed(clientId, NO_KEYS));
    } else {
      markFailed(clientId, "Not sent — encryption isn’t available on this device.");
    }
  }, [composeText, composeRecipients, workspaceMembers, scrollToBottom, socket, myUser, armFailTimer, buildEnvelope, navigateTo, markFailed]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setActivePanel(null);
    setCreateGroupOpen(false);
    setWorkspaceOpen(false);
  }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const addRecipient = useCallback((name: string) => {
    setComposeRecipients((r) => [...r, name]);
    setComposeQuery("");
  }, []);
  const removeRecipient = useCallback((name: string) => {
    setComposeRecipients((r) => r.filter((x) => x !== name));
  }, []);

  const value = useMemo<ChatContextValue>(
    () => ({
      groups,
      currentGroupId,
      selectGroup,
      threadFor,
      openThread,
      closeThread,
      groupInfoOpen,
      toggleGroupInfo,
      closeGroupInfo,
      historyCursor,
      loadOlder,
      jumpToMessage,
      highlightMsgId,
      clearHighlight,
      composerText,
      setComposerText,
      composerActive,
      setComposerActive,
      composerAttachment,
      setComposerAttachment,
      sendMessage,
      retrySend,
      deleteMessage,
      editing,
      editingMessage,
      startEdit,
      cancelEdit,
      submitEdit,
      forwardSource,
      openForward,
      closeForward,
      forwardMessage,
      replyingTo,
      startReply,
      cancelReply,
      threadComposerText,
      setThreadComposerText,
      sendThreadMessage,
      seenByMsgId,
      hoverMsgId,
      setHoverMsgId,
      pickerOpenFor,
      togglePicker,
      moreOpenFor,
      toggleMore,
      closeMore,
      toggleReaction,
      pinnedBarHidden,
      hidePinnedBar,
      pinnedPanelFor,
      togglePinnedPanel,
      togglePin,
      userId,
      myUser,
      profile,
      updateProfile,
      statusOpen,
      openStatus,
      closeStatus,
      typingByGroup,
      notifyTyping,
      groupOrder,
      rosterLoaded,
      groupsOpen,
      toggleGroups: () => setGroupsOpen((s) => !s),
      dmsOpen,
      toggleDms: () => setDmsOpen((s) => !s),
      settingsOpen,
      openSettings,
      closeSettings,
      settingsTab,
      setSettingsTab,
      backupSetupOpen,
      setBackupSetupOpen,
      keyAlerts: Object.values(keyAlerts),
      acknowledgeKeyAlert,
      dmOrder,
      composeOpen,
      openCompose,
      closeCompose,
      composeQuery,
      setComposeQuery,
      composeText,
      setComposeText,
      composeRecipients,
      addRecipient,
      removeRecipient,
      sendCompose,
      searchOpen,
      openSearch,
      closeSearch,
      searchQ,
      setSearchQ,
      activePanel,
      openPanel,
      closePanel,
      createGroupOpen,
      openCreateGroup,
      closeCreateGroup,
      createGroup,
      updateGroup,
      deleteGroup,
      addGroupMember,
      removeGroupMember,
      unreadByGroup,
      workspaceName,
      workspaceMembers,
      workspaceOpen,
      openWorkspace,
      closeWorkspace,
      renameWorkspace,
      inviteWorkspaceMember,
      removeWorkspaceMember,
      chatFilter,
      setChatFilter,
      bubbleTheme,
      setBubbleTheme,
      likeEmoji,
      setLikeEmoji,
      archivedIds,
      isArchived,
      toggleArchived,
      drafts,
      saveDraft,
      clearDraft,
      scrollRef,
    }),
    [
      groups,
      currentGroupId,
      selectGroup,
      threadFor,
      openThread,
      closeThread,
      groupInfoOpen,
      toggleGroupInfo,
      closeGroupInfo,
      historyCursor,
      loadOlder,
      jumpToMessage,
      highlightMsgId,
      clearHighlight,
      composerText,
      setComposerText,
      composerActive,
      composerAttachment,
      sendMessage,
      retrySend,
      deleteMessage,
      editing,
      editingMessage,
      startEdit,
      cancelEdit,
      submitEdit,
      forwardSource,
      openForward,
      closeForward,
      forwardMessage,
      replyingTo,
      startReply,
      cancelReply,
      threadComposerText,
      setThreadComposerText,
      sendThreadMessage,
      seenByMsgId,
      hoverMsgId,
      pickerOpenFor,
      togglePicker,
      moreOpenFor,
      toggleMore,
      closeMore,
      toggleReaction,
      pinnedBarHidden,
      hidePinnedBar,
      pinnedPanelFor,
      togglePinnedPanel,
      togglePin,
      userId,
      myUser,
      profile,
      updateProfile,
      statusOpen,
      openStatus,
      closeStatus,
      typingByGroup,
      notifyTyping,
      groupOrder,
      rosterLoaded,
      groupsOpen,
      dmsOpen,
      settingsOpen,
      openSettings,
      closeSettings,
      settingsTab,
      backupSetupOpen,
      keyAlerts,
      acknowledgeKeyAlert,
      dmOrder,
      composeOpen,
      openCompose,
      closeCompose,
      composeQuery,
      composeText,
      composeRecipients,
      addRecipient,
      removeRecipient,
      sendCompose,
      searchOpen,
      openSearch,
      closeSearch,
      searchQ,
      activePanel,
      openPanel,
      closePanel,
      createGroupOpen,
      openCreateGroup,
      closeCreateGroup,
      createGroup,
      updateGroup,
      deleteGroup,
      addGroupMember,
      removeGroupMember,
      unreadByGroup,
      workspaceName,
      workspaceMembers,
      workspaceOpen,
      openWorkspace,
      closeWorkspace,
      renameWorkspace,
      inviteWorkspaceMember,
      removeWorkspaceMember,
      chatFilter,
      bubbleTheme,
      setBubbleTheme,
      likeEmoji,
      setLikeEmoji,
      archivedIds,
      isArchived,
      toggleArchived,
      drafts,
      saveDraft,
      clearDraft,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
