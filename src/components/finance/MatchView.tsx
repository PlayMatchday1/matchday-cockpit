"use client";

// MATCH VIEW — the stats band answers the question; the table is the evidence underneath.
//
// THE QUESTION IS "HOW ARE THURSDAYS AT WESTLAKE DOING?" Thirteen dropdowns over 1,367 rows made
// the operator the query engine: narrow the set by hand, then read a thousand rows to find out
// what it earned. Now the filters narrow, and nine tiles say what that set earns, costs and keeps.
//
// FOUR RULES THIS FILE EXISTS TO HOLD:
//
//   1. A ZERO DENOMINATOR RENDERS A DASH. Not $0, not 0.0%, and never the numerator. The old
//      table divided by Math.max(1, n), which guards Infinity and nothing else — with 0 matches it
//      divides by ONE and prints the total as the average.
//   2. AN OPTION THAT MATCHES NOTHING IS ABSENT, not disabled. Every option carries its own count,
//      so a dead end is visible before it is clicked.
//   3. THE CASCADE RUNS ONE WAY. City → Field → Kick-off. A select never constrains itself, and
//      never constrains anything ABOVE it — picking a field must not delete the other cities, or
//      you are stuck in a corner whose only exit is Clear all.
//   4. THE LENS IS NOT A FILTER. Members / DPP / Free are three ways of counting the SAME match,
//      so they change what the numbers are ABOUT. Revenue, profit and the head tile follow.
//      FIELD COST DOES NOT — a lens on revenue must never move cost. Nor do promo redemptions.

import { useEffect, useMemo, useState } from "react";
import { hasKickedOff, type MatchRow } from "@/lib/fieldEconomics";
import { fmtMoney, fmtInt } from "@/components/growth/format";
import { RECORD_STARTS } from "@/lib/financePeriod";
import s from "./financeSection.module.css";

type LensKey = "all" | "member" | "dpp" | "free";
type SelKey = "month" | "weekof" | "dow" | "city" | "field" | "hour";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* WALL CLOCK THROUGHOUT. MatchRow.start was built component-wise, so its getters are the clock on
 * the pitch. Nothing here re-parses a string into a Date. */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dowOf = (d: Date) => DAYS[(d.getDay() + 6) % 7];
