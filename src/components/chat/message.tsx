"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  Download,
  Forward,
  ImageIcon,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  Reply,
  Smile,
  Trash2,
} from "lucide-react";
import type { Attachment, Message as Msg, ReplyRef } from "@/lib/chat-data";
import { formatMsgTime } from "@/lib/chat-data";
import { decryptToBlob } from "@/lib/crypto/attachment";
import { renderRichText } from "@/lib/rich-text";
import { EmojiPickerPopup } from "./emoji-picker";
import { richToHtml } from "@/lib/lexical-render";
import { useChat } from "./chat-context";
import { Avatar } from "./bits";
import { AudioPlayer } from "./audio-player";
import { VideoPlayer } from "./video-player";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  createPopoverHandle,
} from "@/components/ui/popover";

// Emoji sequence matcher (built from explicit escapes so the source carries no
// invisible characters): a base pictographic followed by any of VS16 (U+FE0F),
// a skin-tone modifier, or ZWJ (U+200D)-joined parts; OR a flag (regional-
// indicator pair); OR a keycap (digit/#/* + optional VS16 + U+20E3); OR
// whitespace.
const EMOJI_SEQ = new RegExp(
  "\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier}|\\u200D\\p{Extended_Pictographic}\\uFE0F?)*" +
    "|[\\u{1F1E6}-\\u{1F1FF}]{2}" +
    "|[0-9#*]\\uFE0F?\\u20E3" +
    "|\\s+",
  "gu",
);

/**
 * True when a message's text is nothing but emoji (and whitespace) — those get
 * rendered larger ("jumbo"), like Slack/iMessage.
 */
function isEmojiOnly(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  // Require a real emoji (digits/whitespace alone must not count as "jumbo").
  if (!/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(s)) return false;
  return s.replace(EMOJI_SEQ, "").length === 0;
}

// Fetch an encrypted attachment's ciphertext (via the same-origin proxy, since
// the CDN sends no CORS headers) and decrypt it to a Blob.
async function fetchAndDecrypt(a: Attachment): Promise<Blob> {
  const res = await fetch("/api/attachment?u=" + encodeURIComponent(a.url!));
  if (!res.ok) throw new Error("proxy fetch failed");
  return decryptToBlob(await res.arrayBuffer(), a.key!, a.iv!, a.mime);
}

const fileExt = (a: Attachment) =>
  (a.label || a.name.split(".").pop() || "FILE").slice(0, 4).toUpperCase();

