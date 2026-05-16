// Initials avatar for Player Chat — circular, color rotates by hash
// of a stable seed (phone_number or player id). Channel-icon slot
// overlays the bottom-right for the inbox row (SMS / WhatsApp).
//
// Colors drawn from the existing brand palette only (no new tokens).
// The hash is deterministic so the same player keeps the same color
// across renders.

import { MessageCircle, MessageSquare } from "lucide-react";

import type { CrmChannel } from "./ChannelChip";

const PALETTE = [
  // Background / text pairs picked for AA contrast on the cream
  // canvas. Tokens come from globals.css @theme inline.
  { bg: "bg-deep-green", text: "text-cream" },
  { bg: "bg-mint", text: "text-deep-green" },
  { bg: "bg-blue-info", text: "text-cream" },
  { bg: "bg-purple-done", text: "text-cream" },
  { bg: "bg-coral", text: "text-cream" },
  { bg: "bg-gold", text: "text-deep-green" },
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function initialsFrom(
  name: string | null | undefined,
  fallback: string,
): string {
  const trimmed = name?.trim();
  if (!trimmed) return fallback.slice(0, 2).toUpperCase();
  const parts = trimmed.split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  const out = (first + last).toUpperCase();
  return out || fallback.slice(0, 2).toUpperCase();
}

const SIZE: Record<"sm" | "md" | "lg", { wrap: string; text: string; channel: string }> = {
  sm: { wrap: "h-8 w-8", text: "text-[11px]", channel: "h-3.5 w-3.5 -right-0.5 -bottom-0.5" },
  md: { wrap: "h-10 w-10", text: "text-xs", channel: "h-4 w-4 -right-0.5 -bottom-0.5" },
  lg: { wrap: "h-14 w-14", text: "text-base", channel: "h-5 w-5 -right-1 -bottom-1" },
};

export default function PlayerAvatar({
  name,
  seed,
  channel,
  size = "md",
  isMember,
}: {
  // Display name to derive initials from. Null falls back to seed.
  name: string | null | undefined;
  // Stable hash seed — phone_number or numeric player id. Determines
  // the palette slot so the same player keeps the same color.
  seed: string;
  // Optional channel badge to overlay on the bottom-right. When
  // omitted, no badge is rendered.
  channel?: CrmChannel | null;
  size?: "sm" | "md" | "lg";
  // Member players get a thin mint ring instead of the default
  // none. Visual cue that's also reinforced by the Member pill in
  // the inbox row, so non-redundant only when the pill is hidden
  // (small avatars in dense layouts).
  isMember?: boolean;
}) {
  const slot = PALETTE[hashString(seed) % PALETTE.length];
  const initials = initialsFrom(name, seed);
  const s = SIZE[size];
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full font-bold ${s.wrap} ${slot.bg} ${slot.text} ${
        isMember ? "ring-2 ring-mint" : ""
      }`}
      aria-hidden
    >
      <span className={s.text}>{initials}</span>
      {channel === "whatsapp" && (
        <span
          className={`absolute inline-flex items-center justify-center rounded-full bg-mint text-deep-green ring-2 ring-cream ${s.channel}`}
          aria-label="WhatsApp"
        >
          <MessageCircle aria-hidden className="h-2.5 w-2.5" strokeWidth={2.75} />
        </span>
      )}
      {channel === "sms" && (
        <span
          className={`absolute inline-flex items-center justify-center rounded-full bg-cream text-deep-green/70 ring-2 ring-cream ${s.channel}`}
          aria-label="SMS"
        >
          <MessageSquare aria-hidden className="h-2.5 w-2.5" strokeWidth={2.75} />
        </span>
      )}
    </span>
  );
}
