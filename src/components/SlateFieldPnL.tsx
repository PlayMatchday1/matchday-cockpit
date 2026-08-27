"use client";

// Slate Review — Match P&L by field, PER-MATCH economics. Average revenue and
// cost of ONE match at each field, so a field that ran 54 matches compares
// directly with one that ran 6. A window selector (1 / 2 / 4 completed weeks,
// default 4) recomputes from its own set of ran matches — never scaled.
//
// Ran matches only (is_cancelled=false). Fakes / WAITING / player-cancelled are
// excluded upstream; absents count. Revenue is GROSS, before Stripe fees, split
// three ways: DPP (DAILY PAID) + membership (allocated at the benchmark rate) +
// promo (PROMOCODE rows — usually $0/comped, but the spots are real and it's a
// genuine computed $0, never an unknown). The three revenue shares sum to 100%.
//
// Three cost buckets, never merged: flat per-match (the only rankable one, by
// NET PER MATCH), profit share (shown, labelled, excluded from the ranking), and
// unmapped (no venue / a link to a deactivated venue). A cost cell NEVER prints
// "$0" for an unknown cost — it prints an em-dash with its bucket. Cents (2dp)
// everywhere, tabular numerals. City-scoped; page-level match-ops guard only.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";
import { fetchWeekMatchPnL, type MatchPnLRow } from "@/lib/matchPnL";
import { fieldCode } from "@/lib/slateFieldCodes";
import { canonicalVenueName } from "@/lib/venueResolver";

const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", mint: "#e0f2e7",
  ink: "#12241d", muted: "#626f68", ok: "#12704a", line: "#e6ebe8", hair: "#eff3f1",
  chipBg: "#eef3f0", chipLine: "#e2eae5", surface: "#ffffff", railB: "#f6f9f7",
  colBg: "#f9fbfa", gold: "#e3c369", goldInk: "#8a6300", goldDot: "#d9a521",
  loss: "#8f2d15", nsInk: "#566661",
};
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (v: number) => Math.round(v * 100) / 100;
const fmtDay = (d: Date) => `${MO[d.getMonth()]} ${d.getDate()}`;

// Last completed Sunday on or before today, then the Monday `weeks` back.
function windowFor(weeks: number, now = new Date()): { start: Date; end: Date } {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = d.getDay(); // Sun=0 → today is the last completed Sunday
  const lastSun = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  const start = new Date(lastSun.getFullYear(), lastSun.getMonth(), lastSun.getDate() - (7 * weeks - 1));
  const end = new Date(lastSun.getFullYear(), lastSun.getMonth(), lastSun.getDate(), 23, 59, 59);
  return { start, end };
}

type Bucket = "flat" | "share" | "unmapped";
type FieldAgg = {
  key: string; label: string; fullName: string; bucket: Bucket; costLabel: string;
  matches: number;
  dpp: number; member: number; promo: number; promoSpots: number; // window totals
  revenue: number; cost: number | null;
  // per-match (cents)
  dppPM: number; memberPM: number; promoPM: number; revPM: number; costPM: number | null; netPM: number | null;
  unmappedNames: string[];
  /* THE SPLIT, SHOWN NOT BURIED. A merged Soccer Central line has to say which of its matches took
   * both pitches, or a reader cannot tell a $90 night from a $180 one. */
  onePitchMatches: number; twoPitchMatches: number; twoPitchCost: number;
};

// Three shares that sum to exactly 100.0 (1dp): round each, push drift onto the
// largest so colour+number always reconcile to a whole.
function sharesTo100(parts: number[], total: number): number[] {
  if (total <= 0) return parts.map(() => 0);
  const raw = parts.map((p) => (p / total) * 100);
  const rounded = raw.map((r) => Math.round(r * 10) / 10);
  const drift = Math.round((100 - rounded.reduce((a, b) => a + b, 0)) * 10) / 10;
  if (drift !== 0) { const i = raw.indexOf(Math.max(...raw)); rounded[i] = Math.round((rounded[i] + drift) * 10) / 10; }
  return rounded;
}

