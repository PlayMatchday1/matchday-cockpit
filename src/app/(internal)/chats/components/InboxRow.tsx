"use client";

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
}: {
  thread: InboxRowThread;
  active: boolean;
  onSelect: () => void;
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
    <li>
      <button
        type="button"
        onClick={onSelect}
        style={{ touchAction: "manipulation" }}
        className={`flex w-full items-center gap-3 px-3 py-3 text-left transition sm:px-4 ${
          active ? "bg-cream-soft" : "bg-white hover:bg-cream-soft/60"
        }`}
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
    </li>
  );
}
