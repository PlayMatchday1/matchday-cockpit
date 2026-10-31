// Staff app GROWTH, 2026 Daily Matches (Ryan, 2026-10-31). The screen's numbers, computed from the
// desktop's own payload (GET /api/growth/field-goals) by the desktop's own functions, so the phone
// and the page cannot disagree: baselineMonth and monthIndexIn pick the month the figures run from,
// cityRollup and cityTotals make every city and the footer, shownGap makes every gap, dailyIn and
// fmtUnit the unit, bandForDisplay the colour. Nothing here is a second copy of a rule. Read only.
//
// THE GOAL MONTH ("Compare to") is the one thing the desktop does not have as a control. Its figures
// are the desktop's: December is the typed goal; October and November are the typed target or, when
// none is typed, the desktop's ramp from the baseline to December (the same values the city table
// and the year chart draw). A ramp is TAGGED as one. A ramp that would equal the field's own actual
// (no December to ramp to, or December equal to the baseline) is not a goal: that field shows
// "no Oct goal" and is left out of the month's goal count.

import {
  MONTH_LABELS, baselineMonth, bandForDisplay, cityRollup, cityTotals, dailyIn, fmtUnit, monthIndexIn,
  monthKey, ramp, roundTo, rowCountsTowardTotals, shownGap,
  type Band, type CityRow, type CompareFrom, type GoalSort, type RollupRow,
} from "./fieldGoals";

export type GoalMonth = "oct" | "nov" | "dec";
export const GOAL_MONTHS: readonly GoalMonth[] = ["oct", "nov", "dec"];
const GOAL_INDEX: Record<GoalMonth, number> = { oct: 9, nov: 10, dec: 11 };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type PayloadRow = RollupRow & { venueId: number | null; fieldId: number | null; monthly: { daily: number; matches?: number; days?: number; partial?: boolean }[] };
export type Payload = { year: number; today: string; currentMonth: number; months: { days: number }[]; rows: PayloadRow[]; slots: PayloadRow[]; scopeCity?: string | null };

export type Opts = { unit: "day" | "week"; sort: GoalSort; goal: GoalMonth; compare: CompareFrom | null };

export type GoalKind = "typed" | "ramp" | "none";

/** One field's goal for the chosen month, as the desktop holds it, with where it came from. */
export function fieldGoal(r: PayloadRow, year: number, baseIdx: number, goal: GoalMonth): { value: number | null; kind: GoalKind } {
  const typed = r.targets[monthKey(year, GOAL_INDEX[goal])];
  if (typed != null) return { value: typed, kind: "typed" };
  if (goal === "dec") return { value: null, kind: "none" };
  const base = r.monthly[baseIdx]?.daily ?? 0;
  const dec = r.targets[monthKey(year, 11)] ?? null;
  const v = ramp(base, dec)[goal === "oct" ? 0 : 1];
  if (v == null || roundTo(v, 1) === roundTo(base, 1)) return { value: null, kind: "none" };
  return { value: v, kind: "ramp" };
}

/** The city's goal for the month: the desktop's own city figure (cityRollup's oct, nov, dec). */
const cityGoal = (c: Pick<CityRow, "oct" | "nov" | "dec">, goal: GoalMonth) => c[goal];