export default function SlateFieldPnL({ city }: { city: string }) {
  const { data, loading: dataLoading } = useFinanceData();
  const [win, setWin] = useState<1 | 2 | 4>(4);
  const [active, setActive] = useState<MatchPnLRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const { start, end } = useMemo(() => windowFor(win), [win]);
  const rangeLabel = `${fmtDay(start)} – ${fmtDay(end)}`;

  useEffect(() => {
    if (dataLoading || !data) return;
    let cancelled = false;
    setActive(null); setError(null);
    fetchWeekMatchPnL(supabase, start, end, data)
      .then((r) => { if (!cancelled) setActive(r.active); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [data, dataLoading, start, end]);

  const venueById = useMemo(() => new Map((data?.venues ?? []).map((v) => [v.id, v])), [data]);

  const agg = useMemo(() => {
    if (!active) return null;
    const rows = active.filter((r) => r.city === city);
    type Raw = Omit<FieldAgg, "revenue" | "dppPM" | "memberPM" | "promoPM" | "revPM" | "costPM" | "netPM">;
    const groups = new Map<string, Raw>();
    for (const r of rows) {
      // Special events carry no venue cost and must not dilute a pitch's
      // per-match average — excluded from the frozen non-cancelled denominator.
      if (r.isEvent) continue;
      const v = r.venueId != null ? venueById.get(r.venueId) : undefined;
      let bucket: Bucket; let costLabel = "";
      if (r.venueId == null || !v || v.is_active === false) bucket = "unmapped";
      else if (v.billing_type === "per_match") bucket = "flat";
      else { bucket = "share"; costLabel = v.billing_type === "profit_share" ? "profit share" : "monthly flat"; }
      /* ── SOCCER CENTRAL IS ONE LINE. This venue only. ─────────────────────────────────────────
       * Soccer Central runs on two 9v9 pitches side by side, and a tournament-size match occupies
       * both. fin_venues carries that as a second row — 11 "Soccer Central" at $90 and 53 "Soccer
       * Central Tournament" at $180 — which is the right DATA MODEL and the wrong thing to show:
       * one pitch reading as two fields, one of which looks twice as expensive.
       *
       * SO THE MERGE IS HERE, AT THE PRESENTATION LAYER, AND NOWHERE ELSE. Venue 53 stays a real
       * row carrying the real rate; nothing is folded into venue 11 and no rate is rewritten. The
       * split is shown on the line rather than buried.
       *
       * NOT A GENERIC GROUPING RULE, deliberately. Finance already has one — COMBINE_BY_NAME in
       * venueGroups.ts, which pairs exactly these two — and this is the same special case for the
       * one panel that groups by venueId instead of by group. Two venues, named, and that is all. */
      const SOCC_BASE = 11, SOCC_TOURNEY = 53;
      const isSocc = r.venueId === SOCC_BASE || r.venueId === SOCC_TOURNEY;
      const key = bucket === "unmapped" ? `unmapped:${r.venueId ?? r.venueRawName}`
        : isSocc ? `v:${SOCC_BASE}` : `v:${r.venueId}`;
      let g = groups.get(key);
      if (!g) {
        // The merged line is named for the BASE venue, never "Soccer Central Tournament".
        const nm = isSocc ? (venueById.get(SOCC_BASE)?.venue_name ?? "Soccer Central") : (v?.venue_name ?? r.venueRawName);
        g = { key, label: fieldCode(canonicalVenueName(nm)), fullName: nm,
          bucket, costLabel, matches: 0, dpp: 0, member: 0, promo: 0, promoSpots: 0, cost: bucket === "flat" ? 0 : null, unmappedNames: [],
          onePitchMatches: 0, twoPitchMatches: 0, twoPitchCost: 0 };
        groups.set(key, g);
      }
      /* TWO PITCHES IS TWO MATCHES — counts and denominators only. The COST doubling is already in
       * the rate ($180 on venue 53) and the charged unit count stays 1; doubling both would bill
       * $360. So this line adds units, and the cost line below adds r.fieldCost unchanged. */
      g.matches += r.matchUnits;
      if (r.matchUnits > 1) { g.twoPitchMatches += 1; g.twoPitchCost += r.fieldCost ?? 0; }
      else { g.onePitchMatches += 1; }
      g.dpp += r.grossRevenue;
      g.member += r.allocatedMemberRev;
      g.promo += r.promoRevenue;
      g.promoSpots += r.promoSpots;
      if (bucket === "flat") g.cost = (g.cost ?? 0) + (r.fieldCost ?? 0);
      if (bucket === "unmapped" && !g.unmappedNames.includes(r.venueRawName)) g.unmappedNames.push(r.venueRawName);
    }
    const finalize = (g: Raw): FieldAgg => {
      const dppPM = round2(g.dpp / g.matches), memberPM = round2(g.member / g.matches), promoPM = round2(g.promo / g.matches);
      const revPM = round2(dppPM + memberPM + promoPM); // sum of components → drill-down always foots
      const costPM = g.cost == null ? null : round2(g.cost / g.matches);
      return { ...g, revenue: g.dpp + g.member + g.promo, dppPM, memberPM, promoPM, revPM, costPM, netPM: costPM == null ? null : round2(revPM - costPM) };
    };
    const all = [...groups.values()].map(finalize);
    // Footing assertion (Part 6): DPP + member + promo per match = revenue per match, every field.
    for (const g of all) {
      if (Math.abs(g.dppPM + g.memberPM + g.promoPM - g.revPM) > 0.005) console.error(`[SlateFieldPnL] footing failed for ${g.label}`);
    }
    return {
      flat: all.filter((g) => g.bucket === "flat").sort((a, b) => (b.netPM ?? 0) - (a.netPM ?? 0)),
      share: all.filter((g) => g.bucket === "share").sort((a, b) => b.revPM - a.revPM),
      unmapped: all.filter((g) => g.bucket === "unmapped").sort((a, b) => b.matches - a.matches),
    };
  }, [active, city, venueById]);

  const unmappedCount = agg ? agg.unmapped.reduce((n, g) => n + g.unmappedNames.length, 0) : 0;

  return (
    <div className="mb-[18px] rounded-2xl border p-[18px_18px_16px]" style={{ background: C.surface, borderColor: C.line }}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* NO SUBTITLE. The window is already stated in the control beside this heading and
              "gross, before Stripe fees" is already the column subhead — the sentence repeated both
              and explained the rest. If a figure here needs a sentence, the figure or its label is
              wrong. */}
          <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.8px]" style={{ color: C.muted }}>MATCH P&amp;L BY FIELD</h2>
        </div>
        <div className="text-right">
          <div className="flex items-center gap-1.5">
            <span className="text-[10.5px] font-bold uppercase tracking-[0.7px]" style={{ color: C.muted }}>Average over</span>
            {([1, 2, 4] as const).map((w) => (
              <button key={w} type="button" onClick={() => setWin(w)}
                className="rounded-full border px-3 py-[5px] text-[12px] font-bold tabular-nums"
                style={w === win ? { background: C.forestDeep, borderColor: C.forestDeep, color: "#fff" } : { background: C.surface, borderColor: C.chipLine, color: C.nsInk }}>
                {w} {w === 1 ? "week" : "weeks"}
              </button>
            ))}
          </div>
          <div className="mt-2 text-[12px] tabular-nums" style={{ color: C.muted }}>{rangeLabel} · completed weeks only</div>
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-[10px] border px-3 py-2 text-[12.5px]" style={{ borderColor: "#f0cec2", background: "#fbe9e3", color: C.loss }}>{error}</div>
      ) : !agg ? (
        <div className="py-8 text-center text-[13px]" style={{ color: C.muted }}>Loading match P&amp;L…</div>
      ) : agg.flat.length + agg.share.length + agg.unmapped.length === 0 ? (
        <div className="py-8 text-center text-[13px]" style={{ color: C.muted }}>No ran matches in this window for {city}.</div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th left>Field</Th>
                <Th>Matches</Th>
                <Th right>Revenue / match<span className="block text-[9px] font-semibold normal-case tracking-normal" style={{ color: C.muted }}>gross, before Stripe fees</span></Th>
                <Th right>Field cost / match</Th>
                <Th right>Net / match</Th>
              </tr>
            </thead>
            <tbody>
              {agg.flat.length > 0 && <GroupHead label="Flat per-match rate" note="ranked by net per match" />}
              {agg.flat.map((g, i) => <FieldRows key={g.key} g={g} rank={i + 1} open={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} />)}
              {agg.share.length > 0 && <GroupHead label="Profit share" note="billing is a share of revenue, not a fixed per-match number, so these cannot be ranked against flat-rate fields" />}
              {agg.share.map((g) => <FieldRows key={g.key} g={g} open={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} />)}
              {agg.unmapped.length > 0 && <GroupHead label="Unmapped" note={`no usable venue cost — field 1552 (no fin_venue_fields link) plus links pointing at deactivated venues`} />}
              {agg.unmapped.length > 0 && (
                <tr><td className="l" style={{ padding: "12px 0 12px 10px", textAlign: "left", fontWeight: 600, color: C.muted, borderBottom: `1px solid ${C.hair}` }}>{unmappedCount} {unmappedCount === 1 ? "field" : "fields"} with no venue mapping{agg.unmapped.some((g) => g.unmappedNames.length) ? ` (${agg.unmapped.flatMap((g) => g.unmappedNames).join(", ")})` : ""}</td>
                  <td style={mut}>—</td><td style={mut}>—</td><td style={mut}>—</td><td style={{ ...mut, paddingRight: 10 }}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const mut: React.CSSProperties = { padding: "12px 0", textAlign: "right", color: C.nsInk, fontWeight: 600, borderBottom: `1px solid ${C.hair}` };
function Th({ children, right, left }: { children: React.ReactNode; right?: boolean; left?: boolean }) {
  return <th className={`border-b px-0 pb-2.5 align-bottom text-[11px] font-bold uppercase tracking-[0.6px] ${right ? "text-right" : left ? "pl-2.5 text-left" : "text-right"}`} style={{ color: C.muted, borderColor: C.line }}>{children}</th>;
}
function GroupHead({ label, note }: { label: string; note: string }) {
  return <tr><td colSpan={5} className="px-2.5 py-[7px] text-[11px] font-bold uppercase tracking-[0.7px]" style={{ background: C.hair, color: C.nsInk }}>{label}<span className="ml-2 font-semibold normal-case tracking-normal" style={{ color: C.muted }}>{note}</span></td></tr>;
}

function FieldRows({ g, rank, open, onToggle }: { g: FieldAgg; rank?: number; open: boolean; onToggle: () => void }) {
  const td: React.CSSProperties = { padding: "12px 0", fontSize: 14, fontWeight: 700, textAlign: "right", color: C.ink, borderBottom: `1px solid ${C.hair}`, cursor: "pointer" };
  const costCell = g.bucket === "flat" && g.costPM != null ? <span style={{ color: C.ink }}>{money(g.costPM)}</span>
    : g.bucket === "share" ? <span style={{ color: C.goldInk, fontWeight: 700 }}>Profit share</span>
      : <span style={{ color: C.nsInk }}>—</span>;
  const netCell = g.bucket === "flat" && g.netPM != null
    ? <span style={{ fontWeight: 800, fontSize: 15, color: g.netPM < 0 ? C.loss : C.ok }}>{money(g.netPM)}</span>
    : g.bucket === "share" ? <span style={{ color: C.nsInk }}>Not ranked</span> : <span style={{ color: C.nsInk }}>—</span>;
  return (
    <>
      <tr onClick={onToggle} className="hover:bg-[#f9fbfa]">
        <td style={{ ...td, textAlign: "left", paddingLeft: 10, cursor: "pointer" }}>
          {rank != null && <span className="mr-[9px] inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-extrabold" style={{ background: C.chipBg, border: `1px solid ${C.chipLine}`, color: C.nsInk }}>{rank}</span>}
          <span className="text-[14px] font-extrabold" style={{ color: C.ink }}>{g.label}</span>
          <span className="ml-2 text-[11.5px] font-semibold" style={{ color: C.muted }}>{g.fullName}</span>
          {g.bucket === "flat" && <span className="ml-2 text-[10px]" style={{ color: C.muted }}>{open ? "▾" : "▸"}</span>}
        </td>
        {/* A two-pitch match counts as the two slots it took, and the cell says so rather than
            leaving a reader to wonder why the total exceeds the nights played. */}
        <td style={{ ...td, color: C.nsInk, fontWeight: 600 }} data-testid="fp-matches">
          {g.matches}
          {g.twoPitchMatches > 0 && (
            <span style={{ color: C.muted, fontWeight: 500, fontSize: 11 }} title={`${g.twoPitchMatches} match${g.twoPitchMatches === 1 ? "" : "es"} occupied both 9v9 pitches and counts as two`}>
              {" "}({g.onePitchMatches}+{g.twoPitchMatches}×2)
            </span>
          )}
        </td>
        <td style={td}>{money(g.revPM)}</td>
        <td style={td}>{costCell}</td>
        <td style={{ ...td, paddingRight: 10 }}>{netCell}</td>
      </tr>
      {open && g.bucket === "flat" && (
        <tr><td colSpan={5} style={{ background: C.colBg, padding: 0, borderBottom: `1px solid ${C.line}` }}><Drill g={g} /></td></tr>
      )}
    </>
  );
}

function Drill({ g }: { g: FieldAgg }) {
  const bars = [
    { label: "DPP spots", pm: g.dppPM, hue: C.accent },
    { label: "Membership allocated", pm: g.memberPM, hue: C.forest },
    { label: "Promo spots", pm: g.promoPM, hue: C.goldDot },
  ];
  const [dppSh, memSh, promoSh] = sharesTo100([g.dpp, g.member, g.promo], g.revenue);
  const shares = [dppSh, memSh, promoSh];
  const costSharePct = g.cost != null && g.revenue > 0 ? Math.round((g.cost / g.revenue) * 1000) / 10 : 0;
  const maxPM = Math.max(g.dppPM, g.memberPM, g.promoPM, g.costPM ?? 0, 0.01);
  const wpct = (v: number) => `${(v / maxPM) * 100}%`;
  // Footing: show only the non-zero revenue components summed.
  const parts = bars.filter((b) => b.pm > 0);
  const sumPM = round2(parts.reduce((a, b) => a + b.pm, 0));
  const foots = Math.abs(sumPM - g.revPM) < 0.005;

  const Row = ({ label, pm, hue, pct, cost }: { label: string; pm: number; hue: string; pct: number; cost?: boolean }) => (
    <div className="grid items-center gap-3" style={{ gridTemplateColumns: "150px 1fr 96px 74px" }}>
      <span className="text-[12.5px] font-bold" style={{ color: C.ink }}>{label}</span>
      <span className="block h-3 overflow-hidden rounded-[3px]" style={{ background: C.hair }}><span className="block h-full rounded-[3px]" style={{ width: wpct(pm), background: hue }} /></span>
      <span className="text-right text-[13px] font-extrabold tabular-nums" style={{ color: C.ink }}>{money(pm)}</span>
      <span className="text-right text-[12px] font-semibold tabular-nums" style={{ color: cost ? C.loss : C.muted }}>{pct.toFixed(1)}%</span>
    </div>
  );

  return (
    <div className="px-3.5 pb-[18px] pt-4">
      <div className="flex max-w-[760px] flex-col gap-[9px]">
        <div className="grid items-center gap-3" style={{ gridTemplateColumns: "150px 1fr 96px 74px" }}>
          <span /><span />
          <span className="text-right text-[10px] font-bold uppercase tracking-[0.05em]" style={{ color: C.muted }}>per match</span>
          <span className="text-right text-[10px] font-bold uppercase tracking-[0.05em]" style={{ color: C.muted }}>of revenue</span>
        </div>
        {bars.map((b, i) => <Row key={b.label} label={b.label} pm={b.pm} hue={b.hue} pct={shares[i]} />)}
        <div style={{ borderTop: `1px solid ${C.line}`, margin: "4px 0 1px" }} />
        <Row label="Field cost" pm={g.costPM ?? 0} hue={C.loss} pct={costSharePct} cost />
      </div>
      <div className="mt-3.5 flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t pt-3 text-[12.5px] tabular-nums" style={{ borderColor: C.line, color: C.nsInk }}>
        {/* ARITHMETIC ONLY. The column headers already carry "revenue per match", "field cost" and
            "net per match"; naming them again in the sentence said each one twice. */}
        <span>{parts.map((b, i) => <span key={b.label}>{i > 0 ? " + " : ""}{money(b.pm)}</span>)} = <b style={{ color: C.ink }}>{money(sumPM)}</b> {foots ? <span className="font-extrabold" style={{ color: C.ok }}>✓ foots</span> : <span className="font-extrabold" style={{ color: C.loss }}>✗ does not foot</span>}</span>
        <span>less <b style={{ color: C.ink }}>{money(g.costPM ?? 0)}</b> = <b className="font-extrabold" style={{ color: (g.netPM ?? 0) < 0 ? C.loss : C.ok }}>{money(g.netPM ?? 0)}</b> per match</span>
      </div>
      <p className="m-0 mt-2.5 text-[12px] tabular-nums" style={{ color: C.muted }}>
        {g.matches} matches · {money(g.revenue)} gross · {money(g.cost ?? 0)} cost · {money(g.revenue - (g.cost ?? 0))} net
        {g.twoPitchMatches > 0 && (
          <> · <b data-testid="fp-split">{g.onePitchMatches} on one pitch, {g.twoPitchMatches} on both</b> ({money(g.twoPitchCost)} of the cost is two-pitch)</>
        )}
      </p>
    </div>
  );
}
