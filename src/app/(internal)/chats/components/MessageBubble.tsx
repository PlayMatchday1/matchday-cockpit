"use client";

// Single message in the conversation pane. Inbound = white bubble
// with cream-line border, dark green text, asymmetric tail-rounded
// bottom-left. Outbound = mint bubble, dark green text (NOT white —
// mint is loud enough that dark text reads cleanly), tail bottom-
// right. Below each bubble: small "operator · time · status" line
// using the hoisted DeliveryStatusLabel.
//
// Media render branches:
//   image     — inline <img>, click opens full-size in new tab
//   video     — <video controls preload=metadata>
//   audio     — <audio controls preload=metadata> with "Voice note"
//               or "Audio" label
//   document  — file-icon card with filename, size, download link
//   sticker   — standalone <img>, NO bubble background (per WhatsApp
//               UX where stickers float without a bubble frame)
// Each falls back to a text "(failed to load)" line if the signed
// URL becomes unreachable. Caption (msg.body) renders below the
// media when non-empty for image/video/document; audio + sticker
// don't carry captions per Meta spec.

import { useState } from "react";
import { Download, FileText } from "lucide-react";
import DeliveryStatusLabel, {
  type DeliveryStatus,
} from "@/components/DeliveryStatusLabel";
import type { CrmChannel } from "@/components/ChannelChip";

// Shape matches the row returned by /api/crm/threads/[id] and
// /api/crm/send. All DB columns are present so this type is
// structurally identical to the parent's Message type — required
// for function-variance compatibility when the parent passes a
// `(m: Message) => void` callback into Composer's onSent prop.
export type ConversationMessage = {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  body: string;
  sent_at: string;
  sent_by_user_id: string | null;
  telnyx_message_id: string | null;
  external_message_id: string | null;
  segment_count: number;
  channel: CrmChannel;
  delivery_status: DeliveryStatus;
  delivery_status_updated_at: string | null;
  sender?: { email: string; full_name: string | null } | null;
  media_kind: "image" | "video" | "audio" | "document" | "sticker" | null;
  media_filename?: string | null;
  media_size_bytes?: number | null;
  signed_media_url?: string | null;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function MessageBubble({
  msg,
  className,
}: {
  msg: ConversationMessage;
  // Parent-supplied margin class. The conversation list uses
  // direction-aware spacing (mt-3 same-direction, mt-6 direction-
  // switch, mt-0 right after a date divider). Defaults to mt-3.
  className?: string;
}) {
  const isInbound = msg.direction === "inbound";
  const senderLabel =
    msg.sender?.full_name?.trim() ||
    msg.sender?.email ||
    (msg.sent_by_user_id ? "operator" : null);

  // Asymmetric rounding produces a "tail" corner pointing at the
  // sender side. Inbound tail bottom-left, outbound tail bottom-
  // right. The other three corners stay fully rounded (rounded-2xl).
  const bubbleShape = isInbound
    ? "rounded-2xl rounded-bl-md"
    : "rounded-2xl rounded-br-md";
  const bubbleColor = isInbound
    ? "border border-cream-line bg-white text-deep-green"
    : "bg-mint text-deep-green";

  const hasSignedUrl = typeof msg.signed_media_url === "string";
  const isImage = msg.media_kind === "image" && hasSignedUrl;
  const isVideo = msg.media_kind === "video" && hasSignedUrl;
  const isAudio = msg.media_kind === "audio" && hasSignedUrl;
  const isDocument = msg.media_kind === "document" && hasSignedUrl;
  const isSticker = msg.media_kind === "sticker" && hasSignedUrl;
  const hasMedia = isImage || isVideo || isAudio || isDocument || isSticker;
  // Body slot renders when there is text to show — either a caption
  // on image/video/document, or a normal text-only message. Audio
  // and sticker bubbles skip it (Meta doesn't allow captions there;
  // and stickers don't use a bubble at all anyway).
  const showBody = !hasMedia || msg.body.length > 0;

  // Time/sender/status footer is shared by both render paths
  // (bubble + sticker) so extract it once.
  const footer = (
    <div className="mt-1 px-1 text-[10px] text-deep-green/50">
      {!isInbound && senderLabel && (
        <span className="mr-1 font-medium">{senderLabel} ·</span>
      )}
      <span>{formatTime(msg.sent_at)}</span>
      {!isInbound && msg.channel === "sms" && msg.segment_count > 1 && (
        <span> · {msg.segment_count} segments</span>
      )}
      {!isInbound && <DeliveryStatusLabel status={msg.delivery_status} />}
    </div>
  );

  // Stickers render OUTSIDE the bubble per WhatsApp's own UX. No
  // background, no border, no caption.
  if (isSticker) {
    return (
      <li
        className={`flex flex-col ${isInbound ? "items-start" : "items-end"} ${className ?? "mt-3"}`}
      >
        <MediaSticker src={msg.signed_media_url as string} />
        {footer}
      </li>
    );
  }

  return (
    <li
      className={`flex flex-col ${isInbound ? "items-start" : "items-end"} ${className ?? "mt-3"}`}
    >
      <div className={`max-w-[80%] overflow-hidden ${bubbleShape} ${bubbleColor}`}>
        {isImage && (
          <MediaImage
            src={msg.signed_media_url as string}
            alt="Image attachment"
          />
        )}
        {isVideo && <MediaVideo src={msg.signed_media_url as string} />}
        {isAudio && (
          <MediaAudio
            src={msg.signed_media_url as string}
            filename={msg.media_filename ?? null}
          />
        )}
        {isDocument && (
          <MediaDocument
            src={msg.signed_media_url as string}
            filename={msg.media_filename ?? null}
            sizeBytes={msg.media_size_bytes ?? null}
          />
        )}
        {showBody && (
          <div className="px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
            {msg.body}
          </div>
        )}
      </div>
      {footer}
    </li>
  );
}

// Inline image inside a bubble. Wrapping <a> opens the full-size
// image in a new tab. onError flips to a text fallback so a stale or
// 403 signed URL doesn't leave a broken-image icon.
function MediaImage({ src, alt }: { src: string; alt: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div className="px-3 py-2 text-xs italic text-deep-green/55">
        Image (failed to load)
      </div>
    );
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
      aria-label="Open image in new tab"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setErrored(true)}
        className="block h-auto max-w-xs"
      />
    </a>
  );
}

