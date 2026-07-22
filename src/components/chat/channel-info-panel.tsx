"use client";

import { useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  ChevronRight,
  ImageIcon,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { Attachment, User } from "@/lib/chat-data";
import {
  CHAT_GRADIENTS,
  QUICK_EMOJI,
  channelMembers,
  presenceColor,
  presenceLabel,
} from "@/lib/chat-data";
import { useChat } from "./chat-context";
import { Avatar } from "./bits";
import { ConvAvatar } from "./sidebar";
import { useDecryptedImage } from "./message";

/** Stable id for a member/user — the server-provided uid (email for real
 * users, seeded key otherwise). Falls back to the first name only for legacy
 * Users that predate the id field. */
const memberId = (u: User) => u.id ?? u.name.split(" ")[0].toLowerCase();

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 border-t border-app-border px-1 py-3">
      <div className="mb-3 flex items-center">
        <div className="text-[14px] font-semibold text-app-text">{label}</div>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

/** One tile of the shared-media grid (decrypts E2EE images client-side). */
function MediaThumb({ a }: { a: Attachment }) {
  const { src } = useDecryptedImage(a);
  const url = a.encrypted ? src : (a.url ?? null);
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-lg bg-panel"
        style={{ aspectRatio: "1" }}
        title={a.name}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={a.name} className="size-full object-cover" />
      </a>
    );
  }
  return (
    <div
      className="rounded-lg"
      style={{
        aspectRatio: "1",
        background:
          "repeating-linear-gradient(45deg, var(--app-hover) 0 10px, var(--app-hover-strong) 10px 20px)",
      }}
      title={a.name}
    />
  );
}

