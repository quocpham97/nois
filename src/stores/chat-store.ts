/**
 * The chat store — every piece of chat state a view can render, in one place
 * that views subscribe to a SLICE of.
 *
 * Why a store and not a context: this state used to live in ~50 `useState`
 * hooks behind a single ~200-member context value, so a composer keystroke
 * re-rendered the sidebar, the workspace rail and every message row. Here a
 * component selects only the fields it draws (`useChatStore((s) => s.searchQ)`)
 * and re-renders only when those change.
 *
 * What belongs here: state, and the actions that are pure state transitions
 * (opening a panel, toggling a popover, moving the URL). What does NOT belong
 * here: anything needing the socket, the crypto stores or React effects — those
 * live in the logic hooks under components/chat/hooks and are handed to views
 * through `useChatActions`.
 *
 * Setters keep React's `useState` contract — `setGroups((s) => …)` as well as
 * `setGroups(value)` — because the logic hooks are written against that shape.
 */
import { create } from "zustand";
import type {
  Attachment,
  Group,
  GroupMap,
  Message,
  User,
  UserProfile,
} from "@/lib/chat-data";
import type { Pin } from "@/lib/crypto/pinning";
import { idToPath } from "@/components/chat/lib/nav-paths";
import type {
  ChatFilter,
  Draft,
  EditTarget,
  NavPanel,
  SettingsTab,
} from "@/components/chat/lib/types";

/** A `useState`-shaped update: a value, or a function of the previous value. */
export type Updater<T> = T | ((prev: T) => T);

/** Read cursors per group: userId → their furthest-read seq. */
export type ReceiptMap = Record<
  string,
  Record<string, { readSeq: number; ts: number }>
>;

/** Shared empty array so `profile.archived ?? EMPTY` keeps a stable identity
 *  across selector runs (a fresh `[]` would re-render every subscriber). */
export const EMPTY_IDS: string[] = [];

/** The renderable state. Split out from the actions so the setter helper can be
 *  typed over data keys only. */
