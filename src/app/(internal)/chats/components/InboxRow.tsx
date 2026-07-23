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

// Per-tier visual tokens for the combined awaiting chip + left edge.
// Green = fresh, amber = free-reply window closing, red = window closed
// (template required to reply). The closed tier also washes the whole
// row faintly warm (applied in buttonBg below).
const TIER_STYLE: Record<AwaitingTier, { edge: string; chip: string }> = {
  fresh: {
    edge: "bg-mint",
    chip: "bg-mint-soft text-deep-green",
  },
  closing: {
    edge: "bg-amber-400",
    chip: "bg-amber-50 text-amber-700 border border-amber-200",
  },
  closed: {
    edge: "bg-red-500",
    chip: "bg-red-50 text-red-700 border border-red-200",
  },
};

function assigneeLabel(
  a: InboxRowThread["assignee"],
): { text: string; assigned: boolean } {
  if (!a) return { text: "Unassigned", assigned: false };
  const name = a.full_name?.trim() || a.email.split("@")[0];
  return { text: name, assigned: true };
}

// Quiet answered-state label: "replied 2h ago" / "template sent 5h ago",
// and "replied just now" for the first minute (never "replied now ago").
function answeredLabel(t: InboxRowThread, nowMs: number): string {
  const age = awaitingAgeLabel(t.last_message_at, nowMs);
  const verb = t.last_message_is_template ? "template sent" : "replied";
  return age === "now" ? `${verb} just now` : `${verb} ${age} ago`;
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

  // ONE combined chip: age + window state, e.g. "18h · window closing",
  // "4d · window closed — template required", or just "1m" when fresh.
  const chipText = state
    ? state.note
      ? `${state.ageLabel} · ${state.note}`
      : state.ageLabel
    : null;

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
        className={`flex min-w-0 flex-1 items-start gap-3 py-3.5 pr-10 text-left transition ${
          selectable ? "pl-2" : "pl-3.5 sm:pl-4"
        } ${buttonBg}`}
      >
        <span
          aria-hidden
          className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream-line text-[13px] font-medium text-muted"
        >
          {initials}
        </span>
        {/* LEFT: name + city on line 1, preview on line 2. The name owns
            the row's left width — chips live in the right column, so the
            name is never truncated to make room for them. */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={`min-w-0 truncate text-[15px] text-deep-green ${
                thread.is_unread ? "font-semibold" : "font-medium"
              }`}
            >
              {name}
            </span>
            {city && (
              <span className="shrink-0 rounded bg-mint-soft px-1.5 py-px text-[10px] font-bold tracking-wide text-deep-green/70">
                {city}
              </span>
            )}
            {isMember && (
              <span className="shrink-0 text-[10px] font-semibold text-mint-hover">
                Member
              </span>
            )}
            {thread.match_ambiguous && (
              <span className="shrink-0 text-[10px] text-deep-green/35">
                Historical
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
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
        </div>
        {/* RIGHT: one combined status chip, assignment beneath it. */}
        <div className="flex max-w-[46%] shrink-0 flex-col items-end gap-1.5 text-right">
          {awaiting && state && tierStyle ? (
            <span
              className={`inline-block max-w-full rounded-lg px-2 py-0.5 text-[10.5px] font-bold leading-snug ${tierStyle.chip}`}
            >
              {chipText}
            </span>
          ) : answered ? (
            <span className="text-[11px] text-deep-green/40">
              {answeredLabel(thread, nowMs)}
            </span>
          ) : (
            <span className="text-[12px] text-deep-green/45">{timeLabel}</span>
          )}
          <span
            className={`text-[11px] leading-tight ${
              asg.assigned ? "text-deep-green/60" : "text-deep-green/35"
            }`}
          >
            {asg.assigned ? (
              <>
                Assigned · <span className="font-semibold">{asg.text}</span>
              </>
            ) : (
              "Unassigned"
            )}
          </span>
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
