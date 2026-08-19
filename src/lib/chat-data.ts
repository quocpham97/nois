export type Presence = "active" | "idle" | "offline";

export type User = {
  /**
   * Stable identity key (the session uid — a seeded handshake key like "sarah"
   * or a real user's email). This is what the server routes DMs by and what
   * E2EE key bundles are published under, so it must travel with every User
   * rather than being guessed back from the display name.
   */
  id?: string;
  name: string;
  initials: string;
  bg: string;
  /** Optional uploaded avatar (data URL); falls back to initials when absent. */
  avatar?: string;
};

export type Reaction = {
  e: string;
  n: number;
  mine?: boolean;
};

/**
 * Sender-generated link preview. Travels ONLY inside the E2EE envelope (part of
 * the encrypted content, never a top-level wire field), so recipients render it
 * with zero network activity and the server never sees the URL.
 */
export type LinkPreview = {
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  /** Downscaled thumbnail as a data: URI, capped small enough to ride in the envelope. */
  image?: string;
};

export type Attachment = {
  kind: "image" | "file" | "video" | "audio";
  name: string;
  size: string;
  label: string;
  /** UploadThing CDN URL for the uploaded file (absent on legacy placeholders).
   *  For `video`, this is the HLS master-playlist URL (/api/hls/<id>/master.m3u8). */
  url?: string;
  /** Original content type, e.g. "image/png", "application/pdf". */
  mime?: string;
  /** Natural pixel dimensions (images + video) — used to reserve layout (avoid CLS). */
  width?: number;
  height?: number;
  /** Video only: poster-frame URL and duration in seconds. */
  poster?: string;
  duration?: number;
  /** Audio only: ~48 normalized (0–1) amplitude buckets for the waveform bar.
   *  Travels on the wire attachment like width/height/name do — the same
   *  accepted metadata class (the audio CONTENT stays E2EE ciphertext). */
  peaks?: number[];
  /** When true, `url` points at AES-GCM ciphertext — fetch via the proxy and
   *  decrypt with key/iv before display (see crypto/attachment.ts). */
  encrypted?: boolean;
  /** Base64 AES-256-GCM key + iv. CLIENT-ONLY: stripped from the wire when the
   *  message envelope carries them; present on the wire only in the no-keys
   *  plaintext fallback. Locally persisted so reloads can re-decrypt. */
  key?: string;
  iv?: string;
};

/**
 * Compact snapshot of the message a reply quotes. Travels INSIDE the E2EE
 * envelope (part of the encrypted content, never a top-level wire field), so
 * the quoted stub renders with zero extra fetches and the server never sees
 * it. `authorId` lets the viewer's own quoted messages render as "You".
 */
export type ReplyRef = {
  /** id of the quoted message — used to scroll/flash to it when the stub is tapped. */
  msgId: string;
  /** Display name of the quoted message's author. */
  author: string;
  /** The author's identity key, so the viewer's own messages show "You". */
  authorId?: string;
  /** One-line excerpt (an emoji tag like "📷 Photo" for attachment-only messages). */
  text: string;
};

/**
 * A finished call, recorded in the thread as a message (Messenger-style).
 *
 * The STARTER owns the record: whoever placed the call seals one of these into a
 * normal E2EE message when the call ends for them, so everyone in the
 * conversation (and every device of theirs) gets the same row through the
 * ordinary message path — no server-side call log, and nothing to reconstruct
 * after a reload. In a group that means the row describes the call as the starter
 * experienced it: if they leave while others carry on, the row stops there.
 *
 * `status` is stored from the caller's point of view; `callEventTitle` maps it to
 * the viewer's wording ("No answer" for the caller, "Missed voice call" for the
 * side that didn't pick up).
 */
export type CallEvent = {
  mode: "voice" | "video";
  /** answered = media connected; declined = the callee said no; unanswered =
   *  rang out, was cancelled, or the callee was busy on another call. */
  status: "answered" | "declined" | "unanswered";
  /** Talk time as "m:ss"/"h:mm:ss" — answered calls only. */
  duration?: string;
  /** Group calls: peak simultaneous participants ("4 on the call"). Absent for
   *  a DM, where "2 on the call" says nothing. */
  joined?: number;
};

/** Viewer-relative title for a call row. `mine` = the viewer placed the call. */
export function callEventTitle(call: CallEvent, mine?: boolean): string {
  const video = call.mode === "video";
  if (call.status === "answered") return video ? "Video call" : "Voice call";
  if (call.status === "declined")
    return video ? "Video call declined" : "Call declined";
  // Unanswered reads differently on each side: the caller got no answer, the
  // other side missed it.
  if (mine) return "No answer";
  return video ? "Missed video call" : "Missed voice call";
}

/** Talk time from a call's elapsed seconds: "0:42", "11:42", "1:02:07". */
export function formatCallDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  const hh = Math.floor(s / 3600);
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

