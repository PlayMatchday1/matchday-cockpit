"use client";

// FINANCE › REVENUE — what came in, at three grains, over the anchor month and the prior three.
//
// ONE DERIVATION WITH COST. Every DPP figure here comes from fieldEconomics.buildFieldMonths, the
// same function /admin/finance/cost reads. The Field Cost column is that module's allocation of
// the month's canonical cost, NOT venue.cost_per_match — see the header of fieldEconomics.ts for
// why the second one cannot be used for money.
//
// FOUR MONTHS CROSS A QUARTER. The loader fetches one quarter, so the page mounts a second loader
// for the quarter owning the earlier months and merges them by month ownership. Reading those
// months out of the current quarter's 14-day pad instead would hand back a fragment wearing a
// whole month's label.
//
// THE CURRENT MONTH IS PARTIAL AND SAYS SO. Measured tiles carry the "so far" mark. Exactly one
// number on this page is an extrapolation — the pace tile — and it is named as one. Nothing else
// is grossed up to a full month.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { useFinancePeriodData } from "@/lib/useFinancePeriodData";
import { useMatchRangeData } from "@/lib/useMatchData";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import {
  comparisonSpan, matchRange, matchPanelPeriod, projectMonthEnd,
  type MatchWindowKind,
} from "@/lib/financePeriod";
import {
  buildFieldCostSlots, buildFieldMonths, buildMatchRows, byCity, byField, canonCity, hasKickedOff,
  COST_BASIS_LABEL, type FieldMonth, type MatchRow,
} from "@/lib/fieldEconomics";
import { cityMembershipRevenueFor, CITY_DISPLAY_ORDER, type Q2Month } from "@/lib/financeStats";
import { loadMembershipWindowsByUserId, type MembershipWindowsByUserId } from "@/lib/mdapiMatchesRead";
import { isCityHidden } from "@/lib/types";
import { downloadCsv, fmtMoney, fmtInt } from "@/components/growth/format";
import MatchView from "./MatchView";
import DailyRevenuePace from "./DailyRevenuePace";
import s from "./financeSection.module.css";

