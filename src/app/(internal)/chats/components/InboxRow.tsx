"use client";

import { Star } from "lucide-react";
import {
  awaitingReplyState,
  awaitingAgeLabel,
  type AwaitingTier,
} from "@/lib/awaitingReply";

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
  // Last outbound was a WhatsApp template → answered row reads
  // "template sent" instead of "replied".
  last_message_is_template: boolean;
  status: "open" | "closed";
  player: {
    first_name: string | null;
    last_name: string | null;
    preferable_city_normalized: string | null;
    is_member?: boolean | null;
  } | null;
  // Current assignee — surfaced on the row so it's clear whose queue a
  // waiting thread sits in.
  assignee: { full_name: string | null; email: string } | null;
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

// Per-tier visual tokens for the awaiting chip + left edge. Green =
// fresh, amber = free-reply window closing, red = window closed
// (template required to reply).
const TIER_STYLE: Record<
  AwaitingTier,
  { edge: string; chip: string; dot: string; rowBg: string; note: string }
> = {
  fresh: {
    edge: "bg-mint",
    chip: "bg-mint-soft text-deep-green",
    dot: "bg-mint",
    rowBg: "",
    note: "",
  },
  closing: {
    edge: "bg-amber-400",
    chip: "bg-amber-50 text-amber-700 border border-amber-200",
    dot: "bg-amber-400",
    rowBg: "",
    note: "text-amber-700",
  },
  closed: {
    edge: "bg-red-500",
    chip: "bg-red-50 text-red-700 border border-red-200",
    dot: "bg-red-500",
    // Faint warm wash so the past-window rows read as urgent even
    // before the chip is read.
    rowBg: "bg-red-50/40",
    note: "text-red-700 font-semibold",
  },
};

function assigneeLabel(
  a: InboxRowThread["assignee"],
): { text: string; assigned: boolean } {
  if (!a) return { text: "Unassigned", assigned: false };
  const name = a.full_name?.trim() || a.email.split("@")[0];
  return { text: name, assigned: true };
}

// Quiet answered-state label: "replied 2h ago" / "template sent 5h ago".
function answeredLabel(t: InboxRowThread, nowMs: number): string {
  const age = awaitingAgeLabel(t.last_message_at, nowMs);
  const verb = t.last_message_is_template ? "template sent" : "replied";
  return `${verb} ${age} ago`;
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
  const rawPreview = thread.last_message_preview ?? "(no messages)";
  const preview =
    thread.last_message_direction === "outbound"
      ? `You: ${rawPreview}`
      : rawPreview;

  // Awaiting OUR reply = open thread where the customer spoke last.
  const nowMs = Date.now();
  const awaiting =
    thread.status === "open" &&
    thread.last_message_direction === "inbound" &&
    !!thread.last_message_preview;
  const state = awaiting
    ? awaitingReplyState(thread.last_message_at, nowMs)
    : null;
  const tierStyle = state ? TIER_STYLE[state.tier] : null;
  // Right-slot label: awaiting → colored age chip; answered (we spoke
  // last) → quiet "replied/template sent"; otherwise plain time.
  const answered =
    !awaiting && thread.last_message_direction === "outbound";
  const timeLabel = timeAgoCompact(thread.last_message_at);
  const asg = assigneeLabel(thread.assignee);

  const metaBits: string[] = [];
  if (city) metaBits.push(city);
  if (isMember) metaBits.push("Member");
  if (thread.match_ambiguous) metaBits.push("Historical");

  const buttonBg = active
    ? "bg-cream-soft"
    : state?.tier === "closed"
      ? "bg-red-50/40 hover:bg-red-50/70"
      : "bg-white hover:bg-cream-soft/60";

  return (
    <li className="relative flex items-stretch">
      {/* Escalation edge — colored only while awaiting our reply. */}
      {tierStyle && (
        <span
          aria-hidden
          className={`absolute left-0 top-0 bottom-0 z-10 w-[3px] ${tierStyle.edge}`}
        />
      )}
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
        } ${buttonBg}`}
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
            {awaiting && state && tierStyle ? (
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${tierStyle.chip}`}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${tierStyle.dot}`}
                />
                {state.ageLabel}
              </span>
            ) : answered ? (
              <span className="shrink-0 text-[11px] text-deep-green/40">
                {answeredLabel(thread, nowMs)}
              </span>
            ) : (
              <span className="shrink-0 text-[12px] text-deep-green/45">
                {timeLabel}
              </span>
            )}
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
          <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-deep-green/45">
            {state?.note && tierStyle && (
              <>
                <span className={`shrink-0 ${tierStyle.note}`}>
                  {state.note}
                </span>
                <span aria-hidden className="text-deep-green/25">
                  ·
                </span>
              </>
            )}
            <span
              className={
                asg.assigned
                  ? "shrink-0 text-deep-green/60"
                  : "shrink-0 text-deep-green/35"
              }
            >
              {asg.assigned ? `Assigned · ${asg.text}` : "Unassigned"}
            </span>
            {metaBits.length > 0 && (
              <>
                <span aria-hidden className="text-deep-green/25">
                  ·
                </span>
                <span className="truncate">{metaBits.join(" · ")}</span>
              </>
            )}
          </div>
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