export type Message = {
  id: string;
  /**
   * Server-assigned, per-group monotonic sequence for top-level messages.
   * Drives ordering and IndexedDB pagination on the client. Absent on
   * optimistic (not-yet-acked) messages and on thread replies.
   */
  seq?: number;
  author: User;
  time: string;
  /**
   * Epoch-ms creation timestamp. Unlike `time` (a pre-formatted display string),
   * this lets the client decide whether to show just the time (today) or the
   * date too (older). Stamped by the server (and optimistically on send).
   */
  ts?: number;
  date?: string;
  text: string;
  sameAuthor?: boolean;
  self?: boolean;
  mentions?: string[];
  reactions?: Reaction[];
  attachment?: Attachment;
  threadCount?: number;
  threadParticipants?: User[];
  threadLastTime?: string;
  threadReplies?: Message[];
  /** Optimistic message awaiting server ack (not yet confirmed). */
  pending?: boolean;
  /** Optimistic message that timed out before ack — offer a retry. */
  failed?: boolean;
  /** Why a message failed (e.g. couldn't be end-to-end encrypted), for the UI. */
  failReason?: string;
  /** Lexical editor-state JSON (rich-text messages); `text` is the plaintext. */
  rich?: string;
  /** Soft-deleted: render a "This message was deleted." tombstone in place. */
  deleted?: boolean;
  /** Body was edited after sending. `editedTs` (epoch-ms, server-stamped)
   *  orders concurrent edits and drives the "(edited)" tooltip. */
  edited?: boolean;
  editedTs?: number;
  /** Sender-generated link preview, decrypted from the envelope (see LinkPreview). */
  preview?: LinkPreview;
  /**
   * E2EE envelope (JSON) when the message is end-to-end encrypted. The server
   * stores and relays this opaquely; `text`/`rich` are empty on the wire and
   * filled in only after the recipient client decrypts locally. See
   * crypto/session.ts.
   */
  enc?: string;
  /** Client-only: an encrypted message this device could not decrypt. */
  locked?: boolean;
  /** Quoted-reply reference — renders a tappable stub atop the bubble. Rides
   *  the E2EE envelope (see ReplyRef). */
  replyTo?: ReplyRef;
  /** True when this message was forwarded from another conversation (shows a
   *  "Forwarded" marker above the bubble). */
  forwarded?: boolean;
  /**
   * Client-only: not a real message but the sidebar's cached last-line preview,
   * rebuilt from the roster cache on boot so the conversation list paints before
   * the socket connects. It carries only an id, a preview string and a stub
   * author — never a body — so it must never render in a thread, and the real
   * message (same id) always supersedes it.
   */
  snapshot?: boolean;
  /** Call event (a finished voice/video call) — renders as a call card instead
   *  of a bubble. Rides the E2EE envelope like every other body field, so the
   *  server never learns that a call happened, let alone how long it ran. */
  call?: CallEvent;
};

export type Pinned = {
  id: string;
  author: User;
  text: string;
};

export type Group = {
  id: string;
  /** The two conversation kinds. A DM is a 1:1; everything else is a group
   *  (formerly "group"). This field — not the id — is the sole discriminator. */
  type: "group" | "dm";
  name: string;
  icon?: "hash" | "lock" | "megaphone";
  topic?: string;
  members?: number;
  /** Authoritative member roster from the server (resolved Users). */
  memberList?: User[];
  readonly?: boolean;
  private?: boolean;
  user?: User;
  presence?: Presence;
  /**
   * Pinned message ids (server holds only references, never content). The
   * client resolves each id to a `Pinned` snippet from its local IndexedDB.
   */
  pinIds?: string[];
  /** This conversation's chat color (a CHAT_GRADIENTS key), shared by every
   *  member. null/unset means "use the viewer's own default chat color". Sent as
   *  an explicit null when cleared: the client merges group meta by spreading,
   *  and an absent key can't unset a previous value. */
  bubbleTheme?: string | null;
  pinned: Pinned[];
  messages: Message[];
};

