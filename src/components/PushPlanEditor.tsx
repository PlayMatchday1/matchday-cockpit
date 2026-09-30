"use client";

// THE PUSH PLAN EDITOR — a channel is a block, a date is a row.
//
// Teresa: "Pick the channel. Pick the date or dates when we are doing the push in that channel.
// Mention if this channel will have a code or not. And for each date, leave a small field to add
// the topic of the push as it might vary between days."
//
// ══ AND THE CODE VARIES BETWEEN DAYS TOO ═════════════════════════════════════════════════════
// "Mention if this channel will have a code" was built as one code field per channel, fanned onto
// every date on save. It is per DATE now, for the same reason the topic is: one channel runs a
// Thursday push with PARMER10 and a Saturday push with nothing, and the table has always been able
// to hold that — only this editor could not say it. Blank means no code on that push.
//
// ══ A PUSH IS A BLOCK, NOT A ROW ═════════════════════════════════════════════════════════════
// Time and ✕ on one line; the code and the message full width beneath. The four-column row it
// replaced squeezed the message into whatever was left over, which at the panel's real width was a
// few characters hidden behind the ✕.
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
              {/* THE CODE FIELD IS NOT HERE ANY MORE. It was one per channel, in this header, and
                  that is the bug: a channel can carry a Thursday push with a code and a Saturday
                  push without one, and one field per channel cannot say so. Each push owns its
                  code now, in its own block below. */}
            </div>

            {ch.on && (
              <div className="px-3 pb-2.5 pt-2">
                {rows.map((r) => {
                  const lead = leadToKickoff(r.pushAt, kickoff);
                  return (
                    /* ── ONE PUSH IS A STACKED BLOCK, NOT A ROW ─────────────────────────────
                     * It was a four-column grid — [time | 8h before | message | ✕] — and at the
                     * panel's real width the message box was the column that gave, ending up a
                     * few characters wide and tucked behind the ✕. Teresa could not read what she
                     * had typed.
                     *
                     * THE FIX IS THE AXIS, NOT THE PANEL. The panel does not get wider. The three
                     * things stack: the time and the ✕ share one line because both are small and
                     * fixed, and the code and the message each get the full width beneath them.
                     * Nothing competes with the message for horizontal space any more. */
                    <div key={r.key} data-testid="push" data-key={c.key}
                      className="mt-2.5 min-w-0 rounded-xl border border-cream-line bg-cream-soft/30 p-3 first:mt-1">
                      {/* LINE 1: WHEN. flex, not grid — the ✕ is flex-none and the input takes the
                          rest, so there is no column for the message to be squeezed out of. */}
                      <div className="flex min-w-0 items-center gap-2.5">
                        <input type="datetime-local" data-testid="at" data-key={c.key}
                          value={toInputValue(r.pushAt, zone, venueOffset)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const at = fromInputValue(e.target.value, zone, venueOffset);
                            set(c.key, { rows: sortRows(rows.map((x) => (x.key === r.key ? { ...x, pushAt: at } : x))) });
                          }}
                          /* min-w-0 IS STILL LOAD-BEARING. A datetime-local input's intrinsic width
                             pushes a flex item past its box at 390px however narrow it is told to
                             be, exactly as it did in the grid. */
                          className="h-9 min-w-0 flex-1 rounded-lg border border-cream-line bg-white px-2 text-[12.5px] font-semibold" />
                        {/* TIMEZONE FREE. Two instants subtracted, so it is the one number that
                            reads identically in Madrid and in Austin. */}
                        <span data-testid="rel" data-late={lead?.late ? "1" : "0"}
                          className={`flex-none whitespace-nowrap text-[11.5px] font-bold ${lead?.late ? "text-coral" : "text-deep-green/55"}`}>
                          {lead ? lead.text : "no date"}
                        </span>
                        <button type="button" data-testid="rm" aria-label="Remove this push"
                          onClick={(e) => { e.stopPropagation(); set(c.key, { rows: rows.filter((x) => x.key !== r.key) }); }}
                          className="h-8 w-8 flex-none rounded-lg border border-cream-line bg-white text-[15px] font-bold text-deep-green/40 hover:border-coral/40 hover:bg-coral-soft/40 hover:text-coral">
                          ×
                        </button>
                      </div>

                      {/* LINE 2: THIS PUSH'S CODE. Blank is a real answer and the hint says so —
                          it is not "inherit the channel's", because there is no longer one. */}
                      <div className="mt-3 grid min-w-0 grid-cols-1 gap-1">
                        <label htmlFor={`code-${c.key}-${r.key}`} className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/55">
                          Promo code
                        </label>
                        <input id={`code-${c.key}-${r.key}`} data-testid="push-code" data-key={c.key}
                          value={r.code} autoComplete="off" placeholder="e.g. PARMER10"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => set(c.key, { rows: rows.map((x) => (x.key === r.key ? { ...x, code: e.target.value.toUpperCase() } : x)) })}
                          className="h-9 w-full min-w-0 rounded-lg border border-cream-line bg-white px-2.5 text-[12.5px] font-semibold uppercase placeholder:font-medium placeholder:normal-case placeholder:text-deep-green/25" />
                        <span className="text-[11.5px] text-deep-green/45">Optional. Leave blank for no code on this push.</span>
                      </div>

                      {/* LINE 3: WHAT PLAYERS WILL READ. A textarea, full width, tall enough to
                          show a message rather than a fragment of one, and resizable when it is
                          not. THE COLUMN IS STILL `topic` — this is the same field it always
                          wrote, given the room the thing it holds actually needs. */}
                      <div className="mt-3 grid min-w-0 grid-cols-1 gap-1">
                        <label htmlFor={`msg-${c.key}-${r.key}`} className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-deep-green/55">
                          Message
                        </label>
                        <textarea id={`msg-${c.key}-${r.key}`} data-testid="topic" data-key={c.key}
                          value={r.topic} placeholder="What players will read" rows={3}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => set(c.key, { rows: rows.map((x) => (x.key === r.key ? { ...x, topic: e.target.value } : x)) })}
                          className="min-h-[92px] w-full min-w-0 resize-y rounded-lg border border-cream-line bg-white px-2.5 py-2 text-[12.5px] leading-[1.45] placeholder:text-deep-green/25" />
                        {/* WHATSAPP AND SMS BOTH CHARGE BY LENGTH somewhere downstream, and a
                            message box with no count is how a 700-character push gets written. */}
                        <span data-testid="msg-count" className="text-right text-[11px] text-deep-green/45">
                          {r.topic.length} character{r.topic.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <button type="button" data-testid="add"
                  onClick={(e) => {
                    e.stopPropagation();
                    /* 8h BEFORE KICK-OFF, AS AN INSTANT, so it is right in every zone at once —
                       and it sorts into place by time rather than landing at the end. */
                    const row: DraftRow = { key: newDraftKey(), pushAt: defaultPushAt(kickoff), topic: "", code: "" };
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
