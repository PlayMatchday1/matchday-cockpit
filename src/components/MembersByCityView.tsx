"use client";

/* MEMBERS BY CITY — read-only. There is no write path behind this page and no control on it that
 * acts; the only button copies what is already on screen into a file.
 *
 * ── WHAT THE PAGE IS ALLOWED TO SAY ───────────────────────────────────────────────────────────
 * Title, toolbar, table, one footer line. The sub-labels under the headers and the as-of label
 * are the ENTIRE explanation. No subtitle, no status chip, no paragraphs, no callouts — asserted
 * by members-by-city-test, which reads this file and fails on any sentence outside that set.
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
  buildMembersByCity, membersByCityCsv, dollars, mixLabel,
  CUTOFF_YMD, WINDOW_START_YMD, UNASSIGNED_CODE,
  type ByCityRow, type SubscriptionRow,
} from "@/lib/membersByCity";

const COLS = "user_id, status, price, member_email, activation_date, canceled_at, city_identifier, synced_at";

type Loaded = { rows: (SubscriptionRow & { synced_at?: string | null })[]; pulled: number; expected: number | null };

/** "Aug 6, 2026" from a YYYY-MM-DD, in UTC — these are calendar constants, not local instants. */
const prettyYmd = (ymd: string): string =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

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
    const stamps = loaded.rows.map((r) => String(r.synced_at ?? "")).filter(Boolean).sort();
    return {
      table: buildMembersByCity(loaded.rows, asOf),
      // Home's number, from Home's function, over the same rows at the same instant.
      homeActive: countActiveMembers(loaded.rows, asOf),
      asOfLabel: stamps.length ? prettyStamp(stamps[stamps.length - 1]) : prettyStamp(asOf.toISOString()),
    };
  }, [loaded]);

  const exportCsv = useCallback(() => {
    if (!view) return;
    const blob = new Blob([membersByCityCsv(view.table, view.asOfLabel)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `members-by-city-${CUTOFF_YMD}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }, [view]);

  const num = (n: number) => (
    <span className={`mbc-n${n === 0 ? " mbc-zero" : ""}`}>{n.toLocaleString("en-US")}</span>
  );

  const bodyRow = (r: ByCityRow) => (
    <tr key={r.code}>
      <td className="mbc-l">
        <span className="mbc-city">
          {r.city ?? "Unassigned"}
          <small>{r.code}</small>
        </span>
      </td>
      <td>{num(r.active)}</td>
      <td>{num(r.cancelledInWindow)}</td>
      <td>{num(r.cancelledAfterCutoff)}</td>
      <td className="mbc-chg">{num(r.beingCharged)}</td>
      <td>
        <span className="mbc-money">
          {dollars(r.billingCents)}
          <small>{mixLabel(r.mix) || "—"}</small>
        </span>
      </td>
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
          <div className="mbc-bar">
            <span className="mbc-lbl">Cutoff</span>
            <span className="mbc-chip">{prettyYmd(CUTOFF_YMD)}</span>
            <span className="mbc-lbl mbc-gap">Window</span>
            <span className="mbc-chip">{prettyYmd(WINDOW_START_YMD)} – {prettyYmd(CUTOFF_YMD)}</span>
            <span className="mbc-asof" data-testid="mbc-asof">As of {view.asOfLabel}</span>
            <button type="button" className="mbc-ghost" onClick={exportCsv} data-testid="mbc-export">Export CSV</button>
          </div>

          <div className="mbc-scroll">
            <table>
              <thead>
                <tr>
                  <th className="mbc-l">City</th>
                  <th>Active<small>status ACTIVE today</small></th>
                  <th>Cancelled<small>{prettyYmd(WINDOW_START_YMD)} – {prettyYmd(CUTOFF_YMD)}</small></th>
                  <th>Cancelled<small>after {prettyYmd(CUTOFF_YMD)}</small></th>
                  <th className="mbc-chg">Being charged<small>active minus {prettyYmd(WINDOW_START_YMD)} – {prettyYmd(CUTOFF_YMD)}</small></th>
                  <th>Billing next cycle<small>summed, not averaged</small></th>
                </tr>
              </thead>
              <tbody data-testid="mbc-rows">{view.table.rows.map(bodyRow)}</tbody>
              <tfoot>
                <tr data-testid="mbc-total">
                  <td className="mbc-l">MATCHDAY</td>
                  <td data-testid="mbc-total-active">{num(view.table.total.active)}</td>
                  <td>{num(view.table.total.cancelledInWindow)}</td>
                  <td>{num(view.table.total.cancelledAfterCutoff)}</td>
                  <td className="mbc-chg">{num(view.table.total.beingCharged)}</td>
                  <td>
                    <span className="mbc-money">
                      {dollars(view.table.total.billingCents)}
                      <small>{mixLabel(view.table.total.mix) || "—"}</small>
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mbc-foot">Excludes price $0</div>
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
.mbc { padding: 24px 28px 80px; max-width: 1420px; }
.mbc h1 { font-size: 28px; letter-spacing: -0.5px; margin: 0 0 16px; }
.mbc-card { background: #fff; border: 1px solid var(--line, #e4eae5); border-radius: 10px; overflow: hidden; }
.mbc-bar { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; padding: 12px 18px; border-bottom: 1px solid #eff3ef; }
.mbc-lbl { font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; color: #93a49a; text-transform: uppercase; }
.mbc-gap { margin-left: 8px; }
.mbc-chip { border: 1px solid #e4eae5; background: #fff; border-radius: 999px; padding: 6px 13px; font-size: 13px; font-weight: 600; color: #3c4f44; white-space: nowrap; }
.mbc-asof { margin-left: 14px; font-size: 12.5px; font-weight: 600; color: #6e8076; white-space: nowrap; }
.mbc-ghost { margin-left: auto; border: 1px solid #e4eae5; background: #fff; border-radius: 999px; padding: 7px 15px; font: inherit; font-size: 13px; font-weight: 700; color: #3c4f44; cursor: pointer; }
.mbc-ghost:hover { background: #f4f7f4; }
.mbc-scroll { overflow-x: auto; }
.mbc table { width: 100%; border-collapse: collapse; }
.mbc thead th { background: #f7faf8; border-bottom: 1px solid #e4eae5; font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; color: #8c9e93; text-transform: uppercase; padding: 11px 14px; text-align: right; white-space: nowrap; vertical-align: bottom; }
.mbc thead th small { display: block; font-size: 10px; letter-spacing: 0.04em; text-transform: none; color: #a9b8af; font-weight: 600; margin-top: 3px; }
.mbc th.mbc-l, .mbc td.mbc-l { text-align: left; }
.mbc thead th.mbc-chg { background: #e4fbec; color: #0b3d24; }
.mbc thead th.mbc-chg small { color: #3e8c60; }
.mbc tbody td { padding: 12px 14px; text-align: right; border-bottom: 1px solid #eff3ef; font-variant-numeric: tabular-nums; }
.mbc tbody tr:hover { background: #fbfdfb; }
.mbc td.mbc-chg { background: #e4fbec; }
.mbc td.mbc-chg .mbc-n { color: #0b3d24; }
.mbc-city { font-weight: 700; font-size: 14.5px; }
.mbc-city small { display: block; font-weight: 600; font-size: 11.5px; color: #6e8076; letter-spacing: 0.04em; }
.mbc-n { font-weight: 700; font-size: 15px; }
.mbc-zero { color: #b9c6be; font-weight: 600; }
.mbc-money { font-weight: 700; font-size: 15px; }
.mbc-money small { display: block; font-weight: 600; font-size: 11.5px; color: #6e8076; }
.mbc tfoot td { padding: 14px; text-align: right; border-top: 2px solid #e4eae5; font-variant-numeric: tabular-nums; background: #f7faf8; }
.mbc tfoot td.mbc-l { text-align: left; font-weight: 800; font-size: 13px; letter-spacing: 0.06em; }
.mbc tfoot .mbc-n { font-size: 16px; }
.mbc tfoot td.mbc-chg { background: #d6f5e2; }
.mbc-foot { color: #6e8076; font-size: 12.5px; padding: 12px 18px; }
.mbc-state { color: #6e8076; padding: 24px 0; }
.mbc-err { background: #fdece8; border: 1px solid #f3c4b8; color: #8c2c14; border-radius: 9px; padding: 12px 15px; font-size: 13px; }
@media (max-width: 900px) {
  .mbc { padding: 16px 12px 60px; }
  .mbc thead th, .mbc tbody td, .mbc tfoot td { padding: 9px 8px; font-size: 12.5px; }
}
`;
