"use client";

// Single thread row in the Player Chat inbox. Mobile-first row
// height (44px+ touch target). Visual states:
//
//   - default        : white bg, no accent
//   - active         : mint left border (4px), faint mint-soft bg
//   - unread         : yellow-pos tinted bg + yellow-pos left
//                      border, name bolder
//   - ambiguous flag : muted "ⓘ historical" chip (PR #29 softening)
//
// Time pill: mint text when last activity < 1 hour, muted otherwise.
// City + Member pills follow the brand palette.

import { colorForCity, UNKNOWN_CITY } from "@/lib/cityColors";
import PlayerAvatar from "@/components/PlayerAvatar";
import type { CrmChannel } from "@/components/ChannelChip";

export type InboxRowThread = {
  id: string;
  phone_number: string;
  channel: CrmChannel;
  match_ambiguous: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  player: {
    first_name: string | null;
    last_name: string | null;
    preferable_city_normalized: string | null;
    is_member?: boolean | null;
  } | null;
  unread: boolean;
};

function fullName(t: InboxRowThread): string {
  const p = t.player;
  if (!p) return t.phone_number;
  const first = p.first_name?.trim() ?? "";
  const last = p.last_name?.trim() ?? "";
  const out = `${first} ${last}`.trim();
  return out || t.phone_number;
}

function cityForRow(t: InboxRowThread): string | null {
  return t.player?.preferable_city_normalized ?? null;
}

function timeAgoCompact(iso: string): { label: string; recent: boolean } {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return { label: "", recent: false };
  const diff = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diff < 45) return { label: "now", recent: true };
  if (diff < 3600) return { label: `${Math.floor(diff / 60)}m`, recent: true };
  if (diff < 86400) return { label: `${Math.floor(diff / 3600)}h`, recent: false };
  if (diff < 604800) return { label: `${Math.floor(diff / 86400)}d`, recent: false };
  return { label: new Date(then).toLocaleDateString(), recent: false };
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
  const city = cityForRow(thread);
  const isMember = thread.player?.is_member === true;
  const time = timeAgoCompact(thread.last_message_at);

  const rowBg = active
    ? "bg-mint-soft"
    : thread.unread
      ? "bg-yellow-pos/10"
      : "bg-white hover:bg-cream-soft";
  const leftBorder = active
    ? "border-l-[3px] border-l-mint"
    : thread.unread
      ? "border-l-[3px] border-l-yellow-pos"
      : "border-l-[3px] border-l-transparent";

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition sm:px-4 ${rowBg} ${leftBorder}`}
      >
        <PlayerAvatar
          name={thread.player ? name : null}
          seed={thread.phone_number}
          channel={thread.channel}
          size="md"
          isMember={isMember}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-sm tracking-tight text-deep-green ${
                thread.unread ? "font-extrabold" : "font-semibold"
              }`}
            >
              {name}
            </span>
            <span
              className={`shrink-0 text-[10px] font-medium ${
                time.recent ? "text-mint-hover" : "text-deep-green/45"
              }`}
            >
              {time.label}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-deep-green/65">
            {thread.last_message_preview ?? "(no messages)"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {city && <CityPill code={city} />}
            {isMember && <MemberPill />}
            {thread.match_ambiguous && (
              <span
                title="Phone has historical accounts on file — showing the most recent"
                className="inline-flex items-center gap-0.5 rounded-full bg-muted-soft px-1.5 py-0.5 text-[10px] font-medium text-muted"
              >
                <span aria-hidden>ⓘ</span> historical
              </span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function CityPill({ code }: { code: string }) {
  const safe = code && code.length > 0 ? code : UNKNOWN_CITY;
  const hex = colorForCity(safe);
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wider"
      style={{ backgroundColor: "rgb(0 51 38)", color: hex }}
    >
      {safe}
    </span>
  );
}

function MemberPill() {
  return (
    <span className="rounded-full bg-purple-done/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-purple-done">
      Member
    </span>
  );
}
