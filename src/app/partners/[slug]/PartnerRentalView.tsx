"use client";

// The RENTAL_PLUS_PROFIT_SHARE partner dashboard — built to docs/mockups/partner-v3_2.html.
//
// PUBLIC AND UNAUTHENTICATED, like every partner dashboard: the slug is the access grant.
//
// WHAT V3 CHANGED, and why each one exists:
//
//   AN OPEN MONTH IS NOT A BILL. The headline says SO FAR while a month is open and never OWED,
//   and it states both when the month closes and when it pays. The money side of this shipped in
//   8d1f4e2 (only played matches reach a total); this is the half the partner reads.
//
//   THE GREEN BOX CARRIES BOTH HALVES. "you take 40%" was half the deal — the rental is the other
//   half and it was a footnote. The box is the whole answer in six words, and it is the largest
//   type in the block.
//
//   THE TOTAL COLUMN TAKES THE PARTNER'S NAME and wins the row: it is the only column they act on.
//   Driven off the partner record, never hardcoded — the next venue has a different name.
//
//   "MATCHDAY RETAINED" IS GONE. retained = pool − partner share, and partner share is 40% of
//   pool, so retained was always the same 60% already printed as "MatchDay share". Two columns
//   algebraically incapable of disagreeing is one column and a distraction. The reconciliation
//   line still prints the retained FIGURE, because that identity is what makes the split credible
//   and it is the one place the number is load-bearing.
//
//   MOBILE IS A FIRST-CLASS LAYOUT, not a scrolled table. This page is a link a venue owner opens
//   on a phone. Both layouts render from the SAME month objects, so the figures cannot disagree.
//
// NO EXPLANATORY PROSE. Where a row or a chip states a thing, the sentence repeating it is cut.

import { useState } from "react";
import type { RentalDashboardProps, RentalMonth } from "@/lib/partnerRentalDashboard";
import { fmtCents, PERIOD_STATUS_LABEL } from "@/lib/partnerPayoutModel";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// YMD → "Wed, Aug 5" / "September 5, 2026". Parsed as UTC parts and formatted by hand: these are
// plain calendar dates, and running them through a local Date is how a date lands a day early.
const ymdParts = (ymd: string) => ({ y: Number(ymd.slice(0, 4)), m: Number(ymd.slice(5, 7)), d: Number(ymd.slice(8, 10)) });
const longDate = (ymd: string) => { const { y, m, d } = ymdParts(ymd); return `${MONTHS_SHORT[m - 1]}ember`.slice(0, 0) + `${["January","February","March","April","May","June","July","August","September","October","November","December"][m - 1]} ${d}, ${y}`; };
const shortDate = (ymd: string) => { const { y, m, d } = ymdParts(ymd); return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`; };
const dayLabel = (ymd: string) => {
  const { y, m, d } = ymdParts(ymd);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS_SHORT[m - 1]} ${d}`;
};
const closesLabel = (ymd: string) => { const { m, d } = ymdParts(ymd); return `${MONTHS_SHORT[m - 1]} ${d}`; };

// THE ADMIN HALF, PASSED IN — never inferred, never toggled by CSS.
//
// The public partner link is UNAUTHENTICATED BY DESIGN: anyone holding the URL loads this
// component. So the write controls must not exist in its markup at all — hiding them with
// `display:none` would ship Mark paid and Undo to every partner and rely on them not opening dev
// tools. `admin` is omitted by the public route (src/app/partners/[slug]/page.tsx), so the whole
// payments card is absent from the tree rather than hidden in it.
//
// The server side of the same statement: POST /api/partner-dashboards is authenticateAdmin-gated,
// so even a hand-made request from a partner link is refused. The prop is the UI half of a rule
// enforced in two places.
export type RentalAdmin = {
  partnerId: string;
  busy?: boolean;
  onMark: (partnerId: string, periodKey: string, action: "paid" | "unpaid") => void;
};

