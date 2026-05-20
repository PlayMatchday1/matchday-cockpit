"use client";

// Composer at the bottom of the conversation pane. Two modes:
//
//   text mode (default): paperclip + auto-expanding textarea + round
//                        mint send button. Enter to send, Shift+Enter
//                        for newline. SMS-only segment counter under
//                        the row.
//
//   media mode (after picking a file via the paperclip, drag-drop,
//                        or Cmd+V paste): kind-aware preview block
//                        (thumbnail for image, inline player for
//                        video, file-icon card for audio + document)
//                        + optional caption textarea + Send. X
//                        cancels back to text mode.
//
// Three entry points for selecting a file, all routed through one
// shared onFileSelected helper:
//   1. Paperclip → <input type="file"> picker
//   2. Drag-and-drop onto the composer (desktop)
//   3. Cmd+V paste into either textarea (desktop)
//
// Per-kind rules (mirrors src/lib/whatsappMediaKind.ts):
//   image     JPEG/PNG, ≤ 5 MB.   Client compresses to fit.
//   video     MP4/3GPP, ≤ 16 MB.  iOS .mov rejected with conversion hint.
//   audio     AAC/MP3/MP4/AMR/OGG, ≤ 16 MB. NO caption (Meta spec).
//   document  Broad MIME, ≤ 100 MB.
// Server (/api/crm/send-media) re-validates the same rules.
//
// Client-side image compression: iPhone camera roll photos routinely
// exceed 5 MB. Before validation we resize images to a 1920 px
// longest-edge JPEG and walk a quality ladder (0.85 → 0.7 → 0.55 →
// 0.4) until the result is under 5 MB. Skipped for non-image kinds.
//
// WhatsApp 24-hour window: when expired, BOTH modes are disabled and
// the muted info banner explains why. Server enforces the same rule
// and 422s if violated; the client check just avoids the round-trip.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, FileText, MessageSquareText, Music, Paperclip, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CrmChannel } from "@/components/ChannelChip";
import type { ConversationMessage } from "./MessageBubble";
import {
  classifyOutboundMime,
  COMPOSER_ACCEPT_ATTR,
  MEDIA_BYTE_LIMITS,
  type OutboundMediaKind,
} from "@/lib/whatsappMediaKind";
import { formatBytes, maybeCompressImage } from "@/lib/imageCompression";
import TemplatesPicker from "./TemplatesPicker";

const GSM7_RX =
  /^[\n\rA-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà€\\[\]{}|~^]*$/;

function smsBudget(body: string): {
  encoding: "gsm7" | "ucs2";
  segmentSize: number;
  segments: number;
} {
  const encoding = GSM7_RX.test(body) ? "gsm7" : "ucs2";
  const segmentSize = encoding === "gsm7" ? 160 : 70;
  const len = body.length;
  const segments = len === 0 ? 0 : Math.ceil(len / segmentSize);
  return { encoding, segmentSize, segments };
}

