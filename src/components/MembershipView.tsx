"use client";

// PLAYER LIFECYCLE › MEMBERSHIP.
//
// NO DUAL-AXIS CHART. The deck plots active members and avg matches per member on two y-scales in
// one frame. That is two charts, and they are drawn as two: same months, each with its own scale
// and its own direct labels. In a dual-axis frame the crossing point is an artifact of where the
// two scales were placed, and people read it as a relationship — so the picture asserts something
// the data does not.
//
// COLOUR IS NEVER THE ONLY IDENTITY. Every share carries a direct label. The palette is validated
// for colour-blind separation (members #1baf7a · daily #2a78d6 · promotions #eb6834) and brand
// green is reserved for the all-time line, which is one series and needs no legend.
//
// GEOMETRY LIVES IN membershipModel, not here — scaleTicks, clampTip and the share maths are pure
// and asserted by membership-chart-test. Two of those rules caught bugs in the mockup that were
// invisible by eye: an axis stopping below its own max, and a tooltip escaping its card.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  SERIES, ALLTIME_COLOUR, axisTop, scaleTicks, clampTip, totalsByMonth, activeSeries,
  buildKpis, shares, pctShares, scopeLabel, classify,
  type SpotRow, type MonthTotals, type ActivePoint,
} from "@/lib/membershipModel";