export function growthView(p: Payload, o: Opts) {
  const year = p.year, cur = p.currentMonth;
  const bl = baselineMonth(p.today, o.compare);
  const baseIdx = monthIndexIn(bl.baseKey, year) ?? cur;
  const baseIsLive = baseIdx === cur;
  const noBase = baseIsLive && (p.months[cur]?.days ?? 0) === 0;
  const all = [...p.rows, ...p.slots];
  const byKey = new Map(all.map((r) => [r.key, r]));
  const cities = cityRollup(all, year, cur, o.sort, baseIdx, o.unit);
  const tot = cityTotals(cities);
  const u = o.unit;
  const shown = (d: number) => fmtUnit(d, u);
  const gapOf = (goal: number | null, base: number) => (goal == null ? null : shownGap(dailyIn(goal, u), dailyIn(base, u), u));
  const bandOf = (goal: number | null, base: number): Band | null => (goal == null ? null : bandForDisplay(shownGap(goal, base, "day") as number));

  let trivialRamps = 0;
  const cityOut = cities.map((c) => {
    const fields = c.fields.map((f) => {
      const r = byKey.get(f.key)!;
      const g = fieldGoal(r, year, baseIdx, o.goal);
      if (o.goal !== "dec" && g.kind === "none" && r.targets[monthKey(year, 11)] != null) trivialRamps += 1;
      const base = f.base ?? 0;
      return {
        key: f.key, name: f.name, kind: f.kind, venueId: r.venueId, fieldId: r.fieldId,
        base: f.base, baseShown: f.base == null ? null : shown(f.base),
        goal: g.value, goalShown: g.value == null ? null : shown(g.value), goalKind: g.kind,
        gap: gapOf(g.value, base), band: bandOf(g.value, base),
        dec: f.dec, oct: f.oct, nov: f.nov,
      };
    });
    const goal = cityGoal(c, o.goal);
    return {
      city: c.city, hasCity: c.hasCity,
      base: c.base, baseShown: shown(c.base), live: c.live,
      goal, goalShown: shown(goal), gap: gapOf(goal, c.base), band: bandOf(goal, c.base),
      oct: c.oct, nov: c.nov, dec: c.dec,
      existing: c.existing, slots: c.slots,
      noGoal: fields.filter((f) => f.goal == null).length,
      // LAUNCHING: a city whose rows are only new fields (slots), no real field yet (Ryan, 2026-10-31).
      launching: c.existing === 0 && c.slots > 0,
      fields,
    };
  });

  const goal = cityGoal(tot, o.goal);
  const gap = gapOf(tot.dec, tot.base) as number;
  const counted = all.filter(rowCountsTowardTotals);
  return {
    year, today: p.today, currentMonth: cur, scopeCity: p.scopeCity ?? null,
    unit: u, sort: o.sort, goalMonth: o.goal,
    compare: { value: baseIsLive ? "to-date" : "last-full", default: bl.defaultCompareFrom, liveLabel: MONTH_LABELS[cur], lastFullLabel: MONTH_LABELS[Math.max(0, cur - 1)] },
    base: { index: baseIdx, label: MONTH_LABELS[baseIdx], name: MONTH_NAMES[baseIdx], isLive: baseIsLive, none: noBase },
    // THE HERO is the desktop's: "{Mon} so far" or "{Month}, last full month", "Dec goal", "To find",
    // pct = now / goal, and the other unit's "X → Y".
    hero: {
      label: baseIsLive ? `${MONTH_LABELS[cur]} so far` : `${MONTH_NAMES[baseIdx]}, last full month`,
      now: tot.base, nowShown: noBase ? null : shown(tot.base),
      dec: tot.dec, decShown: shown(tot.dec),
      toFind: noBase ? null : gap, toFindShown: noBase ? null : (u === "day" ? gap.toFixed(1) : gap.toFixed(0)),
      pct: tot.dec > 0 ? Math.min(100, (tot.base / tot.dec) * 100) : 0,
      alt: u === "day" ? `${fmtUnit(tot.base, "week")} → ${fmtUnit(tot.dec, "week")}` : `${tot.base.toFixed(1)} → ${tot.dec.toFixed(1)}`,
      altUnit: u === "day" ? "a week" : "a day",
      oct: tot.oct, nov: tot.nov,
      octShown: shown(tot.oct), novShown: shown(tot.nov),
      newFields: counted.filter((r) => r.kind === "slot").length,
    },
    goal: { month: o.goal, value: goal, shown: shown(goal), gap: gapOf(goal, tot.base) },
    totals: { ...tot, existing: tot.existing, slots: tot.slots },
    cities: cityOut,
    trivialRamps,
  };
}

export type GrowthView = ReturnType<typeof growthView>;
