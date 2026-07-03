"use client";

import { Star } from "lucide-react";

// Single thread row in the Player Chat inbox. iMessage layout:
// circular initials avatar, name + timestamp on the top line,
// message preview + unread dot below, small metadata footer
// (city, "Historical"). No yellow tint, no left stripe, no
// chat-bubble overlay on the avatar. Unread is signaled by font
// weight on name + preview plus a small green dot on the right.
//
// Selection state (active=true) on the desktop split view gets a
// faint cream-soft bg so the selected row stays visually anchored
// in the inbox column.

export type InboxRowThread = {
  id: string;
  phone_number: string;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  last_message_direction: "inbound" | "outbound" | null;
  player: {
    first_name: string | null;
    last_name: string | null;
    preferable_city_normalized: string | null;
    is_member?: boolean | null;
  } | null;
  // Server-computed unread state per the assignment-aware rule. The
  // client never recomputes the rule — it just renders this flag and
  // optimistically patches on mark-read.
  is_unread: boolean;
  // Per-viewer follow-up star. Server-computed; optimistically patched
  // on toggle.
  is_follow_up: boolean;
};

function fullName(t: InboxRowThread): string {
  const p = t.player;
  if (!p) return t.phone_number;
  const first = p.first_name?.trim() ?? "";
  const last = p.last_name?.trim() ?? "";
  const out = `${first} ${last}`.trim();
  return out || t.phone_number;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function cityForRow(t: InboxRowThread): string | null {
  return t.player?.preferable_city_normalized ?? null;
}

// Compact timestamp: "now", "5m", "3h", "2d", or a M/D date.
function timeAgoCompact(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diff < 45) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
  });
}

export default function InboxRow({
  thread,
  active,
  onSelect,
  onToggleFollowUp,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  thread: InboxRowThread;
  active: boolean;
  onSelect: () => void;
  onToggleFollowUp: () => void;
  // Bulk-select checkbox (Open view, admins). When selectable, a
  // checkbox renders at the left of the row; ticking it never opens
  // the thread.
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const name = fullName(thread);
  const initials = initialsOf(name);
  const city = cityForRow(thread);
  const isMember = thread.player?.is_member === true;
  const timeLabel = timeAgoCompact(thread.last_message_at);
  const rawPreview = thread.last_message_preview ?? "(no messages)";
  const preview =
    thread.last_message_direction === "outbound"
      ? `You: ${rawPreview}`
      : rawPreview;

  const metaBits: string[] = [];
  if (city) metaBits.push(city);
  if (isMember) metaBits.push("Member");
  if (thread.match_ambiguous) metaBits.push("Historical");

  return (
    <li className="relative flex items-stretch">
      {selectable && (
        <label
          className="flex shrink-0 cursor-pointer items-center pl-3 pr-1"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect?.();
            }}
            aria-label={
              selected ? "Deselect conversation" : "Select conversation"
            }
            className="h-4 w-4 rounded border-deep-green/30 text-deep-green accent-deep-green focus:ring-deep-green/40"
          />
        </label>
      )}
      <button
        type="button"
        onClick={onSelect}
        style={{ touchAction: "manipulation" }}
        className={`flex min-w-0 flex-1 items-center gap-3 py-3 pr-11 text-left transition ${
          selectable ? "pl-2" : "pl-3 sm:pl-4"
        } ${active ? "bg-cream-soft" : "bg-white hover:bg-cream-soft/60"}`}
      >
        <span
          aria-hidden
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream-line text-[13px] font-medium text-muted"
        >
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`min-w-0 truncate text-[15px] text-deep-green ${
                thread.is_unread ? "font-medium" : "font-normal"
              }`}
            >
              {name}
            </span>
            <span className="shrink-0 text-[12px] text-deep-green/45">
              {timeLabel}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span
              className={`min-w-0 truncate text-[13px] ${
                thread.is_unread
                  ? "font-medium text-deep-green"
                  : "font-normal text-deep-green/55"
              }`}
            >
              {preview}
            </span>
            {thread.is_unread && (
              <span
                aria-label="Unread"
                className="h-2 w-2 shrink-0 rounded-full bg-deep-green"
              />
            )}
          </div>
          {metaBits.length > 0 && (
            <div className="mt-1 truncate text-[11px] text-deep-green/45">
              {metaBits.join(" · ")}
            </div>
          )}
        </div>
      </button>
      {/* Follow-up star — a sibling button (not nested in the select
          button, which would be invalid HTML). stopPropagation guards
          against any wrapper handler; tapping it toggles the flag
          without opening the thread. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFollowUp();
        }}
        aria-label={
          thread.is_follow_up ? "Remove follow-up flag" : "Mark for follow up"
        }
        aria-pressed={thread.is_follow_up}
        style={{ touchAction: "manipulation" }}
        className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-deep-green/35 transition hover:bg-cream-line/60 hover:text-deep-green"
      >
        <Star
          aria-hidden
          size={16}
          strokeWidth={1.75}
          className={thread.is_follow_up ? "fill-coral text-coral" : ""}
        />
      </button>
    </li>
  );
}