type Payload = {
  months: string[]; rows: SpotRow[];
  /* activeMembers      — EVERY row with status ACTIVE (455). The wider set: includes comped and
   *                      staff. Drawn on the all-time chart line, never as a headline.
   * activeMembersPaid  — paying, external, activated (387). THE headline, and the identical
   *                      function the Home tile calls. See membership-parity-test.ts. */
  activeMembers: number; activeMembersPaid: number;
  membersScope: "network" | "city"; fieldScoped: boolean;
  dayMix: { day: string; member: number; daily: number; promo: number; total: number }[];
  byCity: { name: string; member: number; daily: number; promo: number }[];
  byField: { name: string; member: number; daily: number; promo: number }[];
  revenueByMonth: Record<string, number>;
  snapshots: { month: string; value: number; avgMatches: number | null }[];
  churnDays: number; scope: string | null; confined: boolean;
  churnedNow: number; churnedPrior: number; hasPriorMonth: boolean;
  activeByMonth: Record<string, number>;
  partial: Record<string, { elapsed: number; total: number }>;
  currentMonth: string;
  cities: string[]; fields: { fieldId: number; name: string }[];
  error?: string;
};

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/** "2024-02-01" -> "Feb 2024". String surgery, never new Date() — a captured month is a label. */
const monthLabel = (ymd: string) => `${MON[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
const money = (n: number) => `$${n.toFixed(2)}`;
/** " · 26 of 31 days" when the period has not finished, and nothing when it has. */
const partSuffix = (p?: { elapsed: number; total: number }) =>
  p && p.elapsed < p.total ? ` · partial, ${p.elapsed} of ${p.total} days` : "";
const isPartialMonth = (d: { partial?: Record<string, { elapsed: number; total: number }> } | null, m: string) => {
  const p = d?.partial?.[m];
  return !!p && p.elapsed < p.total;
};
const num = (n: number) => n.toLocaleString("en-US");

/* ── ONE PLOT GEOMETRY, SHARED ─────────────────────────────────────────────────────────────────
 * The title strip is 34 tall and the plot starts BELOW it, which is what keeps a direct label off
 * the title — asserted in the suite rather than eyeballed. */
const VB = { w: 640, h: 260 };
const PLOT = { x: 46, y: 44, w: VB.w - 62, h: VB.h - 44 - 34 };

function useTip() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<{ html: string; left: number; top: number } | null>(null);
  const show = useCallback((cx: number, cy: number, html: string, card: HTMLElement | null) => {
    const cw = card?.clientWidth ?? 600, ch = card?.clientHeight ?? 300;
    const k = cw / VB.w;
    const box = clampTip(cx * k, cy * k, { w: 190, h: 68 }, { w: cw, h: ch });
    setTip({ html, left: box.left, top: box.top });
  }, []);
  return { ref, tip, show, hide: () => setTip(null) };
}

function Tip({ tip }: { tip: { html: string; left: number; top: number } | null }) {
  if (!tip) return null;
  return (
    <div className="tip" style={{ left: tip.left, top: tip.top }} role="status"
      dangerouslySetInnerHTML={{ __html: tip.html }} />
  );
}

export default function MembershipView() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [city, setCity] = useState<string>("all");
  const [field, setField] = useState<string>("all");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      const q = new URLSearchParams();
      if (city !== "all") q.set("city", city);
      if (field !== "all") q.set("field", field);
      const r = await fetch(`/api/membership?${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
      const j = (await r.json()) as Payload;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      /* A FAILED LOAD CLEARS THE DATA. It used to keep the last successful payload, so switching
       * from Dallas to Houston with the route down left DALLAS's 20 members, 1.4 matches and
       * $17.26 on screen while the dropdown read "Houston" — four wrong numbers under the right
       * label, with only an error line to contradict them. Measured, not supposed.
       *
       * Now the tiles fall to their empty state and the error says why. An em-dash beside a
       * visible error is "we could not read"; an em-dash with no error is "no members to divide
       * by". Two different animals, and they no longer render identically. */
      setErr(e instanceof Error ? e.message : String(e));
      setData(null);
    }
    finally { setLoading(false); }
  }, [city, field]);
  useEffect(() => { void load(); }, [load]);

  const months = data?.months ?? [];
  const totals: MonthTotals[] = useMemo(() => totalsByMonth(data?.rows ?? [], months), [data, months]);
  const thisMonth = totals[totals.length - 1];
  const cityName = city === "all" ? null : city;
  const fieldName = field === "all" ? null : (data?.fields.find((f) => String(f.fieldId) === field)?.name ?? null);
  const scope = scopeLabel(cityName, fieldName, cityName);

  const revenue = thisMonth ? (data?.revenueByMonth[thisMonth.month] ?? 0) : 0;
  /* THE KPI READS THE SAME NUMBER THE CHART DRAWS. It used to read the LIVE subscription count
   * while the chart beside it read the captured snapshot — 451 against 383 for the same month. The
   * live figure has not gone away; it is stated on the all-time line where it belongs, as a
   * separate fact with its own label. */
  /* THE HEADLINE IS THE LIVE PAID-EXTERNAL COUNT, not the current month's snapshot row. Same
   * function as the Home tile (membershipStats.countActiveMembers), so the two pages cannot
   * disagree — membership-parity-test.ts holds them together. It used to read activeByMonth,
   * which is recomputed nightly, so this tile lagged Home by up to a day on top of the four
   * staff accounts the two predicates already disagreed about. */
  const activeThisMonth = data?.activeMembersPaid ?? 0;
  const part = thisMonth ? data?.partial?.[thisMonth.month] : undefined;
  const isPartial = !!part && part.elapsed < part.total;
  const kpis = buildKpis({
    activeMembers: activeThisMonth,
    // MATCHES, not spots — one match is one match.
    memberSpots: thisMonth?.memberMatches ?? 0,
    membershipRevenue: revenue,
    // Churn is a PLAYER concept — days since last played, the 90-day floor /api/lifecycle/churn
    // already defaults to. It is not a membership status, and the two disagree by design.
    churnedNow: data?.churnedNow ?? 0,
    // NO PRIOR MONTH MEANS NO CHANGE TO REPORT — 0 would assert a flat month nobody measured.
    churnedPrior: data?.hasPriorMonth ? (data?.churnedPrior ?? 0) : 0,
  });

  const active: ActivePoint[] = useMemo(() => activeSeries(
    (data?.snapshots ?? []).map((s) => ({ month: monthLabel(s.month), value: s.value })),
  ), [data]);

  return (
    <div className="ms">
      <h1 className="h1">MEMBERSHIP</h1>
      <p className="sub">
        Member activity, member and daily-play spot volume, and the composition of the player population.
      </p>
      {data?.confined && (
        <p className="note">Scoped to {data.scope}. Other cities are refused at the server, not hidden here.</p>
      )}

      <div className="filters">
        <label>City
          <select value={city} onChange={(e) => { setCity(e.target.value); setField("all"); }} data-testid="ms-city">
            <option value="all">All Matchday</option>
            {(data?.cities ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>Field
          <select value={field} onChange={(e) => setField(e.target.value)} data-testid="ms-field">
            <option value="all">All fields</option>
            {(data?.fields ?? []).map((f) => <option key={f.fieldId} value={String(f.fieldId)}>{f.name}</option>)}
          </select>
        </label>
        <span className="applies">Applies to every chart on this page</span>
      </div>

      {err && <p className="err">{err}</p>}
      {loading && <p className="sub">Loading…</p>}

      {/* ── FOUR KPIs ─────────────────────────────────────────────────────────────────────── */}
      <div className="kpis" data-testid="ms-kpis">
        {/* NO PARTIAL SUFFIX. "28 of 31 days" belongs to avg matches per member, which accrues
            over a month; a headcount does not. It is not 28/31ths of anything. The suffix stays
            on the two KPIs below, where the period is real. */}
        {/* THE SUBTITLE STATES THE NUMBER'S OWN SCOPE. Picking a FIELD narrows every chart on
            this page but cannot narrow this count — a membership belongs to a city, and
            mdapi_subscriptions has no field column. Saying so beats showing a city figure under
            a field heading. */}
        <Kpi k="Active members" v={num(kpis.activeMembers)}
          s={`paying, external · as of now${data?.fieldScoped ? ` · ${data.membersScope === "city" ? "city" : "network"}-wide, not per field` : ""}`} />
        <Kpi k="Avg matches / member" v={kpis.avgMatchesPerMember == null ? "—" : kpis.avgMatchesPerMember.toFixed(1)}
          s={`${thisMonth?.month ?? ""}${partSuffix(part)}`} />
        <Kpi k="Avg price / member spot"
          v={kpis.avgPricePerMemberSpot == null ? "—" : money(kpis.avgPricePerMemberSpot)}
          s={`${thisMonth?.month ?? ""} · membership revenue ÷ member spots${partSuffix(part)}`} />
        <Kpi k="MoM change in churned players" v={kpis.churnedMoMPct == null ? "—" : `${kpis.churnedMoMPct.toFixed(1)}%`}
          s={kpis.churnedNow > 0
            ? `${num(kpis.churnedNow)} players ${data?.churnDays ?? 90}+ days inactive, against ${num(kpis.churnedPrior)} the month before`
            : `${data?.churnDays ?? 90}+ days inactive — a PLAYER measure, not a membership status`} />
      </div>

      <AllTime points={active} live={data?.activeMembers ?? null} />
      <SpotsChart totals={totals} scope={scope} partial={data?.partial ?? {}} />
      <div className="pair">
        {/* NOT ONE DUAL-AXIS FRAME. Two charts, same months, each with its own scale. */}
        {/* EACH MONTH'S OWN ACTIVE COUNT, from the snapshot. Not one live number repeated. */}
        <Small title="Active members" sub="Selected months · captured monthly"
          values={totals.map((t) => ({ k: t.month, v: data?.activeByMonth[t.month] ?? 0, partial: isPartialMonth(data, t.month) }))}
          colour={SERIES[0].colour} fmt={num} />
        <Small title="Avg matches per member" sub="Same months, its own scale"
          values={totals.map((t) => {
            const a = data?.activeByMonth[t.month] ?? 0;
            return { k: t.month, v: a > 0 ? t.memberMatches / a : 0, partial: isPartialMonth(data, t.month) };
          })}
          colour={SERIES[1].colour} fmt={(n) => n.toFixed(1)} />
      </div>
      <DayMixChart rows={data?.dayMix ?? []} month={thisMonth?.month ?? ""} scope={scope}
        daysInMonth={part?.total ?? 31} />
      <Breakdown totals={totals} scope={scope}
        byCity={data?.byCity ?? []} byField={data?.byField ?? []} />
      <PriceTiles totals={totals} revenueByMonth={data?.revenueByMonth ?? {}} />

      <style jsx>{`
        .ms { padding: 4px 0 44px; position: relative }
        .h1 { font-size: 30px; font-weight: 900; letter-spacing: -.6px; margin: 0 0 6px }
        .sub, .note { font-size: 12.5px; color: rgba(16,35,26,.55); margin: 0 0 10px; max-width: 780px; line-height: 1.5 }
        .note { color: #B8730B }
        .err { color: #E8492A; font-size: 12.5px }
        .filters { display: flex; gap: 14px; align-items: end; flex-wrap: wrap; margin: 14px 0 16px }
        .filters :global(label) { display: flex; flex-direction: column; gap: 4px; font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; color: #93A49A }
        .filters :global(select) { border: 1px solid #E4EAE5; border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 15px; min-width: 170px; background: #fff }
        @media (min-width: 640px) { .filters :global(select) { font-size: 13px } }
        .applies { font-size: 11.5px; color: rgba(16,35,26,.45); padding-bottom: 9px }
        .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 16px }
        .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px }
      `}</style>
      <style jsx global>{`
        .mscard { background: #fff; border: 1px solid #E4EAE5; border-radius: 12px; padding: 0 0 12px; margin-bottom: 14px; position: relative }
        /* AUTO HEIGHT, NOT A FIXED 34. The fixed height matched the SVG plot's y-offset, which is
           right for the charts and wrong for a card whose subtitle wraps to two lines — the
           breakdown's "Aug 2026 · All Matchday · monthly proportion of…" wrapped and the bar below
           it drew straight over the second line. The SVG plot still starts at y=44 (that geometry
           is asserted in the suite); this is the HTML head, and it grows. */
        .mshead { padding: 12px 16px 6px; box-sizing: border-box }
        .mstitle { font-size: 13px; font-weight: 900; letter-spacing: -.2px; color: #10231A }
        .mssub { font-size: 11px; color: rgba(16,35,26,.45) }
        .tip { position: absolute; transform: translate(-50%, -100%); background: #10231A; color: #fff; border-radius: 8px;
               padding: 7px 10px; font-size: 11.5px; line-height: 1.4; pointer-events: none; white-space: nowrap; z-index: 5 }
        .legend { display: flex; gap: 14px; flex-wrap: wrap; padding: 0 16px 6px; font-size: 11.5px; color: rgba(16,35,26,.6) }
        .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px }
      `}</style>
    </div>
  );
}

function Kpi({ k, v, s }: { k: string; v: string; s: string }) {
  return (
    <div className="mscard" style={{ padding: "13px 15px" }} data-testid="ms-kpi">
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: "#93A49A" }}>{k}</div>
      <div style={{ fontSize: 25, fontWeight: 900, margin: "2px 0 1px" }} data-testid="ms-kpi-value">{v}</div>
      <div style={{ fontSize: 11, color: "rgba(16,35,26,.45)" }}>{s}</div>
    </div>
  );
}

