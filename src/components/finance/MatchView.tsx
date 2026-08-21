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

import { useMemo, useState } from "react";
import type { MatchRow } from "@/lib/fieldEconomics";
import { fmtMoney, fmtInt } from "@/components/growth/format";
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

const PRESETS: [string, string, number | null][] = [
  ["14", "Last 2 weeks", 14],
  ["30", "Last 30 days", 30],
  ["90", "Last 90 days", 90],
  ["all", "All time", null],
];

type Filters = { from: string; to: string; preset: string } & Record<SelKey, string>;
const EMPTY: Filters = { from: "", to: "", preset: "all", month: "", weekof: "", dow: "", city: "", field: "", hour: "" };

export default function MatchView({ rows, initialCity }: {
  rows: MatchRow[];
  /* A CITY CARRIED IN FROM FIELD VIEW LANDS IN THIS VIEW'S OWN CITY SELECT, rather than being
   * applied to the rows before they arrive. Filtering them upstream left the selection INVISIBLE
   * here — the count said "669 of 1367" with nothing on screen to explain or clear it, which is
   * the same invisible-state fault the breakdown card was rebuilt to remove. Owned here, it shows
   * as a chip with an ×, exactly like a city picked in this view. */
  initialCity?: string;
}) {
  const [f, setF] = useState<Filters>(() => (initialCity ? { ...EMPTY, city: initialCity } : EMPTY));
  const [lens, setLens] = useState<LensKey>("all");

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

  const shown = useMemo(() => rows.filter((m) => passes(m, null)), [rows, passes]);

  /** Options for one select, each with the count you get by choosing it. */
  const optionsFor = (k: SelKey) => {
    const seen = new Map<string, number>();
    for (const m of rows) if (passes(m, k)) {
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
    const n = shown.length;
    const rev = shown.reduce((a, m) => a + L.rev(m), 0);
    const cost = shown.reduce((a, m) => a + (m.fieldCost ?? 0), 0);
    const heads = shown.reduce((a, m) => a + L.heads(m), 0);
    const spots = shown.reduce((a, m) => a + m.totalSpots, 0);
    const promos = shown.reduce((a, m) => a + m.promos, 0);
    const promoMatches = shown.filter((m) => m.promos > 0).length;
    /* PROFIT IS DERIVED FROM WHAT THE OTHER TWO TILES PRINT, not from the unrounded pair.
     * Revenue and cost are each rounded to the dollar for display; a profit rounded independently
     * lands a dollar away from the subtraction a reader does on screen — measured: 271,844 −
     * 110,724 printed 161,121. The band has to reconcile on its face, so the rounding happens
     * once and profit and margin are built on top of it. */
    const revShown = Math.round(rev);
    const costShown = Math.round(cost);
    const profitShown = revShown - costShown;
    return {
      n, rev, cost, heads, spots, promos, promoMatches,
      profit: profitShown,
      // EVERY ONE OF THESE IS A REAL ZERO CHECK. n === 0 gives null, which renders a dash.
      avgRev: n > 0 ? rev / n : null,
      avgCost: n > 0 ? cost / n : null,
      margin: revShown !== 0 ? (profitShown / revShown) * 100 : null,
      perMatch: n > 0 ? heads / n : null,
    };
  }, [shown, L]);

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

  const context = shown.length === rows.length && chips.length === 0
    ? `Showing all ${fmtInt(rows.length)} matches on record.`
    : `Showing ${fmtInt(shown.length)} ${shown.length === 1 ? "match" : "matches"}${
        chips.length ? ` — ${chips.map((c) => c.label).join(", ")}.` : "."}`;

  const TILES: { key: string; label: string; value: string; sub?: string; neg?: boolean }[] = [
    { key: "matches", label: "Matches", value: fmtInt(st.n), sub: st.n ? `${fmtInt(st.spots)} spots` : undefined },
    { key: "revenue", label: "Total revenue", value: fmtMoney(st.rev) },
    { key: "avgrev", label: "Avg revenue", value: st.avgRev == null ? "—" : fmtMoney(st.avgRev), sub: "per match" },
    { key: "cost", label: "Field cost", value: fmtMoney(st.cost) },
    { key: "avgcost", label: "Avg cost", value: st.avgCost == null ? "—" : fmtMoney(st.avgCost), sub: "per match" },
    { key: "profit", label: "Profit", value: fmtMoney(st.profit), neg: st.profit < 0 },
    { key: "margin", label: "Margin", value: st.margin == null ? "—" : `${st.margin.toFixed(1)}%`, neg: st.margin != null && st.margin < 0 },
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
                className={f.preset === p ? s.on : ""} onClick={() => setPreset(p, days)}>{label}</button>
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

      {/* ── THE BAND ─────────────────────────────────────────────────────────────────────── */}
      <div className={s.mvBand} data-testid="mv-band">
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
      <div className={s.mvContext} data-testid="mv-context">{context}</div>

      {/* ── THE EVIDENCE ─────────────────────────────────────────────────────────────────── */}
      {shown.length === 0 ? (
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
                  <tr key={m.matchApiId} data-testid="mv-row" data-mid={m.matchApiId}>
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
