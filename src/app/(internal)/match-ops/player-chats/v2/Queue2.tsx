"use client";

// THE QUEUE of Player Chats 2.0 (Figma 20851:95), and its collapsed form, a column of faces with
// wait times (Figma 20855:44), shown while Player details is open.
//
// Rows: name, city code, Member tag, a one-line preview, the wait coloured by urgency (over 30m
// red, over 10m amber; src/lib/inbox2Model). No star, no avatar, no select-all on the row — the
// star is in the conversation's ⋯ menu and bulk close is the Select mode, both kept.

import { useEffect, useRef, useState } from "react";
import { ChevronRight, RotateCcw, Search as SearchIcon, SlidersHorizontal, X } from "lucide-react";
import EnablePushNotificationsButton from "@/components/EnablePushNotificationsButton";
import { KNOWN_CITY_CODES, HIDDEN_CITY_CODES } from "@/lib/cityNormalization";
import { UNKNOWN_CITY } from "@/lib/cityColors";
import { awaitingAgeLabel } from "@/lib/awaitingReply";
import { rowAttention } from "@/lib/crmAttention";
import { WAIT_COLOR, initials, waitStartIso, waitTone, type Inbox2Tab } from "@/lib/inbox2Model";
import type { ThreadListRow } from "@/lib/crmConversation";
import AutoSendCountdown from "../components/AutoSendCountdown";

const INK = "#13241d", MUTED = "#5e6b66", FAINT = "#7c8782", LINE = "#e3e3db", DEEP = "#0e3b2c";

export function fullNameOf(t: ThreadListRow): string {
  const full = `${t.player?.first_name?.trim() ?? ""} ${t.player?.last_name?.trim() ?? ""}`.trim();
  return full || t.phone_number;
}
export function cityCodeOf(t: ThreadListRow): string {
  const c = t.city_code || t.player?.preferable_city_normalized;
  return c && c.length > 0 ? c : UNKNOWN_CITY;
}

export type Filters = { cities: Set<string>; starred: boolean; assigned: boolean; members: boolean; search: string };
export const NO_FILTERS: Filters = { cities: new Set(), starred: false, assigned: false, members: false, search: "" };
export const filtersActive = (f: Filters) => f.cities.size > 0 || f.starred || f.assigned || f.members || f.search.trim().length > 0;