/* ── THE ALL-TIME LINE — kept exactly as it was, one target per month added ────────────────────
 * Hover, click AND keyboard focus all land on the same point: a chart only reachable by mouse is
 * a chart half the operators cannot read. The FIRST month reports no delta, because there is
 * nothing before it and "+0" would assert a flat month that was never measured. */
function AllTime({ points, live }: { points: ActivePoint[]; live: number | null }) {
  const card = useRef<HTMLDivElement | null>(null);
  const { tip, show, hide } = useTip();
  if (!points.length) return null;
  const max = Math.max(...points.map((p) => p.value));
  const top = axisTop(max);
  const x = (i: number) => PLOT.x + (points.length === 1 ? PLOT.w / 2 : (i / (points.length - 1)) * PLOT.w);
  const y = (v: number) => PLOT.y + PLOT.h - (v / top) * PLOT.h;
  const last = points[points.length - 1];
  return (
    <div className="mscard" ref={card}>
      <div className="mshead">
        <div className="mstitle">Active members · all-time</div>
        {/* TWO REAL NUMBERS FOR THE SAME MONTH, AND THE PAGE SAYS SO.
            This line reads the last CAPTURED snapshot; the KPI above reads mdapi_subscriptions
            LIVE. Both are true, and printing one beside the other with no explanation is how a
            page teaches people not to trust it — so the difference is named rather than left to
            be discovered.

            CORRECTED 2026-08-28. This used to read "For Aug 2026 that is 383 against 451", which
            compared the capture to the wrong live number: 451/455 is EVERY row with status ACTIVE,
            including 64 priced at 0 and 40 staff accounts, and it was never what the KPI meant to
            answer. The KPI is now the paid-external count (387) on both this page and Home, and
            the wider 455 is labelled below as the wider set it is. What remains genuinely
            different here is TIME, not population: the captured value is a point in time and the
            KPI is now. */}
        <div className="mssub">
          <b>{num(last.value)}</b> active when {last.month} was captured
          {last.delta != null && <> · <span style={{ color: last.delta < 0 ? "#E8492A" : "#0B7A3E" }}>{last.delta > 0 ? "+" : ""}{last.delta}</span> from the month before</>}
          {/* THE WIDER SET, SAID AS A WIDER SET. Not a contradiction of the KPI above: every member
              in that 387 is inside this 455, plus 64 subscriptions priced at 0 and 40 staff
              accounts. A denominator, not a headline — it used to read "active live today", which
              is the same words as the KPI for a different population. */}
          {live != null && live !== last.value && (
            <> · <b>{num(live)}</b> all ACTIVE subscriptions, comped and staff included</>
          )}
          {" "}· click any point for its figure
        </div>
      </div>
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} width="100%" role="img" aria-label="Active members, all time">
        {scaleTicks(top).map((t) => (
          <g key={t}>
            <line x1={PLOT.x} x2={PLOT.x + PLOT.w} y1={y(t)} y2={y(t)} stroke="#EFF3EF" />
            <text x={PLOT.x - 8} y={y(t) + 4} textAnchor="end" fontSize="9.5" fill="#93A49A">{num(t)}</text>
          </g>
        ))}
        <polyline fill="none" stroke={ALLTIME_COLOUR} strokeWidth="2"
          points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
        {points.map((p, i) => (
          <circle key={p.month} cx={x(i)} cy={y(p.value)} r="4.5" fill={ALLTIME_COLOUR}
            tabIndex={0} role="button" data-testid="ms-alltime-point"
            aria-label={`${p.month}: ${p.value} active members${p.delta == null ? ", no prior month" : `, ${p.delta > 0 ? "up" : "down"} ${Math.abs(p.delta)}`}`}
            onMouseEnter={() => show(x(i), y(p.value), tipHtml(p), card.current)}
            onFocus={() => show(x(i), y(p.value), tipHtml(p), card.current)}
            onClick={() => show(x(i), y(p.value), tipHtml(p), card.current)}
            onMouseLeave={hide} onBlur={hide} style={{ cursor: "pointer", outlineOffset: 2 }} />
        ))}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}
