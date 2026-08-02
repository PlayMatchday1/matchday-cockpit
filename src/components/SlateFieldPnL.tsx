"use client";

// Slate Review — Match P&L by field. Per-field unit economics for the last four
// completed weeks (the same window Cancel Patterns uses, so the two reconcile).
//
// Ran matches only (is_cancelled=false); cancelled matches are excluded entirely.
// Fakes and WAITING are already excluded upstream by fetchWeekMatchPnL. Revenue
// is GROSS, before Stripe fees: paid DPP + allocated member value.
//
// Three cost buckets, never merged:
//   FLAT PER-MATCH  billing_type='per_match' — the only rankable bucket.
//   PROFIT SHARE    billing_type='profit_share' (and monthly_flat, also not a
//                   per-match rate) — cost isn't a fixed per-match number, so
//                   it's shown but excluded from the net ranking.
//   UNMAPPED        no venue resolution, or the link points at a deactivated
//                   venue (the 11 dead fin_venue_fields links) — cost unknown.
// A cost cell NEVER prints "$0": unknown cost prints "—", profit-share prints
// its billing label. A real $0 and an unknown cost never look the same.
//
// This card carries the SAME permission as the page (Match Ops / cities). No
// finance sub-gate — cost, net and the ranking are visible to anyone who can
// open the page.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";
import { fetchWeekMatchPnL, type MatchPnLRow } from "@/lib/matchPnL";
import { mostRecentCompletedWeekMonday, sundayEndOf } from "@/lib/weekWindow";
import { fieldCode } from "@/lib/slateFieldCodes";
import { normField } from "@/lib/normField";

const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", ink: "#12241d",
  muted: "#626f68", ok: "#12704a", line: "#e6ebe8", hair: "#eff3f1",
  chipBg: "#eef3f0", chipLine: "#e2eae5", surface: "#ffffff", railB: "#f6f9f7",
  gold: "#e3c369", goldInk: "#8a6300", loss: "#8f2d15", nsInk: "#6f6858",
};
const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString()}`;

type Bucket = "flat" | "share" | "unmapped";
type FieldAgg = {
  key: string;
  label: string;        // shared code source
  fullName: string;
  bucket: Bucket;
  costLabel: string;    // "profit share" | "monthly flat" | "" (flat uses $)
  matches: number;
  paid: number;         // gross DPP
  member: number;       // allocated member value
  revenue: number;      // paid + member (gross, before Stripe fees)
  cost: number | null;  // total field cost (flat only)
  net: number | null;   // revenue - cost (flat only)
  rows: MatchPnLRow[];
  unmappedFieldIds: number[];
};

export function fmtWindow(a: Date, b: Date): string {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${M[a.getMonth()]} ${a.getDate()} – ${M[b.getMonth()]} ${b.getDate()}`;
}

