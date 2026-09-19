"use client";

/* ADS OVERVIEW — one row per paid market, expandable.
 *
 * EVERYTHING THIS PAGE HAS TO SAY, IT SAYS ON THE PAGE. The two attributions, the censoring and
 * its direction, and the markets deliberately left out are all one click from the number they
 * qualify, because a caveat that lives in a doc is a caveat nobody reading the number will see.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./growth.module.css";
import { fmtInt, fmtMoney } from "./format";
import {
  perUnit, shareOf, duplicateNames, CONFIDENCE_WORTH_FLAGGING,
  type AdsOverview, type MarketRow,
} from "@/lib/adsOverview";
import { UNKNOWN_MARKET } from "@/lib/metaAdSpend";

const CITY_LABEL: Record<string, string> = {
  ATL: "Atlanta", ATX: "Austin", DFW: "Dallas", HTX: "Houston",
  OKC: "OKC", SATX: "San Antonio", STL: "St. Louis",
};

/* ── THE DEFAULT RANGE IS EVERYTHING THE TABLES HOLD ─────────────────────────────────────────────
 * 2026-08-01 to today, and the reason is that anything earlier is a DIFFERENT ACCOUNT. The campaign
 * and ad set structure was rebuilt in August — eight months of `ATL - Eng - Feb Advantage+` became
 * `MD / Multiple Locations / App Promotion`, and the market code in the name went from 100% of
 * spend to 28.5% — so the tables floor there and a wider window would put two structures under one
 * heading.
 *
 * A SHORTER DEFAULT WAS THE OTHER CANDIDATE and it loses more than it gains: new players run about
 * 6.7 per city-day, so a 28-day default puts several markets into single digits and the
 * share-of-spend against share-of-players read becomes noise. The presets are there for when a
 * narrower question is actually being asked. */
const FLOOR = "2026-08-01";
const todayChicago = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const minus = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  const s = d.toISOString().slice(0, 10); return s < FLOOR ? FLOOR : s;
};

/* NO MONTH-TO-DATE. It reads well on the 28th and falls apart on the 2nd, and at roughly 6.7 new
 * players per city-day an early-month sample puts several markets into single digits — which is
 * the share-of-spend against share-of-players read reduced to noise. */
type Mode = "floor" | "d30" | "d7" | "custom";
const PRESETS: { mode: Mode; label: string; since: () => string }[] = [
  { mode: "floor", label: "Since Aug 1", since: () => FLOOR },
  { mode: "d30", label: "Last 30 days", since: () => minus(todayChicago(), 29) },
  { mode: "d7", label: "Last 7 days", since: () => minus(todayChicago(), 6) },
];

