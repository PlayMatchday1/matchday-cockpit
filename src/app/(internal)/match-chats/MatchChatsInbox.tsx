"use client";

// Left pane of the two-pane Match Chats shell. Tabs (Active /
// Upcoming) above the row list. Inbox data, Firebase session, and
// the realtime listener all live in the parent (MatchChatsClient)
// now — this component is presentational and consumes data via
// props.
//
// Mobile flow: when showOnMobile is true the pane fills the screen
// (flex-1 w-full); when false it hides (the chat pane takes over).
// On lg+ the pane is always visible at 320px expanded or 40px
// collapsed. Collapse is a desktop-only feature — on mobile the
// localStorage flag is ignored and the pane always renders expanded.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type MatchChatInboxResponse,
  type MatchChatInboxRow,
} from "@/lib/matchChats";
import { formatMatchTitle } from "@/lib/cityTimezones";
import CityChip from "@/components/CityChip";

export type InboxTab = "active" | "upcoming";

const COLLAPSE_KEY = "cockpit:match-chats:inbox-collapsed";

// ---------------- helpers ----------------

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diff < 45) return "just now";
  if (diff < 90) return "1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 5400) return "1h";
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 172800) return "1d";
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(then).toLocaleDateString();
}

function readCollapse(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapse(b: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSE_KEY, b ? "1" : "0");
  } catch {
    // private mode — no-op
  }
}

// ============================================================
// main
// ============================================================