export function ChannelInfoPanel() {
  const {
    channels,
    currentChannelId,
    closeChannelInfo,
    updateChannel,
    deleteChannel,
    addChannelMember,
    removeChannelMember,
    myUser: me,
    workspaceMembers,
    bubbleTheme,
    setBubbleTheme,
    likeEmoji,
    setLikeEmoji,
    openSearch,
  } = useChat();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTopic, setEditTopic] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [muted, setMuted] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ch = channels[currentChannelId];
  if (!ch) return null;
  const isDm = ch.type === "dm";
  const members = channelMembers(ch, me);
  const memberNames = new Set(members.map((m) => m.name));
  const addable = workspaceMembers.filter((u) => !memberNames.has(u.name));

  const images = ch.messages
    .map((m) => m.attachment)
    .filter((a): a is Attachment => !!a && a.kind === "image")
    .slice(-6)
    .reverse();
  const files = ch.messages
    .map((m) => m.attachment)
    .filter((a): a is Attachment => !!a && a.kind !== "image");

  const startEdit = () => {
    setEditName(ch.name);
    setEditTopic(ch.topic ?? "");
    setError(null);
    setEditing(true);
  };
  const saveEdit = () => {
    updateChannel(ch.id, { name: editName, topic: editTopic }, setError);
    setEditing(false);
  };

  const circleAction = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
  ) => (
    <button
      key={label}
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 text-app-text"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-panel hover:bg-panel-hover">
        {icon}
      </span>
      <span className="text-[11.5px] font-medium text-app-muted">{label}</span>
    </button>
  );

  return (
    <aside className="relative flex w-[340px] shrink-0 flex-col border-l border-app-border bg-app-bg">
      <button
        onClick={closeChannelInfo}
        title="Close"
        className="absolute right-3 top-3 z-[1] flex size-8 items-center justify-center rounded-full text-app-muted hover:bg-app-hover hover:text-app-text"
      >
        <X size={16} strokeWidth={2} />
      </button>

      <div className="app-scroll flex-1 overflow-y-auto px-4 pb-8 pt-6">
        {/* Identity */}
        <div className="flex flex-col items-center text-center">
          <ConvAvatar ch={ch} me={me} size={80} />
          <div className="mt-3 text-[19px] font-bold">
            {isDm && ch.user ? ch.user.name : ch.name}
          </div>
          <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[12.5px] text-app-muted">
            {isDm ? (
              <>
                <span
                  className="size-2 rounded-full"
                  style={{ background: presenceColor(ch.presence) }}
                />
                {presenceLabel(ch.presence)}
              </>
            ) : (
              `${members.length} ${members.length === 1 ? "member" : "members"}`
            )}
          </div>
        </div>

        {/* Quick actions */}
        <div className="my-5 flex justify-center gap-6">
          {isDm
            ? circleAction(<UserRound size={19} strokeWidth={1.8} />, "Profile")
            : circleAction(
                <Pencil size={17} strokeWidth={1.8} />,
                "Edit",
                startEdit,
              )}
          {circleAction(
            muted ? (
              <BellOff size={18} strokeWidth={1.8} />
            ) : (
              <Bell size={18} strokeWidth={1.8} />
            ),
            muted ? "Unmute" : "Mute",
            () => setMuted((m) => !m),
          )}
          {circleAction(
            <Search size={18} strokeWidth={1.8} />,
            "Search",
            openSearch,
          )}
        </div>

        {/* Customize chat */}
        <Section label="Customize chat">
          <div className="mb-2 text-[12.5px] text-app-muted">Chat color</div>
          <div className="mb-4 flex gap-2.5">
            {Object.entries(CHAT_GRADIENTS).map(([key, grad]) => (
              <button
                key={key}
                title={key}
                onClick={() => setBubbleTheme(key)}
                className="size-8 rounded-full"
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
          <div className="mb-2 text-[12.5px] text-app-muted">Quick emoji</div>
          <div className="flex gap-2">
            {QUICK_EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => setLikeEmoji(e)}
                className="flex size-[34px] items-center justify-center rounded-full text-[18px]"
                style={{
                  background:
                    likeEmoji === e ? "var(--app-accent-soft)" : "var(--panel)",
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </Section>

        {/* Chat info (channels) */}
        {!isDm &&
          (editing ? (
            <Section label="Edit group">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Name"
                className="mb-2 w-full rounded-xl border border-app-border bg-panel-2 px-3 py-2 text-[13.5px] text-app-text outline-none focus:border-border-strong"
              />
              <textarea
                value={editTopic}
                onChange={(e) => setEditTopic(e.target.value)}
                placeholder="Topic"
                rows={2}
                className="w-full resize-none rounded-xl border border-app-border bg-panel-2 px-3 py-2 text-[13.5px] text-app-text outline-none focus:border-border-strong"
              />
              <div className="mt-2 flex gap-2">
                <button
                  onClick={saveEdit}
                  className="flex items-center gap-1 rounded-full px-3.5 py-1.5 text-[13px] font-semibold"
                  style={{ background: "var(--app-accent)", color: "var(--on-accent)" }}
                >
                  <Check size={13} strokeWidth={2.4} /> Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-full bg-panel px-3.5 py-1.5 text-[13px] font-semibold text-app-muted hover:bg-panel-hover"
                >
                  Cancel
                </button>
              </div>
            </Section>
          ) : (
            <Section
              label="Chat info"
              action={
                <button
                  onClick={startEdit}
                  title="Edit"
                  className="flex items-center gap-1 text-[12.5px] font-semibold text-app-accent hover:underline"
                >
                  <Pencil size={12} strokeWidth={2} /> Edit
                </button>
              }
            >
              <div className="text-[13.5px] leading-[1.5] text-app-text">
                {ch.topic || <span className="text-app-muted">No topic set.</span>}
              </div>
              <div className="mt-1.5 text-[12.5px] leading-[1.5] text-app-muted">
                {ch.private
                  ? "Private group — only invited members can see it."
                  : "Open to everyone in the workspace."}
              </div>
            </Section>
          ))}

        {/* Members (channels) */}
        {!isDm && (
          <Section
            label={`Chat members · ${members.length}`}
            action={
              <button
                onClick={() => setAdding((v) => !v)}
                className="flex items-center gap-1 text-[12.5px] font-semibold text-app-accent hover:underline"
              >
                <Plus size={13} strokeWidth={2.4} /> Add
              </button>
            }
          >
            {adding && (
              <div className="mb-2 rounded-xl border border-app-border bg-panel-2 p-1">
                {addable.length === 0 ? (
                  <div className="px-2 py-1.5 text-[12.5px] text-app-muted">
                    Everyone&apos;s already a member.
                  </div>
                ) : (
                  addable.map((u) => (
                    <button
                      key={u.name}
                      onClick={() => addChannelMember(ch.id, memberId(u))}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-panel-hover"
                    >
                      <Avatar initials={u.initials} bg={u.bg} size={24} radius={999} />
                      <span className="text-[13px] font-medium">{u.name}</span>
                      <Plus size={14} strokeWidth={2.2} className="ml-auto text-app-muted" />
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="-mx-1">
              {members.map((u) => (
                <div
                  key={u.name}
                  className="group flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 hover:bg-app-hover"
                >
                  <Avatar initials={u.initials} bg={u.bg} size={30} radius={999} />
                  <span className="text-[13.5px] font-medium text-app-text">
                    {u.name}
                  </span>
                  {u.name === me.name && (
                    <span className="text-[12px] text-app-faint">you</span>
                  )}
                  <button
                    onClick={() => removeChannelMember(ch.id, memberId(u))}
                    title={`Remove ${u.name}`}
                    className="ml-auto flex size-6 items-center justify-center rounded-full text-app-muted opacity-0 hover:bg-panel hover:text-app-red group-hover:opacity-100"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Shared media */}
        <Section label="Shared media">
          {images.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] text-app-muted">
              <ImageIcon size={15} strokeWidth={1.8} />
              No photos or videos yet.
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1">
              {images.map((a, i) => (
                <MediaThumb key={a.url ?? i} a={a} />
              ))}
            </div>
          )}
        </Section>

        {/* Shared files */}
        <button
          onClick={() => setFilesOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 border-t border-app-border px-1 py-3 text-left"
        >
          <span className="flex-1 text-[14px] font-semibold text-app-text">
            Shared files
          </span>
          <span className="text-[12.5px] text-app-muted">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
          <ChevronRight
            size={16}
            strokeWidth={2}
            className="text-app-faint transition-transform"
            style={{ transform: filesOpen ? "rotate(90deg)" : "none" }}
          />
        </button>
        {filesOpen && files.length > 0 && (
          <div className="pb-2">
            {files.map((a, i) => (
              <div
                key={a.url ?? i}
                className="flex items-center gap-2.5 rounded-xl px-1.5 py-1.5"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel text-[10px] font-bold text-app-muted">
                  {(a.label || "FILE").slice(0, 4).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{a.name}</span>
                  <span className="text-[11.5px] text-app-muted">{a.size}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Privacy & support */}
        <Section label="Privacy & support">
          {isDm ? (
            <div className="text-[13px] leading-[1.5] text-app-muted">
              Messages are end-to-end encrypted. Only you and{" "}
              {ch.user?.name ?? "your contact"} can read them.
            </div>
          ) : confirmDelete ? (
            <div className="rounded-xl border border-app-border bg-panel-2 p-3">
              <div className="mb-2 text-[13px] text-app-text">
                Delete <span className="font-semibold">{ch.name}</span>? This
                removes the group and its messages for everyone.
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => deleteChannel(ch.id, setError)}
                  className="rounded-full px-3.5 py-1.5 text-[13px] font-semibold text-white"
                  style={{ background: "var(--app-red)" }}
                >
                  Delete group
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full bg-panel px-3.5 py-1.5 text-[13px] font-semibold text-app-muted hover:bg-panel-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-2 text-[13.5px] font-medium text-app-red hover:underline"
            >
              <Trash2 size={15} strokeWidth={1.8} /> Delete group
            </button>
          )}
        </Section>

        {error && <div className="px-1 pt-2 text-[13px] text-app-red">{error}</div>}
      </div>
    </aside>
  );
}
