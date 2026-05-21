"use client";

import { useMemo } from "react";
import { useMatchWindowData } from "@/lib/useMatchData";
import { getCancelHeatmap, weekLabel } from "@/lib/cityStats";

function keyToLabel(key: string): string {
  const [yr, mo, dy] = key.split("-").map(Number);
  return weekLabel(new Date(yr, mo - 1, dy));
}

function rateColor(rate: number): string {
  if (rate >= 75) return "text-coral";
  if (rate >= 50) return "text-[#d97706]";
  return "text-mint-hover";
}

export default function CancelHeatmap({
  city,
  showAllSlots = false,
  highlightRecentCancels = false,
}: {
  city: string;
  // When true, every recurring slot for the city renders — not just
  // those with at least one cancellation in the window. Slate Review
  // uses this so the full slate's attendance is visible with
  // cancellations shown inline. Default false keeps the original
  // /cities/[city] behavior.
  showAllSlots?: boolean;
  // When true, slots that cancelled in the most-recent COMPLETED week
  // get a row-level marker (left border + faint tint). Most-recent
  // completed = weeks[weeks.length - 2] (the cell before the current
  // in-progress week). Default false.
  highlightRecentCancels?: boolean;
}) {
  // Shares the 12-week city-scoped cache entry with CityDetailView —
  // same window, same city, same key, so this component piggybacks on
  // the parent's already-pending or already-resolved fetch.
  const { rows, meta, loading } = useMatchWindowData(12, city);

  const heatmap = useMemo(
    () =>
      rows.length === 0
        ? null
        : getCancelHeatmap(rows, city, 8, new Date(), {
            includeAllSlots: showAllSlots,
          }),
    [rows, city, showAllSlots],
  );

  if (loading || !meta || !heatmap) return null;

  const { weeks, slots } = heatmap;
  // weeks is oldest → newest; weeks[length-1] = current (in progress),
  // weeks[length-2] = most-recent completed. Falls back to last when
  // only one week is available (defensive — shouldn't happen at the
  // default 8-week window).
  const recentCompletedKey =
    weeks.length >= 2 ? weeks[weeks.length - 2] : (weeks[weeks.length - 1] ?? null);

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
        Last 8 weeks ·{" "}
        {showAllSlots
          ? "all recurring slots"
          : "slots with at least 1 cancellation"}{" "}
        · sorted by day
      </div>

      <div className="mt-3 mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-deep-green/70">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className="block h-4 w-4 rounded bg-coral" />
          <span>
            Cancelled <span className="text-deep-green/50">(# booked)</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="block h-4 w-4 rounded bg-[#e8f8ee] ring-1 ring-inset ring-cream-line"
          />
          <span>
            Ran <span className="text-deep-green/50">(# played)</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span aria-hidden className="block h-4 w-4 rounded bg-cream-line" />
          <span>Not scheduled</span>
        </div>
      </div>

      {slots.length === 0 ? (
        <div className="rounded-xl bg-cream-soft px-4 py-8 text-center text-sm text-deep-green/60">
          {showAllSlots
            ? "No scheduled matches in the last 8 weeks."
            : "No cancellations in the last 8 weeks."}
        </div>
      ) : (
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                <th className="px-3 py-2 text-left">Field</th>
                <th className="px-2 py-2 text-left">Day</th>
                <th className="px-2 py-2 text-left">Time</th>
                {weeks.map((wk) => (
                  <th key={wk} className="px-1 py-2 text-center">
                    {keyToLabel(wk)}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((slot, i) => {
                const prev = i > 0 ? slots[i - 1] : null;
                const newDay = !prev || prev.dowIdx !== slot.dowIdx;
                let cancels = 0;
                let ran = 0;
                for (const wk of weeks) {
                  const w = slot.weeks[wk];
                  if (!w) continue;
                  if (w.cancelled) cancels += w.spots;
                  else ran += w.players;
                }
                const denom = cancels + ran;
                const rate = denom === 0 ? 0 : (cancels / denom) * 100;
                // Row marker: slot canceled in the most-recent COMPLETED
                // week. Gated on the prop so /cities/[city] stays clean
                // and only Slate Review surfaces the accent.
                const recentlyCanceled =
                  highlightRecentCancels &&
                  recentCompletedKey != null &&
                  slot.weeks[recentCompletedKey]?.cancelled === true;
                const baseBorder = newDay
                  ? "border-t-2 border-cream-line"
                  : "border-t border-cream-line/40";
                const accent = recentlyCanceled
                  ? "border-l-4 border-l-coral bg-coral-soft/30"
                  : "";
                return (
                  <tr
                    key={`${slot.field}|${slot.dowIdx}|${slot.time}`}
                    className={`${baseBorder} ${accent}`.trim()}
                    title={
                      recentlyCanceled
                        ? `${slot.field} · ${slot.dow} ${slot.time}: cancelled in the most recent completed week`
                        : undefined
                    }
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-deep-green">
                      {slot.field}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-deep-green/70">
                      {slot.dow}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-deep-green/70">
                      {slot.time}
                    </td>
                    {weeks.map((wk) => {
                      const cell = slot.weeks[wk];
                      if (!cell) {
                        return (
                          <td key={wk} className="px-1 py-1">
                            <div
                              aria-hidden
                              className="mx-auto h-[26px] w-[36px] rounded bg-cream-line"
                            />
                          </td>
                        );
                      }
                      if (cell.cancelled) {
                        return (
                          <td key={wk} className="px-1 py-1">
                            <div
                              className="mx-auto flex h-[26px] w-[36px] items-center justify-center rounded bg-coral text-xs font-bold tabular-nums text-white"
                              title={`${slot.field} · ${slot.dow} ${slot.time} · ${keyToLabel(wk)}: cancelled, ${cell.spots} booked`}
                            >
                              {cell.spots}
                            </div>
                          </td>
                        );
                      }
                      return (
                        <td key={wk} className="px-1 py-1">
                          <div
                            className="mx-auto flex h-[26px] w-[36px] items-center justify-center rounded bg-[#e8f8ee] text-xs font-bold tabular-nums text-deep-green"
                            title={`${slot.field} · ${slot.dow} ${slot.time} · ${keyToLabel(wk)}: ran, ${cell.players} played`}
                          >
                            {cell.players}
                          </div>
                        </td>
                      );
                    })}
                    <td
                      className={`whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums ${rateColor(rate)}`}
                    >
                      {Math.round(rate)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