export default function MatchChatsInbox({
  data,
  error,
  loading,
  selectedChatId,
  tab,
  onSelect,
  onTabChange,
  showOnMobile,
}: {
  data: MatchChatInboxResponse | null;
  error: string | null;
  loading: boolean;
  selectedChatId: string | null;
  tab: InboxTab;
  onSelect: (chatId: string) => void;
  onTabChange: (tab: InboxTab) => void;
  showOnMobile: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(readCollapse());
  }, []);
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapse(next);
      return next;
    });
  }, []);

  const activeCount = data?.active.length ?? 0;
  const upcomingCount = data?.upcoming.length ?? 0;
  const rows = (tab === "active" ? data?.active : data?.upcoming) ?? [];

  return (
    <>
      {/* Collapsed strip — lg+ only when collapsed=true. Mobile
          ignores the localStorage flag and renders the expanded panel
          below instead. */}
      {collapsed && (
        <aside
          className="hidden w-10 shrink-0 flex-col overflow-hidden border-r border-cream-line bg-cream-soft transition-[width] duration-200 ease-out lg:flex"
          style={{ width: 40 }}
        >
          <div className="flex h-9 items-center justify-center border-b border-cream-line bg-cream-soft">
            <button
              type="button"
              onClick={toggleCollapse}
              aria-label="Expand inbox"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-deep-green/60 transition hover:bg-white hover:text-deep-green"
            >
              ›
            </button>
          </div>
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label="Expand inbox"
            className="flex-1 text-[10px] uppercase tracking-widest text-deep-green/40 [writing-mode:vertical-rl]"
          >
            Inbox
          </button>
        </aside>
      )}

      {/* Expanded panel. Visibility:
          - Mobile (< lg): renders full-width when showOnMobile, hidden
            otherwise. The collapse flag is ignored.
          - lg+: renders 320px when !collapsed, hidden when collapsed
            (the strip above takes over). */}
      <aside
        className={`min-w-0 flex-col overflow-hidden border-r border-cream-line bg-cream-soft transition-[width] duration-200 ease-out ${
          showOnMobile ? "flex w-full flex-1" : "hidden"
        } ${
          collapsed ? "lg:hidden" : "lg:flex lg:w-[320px] lg:shrink-0"
        }`}
      >
        {/* Tabs row — also hosts the desktop-only collapse toggle on
            the right edge. */}
        <div className="flex shrink-0 items-center gap-1 border-b border-cream-line bg-cream-soft px-2 py-1.5">
          <TabButton
            active={tab === "active"}
            onClick={() => onTabChange("active")}
            label="Active"
            count={activeCount}
          />
          <TabButton
            active={tab === "upcoming"}
            onClick={() => onTabChange("upcoming")}
            label="Upcoming"
            count={upcomingCount}
          />
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label="Collapse inbox"
            className="ml-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-deep-green/60 transition hover:bg-white hover:text-deep-green lg:inline-flex"
          >
            ‹
          </button>
        </div>

        {error && (
          <div className="m-2 rounded border border-coral/40 bg-coral-soft p-2 text-xs text-coral-hover">
            {error}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
          {loading && !data && (
            <div className="flex flex-1 items-center justify-center px-6 text-xs text-deep-green/50">
              Loading…
            </div>
          )}
          {!loading && rows.length === 0 && !error && (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-deep-green/45">
              {tab === "active"
                ? "No messages in the last 7 days."
                : "No upcoming matches in the next 3 days."}
            </div>
          )}
          {rows.length > 0 && (
            <ul className="divide-y divide-cream-line">
              {rows.map((r) => (
                <InboxRow
                  key={r.chat_id}
                  row={r}
                  active={r.chat_id === selectedChatId}
                  onSelect={() => onSelect(r.chat_id)}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------- pieces ----------------

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ touchAction: "manipulation" }}
      className={`min-w-0 flex-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
        active
          ? "bg-deep-green text-cream"
          : "border border-cream-line bg-white text-deep-green/70 hover:bg-cream-soft"
      }`}
    >
      {label}
      <span className={`ml-1 ${active ? "text-cream/70" : "text-deep-green/40"}`}>
        · {count}
      </span>
    </button>
  );
}

function InboxRow({
  row,
  active,
  onSelect,
}: {
  row: MatchChatInboxRow;
  active: boolean;
  onSelect: () => void;
}) {
  const m = row.match;
  const isCancelled = m?.is_cancelled === true;
  const isOrphan = m == null;
  const isUpcomingEmpty = row.section === "upcoming";
  const dim = (isCancelled || isUpcomingEmpty || isOrphan) && !active;

  const title = useMemo(() => {
    if (isOrphan) return null;
    return formatMatchTitle({
      cityCode: m?.city_identifier ?? null,
      startDateIso: m?.start_date_utc ?? null,
      fieldTitle: m?.field_title ?? null,
    });
  }, [m, isOrphan]);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        style={{ touchAction: "manipulation" }}
        className={`block w-full min-w-0 px-3 py-2.5 text-left transition ${
          active
            ? "bg-mint-soft"
            : "border-l-2 border-l-transparent hover:bg-white"
        } ${active ? "border-l-2 border-l-mint" : ""} ${dim ? "opacity-60" : ""}`}
      >
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {isOrphan ? (
              <span className="truncate italic text-deep-green/55">
                Match {row.chat_id} · (no match data)
              </span>
            ) : (
              <>
                {title?.cityCode && <CityChip code={title.cityCode} />}
                <span className="text-[10px] text-deep-green/30" aria-hidden>
                  ·
                </span>
                <span className="font-semibold text-deep-green">
                  {title?.date}
                </span>
                {title?.time && (
                  <>
                    <span className="text-[10px] text-deep-green/30" aria-hidden>
                      ·
                    </span>
                    <span className="text-deep-green/70">{title.time}</span>
                    {title.isUtcFallback && (
                      <span className="text-[10px] text-deep-green/40">
                        (UTC)
                      </span>
                    )}
                  </>
                )}
                {isCancelled && (
                  <span className="rounded-full bg-muted-soft px-1.5 py-0.5 text-[9px] font-medium text-muted">
                    Cancelled
                  </span>
                )}
              </>
            )}
          </div>
          {row.last_message && (
            <span className="shrink-0 text-[10px] font-medium text-deep-green/50">
              {timeAgo(row.last_message.sent_at)}
            </span>
          )}
        </div>
        {!isOrphan && title?.venue && (
          <div className="mt-0.5 min-w-0 truncate text-xs font-semibold text-deep-green">
            {title.venue}
          </div>
        )}
        <div className="mt-0.5 min-w-0 truncate text-xs">
          {row.last_message ? (
            <>
              {row.last_message.sent_by && (
                <span className="mr-1 font-medium text-deep-green/70">
                  {row.last_message.sent_by}:
                </span>
              )}
              <span className="text-deep-green/60">
                {row.last_message.body ?? "(media)"}
              </span>
            </>
          ) : (
            <span className="italic text-deep-green/40">No messages yet</span>
          )}
        </div>
      </button>
    </li>
  );
}
