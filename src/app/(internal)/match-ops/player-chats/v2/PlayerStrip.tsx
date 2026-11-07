"use client";

// THE PLAYER STRIP — the conversation header of Player Chats 2.0 (Figma 20851:161).
//   Row 1: initials, the name (links to Player Lookup), city · Casual/Member · Level · joined ·
//          channel and number; the assignee pill; Mark done (today's Close) or Reopen; the ⋯ menu.
//   Row 2: fact chips — Credits, Played, Strikes, Membership, Next match — and "Player details ›".
//   Row 3: the player's latest app action from app_request_log (red when a failure in the last
//          7 days), linking to the Activity tab.
// Every control here calls a handler the old page already had; nothing new is written.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ExternalLink, MoreHorizontal, RotateCcw } from "lucide-react";
import AssignDropdown from "../components/AssignDropdown";
import type { Assignee } from "@/components/AssigneeChip";
import { CopyPhoneInline } from "@/components/CopyPhone";
import { channelDisplay, type CrmChannel } from "@/components/ChannelChip";
import { fmtUsd } from "@/lib/creditsModel";
import { matchLine, shortStamp, ymdIn, type Item, type MatchInfo } from "@/lib/appActivity";
import { zoneOfCity } from "@/lib/matchTimezone";
import { activityLine, initials, membershipLevel, nextMatch, wallClockWhen } from "@/lib/inbox2Model";
import { monthYear } from "../components/ContextPane";
import type { ThreadContext } from "./useThreadContext";
import type { ThreadDetail } from "@/lib/crmConversation";

const INK = "#13241d", MUTED = "#5e6b66", FAINT = "#7c8782", LINE = "#e3e3db", DEEP = "#0e3b2c";

export type MenuItem = { key: string; label: string; onClick: () => void; disabled?: boolean; title?: string; danger?: boolean } | { key: string; node: React.ReactNode };