const MAX_IMAGE_BYTES = MEDIA_BYTE_LIMITS.image;
const CAPTION_MAX = 1024;

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function bearerHeadersMultipart(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

export default function Composer({
  threadId,
  appUserId,
  channel,
  whatsappWindowExpired,
  onSent,
}: {
  threadId: string;
  appUserId: string | null;
  channel: CrmChannel;
  whatsappWindowExpired: boolean;
  onSent: (m: ConversationMessage) => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Media-mode state. file is the picked Blob (image: post-
  // compression; others: as-picked). caption is the optional caption
  // — hidden in the UI for audio since Meta does not allow it.
  // previewUrl is the object URL used by the image/video preview.
  // originalSize is the pre-compression byte count for the
  // "compressed from X to Y" hint (image-only).
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [originalSize, setOriginalSize] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Media send only on WhatsApp threads inside the 24-hour window.
  const canSendMedia = channel === "whatsapp" && !whatsappWindowExpired;

  // Drag-and-drop state. dragCounterRef compensates for the React
  // dragenter/dragleave child-traversal flicker by tracking how many
  // active enter/leave pairs are outstanding.
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  // Canned-response picker. Visible on both channels; image templates
  // gate inside the picker based on canSendMedia.
  const [templatesOpen, setTemplatesOpen] = useState(false);

  // Kind is derived from the picked file's MIME at render time.
  const kind: OutboundMediaKind | null = useMemo(() => {
    if (!file) return null;
    const c = classifyOutboundMime(file.type);
    return c.ok ? c.kind : null;
  }, [file]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(240, Math.max(80, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  // Object URL for image/video previews. Audio + document don't need
  // one (they render a file-icon card), but creating it unconditionally
  // is cheap and keeps the cleanup logic single-pathed.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Reset both modes when switching threads.
  useEffect(() => {
    setBody("");
    setError(null);
    setFile(null);
    setCaption("");
    setOriginalSize(null);
    setDragActive(false);
    dragCounterRef.current = 0;
  }, [threadId]);

  const budget = useMemo(() => smsBudget(body), [body]);

  // ---------------- shared file-selection helper ----------------
  // All three entry points flow through this. Classifies MIME,
  // validates size against the per-kind cap, compresses for images,
  // then populates preview state. Does NOT touch caption — paste-
  // while-preview preserves the operator's typed caption.
  const onFileSelected = useCallback(async (picked: File): Promise<void> => {
    setError(null);
    if (picked.size === 0) {
      setError("File is empty.");
      return;
    }
    const c = classifyOutboundMime(picked.type);
    if (!c.ok) {
      setError(c.error);
      return;
    }

    let finalFile: File = picked;
    let originalBytes: number | null = null;

    // Compression only for images. Other kinds are passed through
    // verbatim — Meta accepts them up to the per-kind size cap.
    if (c.kind === "image") {
      try {
        const compressed = await maybeCompressImage(picked, MAX_IMAGE_BYTES);
        if (compressed) {
          finalFile = compressed;
          originalBytes = picked.size;
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to process image.",
        );
        return;
      }
    }

    const cap = MEDIA_BYTE_LIMITS[c.kind];
    if (finalFile.size > cap) {
      setError(
        c.kind === "image"
          ? "Image too large even after compression."
          : `${c.kind} exceeds ${cap / (1024 * 1024)} MB limit.`,
      );
      return;
    }

    setFile(finalFile);
    setOriginalSize(originalBytes);
  }, []);

  // ---------------- text-mode submit ----------------
  const disabled = sending || !appUserId || whatsappWindowExpired;
  const placeholder = !appUserId
    ? "Sign in to send."
    : whatsappWindowExpired
      ? "WhatsApp session expired — player must message first."
      : "Type a reply. Enter to send, Shift+Enter for newline.";

  const submitText = useCallback(async () => {
    if (sending) return;
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("No active session — sign in again.");
      setSending(false);
      return;
    }
    try {
      const res = await fetch("/api/crm/send", {
        method: "POST",
        headers,
        body: JSON.stringify({ thread_id: threadId, body }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        message?: ConversationMessage;
        error?: string;
        send_error?: string;
      };
      if (!res.ok) {
        throw new Error(j.send_error || j.error || `HTTP ${res.status}`);
      }
      if (j.message) onSent(j.message);
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [body, sending, threadId, onSent]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submitText();
      }
    },
    [submitText],
  );

  // ---------------- media-mode flow ----------------
  const openFilePicker = useCallback(() => {
    setError(null);
    fileInputRef.current?.click();
  }, []);

  const onFilePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      // Reset the input so picking the same file again still fires
      // onChange (browsers skip the event if value is unchanged).
      e.target.value = "";
      if (!f) return;
      void onFileSelected(f);
    },
    [onFileSelected],
  );

  const cancelMedia = useCallback(() => {
    setFile(null);
    setCaption("");
    setOriginalSize(null);
    setError(null);
  }, []);

  const submitMedia = useCallback(async () => {
    if (sending || !file || !kind) return;
    // Audio cannot carry captions; server will drop it but make the
    // intent obvious by clearing here too.
    const effectiveCaption = kind === "audio" ? "" : caption;
    if (effectiveCaption.length > CAPTION_MAX) {
      setError(`Caption exceeds ${CAPTION_MAX} chars.`);
      return;
    }
    setSending(true);
    setError(null);
    const headers = await bearerHeadersMultipart();
    if (!headers) {
      setError("No active session — sign in again.");
      setSending(false);
      return;
    }
    try {
      const form = new FormData();
      form.append("thread_id", threadId);
      form.append("file", file);
      form.append("caption", effectiveCaption);
      const res = await fetch("/api/crm/send-media", {
        method: "POST",
        headers,
        body: form,
      });
      const j = (await res.json().catch(() => ({}))) as {
        message?: ConversationMessage;
        error?: string;
        storage_uploaded?: boolean;
      };
      if (!res.ok) {
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      if (j.message) onSent(j.message);
      setFile(null);
      setCaption("");
      setOriginalSize(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep file + caption so operator can retry without re-picking.
    } finally {
      setSending(false);
    }
  }, [file, kind, caption, threadId, sending, onSent]);

  // ---------------- drag-and-drop ----------------
  const onDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canSendMedia) return;
      dragCounterRef.current += 1;
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes("Files")) {
        setDragActive(true);
      }
    },
    [canSendMedia],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canSendMedia) return;
      // preventDefault on dragover is required to enable drop.
      e.preventDefault();
    },
    [canSendMedia],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canSendMedia) return;
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setDragActive(false);
      }
    },
    [canSendMedia],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canSendMedia) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragActive(false);
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      // Any file kind: onFileSelected classifies and surfaces a
      // per-MIME error if the type isn't accepted.
      void onFileSelected(f);
    },
    [canSendMedia, onFileSelected],
  );

  // ---------------- paste-from-clipboard ----------------
  // Shared by the text-mode textarea and the caption textarea. Any
  // clipboard "file" item routes through onFileSelected. Text items
  // fall through so default paste still works.
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!canSendMedia) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind !== "file") continue;
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          void onFileSelected(f);
          return;
        }
      }
      // No file — let the default text paste behavior proceed.
    },
    [canSendMedia, onFileSelected],
  );

  // ---------------- render ----------------
  return (
    <div
      className="relative border-t border-cream-line bg-cream px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && canSendMedia && (
        <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-deep-green/40 bg-cream-soft/95 text-sm font-medium text-deep-green">
          Drop file here
        </div>
      )}

      {whatsappWindowExpired && (
        <div className="mb-2 rounded-md border border-cream-line bg-cream-soft px-2 py-1.5 text-[11px] text-deep-green/65">
          <span aria-hidden className="mr-1">
            ⓘ
          </span>
          WhatsApp session expired — player must message first to reopen the
          24-hour window.
        </div>
      )}

      {file && kind ? (
        <MediaPreview
          file={file}
          previewUrl={previewUrl}
          kind={kind}
          caption={caption}
          sending={sending}
          error={error}
          originalSize={originalSize}
          onCaptionChange={setCaption}
          onCancel={cancelMedia}
          onSend={() => void submitMedia()}
          onPaste={onPaste}
        />
      ) : (
        <>
          <div className="flex items-end gap-2">
            {canSendMedia && (
              <button
                type="button"
                onClick={openFilePicker}
                aria-label="Attach file"
                disabled={sending || !appUserId}
                style={{ touchAction: "manipulation" }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
              >
                <Paperclip aria-hidden className="h-5 w-5" strokeWidth={1.75} />
              </button>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setTemplatesOpen((o) => !o)}
                aria-label="Open templates"
                aria-pressed={templatesOpen}
                disabled={sending || !appUserId}
                style={{ touchAction: "manipulation" }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
              >
                <MessageSquareText
                  aria-hidden
                  className="h-5 w-5"
                  strokeWidth={1.75}
                />
              </button>
              <TemplatesPicker
                open={templatesOpen}
                onClose={() => setTemplatesOpen(false)}
                canSendMedia={canSendMedia}
                showImageGate={!canSendMedia}
                onPickText={(text) => {
                  setBody(text);
                  // Focus textarea after a tick so the value settles
                  // before caret placement.
                  setTimeout(() => taRef.current?.focus(), 0);
                }}
                onPickImage={(picked, captionText) => {
                  void (async () => {
                    await onFileSelected(picked);
                    setCaption(captionText);
                  })();
                }}
              />
            </div>
            <textarea
              ref={taRef}
              value={body}
              disabled={disabled}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={placeholder}
              // text-base (16px) instead of text-sm (14px). iOS Safari
              // auto-zooms on focus when an input's font-size is below
              // 16px; staying at or above 16px prevents the zoom + the
              // stale-viewport bug that pinned the bottom nav mid-screen.
              className="block flex-1 resize-none rounded-2xl border border-cream-line bg-white px-3 py-2 text-base text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft disabled:text-deep-green/40"
              style={{ minHeight: 44, maxHeight: 240 }}
            />
            <button
              type="button"
              onClick={() => void submitText()}
              disabled={
                sending || !body.trim() || !appUserId || whatsappWindowExpired
              }
              aria-label={sending ? "Sending message" : "Send message"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mint text-deep-green shadow-sm transition hover:bg-mint-hover disabled:opacity-40"
            >
              <ArrowUp aria-hidden className="h-5 w-5" strokeWidth={2.5} />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-deep-green/55">
            <div>
              <span className="font-medium text-deep-green/75">
                {body.length}
              </span>{" "}
              chars
              {channel === "sms" && (
                <>
                  {" · "}
                  {budget.encoding === "gsm7"
                    ? "GSM-7 (160/seg)"
                    : "UCS-2 (70/seg)"}
                  {" · "}
                  <span className="font-medium text-deep-green/75">
                    {budget.segments}
                  </span>{" "}
                  seg{budget.segments === 1 ? "" : "s"}
                </>
              )}
              {error && <span className="ml-2 text-coral-hover">{error}</span>}
            </div>
            <div className="text-[10px] text-deep-green/40">
              {channel === "whatsapp" ? "WhatsApp" : "SMS"}
            </div>
          </div>
        </>
      )}

      {/* Hidden file picker — broad accept covers image/video/audio
          and the common document MIMEs. The classifier is still the
          source of truth; the accept attribute is just a UX hint. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={COMPOSER_ACCEPT_ATTR}
        hidden
        onChange={onFilePicked}
      />
    </div>
  );
}

// Media-mode preview panel. Replaces the textarea row while a file
// is selected. Caption shown for image/video/document; hidden for
// audio per Meta spec. Image preview is a thumbnail; video preview
// is an inline player; audio + document show a file-icon card.
function MediaPreview({
  file,
  previewUrl,
  kind,
  caption,
  sending,
  error,
  originalSize,
  onCaptionChange,
  onCancel,
  onSend,
  onPaste,
}: {
  file: File;
  previewUrl: string | null;
  kind: OutboundMediaKind;
  caption: string;
  sending: boolean;
  error: string | null;
  originalSize: number | null;
  onCaptionChange: (s: string) => void;
  onCancel: () => void;
  onSend: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const showCaption = kind !== "audio";

  return (
    <div className="relative rounded-md border border-cream-line bg-white p-3">
      <button
        type="button"
        onClick={onCancel}
        disabled={sending}
        aria-label="Remove file"
        style={{ touchAction: "manipulation" }}
        className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
      >
        <X aria-hidden className="h-4 w-4" strokeWidth={2} />
      </button>

      <div className="flex gap-3 pr-9">
        <PreviewThumb kind={kind} previewUrl={previewUrl} />
        <div className="min-w-0 flex-1 pt-1">
          <div className="truncate text-xs font-medium text-deep-green">
            {file.name || "attachment"}
          </div>
          <div className="text-[10px] text-deep-green/55">
            {formatBytes(file.size)} ·{" "}
            {kind === "image"
              ? "Image"
              : kind === "video"
                ? "Video"
                : kind === "audio"
                  ? "Audio file"
                  : "Document"}
          </div>
          {originalSize !== null && (
            <div className="text-[10px] text-deep-green/45">
              compressed from {formatBytes(originalSize)} to{" "}
              {formatBytes(file.size)}
            </div>
          )}
        </div>
      </div>

      {showCaption && (
        <textarea
          value={caption}
          disabled={sending}
          onChange={(e) => onCaptionChange(e.target.value)}
          onPaste={onPaste}
          placeholder="Add a caption (optional)"
          maxLength={CAPTION_MAX}
          // text-base for the same iOS auto-zoom reason as the text-mode
          // textarea above.
          className="mt-2 block w-full resize-none rounded-2xl border border-cream-line bg-white px-3 py-2 text-base text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft disabled:text-deep-green/40"
          style={{ minHeight: 44, maxHeight: 120 }}
        />
      )}

      {error && (
        <div className="mt-2 text-[11px] text-coral-hover">{error}</div>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-deep-green/55">
        {showCaption ? (
          <span>
            <span className="font-medium text-deep-green/75">
              {caption.length}
            </span>{" "}
            / {CAPTION_MAX} chars
          </span>
        ) : (
          <span className="italic text-deep-green/45">
            No caption — WhatsApp does not support captions on audio.
          </span>
        )}
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          style={{ touchAction: "manipulation" }}
          className="inline-flex h-11 items-center justify-center gap-1.5 rounded-full bg-mint px-4 text-sm font-medium text-deep-green shadow-sm transition hover:bg-mint-hover disabled:opacity-40"
        >
          <ArrowUp aria-hidden className="h-4 w-4" strokeWidth={2.5} />
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// Kind-aware preview thumbnail. Image and video render the actual
// pixels via the object URL; audio and document show a fixed-size
// icon card so the operator can see what they're about to send
// without paying preview-load cost.
function PreviewThumb({
  kind,
  previewUrl,
}: {
  kind: OutboundMediaKind;
  previewUrl: string | null;
}) {
  if (kind === "image" && previewUrl) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={previewUrl}
        alt="Attachment preview"
        className="h-20 w-20 shrink-0 rounded object-cover"
      />
    );
  }
  if (kind === "video" && previewUrl) {
    return (
      <video
        src={previewUrl}
        controls
        preload="metadata"
        className="h-20 w-32 shrink-0 rounded bg-black object-contain"
      />
    );
  }
  if (kind === "audio") {
    return (
      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded bg-cream-soft text-deep-green/70">
        <Music aria-hidden className="h-8 w-8" strokeWidth={1.5} />
      </div>
    );
  }
  // document
  return (
    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded bg-cream-soft text-deep-green/70">
      <FileText aria-hidden className="h-8 w-8" strokeWidth={1.5} />
    </div>
  );
}
