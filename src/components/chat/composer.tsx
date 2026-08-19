"use client";

import { useEffect, useRef, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type EditorState,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
} from "lexical";
import {
  Check,
  FileText,
  ImageIcon,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Reply,
  Send,
  Smile,
  Video,
  X,
} from "lucide-react";
import {
  type LinkPreview,
  type Message,
  messageExcerpt,
} from "@/lib/chat-data";
import { cryptoAvailable } from "@/lib/crypto/identity";
import { encryptFile } from "@/lib/crypto/attachment";
import { useUploadThing } from "@/lib/uploadthing";
import { EmojiPickerPopup } from "./emoji-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EDITOR_NODES, EDITOR_THEME } from "./lexical/config";
import { MentionsPlugin } from "./lexical/MentionsPlugin";
import { useVoiceRecorder } from "./use-voice-recorder";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores/chat-store";
import { useEditingMessage, useLikeEmoji } from "@/stores/chat-selectors";
import { useChatActions } from "./chat-actions";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** First http(s) URL in the composer text (the one we offer to preview). */
function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

/**
 * Downscale a preview image to a small JPEG data URI so it rides INSIDE the
 * E2EE envelope (recipients render it with zero network requests). Returns
 * undefined when the image can't be fetched/decoded or won't fit the cap —
 * the preview then ships without an image rather than leaking a remote fetch.
 */
