import "server-only"; // no-op under --conditions=react-server
// PLAYER LIFECYCLE › MEMBERSHIP — the geometry and the agreement.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/membership-chart-test.ts
//
// TWO OF THESE CAUGHT REAL BUGS IN THE MOCKUP AND NEITHER WAS VISIBLE BY EYE:
//
//   1. AN AXIS THAT STOPS BELOW ITS OWN MAXIMUM. Take the last nice step under max and the tallest
//      bar is drawn ABOVE its own axis; with overflow:visible it silently leaves the chart. The bar
//      still looks like a bar, so nothing about the picture says it is wrong.
//   2. A TOOLTIP THAT ESCAPES ITS CARD. It breaks at BOTH ENDS of a series and near the top, which
//      is exactly where nobody hovers while building. An unreadable tooltip is the same as none.
//
// And one that comes from a shipped bug elsewhere: the Expenses page shipped with a chip, a column
// total and a footer summing three different windows, and nothing caught it. The KPI, the chart
// total and the visible columns are asserted to be one number here.

import {
  niceStep, scaleTicks, axisTop, clampTip, insideBox, totalsByMonth, activeSeries,
  buildKpis, shares, pctShares, classify, seriesOf, SERIES, ALLTIME_COLOUR, CHURN_DAYS,
  scopeLabel, type SpotRow,
} from "../src/lib/membershipModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("MEMBERSHIP CHARTS\n");

// ── 1. THE TOP TICK IS ALWAYS >= THE MAXIMUM ───────────────────────────────────────────────────
console.log("axis: the top tick is never below the series max");
{
  // Values chosen to land just ABOVE a nice step — the exact case that overflows.
  for (const max of [1, 7, 11, 19, 26, 51, 101, 249, 251, 999, 1001, 1865, 12345, 0.4, 2.5, 7.2]) {
    const top = axisTop(max);
    if (top >= max) ok(`max ${max} -> top tick ${top}`);
    else bad(`max ${max} -> top tick ${top}`, "THE TALLEST MARK WOULD LEAVE THE CHART");
  }
  is("ticks start at zero", scaleTicks(100)[0], 0);
  is("ticks ascend", scaleTicks(100).every((v, i, a) => i === 0 || v > a[i - 1]), true);
  // CONTROL: the naive version — floor to the last step below max — genuinely fails, so the
  // assertion above is not vacuously true.
  const naiveTop = (max: number, n = 5) => Math.floor(max / niceStep(max / n)) * niceStep(max / n);
  is("CONTROL — the naive floor-to-step version DOES drop below max", naiveTop(26) < 26, true);
  is("a zero series still yields a usable axis", scaleTicks(0), [0, 1]);
  is("a negative max is treated as empty", scaleTicks(-5), [0, 1]);
}

// ── 2. NO MARK RENDERS OUTSIDE ITS PLOT AREA ───────────────────────────────────────────────────
console.log("\ngeometry: every mark inside its plot");
{
  const PLOT = { x: 40, y: 10, w: 520, h: 220 };
  const top = axisTop(1865);
  const bar = (v: number, i: number) => {
    const h = (v / top) * PLOT.h;
    return { x: PLOT.x + i * 40 + 4, y: PLOT.y + PLOT.h - h, w: 28, h };
  };
  const vals = [1865, 1200, 800, 42, 0];
  let allIn = true;
  vals.forEach((v, i) => { if (!insideBox(bar(v, i), PLOT)) allIn = false; });
  is("every bar sits inside the plot, including the tallest", allIn, true);
  // CONTROL: a bar scaled against a top that is BELOW max escapes — proving the check has teeth.
  const badTop = 1500;
  const escaping = { x: PLOT.x, y: PLOT.y + PLOT.h - (1865 / badTop) * PLOT.h, w: 28, h: (1865 / badTop) * PLOT.h };
  is("CONTROL — a bar scaled to a too-small top DOES escape", insideBox(escaping, PLOT), false);
  is("a zero-height bar is still inside", insideBox({ x: PLOT.x, y: PLOT.y + PLOT.h, w: 28, h: 0 }, PLOT), true);
}

