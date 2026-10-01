"use client";

/* MEMBERS BY CITY — read-only. There is no write path behind this page and no control on it that
 * acts; the only button copies what is already on screen into a file.
 *
 * ── WHAT THE PAGE IS ALLOWED TO SAY ───────────────────────────────────────────────────────────
 * Title, toolbar, table, one footer line. The sub-labels under the headers and the as-of label
 * are the ENTIRE explanation. No subtitle, no status chip, no paragraphs, no callouts — asserted
 * by members-by-city-test, which reads this file and fails on any sentence outside that set.
 *
 * THE v2 MOCK CARRIES A SUBTITLE AND THIS PAGE DOES NOT. It was built from the mock in d658286 and
 * removed immediately after: the bar states the cutoff and the billing date, so a sentence saying
 * the page is a month-end report is telling the reader what the two dates above it already say.
 * Ryan: "the page needs no explanatory prose."
 *
 * ── THE AS-OF IS THE SYNC INSTANT, NOT THE PAGE LOAD ──────────────────────────────────────────
 * Active moves 4-5 people a day (353 -> 406 over eleven days in August), so a bare number is
 * stale within 48 hours and someone reconciles against a figure that no longer exists — which is
 * exactly what happened to 395. The label is max(synced_at) across the rows actually loaded,
 * because that is what genuinely bounds the numbers: mdapi_subscriptions is written by one nightly
 * cron, and nothing about the page load makes the data any fresher than that write.
 *
 * ── AN EMPTY TABLE MUST NOT LOOK LIKE A WORKING ONE ───────────────────────────────────────────
 * A failed read renders as an ERROR, never as zeros. `?.length ?? 0` turning a swallowed error
 * into a confident zero is the exact shape of bug this page would be worst at showing, since
 * every column's happy answer is a small number.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { selectAll } from "@/lib/supabasePagination";
import { countActiveMembers } from "@/lib/membershipStats";
import {
  buildMembersByCity, membersByCityCsv, dollars, mixLabel, prettyDate, prettyDateShort, reportDatesFor,
  type ByCityRow, type SubscriptionRow,
} from "@/lib/membersByCity";

const COLS = "user_id, status, price, member_email, activation_date, canceled_at, city_identifier, synced_at";

type Loaded = { rows: (SubscriptionRow & { synced_at?: string | null })[]; pulled: number; expected: number | null };

/** "Aug 31, 2026 · 11:00 UTC" — the sync instant, stated in UTC because that is what it is. */
const prettyStamp = (iso: string): string => {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const hm = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day} · ${hm} UTC`;
};

export default function MembersByCityView() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      /* PAGE EXPLICITLY, THEN ASSERT. PostgREST caps every response at 1,000 rows regardless of
       * what is asked for, and the table is 2,700 today. selectAll walks it; the exact head count
       * is read separately and compared, because selectAll's own stop condition (a short page)
       * cannot tell a complete pull from a truncated one. A short pull throws — it does not
       * quietly render a smaller Austin. */
      const head = await supabase.from("mdapi_subscriptions").select("user_id", { count: "exact", head: true });
      if (head.error) throw new Error(`count failed: ${head.error.message}`);
      const rows = await selectAll<SubscriptionRow & { synced_at?: string | null }>(() =>
        supabase.from("mdapi_subscriptions").select(COLS).order("membership_id"),
      );
      if (head.count != null && rows.length !== head.count) {
        throw new Error(`incomplete pull — got ${rows.length} of ${head.count} rows`);
      }
      setLoaded({ rows, pulled: rows.length, expected: head.count });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoaded(null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const view = useMemo(() => {
    if (!loaded) return null;
    /* ONE INSTANT, USED TWICE. The table and the equality check below are computed from the same
     * Date so the page's Active cannot drift from what countActiveMembers would say. Never assert
     * against a literal: 395 was a literal, and it was a number the count merely passed through. */
    const asOf = new Date();
    /* THE DATES COME FROM THAT INSTANT AND FROM NOWHERE ELSE. Not a constant, not localStorage,
     * not a query param — there is no branch here that can be handed a date, which is the only way
     * the cutoff cannot be pinned to an old month again. Derived inside this memo, so a visit that
     * spans midnight on the 6th rolls forward on the next load rather than holding what it opened
     * on. */
    const dates = reportDatesFor(asOf);
    const stamps = loaded.rows.map((r) => String(r.synced_at ?? "")).filter(Boolean).sort();
    return {
      dates,
      table: buildMembersByCity(loaded.rows, dates),
      // Home's number, from Home's function, over the same rows at the same instant.
      homeActive: countActiveMembers(loaded.rows, asOf),
      asOfLabel: stamps.length ? prettyStamp(stamps[stamps.length - 1]) : prettyStamp(asOf.toISOString()),
    };
  }, [loaded]);

  const exportCsv = useCallback(() => {
    if (!view) return;
    /* THE SAME `view.dates` THE HEADER AND THE COLUMNS READ, so the file cannot name a different
     * cutoff than the screen it was exported from. */
    const blob = new Blob([membersByCityCsv(view.table, view.asOfLabel, view.dates)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `members-by-city-${view.dates.cutoffYmd}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }, [view]);

  const num = (n: number) => (
    <span className={`mbc-n${n === 0 ? " mbc-zero" : ""}`}>{n.toLocaleString("en-US")}</span>
  );

  /* ONE CELL BUILDER FOR BOTH THE BODY AND THE FOOTER. The MATCHDAY row carries the same five
   * figures in the same order as a city row, so they are emitted from one expression — a total
   * rendered by its own copy of the markup is a total that can disagree with the rows above it.
   *
   * data-col ON EVERY CELL, matching the mock. The columns are named rather than counted, so a
   * column inserted later cannot silently shift what an assertion is reading. */
  const figures = (r: ByCityRow) => (
    <>
      <td data-col="total">{num(r.totalActive)}</td>
      <td data-col="before">{num(r.cancelledBefore)}</td>
      <td className="mbc-hl mbc-big" data-col="paying">{num(r.paying)}</td>
      <td className="mbc-hl mbc-big" data-col="billing">
        <span className="mbc-money">
          {dollars(r.billingCents)}
          <small>{mixLabel(r.mix) || "—"}</small>
        </span>
      </td>
      {/* SET OFF BY A RULE, as in the mock: it is the one column that is not about this charge. */}
      <td className="mbc-grp" data-col="after">{num(r.cancelledAfter)}</td>
    </>
  );

  const bodyRow = (r: ByCityRow) => (
    <tr key={r.code} data-testid={`mbc-row-${r.code.toLowerCase()}`} data-code={r.code}>
      <td className="mbc-l mbc-city-cell">
        <b>{r.city}</b><span>{r.code}</span>
      </td>
      {figures(r)}
    </tr>
  );

  return (
    <div className="mbc">
      <h1>Members by City</h1>

      {err ? (
        <div className="mbc-err" data-testid="mbc-error">
          <b>The query failed — this is NOT an empty table.</b> {err}{" "}
          <button type="button" className="mbc-ghost" onClick={() => void load()}>Retry</button>
        </div>
      ) : loading && !view ? (
        <div className="mbc-state">Loading…</div>
      ) : view ? (
        <div className="mbc-card">
          {/* NO WINDOW PILL AND NO PICKER. Both were removed deliberately: every column's base is
              status ACTIVE TODAY, which is not an as-of quantity, so an earlier cutoff cannot be
              reproduced from this data and a control offering one would render a confident,
              understated month. The dates below are derived from now.
              THE BAR CARRIES THE YEAR; the column labels do not. */}
          <div className="mbc-bar" data-testid="mbc-dates"
            data-cutoff={view.dates.cutoffYmd} data-billing={view.dates.billingYmd} data-runrate={view.dates.runRateYmd}>
            <span className="mbc-kv"><span className="mbc-k">Cutoff</span>
              <span className="mbc-v" data-testid="mbc-cutoff">{prettyDate(view.dates.cutoffYmd)}</span></span>
            <span className="mbc-dot">&middot;</span>
            <span className="mbc-kv"><span className="mbc-k">Bills</span>
              <span className="mbc-v" data-testid="mbc-bills">{prettyDate(view.dates.billingYmd)}</span></span>
            <span className="mbc-asof" data-testid="mbc-asof">As of {view.asOfLabel}</span>
            <span className="mbc-sp" />
            <button type="button" className="mbc-ghost" onClick={exportCsv} data-testid="mbc-export">Export CSV</button>
          </div>

          <div className="mbc-scroll">
            <table data-testid="mbc-table">
              <thead>
                <tr>
                  <th className="mbc-l">City</th>
                  <th data-col="total">Total active<small>status ACTIVE, over $0</small></th>
                  <th data-col="before">Cancelled before {prettyDateShort(view.dates.cutoffYmd)}<small>still active, won&apos;t bill</small></th>
                  <th className="mbc-hl" data-col="paying">Paying members<small>total minus cancelled before</small></th>
                  <th className="mbc-hl" data-col="billing">Billing {prettyDateShort(view.dates.billingYmd)}<small>sum of each member&apos;s price</small></th>
                  <th className="mbc-grp" data-col="after">Cancelled {prettyDateShort(view.dates.cutoffYmd)}+<small>pay {prettyDateShort(view.dates.billingYmd)}, not {prettyDateShort(view.dates.runRateYmd)}</small></th>
                </tr>
              </thead>
              <tbody data-testid="mbc-rows">{view.table.rows.map(bodyRow)}</tbody>
              <tfoot>
                <tr className="mbc-totalrow" data-testid="mbc-row-total">
                  <td className="mbc-l">MATCHDAY</td>
                  {figures(view.table.total)}
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mbc-foot">
            {/* THE UNASSIGNED LINE, AND IT IS NOT A ROW. A member whose city code is not in the map
                cannot be allocated to a city, and folding them into MATCHDAY would make the total
                unreconcilable against the rows above it. Today that is one NYC member at $100 — the
                largest single price on the board, which is exactly the kind of thing that should
                not disappear into a skip. Hidden entirely when there are none. */}
            {view.table.unassigned.members > 0 && (
              <span data-testid="mbc-unassigned"
                data-members={view.table.unassigned.members} data-cents={view.table.unassigned.cents}>
                Not in totals: <b>{view.table.unassigned.members} unassigned member{view.table.unassigned.members === 1 ? "" : "s"}, {dollars(view.table.unassigned.cents)}</b>.
              </span>
            )}
            <span data-testid="mbc-footnote">Excludes $0 members and internal accounts.</span>
          </div>
        </div>
      ) : null}

      <style>{CSS}</style>
    </div>
  );
}

