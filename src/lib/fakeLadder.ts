/* THE FAKE-SPOT LADDER — pure. Nothing here fetches and nothing renders.
 *
 * ── FAKES ARE DERIVED, NOT STORED ─────────────────────────────────────────────────────────────
 *     fake = capacity - rung - real        (floored at 0)
 *
 * This is exact, not an approximation: it is literally `Math.max(0, capacity - realPlayers -
 * ceiling)` at MatchPanel.tsx:464, and it reproduces production match 18360 at all five rungs.
 * The floor is the only qualification — when rung + real exceeds capacity the count clamps to 0
 * rather than going negative.
 *
 * ── SO A FAKE COUNT IS A READ-OUT, AND WRITING ONE WRITES TO NOTHING ──────────────────────────
 * A control that sets a raw fake count is overwritten the moment the ladder is next evaluated.
 * Fake controls write RUNGS. Everything in this file exists to let a control speak in fakes —
 * which is how the operator thinks — while writing rungs, which is what the API stores.
 *
 * ── WHICH RUNG IS IN FORCE ────────────────────────────────────────────────────────────────────
 * MEASURED ON STAGING 2026-09-02, six matches at six distances, ladder rungs set to distinct
 * values so the resulting fake count named the rung that had been applied:
 *
 *     30h -> 36h rung      9h -> 12h rung      2h   -> 3h rung
 *     20h -> 24h rung      5h ->  6h rung      0.5h -> 3h rung
 *
 * The in-force rung is the SMALLEST MARK AT OR ABOVE hours-to-kickoff, and it stays on 3h once
 * inside three hours. Read-back values, not computed ones.
 *
 * ── THE RECONCILER LAGS, AND BY MORE THAN THIS FILE USED TO SAY ───────────────────────────────
 * A rung write lands immediately and reads back immediately; THE DERIVED FAKE COUNT DOES NOT.
 *
 * "About 150 seconds" was recorded here from a single observation. MEASURED PROPERLY 2026-09-02 —
 * the ladder moved, the roster deliberately left alone, sampled at 10-15s resolution:
 *
 *     match 2620  ADD     0 -> 10 fakes    93s
 *     match 2620  ADD     0 -> 12 fakes   103s
 *     match 2619  REMOVE 16 ->  4 fakes   294s
 *     match 2620  REMOVE 12 ->  2 fakes   298s
 *
 * SOMETHING REAL RECONCILES THE ROSTER TO THE LADDER, IN BOTH DIRECTIONS. Adds land in about a
 * minute and a half; REMOVALS TAKE ABOUT FIVE MINUTES, consistently and about three times longer.
 * Any operator-facing "it will catch up" copy must quote the SLOW figure.
 *
 * Any verdict on a rung-only write must still be judged on the RUNG read-back — judging it on the
 * fake count would report FAILED for a write that landed perfectly and has not been applied yet.
 * A control that also writes the roster directly (see src/lib/fakeRosterPlan.ts) is judged on the
 * roster instead, because it has made the count true rather than merely scheduled it.
 */

/** The ladder's marks, in hours before kickoff, longest first. */
export const RUNG_MARKS = [36, 24, 12, 6, 3] as const;
export type RungMark = (typeof RUNG_MARKS)[number];
export const rungKey = (m: RungMark): string => `fakeSpotLeft${m}h`;
/** All five field names, in ladder order. Every one is in EDITABLE_KEYS. */
export const RUNG_KEYS: string[] = RUNG_MARKS.map(rungKey);

/** fake = capacity - rung - real, floored at 0. The one definition. */
export const fakesFor = (capacity: number, rung: number, real: number): number =>
  Math.max(0, capacity - rung - real);

/** The inverse: the rung that produces `fakes`. Clamped into [0, capacity - real]. */
export const rungFor = (capacity: number, fakes: number, real: number): number =>
  Math.max(0, Math.min(Math.max(0, capacity - real), capacity - fakes - real));

/**
 * The mark in force at `hoursToKickoff` — the smallest mark at or above it, floored at 3h.
 * A match past kickoff is still on the 3h rung; there is no sixth mark.
 */