// Native HTML5 video player. preload=metadata fetches just enough to
// show duration without pulling the whole file. Controls handle play/
// pause/scrub natively across iOS and desktop browsers.
function MediaVideo({ src }: { src: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div className="px-3 py-2 text-xs italic text-deep-green/55">
        Video (failed to load)
      </div>
    );
  }
  return (
    <video
      controls
      preload="metadata"
      src={src}
      onError={() => setErrored(true)}
      className="block h-auto max-w-xs"
    />
  );
}

// Native HTML5 audio player. Label above ("Voice note" / "Audio") is
// keyed off the filename convention the webhook writes (voice-note.*
// for press-and-hold WhatsApp voice notes, audio.* for attached
// files).
function MediaAudio({
  src,
  filename,
}: {
  src: string;
  filename: string | null;
}) {
  const isVoice = (filename ?? "").startsWith("voice-note");
  return (
    <div className="px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-deep-green/55">
        {isVoice ? "Voice note" : "Audio"}
      </div>
      {/* The default <audio> controls UI is browser-styled and not
          themeable. Width capped at max-w-xs to match other media. */}
      <audio
        controls
        preload="metadata"
        src={src}
        className="mt-1 block w-full max-w-xs"
      />
    </div>
  );
}

// Document card: file icon + filename + size + download icon. Whole
// row is a link; the explicit Download icon is visual affordance.
// download attribute hints the browser to save rather than display
// (works for cross-origin URLs with same-origin signed URLs — our
// signed URLs come from Supabase Storage which sets Content-
// Disposition: attachment for download-flagged objects).
function MediaDocument({
  src,
  filename,
  sizeBytes,
}: {
  src: string;
  filename: string | null;
  sizeBytes: number | null;
}) {
  const name = filename ?? "document";
  const display = name.length > 30 ? `${name.slice(0, 29)}…` : name;
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      download={name}
      className="flex items-center gap-3 px-3 py-2 transition hover:bg-black/5"
      aria-label={`Download ${name}`}
    >
      <FileText
        aria-hidden
        className="h-8 w-8 shrink-0 text-deep-green/70"
        strokeWidth={1.5}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-deep-green">
          {display}
        </div>
        {typeof sizeBytes === "number" && sizeBytes > 0 && (
          <div className="text-[10px] text-deep-green/55">
            {formatBytes(sizeBytes)}
          </div>
        )}
      </div>
      <Download
        aria-hidden
        className="h-4 w-4 shrink-0 text-deep-green/55"
        strokeWidth={1.75}
      />
    </a>
  );
}

// Standalone sticker. No bubble background, no caption. Animated
// webp stickers play automatically in modern Safari and Chrome.
function MediaSticker({ src }: { src: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div className="px-1 text-xs italic text-deep-green/55">
        Sticker (failed to load)
      </div>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt="Sticker"
      loading="lazy"
      onError={() => setErrored(true)}
      className="h-32 w-32 object-contain"
    />
  );
}
