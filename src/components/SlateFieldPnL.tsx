"use client";

// Slate Review — Match P&L by field, PER-MATCH economics. Average revenue and
// cost of ONE match at each field, so a field that ran 54 matches compares
// directly with one that ran 6. A window selector (1 / 2 / 4 completed weeks,
// default 4) recomputes from its own set of ran matches — never scaled.
//
// THE CALCULATION LIVES IN src/lib/fieldPnL.ts (Ryan, 2026-10-08), shared with Finance › Revenue's
// 4-week columns so a field reads the same numbers on both pages. This file renders it.
//
// ONE RANKED LIST. Flat-rate fields and profit-share fields rank together by NET PER MATCH: a
// profit-share field's cost is computed per match from the partner's terms (fieldPnL, ruling 1) and
// carries a "Profit share" tag, plus a provisional note while a month's member rate is open. A field
// whose cost cannot be computed shows the model's name and is not ranked; unmapped fields (no venue
// cost) are listed last. A cost cell NEVER prints "$0" for an unknown cost. Cents (2dp) everywhere,
// tabular numerals. City-scoped; page-level match-ops guard only.

import { useMemo, useState } from "react";
import { usePhone } from "@/lib/usePhone";
import { provisionalNote, rankFields, type FieldAgg } from "@/lib/fieldPnL";
import { useFieldPnL } from "@/lib/useFieldPnL";

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
  const isPhone = usePhone();
  const [win, setWin] = useState<1 | 2 | 4>(4);
  const [open, setOpen] = useState<string | null>(null);
  const { win: w, fields, error } = useFieldPnL(win);
  const rangeLabel = `${fmtDay(w.start)} – ${fmtDay(w.end)}`;

  const agg = useMemo(() => {
    if (!fields) return null;
    const all = fields.filter((g) => g.city === city);
    // Footing assertion (Part 6): DPP + member + promo per match = revenue per match, every field.
    for (const g of all) {
      if (Math.abs(g.dppPM + g.memberPM + g.promoPM - g.revPM) > 0.005) console.error(`[SlateFieldPnL] footing failed for ${g.label}`);
    }
    return rankFields(all);
  }, [fields, city]);

  const unmappedCount = agg ? agg.unmapped.reduce((n, g) => n + g.unmappedNames.length, 0) : 0;
  const total = agg ? agg.ranked.length + agg.model.length + agg.unmapped.length : 0;

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
      ) : total === 0 ? (
        <div className="py-8 text-center text-[13px]" style={{ color: C.muted }}>No ran matches in this window for {city}.</div>
      ) : (
        isPhone ? (
        /* ── ONE CARD PER FIELD (phone) ────────────────────────────────────────────────────────
           A five-column table at 390px either scrolls sideways or shears. Turned into cards, the
           field name has the whole width and the three figures are labelled rather than positional
           — a column header three screens up labels nothing.

           THE GROUP HEADERS STAY, with their notes. They are the reason the ranking is only inside
           the flat-rate group, and dropping them would leave a ranked list beside an unranked one
           with nothing saying why. */
        <div className="mt-4 flex flex-col gap-2" data-testid="fp-cards">
          {agg.ranked.length > 0 && <PhoneGroup label="Ranked by net per match" note="profit share costs are computed per match from the partner's terms" />}
          {agg.ranked.map((g, i) => <PhoneCard key={g.key} g={g} rank={i + 1} />)}
          {agg.model.length > 0 && <PhoneGroup label="No computed cost" note="the cost model cannot be split by match, so these are not ranked" />}
          {agg.model.map((g) => <PhoneCard key={g.key} g={g} />)}
          {agg.unmapped.length > 0 && <PhoneGroup label="Unmapped" note="no usable venue cost — field 1552 (no fin_venue_fields link) plus links pointing at deactivated venues" />}
          {agg.unmapped.length > 0 && (
            <div className="rounded-[10px] border px-3 py-2.5 text-[12.5px] font-semibold" style={{ borderColor: C.line, color: C.muted }}>
              {unmappedCount} {unmappedCount === 1 ? "field" : "fields"} with no venue mapping
              {agg.unmapped.some((g) => g.unmappedNames.length) ? ` (${agg.unmapped.flatMap((g) => g.unmappedNames).join(", ")})` : ""}
            </div>
          )}
        </div>
        ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th left>Field</Th>
                <Th>Matches</Th>
                <Th right>Revenue / match<span className="block text-[9px] font-semibold normal-case tracking-normal" style={{ color: C.muted }}>gross, before Stripe fees</span></Th>
                <Th right title={FIELD_COST_TIP}>Field cost / match</Th>
                <Th right>Net / match</Th>
              </tr>
            </thead>
            <tbody>
              {agg.ranked.length > 0 && <GroupHead label="Ranked by net per match" note="profit share costs are computed per match from the partner's terms" />}
              {agg.ranked.map((g, i) => <FieldRows key={g.key} g={g} rank={i + 1} open={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} />)}
              {agg.model.length > 0 && <GroupHead label="No computed cost" note="the cost model cannot be split by match, so these are not ranked" />}
              {agg.model.map((g) => <FieldRows key={g.key} g={g} open={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} />)}
              {agg.unmapped.length > 0 && <GroupHead label="Unmapped" note={`no usable venue cost — field 1552 (no fin_venue_fields link) plus links pointing at deactivated venues`} />}
              {agg.unmapped.length > 0 && (
                <tr><td className="l" style={{ padding: "12px 0 12px 10px", textAlign: "left", fontWeight: 600, color: C.muted, borderBottom: `1px solid ${C.hair}` }}>{unmappedCount} {unmappedCount === 1 ? "field" : "fields"} with no venue mapping{agg.unmapped.some((g) => g.unmappedNames.length) ? ` (${agg.unmapped.flatMap((g) => g.unmappedNames).join(", ")})` : ""}</td>
                  <td style={mut}>—</td><td style={mut}>—</td><td style={mut}>—</td><td style={{ ...mut, paddingRight: 10 }}>—</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )
      )}
    </div>
  );
}