const hourOf = (d: Date) => {
  const h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
};
const mondayOf = (d: Date) => {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return ymd(t);
};
const shortDate = (iso: string) => {
  const [y, m, dd] = iso.split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const weekLabel = (iso: string) => {
  const [y, m, dd] = iso.split("-").map(Number);
  const a = new Date(y, m - 1, dd);
  const b = new Date(y, m - 1, dd + 6);
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Week of ${f(a)} – ${f(b)}`;
};
const monthLabel = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

/* THE LENS. Each is a way of counting the same match — a revenue measure and a head count.
 * FREE has no revenue by definition, which is the point of counting it separately. */
const LENS: Record<LensKey, { label: string; rev: (m: MatchRow) => number; heads: (m: MatchRow) => number; noun: string }> = {
  all: { label: "All revenue", rev: (m) => m.dppRevenue + m.memberRevenue, heads: (m) => m.totalSpots, noun: "Spots" },
  member: { label: "Members", rev: (m) => m.memberRevenue, heads: (m) => m.memberSpots, noun: "Members" },
  dpp: { label: "DPP", rev: (m) => m.dppRevenue, heads: (m) => m.dppSpots, noun: "DPP" },
  free: { label: "Free", rev: () => 0, heads: (m) => m.freeSpots, noun: "Free" },
};

/* A SELECT NEVER CONSTRAINS ITSELF, NOR ANYTHING ABOVE IT IN THE CASCADE.
 * This map is the whole rule: when building CITY's options, ignore city, field and hour, so the
 * full city list survives a field selection. Getting this wrong is not obvious — it looks correct
 * until you pick a field and find the city list has collapsed to one entry with no way back. */
const IGNORES: Record<SelKey, SelKey[]> = {
  month: ["month"],
  weekof: ["weekof"],
  dow: ["dow"],
  city: ["city", "field", "hour"],
  field: ["field", "hour"],
  hour: ["hour"],
};

const VALUE: Record<SelKey, (m: MatchRow) => string> = {
  month: (m) => ymd(m.start).slice(0, 7),
  weekof: (m) => mondayOf(m.start),
  dow: (m) => dowOf(m.start),
  city: (m) => m.city,
  field: (m) => m.location,
  hour: (m) => hourOf(m.start),
};

const LABEL: Record<SelKey, (v: string) => string> = {
  month: monthLabel, weekof: weekLabel, dow: (v) => v, city: (v) => v, field: (v) => v, hour: (v) => v,
};

const HEADING: Record<SelKey, string> = {
  month: "Month", weekof: "Week of", dow: "Weekday", city: "City", field: "Field", hour: "Kick-off",
};
const PLURAL: Record<SelKey, string> = {
  month: "months", weekof: "weeks", dow: "weekdays", city: "cities", field: "fields", hour: "kick-offs",
};

const SORT: Partial<Record<SelKey, (a: string, b: string) => number>> = {
  month: (a, b) => (a < b ? 1 : -1),
  weekof: (a, b) => (a < b ? 1 : -1),
  dow: (a, b) => DAYS.indexOf(a) - DAYS.indexOf(b),
  hour: (a, b) => {
    const min = (t: string) => {
      const [hm, ap] = t.split(" ");
      const [h, m] = hm.split(":").map(Number);
      return ((h % 12) + (ap === "PM" ? 12 : 0)) * 60 + m;
    };
    return min(a) - min(b);
  },
};

/* THE LAST PRESET'S LABEL IS NOT A CONSTANT. Clearing the date range shows everything LOADED,
 * which is the whole record only after the operator has loaded it — so the button says "All
 * loaded" until then and "All time" afterwards. It read "All time" unconditionally against a
 * four-month window, which is the defect this panel was opened to fix: a control that answers a
 * question it was never given the data for. */
const PRESETS: [string, string, number | null][] = [
  ["14", "Last 2 weeks", 14],
  ["30", "Last 30 days", 30],
  ["90", "Last 90 days", 90],
  ["all", "All loaded", null],
];

type Filters = { from: string; to: string; preset: string } & Record<SelKey, string>;
const EMPTY: Filters = { from: "", to: "", preset: "all", month: "", weekof: "", dow: "", city: "", field: "", hour: "" };

export default function MatchView({
  rows, initialCity, windowKind = "ytd", windowLabel, loading = false, error = null,
  onLoadAllHistory, onShown, nowMs: nowMsProp,
}: {
  rows: MatchRow[];
  /* A CITY CARRIED IN FROM FIELD VIEW LANDS IN THIS VIEW'S OWN CITY SELECT, rather than being
   * applied to the rows before they arrive. Filtering them upstream left the selection INVISIBLE
   * here — the count said "669 of 1367" with nothing on screen to explain or clear it, which is
   * the same invisible-state fault the breakdown card was rebuilt to remove. Owned here, it shows
   * as a chip with an ×, exactly like a city picked in this view. */
  initialCity?: string;
  /* Which window the rows came from. "ytd" is the default and is NOT the whole record; "all"
   * means load-all-history has run and every preset below can finally mean what it says. */
  windowKind?: "ytd" | "all";
  /* Printed beside the row count. The window a table was built from is not derivable from the
   * table — 1,419 rows look identical whether they are the year or the century. */
  windowLabel?: string;
  loading?: boolean;
  /* A LOAD THAT FAILED MUST NOT READ AS A LOAD THAT FOUND NOTHING. Both render an empty table,
   * and only one of them means "there were no matches" — so the failure is stated on the panel
   * rather than swallowed into a zero. */
  error?: string | null;
  onLoadAllHistory?: () => void;
  /* The rows currently on screen, reported up so the section-level Export sends what the
   * operator is looking at rather than its own separately-filtered set. */
  onShown?: (rows: MatchRow[]) => void;
  /* Injectable clock. Whether a match has kicked off is a function of NOW, so a test that cannot
   * set it can only assert on rows that are safely in the past and never on the boundary. */
  nowMs?: number;
}) {
  const [f, setF] = useState<Filters>(() => (initialCity ? { ...EMPTY, city: initialCity } : EMPTY));
  const [lens, setLens] = useState<LensKey>("all");
  /* UPCOMING MATCHES ARE OFF BY DEFAULT and were never meant to be in the figures at all. On
   * 24 Aug the table was topped by 29 and 30 Aug — two spots sold, field cost already allocated,
   * profit deeply negative — and those rows dragged MATCHES, AVG REVENUE, AVG COST, MARGIN and
   * PROFIT down with them. A match that has not kicked off has not finished selling. */
  const [includeUpcoming, setIncludeUpcoming] = useState(false);

  /* HAS THIS MATCH KICKED OFF? start_date is venue-LOCAL wall clock wearing a fake +00:00;
   * comparing it against a real instant runs 4-5h early and reports tonight's matches as played.
   * That bug has shipped three times, so MatchRow carries startUtcMs (true instant, from
   * start_date_utc via matchStartMs) and this is the only comparison made.
   *
   * A NULL INSTANT IS NOT PAST. Upstream has not populated start_date_utc for that row, and an
   * unknown time is not evidence a match happened — it stays out of the figures. */
  const nowMs = nowMsProp ?? Date.now();
  const kickedOff = (m: MatchRow) => hasKickedOff(m, nowMs);
  const upcomingCount = useMemo(() => rows.filter((m) => !kickedOff(m)).length, [rows, nowMs]);

  /* THE BASE the selects and the table both work from, so an option's count is the number of
   * rows choosing it actually shows. */
  const base = useMemo(
    () => (includeUpcoming ? rows : rows.filter(kickedOff)),
    [rows, includeUpcoming, nowMs],
  );

  /** Does this match survive the filters, ignoring the ones the cascade says to skip? */
  const passes = useMemo(() => (m: MatchRow, skip: SelKey | null): boolean => {
    const off = skip ? IGNORES[skip] : [];
    const on = (k: SelKey) => !off.includes(k);
    const d = ymd(m.start);
    if ((!f.from || d >= f.from) && (!f.to || d <= f.to)) { /* in range */ } else return false;
    for (const k of ["month", "weekof", "dow", "city", "field", "hour"] as SelKey[]) {
      if (on(k) && f[k] && VALUE[k](m) !== f[k]) return false;
    }
    return true;
  }, [f]);

  const shown = useMemo(() => base.filter((m) => passes(m, null)), [base, passes]);

  useEffect(() => { onShown?.(shown); }, [shown, onShown]);

  /** Options for one select, each with the count you get by choosing it. */
  const optionsFor = (k: SelKey) => {
    const seen = new Map<string, number>();
    for (const m of base) if (passes(m, k)) {
      const v = VALUE[k](m);
      if (v) seen.set(v, (seen.get(v) ?? 0) + 1);
    }
    const out = [...seen.entries()]
      .sort((a, b) => (SORT[k] ? SORT[k]!(a[0], b[0]) : a[0] < b[0] ? -1 : 1))
      .map(([v, n]) => ({ v, n, label: LABEL[k](v) }));
    // A value that has vanished from the data but is still SELECTED stays listed, or the control
    // silently drops the filter it is displaying.
    if (f[k] && !out.some((o) => o.v === f[k])) out.unshift({ v: f[k], n: 0, label: LABEL[k](f[k]) });
    return out;
  };

  /* CHANGING AN UPSTREAM SELECT DROPS DOWNSTREAM CHOICES IT CANNOT SERVE — never leaves one
   * selected and silently matching nothing. */
  const setSel = (k: SelKey, v: string) => {
    setF((cur) => {
      const next = { ...cur, [k]: v };
      if (k === "city") { next.field = ""; next.hour = ""; }
      if (k === "field") { next.hour = ""; }
      return next;
    });
  };

  const setPreset = (p: string, days: number | null) => {
    if (days == null) { setF((c) => ({ ...c, preset: "all", from: "", to: "" })); return; }
    const to = new Date();
    const from = new Date();
    // 14 days INCLUSIVE of today — the span is exactly `days`, asserted.
    from.setDate(from.getDate() - (days - 1));
    setF((c) => ({ ...c, preset: p, from: ymd(from), to: ymd(to) }));
  };

  // ── THE BAND ────────────────────────────────────────────────────────────────────────────────
  const L = LENS[lens];
  const st = useMemo(() => {
    /* THE BAND MEASURES COMPLETED MATCHES ONLY, whatever the table is showing. Turning upcoming
     * rows on is a request to SEE what is coming, never a claim that it has been earned — so
     * this line, not `shown`, is what every figure below is built from. */
    const done = shown.filter(kickedOff);
    const n = done.length;
    const rev = done.reduce((a, m) => a + L.rev(m), 0);
    /* COST IS ONLY SUMMED OVER ROWS THAT HAVE ONE. `fieldCost ?? 0` treated a venue-month with no
     * cost basis on file as free, which understates cost and overstates profit — the exact
     * 0-for-unknown the rest of this file refuses. Outside the loaded finance quarters (every
     * all-time row) that is the normal case, not an edge one. */
    const costed = done.filter((m) => m.fieldCost != null);
    const cost = costed.reduce((a, m) => a + (m.fieldCost ?? 0), 0);
    const costedRev = costed.reduce((a, m) => a + L.rev(m), 0);
    const heads = done.reduce((a, m) => a + L.heads(m), 0);
    const spots = done.reduce((a, m) => a + m.totalSpots, 0);
    const promos = done.reduce((a, m) => a + m.promos, 0);
    const promoMatches = done.filter((m) => m.promos > 0).length;
    /* PROFIT IS DERIVED FROM WHAT THE OTHER TWO TILES PRINT, not from the unrounded pair.
     * Revenue and cost are each rounded to the dollar for display; a profit rounded independently
     * lands a dollar away from the subtraction a reader does on screen — measured: 271,844 −
     * 110,724 printed 161,121. The band has to reconcile on its face, so the rounding happens
     * once and profit and margin are built on top of it. */
    /* PROFIT AND MARGIN RECONCILE OVER THE COSTED ROWS, and the tiles say so when that is a
     * smaller set than the band's match count. Rounding once and deriving profit from the two
     * printed figures is kept from the original: a profit rounded independently lands a dollar
     * off the subtraction a reader does on screen. */
    const costedRevShown = Math.round(costedRev);
    const costShown = Math.round(cost);
    const profitShown = costedRevShown - costShown;
    const nCosted = costed.length;
    return {
      n, rev, cost, heads, spots, promos, promoMatches, nCosted,
      profit: nCosted > 0 ? profitShown : null,
      // EVERY ONE OF THESE IS A REAL ZERO CHECK. n === 0 gives null, which renders a dash.
      avgRev: n > 0 ? rev / n : null,
      avgCost: nCosted > 0 ? cost / nCosted : null,
      margin: nCosted > 0 && costedRevShown !== 0 ? (profitShown / costedRevShown) * 100 : null,
      perMatch: n > 0 ? heads / n : null,
    };
  }, [shown, L, nowMs]);
  // Partial cost coverage is the thing the sub-lines have to disclose; full coverage says nothing.
  const partialCost = st.nCosted < st.n;

  const chips: { k: string; label: string; clear: () => void }[] = [];
  if (f.from || f.to) {
    chips.push({
      k: "date",
      label: `${f.from ? shortDate(f.from) : "…"} – ${f.to ? shortDate(f.to) : "…"}`,
      clear: () => setF((c) => ({ ...c, from: "", to: "", preset: "all" })),
    });
  }
  for (const k of ["month", "weekof", "dow", "city", "field", "hour"] as SelKey[]) {
    if (f[k]) chips.push({ k, label: LABEL[k](f[k]), clear: () => setSel(k, "") });
  }

  /* THE WINDOW IS PART OF THE COUNT. "Showing all 1,419 matches on record" was false by two
   * orders of magnitude — they were the four months the header happened to have loaded. The
   * count now always names the window it was drawn from, and only says "on record" once the
   * whole record is actually in memory. */
  const scope = windowKind === "all"
    ? "the full record"
    : windowLabel ?? "the loaded window";
  const filtered = chips.length > 0 || shown.length !== base.length;
  const context = `Showing ${fmtInt(shown.length)} ${shown.length === 1 ? "match" : "matches"}`
    + (filtered ? ` of ${fmtInt(base.length)}` : "")
    + ` — ${scope}`
    + (chips.length ? `, ${chips.map((c) => c.label).join(", ")}` : "")
    + (includeUpcoming
        ? `, upcoming included`
        : upcomingCount > 0 ? `, ${fmtInt(upcomingCount)} upcoming hidden` : "")
    + ".";

  const TILES: { key: string; label: string; value: string; sub?: string; neg?: boolean }[] = [
    { key: "matches", label: "Matches", value: fmtInt(st.n),
      sub: st.n ? `${fmtInt(st.spots)} spots · completed only` : "completed only" },
    { key: "revenue", label: "Total revenue", value: fmtMoney(st.rev) },
    { key: "avgrev", label: "Avg revenue", value: st.avgRev == null ? "—" : fmtMoney(st.avgRev), sub: "per match" },
    // THE COSTED DENOMINATOR IS NAMED ON EVERY TILE THAT USES IT. Without it a reader subtracts
    // Field cost from Total revenue, gets a different profit, and has no way to see why.
    { key: "cost", label: "Field cost", value: fmtMoney(st.cost),
      sub: partialCost ? `${fmtInt(st.nCosted)} of ${fmtInt(st.n)} costed` : undefined },
    { key: "avgcost", label: "Avg cost", value: st.avgCost == null ? "—" : fmtMoney(st.avgCost),
      sub: partialCost ? `per costed match` : "per match" },
    { key: "profit", label: "Profit", value: st.profit == null ? "—" : fmtMoney(st.profit),
      sub: partialCost ? `on ${fmtInt(st.nCosted)} costed` : undefined,
      neg: st.profit != null && st.profit < 0 },
    { key: "margin", label: "Margin", value: st.margin == null ? "—" : `${st.margin.toFixed(1)}%`,
      sub: partialCost ? `on ${fmtInt(st.nCosted)} costed` : undefined,
      neg: st.margin != null && st.margin < 0 },
    { key: "heads", label: L.noun, value: fmtInt(st.heads), sub: st.perMatch == null ? undefined : `${st.perMatch.toFixed(1)} per match` },
    // NOT A LENS FIGURE. A redemption is a redemption whichever way the match is counted.
    { key: "promos", label: "Promo codes", value: fmtInt(st.promos), sub: st.n ? `on ${fmtInt(st.promoMatches)} of ${fmtInt(st.n)} matches` : undefined },
  ];

  return (
    <div data-testid="match-view">
      {/* ── WHEN ─────────────────────────────────────────────────────────────────────────── */}
      <div className={s.mvFilters}>
        <div className={s.mvRow}>
          <span className={s.ctrlLab}>When</span>
          <div className={s.seg} role="group" aria-label="Date range preset">
            {PRESETS.map(([p, label, days]) => (
              <button key={p} type="button" data-testid={`mv-preset-${p}`}
                className={f.preset === p ? s.on : ""} onClick={() => setPreset(p, days)}>
                {p === "all" && windowKind === "all" ? "All time" : label}</button>
            ))}
          </div>
          <label className={s.mvDate}>From
            <input type="date" data-testid="mv-from" value={f.from}
              onChange={(e) => setF((c) => ({ ...c, from: e.target.value, preset: "" }))} /></label>
          <label className={s.mvDate}>To
            <input type="date" data-testid="mv-to" value={f.to}
              onChange={(e) => setF((c) => ({ ...c, to: e.target.value, preset: "" }))} /></label>
        </div>

        {/* ── THE SIX ─────────────────────────────────────────────────────────────────────── */}
        <div className={s.mvSelects} data-testid="mv-selects">
          {(["month", "weekof", "dow", "city", "field", "hour"] as SelKey[]).map((k) => {
            const opts = optionsFor(k);
            return (
              <label key={k} className={s.mvSel}>
                <span>{HEADING[k]}</span>
                <select data-testid={`mv-${k}`} value={f[k]} onChange={(e) => setSel(k, e.target.value)}>
                  <option value="">All {PLURAL[k]}</option>
                  {/* EVERY OPTION CARRIES ITS COUNT, and an option that matches nothing is not
                      here at all — optionsFor only ever emits values it actually saw. */}
                  {opts.map((o) => <option key={o.v} value={o.v}>{o.label} ({o.n})</option>)}
                </select>
              </label>
            );
          })}
        </div>

        {/* ── SHOW — one lens, not three filters ──────────────────────────────────────────── */}
        <div className={s.mvRow}>
          <span className={s.ctrlLab}>Show</span>
          <div className={s.seg} role="group" aria-label="Revenue lens">
            {(Object.keys(LENS) as LensKey[]).map((k) => (
              <button key={k} type="button" data-testid={`mv-lens-${k}`}
                className={lens === k ? s.on : ""} onClick={() => setLens(k)}>{LENS[k].label}</button>
            ))}
          </div>
        </div>

        {/* ── ROWS — upcoming, and the record ─────────────────────────────────────────────────
            THE TOGGLE ADDS ROWS TO THE TABLE, NOT TO THE FIGURES. Its label says so, because a
            toggle that silently moved every average would be the defect it was built to fix. */}
        <div className={s.mvRow}>
          <span className={s.ctrlLab}>Rows</span>
          <label className={s.mvToggle}>
            <input type="checkbox" data-testid="mv-include-upcoming"
              checked={includeUpcoming} disabled={upcomingCount === 0}
              onChange={(e) => setIncludeUpcoming(e.target.checked)} />
            <span>
              Include upcoming
              {upcomingCount > 0 ? ` (${fmtInt(upcomingCount)})` : " (none loaded)"}
              {includeUpcoming ? " — listed, never counted" : ""}
            </span>
          </label>

          <span className={s.brkGrow} />

          {/* ONE DELIBERATE 15-SECOND LOAD, and it says so before it is pressed rather than
              after. Once it has run the button is gone and the presets above mean what they
              say — there is nothing left to load. */}
          {windowKind === "all" ? (
            <span className={s.mvNote} data-testid="mv-window-note">
              Full record loaded — {RECORD_STARTS} to today.
            </span>
          ) : (
            <button type="button" className={s.btn} data-testid="mv-load-all"
              disabled={loading || !onLoadAllHistory} onClick={() => onLoadAllHistory?.()}>
              {loading ? "Loading…" : "Load all history (~15s)"}
            </button>
          )}
        </div>

        {/* ── CHIPS. A range set by a preset is invisible once you scroll past the buttons. ── */}
        {chips.length > 0 && (
          <div className={s.mvChips} data-testid="mv-chips">
            {chips.map((c) => (
              <span key={c.k} className={s.mvChip} data-testid="mv-chip" data-chip={c.k}>
                {c.label}
                <button type="button" aria-label={`Clear ${c.label}`} data-testid={`mv-chip-clear-${c.k}`}
                  onClick={c.clear}>×</button>
              </span>
            ))}
            <button type="button" className={s.brkClear} data-testid="mv-clear-all"
              onClick={() => { setF(EMPTY); }}>Clear all</button>
          </div>
        )}
      </div>

      {/* ── THE BAND ───────────────────────────────────────────────────────────────────────
          HIDDEN WHILE LOADING, not rendered with the numbers it has so far. A tile that changes
          after it has been read is worse than a tile that was not there yet. */}
      <div className={s.mvBand} data-testid="mv-band" hidden={loading}>
        {TILES.map((t) => (
          <div key={t.key} className={`${s.mvTile}${t.neg ? " " + s.mvNeg : ""}`} data-testid={`mv-tile-${t.key}`}>
            <span className={s.mvTileLab}>{t.label}</span>
            {/* NOT "mv-tile-value" — that collides with the mv-tile-* prefix a test naturally
                globs for, and a phantom tile appears in every count. */}
            <span className={s.mvTileVal} data-testid="mv-val">{t.value}</span>
            {t.sub && <span className={s.mvTileSub}>{t.sub}</span>}
          </div>
        ))}
      </div>
      {!loading && <div className={s.mvContext} data-testid="mv-context">{context}</div>}

      {/* ── THE EVIDENCE ─────────────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className={s.empty} data-testid="mv-loading">
          Loading {windowKind === "all" ? "the full record" : windowLabel ?? "matches"}…
        </div>
      ) : error ? (
        <div className={s.empty} data-testid="mv-error">
          Could not load matches — {error}. The figures above are not a result; nothing was read.
        </div>
      ) : shown.length === 0 ? (
        <div className={s.empty} data-testid="mv-empty">No matches for this selection.</div>
      ) : (
        <div className={s.tblWrap}>
          <table className={`${s.tbl} ${s.wide}`} data-testid="mv-table">
            <thead>
              <tr>
                <th className="l">Date</th><th className="l">Day</th><th className="l">Kick-off</th>
                <th className="l">City</th><th className="l">Field</th>
                <th>Spots</th><th>Members</th><th>DPP</th><th>Free</th><th>Promos</th>
                <th>Revenue</th><th>Field cost</th><th>Profit</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const rev = L.rev(m);
                const cost = m.fieldCost ?? 0;
                const profit = rev - cost;
                return (
                  <tr key={m.matchApiId} data-testid="mv-row" data-mid={m.matchApiId}
                      /* The row's LOCAL calendar date, machine-readable. The visible cell is
                       * "Aug 30" with no year, which cannot be compared against today across a
                       * multi-year window — and the future-match rule has to be assertable. */
                      data-d={ymd(m.start)}>
                    <td className="l">{shortDate(ymd(m.start))}</td>
                    <td className="l">{dowOf(m.start)}</td>
                    <td className="l">{hourOf(m.start)}</td>
                    <td className="l">{m.city}</td>
                    <td className="l">{m.location}</td>
                    <td>{fmtInt(m.totalSpots)}</td>
                    <td>{fmtInt(m.memberSpots)}</td>
                    <td>{fmtInt(m.dppSpots)}</td>
                    <td>{fmtInt(m.freeSpots)}</td>
                    <td>{fmtInt(m.promos)}</td>
                    <td>{fmtMoney(rev)}</td>
                    <td className={s.neg}>{m.fieldCost == null ? "—" : fmtMoney(cost)}</td>
                    <td className={profit < 0 ? s.neg : undefined}>{fmtMoney(profit)}</td>
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