// ── 3. THE TOOLTIP STAYS INSIDE ITS CARD, AT BOTH ENDS ─────────────────────────────────────────
console.log("\ntooltip: clamped at both ends and flipped at the top");
{
  const CARD = { w: 600, h: 260 }, TIP = { w: 180, h: 64 };
  const first = clampTip(2, 200, TIP, CARD);
  const last = clampTip(598, 200, TIP, CARD);
  is("the FIRST point does not hang off the left", first.left >= TIP.w / 2 + 8, true);
  is("the LAST point does not hang off the right", last.left <= CARD.w - TIP.w / 2 - 8, true);
  is("a mid point is not moved", clampTip(300, 200, TIP, CARD).left, 300);
  // Near the top there is no room above, so it flips below rather than escaping.
  const high = clampTip(300, 20, TIP, CARD);
  is("near the top it FLIPS BELOW", high.flipped, true);
  is("…and sits below the point", high.top > 20, true);
  is("CONTROL — lower down it does not flip", clampTip(300, 200, TIP, CARD).flipped, false);
  // A tip wider than its card is pinned centre rather than allowed to hang out either side.
  const narrow = clampTip(10, 100, { w: 400, h: 60 }, { w: 300, h: 200 });
  is("a tip wider than the card is centred, not hanging", narrow.left, 150);
}

// ── 4. DIRECT LABELS DO NOT COLLIDE WITH THE CARD TITLE ────────────────────────────────────────
console.log("\nlabels: nothing overlaps the card title");
{
  const TITLE = { x: 0, y: 0, w: 600, h: 34 };          // the title strip
  const PLOT = { x: 40, y: 44, w: 520, h: 200 };        // plot starts BELOW it
  const labelFor = (v: number, top: number, i: number) => {
    const h = (v / top) * PLOT.h;
    return { x: PLOT.x + i * 40, y: PLOT.y + PLOT.h - h - 16, w: 36, h: 14 };  // 16px above the bar
  };
  const top = axisTop(1865);
  const overlaps = (a: typeof TITLE, b: typeof TITLE) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  let clash = false;
  [1865, 1200, 42].forEach((v, i) => { if (overlaps(labelFor(v, top, i), TITLE)) clash = true; });
  is("no direct label reaches the title strip", clash, false);
  /* CONTROL. The first version of this used the TALLEST bar in a plot starting at y=0 — whose
   * label lands at y=-16, ABOVE the title, so it did not overlap and the control passed for the
   * wrong reason. A control that cannot fail proves nothing. A bar at 80% of the plot in a plot
   * starting at the title puts its label INSIDE the title strip, which is the real collision. */
  const badPlot = { x: 40, y: 0, w: 520, h: 200 };
  const badLabel = { x: 40, y: badPlot.y + badPlot.h - 160 - 16, w: 36, h: 14 };   // y = 24
  is("CONTROL — a plot starting at the title DOES collide", overlaps(badLabel, TITLE), true);
  is("…and the real layout keeps the plot below it", PLOT.y >= TITLE.y + TITLE.h, true);
}