type Grain = "city" | "field" | "match";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (d: Date) => {
  const h = d.getHours();
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
};
const dateLabel = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function RevenueSection() {
  // THE CHART IS THE SELECTED PERIOD PLUS THE PRIOR THREE AT THE SAME GRAIN. comparisonSpan
  // collapses those four into one synthetic span so this is a SINGLE fetch, and reports how many
  // it had to drop when the span would need more quarters than can be mounted.
  const { period, now } = useFinancePeriod();
  const { periods, span, dropped } = useMemo(() => comparisonSpan(period, 4, now), [period, now]);
  const { data, loading: primaryLoading } = useFinancePeriodData(span);
  // BOTH LOADERS GATE THE RENDER — see the same note on CostSection. useMatchData carries every
  // DPP dollar on this page; rendering before it lands printed a real-looking $0 in every tile.
  // THE SPAN, NOT THE PERIOD. This page draws the selected period plus the prior three at the
  // same grain, so its window is the span's — narrower than the whole table by two orders of
  // magnitude, and wider than the period by exactly what the chart needs.
  const { fromDate, toDate } = useMemo(() => matchRange(span.start, span.end), [span]);
  const { rows: matchRegistrations, loading: matchLoading } = useMatchRangeData(fromDate, toDate);

  // Subscription windows, for the member-vs-comp split only. useMatchData fetches without them,
  // which collapses every free spot into "member".
  const [windows, setWindows] = useState<MembershipWindowsByUserId>(() => new Map());
  useEffect(() => {
    let alive = true;
    loadMembershipWindowsByUserId(supabase)
      .then((w) => { if (alive) setWindows(w); })
      .catch(() => { /* leaves the legacy split; the column note says which is in force */ });
    return () => { alive = false; };
  }, []);

  const [grain, setGrain] = useState<Grain>("city");
  const [cityFilter, setCityFilter] = useState<string>("all");

  const cities = useMemo(
    () => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)).map(canonCity),
    [],
  );

  const fieldRows = useMemo(
    () => (data ? buildFieldMonths(data, matchRegistrations, span.months) : []),
    [data, matchRegistrations, span.months],
  );

  const matchRows = useMemo(
    () => (data ? buildMatchRows(data, matchRegistrations, fieldRows, windows) : []),
    [data, matchRegistrations, fieldRows, windows],
  );

  /* ── THE MATCH PANEL'S OWN WINDOW ──────────────────────────────────────────────────────────
   * The panel does NOT inherit `span`. The header compares four periods because comparison is
   * its job; the Match panel is a browse-everything table, and inheriting the comparison window
   * made its "All time" preset mean "the last four months" — 20.6% of the record — while saying
   * the opposite. City and Field views are unaffected and stay on `span` below.
   *
   * THE FINANCE TABLES STAY ON THE YTD WINDOW IN BOTH MODES. useFinancePeriodData mounts a fixed
   * four quarter loaders (hooks cannot be conditional) and all-time is fourteen quarters, so the
   * all-time mode widens the REGISTRATIONS only. A match outside the loaded quarters keeps its
   * own revenue, spots and promos — those are summed from its own rows — and gets a NULL field
   * cost, which the band reports as coverage rather than averaging in as free. */
  const [matchWindow, setMatchWindow] = useState<MatchWindowKind>("ytd");
  const mPeriod = useMemo(() => matchPanelPeriod(matchWindow, now), [matchWindow, now]);
  const mCostPeriod = useMemo(() => matchPanelPeriod("ytd", now), [now]);
  const { data: mData, loading: mCostLoading } = useFinancePeriodData(mCostPeriod);
  /* EMPTY BOUNDS ARE THE ALL-TIME KEY. fetchJoinedMatchPlayers treats "no fromDate and no
   * toDate" as the unfiltered whole-table path (count-then-fan-out at 8), and useMatchRangeData
   * caches it under "r|||" — distinct from every windowed key, fetched once per session. */
  const mBounds = useMemo(
    () => (matchWindow === "all"
      ? { fromDate: "", toDate: "" }
      : matchRange(mPeriod.start, mPeriod.end)),
    [matchWindow, mPeriod],
  );
  const { rows: mRegs, loading: mLoading, error: mError } = useMatchRangeData(mBounds.fromDate, mBounds.toDate);
  /* THE PANEL GATES ON ITS OWN LOADERS, and the section does not gate on the panel's.
   *
   * The section-level gate (below) waits on the SPAN's loaders. It cannot also wait on these:
   * the all-time pull is a deliberate ~20s and blanking the City and Field views for it would be
   * a worse lie than the one this fixes. But rendering the band against half-merged data is not
   * an option either — captured twice in a row on the same view, Field cost read $208,704 and
   * then $219,434 as the third quarter's schedule landed. So the panel shows that it is still
   * loading rather than printing a figure that is about to change under the reader. */
  const mBusy = mLoading || (mCostLoading && !mData);
  const mCostSlots = useMemo(
    () => (mData ? buildFieldCostSlots(mData, mPeriod.months) : []),
    [mData, mPeriod.months],
  );
  const panelRows = useMemo(
    () => (mData ? buildMatchRows(mData, mRegs, mCostSlots, windows) : []),
    [mData, mRegs, mCostSlots, windows],
  );
  /* The panel owns its filters, so the section-level Export cannot know what is on screen. It
   * reports what it is showing here rather than the header exporting a different row set — which
   * is what it did before, off `shownMatches` and the deleted thirteen-select state. */
  const panelShownRef = useRef<MatchRow[]>([]);
  const onPanelShown = useCallback((rows: MatchRow[]) => { panelShownRef.current = rows; }, []);

  // Filters apply to every grain and to the chart, so what the chart shows is what the table
  // adds up to. A filtered chart that silently stayed national would be the worse lie.
  const shownFields = useMemo(
    () => fieldRows.filter(
      (r) => (cityFilter === "all" || r.city === canonCity(cityFilter)) &&
             true,
    ),
    [fieldRows, cityFilter],
  );
  // ── MATCH VIEW FILTERS (the mockup's panel) ─────────────────────────────────────────────────
  //
  // EVERY FIELD HERE BACKS A COLUMN THAT EXISTS. The mockup lists thirteen; Match View renders all
  // thirteen, so none was dropped. A filter over a column the table does not show would narrow the
  // rows for a reason the reader cannot see.
  //
  // Scoped to Match View only — City and Field views keep the chips and the Field dropdown, which
  // the mockup drops entirely and which would be a real regression to lose.
  const shownMatchesBase = useMemo(
    () => matchRows.filter(
      (r) => (cityFilter === "all" || r.city === canonCity(cityFilter)) &&
             true,
    ),
    [matchRows, cityFilter],
  );

  // Membership is a city fact, not a pitch fact, so the field filter cannot narrow it. When one
  // is applied the membership series is withheld rather than shown unnarrowed next to a narrowed
  // DPP series — two different scopes on one axis is how a chart starts lying.
  // ALWAYS SCOPED NOW. This was false only while a FIELD filter narrowed the table to one pitch,
  // and that control is gone — membership is a city figure and Field View's rows are the fields,
  // so the filter was redundant. The withheld note went with the state that could raise it.
  const membershipScoped = true;
  const membershipCities = useMemo(
    () => (cityFilter === "all" ? cities : cities.filter((c) => c === canonCity(cityFilter))),
    [cities, cityFilter],
  );

  // ONE BAR PER PERIOD, not per month — at Quarter grain a bar is a quarter, and its value is the
  // sum of that quarter's months.
  // ── GROSS, FROM fin_revenue ─────────────────────────────────────────────────────────────────
  //
  // THE HEADLINE IS MONEY COLLECTED, not play reconstructed. It used to be roster-derived — the
  // sum of DAILY PAID registrations at mapped venues (venuePartnerRevenueFor) — which answers
  // "what did play generate at our venues" and was labelled as revenue. Measured against Stripe it
  // ran 7-8% low every month, because money with no matching roster row, or at a field not mapped
  // to a venue, cannot appear in it.
  //
  // GROSS, NOT NET: fees and refunds are separate columns and are not subtracted, so this lines up
  // with Stripe's gross volume rather than its payout.
  //
  // venuePartnerRevenueFor IS UNTOUCHED and still drives Field View, Match View, Field Ranking,
  // City P&L and Cost. It is the single derivation behind revenue and field cost, and this change
  // deliberately does not go near it — it adds a second, differently-sourced figure beside it and
  // names both.
  const [grossRows, setGrossRows] = useState<{ date: string; city: string; type: string; gross: number }[] | null>(null);
  useEffect(() => {
    const keys = periods.map((p) => p.key);
    if (keys.length === 0) return;
    let live = true;
    const lo = `${periods[0].start.getFullYear()}-${String(periods[0].start.getMonth() + 1).padStart(2, "0")}-01`;
    const last = periods[periods.length - 1];
    const hiD = new Date(last.end.getFullYear(), last.end.getMonth() + 1, 0);
    const hi = `${hiD.getFullYear()}-${String(hiD.getMonth() + 1).padStart(2, "0")}-${String(hiD.getDate()).padStart(2, "0")}`;
    void (async () => {
      // PAGED — PostgREST caps at 1,000 and four months is ~2,000 rows. An unpaged read here would
      // silently under-report the headline, which is the exact class of bug this change fixes.
      const acc: { date: string; city: string; type: string; gross: number }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("fin_revenue").select("date, city, type, gross")
          .gte("date", lo).lte("date", hi).order("date").range(from, from + 999);
        if (error || !data) break;
        acc.push(...(data as typeof acc));
        if (data.length < 1000) break;
      }
      if (live) setGrossRows(acc);
    })();
    return () => { live = false; };
  }, [periods]);

  const monthOfDate = (d: string) => {
    const [y, m] = String(d).split("-");
    return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m) - 1]} ${y}`;
  };

  type SeriesPoint = { month: string; key: string; dpp: number; membership: number };
  const series = useMemo<SeriesPoint[]>(() => {
    if (!data) return [];
    return periods.map((p) => {
      const ms = new Set(p.months);
      const dpp = shownFields.filter((r) => ms.has(r.month)).reduce((a, r) => a + r.revenue, 0);
      let membership = 0;
      if (membershipScoped) {
        for (const c of membershipCities) for (const m of p.months) membership += cityMembershipRevenueFor(data, c, m);
      }
      return { month: p.label, key: p.key, dpp, membership };
    });
  }, [data, periods, shownFields, membershipScoped, membershipCities]);

  // DPP + MEMBERSHIP, ALWAYS. This used to switch on a page-level VIEW control that no figure on
  // the page actually read: the cards take anchorGross and only fall back to this when gross is
  // missing, and the breakdown tables never used it at all. It survives as that fallback and as
  // the Top-revenue-city ranking, both of which want the two summed.
  const valueOf = (p: { dpp: number; membership: number }) => p.dpp + p.membership;

  // ── AVERAGE DAILY REVENUE, DIVIDED BY THE RIGHT NUMBER ──────────────────────────────────────
  //
  // The mockup hardcodes /31 for every month. That is wrong for April, June, September, November
  // (30) and badly wrong for February (28/29) — $66,267 for April reads $2,138 instead of $2,209.
  // The mockup is the spec for layout, not for arithmetic it gets wrong.
  //
  // A CLOSED month divides by its own length. The CURRENT month divides by days ELAPSED — dividing
  // a partial month by its full length understates the daily rate every single day of that month.
  // Which was used is stated on screen rather than left for the reader to infer.
  //
  // daysInMonthOf() is Date's own month-end arithmetic (day 0 of the next month), so February and
  // leap years fall out of it rather than out of a table someone has to maintain.
  // ACCEPTS BOTH NAMINGS. The series labels months in FULL ("June 2026") while the period keys use
  // the three-letter form ("Jun 2026"). A three-letter-only lookup returned -1 for June, July and
  // every other long name, the divisor fell through to 1, and the row printed the month's entire
  // revenue as its daily average — $68,997/day. Caught by dividing the rendered figures back out.
  const MONTH_NAMES = ["January","February","March","April","May","June",
    "July","August","September","October","November","December"];
  const daysInMonthOf = (label: string) => {
    const [mLab, yStr] = String(label ?? "").trim().split(/\s+/);
    const yr = Number(yStr);
    if (!mLab || !Number.isFinite(yr)) return 0;
    const mi = MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(mLab.slice(0, 3).toLowerCase()));
    if (mi < 0) return 0;
    // Day 0 of the next month is the last day of this one — February and leap years included,
    // with no table to keep in step.
    return new Date(yr, mi + 1, 0).getDate();
  };
  // For the month in progress the period model already counts elapsed days inclusive of today.
  const divisorFor = (p: { key: string; month: string }) =>
    p.key === period.key && period.isCurrent
      ? { days: Math.max(1, period.elapsedDays), basis: "elapsed" as const }
      : { days: Math.max(1, daysInMonthOf(p.month)), basis: "full" as const };

  // Gross per month, and the roster-matched figure beside it, so the gap can be stated rather
  // than quietly absorbed.
  // fin_venues.launch_date, by field. A field group can span several venue rows (split-rate legs);
  // the earliest date is the one that means "this pitch started trading".
  const launchOf = useCallback((field: string): string | null => {
    const dates = (data?.venues ?? [])
      .filter((v) => v.venue_name === field)
      .map((v) => v.launch_date)
      .filter((d): d is string => !!d)
      .sort();
    if (dates.length === 0) return null;
    const d = new Date(`${dates[0].slice(0, 10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dates[0].slice(0, 10);
    return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]} ${d.getFullYear()}`;
  }, [data]);

  const grossFor = (p: SeriesPoint) => {
    if (!grossRows) return null;
    const ms = periods.find((q) => q.key === p.key)?.months ?? [p.month];
    const set = new Set(ms);
    return grossRows.filter((r) => set.has(monthOfDate(r.date)))
      .reduce((a, r) => a + Number(r.gross ?? 0), 0);
  };

  // THE GAP, AS DATA. Identical arithmetic to the month sentences this replaced — gross collected
  // minus what the roster walk matched to a venue — now shaped for the popover on the column the
  // caveat is actually about.
  const gapRows = useMemo(() => series.flatMap((p) => {
    const g = grossFor(p);
    const matched = valueOf(p);
    if (g == null || g <= 0) return [];
    const gap = g - matched;
    if (gap <= 0.5) return [];
    return [{ key: p.key, month: p.month, gap, pct: (gap / g) * 100 }];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [series]);

  const grossByType = (p: SeriesPoint, want: "dpp" | "member") => {
    if (!grossRows) return null;
    const ms = periods.find((q) => q.key === p.key)?.months ?? [p.month];
    const set = new Set(ms);
    return grossRows.filter((r) => set.has(monthOfDate(r.date))
      && (want === "member" ? /member/i.test(r.type ?? "") : !/member/i.test(r.type ?? "")))
      .reduce((a, r) => a + Number(r.gross ?? 0), 0);
  };

  const SUMMARY_ROWS = [
    { key: "total", label: "Total revenue",
      render: (p: SeriesPoint) => { const g = grossFor(p); return g == null ? "…" : fmtMoney(g); } },
    { key: "dpp", label: "DPP",
      render: (p: SeriesPoint) => { const g = grossByType(p, "dpp"); return g == null ? "…" : fmtMoney(g); } },
    { key: "membership", label: "Membership",
      render: (p: SeriesPoint) => { const g = grossByType(p, "member"); return g == null ? "…" : fmtMoney(g); } },
    { key: "avgdaily", label: "Average daily revenue",
      render: (p: SeriesPoint) => {
        const { days, basis } = divisorFor(p);
        const g = grossFor(p);
        if (g == null) return "…";
        return (
          <>
            {fmtMoney(g / days)}
            <i className={s.soFar} data-testid="avg-daily-basis">
              {basis === "elapsed" ? `÷ ${days} elapsed` : `÷ ${days} days`}
            </i>
          </>
        );
      } },
  ];

  // The count beside the Breakdown segments, in the units of the breakdown being shown.
  /* ONE COUNT, AND IT IS THE TOGGLE'S. It changes with the view and with the filters, and when a
   * filter is on it says what it is narrowed FROM — "412 of 1365 matches" — because a bare
   * filtered figure and a bare unfiltered one are indistinguishable on screen. */
  const breakdownCount = useMemo(() => {
    const noun = (n: number) =>
      grain === "city" ? (n === 1 ? "city" : "cities")
        : grain === "field" ? (n === 1 ? "field" : "fields")
        : (n === 1 ? "match" : "matches");
    if (grain === "match") {
      /* THE HEADER COUNTS WHAT MATCH VIEW HAS TO WORK WITH; MATCH VIEW COUNTS WHAT IT IS SHOWING.
       * They answer different questions and both are on screen, so neither is a second copy of
       * the other — this one sizes the dataset, the context line under the band states the
       * selection and names the window.
       *
       * panelRows, NOT matchRows: the panel has had its own window since it stopped inheriting
       * the comparison span, and sizing it off the span's rows would print a number from a
       * different dataset than the one below it.
       *
       * COMPLETED ONLY, through the SAME predicate the panel uses. A count on this page must not
       * include matches that have not kicked off — which is the rule the band, the table and this
       * line now share rather than each deciding for itself. */
      const done = panelRows.filter((r) => hasKickedOff(r, now.getTime())).length;
      return `${done} ${noun(done)}`;
    }
    const n = (grain === "city" ? byCity(shownFields) : byField(shownFields)).size;
    if (grain === "field" && cityFilter !== "all") {
      const all = byField(fieldRows).size;
      return `${n} of ${all} ${noun(all)}`;
    }
    return `${n} ${noun(n)}`;
  }, [grain, shownFields, panelRows, cityFilter, fieldRows, now]);

  const anchorPoint = series.find((p) => p.key === period.key) ?? { month: period.label, key: period.key, dpp: 0, membership: 0 };
  // THE KPI CARDS READ GROSS TOO — they sat on the same roster-derived figure as the headline.
  const anchorGross = grossFor(anchorPoint as SeriesPoint);
  const anchorValue = anchorGross ?? valueOf(anchorPoint);
  // What the roster walk matched to a venue, for the gap line below the table.
  const anchorMatched = valueOf(anchorPoint);

  // ELAPSED AND TOTAL COME FROM THE PERIOD, at whatever grain it is — 17 of 31 for August, 48 of
  // 92 for Q3. Computing them here from the day of the month would have been right only at Month
  // grain and quietly wrong at the other two.
  const daysInMonth = period.totalDays;
  const daysElapsed = period.elapsedDays;
  const avgDaily = anchorValue / Math.max(1, daysElapsed);
  const pace = avgDaily * daysInMonth;

  /* ── PACE TO MONTH END ─────────────────────────────────────────────────────────────────────
   * Days 1-N are excluded from the RATE because membership bills at the start of the month, so
   * they are not a normal day. They are NOT excluded from revenue-so-far: that is money that
   * happened, and it goes in at face value. Only the days that have not happened yet are
   * projected.
   *
   *     rate       = (so far − days 1..N) ÷ (elapsed − N)
   *     projection = so far + remaining × rate
   *
   * MONTH GRAIN ONLY. At quarter or year the "first three days" are the first three days of one
   * month inside a much longer window and excluding them means nothing, so those keep the plain
   * mean × total days.
   *
   * ONE DAY, NOT THREE, AND THE MEASUREMENT IS WHY. Across May-Aug 2026 day 1 runs 5.8×-7.8× the
   * median day, every month; day 2 is 1.0×-1.5×, day 3 is 0.9×-1.2×, day 4 is 0.6×-1.4×. Days 2
   * and 3 are ordinary days, so excluding them threw away real data. See projectMonthEnd.
   */
  const RATE_EXCLUDED_DAYS = 1;

  const paceModel = useMemo(() => {
    // MONTH GRAIN, CURRENT OR CLOSED. It used to be current-only because only the pace card read
    // it; AVG DAILY REVENUE now reads the same object, and a closed month still has a day 1 to
    // leave out. isCurrentMonth is what decides whether there is a "today" at all.
    if (period.grain !== "month") return null;
    const anchorMonth = period.months[period.months.length - 1] ?? "";
    // Revenue on the excluded days, from the same gross rows every other figure on this card uses.
    const dayOf = (d: string) => Number(d.slice(8, 10));
    const inMonth = (grossRows ?? []).filter((r) => monthOfDate(r.date) === anchorMonth);
    const excluded = inMonth
      .filter((r) => dayOf(r.date) <= RATE_EXCLUDED_DAYS)
      .reduce((a, r) => a + Number(r.gross ?? 0), 0);
    // TODAY, whose revenue is still arriving. daysElapsed on a current month IS the day of the
    // month, so this is the row set for the day in progress.
    const currentDayRevenue = inMonth
      .filter((r) => dayOf(r.date) === daysElapsed)
      .reduce((a, r) => a + Number(r.gross ?? 0), 0);
    const r = projectMonthEnd({
      soFar: anchorValue, excludedRevenue: excluded, currentDayRevenue,
      daysElapsed, daysInMonth, excludedDays: RATE_EXCLUDED_DAYS,
      isCurrentMonth: period.isCurrent,
    });
    return r.ok ? { ...r, excluded, currentDayRevenue } : r;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, grossRows, anchorValue, daysElapsed, daysInMonth]);

  const topCity = useMemo(() => {
    if (!data) return null;
    let best: { city: string; value: number } | null = null;
    for (const c of cities) {
      if (cityFilter !== "all" && c !== canonCity(cityFilter)) continue;
      const ms = new Set(period.months);
      const dpp = shownFields.filter((r) => ms.has(r.month) && r.city === c).reduce((a, r) => a + r.revenue, 0);
      let membership = 0;
      if (membershipScoped) for (const m of period.months) membership += cityMembershipRevenueFor(data, c, m);
      const value = valueOf({ dpp, membership });
      if (value <= 0) continue;
      if (!best || value > best.value) best = { city: c, value };
    }
    return best;
  }, [data, cities, cityFilter, shownFields, period, membershipScoped]);


  /* THE PACE CARD IS NOT GATED ON THIS SECTION'S DATA, because it does not read any of it. It goes
   * straight to fin_revenue and holds its own module-level cache.
   *
   * MEASURED: a switch to Quarter blanks this section for about 20 SECONDS while useMatchRangeData
   * pages mdapi_match_players ~160 times, and the early return took the pace chart down with it —
   * so the card the operator was looking at vanished for twenty seconds and came back. It now
   * renders in about a second, above the message, while the rest of the section loads behind it.
   * Nothing else here can render early: every tile below reads `data`. */
  /* THE PLACEHOLDER TILES ROW IS LOad-BEARING, not decoration. React reconciles these children by
   * POSITION, so the pace card has to sit at the same index in the loading tree as in the loaded one
   * or it is unmounted and remounted the moment `data` arrives — which wipes a pinned readout out
   * from under whoever was reading it. Caught by verify-pace-readout, not by inspection. */
  if (matchLoading || (primaryLoading && !data)) {
    return (
      <div className={s.wrap} data-testid="finance-revenue-loading">
        <div className={s.tiles} />
        <DailyRevenuePace />
        <div className={s.empty}>Loading…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={s.wrap} data-testid="finance-revenue-nodata">
        <div className={s.tiles} />
        <DailyRevenuePace />
        <div className={s.empty}>No finance data for this period.</div>
      </div>
    );
  }


  /* SWITCHING VIEW KEEPS WHAT THE NEXT VIEW CAN STILL USE.
   *   Field → Match  the city carries over onto the grid's own City select, which means the
   *                  same thing; losing it would silently widen the table you were reading.
   *   Match → Field  and back again, symmetrically.
   *   → City         everything drops. City View has no filter, so a selection kept here would
   *                  be invisible state that reappears the moment you leave. Coming back to
   *                  Field therefore starts at All. */
  const changeGrain = (next: Grain) => {
    if (next === grain) return;
    if (next === "city") { setCityFilter("all"); }
    else if (next === "match") {
      /* THE CITY STAYS PUT AND MATCH VIEW READS IT. It used to be moved into the thirteen-select
       * grid's own City while cityFilter was cleared; that grid is gone, and Match View takes the
       * city as its initial selection instead — so the choice arrives visible and clearable rather
       * than applied to the rows somewhere the reader cannot see. */
    } else if (next === "field") {
      // Coming back from Match View, the city it was showing is whatever cityFilter still holds.
    }
    setGrain(next);
  };

  const max = Math.max(1, ...series.map((p) => valueOf(p)));


  function exportTable() {
    if (grain === "match") {
      downloadCsv(`matchday-revenue-matches-${mPeriod.key}.csv`, [
        ["Date", "Month", "Week", "Weekday", "City", "Location", "Hour", "Match", "Members Code", "Free Code", "DPP's", "Total Spots", "DPP Revenue", "Field Cost"],
        ...panelShownRef.current.map((r) => [
          dateLabel(r.start), r.month, r.week, WEEKDAY[r.start.getDay()], r.city, r.location,
          hourLabel(r.start), 1, r.memberSpots, r.freeSpots, r.dppSpots, r.totalSpots,
          r.dppRevenue.toFixed(2), r.fieldCost == null ? "" : r.fieldCost.toFixed(2),
        ]),
      ]);
      return;
    }
    const grouped = grain === "city" ? byCity(shownFields) : byField(shownFields);
    downloadCsv(`matchday-revenue-${grain}-${period.key}.csv`, [
      ["Month", grain === "city" ? "City" : "Location", "Billing", "Matches", "DPP Revenue", "Private Rental", "Field Cost"],
      ...[...grouped.values()].flatMap((rows) =>
        rows.map((r) => [
          r.month, grain === "city" ? r.city : r.field, COST_BASIS_LABEL[r.basis], r.matches,
          (r.revenue - r.privateRental).toFixed(2), r.privateRental.toFixed(2),
          r.cost == null ? "" : r.cost.toFixed(2),
        ]),
      ),
    ]);
  }

  return (
    <div className={s.wrap} data-testid="finance-revenue">
      <div className={s.tiles}>
        <Tile
          testid="tile-revenue"
          label={`${period.label} revenue`}
          value={fmtMoney(anchorValue)}
          // THE ONLY CARD THAT KEEPS THE "so far" CHIP. It is the one figure on the row that is a
          // running total of a period still in progress; the other three are rates, a name and an
          // extrapolation, and the chip said something different — or nothing — on each.
          partial={period.isCurrent}
        />
        <Tile
          testid="tile-avgdaily"
          label="Avg daily revenue"
          // THE PACE RATE, NOT THE PLAIN MEAN. Two daily rates on adjacent cards is how the wrong
          // one gets quoted; this reads paceModel.rate, the same field the pace card projects from.
          value={paceModel?.ok ? fmtMoney(paceModel.rate) : fmtMoney(avgDaily)}
          // BOTH CARDS CARRY THE SAME ATTRIBUTE FROM THE SAME OBJECT, so a test can prove shared
          // provenance rather than watching two independent numbers happen to agree.
          rate={paceModel?.ok ? paceModel.rate : null}
        />
        <Tile
          label="Top revenue city"
          value={topCity ? topCity.city : "—"}
          // THE FIGURE STAYS, ON THE VALUE LINE. It is the city's revenue, so it belongs beside
          // the city rather than under it.
          amount={topCity ? fmtMoney(topCity.value) : null}
        />
        <Tile
          label="Pace to month end"
          testid="tile-pace"
          // CLOSED MONTHS KEY OFF THE PERIOD, NOT OFF paceModel. paceModel now exists for closed
          // months too (AVG DAILY reads its rate), so testing it for null here would have started
          // printing "PROJECTED — … + 0 days ×" over a month that has already ended.
          value={
            !period.isCurrent ? fmtMoney(anchorValue)
              : paceModel ? (paceModel.ok ? fmtMoney(paceModel.projection) : "—")
              : fmtMoney(pace)
          }
          rate={paceModel?.ok ? paceModel.rate : null}
          // ANCHORED TO THE CARD, NOT THE BUTTON. Hung off the ⓘ it opens directly over the figure
          // it exists to explain.
          info={paceModel?.ok && period.isCurrent
            ? (cardRef) => (
                <InfoPopover
                  testid="pace-info"
                  panelTestid="pace-info-panel"
                  ariaLabel="How pace to month end is calculated"
                  title="How this is calculated"
                  width={300}
                  anchorRef={cardRef}
                >
                  <tbody>
                    <tr data-testid="pace-info-row" data-row="collected">
                      <td className="l">Collected, days 1–{daysElapsed}</td>
                      <td data-testid="pace-info-collected">{fmtMoney(anchorValue)}</td>
                      {/* NO "excluded" HERE. Day 1's money is inside this total; marking the row
                          would read as $17k lost rather than $17k left out of one divisor. */}
                      <td />
                    </tr>
                    <tr data-testid="pace-info-row" data-row="day1">
                      <td className="l">Day 1</td>
                      <td data-testid="pace-info-day1">{fmtMoney(paceModel.excluded)}</td>
                      <td className={s.infoNote}>excluded</td>
                    </tr>
                    {paceModel.todayExcluded && (
                      <tr data-testid="pace-info-row" data-row="today">
                        <td className="l">{(period.months[period.months.length - 1] ?? "").split(" ")[0]} {daysElapsed} · today</td>
                        <td data-testid="pace-info-today">{fmtMoney(paceModel.currentDayRevenue)}</td>
                        <td className={s.infoNote}>excluded</td>
                      </tr>
                    )}
                    <tr className={s.infoRule}><td colSpan={3} /></tr>
                    <tr data-testid="pace-info-row" data-row="rate">
                      <td className="l">Daily rate</td>
                      <td data-testid="pace-info-rate">{fmtMoney(paceModel.rate)}</td>
                      <td className={s.infoNote}>{paceModel.rateDays} days</td>
                    </tr>
                    <tr data-testid="pace-info-row" data-row="forward">
                      <td className="l">{paceModel.remaining} {paceModel.remaining === 1 ? "day" : "days"} remaining</td>
                      {/* THE PANEL TIES TO THE HEADLINE, and that decides which of two identities
                          survives rounding. Printing the exact forward would leave
                          collected + forward one dollar off projected whenever the two fractions
                          cross a dollar; deriving it as projected − collected makes that identity
                          hold by construction and moves the drift onto "forward = remaining ×
                          rate", where it is bounded by one dollar per remaining day — the rate
                          itself is only printed to the dollar. */}
                      <td data-testid="pace-info-forward">{fmtMoney(Math.round(paceModel.projection) - Math.round(anchorValue))}</td>
                      <td />
                    </tr>
                    <tr data-testid="pace-info-row" data-row="projected">
                      <td className="l">Projected</td>
                      <td data-testid="pace-info-projected">{fmtMoney(paceModel.projection)}</td>
                      <td />
                    </tr>
                  </tbody>
                </InfoPopover>
              )
            : undefined}
        />
      </div>

      {/* DAILY PACE, above the period bars. The bars answer "how did the month end"; this answers
          "are we ahead of last month, today" — which is the question that can still be acted on.
          The existing bar chart below is untouched. */}
      <DailyRevenuePace />

      <div className={s.card}>
        <div className={s.cardHead}>
          <div>
            <span className={s.cardTitle}>Matchday revenue</span>
            <div className={s.cardSub} data-testid="revenue-summary-sub">
              Current month and prior three months · oldest to newest
            </div>
          </div>
          {/* NO EXPORT HERE. The one Export on the page sits on the card whose table it
              exports, which is the breakdown card — not this four-month summary. */}
        </div>

        {/* THE FOUR-COLUMN SUMMARY replaces the stacked bar chart, which is not in the mockup and
            is gone rather than hidden behind a toggle. Four months across, oldest left; four
            concept rows down. The bars showed the same two numbers with less precision and no
            room for the third and fourth rows. */}
        <div className={s.tblWrap}>
          <table className={s.tbl} data-testid="revenue-summary">
            <thead>
              <tr>
                <th className="l">&nbsp;</th>
                {series.map((p) => (
                  <th key={p.key} data-testid="revenue-summary-month">
                    {p.month}
                    {p.key === period.key && period.isCurrent && <i className={s.soFar}>so far</i>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.map((row) => (
                <tr key={row.key} data-testid="revenue-summary-row" data-row={row.key}>
                  <td className="l">{row.label}</td>
                  {series.map((p) => (
                    <td key={p.key} data-testid={`sum-${row.key}`} data-month={p.key}>
                      {row.render(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={s.legend}>
          {/* A table that quietly drew fewer months than asked would read as "this is all there
              was". It says so instead. */}
          {dropped > 0 && (
            <span data-testid="revenue-span-dropped">
              {dropped} earlier {dropped === 1 ? "period" : "periods"} not drawn — the span would
              need more quarters than can be loaded at once.
            </span>
          )}
          {periods.length < 4 && dropped === 0 && (
            <span data-testid="revenue-span-short">
              {periods.length} of 4 {periods.length === 1 ? "period" : "periods"} — the record does not go back further.
            </span>
          )}
        </div>
      </div>

      {/* ── ONE CARD: TOGGLE, COUNT, FILTERS, TABLE ────────────────────────────────────────
          Three bordered boxes doing one job became one. The toggle carries its own count and its
          own Export; the filter row exists only on the views where a filter can change the
          answer; the table sits under the same border rather than in a card of its own. */}
      <div className={s.card} data-testid="breakdown-card">
        <div className={s.brkHead}>
          {/* "City View" inside a control labelled BREAKDOWN said view twice. */}
          <div className={s.seg} role="group" aria-label="Breakdown">
            {(["city", "field", "match"] as const).map((g) => (
              <button key={g} type="button" data-testid={`breakdown-${g}`}
                aria-pressed={grain === g}
                className={grain === g ? s.on : ""} onClick={() => changeGrain(g)}>
                {g === "city" ? "City" : g === "field" ? "Field" : "Match"}
              </button>
            ))}
          </div>
          {/* THE COUNT BELONGS TO THE TOGGLE — one place, and it moves with the view AND the
              filters. Match View printed it twice, here and inside the select grid. */}
          <span className={s.brkCount} data-testid="breakdown-count">{breakdownCount}</span>
          {/* THE MONTH QUALIFIER, ONCE. It used to sit on four column headers, which is one fact
              repeated four times. Field view names the exception by name: LAUNCHED is
              fin_venues.launch_date and does not move with the period. Match view is not covered
              because its rows are matches, each carrying its own date. */}
          {grain !== "match" && (
            <span className={s.brkCount} data-testid="breakdown-scope">
              · Figures are for the selected month{grain === "field" ? ", except Launched" : ""}
            </span>
          )}
          <span className={s.brkGrow} />
          <button type="button" className={s.btn} data-testid="breakdown-export"
            onClick={exportTable}>Export</button>
        </div>

        {/* CITY VIEW RENDERS NO FILTER ROW AT ALL. The rows ARE the cities, so a city chip either
            does nothing or hides six of the seven rows the table was opened to compare. */}
        {grain === "field" && (
          <div className={s.brkFilters} data-testid="breakdown-filters">
            <span className={s.ctrlLab}>City</span>
            <div className={s.seg}>
              <button type="button" data-testid="city-chip" data-city="all"
                className={cityFilter === "all" ? s.on : ""}
                onClick={() => setCityFilter("all")}>All</button>
              {cities.map((c) => (
                <button key={c} type="button" data-testid="city-chip" data-city={c}
                  className={cityFilter === c ? s.on : ""}
                  onClick={() => setCityFilter(c)}>{c}</button>
              ))}
            </div>
            {/* Clear appears only when a filter is on, and hides itself again when cleared. */}
            {cityFilter !== "all" && (
              <button type="button" className={s.brkClear} data-testid="breakdown-clear"
                onClick={() => setCityFilter("all")}>Clear</button>
            )}
          </div>
        )}

        {/* MATCH VIEW IS ITS OWN COMPONENT NOW. The thirteen-select grid is gone: it made the
            operator the query engine — narrow 1,367 rows by hand, then read them to find out what
            the set earned. MatchView narrows with six selects, a date RANGE and a lens, and answers
            with a stats band. MATCH and the four spot/revenue selects are deleted rather than
            moved: MATCH duplicated Kick-off, and the others are the lens and table columns. */}
        {grain === "match" ? (
          <MatchView
            rows={panelRows}
            initialCity={cityFilter === "all" ? undefined : canonCity(cityFilter)}
            windowKind={matchWindow}
            windowLabel={mPeriod.label}
            loading={mBusy}
            error={mError}
            onLoadAllHistory={() => setMatchWindow("all")}
            onShown={onPanelShown}
          />
        ) : (
          <GroupTable rows={shownFields} matchRows={shownMatchesBase} grain={grain}
            month={period.months[period.months.length - 1] ?? ""}
            gapRows={gapRows} launchOf={launchOf}
            membershipOf={(c) => (data ? cityMembershipRevenueFor(data, c, period.months[period.months.length - 1] ?? "") : 0)}
            membershipScoped={membershipScoped} />
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, amount, partial, testid, rate, info }: {
  // EVERY CARD IS LABEL + VALUE, and nothing else. The subtitle slot is gone rather than optional:
  // one card carrying a third line forced the other three to pad out to match it, which is the
  // void this removes. A card-specific figure rides on the VALUE line instead.
  label: string; value: string; amount?: string | null; partial?: boolean; testid?: string;
  // THE RATE THE CARD WAS BUILT FROM, verbatim. Two cards printing it prove they share a
  // derivation; two cards printing the same rounded money only prove they agree this month.
  rate?: number | null;
  // The popover is handed the CARD's ref, not the button's, so it can anchor to the card edge
  // without the Tile having to know what a popover is.
  info?: (cardRef: React.RefObject<HTMLDivElement | null>) => React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className={s.tile} data-testid={testid} ref={cardRef}
         data-rate={rate == null ? undefined : String(rate)}>
      <span className={s.tileLab}>{label}{info?.(cardRef)}</span>
      <span className={s.tileVal} data-testid="revenue-tile-value">
        {value}
        {/* Inline, so it sits on the same baseline as the name it belongs to — it is that city's
            revenue, and underneath it made this the only three-line card on the row. */}
        {amount != null && <i className={s.tileAmt} data-testid="revenue-tile-amount">{amount}</i>}
        {partial && <i className={s.soFar} data-testid="revenue-tile-partial">so far</i>}
      </span>

    </div>
  );
}

function BillingMark({ basis, unknown }: { basis: FieldMonth["basis"]; unknown: boolean }) {
  const cls = unknown ? s.btNone : basis === "profit_share" ? s.btShare : basis === "monthly_flat" ? s.btFlat : "";
  return <span className={`${s.bt} ${cls}`} data-testid="billing-mark">{unknown ? "No cost on file" : COST_BASIS_LABEL[basis]}</span>;
}

// CITY / FIELD VIEW — ranked, for the month the period is on, to the mockup's column set.
//

/* ── THE "NOT MATCHED TO A VENUE" POPOVER ────────────────────────────────────────────────────────
 * It lives on the column the caveat is about, and nowhere else.
 *
 * PORTALLED TO document.body ON PURPOSE. The table sits in an overflow-x container — Member mix
 * is already off-screen — so a popover rendered inside it would be clipped by that scroller or
 * drift away from its trigger when the table scrolls sideways. Portalling escapes the clip;
 * position:fixed off the trigger's own rect keeps it attached, and it is recomputed on any scroll
 * (capture phase, so the TABLE's scroll counts, not just the window's) and on resize.
 *
 * IT NEVER CHANGES THE HEADER'S LAYOUT. The trigger is inline and sized in the flow whether the
 * popover is open or shut; the panel itself is out of flow entirely, so no column can be widened
 * and no header row made taller by opening it.
 */
function InfoPopover({ testid, panelTestid, ariaLabel, title, children, width = 260, anchorRef }: {
  testid: string; panelTestid: string; ariaLabel: string; title: string;
  children: React.ReactNode; width?: number;
  // ANCHOR. Absent, the panel hangs off the trigger and its LEFT edges line up — what a column
  // header wants. Given an element, it hangs off THAT element's bottom with the RIGHT edges
  // flush, which is what a card wants: off the button it would land on top of the figure it is
  // explaining.
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // WHO OWNS THE OPEN STATE. On a pointer device the mouse arrives before the click, so hover
  // opened it and the click that followed immediately toggled it shut — the control looked dead.
  // Hover-opened is provisional and closes on mouse-out; a click takes ownership and only another
  // click closes it. Touch and keyboard never fire the hover path at all.
  const hoverOwned = useRef(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef?.current ?? btnRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const W = width, MARGIN = 8;
    // FLIP LEFT rather than run off the right edge. Card-anchored starts flush right already.
    let left = anchorRef ? r.right - W : r.left;
    if (left + W + MARGIN > window.innerWidth) left = r.right - W;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - W - MARGIN));
    setPos({ top: r.bottom + 6, left });
  }, [anchorRef, width]);

  useEffect(() => {
    if (!open) return;
    // MEASURE MORE THAN ONCE. A single measurement on open reads the layout as it is at that
    // instant — which after a viewport change or a late reflow is the OLD layout, and the panel
    // then sits at a position the trigger has since left. Re-placing on the next frame and once
    // more after the browser has settled costs nothing and removes a whole class of drift.
    place();
    const raf = requestAnimationFrame(place);
    const settle = setTimeout(place, 80);
    // capture:true so a scroll inside the table's own overflow container reaches this.
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={testid}
        aria-label={ariaLabel}
        aria-expanded={open}
        className={s.infoBtn}
        // STOP PROPAGATION. These headers carry no sort handler today; if one is ever added, the
        // ⓘ must not trigger it — a control that silently re-sorts the table when you ask it a
        // question is worse than no control.
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (open && !hoverOwned.current) { setOpen(false); return; }
          hoverOwned.current = false;
          setOpen(true);
        }}
        onMouseEnter={() => { if (!open) { hoverOwned.current = true; setOpen(true); } }}
      >
        <span aria-hidden>ⓘ</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={ariaLabel}
          data-testid={panelTestid}
          className={s.infoPanel}
          style={{ top: pos.top, left: pos.left, width }}
          onMouseLeave={() => { if (hoverOwned.current) setOpen(false); }}
        >
          <div className={s.infoHead}>{title}</div>
          <table className={s.infoTbl}>{children}</table>
        </div>,
        document.body,
      )}
    </>
  );
}

/** The original caller, now a body passed to the shared popover. */
function NotMatchedInfo({ rows }: { rows: { key: string; month: string; gap: number; pct: number }[] }) {
  return (
    <InfoPopover
      testid="notmatched-info"
      panelTestid="notmatched-panel"
      ariaLabel="Revenue not matched to a venue, by month"
      title="Not matched to a venue"
    >
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} data-testid="notmatched-row" data-month={r.key}>
            <td className="l">{r.month}</td>
            <td data-testid="notmatched-amount">{fmtMoney(r.gap)}</td>
            <td data-testid="notmatched-pct">{r.pct.toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </InfoPopover>
  );
}

// SCOPED TO ONE MONTH, which the note beside the row count says once (the four "(in month)"
// headers that used to say it four times are gone). The previous table paired
// each thing with each month and ranked by DPP across the span; that answered a different question
// and had none of the derived columns.
//
// EVERY DERIVED COLUMN IS COMPUTED FROM THE TWO IT DIVIDES, so a reader can check them by hand:
// avg/venue = total ÷ venues, avg/match = total ÷ matches, mix = membership ÷ total.
//
// A ZERO DENOMINATOR RENDERS A DASH, NOT A NUMBER. These used to divide by Math.max(1, n), which
// guards against Infinity and nothing else: with 0 matches it divides by ONE and prints the
// NUMERATOR as the average. ATH Pearland — 0 matches, $6,972 of revenue — read "$6,972 avg
// revenue / match", which is worse than Infinity because it looks like an answer. "No rows" never
// catches it: there IS a row, and it has money on it.
function GroupTable({ rows, matchRows, grain, month, membershipOf, membershipScoped, gapRows, launchOf }: {
  rows: FieldMonth[]; grain: "city" | "field"; month: Q2Month;
  /* THE MATCH ROWS ARE HERE FOR ONE REASON: membership at FIELD grain.
   *
   * A pitch does not sell memberships, so there is no membership row carrying a venue and there
   * never will be. The allocation is the city's member revenue times the pitch's share of the
   * city-month's MEMBER SPOTS — and it is ALREADY COMPUTED, once, by
   * matchAllocatedMemberRevenueFor (financeStats.ts:1865), which buildMatchRows calls per match
   * (fieldEconomics.ts:422). Summing those is the same number by construction.
   *
   * WHAT THIS DELIBERATELY IS NOT: a second allocation, and above all NOT a share derived from
   * DPP. A DPP-share basis was proposed once, was wrong, and is recorded as wrong in
   * docs/matchday-api-facts.md so that it is not re-proposed. Members and DPP players do not
   * distribute the same way across pitches.
   *
   * JOINED ON fieldKey, NEVER ON A NAME. MatchRow.fieldKey IS FieldMonth.key — buildMatchRows sets
   * it from the same FieldMonth it takes location from (fieldEconomics.ts:389). Venue names are
   * not unique across cities (Houston's "The Hattrick" vs Austin's "Hattrick"), so a name join
   * here would silently attach one city's members to another's pitch. */
  matchRows: MatchRow[];
  membershipOf: (city: string) => number; membershipScoped: boolean;
  gapRows: { key: string; month: string; gap: number; pct: number }[];
  // LAUNCHED is field-only and is NEW data, not a relabelled column: fin_venues.launch_date was
  // not reaching this table. A field group can span several venue rows (split-rate legs), so the
  // launch date is the EARLIEST among them — the day the pitch started trading, not the day its
  // second rate tier was added.
  launchOf: (field: string) => string | null;
}) {
  const scoped = rows.filter((r) => r.month === month);
  if (scoped.length === 0) return <div className={s.empty}>No rows for this selection.</div>;

  const keyed = new Map<string, { label: string; city: string; venues: Set<string>; keys: Set<string>; matches: number; dpp: number }>();
  for (const r of scoped) {
    const label = grain === "city" ? r.city : r.field;
    let e = keyed.get(label);
    if (!e) { e = { label, city: r.city, venues: new Set(), keys: new Set(), matches: 0, dpp: 0 }; keyed.set(label, e); }
    e.venues.add(r.field);
    e.keys.add(r.key);   // FieldMonth.key === MatchRow.fieldKey — the join, on an id
    e.matches += r.matches;
    e.dpp += r.revenue;
  }

  // The month's allocated member revenue and member spots, per field group.
  const memberByKey = new Map<string, { rev: number; spots: number }>();
  for (const m of matchRows) {
    if (m.month !== month) continue;
    const e = memberByKey.get(m.fieldKey) ?? { rev: 0, spots: 0 };
    e.rev += m.memberRevenue;
    e.spots += m.memberSpots;
    memberByKey.set(m.fieldKey, e);
  }
  /* MEMBERSHIP IS number | null, AND THE DIFFERENCE IS THE POINT. null renders —, and means "no
   * basis to allocate on". 0 would mean "we allocated and it came to nothing", which is a claim
   * this table cannot make about a pitch no member played at. This mirrors cityPnl, where a pitch
   * with no spot data gets null and never 0.
   *
   * FIELD GRAIN: null when the pitch had NO MEMBER SPOTS this month — including when the whole
   * city has no member-spot data, in which case every allocation is 0 and printing $0 across a
   * column would read as a measurement. */
  const list = [...keyed.values()].map((e) => {
    let membership: number | null;
    if (grain === "city") {
      membership = membershipScoped ? membershipOf(e.city) : null;
    } else {
      let rev = 0, spots = 0;
      for (const k of e.keys) { const m = memberByKey.get(k); if (m) { rev += m.rev; spots += m.spots; } }
      membership = spots > 0 ? rev : null;
    }
    const total = e.dpp + (membership ?? 0);
    return { ...e, membership, total, venueCount: e.venues.size };
  }).sort((a, b) => b.total - a.total);

  const T = list.reduce((a, r) => ({
    venues: a.venues + r.venueCount, matches: a.matches + r.matches,
    total: a.total + r.total, dpp: a.dpp + r.dpp,
    // The total sums the rows that HAVE a figure. If none does, it stays null and prints — as they
    // all do; summing nulls to 0 would invent a total the rows above it never claimed.
    membership: r.membership == null ? a.membership : (a.membership ?? 0) + r.membership,
  }), { venues: 0, matches: 0, total: 0, dpp: 0, membership: null as number | null });

  /* MEMBER MIX — THE DEFINITION, WRITTEN DOWN BECAUSE DEFINITIONS DRIFT:
   *
   *     member mix = membership revenue ÷ TOTAL revenue,  total = DPP + membership
   *
   * It is a share of the whole, not a ratio to DPP, so it is bounded 0–100% and the DPP share is
   * its complement. Computed from the two cells printed on the same row, so a reader can check any
   * row by hand — the same rule the other derived columns follow. */
  const mixOf = (membership: number | null, total: number) =>
    membership == null || total <= 0 ? null : `${((membership / total) * 100).toFixed(1)}%`;
  const money = (v: number | null) => (v == null ? "—" : fmtMoney(v));

  return (
    <>
      <div className={s.tblWrap}>
        <table className={s.tbl} data-testid="revenue-group-table">
          <thead>
            {/* ONE THEAD, TWO GRAINS — the columns the two views share are written ONCE and in
                one order, so they cannot drift apart. Only the genuinely view-specific ones are
                conditional: VENUES and AVG REVENUE / VENUE are city-only, CITY and LAUNCHED are
                field-only. AVG REVENUE / MATCH sits ahead of AVG REVENUE / VENUE so the shared
                run reads identically in both. */}
            <tr>
              <th data-testid="gt-th-rank">#</th>
              <th className="l">{grain === "city" ? "City" : "Field"}</th>
              {grain === "field" && <th className="l">City</th>}
              {grain === "field" && <th className="l">Launched</th>}
              {grain === "city" && <th>Venues</th>}
              <th>Matches</th>
              {/* "(in month)" USED TO RIDE ON FOUR OF THESE. It is one fact, and four copies of it
                  read as clutter rather than as emphasis — so it is stated ONCE above the table,
                  beside the row count. It was checked column by column first: Matches, Venues and
                  every revenue column here ARE month-scoped (the table filters `rows` to `month`
                  before it counts anything), and LAUNCHED is NOT — it is fin_venues.launch_date, a
                  fixed date. That is why the note above says "except Launched" on Field view. A
                  blanket statement that is untrue of one column is worse than four repetitions. */}
              <th>Total revenue
                {gapRows.length > 0 && <NotMatchedInfo rows={gapRows} />}</th>
              <th>Avg revenue / match</th>
              {grain === "city" && <th>Avg revenue / venue</th>}
              <th>DPP revenue</th>
              <th>Membership revenue</th>
              <th>Member mix</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={r.label} data-testid="revenue-group-row" data-label={r.label}>
                <td><span className={s.rank}>{i + 1}</span></td>
                <td className="l">{r.label}</td>
                {grain === "field" && <td className="l">{r.city}</td>}
                {grain === "field" && <td className="l" data-testid="gt-launched">{launchOf(r.label) ?? "—"}</td>}
                {grain === "city" && <td data-testid="gt-venues">{fmtInt(r.venueCount)}</td>}
                <td data-testid="gt-matches">{fmtInt(r.matches)}</td>
                <td data-testid="gt-total">{fmtMoney(r.total)}</td>
                {/* guarded: revenue with zero matches must not print Infinity */}
                <td data-testid="gt-avgmatch">{r.matches > 0 ? fmtMoney(r.total / r.matches) : "—"}</td>
                {grain === "city" && <td data-testid="gt-avgvenue">{r.venueCount > 0 ? fmtMoney(r.total / r.venueCount) : "—"}</td>}
                <td data-testid="gt-dpp">{fmtMoney(r.dpp)}</td>
                <td data-testid="gt-member">{money(r.membership)}</td>
                <td data-testid="gt-mix">{mixOf(r.membership, r.total) ?? "—"}</td>
              </tr>
            ))}
            <tr className={s.tot}>
              <td />
              <td className="l">Total</td>
              {grain === "field" && <td className="l">—</td>}
              {grain === "field" && <td className="l">—</td>}
              {grain === "city" && <td>{fmtInt(T.venues)}</td>}
              <td>{fmtInt(T.matches)}</td>
              <td data-testid="gt-tot-total">{fmtMoney(T.total)}</td>
              <td data-testid="gt-tot-avgmatch">{T.matches > 0 ? fmtMoney(T.total / T.matches) : "—"}</td>
              {grain === "city" && <td>{fmtMoney(T.total / Math.max(1, T.venues))}</td>}
              <td data-testid="gt-tot-dpp">{fmtMoney(T.dpp)}</td>
              <td data-testid="gt-tot-member">{money(T.membership)}</td>
              <td data-testid="gt-tot-mix">{mixOf(T.membership, T.total) ?? "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function MatchTable({ rows }: { rows: MatchRow[] }) {
  if (rows.length === 0) return <div className={s.empty}>No matches for this selection.</div>;
  const T = rows.reduce(
    (a, r) => ({
      member: a.member + r.memberSpots, free: a.free + r.freeSpots, dpp: a.dpp + r.dppSpots,
      total: a.total + r.totalSpots, rev: a.rev + r.dppRevenue,
      cost: a.cost + (r.fieldCost ?? 0), unknown: a.unknown + (r.fieldCost == null ? 1 : 0),
    }),
    { member: 0, free: 0, dpp: 0, total: 0, rev: 0, cost: 0, unknown: 0 },
  );
  return (
    <>
      <div className={s.tblWrap}>
        <table className={`${s.tbl} ${s.wide}`} data-testid="revenue-match-table">
          <thead>
            <tr>
              <th className="l">Date</th>
              <th className="l">Month</th>
              <th>Week</th>
              <th className="l">Weekday</th>
              <th className="l">City</th>
              <th className="l">Location</th>
              <th className="l">Hour</th>
              <th>Match</th>
              <th>Members Code</th>
              <th>Free Code</th>
              <th>DPP&rsquo;s</th>
              <th>Total Spots</th>
              <th>DPP revenue</th>
              <th>Field Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.matchApiId} data-testid="revenue-match-row">
                <td className="l">{dateLabel(r.start)}</td>
                <td className="l">{r.month}</td>
                <td>{r.week}</td>
                <td className="l">{WEEKDAY[r.start.getDay()]}</td>
                <td className="l">{r.city}</td>
                <td className="l">{r.location}</td>
                <td className="l">{hourLabel(r.start)}</td>
                <td>1</td>
                <td>{fmtInt(r.memberSpots)}</td>
                <td>{fmtInt(r.freeSpots)}</td>
                <td>{fmtInt(r.dppSpots)}</td>
                <td>{fmtInt(r.totalSpots)}</td>
                <td>{fmtMoney(r.dppRevenue)}</td>
                <td className={r.fieldCost == null ? s.mut : s.neg} data-testid="revenue-match-cost">
                  {r.fieldCost == null ? "—" : fmtMoney(r.fieldCost)}
                </td>
              </tr>
            ))}
            <tr className={s.tot}>
              <td className="l">Total</td>
              <td className="l">—</td>
              <td>—</td>
              <td className="l">—</td>
              <td className="l">—</td>
              <td className="l">—</td>
              <td className="l">—</td>
              <td>{fmtInt(rows.length)}</td>
              <td>{fmtInt(T.member)}</td>
              <td>{fmtInt(T.free)}</td>
              <td>{fmtInt(T.dpp)}</td>
              <td>{fmtInt(T.total)}</td>
              <td>{fmtMoney(T.rev)}</td>
              <td className={s.neg}>{T.unknown === rows.length ? "—" : fmtMoney(T.cost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
