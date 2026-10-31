"use client";

import { Star, Check, Undo2 } from "lucide-react";
import {
  firstResponseCue,
  firstResponseCueDescription,
  awaitingAgeLabel,
  isAwaitingReply,
  isWrappingUp,
  type FirstResponseTier,
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
  // Operator "Done · no reply needed" dismissal (0073). With the ack
  // heuristic, splits inbound-last threads into Awaiting vs Wrapping up.
  no_reply_needed_at: string | null;
  status: "open" | "closed";
  // First-response SLA anchor: first inbound of the current unanswered run
  // (Decision 2). Null when not awaiting. Server-computed, then owned by the
  // realtime crm_messages handler.
  waiting_since: string | null;
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

// Per-tier visual tokens for the single first-response ladder (edge + chip).
// Severity is the max of the SLA axis and the WhatsApp-window axis, so it
// only ever climbs; the CHIP TEXT (not the color) always carries the meaning.
//   neutral  — no edge, muted chip (elapsed business time).
//   warm     — amber edge + tinted amber chip.
//   breached — red edge + SOLID red chip (SLA over, OR window closing/closed;
//              the label distinguishes which). Reuses the existing amber-*/
//              red-* vocabulary — no new tokens.
const CUE_STYLE: Record<FirstResponseTier, { edge: string; chip: string }> = {
  neutral: {
    edge: "",
    chip: "bg-cream-line/60 text-muted",
  },
  warm: {
    edge: "bg-amber-400",
    chip: "bg-amber-50 text-amber-700 border border-amber-200",
  },
  breached: {
    edge: "bg-red-500",
    chip: "bg-red-600 text-white",
  },
};

function assigneeLabel(
  a: InboxRowThread["assignee"],
): { text: string; assigned: boolean } {
  if (!a) return { text: "Unassigned", assigned: false };
  // First name only for the compact row (matches the mock's
  // "Assigned · Deonna"); keeps the right column narrow.
  const first = a.full_name?.trim().split(/\s+/)[0];
  return { text: first || a.email.split("@")[0], assigned: true };
}

// Quiet answered-state label: "replied 2h ago" / "template sent 5h ago",
// and "replied just now" for the first minute (never "replied now ago").
function answeredLabel(t: InboxRowThread, nowMs: number): string {
  const age = awaitingAgeLabel(t.last_message_at, nowMs);
  const verb = t.last_message_is_template ? "template sent" : "replied";
  return age === "now" ? `${verb} just now` : `${verb} ${age} ago`;
}

// Compact timestamp: "now", "5m", "3h", "2d", or a M/D date.
function timeAgoCompact(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Math.floor((nowMs - then) / 1000));
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
  nowMs = Date.now(),
  active,
  onSelect,
  onToggleFollowUp,
  onMarkNoReply,
  onReactivate,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  thread: InboxRowThread;
  // Shared list clock (one 30s tick in CrmClient). Defaulted so other
  // callers / tests need not thread it through.
  nowMs?: number;
  active: boolean;
  onSelect: () => void;
  onToggleFollowUp: () => void;
  // "Done · no reply needed" on an awaiting row → move it to Wrapping up
  // without replying or closing.
  onMarkNoReply?: () => void;
  // "Reply anyway" on a wrapping-up row → clear the dismissal and open
  // the thread to reply.
  onReactivate?: () => void;
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
  // Preview slot. An inbound with no text body (WhatsApp location, contact,
  // reaction, or an unhandled type — the webhook's previewFor returns "" for
  // these) gets a neutral descriptor instead of "(no messages)", which reads
  // as broken. These are exactly the rows the cue must still fire on (see
  // `awaiting` below), so they must not look empty.
  const hasPreview = !!thread.last_message_preview;
  const rawPreview = hasPreview
    ? thread.last_message_preview!
    : thread.last_message_direction === "inbound"
      ? "Media message"
      : "(no messages)";
  const preview =
    thread.last_message_direction === "outbound"
      ? `You: ${rawPreview}`
      : rawPreview;

  // Refined states (shared source of truth with the server + grouping):
  //   awaiting   — customer spoke last AND it needs a reply → colored chip
  //   wrappingUp — customer spoke last but it's an acknowledgment or was
  //                marked no-reply-needed → muted, "Reply anyway"
  //   answered   — we spoke last
  // The cue fires on EXACTLY the isAwaitingReply population — the same
  // predicate as the "Awaiting now" card and the list grouping, no extra
  // gate. A text-less inbound (photo/voice/location/sticker) is precisely
  // when a player is stuck and needs an answer, so it must show the cue.
  const awaiting = isAwaitingReply(thread);
  const wrappingUp = isWrappingUp(thread);
  // The single first-response ladder: SLA business-minutes (anchored on
  // waiting_since — the first inbound of the current run) maxed with the
  // WhatsApp free-reply window (real hours from last_message_at). See
  // firstResponseCue for why the two anchors differ on purpose.
  const cue = awaiting
    ? firstResponseCue(thread.waiting_since, thread.last_message_at, nowMs)
    : null;
  const cueStyle = cue ? CUE_STYLE[cue.tier] : null;
  // Right-slot label: awaiting → the ladder chip; answered (we spoke last)
  // → quiet "replied/template sent"; otherwise plain time.
  const answered =
    !awaiting && !wrappingUp && thread.last_message_direction === "outbound";
  const timeLabel = timeAgoCompact(thread.last_message_at, nowMs);
  const asg = assigneeLabel(thread.assignee);

  // Only the window-CLOSED tier washes the row (preserves the strongest,
  // money-critical Meta signal — a template is required to reply at all).
  const buttonBg = active
    ? "bg-cream-soft"
    : cue?.reason === "window-closed"
      ? "bg-red-50/40 hover:bg-red-50/70"
      : "bg-white hover:bg-cream-soft/60";

  return (
    <li className="relative flex items-stretch">
      {/* Escalation edge — only from warm upward; neutral shows no edge. */}
      {cueStyle?.edge && (
        <span
          aria-hidden
          className={`absolute left-0 top-0 bottom-0 z-10 w-[3px] ${cueStyle.edge}`}
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
        // Awaiting rows carry the wait state in words for screen readers, so
        // the color is never the only signal. Name is kept so the row is
        // still identifiable by voice.
        aria-label={cue ? `${name}. ${firstResponseCueDescription(cue)}` : undefined}
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
        {/* RIGHT: one combined status chip, assignment beneath it.
            shrink-0 with no max-width (mirrors the mock's `.right`): the
            column sizes to the nowrap chip and the LEFT column absorbs
            the rest, so the chip can never overflow leftward over the
            name. */}
        <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
          {awaiting && cue && cueStyle ? (
            <span
              title={firstResponseCueDescription(cue)}
              className={`whitespace-nowrap rounded-lg px-2 py-0.5 text-[10.5px] font-bold ${cueStyle.chip}`}
            >
              {cue.label}
            </span>
          ) : wrappingUp ? (
            <span className="whitespace-nowrap rounded-lg bg-cream-line/60 px-2 py-0.5 text-[10.5px] font-semibold text-deep-green/45">
              no reply needed
            </span>
          ) : answered ? (
            <span className="whitespace-nowrap text-[11px] text-deep-green/40">
              {answeredLabel(thread, nowMs)}
            </span>
          ) : (
            <span className="whitespace-nowrap text-[12px] text-deep-green/45">
              {timeLabel}
            </span>
          )}
          <span
            className={`whitespace-nowrap text-[11px] leading-tight ${
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
      {/* Right-gutter action buttons — siblings of the select button (a
          nested button would be invalid HTML). When there's a row action
          (Done on awaiting, Reply-anyway on wrapping-up) the star sits at
          the top of the gutter and the action beneath it; otherwise the
          star stays vertically centered. Both fit inside the existing
          pr-10 gutter, so the chip column is never squeezed. */}
      {(awaiting && onMarkNoReply) || (wrappingUp && onReactivate) ? (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFollowUp();
            }}
            aria-label={
              thread.is_follow_up
                ? "Remove follow-up flag"
                : "Mark for follow up"
            }
            aria-pressed={thread.is_follow_up}
            style={{ touchAction: "manipulation" }}
            className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full text-deep-green/35 transition hover:bg-cream-line/60 hover:text-deep-green"
          >
            <Star
              aria-hidden
              size={15}
              strokeWidth={1.75}
              className={thread.is_follow_up ? "fill-coral text-coral" : ""}
            />
          </button>
          {awaiting ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMarkNoReply?.();
              }}
              aria-label="Mark done — no reply needed"
              title="Done · no reply needed"
              style={{ touchAction: "manipulation" }}
              className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full text-deep-green/35 transition hover:bg-mint-soft hover:text-mint-hover"
            >
              <Check aria-hidden size={16} strokeWidth={2.25} />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReactivate?.();
              }}
              aria-label="Reply anyway — move back to awaiting"
              title="Reply anyway"
              style={{ touchAction: "manipulation" }}
              className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full text-deep-green/35 transition hover:bg-cream-line/60 hover:text-deep-green"
            >
              <Undo2 aria-hidden size={15} strokeWidth={1.9} />
            </button>
          )}
        </>
      ) : (
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
      )}
    </li>
  );
}