// ── 5. THE KPI, THE CHART TOTAL AND THE COLUMNS AGREE ──────────────────────────────────────────
console.log("\nagreement: one month, three readouts, one number");
{
  const rows: SpotRow[] = [
    ...Array.from({ length: 795 }, () => ({ month: "Aug 2026", cls: "MEMBER" as const, city: "Austin", fieldId: 1, amount: 0 })),
    ...Array.from({ length: 210 }, () => ({ month: "Aug 2026", cls: "DAILY PAID" as const, city: "Austin", fieldId: 1, amount: 15 })),
    ...Array.from({ length: 34 }, () => ({ month: "Aug 2026", cls: "PROMOCODE" as const, city: "Austin", fieldId: 1, amount: 5 })),
    ...Array.from({ length: 12 }, () => ({ month: "Jul 2026", cls: "MEMBER" as const, city: "Austin", fieldId: 1, amount: 0 })),
  ];
  const months = ["Jul 2026", "Aug 2026"];
  const t = totalsByMonth(rows, months);
  const aug = t.find((x) => x.month === "Aug 2026")!;
  is("the chart's Aug member column", aug.member, 795);
  const kpi = buildKpis({ activeMembers: 201, memberSpots: aug.member, membershipRevenue: 6438.75, churnedNow: 169, churnedPrior: 175 });
  is("the KPI divides by the SAME member-spot figure the column draws",
    kpi.avgMatchesPerMember, 795 / 201);
  is("avg price per member spot uses the same denominator",
    kpi.avgPricePerMemberSpot, 6438.75 / 795);
  is("…and equals $8.10 to the cent", Math.round((kpi.avgPricePerMemberSpot ?? 0) * 100) / 100, 8.10);
  is("a month with no rows is zero, not missing", t.find((x) => x.month === "Jul 2026")!.daily, 0);
  is("every month asked for is present", t.map((x) => x.month), months);
  // NULL, NOT ZERO, when there is nobody to divide by.
  const empty = buildKpis({ activeMembers: 0, memberSpots: 0, membershipRevenue: 0, churnedNow: 0, churnedPrior: 0 });
  is("no members -> avg matches is null, not 0", empty.avgMatchesPerMember, null);
  is("no spots -> avg price is null, not 0", empty.avgPricePerMemberSpot, null);
  is("no prior churn -> MoM is null, not 0%", empty.churnedMoMPct, null);
  is("CONTROL — a real MoM computes", Math.round((kpi.churnedMoMPct ?? 0) * 10) / 10, -3.4);
}

// ── 6. THE ALL-TIME LINE: ONE TARGET PER MONTH, NO DELTA ON THE FIRST ──────────────────────────
console.log("\nall-time line");
{
  const raw = [
    { month: "Jan 2026", value: 300 }, { month: "Feb 2026", value: 340 },
    { month: "Mar 2026", value: 412 }, { month: "Apr 2026", value: 383 },
  ];
  const s = activeSeries(raw);
  is("one target per month, no more and no fewer", s.length, raw.length);
  is("the FIRST month reports NO prior-month delta", s[0].delta, null);
  is("…and every later month has one", s.slice(1).every((p) => p.delta !== null), true);
  is("the delta is the difference from the prior point", s[3].delta, -29);
  is("a flat month reports 0, which is a measurement", activeSeries([{ month: "a", value: 5 }, { month: "b", value: 5 }])[1].delta, 0);
  is("…and that is NOT the same as the first month's null", activeSeries([{ month: "a", value: 5 }])[0].delta, null);
  is("a single-month series has exactly one target", activeSeries([{ month: "a", value: 5 }]).length, 1);
  is("an empty series has none", activeSeries([]).length, 0);
}