export function markInForce(hoursToKickoff: number): RungMark {
  for (const m of RUNG_MARKS) if (hoursToKickoff > (RUNG_MARKS[RUNG_MARKS.indexOf(m) + 1] ?? 0)) return m;
  return 3;
}

/** The marks at or after the one in force — the ones that would re-inflate a change. */
export function marksFrom(mark: RungMark): RungMark[] {
  return RUNG_MARKS.slice(RUNG_MARKS.indexOf(mark));
}

export type Ladder = Record<string, number>;

/**
 * THE WRITE FOR A FAKES CHANGE, AS A DIFF.
 *
 * WRITING ONLY THE RUNG IN FORCE IS A LIE. Strip fakes at 19 hours out and the 12h, 6h and 3h
 * rungs put them straight back as the match crosses them — the operator watches the count they
 * just set climb again an hour later with no explanation. So every LATER rung is raised to at
 * least the new value; the ladder cannot then re-inflate past it.
 *
 * ONLY CHANGED FIELDS ARE RETURNED. A rung already at or above the target is left out of the diff
 * entirely, because the diff IS the request body.
 */
export function fakesWriteDiff(
  ladder: Ladder, capacity: number, real: number, hoursToKickoff: number, targetFakes: number,
): { diff: Ladder; mark: RungMark; targetRung: number; laterRaised: RungMark[] } {
  const mark = markInForce(hoursToKickoff);
  const targetRung = rungFor(capacity, targetFakes, real);
  const diff: Ladder = {};
  const laterRaised: RungMark[] = [];
  for (const m of marksFrom(mark)) {
    const k = rungKey(m);
    const cur = Number(ladder[k] ?? 0);
    /* AT OR ABOVE THE TARGET IS ALREADY SAFE — a HIGHER rung means FEWER fakes, so it cannot
     * re-inflate past the value being set. Only rungs below the target would. */
    if (cur >= targetRung) continue;
    diff[k] = targetRung;
    if (m !== mark) laterRaised.push(m);
  }
  return { diff, mark, targetRung, laterRaised };
}

/** What the control says it did, so the later-rung write is visible rather than silent. */
export function fakesWriteNote(targetFakes: number, laterRaised: RungMark[]): string {
  const base = `fakes set to ${targetFakes}`;
  if (laterRaised.length === 0) return base;
  return `${base} · later rung${laterRaised.length === 1 ? "" : "s"} raised to match`;
}


/**
 * THE ONE FAKE CONTROL'S WRITE: set the spots-shown-as-left to `targetRung`, now and through to
 * kickoff.
 *
 * SPOTS-SHOWN-AS-LEFT IS THE VALUE THAT PERSISTS. The fake count is derived from it and drifts as
 * real players join, so a stepper on the fake count reads as a save that came undone — the operator
 * sets 5 fakes, two people sign up, and it says 3. The rung does not move; only its consequence
 * does. So the control steps the rung and DISPLAYS the consequence.
 *
 * IN FORCE AND EVERY LATER BAND, never an earlier one. Earlier bands are already past and writing
 * them changes nothing; later ones would re-inflate the value the moment the match crossed them,
 * which is the whole reason this is a single save rather than five.
 */
export function spotsLeftWriteDiff(
  ladder: Ladder, hoursToKickoff: number, targetRung: number,
): { diff: Ladder; mark: RungMark; marks: RungMark[] } {
  const mark = markInForce(hoursToKickoff);
  const marks = marksFrom(mark);
  const diff: Ladder = {};
  for (const m of marks) {
    const k = rungKey(m);
    /* ONLY WHAT CHANGED — the diff IS the request body. A band already at the target is left out. */
    if (Number(ladder[k] ?? 0) === targetRung) continue;
    diff[k] = targetRung;
  }
  return { diff, mark, marks };
}

/** The value the control shows: the rung in force right now. */
export const spotsLeftNow = (ladder: Ladder, hoursToKickoff: number): number =>
  Number(ladder[rungKey(markInForce(hoursToKickoff))] ?? 0);