/** `Aug 1` — the compact form the spending-period column uses. */
const shortDay = (ymd: string | null) => {
  if (!ymd) return "—";
  const [, m, d] = ymd.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m) - 1]} ${Number(d)}`;
};
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/* ── WHEN A SPENDING PERIOD IS SHORT ENOUGH TO CHANGE THE READING ───────────────────────────────
 * The rate divides a market's spend by players accrued across the WHOLE window, so a market whose
 * money stopped early looks cheaper than it is. OKC is the live case: 28 spending days of 49, and
 * $7.45 per new player against $10.26 over its own period, 38% understated.
 *
 * 10% OF THE WINDOW is the line. Below that the arithmetic barely moves; a week missing from seven
 * is a number somebody would quote without knowing. */
const SHORT_SPAN = 0.9;

const pct = (v: number | null, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const money0 = (cents: number) => fmtMoney(cents / 100);
const money2 = (cents: number | null) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);

export default function AdsOverviewPanel({ authHeaders }: { authHeaders: Record<string, string> }) {
  const [mode, setMode] = useState<Mode>("floor");
  const [since, setSince] = useState(FLOOR);
  const [until, setUntil] = useState(todayChicago);
  const [data, setData] = useState<AdsOverview & { since: string; until: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    fetch(`/api/lifecycle/ads?since=${since}&until=${until}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j.error) setErr(j.error); else setData(j); setLoading(false); })
      .catch((e) => { if (alive) { setErr(String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [since, until, authHeaders]);

  const preset = useCallback((m: Mode, s: string) => { setMode(m); setSince(s); setUntil(todayChicago()); }, []);

  const totals = data?.totals;
  const rows = useMemo(() => data?.rows ?? [], [data]);

  return (
    <>
      {/* ── THE RANGE ─────────────────────────────────────────────────────────────────────────── */}
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <span className={styles.cardTitle}>Range</span>
            <div className={styles.cardSub} data-testid="ads-range-sub">
              The tables start on {FLOOR}. Anything earlier is a different campaign structure, not an
              empty month.
            </div>
          </div>
        </div>
        <div className={styles.controlsRow} style={{ padding: "0 18px 16px" }}>
          <div className={styles.segmented} data-testid="ads-presets">
            {PRESETS.map((p) => (
              <button key={p.mode} type="button" data-testid={`ads-preset-${p.mode}`}
                className={mode === p.mode ? `${styles.segBtn} ${styles.segBtnActive}` : styles.segBtn}
                onClick={() => preset(p.mode, p.since())}>{p.label}</button>
            ))}
            {/* CUSTOM HAS A JOB. It reveals the two date fields, which are hidden under a preset —
                a fourth button that only lit up would be a control that changes nothing. */}
            <button type="button" data-testid="ads-preset-custom"
              className={mode === "custom" ? `${styles.segBtn} ${styles.segBtnActive}` : styles.segBtn}
              onClick={() => setMode("custom")}>Custom</button>
          </div>
          {mode === "custom" && (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>From</span>
                <input type="date" className={styles.control} value={since} min={FLOOR} max={until}
                  data-testid="ads-since" onChange={(e) => setSince(e.target.value < FLOOR ? FLOOR : e.target.value)} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>To</span>
                <input type="date" className={styles.control} value={until} min={since}
                  data-testid="ads-until" onChange={(e) => setUntil(e.target.value)} />
              </label>
            </>
          )}
        </div>
      </div>

      {/* ── WHAT THE NUMBERS ARE, WHERE THE NUMBERS ARE ───────────────────────────────────────── */}
      <div className={styles.calloutBanner} data-testid="ads-attribution-note">
        <b>Two different attributions on one row.</b>{" "}
        <b>Spend</b>{" "}is delivery data, from Meta&rsquo;s <code>comscore_market</code>{" "}breakdown: it is
        where the money was actually served. <b>Installs</b>{" "}are attributed through the ad set&rsquo;s
        derived home market, because Meta returns <b>zero installs</b>{" "}under that same geo breakdown.
        So a cost per install is this market&rsquo;s ad sets divided by the installs those ad sets
        produced, and the home, unattributed and other-market shares beside it describe where their
        money landed.
      </div>

      <div className={styles.calloutBanner} data-testid="ads-censoring-note" style={{ marginTop: 10 }}>
        <b>New players are still arriving for recent days.</b>{" "}A player is dated by when they
        registered and counted once they have played, so somebody who signed up this week may play
        next week. <b>The count is short, which makes cost per new player read too EXPENSIVE, not too
        cheap.</b>{" "}The <b>7d</b>{" "}and <b>30d</b>{" "}columns are the settled figures: every registration in
        the window has had that long to convert, so they are comparable across dates in a way the
        headline is not.
      </div>

      {err && <div className={`${styles.stateMsg} ${styles.errorMsg}`} data-testid="ads-error">Could not load: {err}</div>}
      {loading && !data && <div className={styles.stateMsg} data-testid="ads-loading">Loading ads data…</div>}

      {data && (
        <>
          <div className={styles.card} style={{ marginTop: 10 }}>
            <div className={styles.cardHead}>
              <div>
                <span className={styles.cardTitle}>By market</span>
                <div className={styles.cardSub}>
                  {data.since} to {data.until} · click a market for where its money landed and which
                  ad sets spent it. <b>Regs</b> registrations, <b>Players</b> registrations that went
                  on to play, <b>$ / player</b> spend per one of those, <b>Spend %</b> and{" "}
                  <b>Player %</b> this market&rsquo;s share of each across the paid markets.{" "}
                  <b>Bought</b> flags a market whose spending period is materially shorter than the
                  window; every market&rsquo;s dates are in its expansion.
                </div>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.dataTable} data-testid="ads-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Bought</th>
                    <th>Spend</th>
                    <th>Installs</th>
                    <th>CPI</th>
                    {/* SHORT HEADERS, BECAUSE THE HEADERS ARE WHAT IS WIDE. "Cost / new player"
                        is seventeen characters over a six-character number, and the four long ones
                        together pushed Spend % and Player % off the right edge at 1900px — which
                        is the reallocation read, the thing the table exists for. The card's
                        sub-line carries the full names. */}
                    <th>Regs</th>
                    <th>Players</th>
                    <th>$ / player</th>
                    <th>7d</th>
                    <th>30d</th>
                    <th>Home</th>
                    <th>Unattrib</th>
                    <th>Other</th>
                    <th>Spend %</th>
                    <th>Player %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const sSpend = shareOf(r.spendCents, totals?.spendCents ?? 0);
                    const sPlay = shareOf(r.becamePlayers, totals?.becamePlayers ?? 0);
                    return (
                      <FragmentRow key={r.marketKey} r={r} open={open === r.marketKey}
                        onToggle={() => setOpen((v) => (v === r.marketKey ? null : r.marketKey))}
                        spendShare={sSpend} playerShare={sPlay}
                        windowDays={daysBetween(data.since, data.until)} />
                    );
                  })}
                  <tr style={{ fontWeight: 700 }} data-testid="ads-total-row">
                    <td>Total</td>
                    <td />
                    <td>{money0(totals?.spendCents ?? 0)}</td>
                    <td>{fmtInt(totals?.installs ?? 0)}</td>
                    <td>{money2(perUnit(totals?.spendCents ?? 0, totals?.installs ?? 0))}</td>
                    <td>{fmtInt(totals?.registrations ?? 0)}</td>
                    <td>{fmtInt(totals?.becamePlayers ?? 0)}</td>
                    <td>{money2(perUnit(totals?.spendCents ?? 0, totals?.becamePlayers ?? 0))}</td>
                    <td>{fmtInt(totals?.playedWithin7d ?? 0)}</td>
                    {/* NO TOTAL FOR THE SHARE COLUMNS. They are shares OF this total, so a total
                        share is 100% by construction and says nothing. The 30d total is real and
                        belongs here; the five after it do not. */}
                    <td>{fmtInt(rows.reduce((a, r) => a + r.playedWithin30d, 0))}</td>
                    <td colSpan={5} />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* ── THE GAP, STATED RATHER THAN PADDED ───────────────────────────────────────────── */}
            <div className={styles.footnote} data-testid="ads-excluded-note" style={{ padding: "0 18px 14px" }}>
              Paid markets only. {data.excluded.registrations > 0 ? (
                <>
                  <b>{fmtInt(data.excluded.registrations)} registrations</b>{" "}and{" "}
                  <b>{fmtInt(data.excluded.becamePlayers)} new players</b>{" "}in this window are in
                  markets we do not buy in{data.excluded.cities.length ? ` (${data.excluded.cities.join(", ")})` : ""},
                  so the player columns do not add up to the company total. They are left out rather
                  than padded in with no spend beside them.
                </>
              ) : <>No registrations fell outside the paid markets in this window.</>}
            </div>
          </div>

          {/* ── AD SETS THAT REACHED NO MARKET ───────────────────────────────────────────────── */}
          {data.notAttributed.length > 0 && (
            <div className={styles.card} style={{ marginTop: 10 }} data-testid="ads-notattributed">
              <div className={styles.cardHead}>
                <div>
                  <span className={styles.cardTitle}>Not attributed to a market</span>
                  <div className={styles.cardSub}>
                    Below the 60% confidence floor, or a dominant served market we do not map. Their
                    spend is counted here and in no market row above.
                  </div>
                </div>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr><th>Ad set</th><th>Campaign</th><th>Spend</th><th>Confidence</th><th>Where it landed</th></tr>
                  </thead>
                  <tbody>
                    {data.notAttributed.map((n) => (
                      <tr key={n.adsetId} data-testid="ads-notattributed-row">
                        <td>{n.adsetName ?? n.adsetId}</td>
                        <td>{n.campaignName ?? "—"}</td>
                        <td>{money0(n.spendCents)}</td>
                        <td>{pct(n.confidence)}</td>
                        <td>{n.topMarkets.map((t) => `${t.marketRaw} ${money0(t.spendCents)}`).join(" · ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function FragmentRow({ r, open, onToggle, spendShare, playerShare, windowDays }: {
  r: MarketRow; open: boolean; onToggle: () => void;
  spendShare: number | null; playerShare: number | null; windowDays: number;
}) {
  const home = shareOf(r.homeCents, r.spendCents);
  const unk = shareOf(r.unknownCents, r.spendCents);
  const other = shareOf(r.otherNamedCents, r.spendCents);
  /* THE SPAN, NOT THE DAY COUNT. Interior gaps do not move the rate — San Antonio bought on 38 of
   * 49 days and is undistorted because it still spans the window. A market that STOPPED divides
   * less spend by the same players and reads cheaper than it is. */
  const span = r.firstSpend && r.lastSpend ? daysBetween(r.firstSpend, r.lastSpend) : 0;
  const short = span > 0 && span < windowDays * SHORT_SPAN;
  const dupes = duplicateNames(r.adsets);
  return (
    <>
      <tr data-testid="ads-row" data-market={r.marketKey} onClick={onToggle}
        style={{ cursor: "pointer", background: open ? "var(--mint)" : undefined }}>
        <td>
          <button type="button" data-testid="ads-expand" aria-expanded={open}
            style={{ font: "inherit", color: "inherit", background: "none", border: 0, padding: 0, cursor: "pointer" }}>
            <span aria-hidden style={{ display: "inline-block", width: 12 }}>{open ? "▾" : "▸"}</span>
            {CITY_LABEL[r.marketKey] ?? r.marketKey}
          </button>
        </td>
        {/* THE SPENDING PERIOD IS AN EXCEPTION MARKER, NOT A COLUMN OF DATES. Six of seven markets
            span the whole window, so printing "Aug 1–Sep 18" on each of them is a wide column of
            one repeated fact that pushed the two share columns off the right edge. The dates for
            every market are in the expansion, which is where the brief allows them; the collapsed
            row carries only the case that changes the reading. */}
        <td data-testid="ads-span" data-short={short || undefined}
          style={short ? { color: "var(--negative)", fontWeight: 700 } : { color: "var(--muted)" }}>
          {short
            ? `${shortDay(r.firstSpend)}–${shortDay(r.lastSpend)} · ${span}d of ${windowDays}`
            : r.firstSpend ? "full" : "—"}
        </td>
        <td data-testid="ads-spend">{money0(r.spendCents)}</td>
        <td>{r.installs == null ? "—" : fmtInt(r.installs)}</td>
        <td data-testid="ads-cpi">{money2(perUnit(r.spendCents, r.installs))}</td>
        <td>{fmtInt(r.registrations)}</td>
        <td data-testid="ads-newplayers">{fmtInt(r.becamePlayers)}</td>
        <td data-testid="ads-cpnp">{money2(perUnit(r.spendCents, r.becamePlayers))}</td>
        <td>{fmtInt(r.playedWithin7d)}</td>
        <td>{fmtInt(r.playedWithin30d)}</td>
        {/* THE THREE SHARES ARE OF THIS ROW'S OWN SPEND, so they add to 100% and a reader can
            check them against the spend cell beside them. */}
        <td data-testid="ads-home">{pct(home)}</td>
        <td data-testid="ads-unattributed" style={unk != null && unk > 0.05 ? { color: "var(--negative)", fontWeight: 700 } : undefined}>{pct(unk)}</td>
        <td>{pct(other)}</td>
        <td>{pct(spendShare)}</td>
        {/* THE REALLOCATION READ. Share of spend against share of new players says which market is
            buying more than its output, which neither rate on its own can tell you. */}
        <td data-testid="ads-playershare">{pct(playerShare)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={15} style={{ padding: 0 }}>
            <div className={styles.detailPanel} data-testid="ads-detail">
              <div className={styles.detailHead}>
                <b>Where {CITY_LABEL[r.marketKey] ?? r.marketKey}&rsquo;s money landed</b>
                <span className={styles.footnote} style={{ margin: 0 }}>
                  Bought on {r.spendDays} of {windowDays} days{r.firstSpend ? `, ${shortDay(r.firstSpend)} to ${shortDay(r.lastSpend)}` : ""}.
                  {" "}Served markets down to 99% of this market&rsquo;s spend. The rest is one row.{" "}
                  {UNKNOWN_MARKET} is never rolled up.
                </span>
              </div>
              <table className={styles.dataTable}>
                <thead><tr><th>Served market</th><th>Spend</th><th>Share</th></tr></thead>
                <tbody>
                  {r.served.map((s) => (
                    <tr key={s.marketRaw} data-testid="ads-served-row" data-rolled={s.rolled || undefined}
                      style={s.marketRaw === UNKNOWN_MARKET ? { fontWeight: 700 } : undefined}>
                      <td>{s.marketRaw}</td>
                      <td>{money0(s.spendCents)}</td>
                      <td>{pct(shareOf(s.spendCents, r.spendCents))}</td>
                    </tr>
                  ))}
                  {r.served.length === 0 && <tr><td colSpan={3}>No spend in this window.</td></tr>}
                </tbody>
              </table>

              <div className={styles.detailHead} style={{ marginTop: 16 }}>
                <b>Ad sets that spent it</b>
                <span className={styles.footnote} style={{ margin: 0 }}>
                  All of them, no floor, grouped so a repeated name sits beside itself. Installs are
                  per ad set, the only grain Meta reports them at. <b>Spend with no installs behind
                  it is marked.</b>
                </span>
              </div>
              <table className={styles.dataTable}>
                {/* NO PARENT CONFIDENCE COLUMN. It read 98.7% or 100.0% on every row, which is a
                    column of noise; it only says something when it is LOW, so the exception is
                    flagged on the name instead. */}
                {/* SPEND AND INSTALLS BEFORE THE CAMPAIGN. The campaign name runs to sixty
                    characters and pushed Installs off the right edge of the scroller, which made
                    the no-installs marking invisible at rest — the one thing in this table worth
                    acting on. The long text goes last, where running out of room costs nothing. */}
                <thead><tr><th>Ad set</th><th>Spend</th><th>Installs</th><th>Campaign</th></tr></thead>
                <tbody>
                  {r.adsets.map((a) => {
                    const dead = a.installs === 0 && a.spendCents > 0;
                    const shaky = a.confidence != null && a.confidence < CONFIDENCE_WORTH_FLAGGING;
                    return (
                      <tr key={a.adsetId} data-testid="ads-adset-row" data-dead={dead || undefined}>
                        <td>
                          {a.adsetName ?? a.adsetId}{" "}
                          {/* A REPEATED NAME IS MARKED AS WELL AS GROUPED, so two adjacent rows
                              reading the same do not look like one row drawn twice. */}
                          {dupes.has(a.adsetName ?? a.adsetId) && (
                            <span className={styles.footnote} style={{ marginLeft: 6 }} data-testid="ads-adset-dupe">
                              same name, different campaign
                            </span>
                          )}
                          {" "}
                          {shaky && (
                            <span data-testid="ads-adset-shaky" style={{ marginLeft: 6, color: "var(--negative)", fontWeight: 700 }}>
                              only {pct(a.confidence, 0)} of its money in this market
                            </span>
                          )}
                        </td>
                        <td>{money0(a.spendCents)}</td>
                        {/* SPEND WITH NOTHING TO SHOW FOR IT is the actionable row in this table —
                            five of Houston's seven ad sets, $674 of its $1,799 — and nothing used
                            to mark it. */}
                        <td data-testid="ads-adset-installs"
                          style={dead ? { color: "var(--negative)", fontWeight: 700 } : undefined}>
                          {a.installs == null ? "—" : fmtInt(a.installs)}
                          {dead && <span style={{ fontWeight: 400 }}> · no installs</span>}
                        </td>
                        <td>{a.campaignName ?? "—"}</td>
                      </tr>
                    );
                  })}
                  {r.adsets.length === 0 && <tr><td colSpan={4}>No ad sets in this window.</td></tr>}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