type ChatData = {
  /** Every loaded conversation, keyed by id. */
  groups: GroupMap;
  /** The open conversation ("" = none). The URL is the source of truth. */
  currentGroupId: string;
  /** Authorized group / DM ids, in the server roster's order. */
  groupOrder: string[];
  dmOrder: string[];
  /** True once the server roster has arrived at least once this session
   *  (distinguishes "still loading" from "genuinely no conversations"). */
  rosterLoaded: boolean;
  /** Pagination cursor per group (seq to fetch older, or null when done). */
  historyCursor: Record<string, string | null>;
  /** Server-tracked unread counts per group id. */
  unreadByGroup: Record<string, number>;
  /** userIds currently typing, keyed by group id. */
  typingByGroup: Record<string, string[]>;

  /** Open thread panel (a parent msgId), mutually exclusive with group info. */
  threadFor: string | null;
  groupInfoOpen: boolean;
  highlightMsgId: string | null;
  hoverMsgId: string | null;
  pickerOpenFor: string | null;
  moreOpenFor: string | null;
  pinnedPanelFor: string | null;

  composerText: string;
  composerActive: boolean;
  composerAttachment: Attachment | null;
  threadComposerText: string;
  replyingTo: Message | null;
  editing: EditTarget | null;
  /** Unsent composer drafts keyed by group id, persisted per user. */
  drafts: Record<string, Draft>;

  groupsOpen: boolean;
  dmsOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Controlled open-state of the standalone "Set a backup PIN" modal, lifted
   *  here so the no-backup nudge banner / sign-out dialog can pop it over any
   *  view (it's mounted in the app shell, not inside Settings). */
  backupSetupOpen: boolean;

  composeOpen: boolean;
  composeQuery: string;
  composeText: string;
  composeRecipients: string[];

  searchOpen: boolean;
  searchQ: string;
  createGroupOpen: boolean;
  /** Which sidebar nav panel (Mentions/Drafts/People/Archived) owns the pane. */
  activePanel: NavPanel | null;
  chatFilter: ChatFilter;

  workspaceName: string;
  workspaceMembers: User[];
  workspaceOpen: boolean;

  forwardSource: Message | null;

  /** The server-resolved display identity the saved profile implies. The base
   *  identity lives in the session store; `chat-selectors.useMyUser()` layers
   *  this over it. */
  profileUser: User | null;
  profile: UserProfile;
  statusOpen: boolean;

  /** E2EE read receipts, merged to the max readSeq per user across devices. */
  receiptsByGroup: ReceiptMap;
  /** Peer devices whose identity key changed since we pinned it (TOFU), by
   *  deviceId. Surfaced as a "safety number changed" warning until acked. */
  keyAlerts: Record<string, Pin>;
  /** Bumped when a new sender-key chain is stored, to re-run the decrypt pass
   *  over messages that arrived before their key. */
  chainVersion: number;
  /** Bumped when a DM reheal offer swaps in a fresh envelope. */
  rehealVersion: number;
};

export type ChatSetters = {
  [K in keyof ChatData as `set${Capitalize<K>}`]: (
    v: Updater<ChatData[K]>,
  ) => void;
};

export type ChatStoreActions = {
  /** Move to a conversation by pushing the URL; the routing hook's pathname
   *  effect then adopts it. Clears every full-pane overlay. */
  selectGroup: (id: string) => void;
  /** Set the conversation without touching overlays (used by the URL effect). */
  navigateTo: (id: string) => void;

  openPanel: (p: NavPanel) => void;
  closePanel: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openCompose: () => void;
  closeCompose: () => void;
  openCreateGroup: () => void;
  closeCreateGroup: () => void;
  openWorkspace: () => void;
  closeWorkspace: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  openStatus: () => void;
  closeStatus: () => void;
  /** Dismiss every state-only overlay (Escape, and the URL effect). */
  dismissOverlays: () => void;

  openThread: (msgId: string) => void;
  closeThread: () => void;
  toggleGroupInfo: () => void;
  closeGroupInfo: () => void;
  togglePicker: (msgId: string) => void;
  toggleMore: (msgId: string) => void;
  closeMore: () => void;
  togglePinnedPanel: (groupId: string) => void;
  clearHighlight: () => void;
  toggleGroups: () => void;
  toggleDms: () => void;

  startReply: (msg: Message) => void;
  cancelReply: () => void;
  cancelEdit: () => void;
  openForward: (msg: Message) => void;
  closeForward: () => void;

  addRecipient: (name: string) => void;
  removeRecipient: (name: string) => void;

  saveDraft: (groupId: string, draft: Draft) => void;
  clearDraft: (groupId: string) => void;

  /** Merge one peer's read cursor, taking the max readSeq per user across their
   *  devices — cursors never regress (out-of-order device replay is harmless). */
  mergeReceipt: (
    groupId: string,
    fromUserId: string,
    readSeq: number,
    ts: number,
  ) => void;
  raiseKeyAlert: (deviceId: string, pin: Pin) => void;
  dropKeyAlert: (deviceId: string) => void;
  bumpChainVersion: () => void;
  bumpRehealVersion: () => void;

  /** Patch a message in place — top-level or (via parentId) a thread reply.
   *  Shared by the edit flow's optimistic/echo/revert paths. */
  applyMessagePatch: (
    groupId: string,
    msgId: string,
    parentId: string | null | undefined,
    patch: Partial<Message>,
  ) => void;
  /** Append an optimistic message to a conversation, creating nothing. */
  appendMessage: (groupId: string, message: Message) => void;
  /** Mark an optimistic message pending again (retry) — by id, any group. */
  markSending: (groupId: string, msgId: string) => void;
  /** Resolve an optimistic message to failed, with a reason for the UI. */
  markFailed: (clientId: string, reason?: string) => void;
  /** Merge a conversation the server just told us about. */
  upsertGroup: (group: Group, messages?: Message[]) => void;
  removeGroup: (groupId: string) => void;
};

/** Everything a view can DO through the store alone: pure state transitions and
 *  field setters. Handed to views as part of `useChatActions()`, so they never
 *  need to know which half of the API a call belongs to. */
export type ChatUiActions = ChatSetters & ChatStoreActions;

export type ChatState = ChatData & ChatUiActions;

const pushPath = (path: string) => {
  if (typeof window !== "undefined") {
    window.history.pushState(null, "", path);
  }
};

/** Every state-only overlay, cleared together. */
const CLOSED = {
  threadFor: null,
  searchOpen: false,
  composeOpen: false,
  createGroupOpen: false,
  workspaceOpen: false,
} as const;

export const useChatStore = create<ChatState>((set, get) => {
  /** A `useState`-compatible setter for one data key. */
  const setter =
    <K extends keyof ChatData>(key: K) =>
    (v: Updater<ChatData[K]>) =>
      set((s) => {
        const next =
          typeof v === "function"
            ? (v as (prev: ChatData[K]) => ChatData[K])(s[key])
            : v;
        // Hand back an empty patch when nothing moved, so an updater that
        // returns its input can't churn the state object.
        return next === s[key] ? {} : ({ [key]: next } as Pick<ChatData, K>);
      });

  return {
    groups: {},
    currentGroupId: "",
    groupOrder: [],
    dmOrder: [],
    rosterLoaded: false,
    historyCursor: {},
    unreadByGroup: {},
    typingByGroup: {},

    threadFor: null,
    groupInfoOpen: false,
    highlightMsgId: null,
    hoverMsgId: null,
    pickerOpenFor: null,
    moreOpenFor: null,
    pinnedPanelFor: null,

    composerText: "",
    composerActive: false,
    composerAttachment: null,
    threadComposerText: "",
    replyingTo: null,
    editing: null,
    drafts: {},

    groupsOpen: true,
    dmsOpen: true,
    settingsOpen: false,
    settingsTab: "general",
    backupSetupOpen: false,

    composeOpen: false,
    composeQuery: "",
    composeText: "",
    composeRecipients: [],

    searchOpen: false,
    searchQ: "",
    createGroupOpen: false,
    activePanel: null,
    chatFilter: "inbox",

    workspaceName: "Northwind Studio",
    workspaceMembers: [],
    workspaceOpen: false,

    forwardSource: null,

    profileUser: null,
    profile: {},
    statusOpen: false,

    receiptsByGroup: {},
    keyAlerts: {},
    chainVersion: 0,
    rehealVersion: 0,

    setGroups: setter("groups"),
    setCurrentGroupId: setter("currentGroupId"),
    setGroupOrder: setter("groupOrder"),
    setDmOrder: setter("dmOrder"),
    setRosterLoaded: setter("rosterLoaded"),
    setHistoryCursor: setter("historyCursor"),
    setUnreadByGroup: setter("unreadByGroup"),
    setTypingByGroup: setter("typingByGroup"),
    setThreadFor: setter("threadFor"),
    setGroupInfoOpen: setter("groupInfoOpen"),
    setHighlightMsgId: setter("highlightMsgId"),
    setHoverMsgId: setter("hoverMsgId"),
    setPickerOpenFor: setter("pickerOpenFor"),
    setMoreOpenFor: setter("moreOpenFor"),
    setPinnedPanelFor: setter("pinnedPanelFor"),
    setComposerText: setter("composerText"),
    setComposerActive: setter("composerActive"),
    setComposerAttachment: setter("composerAttachment"),
    setThreadComposerText: setter("threadComposerText"),
    setReplyingTo: setter("replyingTo"),
    setEditing: setter("editing"),
    setDrafts: setter("drafts"),
    setGroupsOpen: setter("groupsOpen"),
    setDmsOpen: setter("dmsOpen"),
    setSettingsOpen: setter("settingsOpen"),
    setSettingsTab: setter("settingsTab"),
    setBackupSetupOpen: setter("backupSetupOpen"),
    setComposeOpen: setter("composeOpen"),
    setComposeQuery: setter("composeQuery"),
    setComposeText: setter("composeText"),
    setComposeRecipients: setter("composeRecipients"),
    setSearchOpen: setter("searchOpen"),
    setSearchQ: setter("searchQ"),
    setCreateGroupOpen: setter("createGroupOpen"),
    setActivePanel: setter("activePanel"),
    setChatFilter: setter("chatFilter"),
    setWorkspaceName: setter("workspaceName"),
    setWorkspaceMembers: setter("workspaceMembers"),
    setWorkspaceOpen: setter("workspaceOpen"),
    setForwardSource: setter("forwardSource"),
    setProfileUser: setter("profileUser"),
    setProfile: setter("profile"),
    setStatusOpen: setter("statusOpen"),
    setReceiptsByGroup: setter("receiptsByGroup"),
    setKeyAlerts: setter("keyAlerts"),
    setChainVersion: setter("chainVersion"),
    setRehealVersion: setter("rehealVersion"),

    navigateTo: (id) => {
      set({ currentGroupId: id });
      pushPath(idToPath(id));
    },

    selectGroup: (id) => {
      get().navigateTo(id);
      set({ ...CLOSED, settingsOpen: false, activePanel: null });
    },

    openPanel: (p) => {
      set({ ...CLOSED, activePanel: p, settingsOpen: false });
      pushPath("/" + p);
    },
    // Closing a panel returns to the group/DM that was open underneath it.
    closePanel: () => {
      set({ activePanel: null });
      pushPath(idToPath(get().currentGroupId));
    },

    openSettings: () => {
      pushPath("/settings");
      set({ settingsOpen: true, activePanel: null, createGroupOpen: false, workspaceOpen: false });
    },
    closeSettings: () => {
      pushPath(idToPath(get().currentGroupId));
      set({ settingsOpen: false });
    },

    openCompose: () =>
      set({
        composeOpen: true,
        composeQuery: "",
        composeText: "",
        composeRecipients: [],
        activePanel: null,
        workspaceOpen: false,
      }),
    closeCompose: () => set({ composeOpen: false }),

    openCreateGroup: () =>
      set({
        createGroupOpen: true,
        settingsOpen: false,
        composeOpen: false,
        searchOpen: false,
        activePanel: null,
        workspaceOpen: false,
      }),
    closeCreateGroup: () => set({ createGroupOpen: false }),

    openWorkspace: () =>
      set({
        workspaceOpen: true,
        settingsOpen: false,
        composeOpen: false,
        searchOpen: false,
        createGroupOpen: false,
        activePanel: null,
      }),
    closeWorkspace: () => set({ workspaceOpen: false }),

    openSearch: () =>
      set({
        searchOpen: true,
        activePanel: null,
        createGroupOpen: false,
        workspaceOpen: false,
      }),
    closeSearch: () => set({ searchOpen: false }),

    openStatus: () => set({ statusOpen: true }),
    closeStatus: () => set({ statusOpen: false }),

    dismissOverlays: () =>
      set({ ...CLOSED, settingsOpen: false, pickerOpenFor: null, activePanel: null, groupInfoOpen: false }),

    openThread: (msgId) => set({ threadFor: msgId, groupInfoOpen: false }),
    closeThread: () => set({ threadFor: null }),
    // Only one right drawer at a time.
    toggleGroupInfo: () =>
      set((s) =>
        s.groupInfoOpen
          ? { groupInfoOpen: false }
          : { groupInfoOpen: true, threadFor: null },
      ),
    closeGroupInfo: () => set({ groupInfoOpen: false }),

    // One popover at a time.
    togglePicker: (msgId) =>
      set((s) => ({
        pickerOpenFor: s.pickerOpenFor === msgId ? null : msgId,
        moreOpenFor: null,
      })),
    toggleMore: (msgId) =>
      set((s) => ({
        moreOpenFor: s.moreOpenFor === msgId ? null : msgId,
        pickerOpenFor: null,
      })),
    closeMore: () => set({ moreOpenFor: null }),
    togglePinnedPanel: (groupId) =>
      set((s) => ({
        pinnedPanelFor: s.pinnedPanelFor === groupId ? null : groupId,
      })),
    clearHighlight: () => set({ highlightMsgId: null }),
    toggleGroups: () => set((s) => ({ groupsOpen: !s.groupsOpen })),
    toggleDms: () => set((s) => ({ dmsOpen: !s.dmsOpen })),

    // Reply and edit are mutually exclusive compose modes.
    startReply: (msg) => set({ replyingTo: msg, editing: null }),
    cancelReply: () => set({ replyingTo: null }),
    cancelEdit: () => set({ editing: null }),
    openForward: (msg) => set({ forwardSource: msg }),
    closeForward: () => set({ forwardSource: null }),

    addRecipient: (name) =>
      set((s) => ({
        composeRecipients: [...s.composeRecipients, name],
        composeQuery: "",
      })),
    removeRecipient: (name) =>
      set((s) => ({
        composeRecipients: s.composeRecipients.filter((x) => x !== name),
      })),

    saveDraft: (groupId, draft) =>
      set((s) => {
        // Empty draft → drop the entry so the badge/list stay accurate.
        if (!draft.text.trim()) {
          if (!(groupId in s.drafts)) return {};
          const { [groupId]: _gone, ...rest } = s.drafts;
          void _gone;
          return { drafts: rest };
        }
        const cur = s.drafts[groupId];
        if (cur && cur.text === draft.text && cur.rich === draft.rich) return {};
        return { drafts: { ...s.drafts, [groupId]: draft } };
      }),
    clearDraft: (groupId) =>
      set((s) => {
        if (!(groupId in s.drafts)) return {};
        const { [groupId]: _gone, ...rest } = s.drafts;
        void _gone;
        return { drafts: rest };
      }),

    mergeReceipt: (groupId, fromUserId, readSeq, ts) =>
      set((s) => {
        const ch = s.receiptsByGroup[groupId] ?? {};
        const cur = ch[fromUserId];
        if (cur && cur.readSeq >= readSeq) return {};
        return {
          receiptsByGroup: {
            ...s.receiptsByGroup,
            [groupId]: { ...ch, [fromUserId]: { readSeq, ts } },
          },
        };
      }),
    raiseKeyAlert: (deviceId, pin) =>
      set((s) => ({ keyAlerts: { ...s.keyAlerts, [deviceId]: pin } })),
    dropKeyAlert: (deviceId) =>
      set((s) => {
        if (!(deviceId in s.keyAlerts)) return {};
        const { [deviceId]: _gone, ...rest } = s.keyAlerts;
        void _gone;
        return { keyAlerts: rest };
      }),
    bumpChainVersion: () => set((s) => ({ chainVersion: s.chainVersion + 1 })),
    bumpRehealVersion: () => set((s) => ({ rehealVersion: s.rehealVersion + 1 })),

    applyMessagePatch: (groupId, msgId, parentId, patch) =>
      set((s) => {
        const ch = s.groups[groupId];
        if (!ch) return {};
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
        return { groups: { ...s.groups, [groupId]: { ...ch, messages } } };
      }),

    appendMessage: (groupId, message) =>
      set((s) => {
        const ch = s.groups[groupId];
        if (!ch) return {};
        return {
          groups: {
            ...s.groups,
            [groupId]: { ...ch, messages: [...ch.messages, message] },
          },
        };
      }),

    markSending: (groupId, msgId) =>
      set((s) => {
        const ch = s.groups[groupId];
        if (!ch) return {};
        return {
          groups: {
            ...s.groups,
            [groupId]: {
              ...ch,
              messages: ch.messages.map((m) =>
                m.id === msgId ? { ...m, pending: true, failed: false } : m,
              ),
            },
          },
        };
      }),

    // Default-E2EE: we never fall back to plaintext, so a send that can't be
    // encrypted fails here (with retry) instead of leaking. The clientId is
    // searched across groups because the caller doesn't always know the group.
    markFailed: (clientId, reason) =>
      set((s) => {
        for (const id of Object.keys(s.groups)) {
          const idx = s.groups[id].messages.findIndex((m) => m.id === clientId);
          if (idx < 0) continue;
          const m = s.groups[id].messages[idx];
          if (reason === undefined && !m.pending) return {}; // already resolved
          const messages = [...s.groups[id].messages];
          messages[idx] = {
            ...m,
            pending: false,
            failed: true,
            ...(reason ? { failReason: reason } : {}),
          };
          return { groups: { ...s.groups, [id]: { ...s.groups[id], messages } } };
        }
        return {};
      }),

    upsertGroup: (group, messages) =>
      set((s) => {
        const existing = s.groups[group.id];
        if (existing && !messages) return {};
        return {
          groups: {
            ...s.groups,
            [group.id]: {
              ...group,
              messages: messages ?? existing?.messages ?? group.messages ?? [],
            },
          },
        };
      }),

    removeGroup: (groupId) =>
      set((s) => {
        if (!s.groups[groupId]) return {};
        const { [groupId]: _gone, ...rest } = s.groups;
        void _gone;
        return { groups: rest };
      }),
  };
});

/** Read the store outside React (logic hooks, socket handlers, timers). */
export const chat = () => useChatStore.getState();

/**
 * The store's own actions and setters. They're created once with the store, so
 * this neither subscribes nor changes identity — which is why the provider can
 * fold them into the stable actions context.
 */
export const uiActions = (): ChatUiActions => useChatStore.getState();
