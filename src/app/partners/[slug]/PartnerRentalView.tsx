"use client";

// The RENTAL_PLUS_PROFIT_SHARE partner dashboard.
//
// PUBLIC AND UNAUTHENTICATED, like every partner dashboard: the slug is the access grant. The
// partner therefore SEES the MatchDay retained figure, including negative ones. That is a
// deliberate call, not an oversight — the reconciliation line is what makes the split credible,
// and it cannot be shown without that number. It is flagged in the report so it can be removed
// before the link goes out if that is the wrong trade.
//
// Daily Players and Guests are absent by design: this model's dashboard shows SPOTS SOLD, NEW
// PLAYERS (first ever match at THIS venue) and RETURNING instead.

import type { RentalDashboardProps } from "@/lib/partnerRentalDashboard";
import { fmtCents } from "@/lib/partnerPayoutModel";

const pct = (n: number) => `${Number(n).toFixed(0)}%`;

export default function PartnerRentalView(p: RentalDashboardProps) {
  return (
    <div className="prv" data-testid="partner-rental">
      <style>{CSS}</style>

      <header className="prv-head">
        <h1 data-testid="prv-partner">{p.partnerName}</h1>
        <p className="prv-sub">{p.venue} · payouts by match</p>
      </header>

      {/* THE ARITHMETIC MUST PROVE ITSELF. If any row or total fails the identity, the page says so
          instead of printing figures nobody can trust. */}
      {!p.reconciles && (
        <div className="prv-broken" data-testid="prv-reconcile-error" role="alert">
          <b>These figures do not add up and are not being shown.</b>
          <span>
            Every match must satisfy <em>partner total + MatchDay retained + match manager = gross revenue</em>,
            exactly, in cents. At least one row or total here does not. Nothing on this page should be
            paid against until that is resolved — please contact MatchDay.
          </span>
        </div>
      )}

      {/* HOW IT WORKS — the terms, from the partner's own record. No figure here is written into
          the page; every one is read from the parameters. */}
      <section className="prv-terms" data-testid="prv-terms">
        <h2>How your payout works</h2>
        <ol>
          <li><b>{fmtCents(p.params.fieldRentalCents)}</b> field rental, owed on <b>every match played</b>, whatever the turnout.</li>
          <li>The match manager costs <b>{fmtCents(p.params.matchManagerCents)}</b> per match. That comes out before any split.</li>
          <li>What is left is the <b>profit share pool</b>. You take <b>{pct(p.params.partnerSharePct)}</b> of it; MatchDay takes the rest.</li>
          <li>If a match does not clear its costs there is <b>no profit share</b> — you still receive the full rental, and MatchDay absorbs the shortfall.</li>
        </ol>
        {p.breakevenSpots != null && p.spotPriceCents != null && (
          // THE MOST USEFUL NUMBER ON THE PAGE, for both sides. Derived from the parameters.
          <p className="prv-break" data-testid="prv-breakeven" data-spots={p.breakevenSpots}>
            <b>Breakeven: {p.breakevenSpots} spots.</b> At {fmtCents(p.spotPriceCents)} a spot, a match needs{" "}
            {p.breakevenSpots} sold before it produces any profit share
            {" "}({fmtCents(p.params.fieldRentalCents)} rental + {fmtCents(p.params.matchManagerCents)} manager
            = {fmtCents(p.params.fieldRentalCents + p.params.matchManagerCents)} of cost).
          </p>
        )}
      </section>

      {p.months.length === 0 && <p className="prv-empty" data-testid="prv-empty">No matches yet.</p>}

      {p.months.map((m) => (
        <section className="prv-month" data-testid="prv-month" data-ym={m.ym} key={m.ym}>
          <div className="prv-mhead">
            <h2>{m.label}</h2>
            <span className="prv-owed" data-testid="prv-month-owed" data-cents={m.totals.partnerTotalCents}>
              {fmtCents(m.totals.partnerTotalCents)} <i>owed to you</i>
            </span>
          </div>

          <div className="prv-metrics" data-testid="prv-metrics">
            <Metric k="SPOTS SOLD" v={m.spotsSold} testid="prv-spots" />
            <Metric k="NEW PLAYERS" v={m.newPlayers} testid="prv-new" sub={`first time at ${p.venue}`} />
            <Metric k="RETURNING" v={m.returning} testid="prv-returning" />
            <Metric k="MATCHES" v={m.totals.matches} testid="prv-matches" />
          </div>

          <div className="prv-scroll">
            <table className="prv-table" data-testid="prv-table">
              <thead>
                <tr>
                  <th>Match</th><th className="n">Spots</th><th className="n">Gross revenue</th>
                  <th className="n">Field rental</th><th className="n">Match manager</th><th className="n">Profit pool</th>
                  <th className="n">Your share</th><th className="n">MatchDay share</th>
                  <th className="n">Your total</th><th className="n">MatchDay retained</th>
                </tr>
              </thead>
              <tbody>
                {m.rows.map((r) => (
                  <tr key={r.matchApiId} data-testid="prv-row" data-match={r.matchApiId} data-reconciles={r.reconciles ? "true" : "false"}>
                    <td className="prv-when">{r.startYmd}</td>
                    <td className="n" data-testid="prv-row-spots">{r.spotsSold}</td>
                    <td className="n" data-testid="prv-row-gross" data-cents={r.grossCents}>{fmtCents(r.grossCents)}</td>
                    <td className="n">{fmtCents(r.fieldRentalCents)}</td>
                    <td className="n">{fmtCents(r.matchManagerCents)}</td>
                    <td className={"n" + (r.poolCents < 0 ? " neg" : "")} data-testid="prv-row-pool" data-cents={r.poolCents}>{fmtCents(r.poolCents)}</td>
                    <td className="n b" data-testid="prv-row-share" data-cents={r.partnerProfitShareCents}>{fmtCents(r.partnerProfitShareCents)}</td>
                    <td className={"n" + (r.matchdayProfitShareCents < 0 ? " neg" : "")}>{fmtCents(r.matchdayProfitShareCents)}</td>
                    {/* A row that fails the identity NEVER shows a total — it shows why. */}
                    <td className="n b" data-testid="prv-row-total" data-cents={r.partnerTotalCents}>
                      {r.reconciles ? fmtCents(r.partnerTotalCents) : <span className="prv-cellerr" data-testid="prv-row-error">does not reconcile</span>}
                    </td>
                    <td className={"n" + (r.matchdayRetainedCents < 0 ? " neg" : "")} data-testid="prv-row-retained" data-cents={r.matchdayRetainedCents}>
                      {r.reconciles ? fmtCents(r.matchdayRetainedCents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid="prv-total-row">
                  <td>{m.totals.matches} match{m.totals.matches === 1 ? "" : "es"}</td>
                  <td className="n">{m.spotsSold}</td>
                  <td className="n" data-testid="prv-total-gross" data-cents={m.totals.grossCents}>{fmtCents(m.totals.grossCents)}</td>
                  <td className="n">{fmtCents(m.totals.fieldRentalCents)}</td>
                  <td className="n">{fmtCents(m.totals.matchManagerCents)}</td>
                  <td className={"n" + (m.totals.poolCents < 0 ? " neg" : "")}>{fmtCents(m.totals.poolCents)}</td>
                  <td className="n b" data-testid="prv-total-share" data-cents={m.totals.partnerProfitShareCents}>{fmtCents(m.totals.partnerProfitShareCents)}</td>
                  <td className={"n" + (m.totals.matchdayProfitShareCents < 0 ? " neg" : "")}>{fmtCents(m.totals.matchdayProfitShareCents)}</td>
                  <td className="n b" data-testid="prv-total-partner" data-cents={m.totals.partnerTotalCents}>{fmtCents(m.totals.partnerTotalCents)}</td>
                  <td className={"n" + (m.totals.matchdayRetainedCents < 0 ? " neg" : "")} data-testid="prv-total-retained" data-cents={m.totals.matchdayRetainedCents}>{fmtCents(m.totals.matchdayRetainedCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* THE RECONCILIATION, SHOWN. This line is the reason the retained figure is on the page
              at all: without it the split is a number the partner has to take on trust. */}
          <p className="prv-recon" data-testid="prv-reconciliation" data-holds={m.totals.reconciles ? "true" : "false"}>
            {fmtCents(m.totals.partnerTotalCents)} to you + {fmtCents(m.totals.matchdayRetainedCents)} kept by MatchDay
            + {fmtCents(m.totals.matchManagerCents)} to match managers = <b>{fmtCents(m.totals.grossCents)}</b> collected.
            {m.totals.matchdayRetainedCents < 0 && (
              <span className="prv-note"> MatchDay retained is negative this period: matches that did not clear their costs still paid you the full rental.</span>
            )}
          </p>
        </section>
      ))}
    </div>
  );
}

function Metric({ k, v, sub, testid }: { k: string; v: number; sub?: string; testid: string }) {
  return (
    <div className="prv-metric" data-testid={testid} data-value={v}>
      <span className="prv-mk">{k}</span>
      <span className="prv-mv">{v}</span>
      {sub && <span className="prv-ms">{sub}</span>}
    </div>
  );
}

const CSS = `
.prv{--ink:#0e1a13;--ink2:#3d5349;--ink3:#5c7168;--line:#dde6e1;--line2:#cbd8d1;--card:#fff;--grn:#146c43;--red:#a4231e;
  font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);
  max-width:1180px;margin:0 auto;padding:22px 18px 60px}
.prv *{box-sizing:border-box}
.prv-head h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0}
.prv-sub{margin:4px 0 0;color:var(--ink3);font-size:13px}
.prv-broken{margin:18px 0;padding:14px 16px;border:1px solid #e0a49a;border-left:4px solid var(--red);border-radius:11px;background:#fdf3f1;display:flex;flex-direction:column;gap:6px}
.prv-broken b{color:#7a1c14;font-size:14px}
.prv-broken span{font-size:12.5px;line-height:1.55;color:#6b2019}
.prv-terms{margin:20px 0;padding:15px 17px;border:1px solid var(--line);border-radius:12px;background:#f7faf8}
.prv-terms h2{font-size:11px;font-weight:800;letter-spacing:.12em;color:var(--ink3);margin:0 0 10px}
.prv-terms ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
.prv-terms li{font-size:13.5px;line-height:1.5}
.prv-break{margin:12px 0 0;padding:10px 12px;border-radius:9px;background:#eef7f1;border:1px solid #a9d3ba;font-size:13px;line-height:1.5}
.prv-break b{font-weight:800;color:#14512f}
.prv-empty{color:var(--ink3);padding:20px 0}
.prv-month{margin:26px 0 0;border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:hidden}
.prv-mhead{display:flex;align-items:baseline;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line);background:#fafcfb;flex-wrap:wrap}
.prv-mhead h2{font-size:17px;font-weight:800;margin:0;letter-spacing:-.01em}
.prv-owed{margin-left:auto;font-size:19px;font-weight:800;color:var(--grn);font-variant-numeric:tabular-nums}
.prv-owed i{font-style:normal;font-size:11px;font-weight:700;color:var(--ink3);letter-spacing:.06em;margin-left:6px}
.prv-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border-bottom:1px solid var(--line)}
.prv-metric{background:var(--card);padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-width:0}
.prv-mk{font-size:9.5px;font-weight:800;letter-spacing:.11em;color:var(--ink3)}
.prv-mv{font-size:24px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.prv-ms{font-size:10.5px;color:var(--ink3)}
/* the table is the one thing allowed to scroll sideways, inside its own container */
.prv-scroll{overflow-x:auto}
.prv-table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:820px}
.prv-table th,.prv-table td{padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
.prv-table th{font-size:9.5px;font-weight:800;letter-spacing:.08em;color:var(--ink3);background:#fafcfb}
.prv-table td.n,.prv-table th.n{text-align:right;font-variant-numeric:tabular-nums}
.prv-table td.b{font-weight:800}
.prv-table td.neg{color:var(--red)}
.prv-when{color:var(--ink2)}
.prv-cellerr{color:var(--red);font-weight:800;font-size:11px}
.prv-table tfoot td{border-top:2px solid var(--line2);border-bottom:0;font-weight:700;background:#fafcfb}
.prv-recon{margin:0;padding:12px 16px;font-size:12.5px;line-height:1.55;color:var(--ink2);background:#f7faf8;border-top:1px solid var(--line)}
.prv-recon b{font-weight:800;color:var(--ink)}
.prv-note{display:block;margin-top:5px;color:var(--ink3)}
@media (max-width:720px){
  .prv{padding:16px 12px 50px}
  .prv-head h1{font-size:21px}
  .prv-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  .prv-mv{font-size:20px}
  .prv-owed{margin-left:0;width:100%}
}
`;