export default function PlayerStrip({
  detail, name, ctx, operators, onAssign, onBack, threadStatus, canManageStatus, onSetStatus, menu,
  onOpenDetails, detailsOpen, activity, canActivity, nowMs,
}: {
  detail: ThreadDetail | null;
  name: string;
  ctx: ThreadContext;
  operators: Assignee[];
  onAssign: (userId: string | null) => void;
  onBack: () => void;
  threadStatus: "open" | "closed";
  canManageStatus: boolean;
  onSetStatus: (a: "close" | "reopen") => void;
  menu: MenuItem[];
  onOpenDetails: (tab?: "activity") => void;
  detailsOpen: boolean;
  activity: { phase: "loading" } | { phase: "error"; error: string } | { phase: "ok"; items: Item[]; matches: Record<number, MatchInfo> } | null;
  canActivity: boolean;
  nowMs: number;
}) {
  const prof = ctx.data?.profile ?? null;
  const mirror = ctx.data?.player ?? null;
  const thread = detail?.thread ?? null;
  const channel = (thread?.channel ?? "sms") as CrmChannel;
  const city = prof?.player.city || mirror?.preferable_city_name || thread?.city_code || mirror?.preferable_city_normalized || null;
  const tz = zoneOfCity(city) ?? "America/Chicago";
  const isMember = Boolean(prof?.membership ?? mirror?.is_member ?? thread?.player?.is_member);
  const joined = monthYear(prof?.player.registered ?? mirror?.created_at ?? null);
  const playerId = prof?.player.id ?? thread?.player_id ?? null;
  const next = prof ? nextMatch(prof.matches) : null;
  const line = activity?.phase === "ok" ? activityLine(activity.items, nowMs) : null;

  return (
    <div data-testid="crm-conv-header" data-thread-id={thread?.id ?? ""}
      className="flex shrink-0 flex-col gap-3 border-b bg-white px-3 pb-[14px] pt-3 min-[900px]:px-6 min-[900px]:pt-4" style={{ borderColor: LINE }}>
      <div className="flex items-center gap-3">
        <button type="button" onClick={(e) => { e.stopPropagation(); onBack(); }} aria-label="Back to inbox"
          className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#5e6b66] lg:hidden">
          <ChevronLeft aria-hidden className="h-5 w-5" />
        </button>
        <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e3f7ed] text-[13px] font-bold min-[600px]:flex" style={{ color: DEEP }}>
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[17px] font-bold" style={{ color: INK }} data-testid="strip-name">{name}</span>
            {playerId != null && (
              <a href={`/match-ops/player-lookup?id=${playerId}`} aria-label="Open in Player Lookup" title="Open in Player Lookup" data-testid="strip-lookup"
                className="shrink-0 text-[#13241d] hover:text-[#0e3b2c]"><ExternalLink aria-hidden className="h-3.5 w-3.5" strokeWidth={2} /></a>
            )}
          </div>
          <div className="mt-[2px] flex min-w-0 flex-wrap items-center gap-x-1 text-[12px]" style={{ color: MUTED }} data-testid="strip-facts">
            <span className="truncate">{[city, membershipLevel(isMember, prof?.player.level), joined ? `joined ${joined}` : null].filter(Boolean).join(" · ")}</span>
            {thread && (
              <span className="inline-flex items-center gap-1">· {channelDisplay(channel)} <CopyPhoneInline value={thread.phone_number} className="min-w-0" /></span>
            )}
            {thread?.match_ambiguous && (
              <span title={`This number is on more than one account. Showing ${name}; it may not be who is writing.`}
                className="ml-1 rounded-full bg-amber-100 px-1.5 text-[11px] font-medium text-amber-800">shared number</span>
            )}
          </div>
        </div>
        {detail && (
          <AssignDropdown current={detail.assignee} operators={operators} onAssign={onAssign}
            trigger={() => (
              <span data-testid="strip-assignee" className="hidden items-center gap-2 rounded-full border py-[5px] pl-[6px] pr-3 text-[12px] font-semibold min-[700px]:inline-flex" style={{ borderColor: LINE, color: INK }}>
                {detail.assignee ? (
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: DEEP }}>
                    {initials(detail.assignee.full_name || detail.assignee.email)}
                  </span>
                ) : (
                  <span className="h-[22px] w-[22px] rounded-full border border-dashed" style={{ borderColor: "#cfd6d2" }} />
                )}
                {detail.assignee ? (detail.assignee.full_name?.trim().split(/\s+/)[0] || detail.assignee.email.split("@")[0]) : "Assign"}
              </span>
            )}
          />
        )}
        {canManageStatus && (threadStatus === "open" ? (
          <button type="button" data-testid="strip-mark-done" onClick={() => onSetStatus("close")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] px-[14px] py-2 text-[13px] font-semibold text-white" style={{ background: DEEP }}>
            <Check aria-hidden className="h-4 w-4" strokeWidth={2.2} /><span className="hidden min-[500px]:inline">Mark done</span>
          </button>
        ) : (
          <button type="button" data-testid="strip-reopen" onClick={() => onSetStatus("reopen")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border px-[14px] py-2 text-[13px] font-semibold" style={{ borderColor: LINE, color: INK }}>
            <RotateCcw aria-hidden className="h-4 w-4" strokeWidth={2} /><span className="hidden min-[500px]:inline">Reopen</span>
          </button>
        ))}
        <OverflowMenu items={menu} />
      </div>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none]" data-testid="strip-chips">
          <Chip k="Credits" v={ctx.credits == null ? "—" : fmtUsd(ctx.credits)} />
          <Chip k="Played" v={prof ? String(prof.player.matchesPlayed) : "—"} />
          <Chip k="Strikes" v={prof ? `${prof.strikes.activeCount} of ${prof.strikes.limit}` : "—"} />
          <Chip k="Membership" v={prof ? (prof.membership ? prof.membership.status : "None") : "—"} />
          <Chip k="Next match" v={!prof ? "—" : next ? [wallClockWhen(next.startDate, ymdIn(new Date(nowMs).toISOString(), tz)), next.name].filter(Boolean).join(" · ") : "None booked"} />
        </div>
        <button type="button" data-testid="strip-details" onClick={() => onOpenDetails()} aria-pressed={detailsOpen}
          className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold" style={{ color: DEEP }}>
          <span className="hidden min-[700px]:inline">Player details</span><span className="min-[700px]:hidden">Details</span>
          <ChevronRight aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>

      {canActivity && playerId != null && (
        <button type="button" data-testid="strip-activity" data-failed={line?.failed ? 1 : 0} onClick={() => onOpenDetails("activity")}
          className="flex w-full min-w-0 items-center gap-[10px] rounded-[8px] px-3 py-2 text-left text-[12px]"
          style={{ background: line?.failed ? "#fdf0ee" : "#f0faf5" }}>
          <span aria-hidden className="text-[9px]" style={{ color: line?.failed ? "#d64531" : "#2cdb87" }}>●</span>
          {activity?.phase === "loading" && <span style={{ color: FAINT }}>Reading app activity…</span>}
          {activity?.phase === "error" && <span style={{ color: "#a83b1c" }}>Couldn&apos;t read app activity: {activity.error}</span>}
          {activity?.phase === "ok" && !line && <span style={{ color: MUTED }}>No app activity in the last 30 days</span>}
          {line && activity?.phase === "ok" && (
            <>
              <span className="shrink-0 truncate font-semibold" style={{ color: line.failed ? "#b3241f" : INK }}>
                {line.failed ? "Failed in the app: " : "Last in the app: "}{lower(line.item.title)}
              </span>
              <span className="min-w-0 flex-1 truncate" style={{ color: MUTED }}>
                {[line.item.matchRef != null ? matchLine(activity.matches[line.item.matchRef], line.item.matchRef) : line.item.detail,
                  line.failed ? line.item.reason : null, shortStamp(line.item.ts, tz)].filter(Boolean).join(" · ")}
              </span>
            </>
          )}
          <span className="ml-auto shrink-0 font-semibold" style={{ color: DEEP }}>App activity ›</span>
        </button>
      )}
    </div>
  );
}

