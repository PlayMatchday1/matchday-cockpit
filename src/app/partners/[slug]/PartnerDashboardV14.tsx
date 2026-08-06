"use client";

// v1_4 partner dashboard (mockups/partner-v1_4.html). Presentation only — every
// figure is derived server-side (src/lib/partnerGrain.ts + the untouched payment
// model) and passed in already aggregated; this component only toggles grain,
// draws deltas, and renders. No "member"/"promo" appears anywhere, in any grain.

import { useMemo, useState } from "react";
import type { PartnerGrains, GrainRow, Snapshot } from "@/lib/partnerGrain";

const C = {
  forest: "#003326", ink: "#0d1f18", muted: "#5C6B62", paper: "#fff", line: "#dfe4da",
  slot: "#F7F9F6", mintSoft: "#E4F9EF", mintInk: "#046B45", coralInk: "#A83120", coralSoft: "#FDE9E5",
};
const money = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
const num = (n: number) => n.toLocaleString("en-US");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dshort = (ymd: string) => `${MON[+ymd.slice(5, 7) - 1]} ${+ymd.slice(8, 10)}`;
const em = "—";

export type SinceLaunch = { matches: number; spots: number; people: number; paid: number };
export type PartnerV14Props = {
  partnerName: string; venue: string; city: string | null; sub: string;
  grains: PartnerGrains; sinceLaunch: SinceLaunch;
};

export default function PartnerDashboardV14({ partnerName, sub, grains, sinceLaunch }: PartnerV14Props) {
  const [grain, setGrain] = useState<"week" | "month">("month");
  const rows = grain === "month" ? grains.monthRows : grains.weekRows;
  const snap: Snapshot = grain === "month" ? grains.snapshotMonth : grains.snapshotWeek;

  return (
    <div className="pv14">
      <style>{CSS}</style>
      <div className="phead">
        <div className="eyebrow">MatchDay</div>
        <h1>{partnerName} <em>— partner dashboard</em></h1>
        <p>{sub}</p>
      </div>

      {/* snapshot */}
      <div className="card">
        <div className="chead">
          <div>
            <div className="ctitle">Current snapshot</div>
            <div className="csub">{grain === "month" ? "The latest complete month, measured against the month before it." : "The latest complete week, measured against the week before it."}</div>
          </div>
          <div className="seg noprint" role="tablist">
            <button role="tab" aria-selected={grain === "week"} className={grain === "week" ? "on" : ""} onClick={() => setGrain("week")}>Week</button>
            <button role="tab" aria-selected={grain === "month"} className={grain === "month" ? "on" : ""} onClick={() => setGrain("month")}>Month</button>
          </div>
        </div>
        <div className="cbody">
          <Snap snap={snap} />
        </div>
      </div>

      {/* since launch */}
      <div className="launch">
        <div className="lhead">Since<br />launch</div>
        {[[num(sinceLaunch.matches), "Matches played"], [num(sinceLaunch.spots), "Spots filled"], [num(sinceLaunch.people), "Distinct people"], [money(sinceLaunch.paid), "Paid to you"]].map(([b, s]) => (
          <div className="lk" key={s}><b>{b}</b><span>{s}</span></div>
        ))}
      </div>

      {/* table */}
      <div className="card">
        <div className="chead">
          <div>
            <div className="ctitle">{grain === "month" ? "Every month" : "Every week"}</div>
            <div className="csub">Newest first. Payments are cut {grains.cadence} at {grains.sharePct}% of qualifying revenue{grains.cadence === "weekly" && grain === "month" ? " — a month row is the sum of its weeks" : ""}.</div>
          </div>
        </div>
        <div className="scroller" data-testid="scroller">
          <table>
            <thead><tr>
              <th>Period</th><th>Matches</th><th>Spots filled</th><th>Daily players</th><th>Guests</th><th>Revenue</th><th>Your payment</th><th>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => <Rows key={r.key} r={r} />)}
            </tbody>
            <tfoot><Foot rows={rows} /></tfoot>
          </table>
        </div>
        <div className="foot" data-testid="footnote">{footnote(grains)}</div>
      </div>
    </div>
  );
}