export default function Queue2(props: {
  tab: Inbox2Tab; onTab: (t: Inbox2Tab) => void;
  needsCount: number; waitingCount: number;
  auto: ThreadListRow[]; rows: ThreadListRow[];
  selectedId: string | null; onSelect: (id: string) => void;
  nowMs: number; appUserId: string | null;
  filters: Filters; setFilters: (f: Filters) => void;
  legacyView: string | null; onClearLegacy: () => void;
  loading: boolean; error: string | null; realtimeOk: boolean | null; onRefresh: () => void;
  selectMode: boolean; selectedIds: Set<string>; onToggleSelected: (id: string) => void; onCloseSelected: () => void; onExitSelect: () => void;
  onHoldChanged: () => void;
  empty: React.ReactNode; listNote: string | null;
  onUseOld: () => void;
  freeze: () => void; thaw: () => void;
}) {
  const { tab, onTab, needsCount, waitingCount, auto, rows, selectedId, onSelect, nowMs, filters, setFilters } = props;
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, as on the old page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.focus(), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filterCount = filters.cities.size + [filters.starred, filters.assigned, filters.members].filter(Boolean).length;
  const live = props.realtimeOk == null ? "Connecting" : props.realtimeOk ? "Live" : "Offline";

  return (
    <aside data-testid="queue2" className="flex min-h-0 w-full flex-col bg-white lg:w-[360px] lg:shrink-0 lg:border-r" style={{ borderColor: LINE }}>
      <div className="flex flex-col gap-3 px-[18px] pb-3 pt-[18px]">
        <div className="flex items-center gap-1">
          {/* Below 1024px the shell's app bar already says "Player Chats". */}
          <h1 className="hidden min-w-0 flex-1 truncate text-[20px] font-bold lg:block" style={{ color: INK }}>Player Chats</h1>
          <span title={live} data-testid="queue-live" className="ml-auto mr-1 h-2 w-2 rounded-full lg:ml-0" style={{ background: props.realtimeOk === false ? "#d64531" : props.realtimeOk ? "#2cdb87" : "#c9d2cd" }} />
          <button type="button" aria-label="Search" title="Search ( / )" data-testid="queue-search-toggle" onClick={() => { setSearchOpen((o) => !o); setTimeout(() => searchRef.current?.focus(), 0); }}
            className="flex h-9 w-9 items-center justify-center rounded-[8px] hover:bg-[#f3f3ef]" style={{ color: filters.search ? DEEP : "#5e6b66" }}>
            <SearchIcon aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </button>
          <div className="relative">
            <button type="button" aria-label="Filter" data-testid="queue-filter" onClick={() => setFilterOpen((o) => !o)}
              className="relative flex h-9 w-9 items-center justify-center rounded-[8px] hover:bg-[#f3f3ef]" style={{ color: filterCount ? DEEP : "#5e6b66" }}>
              <SlidersHorizontal aria-hidden className="h-[18px] w-[18px]" strokeWidth={1.9} />
              {filterCount > 0 && <span className="absolute right-0.5 top-0.5 rounded-full bg-[#2cdb87] px-[4px] text-[9px] font-bold text-[#0e3b2c]">{filterCount}</span>}
            </button>
            {filterOpen && <FilterPopover filters={filters} setFilters={setFilters} onClose={() => setFilterOpen(false)} />}
          </div>
          {/* The notifications bell renders at EVERY width: on a phone it is the only way to subscribe. */}
          <EnablePushNotificationsButton />
          <button type="button" aria-label="Refresh" title="Refresh" onClick={props.onRefresh}
            className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[#5e6b66] hover:bg-[#f3f3ef]">
            <RotateCcw aria-hidden className="h-4 w-4" strokeWidth={1.9} />
          </button>
        </div>
        {(searchOpen || filters.search) && (
          <div className="relative">
            <SearchIcon aria-hidden className="pointer-events-none absolute left-[10px] top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-[#9aa39f]" />
            <input ref={searchRef} data-testid="crm-search" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="Search name, phone or message" onKeyDown={(e) => { if (e.key === "Escape") { setFilters({ ...filters, search: "" }); setSearchOpen(false); } }}
              className="h-9 w-full rounded-[10px] border pl-8 pr-8 text-base outline-none focus:border-[#2cdb87] min-[900px]:text-[13px]" style={{ borderColor: LINE, color: INK }} />
            {filters.search && (
              <button type="button" aria-label="Clear search" onClick={() => { setFilters({ ...filters, search: "" }); setSearchOpen(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#7c8782]"><X aria-hidden className="h-3.5 w-3.5" /></button>
            )}
          </div>
        )}
        <div className="flex gap-1 rounded-[10px] bg-[#f3f3ef] p-1" role="tablist">
          {([["needs", "Needs reply", needsCount], ["waiting", "Waiting", waitingCount], ["done", "Done", null]] as const).map(([k, label, n]) => {
            const on = tab === k;
            return (
              <button key={k} role="tab" aria-selected={on} type="button" data-testid={`queue-tab-${k}`} onClick={() => onTab(k)}
                className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[8px] text-[13px] min-[900px]:h-[31px]"
                style={on ? { background: "#fff", color: INK, fontWeight: 600, boxShadow: "0 1px 2px rgba(9,30,20,.06)" } : { color: MUTED, fontWeight: 500 }}>
                {label}
                {n != null && (
                  <span className="rounded-full px-1.5 py-px text-[11px] font-semibold" data-testid={`queue-count-${k}`}
                    style={k === "needs" && n > 0 ? { background: "#d64531", color: "#fff" } : { background: "#e3e3db", color: MUTED }}>{n}</span>
                )}
              </button>
            );
          })}
        </div>
        {props.legacyView && (
          <div className="flex items-center gap-2 text-[12px]" style={{ color: MUTED }}>
            Showing: {props.legacyView}
            <button type="button" onClick={props.onClearLegacy} className="rounded-full border px-2 py-px text-[11px] font-semibold" style={{ borderColor: LINE }}>Clear</button>
          </div>
        )}
        {props.selectMode && (
          <div data-testid="queue-select-bar" className="flex items-center gap-2 rounded-[10px] bg-[#f7f7f3] px-3 py-2 text-[12px]" style={{ color: INK }}>
            <span className="font-semibold">{props.selectedIds.size} selected</span>
            <button type="button" onClick={props.onExitSelect} className="ml-auto font-semibold" style={{ color: MUTED }}>Cancel</button>
            <button type="button" data-testid="queue-close-selected" disabled={props.selectedIds.size === 0} onClick={props.onCloseSelected}
              className="rounded-[8px] px-2.5 py-1 font-semibold text-white disabled:opacity-40" style={{ background: DEEP }}>Mark done</button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" onPointerDown={props.freeze} onPointerUp={props.thaw} onPointerCancel={props.thaw} onPointerLeave={props.thaw}>
        {props.error && <div className="mx-[18px] mb-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#e3c369", background: "#fdf1d0", color: "#8a6300" }}>{props.error}</div>}
        {props.loading && rows.length === 0 && auto.length === 0 && <p className="px-[18px] py-6 text-[12px]" style={{ color: FAINT }}>Loading conversations…</p>}
        {auto.length > 0 && (
          <div>
            <button type="button" data-testid="crm-auto-section" aria-expanded={autoOpen} onClick={() => setAutoOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-[18px] pb-[6px] pt-[10px] text-left text-[10px] font-semibold tracking-[0.08em]" style={{ color: FAINT }}>
              {autoOpen ? "▾" : "▸"} AUTO-SENDING · {auto.length}
            </button>
            {autoOpen && auto.map((t) => (
              <Row key={t.id} t={t} tab={tab} active={t.id === selectedId} nowMs={nowMs} onSelect={() => onSelect(t.id)}
                selectMode={props.selectMode} checked={props.selectedIds.has(t.id)} onCheck={() => props.onToggleSelected(t.id)} mine={t.assigned_to_user_id === props.appUserId}>
                <AutoSendCountdown threadId={t.id} holdUntil={rowAttention({ ...t, awaiting: t.awaiting ?? true })?.hold_until ?? null} onDone={props.onHoldChanged} />
              </Row>
            ))}
          </div>
        )}
        {rows.map((t) => (
          <Row key={t.id} t={t} tab={tab} active={t.id === selectedId} nowMs={nowMs} onSelect={() => onSelect(t.id)}
            selectMode={props.selectMode} checked={props.selectedIds.has(t.id)} onCheck={() => props.onToggleSelected(t.id)} mine={t.assigned_to_user_id === props.appUserId} />
        ))}
        {props.empty}
        {props.listNote && <p className="px-[18px] py-3 text-[11px]" style={{ color: FAINT }}>{props.listNote}</p>}
      </div>
      <div className="border-t px-[18px] py-2" style={{ borderColor: LINE }}>
        <button type="button" data-testid="chats-use-old" onClick={props.onUseOld} className="text-[11px] font-semibold" style={{ color: MUTED }}>
          Back to the old one
        </button>
      </div>
    </aside>
  );
}

function Row({ t, tab, active, nowMs, onSelect, selectMode, checked, onCheck, mine, children }: {
  t: ThreadListRow; tab: Inbox2Tab; active: boolean; nowMs: number; onSelect: () => void;
  selectMode: boolean; checked: boolean; onCheck: () => void; mine: boolean; children?: React.ReactNode;
}) {
  const name = fullNameOf(t);
  const owed = tab === "needs";
  const since = owed ? waitStartIso(t) : t.last_message_at;
  const tone = owed ? waitTone(since, nowMs) : "plain";
  const att = rowAttention({ ...t, awaiting: t.awaiting ?? false });
  const ours = t.last_message_direction === "outbound";
  const preview = t.last_message_preview ?? "";
  return (
    <div style={active ? { background: "#f0faf5", boxShadow: "inset 3px 0 0 #2cdb87" } : undefined}>
    <div className="flex items-stretch">
      {selectMode && (
        <label className="flex items-center pl-[14px]">
          <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select ${name}`} className="h-4 w-4 accent-[#0e3b2c]" />
        </label>
      )}
      <button type="button" onClick={onSelect} data-testid="crm-thread-row" data-thread-id={t.id} data-unread={t.is_unread ? 1 : 0}
        data-section={att?.section ?? "answered"} title={att?.reason ?? undefined} style={{ touchAction: "manipulation" }}
        className={`flex min-w-0 flex-1 flex-col gap-[3px] px-[18px] py-3 text-left ${active ? "" : "hover:bg-[#fafaf7]"}`}>
        <span className="flex w-full items-center gap-1.5">
          {t.is_unread && <span aria-label="Unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#2cdb87]" />}
          <span data-testid="crm-thread-name" className={`truncate text-[14px] ${t.is_unread ? "font-bold" : "font-semibold"}`} style={{ color: owed || tab === "done" ? INK : MUTED }}>{name}</span>
          <span className="shrink-0 text-[12px]" style={{ color: FAINT }}>{cityCodeOf(t)}</span>
          {t.player?.is_member && <span className="shrink-0 rounded-full bg-[#e7f1fb] px-1.5 py-px text-[10px] font-semibold text-[#264da6]">Member</span>}
          {mine && <span className="shrink-0 text-[11px] font-semibold" style={{ color: MUTED }}>· You</span>}
          <span className="flex-1" />
          <span data-testid="crm-thread-wait" data-tone={tone} className="shrink-0 text-[12px] font-semibold" style={{ color: owed ? WAIT_COLOR[tone] : "#9aa39f" }}>
            {awaitingAgeLabel(since, nowMs)}
          </span>
        </span>
        <span data-testid="crm-thread-preview" className="block w-full truncate text-[13px]" style={{ color: owed ? INK : FAINT }}>
          {ours ? "You: " : ""}{preview || <i>(no preview)</i>}
        </span>
        {att?.error && att.reason && <span data-testid="crm-human-reason" data-error={1} className="block truncate text-[12px] font-semibold text-[#a82a18]">{att.reason}</span>}
      </button>
    </div>
    {children && <div className="-mt-1 px-[18px] pb-3">{children}</div>}
    </div>
  );
}

/** The faces column (Figma 20855:44): the queue collapsed while Player details is open. The ›, or
 *  any face, restores the full queue. */
export function FacesColumn({ rows, needsCount, selectedId, tab, nowMs, onExpand, onPick }: {
  rows: ThreadListRow[]; needsCount: number; selectedId: string | null; tab: Inbox2Tab; nowMs: number;
  onExpand: () => void; onPick: (id: string) => void;
}) {
  return (
    <aside data-testid="queue-faces" className="hidden w-[84px] shrink-0 flex-col items-center gap-[6px] overflow-y-auto border-r bg-white py-4 lg:flex" style={{ borderColor: LINE }}>
      <button type="button" data-testid="queue-expand" aria-label="Show the full queue" onClick={onExpand}
        className="mb-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border bg-white text-[#13241d]" style={{ borderColor: LINE }}>
        <ChevronRight aria-hidden className="h-4 w-4" />
      </button>
      {needsCount > 0 && <span className="mb-1 rounded-full bg-[#d64531] px-[7px] py-px text-[11px] font-semibold text-white">{needsCount}</span>}
      {rows.map((t) => {
        const owed = tab === "needs";
        const since = owed ? waitStartIso(t) : t.last_message_at;
        const tone = owed ? waitTone(since, nowMs) : "plain";
        const active = t.id === selectedId;
        return (
          <button key={t.id} type="button" data-testid="queue-face" data-thread-id={t.id} onClick={() => onPick(t.id)} title={fullNameOf(t)}
            className="flex shrink-0 flex-col items-center gap-[3px] py-1">
            <span className="flex h-10 w-10 items-center justify-center rounded-full text-[12px] font-bold"
              style={active ? { background: "#fff", boxShadow: "0 0 0 2px #2cdb87", color: DEEP } : { background: "#f3f3ef", color: owed ? DEEP : "#9aa39f" }}>
              {initials(fullNameOf(t))}
            </span>
            <span className="text-[11px] font-semibold" style={{ color: owed ? WAIT_COLOR[tone] : "#9aa39f" }}>{awaitingAgeLabel(since, nowMs)}</span>
          </button>
        );
      })}
    </aside>
  );
}

// The same city list the old filter offered.
const PICKABLE: readonly string[] = [...KNOWN_CITY_CODES.filter((c) => !HIDDEN_CITY_CODES.has(c)), UNKNOWN_CITY];

function FilterPopover({ filters, setFilters, onClose }: { filters: Filters; setFilters: (f: Filters) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose]);
  const chip = (on: boolean) => `flex h-9 items-center gap-1 rounded-full border px-[10px] text-[12px] font-semibold min-[900px]:h-[27px] ${on ? "border-[#0e3b2c] bg-[#0e3b2c] text-white" : "border-[#e3e3db] bg-white text-[#5e6b66]"}`;
  const flags: { k: "starred" | "assigned" | "members"; label: string }[] = [
    { k: "starred", label: "Starred" }, { k: "assigned", label: "Assigned to me" }, { k: "members", label: "Members only" },
  ];
  return (
    <div ref={ref} data-testid="queue-filter-popover" className="absolute right-0 top-10 z-30 w-[280px] rounded-[12px] border bg-white p-3 shadow-[0_12px_32px_rgba(9,30,20,.16)]" style={{ borderColor: LINE }}>
      <div className="mb-2 text-[10px] font-semibold tracking-[0.08em]" style={{ color: FAINT }}>CITY</div>
      <div className="flex flex-wrap gap-[5px]">
        {PICKABLE.map((c) => {
          const on = filters.cities.has(c);
          return (
            <button key={c} type="button" className={chip(on)} onClick={() => {
              const next = new Set(filters.cities); if (on) next.delete(c); else next.add(c);
              setFilters({ ...filters, cities: next });
            }}>{c}{on && " ×"}</button>
          );
        })}
      </div>
      <div className="mb-2 mt-3 text-[10px] font-semibold tracking-[0.08em]" style={{ color: FAINT }}>ONLY SHOW</div>
      <div className="flex flex-wrap gap-[5px]">
        {flags.map((f) => (
          <button key={f.k} type="button" className={chip(filters[f.k])} onClick={() => setFilters({ ...filters, [f.k]: !filters[f.k] })}>
            {f.label}{filters[f.k] && " ×"}
          </button>
        ))}
      </div>
      {filtersActive({ ...filters, search: "" }) && (
        <button type="button" onClick={() => setFilters({ ...NO_FILTERS, search: filters.search })} className="mt-3 text-[12px] font-semibold" style={{ color: DEEP }}>Clear filters</button>
      )}
    </div>
  );
}