export default function PartnerRentalView(p: RentalDashboardProps & { admin?: RentalAdmin }) {
  // THE HEADLINE MONTH is the newest one — months are already sorted newest first.
  const current: RentalMonth | undefined = p.months[0];
  const totalHead = `${p.partnerName} total`;

  return (
    <div className="prv" data-testid="partner-rental">
      <style>{CSS}</style>

      <div className="prv-page">
        <header className="prv-mast">
          <h1 data-testid="prv-partner">{p.partnerName}</h1>
          <p className="prv-sub">{p.venue} · monthly payout</p>
        </header>

        {/* THE ARITHMETIC MUST PROVE ITSELF. A page that cannot says so instead of printing
            figures nobody can trust. */}
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

        {current && (
          <section className="prv-pay" data-testid="prv-pay">
            <div className="prv-pay-l">
              {/* ONE OF THE FOUR FIGURES THAT MUST AGREE. */}
              <div className="prv-amt" data-testid="prv-headline" data-cents={current.totals.partnerTotalCents}>
                {fmtCents(current.totals.partnerTotalCents)}
              </div>
              <div className="prv-for">
                for <b>{current.label}</b> · {current.totals.matches} match{current.totals.matches === 1 ? "" : "es"} played
                {/* SO FAR, NEVER OWED, while the month is open. */}
                {current.open && <span className="prv-sofar" data-testid="prv-sofar">so far</span>}
              </div>
            </div>
            <div className="prv-when" data-testid="prv-when">
              <div className="prv-when-lb">{current.open ? "First payment" : "Payment"}</div>
              <div className="prv-when-dt" data-testid="prv-paydate">{longDate(current.paysYmd)}</div>
              <div className="prv-when-nt">
                {current.open
                  ? <>{current.label.split(" ")[0]} closes {closesLabel(current.closesYmd)} · then the 5th of each month</>
                  : <>closed {closesLabel(current.closesYmd)}</>}
              </div>
            </div>
          </section>
        )}

        {/* HOW IT WORKS — the formula strip, the green box, and one line of guarantee. Every figure
            is read from the partner's own record; none is written into the page. */}
        <section className="prv-how" data-testid="prv-how">
          <div className="prv-how-lb">How your payout works</div>
          <div className="prv-f">
            <span className="prv-tok">Match revenue</span>
            <span className="prv-op">−</span><span className="prv-tok prv-cost">{fmtCents(p.params.fieldRentalCents)} field rental</span>
            <span className="prv-op">−</span><span className="prv-tok prv-cost">{fmtCents(p.params.matchManagerCents)} match manager</span>
            <span className="prv-op">=</span><span className="prv-tok">profit pool</span>
          </div>
          <div className="prv-f prv-f2">
            <span className="prv-tok">You get</span>
            {/* BOTH HALVES OF THE DEAL, and the largest type in the block. */}
            <span className="prv-green" data-testid="prv-green">
              {fmtCents(p.params.fieldRentalCents)} rental + {p.params.partnerSharePct}% of the pool
            </span>
          </div>
          <div className="prv-gtee" data-testid="prv-guarantee">
            <span><b>The {fmtCents(p.params.fieldRentalCents)} rental is yours on every match played</b>, whatever the turnout.</span>
            {/* BREAKEVEN IN DOLLARS, not spots. The old "14 spots at $15.00" assumed full price;
                realised August revenue was $12.70 a spot, so the true figure was 16. Stating the
                cost is exact and independent of what a spot actually sold for. */}
            <span data-testid="prv-breakeven" data-cents={p.params.fieldRentalCents + p.params.matchManagerCents}>
              <b>Below {fmtCents(p.params.fieldRentalCents + p.params.matchManagerCents)} of revenue</b> there is no profit share and MatchDay absorbs the loss.
            </span>
          </div>
        </section>

        {p.months.length === 0 && <p className="prv-empty" data-testid="prv-empty">No matches yet.</p>}

        {/* ── PAYMENTS (ADMIN ONLY) ───────────────────────────────────────────────────────
            Same shape as the other partner dashboards: one row per period with its amount and
            state, Mark paid / Undo per row, an "N settled · N awaiting" count, and everything
            already settled collapsed behind a Show toggle. Rendered ONLY when `admin` is passed. */}
        {p.admin && <PaymentsCard months={p.months} admin={p.admin} />}

        {/* ── EVERY MONTH ────────────────────────────────────────────────────────────────── */}
        {p.months.length > 0 && (
          <>
            <div className="prv-blk">
              <div className="prv-h">Every month</div>
              <div className="prv-p">A month closes on its last day and is paid on the 5th of the next.</div>
            </div>

            {/* DESKTOP: the period table. Same left-hand shape as the other partner's page. */}
            <div className="prv-scroll prv-deskonly">
              <table className="prv-tbl" data-testid="prv-periods">
                <thead>
                  <tr>
                    <th>Period</th><th className="n">Matches</th><th className="n">Spots</th>
                    <th className="n">Players</th><th className="n">Revenue</th>
                    <th className="n tot">{totalHead}</th>
                    <th className="l">Status</th><th className="n">When</th>
                  </tr>
                </thead>
                <tbody>
                  {p.months.map((m) => (
                    <tr key={m.ym} data-testid="prv-period-row" data-ym={m.ym}>
                      <td className="prv-first">{m.label}</td>
                      <td className="n">{m.totals.matches}</td>
                      <td className="n">{m.spotsSold}</td>
                      <td className="n">{m.distinctPlayers}</td>
                      <td className="n dim">{fmtCents(m.totals.grossCents)}</td>
                      {/* ONE OF THE FOUR FIGURES THAT MUST AGREE. */}
                      <td className="n tot" data-testid="prv-period-total" data-cents={m.totals.partnerTotalCents}>
                        {fmtCents(m.totals.partnerTotalCents)}
                      </td>
                      <td className="l"><StatusChip m={m} /></td>
                      <td className="n dim" data-testid="prv-period-when">
                        {m.open
                          ? `Closes ${closesLabel(m.closesYmd)} · pays ${closesLabel(m.paysYmd)}`
                          : shortDate(m.paysYmd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* PHONE: a first-class list, not a scrolled table. */}
            <div className="prv-mobonly" data-testid="prv-periods-mobile">
              {p.months.map((m) => (
                <div className="prv-pm" key={m.ym} data-testid="prv-period-card" data-ym={m.ym}>
                  <div className="prv-pm-l">
                    <div className="prv-pm-pd">{m.label}</div>
                    <div className="prv-pm-nt">{m.totals.matches} played · {m.spotsSold} spots</div>
                  </div>
                  <div className="prv-pm-r">
                    {/* ONE OF THE FOUR FIGURES THAT MUST AGREE — the phone's copy of it. */}
                    <div className="prv-pm-v" data-testid="prv-period-total-mobile" data-cents={m.totals.partnerTotalCents}>
                      {fmtCents(m.totals.partnerTotalCents)}
                    </div>
                    <div className="prv-pm-c"><StatusChip m={m} /></div>
                  </div>
                </div>
              ))}
              {current && (
                <div className="prv-schednote">
                  Closes {closesLabel(current.closesYmd)} · pays {closesLabel(current.paysYmd)}.
                  {current.scheduled.length > 0 && (
                    <> <b>{dayLabel(current.scheduled[0].startYmd)} {current.scheduled.length > 1 ? `and ${current.scheduled.length - 1} more are` : "is"} scheduled and not counted yet.</b></>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── MONTH DETAIL ──────────────────────────────────────────────────────────────── */}
        {p.months.map((m) => (
          <section className="prv-month" data-testid="prv-month" data-ym={m.ym} key={m.ym}>
            <div className="prv-blk">
              <div className="prv-h">{m.label} · match by match</div>
            </div>

            <div className="prv-metrics" data-testid="prv-metrics">
              {/* THE TILES SUM: players = new + returning, and repeat visits explain the gap to
                  spots without a second tile repeating a number already on screen. */}
              <Metric k="SPOTS SOLD" v={m.spotsSold} testid="prv-spots" />
              <Metric k="PLAYERS" v={m.distinctPlayers} testid="prv-players"
                sub={`distinct people · ${m.repeatVisits} repeat visit${m.repeatVisits === 1 ? "" : "s"}`} />
              <Metric k="RETURNING" v={m.returning} testid="prv-returning"
                sub={m.returning === 0 ? `the other ${m.distinctPlayers} were new to ${p.venue}` : `of ${m.distinctPlayers} players`} />
              <Metric k="MATCHES" v={m.totals.matches} testid="prv-matches" />
            </div>

            <div className="prv-scroll">
              <table className="prv-tbl" data-testid="prv-table">
                <thead>
                  <tr>
                    <th>Match</th><th className="n">Spots</th><th className="n">Revenue</th>
                    <th className="n">Field rental</th><th className="n">Match manager</th><th className="n">Profit pool</th>
                    <th className="n">Your {p.params.partnerSharePct}%</th><th className="n">MatchDay share</th>
                    <th className="n tot" data-testid="prv-total-head">{totalHead}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.rows.map((r) => (
                    <tr key={r.matchApiId} data-testid="prv-row" data-match={r.matchApiId} data-reconciles={r.reconciles ? "true" : "false"}>
                      <td className="prv-first">{dayLabel(r.startYmd)}</td>
                      <td className="n" data-testid="prv-row-spots">{r.spotsSold}</td>
                      <td className="n dim" data-testid="prv-row-gross" data-cents={r.grossCents}>{fmtCents(r.grossCents)}</td>
                      <td className="n dim">{fmtCents(r.fieldRentalCents)}</td>
                      <td className="n dim">{fmtCents(r.matchManagerCents)}</td>
                      <td className={"n dim" + (r.poolCents < 0 ? " neg" : "")} data-testid="prv-row-pool" data-cents={r.poolCents}>{fmtCents(r.poolCents)}</td>
                      <td className="n" data-testid="prv-row-share" data-cents={r.partnerProfitShareCents}>{fmtCents(r.partnerProfitShareCents)}</td>
                      <td className={"n dim" + (r.matchdayProfitShareCents < 0 ? " neg" : "")} data-testid="prv-row-mdshare" data-cents={r.matchdayProfitShareCents}>{fmtCents(r.matchdayProfitShareCents)}</td>
                      {/* A row that fails the identity NEVER shows a total — it shows why. */}
                      <td className="n tot" data-testid="prv-row-total" data-cents={r.partnerTotalCents}>
                        {r.reconciles ? fmtCents(r.partnerTotalCents) : <span className="prv-cellerr" data-testid="prv-row-error">does not reconcile</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="prv-total-row">
                    <td className="prv-first">{m.totals.matches} match{m.totals.matches === 1 ? "" : "es"} played</td>
                    <td className="n" data-testid="prv-total-spots">{m.spotsSold}</td>
                    <td className="n" data-testid="prv-total-gross" data-cents={m.totals.grossCents}>{fmtCents(m.totals.grossCents)}</td>
                    <td className="n">{fmtCents(m.totals.fieldRentalCents)}</td>
                    <td className="n">{fmtCents(m.totals.matchManagerCents)}</td>
                    <td className={"n" + (m.totals.poolCents < 0 ? " neg" : "")}>{fmtCents(m.totals.poolCents)}</td>
                    <td className="n" data-testid="prv-total-share" data-cents={m.totals.partnerProfitShareCents}>{fmtCents(m.totals.partnerProfitShareCents)}</td>
                    <td className={"n" + (m.totals.matchdayProfitShareCents < 0 ? " neg" : "")}>{fmtCents(m.totals.matchdayProfitShareCents)}</td>
                    {/* ONE OF THE FOUR FIGURES THAT MUST AGREE, and the largest number in the footer. */}
                    <td className="n tot" data-testid="prv-total-partner" data-cents={m.totals.partnerTotalCents}>{fmtCents(m.totals.partnerTotalCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* SCHEDULED — listed, greyed, explicitly not counted. Hiding them would be a different
                lie from billing for them; the row states its own status, so no sentence explains it. */}
            {m.scheduled.length > 0 && (
              <div className="prv-scroll">
                <table className="prv-tbl prv-sched" data-testid="prv-scheduled">
                  <tbody>
                    {m.scheduled.map((r) => (
                      <tr key={r.matchApiId} data-testid="prv-sched-row" data-match={r.matchApiId}>
                        <td className="prv-first">{dayLabel(r.startYmd)}</td>
                        <td className="l" colSpan={7}>Scheduled · not played yet</td>
                        <td className="n tot prv-notcounted" data-testid="prv-sched-total">not counted</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* THE RECONCILIATION. The one place the retained FIGURE is load-bearing: without it the
                split is a number the partner has to take on trust. The retained COLUMN is gone. */}
            <p className="prv-recon" data-testid="prv-reconciliation" data-holds={m.totals.reconciles ? "true" : "false"}>
              {fmtCents(m.totals.partnerTotalCents)} to you + {fmtCents(m.totals.matchdayRetainedCents)} kept by MatchDay
              + {fmtCents(m.totals.matchManagerCents)} to match managers = <b>{fmtCents(m.totals.grossCents)}</b> collected.
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}

function PaymentsCard({ months, admin }: { months: RentalMonth[]; admin: RentalAdmin }) {
  const [showEarlier, setShowEarlier] = useState(false);
  // A period is ACTIONABLE when it has closed and is not already paid — an open month has no final
  // figure, so it gets no button rather than a disabled one that invites a click.
  const settled = months.filter((m) => m.status === "paid");
  const awaiting = months.filter((m) => m.status === "due");
  const rest = months.filter((m) => m.status !== "paid");
  const earlier = settled;

  return (
    <section className="prv-pays" data-testid="prv-payments">
      <div className="prv-pays-hd">
        <span className="prv-h">Payments</span>
        <span className="prv-pays-count" data-testid="prv-pays-count">
          {settled.length} settled · {awaiting.length} awaiting
        </span>
      </div>

      {rest.map((m) => (
        <div className="prv-pay-row" key={m.ym} data-testid="prv-pay-row" data-ym={m.ym} data-status={m.status}>
          <div>
            <div className="prv-pay-pd">{m.label}</div>
            <div className="prv-pay-nt">
              {m.status === "in_progress" ? `Closes ${m.closesYmd} · no final figure yet` : `Closed ${m.closesYmd}`}
            </div>
          </div>
          <div className="prv-pay-r">
            <span className="prv-pay-amt">{fmtCents(m.totals.partnerTotalCents)}</span>
            <StatusChip m={m} />
            {/* Only a CLOSED, UNPAID period can be marked. The server enforces this too. */}
            {m.status === "due" && (
              <button type="button" className="prv-btn go" data-testid="prv-mark-paid" disabled={admin.busy}
                onClick={() => admin.onMark(admin.partnerId, m.periodKey, "paid")}>Mark paid</button>
            )}
          </div>
        </div>
      ))}

      {earlier.length > 0 && (
        <>
          <button type="button" className="prv-showmore" data-testid="prv-show-earlier"
            onClick={() => setShowEarlier((v) => !v)}>
            {showEarlier ? "Hide" : "Show"} {earlier.length} earlier payment{earlier.length === 1 ? "" : "s"}
            {" "}{fmtCents(earlier.reduce((s, m) => s + m.totals.partnerTotalCents, 0))}
          </button>
          {showEarlier && earlier.map((m) => (
            <div className="prv-pay-row settled" key={m.ym} data-testid="prv-pay-row" data-ym={m.ym} data-status={m.status}>
              <div>
                <div className="prv-pay-pd">{m.label}</div>
                <div className="prv-pay-nt">{m.paidAt ? `paid ${m.paidAt.slice(0, 10)}` : "paid"}</div>
              </div>
              <div className="prv-pay-r">
                <span className="prv-pay-amt">{fmtCents(m.totals.partnerTotalCents)}</span>
                <StatusChip m={m} />
                {/* UNDO IS A REVERSAL, not an erasure — the server sets the row back to pending and
                    logs it; the change_log keeps the fact that it was once marked. */}
                <button type="button" className="prv-btn" data-testid="prv-undo" disabled={admin.busy}
                  onClick={() => admin.onMark(admin.partnerId, m.periodKey, "unpaid")}>Undo</button>
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function StatusChip({ m }: { m: RentalMonth }) {
  // Every state here is READ FROM THE LEDGER or derived from the period's own dates — including
  // Paid, which comes from partner_weekly_payments. An earlier version of this file claimed Paid
  // could never render because nothing recorded it; that was wrong, and the table has existed
  // since migration 0003.
  const cls = m.status === "paid" ? "paid" : m.status === "in_progress" ? "prog" : m.status === "due" ? "due" : "none";
  return (
    <span className={`prv-chip ${cls}`} data-testid="prv-status" data-status={m.status}>
      {PERIOD_STATUS_LABEL[m.status]}
      {m.status === "paid" && m.paidAt && <i className="prv-chip-dt"> {m.paidAt.slice(0, 10)}</i>}
    </span>
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
.prv{--ink:#0e1f16;--ink2:#5b7568;--ink3:#93a89c;--line:#e4eae6;--line2:#eff3f0;--bg:#f2f5f3;
  --panel:#fff;--grn:#15803d;--grn2:#166534;--grnbg:#effaf3;--grnln:#c8ead6;--red:#a8321f;
  --blu:#1d4ed8;--blubg:#eef2ff;--blln:#c7d2fe;--amb:#8a5a00;--ambbg:#fdf6e7;--ambln:#f0dfb4;
  font:15px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:var(--ink);background:var(--bg);min-height:100vh;padding:26px 20px 70px}
.prv *{box-sizing:border-box}
.prv-page{max-width:1250px;margin:0 auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.prv-mast{padding:22px 26px 20px;border-bottom:1px solid var(--line)}
.prv-mast h1{margin:0;font-size:27px;font-weight:800;letter-spacing:-.02em}
.prv-sub{color:var(--ink2);font-size:14px;margin:3px 0 0}
.prv-broken{margin:16px 26px;padding:14px 16px;border:1px solid #e0a49a;border-left:4px solid var(--red);border-radius:11px;background:#fdf3f1;display:flex;flex-direction:column;gap:6px}
.prv-broken b{color:#7a1c14;font-size:14px}
.prv-broken span{font-size:12.5px;line-height:1.55;color:#6b2019}

.prv-pay{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;
  padding:22px 26px 23px;background:var(--grnbg);border-bottom:1px solid var(--grnln)}
.prv-amt{font-size:44px;font-weight:800;color:var(--grn2);letter-spacing:-.025em;line-height:1;font-variant-numeric:tabular-nums}
.prv-for{font-size:14px;color:var(--ink2);margin-top:7px}
.prv-for b{color:var(--ink);font-weight:700}
.prv-when{text-align:right;flex:none}
.prv-when-lb{font-size:10.5px;letter-spacing:.09em;font-weight:800;color:var(--grn);text-transform:uppercase}
.prv-when-dt{font-size:20px;font-weight:800;margin-top:4px;letter-spacing:-.01em}
.prv-when-nt{font-size:12.5px;color:var(--ink2);margin-top:3px}
.prv-sofar{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;
  color:var(--blu);background:var(--blubg);border:1px solid var(--blln);border-radius:999px;padding:3px 9px;margin-left:10px;vertical-align:middle}

.prv-how{padding:18px 26px 19px;border-bottom:1px solid var(--line)}
.prv-how-lb{font-size:10.5px;letter-spacing:.09em;font-weight:800;color:var(--ink3);text-transform:uppercase;margin-bottom:11px}
.prv-f{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:15px}
.prv-f2{margin-top:11px}
.prv-tok{font-weight:700;white-space:nowrap}
.prv-op{color:var(--ink3);font-weight:700}
.prv-cost{color:var(--ink2)}
.prv-green{background:var(--grn2);color:#fff;padding:6px 14px;border-radius:8px;font-weight:800;white-space:nowrap;font-size:15.5px}
.prv-gtee{margin-top:12px;font-size:13.5px;color:var(--ink2)}
.prv-gtee span{display:inline;margin-right:22px}
.prv-gtee b{color:var(--ink);font-weight:700}

.prv-blk{padding:19px 26px 8px;border-top:1px solid var(--line)}
.prv-h{font-size:10.5px;letter-spacing:.1em;font-weight:800;color:var(--ink3);text-transform:uppercase}
.prv-p{font-size:13px;color:var(--ink2);margin-top:5px}

.prv-scroll{overflow-x:auto}
.prv-tbl{width:100%;border-collapse:collapse}
.prv-tbl thead th{font-size:10.5px;letter-spacing:.06em;font-weight:800;color:var(--ink3);text-transform:uppercase;
  text-align:right;padding:12px 14px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.prv-tbl thead th:first-child{text-align:left;padding-left:26px}
.prv-tbl thead th.l{text-align:left;padding-left:22px}
.prv-tbl tbody td{padding:12px 14px;text-align:right;font-size:14px;font-variant-numeric:tabular-nums;border-bottom:1px solid var(--line2);white-space:nowrap}
.prv-tbl tbody td.prv-first{text-align:left;padding-left:26px;font-weight:600}
.prv-tbl tbody td.l{text-align:left;padding-left:22px}
.prv-tbl .dim{color:var(--ink2)}
.prv-tbl .neg{color:var(--red)}
/* THE PARTNER'S COLUMN — tinted, larger and bolder than every other cell. It is the only column
   they act on, so it wins the row. */
.prv-tbl td.tot{background:var(--grnbg);font-size:17px;font-weight:800;color:var(--grn2);
  border-left:1px solid var(--grnln);border-right:1px solid var(--grnln)}
.prv-tbl th.tot{color:var(--grn2);background:var(--grnbg);border-left:1px solid var(--grnln);border-right:1px solid var(--grnln)}
.prv-tbl tfoot td{padding:14px;text-align:right;font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;
  border-top:2px solid var(--ink);background:#fbfdfc;white-space:nowrap}
.prv-tbl tfoot td.prv-first{text-align:left;padding-left:26px}
.prv-tbl tfoot td.tot{font-size:21px;background:#dff3e7;border-top:2px solid var(--grn2)}
.prv-cellerr{color:var(--red);font-weight:800;font-size:11px}

.prv-sched td{background:#f7f9f8;color:var(--ink3)}
.prv-sched td.prv-first{font-weight:600;color:var(--ink2)}
.prv-notcounted{background:#f4f6f5 !important;color:var(--ink3) !important;font-size:14px !important;border-color:var(--line) !important}
.prv-schednote{padding:11px 26px 18px;font-size:12.5px;color:var(--ink2)}
.prv-schednote b{color:var(--ink)}

.prv-chip{display:inline-block;font-size:11.5px;font-weight:800;border-radius:999px;padding:4px 11px;white-space:nowrap}
.prv-chip.prog{color:var(--blu);background:var(--blubg);border:1px solid var(--blln)}
.prv-chip.due{color:var(--amb);background:var(--ambbg);border:1px solid var(--ambln)}
.prv-chip.none{color:var(--ink2);background:#f4f6f5;border:1px solid var(--line)}
.prv-chip.paid{color:var(--grn);background:var(--grnbg);border:1px solid var(--grnln)}
.prv-chip-dt{font-style:normal;font-weight:700;opacity:.75;margin-left:2px}

/* ADMIN ONLY — this whole block is absent from the public page's markup, not hidden in it. */
.prv-pays{border-top:1px solid var(--line);background:#fbfdfc}
.prv-pays-hd{display:flex;align-items:baseline;gap:10px;padding:19px 26px 10px}
.prv-pays-count{margin-left:auto;font-size:12.5px;color:var(--ink2);font-weight:700}
.prv-pay-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 26px;border-top:1px solid var(--line2)}
.prv-pay-row.settled{background:#f7f9f8}
.prv-pay-pd{font-weight:800;font-size:14.5px}
.prv-pay-nt{font-size:12px;color:var(--ink2);margin-top:2px}
.prv-pay-r{display:flex;align-items:center;gap:10px;flex:none}
.prv-pay-amt{font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--grn2)}
.prv-btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 13px;font:inherit;font-size:12.5px;font-weight:700;color:var(--ink);cursor:pointer;min-height:34px}
.prv-btn:disabled{opacity:.45;cursor:not-allowed}
/* the ONE filled-dark button — Mark paid is the single thing to do here */
.prv-btn.go{background:#003326;border-color:#003326;color:#fff}
.prv-showmore{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--line2);background:transparent;padding:11px 26px;font:inherit;font-size:12.5px;font-weight:700;color:var(--ink2);cursor:pointer}

.prv-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);
  border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.prv-metric{background:var(--panel);padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-width:0}
.prv-mk{font-size:9.5px;font-weight:800;letter-spacing:.11em;color:var(--ink3)}
.prv-mv{font-size:24px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.prv-ms{font-size:10.5px;color:var(--ink3)}
.prv-recon{margin:0;padding:12px 26px 18px;font-size:12.5px;line-height:1.55;color:var(--ink2);background:#f7faf8;border-top:1px solid var(--line)}
.prv-recon b{font-weight:800;color:var(--ink)}
.prv-empty{color:var(--ink3);padding:20px 26px}

/* the phone period list — hidden above the breakpoint */
.prv-mobonly{display:none}
.prv-pm{padding:12px 17px;border-bottom:1px solid var(--line2);display:flex;justify-content:space-between;align-items:center;gap:12px}
.prv-pm-pd{font-weight:800;font-size:15px}
.prv-pm-nt{font-size:12px;color:var(--ink2);margin-top:2px}
.prv-pm-r{text-align:right;flex:none}
.prv-pm-v{font-size:19px;font-weight:800;color:var(--grn2);font-variant-numeric:tabular-nums}
.prv-pm-c{margin-top:4px}

/* ── PHONE: a first-class layout, not an adapted table ─────────────────────────────────────── */
@media (max-width:720px){
  .prv{padding:0}
  .prv-page{border-radius:0;border-left:0;border-right:0}
  .prv-mast{padding:17px 17px 15px}
  .prv-mast h1{font-size:22px}
  /* the pay band stacks: the amount, then when it pays under a rule */
  .prv-pay{display:block;padding:17px}
  .prv-amt{font-size:37px}
  .prv-when{text-align:left;margin-top:14px;padding-top:13px;border-top:1px solid var(--grnln)}
  .prv-when-dt{font-size:18px}
  .prv-how{padding:15px 17px 16px}
  .prv-f{font-size:13.5px;gap:7px}
  .prv-green{font-size:14px}
  .prv-gtee span{display:block;margin-right:0}
  .prv-gtee span + span{margin-top:5px}
  .prv-blk{padding:15px 17px 6px}
  /* the period TABLE is replaced, not scrolled */
  .prv-deskonly{display:none}
  .prv-mobonly{display:block}
  .prv-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  .prv-mv{font-size:20px}
  .prv-recon{padding:12px 17px 16px}
  .prv-schednote{padding:11px 17px 15px}
  /* the match-by-match table stays a table — it is genuinely tabular — but scrolls inside its own
     container so the PAGE never scrolls sideways. */
  .prv-tbl{min-width:760px}
  .prv-tbl thead th:first-child,.prv-tbl tbody td.prv-first,.prv-tbl tfoot td.prv-first{padding-left:17px}
}
`;