const tipHtml = (p: ActivePoint) =>
  `<b>${p.month}</b><br>${num(p.value)} active` +
  (p.delta == null ? "<br><span style='opacity:.6'>no prior month</span>"
                   : `<br>${p.delta > 0 ? "+" : ""}${p.delta} from last month`);

/** Grouped bars, two series, one bar per month per series. */
function SpotsChart({ totals, scope, partial }: {
  totals: MonthTotals[]; scope: string; partial: Record<string, { elapsed: number; total: number }>;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const { tip, show, hide } = useTip();
  const max = Math.max(1, ...totals.flatMap((t) => [t.member, t.daily]));
  const top = axisTop(max);
  const bw = Math.min(34, (PLOT.w / Math.max(1, totals.length) - 16) / 2);
  return (
    <div className="mscard" ref={card}>
      <div className="mshead">
        <div className="mstitle">Member and daily-play spots booked</div>
        <div className="mssub">
          {totals[0]?.month} – {totals[totals.length - 1]?.month} · {scope}
          {(() => { const p = partial[totals[totals.length - 1]?.month ?? ""];
            return p && p.elapsed < p.total ? ` · ${totals[totals.length - 1].month} is partial, ${p.elapsed} of ${p.total} days` : ""; })()}
        </div>
      </div>
      <div className="legend">
        {SERIES.slice(0, 2).map((s) => <span key={s.key}><i style={{ background: s.colour }} />{s.label}</span>)}
      </div>
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} width="100%" role="img" aria-label="Member and daily-play spots booked by month">
        {scaleTicks(top).map((t) => (
          <g key={t}>
            <line x1={PLOT.x} x2={PLOT.x + PLOT.w} y1={PLOT.y + PLOT.h - (t / top) * PLOT.h} y2={PLOT.y + PLOT.h - (t / top) * PLOT.h} stroke="#EFF3EF" />
            <text x={PLOT.x - 8} y={PLOT.y + PLOT.h - (t / top) * PLOT.h + 4} textAnchor="end" fontSize="9.5" fill="#93A49A">{num(t)}</text>
          </g>
        ))}
        {totals.map((t, i) => {
          const cx = PLOT.x + (i + 0.5) * (PLOT.w / totals.length);
          const pm = partial[t.month];
          const isPart = !!pm && pm.elapsed < pm.total;
          return (
            <g key={t.month}>
              {[["member", t.member] as const, ["daily", t.daily] as const].map(([k, v], j) => {
                const h = (v / top) * PLOT.h;
                const bx = cx - bw - 2 + j * (bw + 4);
                const s = SERIES.find((x) => x.key === k)!;
                return (
                  <g key={k}>
                    <rect x={bx} y={PLOT.y + PLOT.h - h} width={bw} height={h} rx="2"
                      fill={isPart ? "#fff" : s.colour} stroke={s.colour} strokeWidth={isPart ? 1.5 : 0}
                      strokeDasharray={isPart ? "3 2" : undefined}
                      data-testid="ms-bar"
                      onMouseEnter={() => show(bx + bw / 2, PLOT.y + PLOT.h - h, `<b>${t.month}</b><br>${s.label}: ${num(v)}`, card.current)}
                      onMouseLeave={hide} />
                    {/* DIRECT LABEL — identity is never colour alone. */}
                    <text x={bx + bw / 2} y={PLOT.y + PLOT.h - h - 5} textAnchor="middle" fontSize="9" fontWeight="700" fill={s.colour}>{num(v)}</text>
                  </g>
                );
              })}
              <text x={cx} y={PLOT.y + PLOT.h + 15} textAnchor="middle" fontSize="10" fill="#6E8076">{t.month.split(" ")[0]}{isPart ? " ·" : ""}</text>
            </g>
          );
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

/** A single-series month chart with its OWN scale — half of the pair that replaces the dual axis. */
function Small({ title, sub, values, colour, fmt }: {
  title: string; sub: string; values: { k: string; v: number; partial?: boolean }[]; colour: string; fmt: (n: number) => string;
}) {
  const max = Math.max(1, ...values.map((v) => v.v));
  const top = axisTop(max, 4);
  const H = 170, P = { x: 44, y: 40, w: VB.w - 60, h: H - 40 - 26 };
  return (
    <div className="mscard">
      <div className="mshead"><div className="mstitle">{title}</div><div className="mssub">{sub}</div></div>
      <svg viewBox={`0 0 ${VB.w} ${H}`} width="100%" role="img" aria-label={title}>
        <line x1={P.x} x2={P.x + P.w} y1={P.y + P.h} y2={P.y + P.h} stroke="#E4EAE5" />
        {values.map((d, i) => {
          const h = (d.v / top) * P.h, bw = Math.min(30, P.w / values.length - 14);
          const bx = P.x + (i + 0.5) * (P.w / values.length) - bw / 2;
          return (
            <g key={d.k}>
              {/* A PARTIAL MONTH IS DRAWN DIFFERENTLY. Hollow with a dashed edge, and the axis
                  label carries a bullet — a partial period rendered identically to a complete one
                  reads as a collapse rather than as a month that has not finished. */}
              <rect x={bx} y={P.y + P.h - h} width={bw} height={h} rx="2" data-testid="ms-bar"
                fill={d.partial ? "#fff" : colour} stroke={colour} strokeWidth={d.partial ? 1.5 : 0}
                strokeDasharray={d.partial ? "3 2" : undefined} />
              <text x={bx + bw / 2} y={P.y + P.h - h - 5} textAnchor="middle" fontSize="9" fontWeight="700" fill={colour} data-testid="ms-bar-label">{fmt(d.v)}</text>
              <text x={bx + bw / 2} y={P.y + P.h + 14} textAnchor="middle" fontSize="9.5" fill="#6E8076">{d.k.split(" ")[0]}{d.partial ? " ·" : ""}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── 100% STACKED, ACROSS THE DAYS OF THE MONTH ───────────────────────────────────────────────
 * A DAY WITH NO PLAY IS DRAWN AS A GAP, not as three equal thirds. `shares()` marks it empty and
 * this skips it — inventing a 33/33/33 composition for a day nobody played would put a mix on
 * screen that never happened, and it would look exactly like a real one. */
function DayMixChart({ rows, month, scope, daysInMonth }: {
  rows: { day: string; member: number; daily: number; promo: number; total: number }[];
  month: string; scope: string; daysInMonth: number;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const { tip, show, hide } = useTip();
  if (!rows.length) return null;
  const sh = shares(rows);
  const H = 220, P = { x: 46, y: 44, w: VB.w - 62, h: H - 44 - 26 };
  const cw = P.w / rows.length;
  const dayNum = (d: string) => Number(d.slice(8, 10));
  const first = dayNum(rows[0].day), lastDay = dayNum(rows[rows.length - 1].day);
  /* AN AXIS, NOT TWO END LABELS. "01" at one end and "25" at the other tells you nothing about
   * where day 12 is. Ticks every 5 days, plus day 1, and only where a column actually exists. */
  const ticks = rows
    .map((r, i) => ({ d: dayNum(r.day), i }))
    .filter(({ d }) => d === 1 || d % 5 === 0);
  return (
    <div className="mscard" ref={card}>
      <div className="mshead">
        <div className="mstitle">Player population mix by day</div>
        {/* NAME THE DAYS ACTUALLY COVERED. "Aug 2026" alone over 25 columns in a 31-day month
            invites the reader to take the last column as the month's end. */}
        <div className="mssub">
          {month} · days {first}–{lastDay} of {daysInMonth}{first > 1 || lastDay < daysInMonth ? " · partial" : ""} · {scope}
        </div>
      </div>
      <div className="legend">{SERIES.map((s) => <span key={s.key}><i style={{ background: s.colour }} />{s.label}</span>)}</div>
      <svg viewBox={`0 0 ${VB.w} ${H}`} width="100%" role="img" aria-label={`Player population mix by day, ${month}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={P.x} x2={P.x + P.w} y1={P.y + P.h - f * P.h} y2={P.y + P.h - f * P.h} stroke="#EFF3EF" />
            <text x={P.x - 8} y={P.y + P.h - f * P.h + 4} textAnchor="end" fontSize="9.5" fill="#93A49A">{Math.round(f * 100)}%</text>
          </g>
        ))}
        {sh.map((d, i) => {
          if (d.empty) return null;
          const x = P.x + i * cw;
          let acc = 0;
          return (
            <g key={d.day}
              onMouseEnter={() => show(x + cw / 2, P.y, `<b>${d.day}</b><br>${SERIES[0].label} ${(d.member * 100).toFixed(0)}%<br>${SERIES[1].label} ${(d.daily * 100).toFixed(0)}%<br>${SERIES[2].label} ${(d.promo * 100).toFixed(0)}%`, card.current)}
              onMouseLeave={hide}>
              {([["member", d.member], ["daily", d.daily], ["promo", d.promo]] as const).map(([k, v]) => {
                const h = v * P.h, y = P.y + P.h - acc - h; acc += h;
                const col = SERIES.find((s2) => s2.key === k)!.colour;
                return <rect key={k} x={x} y={y} width={Math.max(1, cw - 1)} height={h} fill={col} data-testid="ms-bar" />;
              })}
            </g>
          );
        })}
        {ticks.map(({ d, i }) => (
          <g key={d}>
            <line x1={P.x + i * cw + cw / 2} x2={P.x + i * cw + cw / 2} y1={P.y + P.h} y2={P.y + P.h + 4} stroke="#C9D3CB" />
            <text x={P.x + i * cw + cw / 2} y={P.y + P.h + 15} textAnchor="middle" fontSize="9.5" fill="#6E8076"
              data-testid="ms-day-tick">{d}</text>
          </g>
        ))}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

/** Matchday / by city / by field, every share direct-labelled. */
function Breakdown({ totals, scope, byCity, byField }: {
  totals: MonthTotals[]; scope: string;
  byCity: { name: string; member: number; daily: number; promo: number }[];
  byField: { name: string; member: number; daily: number; promo: number }[];
}) {
  const [view, setView] = useState<"md" | "city" | "field">("md");
  const t = totals[totals.length - 1];
  if (!t) return null;
  const p = pctShares(t.member, t.daily, t.promo);
  const bars = [
    { s: SERIES[0], v: p.member, n: t.member }, { s: SERIES[1], v: p.daily, n: t.daily }, { s: SERIES[2], v: p.promo, n: t.promo },
  ];
  const rows = view === "city" ? byCity : view === "field" ? byField : [];
  return (
    <div className="mscard">
      <div className="mshead">
        <div className="mstitle">Player population breakdown</div>
        <div className="mssub">{t.month} · {scope} · monthly proportion of member, daily-play and promotion players</div>
      </div>
      <div style={{ padding: "6px 16px 0" }}>
        <div style={{ display: "flex", height: 26, borderRadius: 6, overflow: "hidden", border: "1px solid #E4EAE5" }} data-testid="ms-mix">
          {bars.filter((b) => b.v > 0).map((b) => (
            <div key={b.s.key} style={{ width: `${b.v}%`, background: b.s.colour }} title={`${b.s.label} ${b.v.toFixed(1)}%`} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 9 }}>
          {bars.map((b) => (
            <span key={b.s.key} style={{ fontSize: 11.5, color: "rgba(16,35,26,.65)" }} data-testid="ms-share-label">
              <i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: b.s.colour, marginRight: 5 }} />
              {b.s.label} <b>{b.v.toFixed(1)}%</b> · {num(b.n)} spots
            </span>
          ))}
        </div>

        {/* THE THREE VIEWS. Every row direct-labelled — a stacked bar whose only identity is colour
            is unreadable to anyone who cannot separate the three, and this palette is chosen for
            separation precisely so the labels are a second signal rather than the only one. */}
        <div style={{ display: "flex", gap: 6, margin: "14px 0 8px" }}>
          {([["md", "Matchday"], ["city", "By city"], ["field", "By field"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setView(k)} data-testid="ms-mix-view"
              style={{ border: "1px solid " + (view === k ? "#0F3323" : "#E4EAE5"), background: view === k ? "#0F3323" : "#fff",
                       color: view === k ? "#fff" : "rgba(16,35,26,.6)", borderRadius: 999, padding: "5px 12px",
                       font: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{l}</button>
          ))}
        </div>
        {view !== "md" && (
          <div data-testid="ms-mix-rows">
            {rows.length === 0 && <p style={{ fontSize: 12, color: "rgba(16,35,26,.45)" }}>Nothing in this window.</p>}
            {rows.map((r) => {
              const q = pctShares(r.member, r.daily, r.promo);
              const tot = r.member + r.daily + r.promo;
              return (
                <div key={r.name} style={{ display: "grid", gridTemplateColumns: "minmax(120px,190px) 1fr", gap: 12, alignItems: "center", marginBottom: 7 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#3C4F44", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</div>
                  <div>
                    <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", border: "1px solid #EFF3EF" }}>
                      {[[SERIES[0], q.member], [SERIES[1], q.daily], [SERIES[2], q.promo]].map(([s2, v]) => (
                        (v as number) > 0 ? <div key={(s2 as typeof SERIES[number]).key} style={{ width: `${v}%`, background: (s2 as typeof SERIES[number]).colour }} /> : null
                      ))}
                    </div>
                    <div style={{ fontSize: 10.5, color: "rgba(16,35,26,.5)", marginTop: 3 }} data-testid="ms-share-label">
                      {q.member.toFixed(0)}% members · {q.daily.toFixed(0)}% daily · {q.promo.toFixed(0)}% promo · {num(tot)} spots
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** One tile per month — what a member actually paid per spot. */
function PriceTiles({ totals, revenueByMonth }: { totals: MonthTotals[]; revenueByMonth: Record<string, number> }) {
  return (
    <div className="mscard">
      <div className="mshead">
        <div className="mstitle">Average price per member spot</div>
        <div className="mssub">What a member actually paid per spot · membership revenue ÷ member spots</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, padding: "8px 16px 0" }}>
        {totals.map((t) => {
          const rev = revenueByMonth[t.month] ?? 0;
          const rate = t.member > 0 ? rev / t.member : null;
          return (
            <div key={t.month} style={{ border: "1px solid #EFF3EF", borderRadius: 9, padding: "10px 12px" }} data-testid="ms-price-tile">
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "#93A49A" }}>{t.month}</div>
              {/* NULL, NOT ZERO. "$0.00 per spot" is a claim; "—" is the absence of one. */}
              <div style={{ fontSize: 19, fontWeight: 900 }}>{rate == null ? "—" : money(rate)}</div>
              <div style={{ fontSize: 10.5, color: "rgba(16,35,26,.45)" }}>{num(t.member)} member spots</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