async function inlinePreviewImage(remoteUrl: string): Promise<string | undefined> {
  try {
    // Fetched through the unfurl proxy (sender-side only) so canvas can read it.
    // POST so the URL rides in the body, out of access logs.
    const res = await fetch("/api/unfurl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: remoteUrl, image: true }),
    });
    if (!res.ok) return undefined;
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, 320 / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // ~32KB decoded ≈ ~44k base64 chars. Try decreasing quality to fit.
    for (const q of [0.7, 0.5, 0.35]) {
      const uri = canvas.toDataURL("image/jpeg", q);
      if (uri.length <= 44_000) return uri;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Lexical editor + toolbar + bottom bar. Lives inside <LexicalComposer>.
function ComposerInner({
  groupId,
  inThread,
  editingMsg,
}: {
  groupId: string;
  inThread: boolean;
  /** When set, the composer EDITS this message instead of sending a new one. */
  editingMsg: Message | null;
}) {
  const [editor] = useLexicalComposerContext();
  const { composerActive, composerAttachment, drafts, profile, replyingTo } =
    useChatStore(
      useShallow((s) => ({
        composerActive: s.composerActive,
        composerAttachment: s.composerAttachment,
        drafts: s.drafts,
        profile: s.profile,
        replyingTo: s.replyingTo,
      })),
    );
  const likeEmoji = useLikeEmoji();
  const {
    sendMessage,
    sendThreadMessage,
    submitEdit,
    cancelEdit,
    setComposerActive,
    notifyTyping,
    setComposerAttachment,
    saveDraft,
    clearDraft,
    updateProfile,
    cancelReply,
  } = useChatActions();

  // Constant for a given mount: entering/leaving edit mode remounts the editor
  // via the LexicalComposer key (so the seed/draft logic never has to switch).
  const isEditing = !!editingMsg;
  const attachable = !inThread && !isEditing;
  // Quoted reply is a group-composer-only mode (threads have their own reply
  // path). When armed, the input focuses and its placeholder changes.
  const replyActive = !!replyingTo && !inThread && !isEditing;
  // Edit mode mounts with the message body already seeded → starts non-empty.
  const [hasText, setHasText] = useState(isEditing);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  // True while the mention typeahead menu is open, so Enter selects a mention
  // instead of sending.
  const mentionOpenRef = useRef(false);
  // Draft autosave (group composer only): keep the latest content in a ref and
  // commit it debounced, plus once more on unmount (group switch) so nothing
  // typed is lost. Thread composers don't persist drafts.
  const draftRef = useRef<{ text: string; rich?: string }>({ text: "" });
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the initial (mount) onChange so an empty editor doesn't clobber a draft
  // that hasn't hydrated from storage yet.
  const firstChange = useRef(true);
  const restored = useRef(false);

  // --- attachment upload (UploadThing) --------------------------------------
  // Picking a file uploads it browser-direct to UploadThing; only when the
  // upload finishes is `composerAttachment` set (with the CDN url), so a message
  // can't be sent before its image exists. While uploading we show a local chip
  // (object-URL thumbnail + progress). pendingMeta/pendingDims carry per-pick
  // info into the (stable) completion callback; removedRef discards a result if
  // the user cleared the chip mid-flight.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Video is transcoded server-side to HLS (plaintext, not encrypted); gates
  // send like an upload does.
  const [transcoding, setTranscoding] = useState(false);

  // --- link previews (opt-in; see UserProfile.linkPreviews) ------------------
  // The first URL currently in the text; drives the preview fetch + the one-tap
  // enable prompt. `previewDismissed` is per-URL (the X on the card), so a NEW
  // link in the same message can still get a preview.
  const [urlInText, setUrlInText] = useState<string | null>(null);
  const [pendingPreview, setPendingPreview] = useState<LinkPreview | null>(null);
  const [previewDismissed, setPreviewDismissed] = useState<string | null>(null);
  const previewsEnabled = profile.linkPreviews === true;
  const previewsUndecided = profile.linkPreviews === undefined;
  // Fetch (debounced) once a URL settles, previews are on, and it wasn't
  // dismissed. The unfurl runs SENDER-side only; recipients render the result
  // from inside the envelope with zero network activity.
  useEffect(() => {
    let cancelled = false;
    const eligible =
      !inThread &&
      !isEditing &&
      !!urlInText &&
      previewsEnabled &&
      urlInText !== previewDismissed;
    const t = setTimeout(async () => {
      if (cancelled) return;
      if (!eligible) {
        setPendingPreview((p) => (p ? null : p));
        return;
      }
      try {
        const res = await fetch("/api/unfurl", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: urlInText! }),
        });
        if (!res.ok || cancelled) return;
        const meta = (await res.json()) as LinkPreview & { image?: string };
        const image = meta.image
          ? await inlinePreviewImage(meta.image)
          : undefined;
        if (cancelled) return;
        setPendingPreview({
          url: meta.url,
          title: meta.title,
          description: meta.description,
          siteName: meta.siteName,
          image,
        });
      } catch {
        // Unfurl failure never blocks composing — just no preview.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [urlInText, previewsEnabled, previewDismissed, inThread, isEditing]);
  const pendingMeta = useRef<{
    kind: "image" | "file" | "audio";
    name: string;
    size: string;
    label: string;
    mime?: string;
    encrypted?: boolean;
    key?: string;
    iv?: string;
    /** Audio only: length + waveform buckets (computed pre-encryption). */
    duration?: number;
    peaks?: number[];
  } | null>(null);
  const pendingDims = useRef<{ width?: number; height?: number }>({});
  const removedRef = useRef(false);

  const clearAttachment = () => {
    removedRef.current = true;
    setPreviewUrl((u) => {
      if (u) URL.revokeObjectURL(u);
      return null;
    });
    setUploadingName(null);
    setUploadError(null);
    setComposerAttachment(null);
  };

  const { startUpload, isUploading } = useUploadThing("messageAttachment", {
    onUploadProgress: (p) => setUploadPct(p),
    onClientUploadComplete: (res) => {
      const f = res?.[0];
      const meta = pendingMeta.current;
      if (removedRef.current || !f || !meta) return;
      setComposerAttachment({
        ...meta,
        url: f.serverData?.url ?? f.ufsUrl,
        ...pendingDims.current,
      });
    },
    onUploadError: (err) => {
      setUploadError(err.message || "Upload failed");
      setUploadingName(null);
      setPreviewUrl((u) => {
        if (u) URL.revokeObjectURL(u);
        return null;
      });
    },
  });

  // Revoke the last object URL on unmount.
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  // Voice notes: the finished recording flows through the exact same
  // encrypt-and-upload path as a picked file (ciphertext-only storage); the
  // waveform peaks + duration were computed from the plaintext by the hook.
  const recorder = useVoiceRecorder(async ({ file, mime, duration, peaks }) => {
    removedRef.current = false;
    setUploadError(null);
    setUploadPct(0);
    setComposerAttachment(null);
    setUploadingName("Voice message");
    pendingDims.current = {};
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    const baseMeta = {
      kind: "audio" as const,
      name: file.name,
      size: formatBytes(file.size),
      label: "Voice message",
      mime,
      duration,
      peaks,
    };
    if (cryptoAvailable()) {
      try {
        const { ciphertext, key, iv } = await encryptFile(file);
        if (removedRef.current) return;
        pendingMeta.current = { ...baseMeta, encrypted: true, key, iv };
        void startUpload([
          new File([ciphertext], file.name, { type: "application/octet-stream" }),
        ]);
      } catch {
        setUploadError("Could not encrypt the recording.");
        setUploadingName(null);
      }
      return;
    }
    pendingMeta.current = baseMeta;
    void startUpload([file]);
  });

  // Can't send while an attachment is still uploading/transcoding — wait for it.
  const canSend =
    (hasText || (attachable && !!composerAttachment)) &&
    !isUploading &&
    !transcoding;

  // Clear the local attachment chip/preview (the Attachment itself is consumed
  // and cleared by useMessageActions on send).
  const resetAttachmentUI = () => {
    setPreviewUrl((u) => {
      if (u) URL.revokeObjectURL(u);
      return null;
    });
    setUploadingName(null);
    setUploadError(null);
    setUploadPct(0);
  };

  const submit = () => {
    if (isUploading || transcoding) return;
    let text = "";
    const state = editor.getEditorState();
    state.read(() => {
      text = $getRoot().getTextContent();
    });
    const trimmed = text.trim();
    if (!trimmed && !(attachable && composerAttachment)) return;
    if (isEditing) {
      submitEdit(trimmed, JSON.stringify(state.toJSON()));
      // cancelEdit remounts the composer (key change), restoring the draft.
      cancelEdit();
      return;
    }
    if (inThread) {
      sendThreadMessage(trimmed, JSON.stringify(state.toJSON()));
    } else {
      // Attachment-only send: skip the rich body — an empty editor state would
      // otherwise render as a blank bubble above the attachment.
      sendMessage(
        trimmed,
        trimmed ? JSON.stringify(state.toJSON()) : undefined,
        pendingPreview ?? undefined,
      );
      setPendingPreview(null);
      setPreviewDismissed(null);
      setUrlInText(null);
      resetAttachmentUI();
      // Sent — drop any saved draft for this group and cancel a pending save.
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftRef.current = { text: "" };
      clearDraft(groupId);
    }
    editor.update(() => {
      $getRoot().clear();
    });
    setEmojiOpen(false);
  };

  // The Enter command is registered once, so it must call the *latest* submit:
  // `sendMessage` is recreated when the socket connects (null → live), and a
  // stale closure would emit through a null socket — the send silently no-ops
  // and later shows "Failed to send". Route through a ref kept current each
  // render so Enter always uses the live closure.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  // Enter sends (Shift+Enter = newline). The mention typeahead intercepts
  // Enter at a higher priority when its menu is open.
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (e) => {
          // Defer to the mention typeahead when its menu is open.
          if (mentionOpenRef.current) return false;
          if (e && !e.shiftKey) {
            e.preventDefault();
            submitRef.current();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor],
  );

  const onChange = (state: EditorState) => {
    let t = "";
    state.read(() => {
      t = $getRoot().getTextContent();
    });
    setHasText(t.trim().length > 0);
    if (t.trim()) notifyTyping(groupId);
    // Track the first URL for the link-preview flow (opt-in fetch happens in
    // the debounced effect above, never here).
    setUrlInText((prev) => {
      const url = firstUrl(t);
      return url === prev ? prev : url;
    });
    // Edit mode never touches the group draft (the draft survives the edit).
    if (!inThread && !isEditing) {
      if (firstChange.current) {
        firstChange.current = false;
        return;
      }
      draftRef.current = { text: t, rich: JSON.stringify(state.toJSON()) };
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(
        () => saveDraft(groupId, draftRef.current),
        500,
      );
    }
  };

  // Flush the pending draft when leaving the group (the editor unmounts on
  // group switch via its `key`), so the last keystrokes aren't dropped.
  useEffect(() => {
    if (inThread || isEditing) return;
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      saveDraft(groupId, draftRef.current);
    };
  }, [inThread, isEditing, groupId, saveDraft]);

  // Restore the group's saved draft into the editor. Runs once per group,
  // re-firing when `drafts` hydrates from storage after mount (the initial-load
  // case, where the editor mounted before the draft was available). Only fills
  // an empty editor so it never stomps on what the user is typing.
  const draftRich = inThread || isEditing ? undefined : drafts[groupId]?.rich;
  useEffect(() => {
    if (inThread || isEditing || restored.current || !draftRich) return;
    let empty = true;
    editor.getEditorState().read(() => {
      empty = $getRoot().getTextContent().trim().length === 0;
    });
    restored.current = true;
    if (empty) editor.setEditorState(editor.parseEditorState(draftRich));
    setHasText(true);
  }, [inThread, isEditing, draftRich, editor]);

  // Edit mode: rich bodies are seeded via initialConfig.editorState (outer
  // Composer); plain-text bodies are inserted here. Focus either way, and let
  // Escape abandon the edit (the key-change remount restores the draft).
  useEffect(() => {
    if (!isEditing) return;
    if (editingMsg && !editingMsg.rich && editingMsg.text) {
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode(editingMsg.text));
        root.append(p);
        root.selectEnd();
      });
    }
    editor.focus();
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        cancelEdit();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, editor]); // editingMsg/cancelEdit: stable for this mount (keyed remount)

  // Focus the input the moment a reply is armed, so the user can type straight
  // away (mirrors tapping "Reply" in Messenger).
  useEffect(() => {
    if (replyActive) editor.focus();
  }, [replyActive, replyingTo, editor]);

  const insertEmoji = (e: string) => {
    editor.update(() => {
      // Clicking the picker blurs the editor, so there may be no live range
      // selection — fall back to selecting the end and inserting there.
      let sel = $getSelection();
      if (!$isRangeSelection(sel)) {
        $getRoot().selectEnd();
        sel = $getSelection();
      }
      if ($isRangeSelection(sel)) sel.insertText(e);
    });
    setEmojiOpen(false);
    editor.focus();
  };

  // Messenger's Like button: with nothing typed, send the quick emoji.
  const sendLike = () => {
    if (inThread) sendThreadMessage(likeEmoji);
    else sendMessage(likeEmoji);
  };

  const onPickFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
    mediaOnly: boolean,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const isImage = file.type.startsWith("image/") || (mediaOnly && !file.type);
    const ext = file.name.includes(".")
      ? file.name.split(".").pop()!.toUpperCase()
      : (file.type.split("/")[1] || "file").toUpperCase();

    // Reset prior pick. The local preview/dims are read from the ORIGINAL
    // (plaintext) file; what we upload is the ciphertext.
    removedRef.current = false;
    setUploadError(null);
    setUploadPct(0);
    setComposerAttachment(null);
    setUploadingName(file.name);
    pendingDims.current = {};
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (isImage) {
      const obj = URL.createObjectURL(file);
      setPreviewUrl(obj);
      const probe = new Image();
      probe.onload = () => {
        pendingDims.current = {
          width: probe.naturalWidth,
          height: probe.naturalHeight,
        };
      };
      probe.src = obj;
    }
    // Video → plaintext HLS. Send the raw file to the server transcoder (NOT
    // encrypted; adaptive streaming requires the transcoder to read it). Gate
    // send via `transcoding` until the HLS URLs come back.
    if (file.type.startsWith("video/")) {
      setTranscoding(true);
      const label = file.name.replace(/\.[^.]+$/, "");
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/video/transcode", { method: "POST", body: fd });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          hls: string;
          poster?: string;
          width?: number;
          height?: number;
          duration?: number;
        };
        if (removedRef.current) return;
        setComposerAttachment({
          kind: "video",
          name: file.name,
          size: formatBytes(file.size),
          label,
          mime: file.type || undefined,
          url: data.hls,
          poster: data.poster,
          width: data.width,
          height: data.height,
          duration: data.duration,
        });
      } catch {
        if (!removedRef.current) {
          setUploadError("Could not process the video.");
          setUploadingName(null);
        }
      } finally {
        setTranscoding(false);
      }
      return;
    }

    const baseMeta = {
      kind: (isImage ? "image" : "file") as "image" | "file",
      name: file.name,
      size: formatBytes(file.size),
      label: isImage ? file.name.replace(/\.[^.]+$/, "") : ext,
      mime: file.type || undefined,
    };

    // E2EE: encrypt client-side and upload the ciphertext as an opaque blob, so
    // the storage host only ever holds ciphertext. The key/iv ride out in the
    // message envelope at send time (see useMessageActions emitSend). Plaintext
    // upload only when WebCrypto is unavailable.
    if (cryptoAvailable()) {
      try {
        const { ciphertext, key, iv } = await encryptFile(file);
        if (removedRef.current) return;
        pendingMeta.current = { ...baseMeta, encrypted: true, key, iv };
        void startUpload([
          new File([ciphertext], file.name, {
            type: "application/octet-stream",
          }),
        ]);
      } catch {
        setUploadError("Could not encrypt the file.");
        setUploadingName(null);
      }
      return;
    }
    pendingMeta.current = baseMeta;
    void startUpload([file]);
  };

  const iconCircle =
    "flex size-9 shrink-0 items-center justify-center rounded-full text-app-accent hover:bg-app-hover";

  return (
    <div className="px-3 pb-3 pt-1">
      {/* attachment chip — shown while encrypting/uploading and once attached */}
      {attachable && (composerAttachment || isUploading || uploadingName) && (
        <div className="mb-2 flex items-center gap-2.5 rounded-2xl border border-app-border bg-panel-2 px-3 py-2 shadow-[var(--app-shadow-sm)]">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt=""
              className="size-9 shrink-0 rounded-lg object-cover"
              style={{ opacity: isUploading ? 0.6 : 1 }}
            />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-panel text-app-muted">
              {/* Images always have a previewUrl (handled above). The
                  no-preview branch is a video (while transcoding) or a file. */}
              {composerAttachment?.kind === "video" || transcoding ? (
                <Video size={16} strokeWidth={1.8} />
              ) : (
                <FileText size={16} strokeWidth={1.8} />
              )}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">
              {composerAttachment?.name ?? uploadingName}
            </div>
            {transcoding ? (
              <div className="text-[11.5px] text-app-faint">Transcoding…</div>
            ) : isUploading ? (
              <div className="mt-1 h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-panel">
                <div
                  className="h-full rounded-full bg-app-accent transition-[width] duration-200"
                  style={{ width: `${uploadPct}%` }}
                />
              </div>
            ) : (
              <div className="text-[11.5px] text-app-faint">
                {composerAttachment?.size}
              </div>
            )}
          </div>
          <button
            onClick={clearAttachment}
            title="Remove"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-app-muted hover:bg-panel-hover hover:text-app-text"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      )}
      {attachable && uploadError && (
        <div className="mb-1 px-2 text-[12px]" style={{ color: "var(--app-red)" }}>
          {uploadError}
        </div>
      )}

      {/* link previews: one-tap opt-in prompt the first time a URL is typed */}
      {!inThread && !isEditing && urlInText && previewsUndecided && (
        <div className="mb-1 flex items-center gap-2 rounded-xl bg-panel px-3 py-1.5 text-[12.5px] text-app-muted">
          <span className="min-w-0 flex-1 truncate">
            Show link previews? Fetching one shares the URL with the server —
            the preview itself stays end-to-end encrypted.
          </span>
          <button
            onClick={() => updateProfile({ linkPreviews: true })}
            className="shrink-0 rounded-full bg-app-accent px-2.5 py-0.5 font-semibold text-white hover:opacity-90"
          >
            Enable
          </button>
          <button
            onClick={() => updateProfile({ linkPreviews: false })}
            className="shrink-0 rounded-full px-2 py-0.5 font-semibold hover:bg-panel-hover"
          >
            No thanks
          </button>
        </div>
      )}

      {/* pending link preview — dismissible per send */}
      {!inThread && !isEditing && pendingPreview && (
        <div className="mb-1 flex items-start gap-2.5 rounded-xl border border-app-border bg-panel px-3 py-2">
          {pendingPreview.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pendingPreview.image}
              alt=""
              className="h-12 w-12 shrink-0 rounded-lg object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-app-text">
              {pendingPreview.title}
            </div>
            <div className="truncate text-[12px] text-app-muted">
              {pendingPreview.siteName || pendingPreview.url}
            </div>
          </div>
          <button
            onClick={() => {
              // Key the dismissal on the TYPED url (what the fetch effect
              // compares), not the server-normalized preview.url.
              setPreviewDismissed(urlInText);
              setPendingPreview(null);
            }}
            title="Remove preview"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-app-muted hover:bg-panel-hover hover:text-app-text"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* quoted-reply bar — accent left border, sits flush atop the input */}
      {replyActive && replyingTo && (
        <div className="mb-1 flex items-center gap-2.5 rounded-xl border-l-[3px] border-app-accent bg-panel px-3 py-2">
          <Reply size={16} strokeWidth={1.9} className="shrink-0 text-app-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-bold text-app-accent">
              Replying to{" "}
              {replyingTo.self
                ? "yourself"
                : replyingTo.author.name.split(" ")[0]}
            </div>
            <div className="truncate text-[13px] text-app-muted">
              {messageExcerpt(replyingTo)}
            </div>
          </div>
          <button
            onClick={cancelReply}
            title="Cancel reply"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-app-muted hover:bg-panel-hover hover:text-app-text"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {isEditing && (
        <div className="mb-1 flex items-center gap-2 rounded-xl bg-panel px-3 py-1.5 text-[12.5px] text-app-muted">
          <Pencil size={13} strokeWidth={1.9} className="shrink-0 text-app-accent" />
          <span className="min-w-0 flex-1 truncate">
            Editing message · <kbd className="font-sans">Esc</kbd> to cancel
          </span>
          <button
            onClick={cancelEdit}
            title="Cancel edit"
            className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-panel-hover hover:text-app-text"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="flex items-end gap-1">
        {/* left action circles — swap to a recording pill while capturing */}
        {attachable &&
          (recorder.recording ? (
            <div className="mb-0.5 flex items-center gap-1.5 rounded-full bg-panel py-1 pl-3 pr-1">
              <span
                className="size-2 shrink-0 animate-pulse rounded-full"
                style={{ background: "var(--app-red)" }}
              />
              <span className="text-[12.5px] tabular-nums text-app-muted">
                {Math.floor(recorder.elapsed / 60)}:
                {String(recorder.elapsed % 60).padStart(2, "0")}
              </span>
              <button
                onClick={recorder.cancel}
                title="Discard recording"
                className="flex size-7 items-center justify-center rounded-full text-app-muted hover:bg-panel-hover hover:text-app-text"
              >
                <X size={15} strokeWidth={2} />
              </button>
              <button
                onClick={recorder.stop}
                title="Finish recording"
                className="flex size-7 items-center justify-center rounded-full text-white"
                style={{ background: "var(--app-accent)" }}
              >
                <Check size={15} strokeWidth={2.2} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-0.5 pb-0.5">
              <button
                onClick={() => fileRef.current?.click()}
                title="Attach a file"
                className={iconCircle}
              >
                <Plus size={22} strokeWidth={1.9} />
              </button>
              <button
                onClick={() => mediaRef.current?.click()}
                title="Add a photo or video"
                className={iconCircle}
              >
                <ImageIcon size={20} strokeWidth={1.9} />
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                title="Attach a file"
                className={iconCircle}
              >
                <Paperclip size={19} strokeWidth={1.9} />
              </button>
              {recorder.supported && (
                <button
                  onClick={() => void recorder.start()}
                  title="Record a voice message"
                  className={iconCircle}
                >
                  <Mic size={19} strokeWidth={1.9} />
                </button>
              )}
            </div>
          ))}

        {/* Aa pill: editor + emoji trigger */}
        <div
          className="flex min-w-0 flex-1 items-end gap-1 rounded-[20px] bg-panel py-0.5 pl-3 pr-1 transition-colors"
          style={{
            border: `1px solid ${composerActive ? "var(--border-strong)" : "transparent"}`,
          }}
        >
          <div className="relative min-w-0 flex-1">
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  onFocus={() => setComposerActive(true)}
                  onBlur={() => setComposerActive(false)}
                  className="lex-editor"
                  style={{ minHeight: 20, maxHeight: 120 }}
                />
              }
              placeholder={
                <div className="lex-placeholder">
                  {replyActive ? "Type your reply…" : "Aa"}
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin />
            <ListPlugin />
            <LinkPlugin />
            <OnChangePlugin onChange={onChange} />
            <MentionsPlugin openRef={mentionOpenRef} />
          </div>
          <Popover open={emojiOpen} onOpenChange={(o) => setEmojiOpen(o)}>
            <PopoverTrigger
              title="Emoji"
              onMouseDown={(e) => e.preventDefault()}
              className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-app-accent hover:bg-app-hover-strong"
            >
              <Smile size={19} strokeWidth={1.9} />
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              sideOffset={8}
              className="w-[352px] overflow-hidden rounded-2xl border-0 bg-transparent p-0 shadow-[var(--app-shadow-lg)]"
            >
              <EmojiPickerPopup onPick={insertEmoji} />
            </PopoverContent>
          </Popover>
        </div>

        {/* Send when there's content; the quick-emoji Like otherwise */}
        {hasText || (attachable && composerAttachment) || isUploading || transcoding ? (
          <button
            onClick={submit}
            disabled={!canSend}
            title="Send"
            className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full"
            style={{
              background: canSend ? "var(--sent-grad)" : "var(--panel-hover)",
              color: canSend ? "#fff" : "var(--app-faint)",
              cursor: canSend ? "pointer" : "not-allowed",
            }}
          >
            <Send size={16} strokeWidth={2} />
          </button>
        ) : (
          <button
            onClick={sendLike}
            title={`Send a ${likeEmoji}`}
            className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-[22px] leading-none hover:bg-app-hover"
          >
            {likeEmoji}
          </button>
        )}
      </div>

      {attachable && (
        <>
          <input
            ref={mediaRef}
            type="file"
            accept="image/*,video/*"
            hidden
            onChange={(e) => onPickFile(e, true)}
          />
          <input ref={fileRef} type="file" hidden onChange={(e) => onPickFile(e, false)} />
        </>
      )}
    </div>
  );
}

export function Composer({
  groupId,
  inThread = false,
}: {
  groupId: string;
  inThread?: boolean;
}) {
  const { drafts, editing, threadFor } = useChatStore(
    useShallow((s) => ({
      drafts: s.drafts,
      editing: s.editing,
      threadFor: s.threadFor,
    })),
  );
  const editingMessage = useEditingMessage();
  // Edit mode is claimed by exactly one composer: the group composer for
  // top-level messages, the open thread's composer for replies.
  const editingHere =
    editing &&
    editing.groupId === groupId &&
    (inThread ? editing.parentId === threadFor : !editing.parentId)
      ? editingMessage
      : null;
  // Rehydrate the group composer with its saved draft (the editor remounts
  // per group via `key`, so this only runs on entry). Threads don't persist.
  // Edit mode seeds the message being edited instead (rich here; plain text is
  // inserted by ComposerInner's edit effect).
  const draftState = inThread ? undefined : drafts[groupId]?.rich;
  const seedState = editingHere ? editingHere.rich : draftState;
  const initialConfig = {
    namespace: "composer",
    theme: EDITOR_THEME,
    nodes: [...EDITOR_NODES],
    onError: (e: Error) => console.error(e),
    ...(seedState ? { editorState: seedState } : {}),
  };
  return (
    // key per group/thread so switching contexts gives a fresh editor;
    // entering/leaving edit mode also remounts (fresh seed, draft untouched).
    <LexicalComposer
      key={
        groupId +
        (inThread ? ":thread" : "") +
        (editingHere ? `:edit:${editing!.msgId}` : "")
      }
      initialConfig={initialConfig}
    >
      <ComposerInner
        groupId={groupId}
        inThread={inThread}
        editingMsg={editingHere}
      />
    </LexicalComposer>
  );
}
