"use client";

// List pane of the Match Chats console (mockup matchops-chats-v1). Mist tone.
//
// Header ("Chats" + live + refresh), a search row (search box with "/" focus +
// a city-filter popover button), a three-tab segmented control (Active /
// Upcoming / Past with real counts), and a flat recency-ordered list of rounded
// row buttons with hover-lift and a full-surface selected state.
//
// NOT rendered (blocked by the missing inbound/outbound field — see ship
// report): the "Waiting on a reply" grouping, waited-time tags, unread dots,
// and the bold-human/grey-MatchDay speaker contrast. Those all depend on
// reliably telling an automated post from a human message, which no stored
// field supports today. A single flat feed is the honest shape.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MatchChatInboxRow } from "@/lib/matchChats";
import { formatMatchTitle } from "@/lib/cityTimezones";
import { KNOWN_CITY_CODES, HIDDEN_CITY_CODES } from "@/lib/cityNormalization";
import { UNKNOWN_CITY } from "@/lib/cityColors";
import MatchOpsMobileStrip from "../MatchOpsMobileStrip";

export type InboxTab = "active" | "upcoming" | "past";

const ALL_CITY_CODES: readonly string[] = [
  ...KNOWN_CITY_CODES.filter((c) => !HIDDEN_CITY_CODES.has(c)),
  UNKNOWN_CITY,
];

// Pastel city badges (presentational, route-scoped — mockup palette).
const BADGE: Record<string, { bg: string; fg: string }> = {
  ATX: { bg: "#dceaf5", fg: "#2f5d80" },
  ATL: { bg: "#f6e3da", fg: "#8a4b31" },
  DFW: { bg: "#e2e5f4", fg: "#454e93" },
  HOU: { bg: "#fbe2e2", fg: "#96393c" },
  OKC: { bg: "#efe6f5", fg: "#6a4a86" },
  SATX: { bg: "#fce4ee", fg: "#963a63" },
  STL: { bg: "#e3f0e6", fg: "#2e6b45" },
  ELP: { bg: "#f6efd8", fg: "#7a6410" },
  [UNKNOWN_CITY]: { bg: "#e7ecea", fg: "#6d7b74" },
};
function badgeFor(code: string | null | undefined) {
  const key = code && code.length > 0 ? code : UNKNOWN_CITY;
  return BADGE[key] ?? BADGE[UNKNOWN_CITY];
}

const VEO_RE = /app\.veo\.co\/matches\//i;
// A group-invite auto-post is a FACT, not a URL to read (S9). Never render the
// raw chat.whatsapp.com link in a preview.
const WA_INVITE_RE = /chat\.whatsapp\.com/i;

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diff < 45) return "now";
  if (diff < 90) return "1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 5400) return "1h";
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 172800) return "1d";
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(then).toLocaleDateString();
}

function emptyStateFor(tab: InboxTab, filtered: boolean, searching: boolean): string {
  if (searching) return "No chats match your search.";
  if (tab === "active")
    return filtered
      ? "No messages in the last 7 days for the selected city."
      : "No messages in the last 7 days.";
  if (tab === "upcoming")
    return filtered
      ? "No upcoming matches in the next 3 days for the selected city."
      : "No upcoming matches in the next 3 days.";
  return filtered
    ? "No matches in the last 7 days for the selected city."
    : "No matches in the last 7 days.";
}