function PhoneGroup({ label, note }: { label: string; note: string }) {
  return (
    <div className="mt-1.5 rounded-[8px] px-2.5 py-[7px] text-[11px] font-bold uppercase tracking-[0.7px] first:mt-0"
      style={{ background: C.hair, color: C.nsInk }}>
      {label}
      <span className="mt-0.5 block text-[10.5px] font-semibold normal-case tracking-normal" style={{ color: C.muted }}>{note}</span>
    </div>
  );
}

function PhoneCard({ g, rank }: { g: FieldAgg; rank?: number }) {
  /* A FIELD WITH NO COMPUTED COST SAYS ITS MODEL, NOT A NUMBER. Printing $0 there would assert the
     field was free. A profit-share field with a computed cost shows it, tagged. */
  const cost = g.costPM == null ? (g.bucket === "model" ? g.costLabel : "—") : <>{money(g.costPM)}<CostTags g={g} /></>;
  const net = g.netPM == null ? (g.bucket === "model" ? "Not ranked" : "—") : money(g.netPM);
  return (
    <div data-testid="fp-card" data-bucket={g.bucket} className="rounded-[11px] border px-3 py-2.5"
      style={{ borderColor: C.line, background: "#fff" }}>
      <div className="flex items-start gap-2">
        {rank != null && (
          <span className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-extrabold"
            style={{ background: C.chipBg, border: `1px solid ${C.chipLine}`, color: C.nsInk }}>{rank}</span>
        )}
        {/* THE FIELD NAME WRAPS. It is the one thing on the card that identifies it. */}
        <span className="min-w-0 flex-1 text-[13px] font-bold" style={{ overflowWrap: "break-word", lineHeight: 1.3 }}>{g.fullName}</span>
        <span className="flex-none text-[11.5px] font-semibold" data-testid="fp-matches" style={{ color: C.nsInk }}>
          {g.matches} {g.matches === 1 ? "match" : "matches"}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 tabular-nums">
        <Fig label="Revenue / match" v={money(g.revPM)} />
        <Fig label="Field cost / match" v={cost} />
        <Fig label="Net / match" v={net} />
      </div>
    </div>
  );
}
function Fig({ label, v }: { label: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9.5px] font-bold uppercase tracking-[0.05em]" style={{ color: C.muted }}>{label}</div>
      <div className="mt-px text-[13px] font-bold" style={{ color: C.ink }}>{v}</div>
    </div>
  );
}

