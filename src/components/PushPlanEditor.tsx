"use client";

// THE PUSH PLAN EDITOR — a channel is a block, a date is a row.
//
// Teresa: "Pick the channel. Pick the date or dates when we are doing the push in that channel.
// Mention if this channel will have a code or not. And for each date, leave a small field to add
// the topic of the push as it might vary between days."
//
// ══ ONE COMPONENT, BOTH SURFACES ═════════════════════════════════════════════════════════════
// The desktop panel and the phone panel embed THIS, rather than each implementing a channel block.
// The two layouts differ by a media query, not by a tree: the desktop row is a four-column grid,
// the phone row stacks, and everything else — the ordering, the defaults, the counts, what an off
// channel means — is one set of rules in one place. Two implementations of "add a push" is how the
// phone's Due list ended up with its own copy of the overdue rule.
//
// ══ TWO CLOCKS, AND THEY OBEY DIFFERENT RULES ════════════════════════════════════════════════
// The match time is a WALL CLOCK: printed once, at the pitch, never re-rendered. Every push time is
// an INSTANT: re-rendered in whoever's clock is being asked for. Ryan: "The times of the matches
// dont change just the push times."
//
// The draft holds instants. The characters in each datetime-local input are derived per render for
// the zone on screen, and read back through the matching shift. See matchPromotion's zone section —
// that pair is the thing this screen gets wrong silently if it is wrong at all.

import { useMemo } from "react";
import {
  CHANNELS, defaultPushAt, draftSummary, fromInputValue, leadToKickoff, newDraftKey,
  readerZoneLabel, toInputValue, venueOffsetMs,
  type ChannelKey, type DraftRow, type PromoMatch, type PushDraft, type ZoneMode,
} from "@/lib/matchPromotion";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Kick-off as the pitch reads it, straight off the parsed wall clock. Printed once, never again. */
export function pitchClock(m: PromoMatch): string {
  return `${DOW[m.dayIdx]} ${m.time}`;
}

