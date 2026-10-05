"use client";

import { useEffect, useState } from "react";
import { TAG_META, tagRangeLabel, tagTitleWithDates, type TagDates } from "@/lib/promoTags";

/* ── STARTING 11, WITH DATES (0207, Ryan 2026-10-05) ──────────────────────────────────────────
 * Off: the pill, and pressing it opens a start date (required) and an end date (empty = still live)
 * with Turn on. On: the pill lit, its range, and the two dates editable with Save dates and Turn off.
 * An undated row (pre-0207) reads "no dates set" and shows everywhere until dates are saved. */
export default function Starting11Control({ on, dates, saving, defaultStart, onSet, onClear }: {
  on: boolean; dates: TagDates | null; saving: boolean; defaultStart: string;
  onSet: (d: TagDates) => void; onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(dates?.startsOn ?? defaultStart);
  const [end, setEnd] = useState(dates?.endsOn ?? "");
  useEffect(() => { setStart(dates?.startsOn ?? defaultStart); setEnd(dates?.endsOn ?? ""); }, [dates?.startsOn, dates?.endsOn, defaultStart]);
  const meta = TAG_META.starting_11;
  const bad = !start ? "A start date is required." : end && end < start ? "The end date is before the start." : null;
  const showForm = on || open;
  return (
    <span className="flex w-full flex-col gap-1.5" data-testid="s11">
      <span className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="tag-toggle" data-t="starting_11" data-on={on ? "1" : "0"} aria-pressed={on} disabled={saving}
          title={tagTitleWithDates("starting_11", dates)} onClick={() => (on ? undefined : setOpen((v) => !v))}
          className="min-h-[32px] rounded-[7px] border px-2.5 text-[11px] font-extrabold tracking-[0.03em]"
          style={on ? { color: "#fff", background: meta.colour, borderColor: meta.colour } : { color: meta.colour, borderColor: meta.colour, background: "transparent" }}>
          {meta.label}
        </button>
        {on && <span data-testid="s11-range" className="text-[11.5px] font-semibold text-deep-green/60">{tagRangeLabel(dates) ?? "No dates set: shows on every week"}</span>}
      </span>
      {showForm && (
        <span className="flex flex-wrap items-end gap-2" data-testid="s11-form">
          <label className="flex flex-col text-[10px] font-extrabold uppercase tracking-[0.06em] text-deep-green/45">Start
            <input type="date" data-testid="s11-start" value={start} onChange={(e) => setStart(e.target.value)}
              className="h-8 rounded-lg border border-cream-line bg-white px-2 text-[12px] font-semibold normal-case tracking-normal text-deep-green" />
          </label>
          <label className="flex flex-col text-[10px] font-extrabold uppercase tracking-[0.06em] text-deep-green/45">End (optional)
            <input type="date" data-testid="s11-end" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)}
              className="h-8 rounded-lg border border-cream-line bg-white px-2 text-[12px] font-semibold normal-case tracking-normal text-deep-green" />
          </label>
          <button type="button" data-testid="s11-save" disabled={saving || !!bad}
            onClick={() => { onSet({ startsOn: start, endsOn: end || null }); setOpen(false); }}
            className="h-8 rounded-full bg-deep-green px-3 text-[12px] font-extrabold text-white disabled:opacity-40">{on ? "Save dates" : "Turn on"}</button>
          {on && <button type="button" data-testid="s11-off" disabled={saving} onClick={onClear}
            className="h-8 px-1 text-[12px] font-bold text-coral">Turn off</button>}
          {bad && <span className="text-[11px] font-semibold text-coral">{bad}</span>}
        </span>
      )}
    </span>
  );
}

