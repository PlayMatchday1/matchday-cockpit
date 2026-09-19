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
import { perUnit, shareOf, type AdsOverview, type MarketRow } from "@/lib/adsOverview";
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

const pct = (v: number | null, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const money0 = (cents: number) => fmtMoney(cents / 100);
const money2 = (cents: number | null) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);

export default function AdsOverviewPanel({ authHeaders }: { authHeaders: Record<string, string> }) {
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

  const preset = useCallback((s: string) => { setSince(s); setUntil(todayChicago()); }, []);

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
            {[["Since Aug 1", FLOOR], ["Last 28 days", minus(todayChicago(), 27)], ["Last 7 days", minus(todayChicago(), 6)]].map(([label, s]) => (
              <button key={label} type="button" data-testid={`ads-preset-${s}`}
                className={since === s ? `${styles.segBtn} ${styles.segBtnActive}` : styles.segBtn}
                onClick={() => preset(s)}>{label}</button>
            ))}
          </div>
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
                  ad sets spent it
                </div>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.dataTable} data-testid="ads-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Spend</th>
                    <th>Installs</th>
                    <th>CPI</th>
                    <th>Registrations</th>
                    <th>New players</th>
                    <th>Cost / new player</th>
                    <th>7d</th>
                    <th>30d</th>
                    <th>Home</th>
                    <th>Unattributed</th>
                    <th>Other named</th>
                    <th>Spend share</th>
                    <th>Player share</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const sSpend = shareOf(r.spendCents, totals?.spendCents ?? 0);
                    const sPlay = shareOf(r.becamePlayers, totals?.becamePlayers ?? 0);
                    return (
                      <FragmentRow key={r.marketKey} r={r} open={open === r.marketKey}
                        onToggle={() => setOpen((v) => (v === r.marketKey ? null : r.marketKey))}
                        spendShare={sSpend} playerShare={sPlay} />
                    );
                  })}
                  <tr style={{ fontWeight: 700 }} data-testid="ads-total-row">
                    <td>Total</td>
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

function FragmentRow({ r, open, onToggle, spendShare, playerShare }: {
  r: MarketRow; open: boolean; onToggle: () => void;
  spendShare: number | null; playerShare: number | null;
}) {
  const home = shareOf(r.homeCents, r.spendCents);
  const unk = shareOf(r.unknownCents, r.spendCents);
  const other = shareOf(r.otherNamedCents, r.spendCents);
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
          <td colSpan={14} style={{ padding: 0 }}>
            <div className={styles.detailPanel} data-testid="ads-detail">
              <div className={styles.detailHead}>
                <b>Where {CITY_LABEL[r.marketKey] ?? r.marketKey}&rsquo;s money landed</b>
                <span className={styles.footnote} style={{ margin: 0 }}>
                  Served markets down to 99% of this market&rsquo;s spend. The rest is one row.{" "}
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
                  All of them, no floor. Installs are per ad set, which is the only grain Meta
                  reports them at.
                </span>
              </div>
              <table className={styles.dataTable}>
                <thead><tr><th>Ad set</th><th>Campaign</th><th>Spend</th><th>Installs</th><th>Parent confidence</th></tr></thead>
                <tbody>
                  {r.adsets.map((a) => (
                    <tr key={a.adsetId} data-testid="ads-adset-row">
                      <td>{a.adsetName ?? a.adsetId}</td>
                      <td>{a.campaignName ?? "—"}</td>
                      <td>{money0(a.spendCents)}</td>
                      <td>{a.installs == null ? "—" : fmtInt(a.installs)}</td>
                      <td>{pct(a.confidence)}</td>
                    </tr>
                  ))}
                  {r.adsets.length === 0 && <tr><td colSpan={5}>No ad sets in this window.</td></tr>}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