export default function SlateFieldPnL({ city }: { city: string }) {
  const { data, loading: dataLoading } = useFinanceData();
  const [active, setActive] = useState<MatchPnLRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // Window: the four completed weeks ending with the most recent completed week
  // — identical to Cancel Patterns, so per-field ran counts reconcile.
  const { weekStart, weekEnd } = useMemo(() => {
    const lastMon = mostRecentCompletedWeekMonday();
    const start = new Date(lastMon.getFullYear(), lastMon.getMonth(), lastMon.getDate() - 21);
    return { weekStart: start, weekEnd: sundayEndOf(lastMon) };
  }, []);

  useEffect(() => {
    if (dataLoading || !data) return;
    let cancelled = false;
    setActive(null); setError(null);
    fetchWeekMatchPnL(supabase, weekStart, weekEnd, data)
      .then((r) => { if (!cancelled) setActive(r.active); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [data, dataLoading, weekStart, weekEnd]);

  const venueById = useMemo(() => new Map((data?.venues ?? []).map((v) => [v.id, v])), [data]);
  const fieldByVenue = useMemo(() => {
    // venueId → list of mdapi_field_ids linked to it (for the unmapped drill-down)
    const m = new Map<number, number[]>();
    if (data) for (const [fid, vid] of data.venueFields) { const a = m.get(vid) ?? []; a.push(fid); m.set(vid, a); }
    return m;
  }, [data]);

  const agg = useMemo(() => {
    if (!active) return null;
    const rows = active.filter((r) => r.city === city);
    const groups = new Map<string, FieldAgg>();
    for (const r of rows) {
      const v = r.venueId != null ? venueById.get(r.venueId) : undefined;
      let bucket: Bucket; let costLabel = "";
      if (r.venueId == null || !v || v.is_active === false) bucket = "unmapped";
      else if (v.billing_type === "per_match") bucket = "flat";
      else { bucket = "share"; costLabel = v.billing_type === "profit_share" ? "profit share" : "monthly flat"; }
      const key = bucket === "unmapped" ? `unmapped:${r.venueId ?? r.venueRawName}` : `v:${r.venueId}`;
      const label = fieldCode(normField(v?.venue_name ?? r.venueRawName));
      let g = groups.get(key);
      if (!g) {
        g = { key, label, fullName: v?.venue_name ?? r.venueRawName, bucket, costLabel,
          matches: 0, paid: 0, member: 0, revenue: 0, cost: bucket === "flat" ? 0 : null, net: bucket === "flat" ? 0 : null, rows: [], unmappedFieldIds: [] };
        groups.set(key, g);
      }
      g.matches += 1;
      g.paid += r.grossRevenue;
      g.member += r.allocatedMemberRev;
      g.revenue = g.paid + g.member;
      g.rows.push(r);
      if (bucket === "flat") {
        g.cost = (g.cost ?? 0) + (r.fieldCost ?? 0);
        g.net = g.revenue - (g.cost ?? 0);
      }
      if (bucket === "unmapped" && r.venueId != null) g.unmappedFieldIds = fieldByVenue.get(r.venueId) ?? [];
    }
    const all = [...groups.values()];
    const flat = all.filter((g) => g.bucket === "flat").sort((a, b) => (b.net ?? 0) - (a.net ?? 0));
    const share = all.filter((g) => g.bucket === "share").sort((a, b) => b.revenue - a.revenue);
    const unmapped = all.filter((g) => g.bucket === "unmapped").sort((a, b) => b.matches - a.matches);
    // Footing assertion: paid + member must equal revenue for every field.
    for (const g of all) {
      if (Math.abs(g.paid + g.member - g.revenue) > 0.005) {
        // eslint-disable-next-line no-console
        console.error(`[SlateFieldPnL] footing failed for ${g.label}: ${g.paid}+${g.member} != ${g.revenue}`);
      }
    }
    return { flat, share, unmapped };
  }, [active, city, venueById, fieldByVenue]);

  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <div className="mb-[18px] rounded-2xl border p-[18px_18px_16px]" style={{ background: C.surface, borderColor: C.line }}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3.5">
        <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.8px]" style={{ color: C.muted }}>MATCH P&amp;L BY FIELD</h2>
        <span className="text-[11.5px]" style={{ color: C.muted }}>{fmtWindow(weekStart, weekEnd)} · last 4 completed weeks</span>
      </div>
      <p className="m-0 mb-3.5 text-[12.5px]" style={{ color: C.muted }}>
        Ran matches only. Revenue is gross, before Stripe fees. Only flat per-match fields are ranked — profit-share billing is a function of revenue, not a fixed per-match number, so it can&rsquo;t be ranked against them.
      </p>

      {error ? (
        <div className="rounded-[10px] border px-3 py-2 text-[12.5px]" style={{ borderColor: "#f0cec2", background: "#fbe9e3", color: C.loss }}>{error}</div>
      ) : !agg ? (
        <div className="py-8 text-center text-[13px]" style={{ color: C.muted }}>Loading match P&amp;L…</div>
      ) : agg.flat.length + agg.share.length + agg.unmapped.length === 0 ? (
        <div className="py-8 text-center text-[13px]" style={{ color: C.muted }}>No ran matches in this window for {city}.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th left>Field</Th>
                <Th>Matches</Th>
                <Th right>Gross revenue<span className="block text-[9px] font-semibold normal-case tracking-normal" style={{ color: C.nsInk }}>before Stripe fees</span></Th>
                <Th right>Field cost</Th>
                <Th right>Net</Th>
              </tr>
            </thead>
            <tbody>
              {agg.flat.length > 0 && <GroupHead label="Flat per-match rate · ranked by net" />}
              {agg.flat.map((g, i) => <FieldRows key={g.key} g={g} rank={i + 1} open={open.has(g.key)} onToggle={() => toggle(g.key)} />)}

              {agg.share.length > 0 && <GroupHead label="Profit share / monthly flat · not ranked (cost is not a fixed per-match rate)" />}
              {agg.share.map((g) => <FieldRows key={g.key} g={g} open={open.has(g.key)} onToggle={() => toggle(g.key)} />)}

              {agg.unmapped.length > 0 && <GroupHead label="Unmapped · no venue / deactivated link · cost unknown" />}
              {agg.unmapped.map((g) => <FieldRows key={g.key} g={g} open={open.has(g.key)} onToggle={() => toggle(g.key)} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, right, left }: { children: React.ReactNode; right?: boolean; left?: boolean }) {
  return <th className={`border-b px-2.5 py-2 text-[10px] font-bold uppercase tracking-[0.6px] ${right ? "text-right" : left ? "text-left" : "text-center"}`} style={{ color: C.muted, borderColor: C.line }}>{children}</th>;
}
function GroupHead({ label }: { label: string }) {
  return <tr><td colSpan={5} className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.7px]" style={{ background: C.railB, color: C.nsInk }}>{label}</td></tr>;
}

function FieldRows({ g, rank, open, onToggle }: { g: FieldAgg; rank?: number; open: boolean; onToggle: () => void }) {
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: `1px solid ${C.hair}` };
  const costCell = g.bucket === "flat"
    ? <span style={{ color: C.ink }}>{fmtUsd(g.cost ?? 0)}</span>
    : g.bucket === "share"
      ? <span style={{ color: C.goldInk, fontWeight: 700 }}>{g.costLabel}</span>
      : <span style={{ color: C.muted }}>—</span>;
  const netCell = g.bucket === "flat" && g.net != null
    ? <span style={{ fontWeight: 800, color: g.net > 10 ? C.ok : g.net < -10 ? C.loss : C.muted }}>{g.net < 0 ? `-${fmtUsd(-g.net)}` : fmtUsd(g.net)}</span>
    : <span style={{ color: C.muted }}>—</span>;
  return (
    <>
      <tr className="cursor-pointer" onClick={onToggle}>
        <td style={{ ...td }}>
          <span className="inline-flex items-center gap-2">
            {rank != null && <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold" style={{ background: C.chipBg, color: C.forest }}>{rank}</span>}
            <b style={{ color: C.forestDeep }}>{g.label}</b>
            <span className="text-[11px]" style={{ color: C.muted }}>{g.fullName}</span>
            <span aria-hidden className="text-[10px]" style={{ color: C.muted }}>{open ? "▾" : "▸"}</span>
          </span>
        </td>
        <td style={{ ...td, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{g.matches}</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.ink }}>{fmtUsd(g.revenue)}</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{costCell}</td>
        <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{netCell}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: C.railB, padding: "10px 14px", borderBottom: `1px solid ${C.hair}` }}>
            <div className="text-[11.5px]" style={{ color: C.nsInk }}>
              <div className="mb-1.5 flex flex-wrap gap-x-6 gap-y-1">
                <span>Paid revenue (DPP, before Stripe fees): <b style={{ color: C.ink }}>{fmtUsd(g.paid)}</b></span>
                <span>+ Allocated member revenue: <b style={{ color: C.ink }}>{fmtUsd(g.member)}</b></span>
                <span>= Revenue: <b style={{ color: C.ink }}>{fmtUsd(g.revenue)}</b> <span style={{ color: Math.abs(g.paid + g.member - g.revenue) < 0.005 ? C.ok : C.loss }}>{Math.abs(g.paid + g.member - g.revenue) < 0.005 ? "✓ foots" : "✗"}</span></span>
              </div>
              {g.bucket === "share" && <div className="mb-1.5" style={{ color: C.goldInk }}>Cost is <b>{g.costLabel}</b> — a function of revenue, not a fixed per-match number; excluded from the net ranking. See the partner dashboard for the settled figure.</div>}
              {g.bucket === "unmapped" && <div className="mb-1.5" style={{ color: C.muted }}>No usable venue cost{g.unmappedFieldIds.length ? <> — field id{g.unmappedFieldIds.length === 1 ? "" : "s"} {g.unmappedFieldIds.join(", ")} {g.unmappedFieldIds.length === 1 ? "links" : "link"} to a deactivated venue</> : " — no fin_venue_fields link"}.</div>}
              <table className="w-full border-collapse">
                <tbody>
                  {g.rows.slice().sort((a, b) => a.matchStart.getTime() - b.matchStart.getTime()).map((r) => (
                    <tr key={r.matchStartIso}>
                      <td className="py-0.5 pr-3" style={{ color: C.muted }}>{r.dayLabel} {r.timeLabel}</td>
                      <td className="py-0.5 pr-3 tabular-nums" style={{ color: C.nsInk }}>{r.paidSpots} paid · {r.memberSpots} member</td>
                      <td className="py-0.5 pr-3 tabular-nums text-right" style={{ color: C.ink }}>{fmtUsd(r.grossRevenue + r.allocatedMemberRev)}</td>
                      <td className="py-0.5 tabular-nums text-right" style={{ color: C.muted }}>{g.bucket === "flat" ? fmtUsd(r.fieldCost ?? 0) : g.bucket === "share" ? g.costLabel : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
