"use client";

// Single message in the conversation pane. Inbound = white bubble
// with cream-line border, dark green text, asymmetric tail-rounded
// bottom-left. Outbound = mint bubble, dark green text (NOT white —
// mint is loud enough that dark text reads cleanly), tail bottom-
// right. Below each bubble: small "operator · time · status" line
// using the hoisted DeliveryStatusLabel.
//
// Media: when media_kind === "image" and signed_media_url is set the
// bubble renders an inline <img> at the top with the caption (if any)
// below. Click opens the full-size image in a new tab. Other media
// kinds (video, audio, document, sticker) currently fall through to
// the placeholder text the webhook wrote on the body column; PR D
// extends the bubble to render them inline.

import { useState } from "react";
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
  signed_media_url?: string | null;
};

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

  const isImage =
    msg.media_kind === "image" && typeof msg.signed_media_url === "string";
  // Body slot renders when there is text to show — either an image
  // caption or a normal text message. Image-only bubbles skip it so
  // the image fills the bubble corner-to-corner.
  const showBody = !isImage || msg.body.length > 0;

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
        {showBody && (
          <div className="px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
            {msg.body}
          </div>
        )}
      </div>
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