function Snap({ snap }: { snap: Snapshot }) {
  const cur = snap.row, prev = snap.prior;
  if (!cur) return <div style={{ color: C.muted, fontSize: 13 }}>No complete period yet.</div>;
  const tiles: { l: string; get: (r: GrainRow) => number | null; money?: boolean }[] = [
    { l: "Matches", get: (r) => r.matches },
    { l: "Spots filled", get: (r) => r.spots },
    { l: "Daily players", get: (r) => r.daily },
    { l: "Guests", get: (r) => r.guests },
    { l: "Your payment", get: (r) => r.payment, money: true },
  ];
  return (
    <>
      <div className="snapname"><b>{cur.label}</b><span>latest complete {cur.weeksEarning != null ? "month" : "period"}{prev ? ` · compared with ${prev.label}` : ""}</span></div>
      <div className="tiles" style={{ marginTop: 15 }}>
        {tiles.map((t) => {
          const c = t.get(cur), p = prev ? t.get(prev) : null;
          return (
            <div className={`tile ${t.l === "Your payment" ? "pay" : ""}`} data-t={t.l} key={t.l}>
              <div className="tl">{t.l}</div>
              <div className="tv">{c == null ? em : t.money ? money(c) : num(c)}</div>
              <div className="trow">{delta(c, p, !!t.money)}{p != null && c != null ? <span className="tprev">was {t.money ? money(p) : num(p)}</span> : null}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function delta(cur: number | null, prev: number | null, isMoney: boolean) {
  if (cur == null || prev == null) return <span className="deltac flat">no prior period</span>;
  const d = cur - prev;
  if (d === 0) return <span className="deltac flat">no change</span>;
  const sign = d > 0 ? "+" : "−";
  const body = isMoney ? sign + money(Math.abs(d)).replace("$", "$") : sign + num(Math.abs(d));
  const pct = prev === 0 ? "" : ` (${sign}${Math.round(Math.abs(d) / Math.abs(prev) * 100)}%)`;
  return <span className={`deltac ${d > 0 ? "up" : "down"}`}>{body}{pct}</span>;
}

function statusPill(r: GrainRow) {
  if (r.paymentUnavailable) return <span className="pill none" title="Paid monthly — see the Month view">Paid monthly</span>;
  if (r.isOpen) return <span className="pill part">In progress</span>;
  if (r.state === "nothing") return <span className="pill none">Nothing owed</span>;
  if (r.weeksEarning && r.weeksPaid != null && r.weeksPaid > 0 && r.weeksPaid < r.weeksEarning) return <span className="pill part">{r.weeksPaid} of {r.weeksEarning} weeks paid</span>;
  if (r.state === "paid") return <span className="pill paid">Paid{r.paidOn ? ` ${dshort(r.paidOn)}` : ""}</span>;
  if (r.state === "past_due") return <span className="pill due" style={{ background: C.coralSoft, color: C.coralInk }}>Past due</span>;
  return <span className="pill due">Due next cycle</span>;
}

function Rows({ r }: { r: GrainRow }) {
  // A zero-MATCH period pays nothing and its money reads em-dash, never $0.
  const zeroMatch = !r.isOpening && (r.matches ?? 0) === 0 && r.rentals.length === 0;
  const revCell = zeroMatch || r.revenue == null ? em : money(r.revenue);
  const payCell = r.paymentUnavailable || r.payment == null || zeroMatch ? em
    : <>{money(r.payment)}{r.diverged && <span className="diverge" title={`Figures changed after payment — ${money(r.frozenPaid ?? 0)} was paid; a fresh recompute now reads ${money(r.livePayment ?? 0)}. The paid amount stands.`}> ✱</span>}</>;
  return (
    <>
      <tr className={`${zeroMatch ? "zero" : ""} ${r.isOpening ? "opening" : ""}`} data-k={r.key} data-diverged={r.diverged ? "1" : undefined}>
        <td>{r.label}{r.isOpening && <span className="tag">opening period</span>}</td>
        <td>{r.matches == null ? em : num(r.matches)}</td>
        <td>{r.spots == null ? em : num(r.spots)}</td>
        <td>{r.daily == null ? em : num(r.daily)}</td>
        <td>{r.guests == null ? em : num(r.guests)}</td>
        <td>{revCell}</td>
        <td>{payCell}</td>
        <td style={{ textAlign: "right" }}>{statusPill(r)}</td>
      </tr>
      {r.rentals.map((rl, i) => (
        <tr className="rental" key={`r${i}`} data-testid="rental-line">
          <td style={{ paddingLeft: 26 }}>↳ {rl.label}</td>
          <td>{em}</td><td>{em}</td><td>{em}</td><td>{em}</td>
          <td>{money(rl.amount)}</td><td>{em}</td>
          <td style={{ textAlign: "right", fontWeight: 700, color: C.muted, fontSize: 11 }}>included in revenue</td>
        </tr>
      ))}
    </>
  );
}

function Foot({ rows }: { rows: GrainRow[] }) {
  const sum = (f: (r: GrainRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  const anyPay = rows.some((r) => r.payment != null);
  return (
    <tr>
      <td>All time</td>
      <td>{num(sum((r) => r.matches))}</td>
      <td>{num(sum((r) => r.spots))}</td>
      <td>{num(sum((r) => r.daily))}</td>
      <td>{num(sum((r) => r.guests))}</td>
      <td>{money(sum((r) => r.revenue))}</td>
      <td>{anyPay ? money(rows.reduce((s, r) => s + (r.isOpen ? 0 : Math.round(r.payment ?? 0)), 0)) : em}</td>
      <td />
    </tr>
  );
}

function footnote(g: PartnerGrains): string {
  let s =
    "Spots filled is every seat paid for and held. MatchDay does not record check-in, so it is not attendance. " +
    "Daily players and Guests are shown; the remainder of Spots filled is made up of other seat types.";
  if (g.rentalTotal > 0) s += ` Private rentals (${money(g.rentalTotal)} across the period) count toward qualifying revenue and are itemised on their own line, never folded into a match.`;
  if (g.roundingDrift !== 0) s += ` Each week is rounded to the nearest dollar on its own, so the sum of the weeks is what was actually paid — it differs by ${money(Math.abs(g.roundingDrift))} from rounding once at the end.`;
  if (g.anyDiverged) s += " A ✱ marks a paid period whose underlying figures changed after payment; the amount shown is what was actually paid and is never recomputed.";
  return s;
}

const CSS = `
.pv14{--forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--paper:#fff;--line:#dfe4da;--slot:#F7F9F6;
  --mintSoft:#E4F9EF;--mintInk:#046B45;--coralInk:#A83120;--coralSoft:#FDE9E5;color:var(--ink);
  font-variant-numeric:tabular-nums;max-width:1360px;margin:0 auto}
.pv14 .phead{padding:26px 0 18px}
.pv14 .eyebrow{font-size:9.5px;font-weight:900;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted)}
.pv14 .phead h1{margin:7px 0 0;font-size:30px;font-weight:900;letter-spacing:-.8px;color:var(--forest)}
.pv14 .phead h1 em{font-style:normal;color:#93A099;font-weight:900}
.pv14 .phead p{margin:8px 0 0;font-size:12.5px;color:var(--muted);line-height:1.55}
.pv14 .card{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 9px 26px rgba(0,51,38,.075);overflow:hidden;margin-bottom:18px}
.pv14 .chead{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:17px 22px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.pv14 .ctitle{font-size:15.5px;font-weight:900;letter-spacing:-.2px;color:var(--forest)}
.pv14 .csub{font-size:11.5px;color:var(--muted);margin-top:4px;line-height:1.45;max-width:680px}
.pv14 .cbody{padding:18px 22px}
.pv14 .seg{display:inline-flex;background:var(--slot);border:1px solid var(--line);border-radius:99px;padding:3px;flex:none}
.pv14 .seg button{border:0;background:transparent;color:var(--muted);font-family:inherit;font-size:11.5px;font-weight:850;padding:7px 18px;border-radius:99px;cursor:pointer}
.pv14 .seg button.on{background:var(--forest);color:#fff}
.pv14 .snapname{display:flex;align-items:baseline;gap:11px;flex-wrap:wrap}
.pv14 .snapname b{font-size:21px;font-weight:900;letter-spacing:-.5px;color:var(--forest)}
.pv14 .snapname span{font-size:11.5px;font-weight:750;color:var(--muted)}
.pv14 .tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.pv14 .tile{background:var(--slot);border:1px solid var(--line);border-radius:13px;padding:14px 15px 13px}
.pv14 .tile.pay{background:#F1FBF6;border-color:#BFEBD5}
.pv14 .tl{font-size:9px;font-weight:900;letter-spacing:.9px;text-transform:uppercase;color:var(--muted)}
.pv14 .tv{font-size:29px;font-weight:900;letter-spacing:-1.2px;color:var(--forest);margin-top:7px;line-height:1}
.pv14 .trow{display:flex;align-items:center;gap:7px;margin-top:9px;flex-wrap:wrap}
.pv14 .deltac{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:900;border-radius:99px;padding:3px 9px}
.pv14 .deltac.up{background:var(--mintSoft);color:var(--mintInk)}
.pv14 .deltac.down{background:var(--coralSoft);color:var(--coralInk)}
.pv14 .deltac.flat{background:var(--slot);color:var(--muted);border:1px solid var(--line)}
.pv14 .tprev{font-size:10.5px;font-weight:700;color:var(--muted)}
.pv14 .launch{display:flex;flex-wrap:wrap;align-items:center;gap:0;background:var(--paper);border:1px solid var(--line);border-radius:14px;margin-bottom:18px;padding:4px 6px;box-shadow:0 9px 26px rgba(0,51,38,.075)}
.pv14 .lhead{padding:10px 8px 10px 16px;font-size:9px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:var(--muted);align-self:center}
.pv14 .lk{padding:10px 18px;display:flex;flex-direction:column;gap:3px}
.pv14 .lk + .lk{border-left:1px solid var(--line)}
.pv14 .lk b{font-size:16px;font-weight:900;color:var(--forest);letter-spacing:-.4px}
.pv14 .lk span{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.pv14 .scroller{max-height:min(58vh,520px);overflow:auto}
.pv14 table{width:100%;border-collapse:separate;border-spacing:0}
.pv14 thead th{position:sticky;top:0;z-index:3;background:var(--slot);text-align:right;font-size:9px;font-weight:900;letter-spacing:.85px;text-transform:uppercase;color:var(--muted);padding:11px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
.pv14 thead th:first-child{text-align:left}
.pv14 tbody td{padding:12px 14px;text-align:right;font-size:13px;font-weight:800;color:var(--ink);border-bottom:1px solid #EDF1EC;white-space:nowrap}
.pv14 tbody td:first-child{text-align:left;font-weight:850;color:var(--forest)}
.pv14 tbody tr.zero td{color:var(--muted);font-weight:700}
.pv14 tbody tr.rental td{font-size:11.5px;font-weight:750;color:var(--muted);background:#FCFEFD}
.pv14 tbody tr.rental td:first-child{color:var(--muted);font-weight:750}
.pv14 tbody tr.opening td{background:#FBFAF6}
.pv14 tfoot td{position:sticky;bottom:0;z-index:3;background:var(--forest);color:#fff;padding:13px 14px;text-align:right;font-size:13px;font-weight:900;white-space:nowrap}
.pv14 tfoot td:first-child{text-align:left;font-size:10px;letter-spacing:.9px;text-transform:uppercase}
.pv14 .pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:900;border-radius:99px;padding:4px 11px;white-space:nowrap}
.pv14 .pill.paid{background:var(--mintSoft);color:var(--mintInk)}
.pv14 .pill.due{background:#FFF6D6;color:#7A5200}
.pv14 .pill.part{background:#EFF3FF;color:#1B4FCB}
.pv14 .pill.none{background:var(--slot);color:var(--muted);border:1px solid var(--line)}
.pv14 .tag{display:inline-block;margin-left:9px;font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:#7A5200;background:#FFF6D6;border-radius:99px;padding:3px 8px;vertical-align:1px}
.pv14 .diverge{color:#A83120;font-weight:900;cursor:help}
.pv14 .foot{padding:13px 22px;border-top:1px solid var(--line);background:var(--slot);font-size:11px;color:var(--muted);line-height:1.6}
@media print{.pv14 .seg,.pv14 .noprint{display:none!important}.pv14 .card{box-shadow:none}}
`;