const FileCard = ({
  a,
  onClick,
  href,
}: {
  a: Attachment;
  onClick?: () => void;
  href?: string;
}) => {
  const body = (
    <>
      <div
        className="flex h-11 w-9 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
        style={{ background: "oklch(0.55 0.18 25)" }}
      >
        {fileExt(a)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{a.name}</div>
        <div className="text-[12px] text-app-muted">{a.size}</div>
      </div>
      {(onClick || href) && (
        <Download size={15} strokeWidth={1.8} className="shrink-0 text-app-muted" />
      )}
    </>
  );
  const cls =
    "mt-1.5 flex max-w-[380px] items-center gap-3 rounded-2xl border border-app-border bg-panel-2 p-2.5 text-left" +
    (onClick || href ? " hover:bg-panel-hover" : "");
  if (href)
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" download className={cls}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button onClick={onClick} className={cls}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
};

// Decrypt an encrypted image attachment to an object URL once its key is
// available (it arrives via the message envelope's decryption). Shared with
// the details pane's media grid. Keyed on the ciphertext+key primitives (not
// the whole `a`, whose identity changes per render) so we decrypt once.
export function useDecryptedImage(a: Attachment): {
  src: string | null;
  failed: boolean;
  ready: boolean;
} {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { url, key, iv, mime } = a;
  const ready = !!(url && key && iv);
  useEffect(() => {
    if (!url || !key || !iv) return;
    let obj: string | null = null;
    let cancelled = false;
    fetch("/api/attachment?u=" + encodeURIComponent(url))
      .then((r) => {
        if (!r.ok) throw new Error("proxy fetch failed");
        return r.arrayBuffer();
      })
      .then((buf) => decryptToBlob(buf, key, iv, mime))
      .then((blob) => {
        if (cancelled) return;
        obj = URL.createObjectURL(blob);
        setSrc(obj);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [url, key, iv, mime]);
  return { src, failed, ready };
}

// Encrypted image: shows a locked placeholder until the key arrives, or on a
// decrypt/fetch failure.
function AttachmentImage({ a }: { a: Attachment }) {
  const { src, failed, ready } = useDecryptedImage(a);
  const ratio = a.width && a.height ? `${a.width} / ${a.height}` : undefined;
  if (src) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 block w-fit max-w-[420px] overflow-hidden rounded-2xl border border-app-border bg-panel-2"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={a.name}
          className="block max-h-[320px] max-w-full object-contain"
          style={ratio ? { aspectRatio: ratio } : undefined}
        />
      </a>
    );
  }
  // Locked (no key yet) or decrypting/failed — reserve the image's space.
  return (
    <div
      className="mt-1.5 flex max-w-[420px] items-center justify-center rounded-2xl border border-app-border bg-panel-2 text-app-muted"
      style={{ width: a.width ? Math.min(a.width, 420) : 240, aspectRatio: ratio ?? "16 / 10" }}
    >
      <span className="flex items-center gap-1.5 text-[12px]">
        <Lock size={13} strokeWidth={1.8} />
        {failed ? "Unable to decrypt" : ready ? "Decrypting…" : "Encrypted image"}
      </span>
    </div>
  );
}

// Encrypted non-image file: decrypt on click, then trigger a download.
function EncryptedFileCard({ a }: { a: Attachment }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy || !a.key || !a.iv) return;
    setBusy(true);
    try {
      const blob = await fetchAndDecrypt(a);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore — could surface an error toast
    } finally {
      setBusy(false);
    }
  };
  return <FileCard a={a} onClick={download} />;
}

/**
 * Link preview card, rendered ENTIRELY from data decrypted out of the message
 * envelope — title/description/site plus a small inlined data-URI thumbnail.
 * Zero network activity on render (recipients never fetch the URL).
 */