/** Up-to-two-letter initials from a display string. */
export function initialsOf(s: string, fallback = "?"): string {
  return (
    s
      .split(/[\s@.]+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || fallback
  );
}

/**
 * Resolve an identity (handshake/session id) to a User. Profiles are derived
 * deterministically from the id + display name, so every user renders with
 * stable initials and colour (e.g. a Google login keyed by email).
 */
export function deriveUser(id: string, name?: string): User {
  const display = (name && name.trim()) || id;
  const initials = initialsOf(display, id.slice(0, 2).toUpperCase());
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { id, name: display, initials, bg: `oklch(0.58 0.16 ${h})` };
}

/** Editable, per-user profile shown in Preferences → Profile. */
export type UserProfile = {
  fullName?: string;
  displayName?: string;
  title?: string;
  pronouns?: string;
  timezone?: string;
  /** Uploaded avatar as a data URL. */
  avatar?: string;
  /** Custom status (emoji + short text). */
  statusEmoji?: string;
  statusText?: string;
  /** Chat color (sent-bubble gradient) — a key of CHAT_GRADIENTS. */
  bubbleTheme?: string;
  /** Quick emoji sent by the composer's Like button. */
  likeEmoji?: string;
  /** Archived conversation (group/DM) ids. */
  archived?: string[];
  /**
   * Link previews are OPT-IN: generating one makes the sender's browser fetch
   * the URL through the same-origin unfurl proxy, so the server learns "this
   * user fetched this URL once" (never which message carries it — the preview
   * itself travels E2EE). undefined = never asked (composer shows a one-tap
   * prompt when a URL is first typed); false = declined.
   */
  linkPreviews?: boolean;
  /** Push-notification preferences. Server-visible so the send hook can honor
   *  them (unlike message content, which it can't read). */
  notif?: NotifPrefs;
};

/** Push preferences. `level`: 0=all, 1=direct messages & mentions, 2=none.
 *  E2EE caveat: the server can't detect mentions in encrypted group groups,
 *  so at level 1 it pushes DMs only (documented in the settings copy). */
export type NotifPrefs = {
  level: 0 | 1 | 2;
  sound: boolean;
  /** Quiet hours 10pm–7am (server-enforced for push). */
  dnd: boolean;
};

// Messenger-style chat colors: the sent-bubble gradient (also used for the
// send button and app logo via the --sent-grad CSS variable).
export const CHAT_GRADIENTS: Record<string, string> = {
  default: "linear-gradient(150deg, #14A3FF 0%, #2E7BFF 55%, #6A5CFF 100%)",
  sunset: "linear-gradient(150deg, #FF8A3D 0%, #FF5E7E 55%, #C13AE8 100%)",
  forest: "linear-gradient(150deg, #29C56F 0%, #12A594 60%, #0E8FB0 100%)",
  grape: "linear-gradient(150deg, #A45CFF 0%, #7B5CFF 55%, #4A6BFF 100%)",
  mono: "linear-gradient(150deg, #545458 0%, #3A3A3E 100%)",
};

export function gradientFor(theme?: string): string {
  return CHAT_GRADIENTS[theme ?? "default"] ?? CHAT_GRADIENTS.default;
}

/** Quick-emoji choices offered in Customize chat. */
export const QUICK_EMOJI = ["👍", "❤️", "😂", "🔥", "🎉", "☕"];

export type GroupMap = Record<string, Group>;

/**
 * A conversation WITHOUT its message list — what a header, banner or avatar
 * actually needs. Views take this so they don't re-render on every new message
 * (see stores/chat-selectors `useGroupMeta`). `Group` is assignable to it.
 */
export type GroupMeta = Omit<Group, "messages"> & { messages?: Message[] };

export type Workspace = {
  name: string;
  initials: string;
  bg: string;
  fg: string;
  active: boolean;
};

export function presenceColor(p?: Presence): string {
  if (p === "active") return "var(--app-green)";
  if (p === "idle") return "var(--app-yellow)";
  return "var(--app-faint)";
}

export function presenceLabel(p?: Presence): string {
  if (p === "active") return "Active now";
  if (p === "idle") return "Away";
  return "Offline";
}

/**
 * The members we can actually see in a group: everyone who has posted in the
 * loaded history, plus the viewer (and the partner for a DM). Public groups
 * aren't membership-tracked server-side, so this is the truthful participant
 * set — shared by the header avatars and the group-info panel so they match.
 */
export function groupMembers(ch: GroupMeta, me: User): User[] {
  // Prefer the server's authoritative roster; fall back to participants seen in
  // loaded history (e.g. before the roster has arrived, or optimistic state) —
  // which a meta-only caller simply doesn't have.
  if (ch.memberList) return ch.memberList;
  const byName = new Map<string, User>();
  byName.set(me.name, me);
  for (const m of ch.messages ?? []) byName.set(m.author.name, m.author);
  if (ch.type === "dm" && ch.user) byName.set(ch.user.name, ch.user);
  return [...byName.values()];
}

/**
 * One-line preview of a message, used by quoted replies and the forward
 * picker. Prefers the text; falls back to an emoji-tagged attachment label so
 * an attachment-only message still reads as something ("📷 Photo").
 */
export function messageExcerpt(m: {
  text?: string;
  attachment?: Attachment;
  call?: CallEvent;
  self?: boolean;
}): string {
  if (m.call) return "📞 " + callEventTitle(m.call, m.self);
  const t = m.text?.trim();
  if (t) return t;
  const a = m.attachment;
  if (!a) return "";
  if (a.kind === "image") return "📷 Photo";
  if (a.kind === "video") return "🎥 Video";
  if (a.kind === "audio") return "🎤 Voice message";
  return "📎 " + a.name;
}

function clockTime(d: Date): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

export function nowTime(): string {
  return clockTime(new Date());
}

/**
 * Display string for a message timestamp: just the clock time when the message
 * is from today, or a date prefix (e.g. "Jun 25, 3:19 PM", with the year when
 * it isn't the current one) when it's from a previous day.
 */
export function formatMsgTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = clockTime(d);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${time}`;
}