export default function PushPlanEditor({
  m, draft, setDraft, zone, setZone,
}: {
  m: PromoMatch;
  draft: PushDraft;
  setDraft: (d: PushDraft) => void;
  zone: ZoneMode;
  setZone: (z: ZoneMode) => void;
}) {
  /* THE VENUE'S OWN OFFSET, DERIVED FROM THIS MATCH'S OWN PAIR. No city-to-timezone map, and
   * America/Chicago — which is hardcoded elsewhere as the BUSINESS zone — is never used as one. */
  const venueOffset = useMemo(() => venueOffsetMs(m.startDate ?? null, m.startDateUtc), [m.startDate, m.startDateUtc]);
  const readerLabel = useMemo(readerZoneLabel, []);
  const kickoff = m.startDateUtc;
  const sum = draftSummary(draft);

  /* THE ZONE IS NAMED ON SCREEN, ALWAYS. A time with no zone label is how this goes wrong
   * silently — Teresa reads 7:00 PM, Austin reads 7:00 PM, and nobody finds out for a week.
   *
   * VENUE TIME IS LABELLED BY CITY, NOT BY AN IANA NAME. There is no venue-to-timezone map in this
   * codebase and inventing one is a separate job with a separate source of truth; what IS known is
   * the offset for kick-off day and which city the pitch is in. */
  const zoneLabel = zone === "venue" && venueOffset != null
    ? `Venue time (${m.city})`
    : readerLabel;

  const set = (k: ChannelKey, patch: Partial<PushDraft[ChannelKey]>) =>
    setDraft({ ...draft, [k]: { ...draft[k], ...patch } });

  const sortRows = (rows: DraftRow[]) =>
    [...rows].sort((a, b) => {
      if (!a.pushAt && !b.pushAt) return 0;
      if (!a.pushAt) return 1;
      if (!b.pushAt) return -1;
      return Date.parse(a.pushAt) - Date.parse(b.pushAt);
    });

  return (
    <div data-testid="push-editor">
      {/* ── THE MATCH TIME, AND WHOSE CLOCK EVERYTHING ELSE IS IN ──────────────────────────── */}
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[12.5px] font-bold text-deep-green/65" data-testid="kick">
          {pitchClock(m)} <i className="not-italic text-[11px] font-semibold text-deep-green/40">at the pitch</i>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-deep-green/45">Push times in</span>
          <span className="inline-flex overflow-hidden rounded-[9px] border border-cream-line bg-[#f7faf8]" role="group" aria-label="Show push times in">
            {(["me", "venue"] as const).map((z) => (
              <button key={z} type="button" data-testid={`z-${z}`} aria-pressed={zone === z}
                onClick={(e) => { e.stopPropagation(); setZone(z); }}
                disabled={z === "venue" && venueOffset == null}
                className={`min-h-[32px] whitespace-nowrap px-2.5 text-[11.5px] font-bold disabled:opacity-40 ${
                  zone === z ? "bg-deep-green text-white" : "text-deep-green/65"}`}>
                {z === "me" ? "My time" : "Venue time"}
              </button>
            ))}
          </span>
          <span data-testid="z-label" className="text-[11.5px] font-bold text-deep-green/45">{zoneLabel}</span>
        </span>
      </div>

      {/* ── A CHANNEL IS A BLOCK ───────────────────────────────────────────────────────────── */}
      {CHANNELS.map((c) => {
        const ch = draft[c.key];
        const rows = ch.rows;
        const note = !ch.on
          ? "not used for this match"
          : rows.length === 0 || rows.every((r) => !r.pushAt)
            ? "needs a date"
            : `${rows.filter((r) => r.pushAt).length} push${rows.filter((r) => r.pushAt).length > 1 ? "es" : ""}`;
        /* AMBER IS ITS OWN STATE, distinct from a planned channel AND from an off one. It is
         * 0128's "the channels are chosen and the send time is not settled", per channel now. */
        const needsDate = ch.on && rows.filter((r) => r.pushAt).length === 0;
        return (
          <div key={c.key} data-testid="chan" data-key={c.key}
            data-on={ch.on ? "1" : "0"} data-pushes={String(rows.filter((r) => r.pushAt).length)}
            className={`mb-2.5 overflow-hidden rounded-xl border ${
              needsDate ? "border-amber-300 bg-[#fffdf6]"
                : ch.on ? "border-cream-line bg-white" : "border-cream-line bg-[#fcfdfc]"}`}>
            <div className={`flex flex-wrap items-center gap-2.5 px-3 py-2.5 ${ch.on ? "border-b border-cream-line/70" : ""}`}>
              <button type="button" data-testid="tog" role="switch" aria-checked={ch.on} aria-label={c.label}
                onClick={(e) => {
                  e.stopPropagation();
                  /* THE ROWS SURVIVE THE TOGGLE. Nothing is written until Save, so turning a
                   * channel off is undone by turning it back on. That is the confirm. */
                  set(c.key, { on: !ch.on });
                }}
                className={`relative h-[22px] w-[38px] flex-none rounded-full transition ${ch.on ? "bg-mint" : "bg-[#dfe6e2]"}`}>
                <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-all ${ch.on ? "left-[19px]" : "left-[3px]"}`} />
              </button>
              <span className="min-w-[104px] text-[13.5px] font-bold">{c.label}</span>
              <span data-testid="cnote" className={`text-[11.5px] ${needsDate ? "font-bold text-amber-700" : "text-deep-green/45"}`}>
                {note}
              </span>
              {/* ONE CODE PER CHANNEL, and an off channel has no field at all — there is nothing
                  for a code to belong to. */}
              {ch.on && (
                <span className="ml-auto flex items-center gap-1.5">
                  <label htmlFor={`code-${c.key}`} className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/45">Code</label>
                  <input id={`code-${c.key}`} data-testid="code" data-key={c.key} value={ch.code}
                    autoComplete="off" placeholder="none for this channel"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => set(c.key, { code: e.target.value })}
                    className="h-8 w-[150px] min-w-0 max-w-full rounded-lg border border-cream-line bg-white px-2 text-[12.5px] font-semibold uppercase placeholder:normal-case placeholder:font-medium placeholder:text-deep-green/25" />
                </span>
              )}
            </div>

            {ch.on && (
              <div className="px-3 pb-2.5 pt-2">
                {rows.map((r) => {
                  const lead = leadToKickoff(r.pushAt, kickoff);
                  return (
                    <div key={r.key} data-testid="push" data-key={c.key}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_36px] items-center gap-2 border-b border-cream-line/50 py-[7px] last:border-b-0 sm:grid-cols-[minmax(0,190px)_108px_minmax(0,1fr)_36px]">
                      <input type="datetime-local" data-testid="at" data-key={c.key}
                        value={toInputValue(r.pushAt, zone, venueOffset)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const at = fromInputValue(e.target.value, zone, venueOffset);
                          set(c.key, { rows: sortRows(rows.map((x) => (x.key === r.key ? { ...x, pushAt: at } : x))) });
                        }}
                        /* min-w-0 IS LOAD-BEARING. A grid item's min-width is auto, so a
                           datetime-local input's intrinsic width pushes the row past its own box
                           at 390px however narrow the column is told to be. */
                        className="h-9 w-full min-w-0 rounded-lg border border-cream-line bg-white px-2 text-[12.5px] font-semibold" />
                      {/* TIMEZONE FREE. Two instants subtracted, so it is the one number that reads
                          identically in Madrid and in Austin. */}
                      {/* AT 390px IT DROPS TO ITS OWN FULL-WIDTH LINE. In source order it would
                          land in the 36px remove column, and "7h before" does not wrap, so the row
                          overflowed its own box by exactly the difference. */}
                      <span data-testid="rel" data-late={lead?.late ? "1" : "0"}
                        className={`col-start-1 whitespace-nowrap text-[11.5px] font-bold sm:col-start-auto ${lead?.late ? "text-coral" : "text-deep-green/55"}`}>
                        {lead ? lead.text : "no date"}
                      </span>
                      <input type="text" data-testid="topic" data-key={c.key} value={r.topic}
                        placeholder="What this push is about"
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => set(c.key, { rows: rows.map((x) => (x.key === r.key ? { ...x, topic: e.target.value } : x)) })}
                        className="col-start-1 h-9 w-full min-w-0 rounded-lg border border-cream-line bg-white px-2.5 text-[12.5px] placeholder:text-deep-green/25 sm:col-start-auto" />
                      <button type="button" data-testid="rm" aria-label="Remove this push"
                        onClick={(e) => { e.stopPropagation(); set(c.key, { rows: rows.filter((x) => x.key !== r.key) }); }}
                        className="h-9 w-9 flex-none rounded-lg border border-cream-line bg-white text-[15px] font-bold text-deep-green/40 hover:border-coral/40 hover:bg-coral-soft/40 hover:text-coral">
                        ×
                      </button>
                    </div>
                  );
                })}
                <button type="button" data-testid="add"
                  onClick={(e) => {
                    e.stopPropagation();
                    /* 8h BEFORE KICK-OFF, AS AN INSTANT, so it is right in every zone at once —
                       and it sorts into place by time rather than landing at the end. */
                    const row: DraftRow = { key: newDraftKey(), pushAt: defaultPushAt(kickoff), topic: "" };
                    set(c.key, { rows: sortRows([...rows, row]) });
                  }}
                  className="mt-1.5 min-h-[32px] rounded-lg border border-dashed border-[#cfdbd4] bg-white px-3 text-[11.5px] font-bold text-deep-green/65 hover:border-mint hover:bg-mint-soft/30 hover:text-emerald-700">
                  + Add a push
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div data-testid="sum" className="text-[12px] text-deep-green/45">
        <b className="text-deep-green/70">{sum.channels}</b> channel{sum.channels === 1 ? "" : "s"}
        {" · "}<b className="text-deep-green/70">{sum.pushes}</b> push{sum.pushes === 1 ? "" : "es"}
        {sum.codes > 0 && <> · <b className="text-deep-green/70">{sum.codes}</b> with a code</>}
        {sum.undated > 0 && <> · <b className="text-amber-700">{sum.undated}</b> still needs a date</>}
      </div>
    </div>
  );
}