function LinkPreviewCard({ p }: { p: NonNullable<Msg["preview"]> }) {
  let host = "";
  try {
    host = new URL(p.url).hostname.replace(/^www\./, "");
  } catch {
    return null; // malformed sender data — render nothing rather than a bad link
  }
  return (
    <a
      href={p.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex max-w-[380px] items-stretch gap-3 overflow-hidden rounded-2xl border border-app-border bg-panel-2 p-2.5 hover:bg-panel-hover"
    >
      {p.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.image}
          alt=""
          className="h-14 w-14 shrink-0 rounded-lg object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] uppercase tracking-[0.03em] text-app-faint">
          {p.siteName || host}
        </div>
        <div className="line-clamp-1 text-[13.5px] font-semibold text-app-text">
          {p.title}
        </div>
        {p.description && (
          <div className="line-clamp-2 text-[12.5px] leading-[1.35] text-app-muted">
            {p.description}
          </div>
        )}
      </div>
    </a>
  );
}

/** Muted "(edited)" marker inside the bubble; tooltip shows when it was edited. */
function EditedTag({ ts }: { ts?: number }) {
  return (
    <span
      className="ml-1.5 text-[11px] italic opacity-60"
      title={ts ? `Edited ${formatMsgTime(ts)}` : "Edited"}
    >
      (edited)
    </span>
  );
}

/**
 * Quoted-reply stub. Two placements:
 *  - `inBubble`: rendered at the top of a text bubble, separated by a divider
 *    (white-translucent on the sender's gradient bubble, border on received).
 *  - standalone: a small card above an attachment-only reply (no text bubble to
 *    live inside).
 * Tappable when the quoted message still has an id to scroll to.
 */
function ReplyQuote({
  r,
  me,
  isOwnOriginal,
  inBubble,
  onJump,
}: {
  r: ReplyRef;
  me?: boolean;
  isOwnOriginal: boolean;
  inBubble: boolean;
  onJump?: () => void;
}) {
  const label = isOwnOriginal ? "You" : r.author.split(" ")[0];
  return (
    <button
      type="button"
      onClick={onJump}
      className={
        inBubble
          ? "mb-1.5 block w-full border-b pb-1.5 text-left"
          : "mb-1 block max-w-[420px] rounded-xl border border-app-border bg-panel-2 px-3 py-1.5 text-left hover:bg-panel-hover"
      }
      style={
        inBubble
          ? {
              borderColor: me ? "rgba(255,255,255,0.28)" : "var(--app-border)",
              opacity: 0.9,
              cursor: "pointer",
            }
          : undefined
      }
    >
      <div className="text-[12.5px] font-semibold leading-tight">
        ↩ {label}
      </div>
      <div
        className="truncate text-[12.5px] leading-tight"
        style={{ maxWidth: 240, opacity: inBubble ? 0.95 : 0.75 }}
      >
        {r.text}
      </div>
    </button>
  );
}

function AttachmentBlock({ a }: { a: Attachment }) {
  if (a.kind === "audio" && a.url) return <AudioPlayer a={a} />;
  if (a.kind === "video" && a.url) return <VideoPlayer a={a} />;
  if (a.kind === "image") {
    if (a.encrypted) return <AttachmentImage a={a} />;
    // Plaintext (legacy) image — click to open the original in a new tab.
    if (a.url) {
      const ratio = a.width && a.height ? `${a.width} / ${a.height}` : undefined;
      return (
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 block w-fit max-w-[420px] overflow-hidden rounded-2xl border border-app-border bg-panel-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={a.url}
            alt={a.name}
            loading="lazy"
            className="block max-h-[320px] max-w-full object-contain"
            style={ratio ? { aspectRatio: ratio } : undefined}
          />
        </a>
      );
    }
    // No url (optimistic/legacy) — striped placeholder with the filename.
    return (
      <div className="mt-1.5 max-w-[420px] overflow-hidden rounded-2xl border border-app-border bg-panel-2">
        <div
          className="flex items-center justify-center"
          style={{
            aspectRatio: "16 / 10",
            background:
              "repeating-linear-gradient(45deg, var(--panel) 0 10px, var(--panel-hover) 10px 20px)",
          }}
        >
          <div className="rounded border border-app-border bg-app-bg px-2.5 py-1 font-mono text-[11px] text-app-muted">
            {a.label || "image preview"}
          </div>
        </div>
        <div className="flex items-center gap-2.5 border-t border-app-border px-3 py-2">
          <ImageIcon size={14} strokeWidth={1.8} className="text-app-muted" />
          <span className="text-[13px] font-medium">{a.name}</span>
          <span className="text-[12px] text-app-faint">{a.size}</span>
        </div>
      </div>
    );
  }
  // Non-image file: encrypted → decrypt-on-click download; plaintext → direct link.
  if (a.encrypted && a.url) return <EncryptedFileCard a={a} />;
  return <FileCard a={a} href={a.url} />;
}

export function Message({ msg }: { msg: Msg }) {
  const {
    hoverMsgId,
    setHoverMsgId,
    pickerOpenFor,
    togglePicker,
    toggleReaction,
    retrySend,
    currentGroupId,
    groups,
    togglePin,
    highlightMsgId,
    deleteMessage,
    startEdit,
    seenByMsgId,
    openForward,
    startReply,
    jumpToMessage,
    myUser,
    moreOpenFor,
    toggleMore,
    closeMore,
  } = useChat();

  const me = msg.self;
  const seenBy = seenByMsgId[msg.id] ?? [];
  const highlighted = highlightMsgId === msg.id;
  // Emoji picker / "More" menu state lives in context so only one is open at a
  // time. Both are rendered with the shadcn Popover, which handles outside-click
  // dismissal, Escape, and auto-flipping when near the viewport edge.
  const pickerOpen = pickerOpenFor === msg.id;
  const moreOpen = moreOpenFor === msg.id;
  // The emoji picker has two triggers (the toolbar button and the reaction-bar
  // "+"), so it uses a detached handle to bind both to the same popover.
  const pickerHandle = useMemo(() => createPopoverHandle(), []);

  const isPinned = (groups[currentGroupId]?.pinned || []).some(
    (p) => p.id === msg.id,
  );
  const grouped = msg.sameAuthor;
  const hovered = hoverMsgId === msg.id;
  // Emoji-only messages render larger ("jumbo"), like Slack/iMessage.
  const jumbo = isEmojiOnly(msg.text);
  // Still-encrypted with no plaintext yet (key in flight / decrypt running) —
  // show a loading state instead of a blank body. Once it resolves, `enc` is
  // cleared and `text` is either the plaintext or a 🔒 locked notice. An
  // encrypted attachment shows its own placeholder, so skip the body indicator.
  const decrypting = !!msg.enc && !msg.text && !msg.attachment;
  // Keep the hover toolbar (which hosts the popover triggers) mounted while a
  // popover is open, even after the pointer leaves the message row.
  const showToolbar = hovered || pickerOpen || moreOpen;

  // Tombstone for soft-deleted messages — no content/actions.
  if (msg.deleted) {
    return (
      <div data-mid={msg.id} className="flex items-center gap-3 px-4 py-1.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-panel text-app-muted">
          <Trash2 size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <div className="text-[13.5px] italic text-app-muted">
            This message was deleted.
          </div>
        </div>
      </div>
    );
  }

  const isDmGroup = groups[currentGroupId]?.type === "dm";
  const showName = !me && !isDmGroup && !grouped;
  const timeLabel = msg.ts ? formatMsgTime(msg.ts) : msg.time;
  // Messenger-style corner grouping: within a run of same-author messages the
  // corner facing the previous bubble is tightened.
  const bubbleRadius = me
    ? `18px ${grouped ? "6px" : "18px"} 18px 18px`
    : `${grouped ? "6px" : "18px"} 18px 18px 18px`;

  const circleBtn =
    "flex size-8 items-center justify-center rounded-full text-app-muted hover:bg-app-hover hover:text-app-text";

  // A quoted reply whose original author is the viewer renders as "You".
  const isOwnOriginal =
    !!msg.replyTo?.authorId && msg.replyTo.authorId === myUser.id;
  const jumpToReply = () => {
    if (msg.replyTo) jumpToMessage(currentGroupId, msg.replyTo.msgId);
  };
  // In-bubble quote only fits a real text bubble; jumbo/attachment-only replies
  // show a standalone card above the content instead.
  const quoteInBubble = !!msg.replyTo && !!msg.text.trim() && !jumbo;

  return (
    <div
      data-mid={msg.id}
      onMouseEnter={() => setHoverMsgId(msg.id)}
      onMouseLeave={() => setHoverMsgId(null)}
      className={`relative flex items-end gap-2 ${me ? "flex-row-reverse" : ""}`}
      style={{
        padding: grouped ? "1px 16px" : "10px 16px 1px",
        paddingBottom:
          msg.reactions && msg.reactions.length > 0 ? 14 : undefined,
        background: highlighted ? "var(--app-accent-soft)" : "transparent",
        transition: "background 0.4s ease",
      }}
    >
      {/* avatar gutter (incoming only; avatar on the first message of a run) */}
      {!me && (
        <div className="w-7 shrink-0">
          {!grouped && (
            <Avatar
              initials={msg.author.initials}
              bg={msg.author.bg}
              src={msg.author.avatar}
              size={28}
              radius={999}
            />
          )}
        </div>
      )}

      {/* bubble column */}
      <div
        className={`flex min-w-0 flex-col ${me ? "items-end" : "items-start"}`}
        style={{ maxWidth: "min(560px, 72%)", opacity: msg.pending ? 0.55 : 1 }}
      >
        {showName && (
          <div className="mb-0.5 ml-3 text-[12px] font-semibold text-app-muted">
            {msg.author.name.split(" ")[0]}
          </div>
        )}

        {/* forwarded marker — faint italic, above the bubble */}
        {msg.forwarded && (
          <div
            className={`mb-0.5 flex items-center gap-1.5 text-[11.5px] italic text-app-faint ${
              me ? "mr-1" : "ml-1"
            }`}
          >
            <Forward size={12} strokeWidth={2} />
            Forwarded
          </div>
        )}

        <div className="relative">
          {/* standalone quote for jumbo / attachment-only replies */}
          {msg.replyTo && !decrypting && !quoteInBubble && (
            <ReplyQuote
              r={msg.replyTo}
              me={me}
              isOwnOriginal={isOwnOriginal}
              inBubble={false}
              onJump={jumpToReply}
            />
          )}
          {decrypting ? (
            <div
              className="flex items-center gap-1.5 bg-recv-bubble px-[13px] py-2 text-[14px] text-app-muted"
              style={{ borderRadius: bubbleRadius }}
            >
              <Lock
                size={13}
                strokeWidth={1.8}
                className="shrink-0 animate-pulse"
              />
              <span className="animate-pulse">Decrypting…</span>
            </div>
          ) : jumbo ? (
            <div className="px-0.5 text-[40px] leading-[1.15]" title={timeLabel}>
              {msg.rich ? (
                <div
                  className="rich-msg break-words"
                  dangerouslySetInnerHTML={{ __html: richToHtml(msg.rich) }}
                />
              ) : (
                renderRichText(msg.text, { mentions: msg.mentions })
              )}
              {msg.edited && <EditedTag ts={msg.editedTs} />}
            </div>
          ) : msg.text.trim() ? (
            <div
              title={timeLabel}
              className={`px-[13px] py-2 text-[15px] leading-[1.4] break-words ${
                me ? "bubble-sent sent-grad" : "bg-recv-bubble text-recv-text"
              }`}
              style={{ borderRadius: bubbleRadius, wordBreak: "break-word" }}
            >
              {msg.replyTo && quoteInBubble && (
                <ReplyQuote
                  r={msg.replyTo}
                  me={me}
                  isOwnOriginal={isOwnOriginal}
                  inBubble
                  onJump={jumpToReply}
                />
              )}
              {msg.rich ? (
                <div
                  className="rich-msg break-words"
                  dangerouslySetInnerHTML={{ __html: richToHtml(msg.rich) }}
                />
              ) : (
                renderRichText(msg.text, { mentions: msg.mentions })
              )}
              {msg.edited && <EditedTag ts={msg.editedTs} />}
            </div>
          ) : null}

          {msg.preview && <LinkPreviewCard p={msg.preview} />}

          {msg.attachment && <AttachmentBlock a={msg.attachment} />}

          {/* reactions — overlapping badge at the bubble's bottom corner */}
          {msg.reactions && msg.reactions.length > 0 && (
            <div
              className={`animate-pop absolute -bottom-3 z-[2] flex items-center gap-0.5 rounded-full border border-app-border bg-panel-2 px-1 py-0.5 shadow-[var(--app-shadow-sm)] ${
                me ? "right-2" : "left-2"
              }`}
            >
              {msg.reactions.map((r) => (
                <button
                  key={r.e}
                  onClick={() => toggleReaction(msg.id, r.e)}
                  title={`${r.n}`}
                  className="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-[12px] font-semibold leading-none hover:bg-panel-hover"
                  style={{
                    color: r.mine ? "var(--app-accent)" : "var(--app-muted)",
                  }}
                >
                  <span className="text-[13px] leading-none">{r.e}</span>
                  {r.n > 1 && r.n}
                </button>
              ))}
            </div>
          )}

          {/* hover tools — beside the bubble, Messenger-style */}
          {showToolbar && (
            <div
              className={`absolute top-1/2 z-[5] flex -translate-y-1/2 items-center gap-0.5 whitespace-nowrap ${
                me ? "right-full mr-1.5" : "left-full ml-1.5"
              }`}
            >
              <PopoverTrigger
                handle={pickerHandle}
                title="React"
                className={circleBtn}
              >
                <Smile size={16} strokeWidth={1.8} />
              </PopoverTrigger>
              <button
                title="Reply"
                onClick={() => startReply(msg)}
                className={circleBtn}
              >
                <Reply size={16} strokeWidth={1.8} />
              </button>
              <button
                title="Forward"
                onClick={() => openForward(msg)}
                className={circleBtn}
              >
                <Forward size={16} strokeWidth={1.8} />
              </button>
              <Popover
                open={moreOpen}
                onOpenChange={(open) => {
                  if (open !== moreOpen) toggleMore(msg.id);
                }}
              >
                <PopoverTrigger
                  title="More"
                  className={circleBtn}
                  style={{ color: moreOpen ? "var(--app-text)" : undefined }}
                >
                  <MoreHorizontal size={16} strokeWidth={1.8} />
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align={me ? "end" : "start"}
                  sideOffset={8}
                  className="w-48 rounded-2xl border-app-border bg-panel-2 p-1.5 shadow-[var(--app-shadow-lg)]"
                >
                  <MenuRow
                    onClick={() => {
                      navigator.clipboard?.writeText(msg.text);
                      closeMore();
                    }}
                  >
                    <Copy
                      size={14}
                      strokeWidth={1.8}
                      className="text-app-muted"
                    />
                    Copy message
                  </MenuRow>
                  <MenuRow
                    onClick={() => {
                      togglePin(currentGroupId, msg.id);
                      closeMore();
                    }}
                  >
                    <Pin
                      size={14}
                      strokeWidth={1.8}
                      className={isPinned ? "text-app-accent" : "text-app-muted"}
                      fill={isPinned ? "var(--app-accent)" : "none"}
                    />
                    {isPinned ? "Unpin from group" : "Pin to group"}
                  </MenuRow>
                  {me && !msg.pending && !msg.enc && !msg.failed && (
                    <MenuRow
                      onClick={() => {
                        startEdit(currentGroupId, msg);
                        closeMore();
                      }}
                    >
                      <Pencil size={14} strokeWidth={1.8} className="text-app-muted" />
                      Edit message
                    </MenuRow>
                  )}
                  {me && (
                    <MenuRow
                      danger
                      onClick={() => {
                        deleteMessage(currentGroupId, msg.id);
                        closeMore();
                      }}
                    >
                      <Trash2 size={14} strokeWidth={1.8} />
                      Delete message
                    </MenuRow>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>

        {msg.pending && (
          <div className="mt-0.5 text-[11px] text-app-faint">Sending…</div>
        )}
        {msg.failed && (
          <div
            className="mt-0.5 flex items-center gap-1.5 text-[11px]"
            style={{ color: "var(--app-red)" }}
          >
            <span>{msg.failReason || "Failed to send."}</span>
            <button
              onClick={() => retrySend(currentGroupId, msg.id)}
              className="font-semibold underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* "seen by" — overlapping mini-avatars on the newest message each
            reader's E2EE read cursor covers (Messenger-style) */}
        {seenBy.length > 0 && (
          <div
            className={`mt-1 flex items-center gap-0.5 ${me ? "justify-end" : ""}`}
            title={`Seen by ${seenBy.map((u) => u.name).join(", ")}`}
          >
            {seenBy.slice(0, 5).map((u, i) => (
              <span key={u.id ?? i} style={{ marginLeft: i ? -4 : 0 }}>
                <Avatar
                  initials={u.initials}
                  bg={u.bg}
                  src={u.avatar}
                  size={15}
                  fontSize={8}
                />
              </span>
            ))}
          </div>
        )}
      </div>

      {/* emoji picker — anchored to the React button via the shared handle */}
      <Popover
        handle={pickerHandle}
        open={pickerOpen}
        onOpenChange={(open) => {
          if (open !== pickerOpen) togglePicker(msg.id);
        }}
      >
        <PopoverContent
          side="bottom"
          align={me ? "end" : "start"}
          sideOffset={8}
          className="w-[352px] overflow-hidden rounded-2xl shadow-[var(--app-shadow-lg)]"
        >
          <EmojiPickerPopup onPick={(e) => toggleReaction(msg.id, e)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function MenuRow({
  onClick,
  danger,
  children,
}: {
  onClick?: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-panel-hover ${
        danger ? "text-app-red" : "text-app-text"
      }`}
    >
      {children}
    </button>
  );
}