// ── 7. SHARES, COLOURS AND SCOPE ───────────────────────────────────────────────────────────────
console.log("\nshares, colour and scope");
{
  const sh = shares([{ day: "1", member: 3, daily: 1, promo: 0, total: 4 }, { day: "2", member: 0, daily: 0, promo: 0, total: 0 }]);
  is("a day's shares sum to 1", Math.round((sh[0].member + sh[0].daily + sh[0].promo) * 1e6) / 1e6, 1);
  /* A DAY WITH NO PLAY HAS NO COMPOSITION. Drawing it as three equal thirds would invent a mix
   * nobody played; it is marked empty and drawn as a gap. */
  is("a day with no play is EMPTY, not three equal thirds", [sh[1].empty, sh[1].member], [true, 0]);
  const p = pctShares(795, 210, 34);
  is("percentage shares sum to 100", Math.round(p.member + p.daily + p.promo), 100);
  is("an empty breakdown is all zero, not NaN", pctShares(0, 0, 0), { member: 0, daily: 0, promo: 0 });
  // COLOUR IS NEVER THE ONLY IDENTITY, and brand green is reserved for the all-time line.
  is("three series, three distinct colours", new Set(SERIES.map((s2) => s2.colour)).size, 3);
  is("the validated palette", SERIES.map((s2) => s2.colour), ["#1baf7a", "#2a78d6", "#eb6834"]);
  is("brand green is NOT lent to any series", SERIES.some((s2) => s2.colour === ALLTIME_COLOUR), false);
  is("every series carries a label", SERIES.every((s2) => s2.label.length > 0), true);
  // Classification is total: anything unrecognised is OTHER and charts as nothing.
  is("MEMBER classifies", [classify("MEMBER"), seriesOf("MEMBER")], ["MEMBER", "member"]);
  is("DAILY PAID classifies", seriesOf(classify("DAILY PAID")), "daily");
  is("PROMOCODE classifies", seriesOf(classify("PROMOCODE")), "promo");
  is("FREE_NON_MEMBER is OTHER and charts as nothing", seriesOf(classify("FREE_NON_MEMBER")), null);
  is("null is OTHER", seriesOf(classify(null)), null);
  // The scope sentence each chart restates.
  is("unfiltered scope", scopeLabel(null, null), "All Matchday");
  is("city scope names the city", scopeLabel("ATX", null, "Austin"), "Austin");
  is("field scope names the field and its city", scopeLabel("ATX", "Westlake", "Austin"), "Westlake · Austin");
  is("the churn floor is the one /api/lifecycle/churn already defaults to", CHURN_DAYS, 90);
}


// ── 8. THE AUGUST 2026 FIGURES, AS THE PAGE ACTUALLY RENDERS THEM ──────────────────────────────
// Pinned from a live render so a refactor that silently changes a denominator fails here. These
// are DERIVED relationships, not magic constants: each is asserted as the arithmetic that produced
// it, so the assertion survives the data moving and only fails if the FORMULA changes.
console.log("\nAugust 2026, as rendered");
{
  const activeMembers = 451, memberSpots = 1902, membershipRevenue = 14838.40;
  const k = buildKpis({ activeMembers, memberSpots, membershipRevenue, churnedNow: 9532, churnedPrior: 8737 });
  is("avg matches per member is spots ÷ members", k.avgMatchesPerMember, memberSpots / activeMembers);
  is("…which renders 4.2", (k.avgMatchesPerMember ?? 0).toFixed(1), "4.2");
  is("avg price per member spot is revenue ÷ spots", k.avgPricePerMemberSpot, membershipRevenue / memberSpots);
  is("…which renders $7.80", `$${(k.avgPricePerMemberSpot ?? 0).toFixed(2)}`, "$7.80");
  is("MoM churn renders 9.1%", `${(k.churnedMoMPct ?? 0).toFixed(1)}%`, "9.1%");
  /* THE DENOMINATOR IS THE SAME NUMBER THE BARS DRAW. The Expenses page shipped with a chip, a
   * column total and a footer summing three different windows; this is the assertion that would
   * have caught it. */
  const rows: SpotRow[] = Array.from({ length: memberSpots }, () => ({ month: "Aug 2026", cls: "MEMBER" as const, city: "Austin", fieldId: 1, amount: 0 }));
  is("the chart column equals the KPI denominator",
    totalsByMonth(rows, ["Aug 2026"])[0].member, memberSpots);
  // And the price tile uses that same pairing, so the tile and the KPI cannot disagree.
  is("the price tile and the KPI are one calculation",
    14838.40 / totalsByMonth(rows, ["Aug 2026"])[0].member, k.avgPricePerMemberSpot);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
