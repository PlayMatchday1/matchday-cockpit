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
import { Download, FileText, Sparkles } from "lucide-react";
import Linkify from "linkify-react";
import DeliveryStatusLabel, {
  type DeliveryStatus,
} from "@/components/DeliveryStatusLabel";
import type { CrmChannel } from "@/components/ChannelChip";
import { LINKIFY_OPTIONS } from "@/lib/linkify";

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
  media_kind:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "reaction"
    | null;
  media_filename?: string | null;
  media_size_bytes?: number | null;
  signed_media_url?: string | null;
  // Set only for media_kind === "reaction" — wamid of the parent
  // outbound message being reacted to. Surfaced by /api/crm/threads/
  // [id]; v1 doesn't use it to position the note inline, but it's
  // here so a v2 "render under the parent bubble" change has the
  // data it needs without another wire change.
  reaction_target_wamid?: string | null;
  // The out-of-hours acknowledgment and template sends. The Claude draft card reads both to tell
  // "the player is waiting" from "we already answered".
  is_auto_reply?: boolean;
  template_name?: string | null;
  /** Set on an auto-send: no person typed it. The footer reads "Agent". */
  auto_sent_draft_id?: string | null;
};

// A muted tone of the MatchDay green token, shared with the inbox row's "Agent:" prefix.
export const AGENT_GREEN = "color-mix(in srgb, var(--color-mint) 58%, #5d6f66)";

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
  variant,
  onOpenImage,
}: {
  msg: ConversationMessage;
  // PLAYER CHATS 2.0 (Figma 20851:45): compact bubbles — the player's white with a border, ours
  // neutral grey — with sender, time and delivery under ours, and images as ~280px thumbnails that
  // open in the page's viewer (onOpenImage) instead of a new tab. Omitted → the old look, unchanged.
  variant?: "v2";
  onOpenImage?: (src: string) => void;
  // Parent-supplied margin class. The conversation list uses
  // direction-aware spacing (mt-3 same-direction, mt-6 direction-
  // switch, mt-0 right after a date divider). Defaults to mt-3.
  className?: string;
}) {
  const isInbound = msg.direction === "inbound";
  const isAgent = !isInbound && !!msg.auto_sent_draft_id;
  const senderLabel =
    isAgent ? "Agent" :
    msg.sender?.full_name?.trim() ||
    msg.sender?.email ||
    (msg.sent_by_user_id ? "operator" : null);

  // Asymmetric rounding produces a "tail" corner pointing at the
  // sender side. Inbound tail bottom-left, outbound tail bottom-
  // right. The other three corners stay fully rounded (rounded-2xl).
  const v2 = variant === "v2";
  const bubbleShape = v2
    ? "rounded-[12px]"
    : isInbound
      ? "rounded-2xl rounded-bl-md"
      : "rounded-2xl rounded-br-md";
  const bubbleColor = v2
    ? isInbound
      ? "border border-[#e3e3db] bg-white text-[#13241d]"
      : "bg-[#e9efec] text-[#13241d]"
    : isInbound
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
  // 2.0: "MatchDay · automatic · 5:45 PM" for an automatic message (Figma 20851:214).
  const v2Sender = !isInbound && msg.is_auto_reply && !isAgent ? "MatchDay · automatic" : senderLabel;
  const footer = v2 ? (
    <div className="mt-[3px] text-[11px] text-[#9aa39f]" data-testid="crm-message-meta">
      {!isInbound && v2Sender && (
        <span className="mr-1" data-testid={isAgent ? "crm-agent-sender" : undefined} style={isAgent ? { color: AGENT_GREEN } : undefined}>
          {isAgent && <Sparkles aria-hidden className="mr-0.5 inline h-2.5 w-2.5 -translate-y-px" strokeWidth={2.2} />}
          {v2Sender} ·
        </span>
      )}
      <span>{formatTime(msg.sent_at)}</span>
      {!isInbound && msg.channel === "sms" && msg.segment_count > 1 && (
        <span> · {msg.segment_count} segments</span>
      )}
      {!isInbound && <DeliveryStatusLabel status={msg.delivery_status} />}
    </div>
  ) : (
    <div className="mt-1 px-1 text-[10px] text-deep-green/50">
      {!isInbound && senderLabel && (
        <span className="mr-1 font-medium" data-testid={isAgent ? "crm-agent-sender" : undefined} style={isAgent ? { color: AGENT_GREEN } : undefined}>
          {isAgent && <Sparkles aria-hidden className="mr-0.5 inline h-2.5 w-2.5 -translate-y-px" strokeWidth={2.2} />}
          {senderLabel} ·
        </span>
      )}
      <span>{formatTime(msg.sent_at)}</span>
      {!isInbound && msg.channel === "sms" && msg.segment_count > 1 && (
        <span> · {msg.segment_count} segments</span>
      )}
      {!isInbound && <DeliveryStatusLabel status={msg.delivery_status} />}
    </div>
  );

  // Reactions render as a small italic note, NO bubble chrome and
  // NO footer. V1 keeps the placement simple (just inline at
  // direction-aligned edge); v2 can re-render the note adjacent to
  // the target bubble using reaction_target_wamid.
  if (msg.media_kind === "reaction") {
    return (
      <li
        className={`flex ${isInbound ? "items-start" : "items-end"} ${className ?? "mt-3"} flex-col`}
      >
        <div className="px-3 py-1 text-xs italic text-deep-green/60">
          {msg.body}
        </div>
      </li>
    );
  }

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
      data-testid="crm-message"
      data-direction={msg.direction}
      data-delivery={msg.delivery_status ?? ""}
      className={`flex flex-col ${isInbound ? "items-start" : "items-end"} ${className ?? "mt-3"}`}
    >
      <div className={`${v2 ? "max-w-[min(560px,85%)]" : "max-w-[80%]"} overflow-hidden ${bubbleShape} ${bubbleColor}`}>
        {isImage && (
          <MediaImage
            src={msg.signed_media_url as string}
            alt="Image attachment"
            onOpen={v2 ? onOpenImage : undefined}
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
          <div className={v2 ? "px-3 py-2 text-[14px] leading-[1.45] whitespace-pre-wrap" : "px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap"}>
            <Linkify options={LINKIFY_OPTIONS}>{msg.body}</Linkify>
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
function MediaImage({ src, alt, onOpen }: { src: string; alt: string; onOpen?: (src: string) => void }) {
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (errored) {
    return (
      <div className="px-3 py-2 text-xs italic text-deep-green/55">
        Image (failed to load)
      </div>
    );
  }
  if (onOpen) {
    // 2.0: a ~280px thumbnail; clicking opens the page's viewer.
    return (
      <button type="button" onClick={() => onOpen(src)} className="block" aria-label="Enlarge image" data-testid="crm-image-thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setErrored(true)}
          className={`block w-[280px] max-w-full ${loaded ? "h-auto" : "h-[180px] bg-[#f3f3ef] object-cover"}`} />
      </button>
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