const mut: React.CSSProperties = { padding: "12px 0", textAlign: "right", color: C.nsInk, fontWeight: 600, borderBottom: `1px solid ${C.hair}` };
function Th({ children, right, left, title }: { children: React.ReactNode; right?: boolean; left?: boolean; title?: string }) {
  return <th title={title} className={`border-b px-0 pb-2.5 align-bottom text-[11px] font-bold uppercase tracking-[0.6px] ${right ? "text-right" : left ? "pl-2.5 text-left" : "text-right"}`} style={{ color: C.muted, borderColor: C.line }}>{children}</th>;
}
function GroupHead({ label, note }: { label: string; note: string }) {
  return <tr><td colSpan={5} className="px-2.5 py-[7px] text-[11px] font-bold uppercase tracking-[0.7px]" style={{ background: C.hair, color: C.nsInk }}>{label}<span className="ml-2 font-semibold normal-case tracking-normal" style={{ color: C.muted }}>{note}</span></td></tr>;
}

function FieldRows({ g, rank, open, onToggle }: { g: FieldAgg; rank?: number; open: boolean; onToggle: () => void }) {
  const td: React.CSSProperties = { padding: "12px 0", fontSize: 14, fontWeight: 700, textAlign: "right", color: C.ink, borderBottom: `1px solid ${C.hair}`, cursor: "pointer" };
  const costCell = g.costPM != null ? <span style={{ color: C.ink }}>{money(g.costPM)}<CostTags g={g} /></span>
    : g.bucket === "model" ? <span style={{ color: C.goldInk, fontWeight: 700 }}>{g.costLabel}</span>
      : <span style={{ color: C.nsInk }}>—</span>;
  const netCell = g.netPM != null
    ? <span style={{ fontWeight: 800, fontSize: 15, color: g.netPM < 0 ? C.loss : C.ok }}>{money(g.netPM)}</span>
    : g.bucket === "model" ? <span style={{ color: C.nsInk }}>Not ranked</span> : <span style={{ color: C.nsInk }}>—</span>;
  return (
    <>
      <tr onClick={onToggle} className="hover:bg-[#f9fbfa]">
        <td style={{ ...td, textAlign: "left", paddingLeft: 10, cursor: "pointer" }}>
          {rank != null && <span className="mr-[9px] inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-extrabold" style={{ background: C.chipBg, border: `1px solid ${C.chipLine}`, color: C.nsInk }}>{rank}</span>}
          <span className="text-[14px] font-extrabold" style={{ color: C.ink }}>{g.label}</span>
          <span className="ml-2 text-[11.5px] font-semibold" style={{ color: C.muted }}>{g.fullName}</span>
          {g.netPM != null && <span className="ml-2 text-[10px]" style={{ color: C.muted }}>{open ? "▾" : "▸"}</span>}
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
      {open && g.netPM != null && (
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

/** The field cost header's tooltip — the same sentence as Finance › Revenue's. */
const FIELD_COST_TIP = "The field's cost per match. For profit share it is computed from the partner's terms and can differ from the billed amount on Field Costs.";

/* THE TAG ON A PROFIT-SHARE COST: it is a computed share, not a rate — and, while the month whose
 * member rate it uses is open, provisional. */
function CostTags({ g }: { g: FieldAgg }) {
  if (g.bucket !== "share") return null;
  return (
    <span className="block text-[10.5px] font-semibold" style={{ color: C.goldInk }} data-testid="fp-share-tag">
      Profit share{g.provisional ? ` · ${provisionalNote(g.provisionalMonths)}` : ""}
    </span>
  );
}