// ============================================================
export default function MatchChatsInbox({
  rows,
  activeCount,
  upcomingCount,
  pastCount,
  error,
  loading,
  dataReady,
  selectedChatId,
  tab,
  onSelect,
  onTabChange,
  showOnMobile,
  cities,
  onCitiesChange,
  search,
  onSearchChange,
  sessionStatus,
  onRefresh,
}: {
  rows: MatchChatInboxRow[];
  activeCount: number;
  upcomingCount: number;
  pastCount: number;
  error: string | null;
  loading: boolean;
  dataReady: boolean;
  selectedChatId: string | null;
  tab: InboxTab;
  onSelect: (chatId: string) => void;
  onTabChange: (tab: InboxTab) => void;
  showOnMobile: boolean;
  cities: Set<string>;
  onCitiesChange: (next: Set<string>) => void;
  search: string;
  onSearchChange: (s: string) => void;
  sessionStatus: "idle" | "loading" | "ready" | "error";
  onRefresh: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [popOpen, setPopOpen] = useState(false);
  const popWrapRef = useRef<HTMLDivElement>(null);

  // "/" focuses the search box (unless already typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Outside-click closes the city popover; clicks inside keep it open (so the
  // second city can be selected without reopening).
  useEffect(() => {
    if (!popOpen) return;
    function onDown(e: MouseEvent) {
      if (popWrapRef.current && !popWrapRef.current.contains(e.target as Node)) {
        setPopOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popOpen]);

  const toggleCity = useCallback(
    (code: string) => {
      const next = new Set(cities);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      onCitiesChange(next);
    },
    [cities, onCitiesChange],
  );

  const cityLabel =
    cities.size === 0
      ? "All cities"
      : cities.size === 1
        ? [...cities][0]
        : `${cities.size} cities`;

  const liveLabel =
    sessionStatus === "ready"
      ? "Live"
      : sessionStatus === "error"
        ? "Offline"
        : "Connecting";

  const searching = search.trim().length > 0;

  return (
    <section
      className={`min-w-0 flex-col border-r lg:flex lg:w-[400px] lg:shrink-0 ${
        showOnMobile ? "flex flex-1" : "hidden"
      }`}
      style={{ background: "#f8faf9", borderColor: "#e6ebe8" }}
    >
      {/* Mobile-only section nav — the desktop rail is hidden below 900px, so
          this is how you reach the rest of Match Ops on a phone. */}
      <MatchOpsMobileStrip />

      {/* Header */}
      <div className="flex-none px-4 pt-3.5">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[19px] font-[760] tracking-[-0.02em]" style={{ color: "#12241d" }}>
            Chats
          </h1>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] pl-[7px] text-[11px] font-bold"
            style={{ color: "#12704a", background: "#e0f2e7", borderColor: "#c9e8d8" }}
          >
            <i
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: sessionStatus === "error" ? "#e2502b" : "#35c77f",
                animation: sessionStatus === "ready" ? "mc-pulse 2.4s infinite" : undefined,
              }}
            />
            {liveLabel}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh"
            aria-label="Refresh"
            className="ml-auto flex h-11 w-11 items-center justify-center rounded-[10px] transition hover:bg-white/85 min-[900px]:h-[31px] min-[900px]:w-[31px]"
            style={{ color: "#5c7267" }}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} aria-hidden>
              <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
              <path d="M20.5 4.5V10H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search + city filter */}
      <div className="relative mt-2.5 flex flex-none items-center gap-2 px-4" ref={popWrapRef}>
        <div className="relative flex-1">
          <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-[11px] top-1/2 h-[15px] w-[15px] -translate-y-1/2" fill="none" stroke="#9aa8a1" strokeLinecap="round" strokeWidth={2} aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search venues, players…"
            className="h-9 w-full rounded-[11px] border pl-[33px] pr-[34px] text-[13px] outline-none transition focus:border-[#35c77f] focus:shadow-[0_0_0_3px_rgba(53,199,127,.15)]"
            style={{ background: "#ffffff", borderColor: "#e6ebe8", color: "#12241d" }}
          />
          {/* The "/" shortcut hint is meaningless on touch — desktop only. */}
          <kbd
            className="pointer-events-none absolute right-[9px] top-1/2 hidden -translate-y-1/2 rounded-[5px] border px-[5px] py-px text-[10.5px] font-bold min-[900px]:block"
            style={{ color: "#a4b0aa", background: "#eef3f0", borderColor: "#e2eae5" }}
          >
            /
          </kbd>
        </div>
        <button
          type="button"
          onClick={() => setPopOpen((v) => !v)}
          className="flex h-9 flex-none items-center gap-1.5 rounded-[11px] border px-[11px] text-[12.5px] font-[650] transition"
          style={
            cities.size > 0
              ? { borderColor: "#0d3b2e", background: "#0d3b2e", color: "#eafaf1" }
              : { borderColor: "#e6ebe8", background: "#ffffff", color: "#3f544a" }
          }
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} aria-hidden>
            <path d="M3 5h18" />
            <path d="M6.5 12h11" />
            <path d="M10 19h4" />
          </svg>
          {cityLabel}
        </button>

        {popOpen && (
          <div
            className="absolute right-4 top-[42px] z-20 w-[274px] rounded-[14px] border p-[11px] shadow-[0_2px_5px_rgba(7,42,32,.07),0_22px_44px_-24px_rgba(7,42,32,.55)]"
            style={{ background: "#ffffff", borderColor: "#e6ebe8" }}
          >
            <div className="mb-2 px-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.13em]" style={{ color: "#93a49b" }}>
              Filter by city
            </div>
            <div className="flex flex-wrap gap-[5px]">
              {ALL_CITY_CODES.map((code) => {
                const on = cities.has(code);
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggleCity(code)}
                    className="flex h-9 min-[900px]:h-[27px] items-center gap-[5px] rounded-full border px-[10px] text-[11.5px] font-bold tracking-[0.02em] transition"
                    style={
                      on
                        ? { background: "#0d3b2e", borderColor: "#0d3b2e", color: "#eafaf1" }
                        : { background: "#ffffff", borderColor: "#e6ebe8", color: "#5c7267" }
                    }
                  >
                    {code}
                    {on && <span className="-mr-0.5 text-[13px] leading-none opacity-75">×</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div
        className="mx-4 mb-3 mt-2.5 flex flex-none gap-0.5 rounded-[11px] p-[3px]"
        style={{ background: "rgba(0,0,0,.045)" }}
      >
        <Tab label="Active" n={activeCount} on={tab === "active"} onClick={() => onTabChange("active")} />
        <Tab label="Upcoming" n={upcomingCount} on={tab === "upcoming"} onClick={() => onTabChange("upcoming")} />
        <Tab label="Past" n={pastCount} on={tab === "past"} onClick={() => onTabChange("past")} />
      </div>

      {error && (
        <div className="mx-4 mb-2 flex-none rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>
          {error}
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3.5">
        {loading && !dataReady && (
          <div className="flex h-full items-center justify-center px-6 text-xs" style={{ color: "#93a49b" }}>
            Loading…
          </div>
        )}
        {!loading && rows.length === 0 && !error && (
          <div className="px-4 py-9 text-center text-[12.5px]" style={{ color: "#93a49b" }}>
            {emptyStateFor(tab, cities.size > 0, searching)}
          </div>
        )}
        {rows.map((r) => (
          <Row
            key={r.chat_id}
            row={r}
            selected={r.chat_id === selectedChatId}
            onSelect={() => onSelect(r.chat_id)}
          />
        ))}
      </div>

      {/* Footer keyboard hints — desktop only; a keyboard shortcut bar is a
          lie on a touch device (no arrow keys, no Enter, no "/"). */}
      <div
        className="hidden flex-none items-center gap-2.5 border-t px-4 py-2 text-[11px] font-semibold min-[900px]:flex"
        style={{ borderColor: "#e6ebe8", background: "#eef3f0", color: "#93a49b" }}
      >
        <Kbd>↑↓</Kbd> move <Kbd>↵</Kbd> open <Kbd>/</Kbd> search
      </div>

      <style>{`@keyframes mc-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}`}</style>
    </section>
  );
}

// ---------------- pieces ----------------

function Tab({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[8px] text-[12.5px] font-[650] transition min-[900px]:h-[30px]"
      style={
        on
          ? { background: "#ffffff", color: "#0f3d2e", fontWeight: 730, boxShadow: "0 1px 2px rgba(7,42,32,.09)" }
          : { color: "#5c7267" }
      }
    >
      {label}
      <span className="text-[11px] font-bold" style={{ color: on ? "#3d9b73" : "#93a49b" }}>
        {n}
      </span>
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[5px] border px-[5px] py-px text-[10px] font-bold" style={{ background: "#ffffff", borderColor: "#e6ebe8", color: "#7c8b83" }}>
      {children}
    </kbd>
  );
}

function Row({
  row,
  selected,
  onSelect,
}: {
  row: MatchChatInboxRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const m = row.match;
  const isCancelled = m?.is_cancelled === true;
  const isOrphan = m == null;
  const isQuiet = row.last_message == null;
  const dim = (isCancelled || isQuiet || isOrphan) && !selected;

  const title = useMemo(() => {
    if (isOrphan) return null;
    return formatMatchTitle({
      cityCode: m?.city_identifier ?? null,
      startDateIso: m?.start_date_utc ?? null,
      fieldTitle: m?.field_title ?? null,
    });
  }, [m, isOrphan]);

  const badge = badgeFor(m?.city_identifier);
  const badgeText = isOrphan ? "??" : title?.cityCode || UNKNOWN_CITY;
  const hasVeo = !!row.last_message?.body && VEO_RE.test(row.last_message.body);

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        touchAction: "manipulation",
        ...(selected
          ? { background: "#ffffff", borderColor: "#e2eae5", boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 14px 30px -22px rgba(7,42,32,.5)" }
          : { borderColor: "transparent" }),
        opacity: dim ? 0.6 : 1,
      }}
      className={`group relative mt-px flex w-full items-start gap-2.5 rounded-[13px] border p-[10px_11px] text-left transition ${
        selected ? "" : "hover:bg-white/80"
      }`}
    >
      {selected && (
        <span aria-hidden className="absolute left-0 top-[11px] bottom-[11px] w-[3px] rounded-r-[3px]" style={{ background: "#35c77f" }} />
      )}
      <span
        className="mt-px flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[11px] text-[9.5px] font-extrabold tracking-[0.02em]"
        style={{ background: badge.bg, color: badge.fg }}
      >
        {badgeText}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-[660] tracking-[-0.008em]" style={{ color: "#12241d" }}>
            {isOrphan ? `Match ${row.chat_id}` : title?.venue || "—"}
          </span>
          {row.last_message && (
            <span className="flex-none text-[11px] font-[650]" style={{ color: "#9aa8a1" }}>
              {timeAgo(row.last_message.sent_at)}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] font-[550]" style={{ color: "#6d7b74" }}>
          {isOrphan ? (
            <span className="italic">(no match data)</span>
          ) : (
            <>
              <span>{title?.date}</span>
              {title?.time && (
                <>
                  <span aria-hidden className="inline-block h-[3px] w-[3px] rounded-full" style={{ background: "#c9d2cd" }} />
                  <span>{title.time}</span>
                </>
              )}
            </>
          )}
        </span>
        <span
          className="mt-[5px] block overflow-hidden text-[12.5px] leading-[1.42]"
          style={{ color: "#63736b", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
        >
          {row.last_message ? (
            row.last_message.body && WA_INVITE_RE.test(row.last_message.body) ? (
              <span className="italic" style={{ color: "#8d9c94" }}>Invite link posted by MatchDay</span>
            ) : (
              <>
                {row.last_message.sent_by && (
                  <span className="font-[650]" style={{ color: "#4a5f55" }}>
                    {row.last_message.sent_by}:{" "}
                  </span>
                )}
                {row.last_message.body ? row.last_message.body : <span className="italic" style={{ color: "#8d9c94" }}>(media)</span>}
              </>
            )
          ) : (
            <span className="italic" style={{ color: "#8d9c94" }}>No messages yet</span>
          )}
        </span>
        {(isCancelled || hasVeo) && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {isCancelled && (
              <span className="rounded-[6px] border px-[7px] py-0.5 text-[10px] font-[750]" style={{ background: "#eef3f0", borderColor: "#e2eae5", color: "#6d7b74" }}>
                Cancelled
              </span>
            )}
            {hasVeo && (
              <span className="rounded-[6px] border px-[7px] py-0.5 text-[10px] font-[750]" style={{ background: "#eef0fa", borderColor: "#dde1f4", color: "#4a539a" }}>
                Veo
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}