/* Plain <style>, not styled-jsx — and NO backticks anywhere inside, including in comments: a
 * backtick ends the template literal mid-rule and the remainder of the sheet is dropped silently.
 * :global() is also invalid here; ordinary descendant selectors only. */
const CSS = `
.mbc { padding: 24px 28px 80px; max-width: 1440px; }
.mbc h1 { font-size: 28px; letter-spacing: -0.5px; margin: 0 0 18px; font-weight: 800; }
.mbc-card { background: #fff; border: 1px solid var(--line, #e3e7e1); border-radius: 14px; overflow: hidden; }
.mbc-bar { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; padding: 16px 20px; border-bottom: 1px solid #e3e7e1; }
.mbc-kv { display: flex; align-items: baseline; gap: 8px; }
.mbc-k { font-size: 11px; font-weight: 700; letter-spacing: 0.09em; color: #7a8a81; text-transform: uppercase; }
.mbc-v { font-weight: 800; font-size: 15px; }
.mbc-dot { color: #c3cbc6; }
.mbc-sp { flex: 1; }
.mbc-asof { font-size: 13px; color: #7a8a81; white-space: nowrap; }
.mbc-ghost { border: 1px solid #e3e7e1; background: #fff; border-radius: 999px; padding: 8px 16px; font: inherit; font-weight: 700; color: #3c4f44; cursor: pointer; }
.mbc-ghost:hover { background: #f4f7f4; }
.mbc-scroll { overflow-x: auto; }
.mbc table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.mbc th, .mbc td { padding: 14px 12px; text-align: right; white-space: nowrap; border-bottom: 1px solid #eef1ec; }
.mbc th { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: #7a8a81; text-transform: uppercase; vertical-align: bottom; background: #f7f9f6; }
.mbc th small { display: block; font-size: 10.5px; letter-spacing: 0.02em; text-transform: none; font-weight: 500; margin-top: 3px; color: #7a8a81; }
.mbc th.mbc-l, .mbc td.mbc-l { text-align: left; }
.mbc td { font-size: 15px; }
.mbc-city-cell b { display: block; font-weight: 700; }
.mbc-city-cell span { font-size: 12px; color: #7a8a81; }
.mbc th.mbc-hl { background: #d5f2de; color: #14532d; }
.mbc th.mbc-hl small { color: #2f6b45; }
.mbc td.mbc-hl { background: #e3f7e9; }
.mbc td.mbc-big { font-weight: 800; }
/* THE ONE COLUMN THAT IS NOT ABOUT THIS CHARGE, set off by a rule rather than by a colour. */
.mbc .mbc-grp { border-left: 1px solid #e3e7e1; }
.mbc-n { font-weight: 700; }
.mbc-zero { color: #c3cbc6; font-weight: 600; }
.mbc-money { font-weight: 800; }
/* THE MIX IS THE ONLY WRAPPING TEXT IN THE TABLE. Bounded and right-aligned so it stacks under its
   own figure rather than widening the column. */
.mbc-money small { display: block; font-weight: 500; font-size: 11.5px; color: #7a8a81; white-space: normal; max-width: 210px; margin-left: auto; }
.mbc tfoot td { background: #f3f6f2; font-weight: 800; border-top: 2px solid #e3e7e1; border-bottom: 0; }
.mbc tfoot td.mbc-hl { background: #d5f2de; }
.mbc tfoot td.mbc-l { font-weight: 800; font-size: 13px; letter-spacing: 0.06em; }
.mbc-foot { display: flex; gap: 24px; flex-wrap: wrap; padding: 12px 20px 16px; border-top: 1px solid #e3e7e1; color: #7a8a81; font-size: 13px; }
.mbc-foot b { color: #44564c; }
.mbc-state { color: #6e8076; padding: 24px 0; }
.mbc-err { background: #fdece8; border: 1px solid #f3c4b8; color: #8c2c14; border-radius: 9px; padding: 12px 15px; font-size: 13px; }
@media (max-width: 900px) {
  .mbc { padding: 16px 12px 60px; }
  .mbc h1 { font-size: 22px; }
}
`;