const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

function Chip({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] bg-[#f7f7f3] px-[10px] py-[6px]" data-testid={`strip-chip-${k.toLowerCase().replace(/\s+/g, "-")}`}>
      <span className="text-[11px] font-medium" style={{ color: FAINT }}>{k}</span>
      <span className="text-[12px] font-semibold" style={{ color: INK }}>{v}</span>
    </span>
  );
}

export function OverflowMenu({ items, testId = "strip-menu" }: { items: MenuItem[]; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button type="button" data-testid={testId} aria-label="More actions" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-[#5e6b66] hover:bg-[#f3f3ef]">
        <MoreHorizontal aria-hidden className="h-5 w-5" />
      </button>
      {open && (
        <div role="menu" data-testid={`${testId}-list`} className="absolute right-0 top-10 z-40 w-[260px] overflow-hidden rounded-[12px] border bg-white py-1 shadow-[0_12px_32px_rgba(9,30,20,.16)]" style={{ borderColor: LINE }}>
          {items.map((it) => "node" in it ? (
            <div key={it.key} className="border-t px-3 py-2 first:border-t-0" style={{ borderColor: "#efefea" }}>{it.node}</div>
          ) : (
            <button key={it.key} role="menuitem" type="button" data-testid={`menu-${it.key}`} disabled={it.disabled} title={it.title}
              onClick={() => { setOpen(false); it.onClick(); }}
              className="block w-full px-3 py-2 text-left text-[13px] hover:bg-[#f7f7f3] disabled:cursor-not-allowed disabled:opacity-45"
              style={{ color: it.danger ? "#a83b1c" : INK }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
