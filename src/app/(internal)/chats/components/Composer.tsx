"use client";

// Composer at the bottom of the conversation pane. Two modes:
//
//   text mode (default): paperclip + auto-expanding textarea + round
//                        mint send button. Enter to send, Shift+Enter
//                        for newline. SMS-only segment counter under
//                        the row.
//
//   image mode (after picking a file via the paperclip): thumbnail +
//                        filename · size + caption textarea + Send.
//                        X button cancels and returns to text mode.
//
// WhatsApp 24-hour window: when expired, BOTH modes are disabled and
// the muted info banner explains why. Server enforces the same rule
// and 422s if violated; the client check just avoids the round-trip.
//
// Image picker: <input type="file" accept="image/jpeg,image/png" />.
// Client-side validation: must be JPEG or PNG, <= 5 MB. Server
// re-validates on /api/crm/send-media.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CrmChannel } from "@/components/ChannelChip";
import type { ConversationMessage } from "./MessageBubble";

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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const CAPTION_MAX = 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// Same as bearerHeaders but without Content-Type — fetch sets the
// multipart boundary automatically when body is FormData.
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

  // Image-mode state. file is the picked Blob; caption is its
  // optional caption. previewUrl is the object URL we create for the
  // thumbnail and revoke on unmount/change.
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Image-mode supports JPEG/PNG only and only on WhatsApp threads.
  const canSendImage = channel === "whatsapp" && !whatsappWindowExpired;

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(240, Math.max(80, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  // Manage the object URL lifecycle for the thumbnail. Recreate when
  // the file changes; revoke on unmount or replacement.
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
  }, [threadId]);

  const budget = useMemo(() => smsBudget(body), [body]);

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

  // ---------------- image-mode flow ----------------
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
      if (!ALLOWED_IMAGE_TYPES.has(f.type)) {
        setError("Only JPEG or PNG images are supported.");
        return;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        setError("Image must be 5 MB or smaller.");
        return;
      }
      if (f.size === 0) {
        setError("Image is empty.");
        return;
      }
      setError(null);
      setFile(f);
      setCaption("");
    },
    [],
  );

  const cancelImage = useCallback(() => {
    setFile(null);
    setCaption("");
    setError(null);
  }, []);

  const submitImage = useCallback(async () => {
    if (sending || !file) return;
    if (caption.length > CAPTION_MAX) {
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
      form.append("caption", caption);
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
      // Reset to text mode after successful send.
      setFile(null);
      setCaption("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep file + caption so operator can retry without re-picking.
    } finally {
      setSending(false);
    }
  }, [file, caption, threadId, sending, onSent]);

  // ---------------- render ----------------
  return (
    <div className="border-t border-cream-line bg-cream px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4">
      {whatsappWindowExpired && (
        <div className="mb-2 rounded-md border border-cream-line bg-cream-soft px-2 py-1.5 text-[11px] text-deep-green/65">
          <span aria-hidden className="mr-1">
            ⓘ
          </span>
          WhatsApp session expired — player must message first to reopen the
          24-hour window.
        </div>
      )}

      {file && previewUrl ? (
        <ImagePreview
          file={file}
          previewUrl={previewUrl}
          caption={caption}
          sending={sending}
          error={error}
          onCaptionChange={setCaption}
          onCancel={cancelImage}
          onSend={() => void submitImage()}
        />
      ) : (
        <>
          <div className="flex items-end gap-2">
            {canSendImage && (
              <button
                type="button"
                onClick={openFilePicker}
                aria-label="Attach image"
                disabled={sending || !appUserId}
                style={{ touchAction: "manipulation" }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
              >
                <Paperclip aria-hidden className="h-5 w-5" strokeWidth={1.75} />
              </button>
            )}
            <textarea
              ref={taRef}
              value={body}
              disabled={disabled}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className="block flex-1 resize-none rounded-2xl border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft disabled:text-deep-green/40"
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

      {/* Hidden file picker — image-mode only on WhatsApp threads. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={onFilePicked}
      />
    </div>
  );
}

// Image-mode preview panel. Replaces the textarea row while a file
// is selected. Caption is optional; Send is enabled whenever a file
// is picked and no send is in flight.
function ImagePreview({
  file,
  previewUrl,
  caption,
  sending,
  error,
  onCaptionChange,
  onCancel,
  onSend,
}: {
  file: File;
  previewUrl: string;
  caption: string;
  sending: boolean;
  error: string | null;
  onCaptionChange: (s: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div className="relative rounded-md border border-cream-line bg-white p-3">
      <button
        type="button"
        onClick={onCancel}
        disabled={sending}
        aria-label="Remove image"
        style={{ touchAction: "manipulation" }}
        className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-full text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
      >
        <X aria-hidden className="h-4 w-4" strokeWidth={2} />
      </button>

      <div className="flex gap-3 pr-9">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={previewUrl}
          alt="Attachment preview"
          className="h-20 w-20 shrink-0 rounded object-cover"
        />
        <div className="min-w-0 flex-1 pt-1">
          <div className="truncate text-xs font-medium text-deep-green">
            {file.name || "attachment"}
          </div>
          <div className="text-[10px] text-deep-green/55">
            {formatBytes(file.size)}
          </div>
        </div>
      </div>

      <textarea
        value={caption}
        disabled={sending}
        onChange={(e) => onCaptionChange(e.target.value)}
        placeholder="Add a caption (optional)"
        maxLength={CAPTION_MAX}
        className="mt-2 block w-full resize-none rounded-2xl border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft disabled:text-deep-green/40"
        style={{ minHeight: 44, maxHeight: 120 }}
      />

      {error && (
        <div className="mt-2 text-[11px] text-coral-hover">{error}</div>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-deep-green/55">
        <span>
          <span className="font-medium text-deep-green/75">
            {caption.length}
          </span>{" "}
          / {CAPTION_MAX} chars
        </span>
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
