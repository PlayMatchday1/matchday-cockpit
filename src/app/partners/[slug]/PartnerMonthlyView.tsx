// Monthly-cadence partner dashboard (mockups/partner-monthly-v1_3.html) — for
// partners paid monthly (Hattrick, Crossbar). No week/month toggle: months are
// the pay unit, with a supplementary "last 8 weeks" activity strip. Presentation
// only; every figure is derived server-side (partnerGrain + the untouched payment
// model) and passed in. No "member"/"promo" anywhere; rentals itemised inside the
// revenue cell, never a match count.

import type { GrainRow } from "@/lib/partnerGrain";

const em = "—";
const num = (n: number | null) => (n == null ? em : n.toLocaleString("en-US"));
const money = (n: number | null) => (n == null ? em : (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dfull = (ymd: string) => `${MON[+ymd.slice(5, 7) - 1]} ${+ymd.slice(8, 10)}, ${ymd.slice(0, 4)}`;

export type MonthlySince = { spots: number; registered: number; guests: number; cancels: number; people: number; matches: number };
export type MonthlyWeek = { label: string; spots: number; matches: number; revenue: number };
export type PartnerMonthlyProps = {
  partnerName: string; sub: string;
  /* The payout terms in words, derived from the payout MODEL upstream. Never a percentage unless
   * the partner is actually on one — see partnerDashboardData's termsFor. */
  terms: string;
  since: MonthlySince; months: GrainRow[]; last8: MonthlyWeek[]; footnote: string;
};

function rentalTotal(r: GrainRow) { return r.rentals.reduce((s, x) => s + x.amount, 0); }
function statusPill(r: GrainRow) {
  if (r.isOpen) return <span className="pill prog">In progress</span>;
  if (r.state === "nothing") return <span className="pill none">Nothing owed</span>;
  if (r.state === "paid" || r.isOpening) return <span className="pill paid">Paid</span>;
  if (r.state === "past_due") return <span className="pill late">Past due</span>;
  return <span className="pill due">Due next cycle</span>;
}
function whenText(r: GrainRow) {
  if (r.isOpen) return { cls: "", t: `Closes ${dfull(r.periodEnd)}` };
  if (r.isOpening || r.state === "paid") return { cls: "", t: r.paidOn ? dfull(r.paidOn) : em };
  if (r.state === "past_due") return { cls: "late", t: `Was due ${dfull(r.dueDate)}` };
  if (r.state === "nothing") return { cls: "", t: em };
  return { cls: "", t: `Due ${dfull(r.dueDate)}` };
}

export default function PartnerMonthlyView({ partnerName, sub, terms, since, months, last8, footnote }: PartnerMonthlyProps) {
  const ordered = months.slice().sort((a, b) => a.key.localeCompare(b.key)); // newest LAST
  const detailed = ordered.filter((m) => m.matches != null);
  /* MONTHS WITH A FIGURE — which is no longer the same as CLOSED months. A per-match-fee period
   * carries an exact running total while it is still open (each played match has earned the fee and
   * nothing later changes it), so it belongs in the total. The caption below says which case this
   * is rather than asserting "closed months only" over a sum that now includes an open one. */
  const closed = ordered.filter((m) => m.payment != null);
  const totalIncludesOpen = closed.some((m) => m.isOpen);
  const sum = (rows: GrainRow[], f: (r: GrainRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  const revTotal = sum(detailed, (m) => m.revenue);
  const rentTotal = sum(detailed, rentalTotal);

  return (
    <div className="pm14">
      <style>{CSS}</style>
      <div className="phead">
        <h1>{partnerName} <em>— partner dashboard</em></h1>
        <p>{sub}</p>
      </div>

      <div className="sech">Since launch</div>
      <div className="tiles">
        <Tile v={num(since.spots)} l="Spots filled" n="Spots paid for and held. MatchDay does not record check-in, so this is not attendance." />
        <Tile v={num(since.registered)} l="Booked by registered players" n="Held by someone with a MatchDay account." />
        <Tile v={num(since.guests)} l="Guest spots" n="Bought by a registered player for someone without an account." />
        <Tile v={num(since.cancels)} l="Cancelled inside 24 hours" n="Non-refundable, so the revenue below still counts them." />
        <Tile v={num(since.people)} l="Distinct people" n={`Held at least one spot. Averages ${since.people ? (since.spots / since.people).toFixed(1) : "0"} spots each over ${since.matches} matches.`} />
      </div>

      <div className="sech">Every month</div>
      <div className="card">
        {/* THE TERMS, PASSED IN — NOT A LITERAL.
            This line read "Your share is 50% of qualifying revenue on every line" with the 50
            hardcoded in the JSX, which is worse than the header's stale interpolation: correcting
            the database would not have fixed it. Crossbar has never been on a percentage. The copy
            now comes from the payout model itself, so a partner cannot be told terms they are not
            on, and a dated change is described rather than back-applied to settled months. */}
        <div className="csub">Newest last. Your payment on every line is <b>{terms}</b>. A month is paid once it closes.</div>
        <table>
          <thead><tr>
            {["Period", "Matches", "Spots filled", "Daily players", "Guests", "Qualifying revenue", "Your payment", "Status", "When"].map((c) => <th key={c}>{c}</th>)}
          </tr></thead>
          <tbody>
            {ordered.map((m) => {
              const rent = rentalTotal(m);
              const w = whenText(m);
              return (
                <tr key={m.key} className={`${m.isOpening ? "opening" : ""} ${m.isOpen ? "running" : ""}`} data-k={m.key} data-diverged={m.diverged ? "1" : undefined}>
                  <td>{m.label}{m.isOpening && <span className="tag">opening period</span>}{m.isOpen && <span className="sub">Partial — through today, not a full month</span>}</td>
                  {/* THE NUMBER THAT PRODUCED THE PAYMENT, and the one that did not, side by side.
                      Under a per-match fee the billable count is what the money is; the cancelled
                      count sits beside it rather than inside it or hidden — "6 played, 9 cancelled"
                      is a conversation worth having with a partner. Other models are untouched. */}
                  <td>
                    {m.matchesBillable != null ? num(m.matchesBillable) : num(m.matches)}
                    {m.matchesCancelled != null && m.matchesCancelled > 0 && (
                      <span className="sub canc">{num(m.matchesCancelled)} cancelled, not billed</span>
                    )}
                  </td>
                  <td>{num(m.spots)}</td>
                  <td>{num(m.daily)}</td>
                  <td>{num(m.guests)}</td>
                  <td>{money(m.revenue)}{rent > 0 && m.revenue != null && <span className="sub rent">{money(m.revenue - rent)} matches + {money(rent)} {m.rentals[0].label}</span>}</td>
                  <td>{m.payment == null ? <>{em}<span className="sub">Not yet calculated</span></> : <>{money(m.payment)}{m.diverged && <span className="diverge" title={`Figures changed after payment — ${money(m.frozenPaid ?? 0)} was paid; a fresh recompute now reads ${money(m.livePayment ?? 0)}. The paid amount stands.`}> ✱</span>}</>}</td>
                  <td style={{ textAlign: "right" }}>{statusPill(m)}</td>
                  <td><span className={`when ${w.cls}`}>{w.t}</span></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>All time<span className="sub">{ordered.length} periods</span></td>
              <td>{num(sum(detailed, (m) => m.matches))}</td>
              <td>{num(sum(detailed, (m) => m.spots))}</td>
              <td>{num(sum(detailed, (m) => m.daily))}</td>
              <td>{num(sum(detailed, (m) => m.guests))}</td>
              <td>{money(revTotal)}<span className="sub rent">{money(revTotal - rentTotal)} matches + {money(rentTotal)} rentals</span><span className="sub">{detailed.length} months with detail</span></td>
              <td>{money(sum(closed, (m) => Math.round(m.payment ?? 0)))}<span className="sub">{totalIncludesOpen ? "includes the month in progress" : "closed months only"}</span></td>
              <td /><td />
            </tr>
          </tfoot>
        </table>
      </div>
      <a className="dispute" href="mailto:ryan@playmatchday.com?subject=Partner%20payment%20question">A payment here is missing or wrong →</a>

      <div className="sech">The last 8 weeks with a match</div>
      <div className="wks">
        {last8.map((w) => (
          <div className="wc" key={w.label} data-testid="week-card">
            <div className="wl">Week of</div><div className="wd">{w.label}</div>
            <div className="wv">{num(w.spots)}</div>
            <div className="wn">spots held<br />{w.matches} {w.matches === 1 ? "match" : "matches"} · {money(w.revenue)}</div>
          </div>
        ))}
      </div>

      <div className="foot" data-testid="footnote">{footnote}</div>
    </div>
  );
}

function Tile({ v, l, n }: { v: string; l: string; n: string }) {
  return <div className="tile"><div className="tl">{l}</div><div className="tv" data-t={l}>{v}</div><div className="tn">{n}</div></div>;
}

const CSS = `
.pm14{--forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--paper:#fff;--line:#E3E8E0;--slot:#F7F9F6;
  --mintSoft:#E9FAF1;--mintEdge:#A8E7C9;--mintInk:#046B45;--amber:#FFF6D6;--amberEdge:#F0DC9B;--amberInk:#7A5200;
  --coral:#FDE9E5;--coralEdge:#F3C4BB;--coralInk:#A83120;--blue:#EFF3FF;--blueEdge:#CBD9FF;--blueInk:#1B4FCB;
  color:var(--ink);font-variant-numeric:tabular-nums;max-width:1420px;margin:0 auto}
.pm14 .phead{padding:26px 0 18px}
.pm14 .phead h1{margin:0;font-size:30px;font-weight:900;letter-spacing:-.8px;color:var(--forest)}
.pm14 .phead h1 em{font-style:normal;color:#93A099}
.pm14 .phead p{margin:8px 0 0;font-size:12.5px;color:var(--muted);line-height:1.55}
.pm14 .sech{font-size:9.5px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:22px 0 10px}
.pm14 .tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.pm14 .tile{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:15px 17px;box-shadow:0 9px 26px rgba(0,51,38,.06)}
.pm14 .tl{font-size:9px;font-weight:900;letter-spacing:.9px;text-transform:uppercase;color:var(--muted)}
.pm14 .tv{font-size:31px;font-weight:900;letter-spacing:-1.3px;color:var(--forest);margin-top:7px;line-height:1}
.pm14 .tn{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.45}
.pm14 .card{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 9px 26px rgba(0,51,38,.06);overflow:hidden}
.pm14 .canc{color:var(--muted)}
.pm14 .csub{padding:14px 20px;border-bottom:1px solid var(--line);font-size:11.5px;color:var(--muted)}
.pm14 table{width:100%;border-collapse:separate;border-spacing:0}
.pm14 thead th{background:var(--slot);text-align:right;font-size:9px;font-weight:900;letter-spacing:.85px;text-transform:uppercase;color:var(--muted);padding:11px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
.pm14 thead th:first-child{text-align:left}
.pm14 tbody td{padding:13px 14px;text-align:right;font-size:13px;font-weight:800;color:var(--ink);border-bottom:1px solid #EDF1EC;white-space:nowrap}
.pm14 tbody td:first-child{text-align:left;font-weight:850;color:var(--forest)}
.pm14 tbody tr.opening td{background:#FBFAF6}
.pm14 tbody tr.running td{background:#FAFBFF}
.pm14 tfoot td{background:var(--forest);color:#fff;padding:14px;text-align:right;font-size:13px;font-weight:900;white-space:nowrap}
.pm14 tfoot td:first-child{text-align:left;font-size:10px;letter-spacing:.9px;text-transform:uppercase}
.pm14 .sub{display:block;font-size:10px;font-weight:750;color:var(--muted);margin-top:3px}
.pm14 .sub.rent{color:var(--blueInk)}
.pm14 tfoot .sub{color:#A8C4B7}
.pm14 tfoot .sub.rent{color:#9BD9F5}
.pm14 .pill{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:900;border-radius:99px;padding:4px 11px;white-space:nowrap}
.pm14 .pill.paid{background:var(--mintSoft);color:var(--mintInk);border:1px solid var(--mintEdge)}
.pm14 .pill.late{background:var(--coral);color:var(--coralInk);border:1px solid var(--coralEdge)}
.pm14 .pill.prog{background:var(--blue);color:var(--blueInk);border:1px solid var(--blueEdge)}
.pm14 .pill.due{background:var(--amber);color:var(--amberInk);border:1px solid var(--amberEdge)}
.pm14 .pill.none{background:var(--slot);color:var(--muted);border:1px solid var(--line)}
.pm14 .tag{display:inline-block;margin-left:9px;font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--amberInk);background:var(--amber);border:1px solid var(--amberEdge);border-radius:99px;padding:3px 8px;vertical-align:1px}
.pm14 .when{font-size:11px;font-weight:800;color:var(--muted)}
.pm14 .when.late{color:var(--coralInk)}
.pm14 .diverge{color:#A83120;font-weight:900;cursor:help}
.pm14 .dispute{display:inline-block;margin:15px 0 0;font-size:12px;font-weight:900;color:var(--forest);text-decoration:underline;text-underline-offset:3px}
.pm14 .wks{display:grid;grid-template-columns:repeat(8,1fr);gap:10px}
@media(max-width:1100px){.pm14 .wks{grid-template-columns:repeat(4,1fr)}.pm14 .tiles{grid-template-columns:repeat(2,1fr)}}
.pm14 .wc{background:var(--paper);border:1px solid var(--line);border-radius:13px;padding:12px 13px}
.pm14 .wl{font-size:8.5px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.pm14 .wd{font-size:10.5px;font-weight:800;color:var(--muted);margin-top:2px}
.pm14 .wv{font-size:24px;font-weight:900;color:var(--forest);margin-top:8px;line-height:1;letter-spacing:-.9px}
.pm14 .wn{font-size:10.5px;color:var(--muted);margin-top:6px;line-height:1.4}
.pm14 .foot{margin-top:16px;font-size:11px;color:var(--muted);line-height:1.65;max-width:1180px}
`;
