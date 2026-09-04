"use client";

/* CANCEL PATTERNS AS A RANKING — one implementation, two callers.
 *
 * LIFTED OUT OF MatchPromotionMobile, not copied. That file already rendered this exact data as a
 * ranked list with an n/4 badge, and Slate Review needed the same thing on a phone; a second copy
 * is how two screens start disagreeing about the same cancellations.
 *
 * ONE ROW PER SLOT, NOT PER CANCELLATION. That collapse is the whole argument of the view: 49
 * cancellations across four weeks are 15 slots, and it is the slot that is the pattern.
 *
 * THE BADGE PRINTS THE NUMBER. Both callers' ramps are deliberately NON-MONOTONIC in lightness —
 * 3-of-4 is darker than 4-of-4 — and that is safe ONLY because the exact count is on every badge,
 * so colour reinforces the count and is never the sole encoding. Do not "correct" either ramp into
 * a light→dark sequence, and do not drop the number.
 */

import { useState } from "react";

export type RankedSlot = {
  key: string;
  /** The FULL field name. Callers that have a code show it separately; this is never a code. */
  name: string;
  when: string;    // "Mon 7PM"
  booked: number;
  city: string;
  n: number;       // weeks of `outOf` in which this slot cancelled
};

export type RankTone = { bg: string; fg: string; border?: string };

/* SORTED MOST-CHRONIC FIRST, then by spots booked descending. The tiebreak is not cosmetic: a slot
 * that dies with 30 people on it is a bigger problem than one that dies empty, and at equal
 * chronicity that is the only thing separating them. */
export function rankSlots(slots: readonly RankedSlot[]): RankedSlot[] {
  return slots.slice().sort((a, b) => b.n - a.n || b.booked - a.booked || a.name.localeCompare(b.name));
}

export default function CancelRanking({
  slots, outOf, ramp, collapseOnes = false, wrapName = false, emptyText,
}: {
  slots: readonly RankedSlot[];
  outOf: number;
  ramp: Record<number, RankTone>;
  /* A SLOT THAT CANCELLED ONCE IN FOUR WEEKS IS NOT A PATTERN, IT IS A TUESDAY. Behind a button
   * that says how many, so they are collapsed rather than hidden. */
  collapseOnes?: boolean;
  wrapName?: boolean;
  emptyText?: string;
}) {
  const [showOnes, setShowOnes] = useState(false);
  const ranked = rankSlots(slots);
  const ones = collapseOnes ? ranked.filter((s) => s.n === 1) : [];
  const shown = collapseOnes && !showOnes ? ranked.filter((s) => s.n > 1) : ranked;

  if (ranked.length === 0) {
    return <p className="px-0 py-3 text-[12.5px]" data-testid="rank-empty" style={{ color: "#626f68" }}>
      {emptyText ?? "No slot cancelled in this window."}
    </p>;
  }
  return (
    <div data-testid="cancel-ranking">
      {shown.map((s) => {
        const tone = ramp[s.n] ?? ramp[1];
        return (
          <div key={s.key} data-testid="rank-row" data-n={s.n} data-booked={s.booked}
            className="mb-2 flex items-center gap-2.5 rounded-[11px] border bg-white px-3 py-[11px] last:mb-0"
            style={{ borderColor: "#e6ebe8", minHeight: 44 }}>
            <span data-testid="rank-badge"
              className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[9px] text-[11.5px] font-extrabold tabular-nums"
              style={{ background: tone.bg, color: tone.fg, border: tone.border ? `1px solid ${tone.border}` : undefined }}>
              {s.n}/{outOf}
            </span>
            <div className="min-w-0 flex-1">
              {/* THE FIELD NAME IN FULL. It wraps rather than ellipsing where the caller asks:
                  a truncated field name is the same swallow this whole view exists to undo. */}
              <div data-testid="rank-name" className={wrapName ? "text-[13.5px] font-extrabold" : "truncate text-[13.5px] font-extrabold"}
                style={wrapName ? { overflowWrap: "break-word", lineHeight: 1.3 } : undefined}>
                {s.name} · {s.when}
              </div>
              <div className="mt-px text-[11.5px] font-bold" style={{ color: "#8a968f" }}>
                {s.booked} spots booked · {s.city}
              </div>
            </div>
          </div>
        );
      })}
      {collapseOnes && ones.length > 0 && (
        <button type="button" data-testid="rank-ones" onClick={() => setShowOnes((v) => !v)}
          className="mt-1 w-full rounded-[10px] border px-3 text-[12px] font-bold"
          style={{ borderColor: "#e6ebe8", color: "#0d3b2e", background: "#f9fbfa", minHeight: 44 }}>
          {showOnes ? "Hide" : "Show"} {ones.length} slot{ones.length === 1 ? "" : "s"} that cancelled once
        </button>
      )}
    </div>
  );
}
