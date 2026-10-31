"use client";

// THE MATCH PICKER (Figma 20638:45), in The deal and in Button opens. The list opens in the panel's own
// flow, not over it, because the panel clips what overflows. Rows lead with the match's name, then field
// and city, as Gameday Ops does (the design showed the field alone). Search, Next 7 / Next 14 days and Needs
// players only narrow what's already loaded; every rule and string is pickerView in src/lib/offersModel.ts.

import { useMemo, useState } from "react";
import { fillFraction, matchNeeds, fillText, money, matchPicked, matchTitle, matchWhere, pickerView, type City, type MatchOpt, type PickerDays } from "@/lib/offersModel";
import { O } from "./offersUi";

export default function MatchPicker({ matches, cities, cityIds, selected, nowWall, onPick, onOpen, onRetry, listState, listError, partial, disabled, locked, testId, empty }: {
  matches: MatchOpt[]; cities: City[]; cityIds: number[]; selected: MatchOpt | null; nowWall: string; onPick: (id: number) => void;
  onOpen: () => void; onRetry: () => void; listState: "ready" | "loading" | "failed"; listError: string | null; partial: boolean;
  disabled?: boolean; locked?: boolean; testId: string; empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [days, setDays] = useState<PickerDays>(7);
  const [needsPlayers, setNeedsPlayers] = useState(true);
  const view = useMemo(() => pickerView(matches, { search, days, needsPlayers, cityIds }, nowWall, cities), [matches, search, days, needsPlayers, cityIds, nowWall, cities]);
  const off = disabled || locked;
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" data-testid={testId} data-open={open ? "1" : "0"} disabled={off} onClick={() => { onOpen(); setOpen((v) => !v); }}
        className="flex w-full items-center justify-between gap-2 rounded-[8px] border px-3 py-[9px] text-left text-[13px] font-medium disabled:cursor-not-allowed"
        style={{ borderColor: O.line, background: locked ? "#eef0ee" : O.surface, color: locked ? O.muted : selected ? O.ink : O.muted, opacity: disabled && !locked ? 0.6 : 1 }}>
        <span className="truncate">{selected ? matchPicked(selected) : empty ?? "Pick a match"}</span>
        <span className="shrink-0 text-[12px]" style={{ color: O.muted }}>{locked ? "🔒" : open ? "⌃" : "⌄"}</span>
      </button>
      {open && !off && (
        <div data-testid={`${testId}-list`} className="flex flex-col overflow-hidden rounded-[12px] border shadow-[0_8px_24px_rgba(0,51,38,0.12)]" style={{ background: O.surface, borderColor: O.line }}>
          <div className="flex flex-col gap-2.5 p-3">
            <label className="flex items-center gap-2 rounded-[8px] px-2.5 py-[9px]" style={{ background: O.subtle }}>
              <span className="text-[14px] font-medium" style={{ color: O.label }}>⌕</span>
              <input data-testid={`${testId}-search`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search match or field" aria-label="Search match or field"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#7d948a]" style={{ color: O.ink }} />
            </label>
            <div className="flex flex-wrap gap-1.5">
              <FilterChip testId={`${testId}-7`} on={days === 7} onClick={() => setDays(7)}>Next 7 days</FilterChip>
              <FilterChip testId={`${testId}-14`} on={days === 14} onClick={() => setDays(14)}>Next 14 days</FilterChip>
              <FilterChip testId={`${testId}-needs`} on={needsPlayers} onClick={() => setNeedsPlayers((v) => !v)}>Needs players</FilterChip>
            </div>
          </div>
          <div className="max-h-[342px] overflow-y-auto">
            {listState === "failed" && (
              <div data-testid={`${testId}-failed`} className="flex flex-wrap items-center gap-x-2 border-t px-3 py-2.5 text-[12px] font-medium" style={{ borderColor: O.line, background: O.critBg, color: O.critInk }}>
                <span>Couldn&apos;t load the matches: {listError}</span>
                <button type="button" data-testid={`${testId}-retry`} className="font-semibold underline" onClick={onRetry}>Retry</button>
              </div>
            )}
            {listState === "loading" && <div data-testid={`${testId}-loading`} className="border-t px-3 py-2.5 text-[12px]" style={{ borderColor: O.line, color: O.muted }}>Loading matches…</div>}
            {listState === "ready" && view.groups.length === 0 && (
              <div data-testid={`${testId}-none`} className="border-t px-3 py-6 text-center text-[12px]" style={{ borderColor: O.line, color: O.muted }}>
                No matches here. {needsPlayers ? "Try turning off Needs players." : days === 7 ? "Try Next 14 days." : "Try another search."}
              </div>
            )}
            {view.groups.map((g) => (
              <div key={g.label}>
                <div data-testid={`${testId}-day`} className="px-3 py-1.5 text-[10px] font-semibold tracking-[0.6px]" style={{ background: O.subtle, color: O.label }}>{g.label}</div>
                {g.rows.map((r) => {
                  const on = selected?.id === r.match.id;
                  const needs = matchNeeds(r.match) > 0;
                  return (
                    <button key={r.match.id} type="button" data-testid={`${testId}-row`} data-id={r.match.id} data-on={on ? "1" : "0"}
                      onClick={() => { onPick(r.match.id); setOpen(false); }}
                      className="flex w-full items-center gap-2.5 border-b px-3 py-2.5 text-left" style={{ borderColor: O.line, background: on ? O.mint : O.surface }}>
                      <span className="w-[64px] shrink-0 whitespace-nowrap text-[13px] font-semibold" style={{ color: O.ink }}>{r.time}</span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex min-w-0 flex-col">
                          <span data-testid={`${testId}-title`} className="truncate text-[13px] font-bold" style={{ color: O.ink }}>{matchTitle(r.match)}</span>
                          <span data-testid={`${testId}-where`} className="truncate text-[11.5px]" style={{ color: O.muted }}>{matchWhere(r.match, cities)}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="relative h-1 w-[80px] shrink-0 overflow-hidden rounded-[2px]" style={{ background: O.line }}>
                            <span className="absolute left-0 top-0 h-1 rounded-[2px]" style={{ width: `${fillFraction(r.match) * 100}%`, background: needs ? "#e6b23a" : O.ok }} />
                          </span>
                          <span data-testid={`${testId}-fill`} className="truncate text-[11px]" style={{ color: needs ? O.warnInk : O.muted }}>{fillText(r.match)}</span>
                        </span>
                      </span>
                      <span className="shrink-0 text-[13px] font-medium" style={{ color: O.muted }}>{money(r.match.price)}</span>
                      {on && <span className="shrink-0 text-[14px] font-bold" style={{ color: O.ok }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div data-testid={`${testId}-footer`} className="px-3 py-2.5 text-[11px]" style={{ color: O.label }}>{view.footer}{partial ? " (the soonest ones; there are more)" : ""}</div>
        </div>
      )}
    </div>
  );
}

function FilterChip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; testId: string }) {
  return (
    <button type="button" data-testid={testId} data-on={on ? "1" : "0"} onClick={onClick}
      className={`whitespace-nowrap rounded-full border px-2.5 py-1.5 text-[12px] ${on ? "font-semibold" : "font-medium"}`}
      style={on ? { background: O.chipOn, borderColor: O.chipOn, color: "#fff" } : { background: O.surface, borderColor: O.line, color: O.ink }}>{children}</button>
  );
}
