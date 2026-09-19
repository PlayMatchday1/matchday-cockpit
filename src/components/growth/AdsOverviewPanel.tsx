"use client";

/* ADS OVERVIEW — paid spend by market against the players it bought.
 *
 * THE PAGE HAS ONE FINDING AND THE FIRST CUT DID NOT SAY SO. Austin at $3.20 against Dallas at
 * $19.68 is a six-times spread that read as seven identical numbers, because every cell on the row
 * carried the same size and weight. Cost per new player is now the only thing at 17px, coloured by
 * band and barred across the markets; CPI drops to caption size beside it; and share of spend
 * against share of players collapses into one diverging bar with the signed gap, which is the
 * reallocation read stated rather than left as two percentages to subtract.
 *
 * WHAT MOVED OUT OF THE WAY. Four blocks sat above the table — a range card, two callouts and a
 * paragraph of column definitions — so the table began below the fold on a laptop. The definitions
 * are tooltips on the headers they define, the three banners are one line with a Why, and
 * Registrations, 7d, 30d, Home, Unattributed and Other are behind All columns.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./growth.module.css";
import { fmtInt, fmtMoney } from "./format";
import {
  perUnit, shareOf, costBand, reallocationGap, duplicateNames, BAND_BAD_AT,
  CONFIDENCE_WORTH_FLAGGING, type AdsOverview, type Band, type MarketRow,
} from "@/lib/adsOverview";
import { UNKNOWN_MARKET } from "@/lib/metaAdSpend";

const CITY_LABEL: Record<string, string> = {
  ATL: "Atlanta", ATX: "Austin", DFW: "Dallas", HTX: "Houston",
  OKC: "OKC", SATX: "San Antonio", STL: "St. Louis",
};

const FLOOR = "2026-08-01";
const todayChicago = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const minus = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  const s = d.toISOString().slice(0, 10); return s < FLOOR ? FLOOR : s;
};

/* NO MONTH-TO-DATE. It reads well on the 28th and falls apart on the 2nd, and at roughly 6.7 new
 * players per city-day an early-month sample puts several markets into single digits. */
type Mode = "floor" | "d30" | "d7" | "custom";
const PRESETS: { mode: Mode; label: string; since: () => string }[] = [
  { mode: "floor", label: "Since Aug 1", since: () => FLOOR },
  { mode: "d30", label: "30d", since: () => minus(todayChicago(), 29) },
  { mode: "d7", label: "7d", since: () => minus(todayChicago(), 6) },
];

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const shortDay = (ymd: string | null) => {
  if (!ymd) return "—";
  const [, m, d] = ymd.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
};
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/* A SPAN SHORTER THAN 90% OF THE WINDOW CHANGES THE READING. The rate divides a market's spend by
 * players accrued across the whole window, so a market that stopped early looks cheaper than it is:
 * OKC reads $7.45 against $10.26 over its own period. Interior gaps do not move it — San Antonio
 * bought on 38 of 49 days and still spans the window. */
const SHORT_SPAN = 0.9;

const pct = (v: number | null, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const money0 = (cents: number) => fmtMoney(cents / 100);
const money2 = (cents: number | null) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);
const KEY_CLASS: Record<Band, string> = {
  good: styles.adsKeyGood, mid: styles.adsKeyMid, bad: styles.adsKeyBad, dark: styles.adsKeyDark,
};

/* A header with its definition on hover, replacing the paragraph that used to sit above the table.
 *
 * A CIRCLED i, NOT A DOTTED UNDERLINE. The underline did not read as interactive — it looks like
 * emphasis, or like nothing, and it is easy to miss entirely. A glyph after the name says there is
 * something here to ask. Every header that carries a definition shows one, so its absence means
 * "nothing more to say" rather than "we ran out of room". */
function InfoDot() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" style={{ opacity: 0.55, flexShrink: 0 }} aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.01" />
    </svg>
  );
}

function Th({ label, tip, className }: { label: string; tip?: string; className?: string }) {
  return (
    <th className={className}>
      {tip ? (
        <span title={tip} className={styles.adsTh}>{label}<InfoDot /></span>
      ) : label}
    </th>
  );
}

export default function AdsOverviewPanel({ authHeaders }: { authHeaders: Record<string, string> }) {
  const [mode, setMode] = useState<Mode>("floor");
  const [since, setSince] = useState(FLOOR);
  const [until, setUntil] = useState(todayChicago);
  const [data, setData] = useState<(AdsOverview & { since: string; until: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [allCols, setAllCols] = useState(false);
  const [why, setWhy] = useState(false);

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

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const totals = data?.totals;
  const windowDays = data ? daysBetween(data.since, data.until) : 0;

  /* THE SCALES ARE ACROSS THE MARKETS ON SCREEN, not fixed. A bar whose full width meant a number
   * nobody is looking at would flatten the spread this column exists to show. */
  const blended = totals ? perUnit(totals.spendCents, totals.becamePlayers) : null;
  const view = useMemo(() => rows.map((r) => {
    const span = r.firstSpend && r.lastSpend ? daysBetween(r.firstSpend, r.lastSpend) : 0;
    const dark = span > 0 && span < windowDays * SHORT_SPAN;
    const cpnp = perUnit(r.spendCents, r.becamePlayers);
    return {
      r, span, dark, cpnp,
      band: costBand(cpnp, blended, dark),
      gap: reallocationGap(shareOf(r.becamePlayers, totals?.becamePlayers ?? 0), shareOf(r.spendCents, totals?.spendCents ?? 0)),
    };
  }), [rows, windowDays, blended, totals]);

  return (
    <div className={styles.ads}>
      {/* ── SUMMARY AND CONTROLS ON ONE LINE ─────────────────────────────────────────────────── */}
      <div className={styles.adsBar}>
        <span className={styles.adsSummary} data-testid="ads-summary">
          {totals
            ? `${money0(totals.spendCents)} spend · ${fmtInt(totals.installs)} installs · ${fmtInt(totals.becamePlayers)} new players · ${money2(blended)} blended`
            : "…"}
        </span>
        <div className={styles.adsControls}>
          <div className={styles.adsPills} data-testid="ads-presets">
            {PRESETS.map((p) => (
              <button key={p.mode} type="button" data-testid={`ads-preset-${p.mode}`}
                className={mode === p.mode ? `${styles.adsPill} ${styles.adsPillOn}` : styles.adsPill}
                onClick={() => preset(p.mode, p.since())}>{p.label}</button>
            ))}
          </div>
          {/* CUSTOM HAS A JOB: it reveals the two date fields, which are hidden under a preset. */}
          <button type="button" data-testid="ads-preset-custom"
            className={mode === "custom" ? `${styles.adsBtn} ${styles.adsBtnOn}` : styles.adsBtn}
            onClick={() => setMode("custom")}>
            {data ? `${shortDay(data.since)} – ${shortDay(data.until)}` : "Custom"}
          </button>
          {mode === "custom" && (
            <>
              <input type="date" className={styles.adsBtn} value={since} min={FLOOR} max={until}
                aria-label="From" data-testid="ads-since"
                onChange={(e) => setSince(e.target.value < FLOOR ? FLOOR : e.target.value)} />
              <input type="date" className={styles.adsBtn} value={until} min={since}
                aria-label="To" data-testid="ads-until" onChange={(e) => setUntil(e.target.value)} />
            </>
          )}
          <button type="button" data-testid="ads-allcols"
            className={allCols ? `${styles.adsBtn} ${styles.adsBtnOn}` : styles.adsBtn}
            aria-pressed={allCols} onClick={() => setAllCols((v) => !v)}>All columns</button>
        </div>
      </div>

      {/* ── ONE LINE, WITH THE REST BEHIND IT ────────────────────────────────────────────────── */}
      <div className={styles.adsNote} data-testid="ads-note" style={{ marginTop: 12 }}>
        <span aria-hidden>ⓘ</span>
        <span>
          Spend is where Meta served it. Installs are attributed through each ad set&rsquo;s home
          market. Recent days are still filling, so cost per new player reads too expensive.
        </span>
        <button type="button" className={styles.adsNoteWhy} data-testid="ads-why"
          aria-expanded={why} onClick={() => setWhy((v) => !v)}>{why ? "Hide" : "Why"}</button>
      </div>
      {why && (
        <div className={styles.adsWhy} data-testid="ads-why-panel" style={{ marginTop: 8 }}>
          <p>
            <b>Two different attributions on one row.</b>{" "}
            <b>Spend</b> is delivery data, from Meta&rsquo;s <code>comscore_market</code> breakdown:
            where the money was actually served. <b>Installs</b> come through each ad set&rsquo;s
            derived home market, because Meta returns <b>zero installs</b> under that geo breakdown.
          </p>
          <p>
            <b>New players are still arriving for recent days.</b> A player is dated by when they
            registered and counted once they have played, so somebody who signed up this week may
            play next week. The count is short, which makes cost per new player read{" "}
            <b>too expensive, not too cheap</b>. The 7d and 30d columns, under All columns, are the
            settled figures.
          </p>
          <p>
            <b>The range starts {FLOOR}.</b> Anything earlier is a different campaign structure, not
            an empty month: the account was rebuilt in August.
          </p>
          <p>
            <b>Bands are relative, not fixed.</b> Green is at or below the blended rate across all
            markets, amber up to twice it, red beyond. A market whose spending period is materially
            shorter than the window is greyed and badged <b>DARK</b> rather than banded, because its
            rate divides less spend by the same players and reads cheaper than it is.
          </p>
        </div>
      )}

      {err && <div className={`${styles.stateMsg} ${styles.errorMsg}`} data-testid="ads-error">Could not load: {err}</div>}
      {loading && !data && <div className={styles.stateMsg} data-testid="ads-loading">Loading ads data…</div>}

      {data && (
        <>
          <div className={styles.card} style={{ marginTop: 12, overflow: "hidden" }}>
            <div className={styles.tableWrap}>
              <table className={styles.adsTable} data-testid="ads-table">
                <thead>
                  <tr>
                    <Th label="Market" />
                    <Th label="Spend" tip="Ad spend served in this market's own ad sets, from Meta's comscore_market breakdown." />
                    <Th label="Installs" tip="Mobile app installs, attributed through each ad set's derived home market. Meta returns none under the geo breakdown." />
                    <Th label="CPI" tip="Spend divided by installs. Context for the headline, not a competing measure." />
                    {allCols && <Th label="Regs" tip="Registrations in this market during the window, by the player's declared city." />}
                    <Th label="New players" tip="Everyone who registered in this market during the window and has since played a match. It counts every new player, not only the ones the ads brought." />
                    {/* NO BAR BESIDE IT. The figure is already the largest thing on the row and
                        colour-coded; a bar re-encoding the same number across seven rows added a
                        column and no information. */}
                    <Th label="Cost per new player" className={styles.adsHeadKey}
                      tip="Ad spend in this market divided by every new player in it, organic ones included. A ratio for comparing markets against each other, not a cost of acquisition." />
                    {allCols && <Th label="7d" tip="Registrations that played within 7 days. Settled: every registration in the window has had that long." />}
                    {allCols && <Th label="30d" tip="Registrations that played within 30 days." />}
                    {allCols && <Th label="Home" tip="Share of this market's spend served in its own comscore market." />}
                    {allCols && <Th label="Unattrib" tip="Share served where Meta would not name a market at all." />}
                    {allCols && <Th label="Other" tip="Share served in a named market that is not this one." />}
                    {/* SHORTENED, WITH THE PHRASE IN THE TOOLTIP. "Share of players less share of
                        spend" is a thirty-seven character header over a five-character number, and
                        it pushed that number off the right edge of the card at 1440px — the signed
                        gap being the thing the bar exists to anchor. */}
                    {/* THE DIVERGING BAR IS GONE AND ITS FAILURE IS WORTH RECORDING: the 1px
                        centre axis did not render against the row background, so there was nothing
                        to diverge FROM and the lengths carried no meaning at all. The signed number
                        was also stranded at the far right, away from the bar it annotated. The
                        number now sits where the bar was. */}
                    <Th label="Players less spend" className={styles.adsHeadKey}
                      tip="This market's share of new players minus its share of spend, in points. Positive returns more than it takes; negative takes more budget than it returns." />
                  </tr>
                </thead>
                <tbody>
                  {view.map((v) => (
                    <Row key={v.r.marketKey} v={v} open={open === v.r.marketKey} allCols={allCols}
                      onToggle={() => setOpen((o) => (o === v.r.marketKey ? null : v.r.marketKey))}
                      windowDays={windowDays} />
                  ))}
                  <tr className={styles.adsTotal} data-testid="ads-total-row">
                    <td>Total</td>
                    <td>{money0(totals?.spendCents ?? 0)}</td>
                    <td>{fmtInt(totals?.installs ?? 0)}</td>
                    <td className={styles.adsMuted}>{money2(perUnit(totals?.spendCents ?? 0, totals?.installs ?? 0))}</td>
                    {allCols && <td>{fmtInt(totals?.registrations ?? 0)}</td>}
                    <td>{fmtInt(totals?.becamePlayers ?? 0)}</td>
                    <td className={styles.adsKey}>{money2(blended)}</td>
                    {allCols && <td>{fmtInt(totals?.playedWithin7d ?? 0)}</td>}
                    {allCols && <td>{fmtInt(rows.reduce((a, r) => a + r.playedWithin30d, 0))}</td>}
                    {allCols && <td colSpan={3} />}
                    {/* NO TOTAL GAP. It is a share of this total minus another share of it, so
                        the total is zero by construction. */}
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            <div className={styles.adsFoot}>
              <span data-testid="ads-excluded-note">
                Paid markets only. {data.excluded.registrations > 0 ? (
                  <>
                    <b>{fmtInt(data.excluded.registrations)} registrations</b> and{" "}
                    <b>{fmtInt(data.excluded.becamePlayers)} new players</b> fall in markets we do not
                    buy in{data.excluded.cities.length ? ` (${data.excluded.cities.join(", ")})` : ""}, so the
                    player columns do not add to the company total.
                  </>
                ) : <>No registrations fell outside the paid markets in this window.</>}
              </span>
              {!allCols && (
                <button type="button" className={styles.adsNoteWhy} style={{ marginLeft: 0 }}
                  data-testid="ads-allcols-foot" onClick={() => setAllCols(true)}>
                  Registrations, 7d and 30d settled counts, home and unattributed shares →
                </button>
              )}
            </div>
          </div>

          {data.notAttributed.length > 0 && (
            <div className={styles.card} style={{ marginTop: 12 }} data-testid="ads-notattributed">
              <div className={styles.cardHead}>
                <div>
                  <span className={styles.cardTitle}>Not attributed to a market</span>
                  <div className={styles.cardSub}>
                    Below the 60% confidence floor, or a dominant served market we do not map. Counted
                    here and in no market row above.
                  </div>
                </div>
              </div>
              <div className={styles.adsDetail} style={{ paddingLeft: 20 }}>
                <div className={styles.adsDetailCol}>
                  {data.notAttributed.map((n) => (
                    <div key={n.adsetId} className={styles.adsLine} data-testid="ads-notattributed-row">
                      <span className={styles.adsLineName}>{n.adsetName ?? n.adsetId}</span>
                      <span className={styles.adsMuted}>{n.topMarkets.map((t) => t.marketRaw).join(", ") || "—"}</span>
                      <span className={styles.adsLineVal}>{money0(n.spendCents)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type ViewRow = { r: MarketRow; span: number; dark: boolean; cpnp: number | null; band: Band | null; gap: number | null };

function Row({ v, open, onToggle, windowDays, allCols }: {
  v: ViewRow; open: boolean; onToggle: () => void;
  windowDays: number; allCols: boolean;
}) {
  const { r, band, cpnp, gap, dark } = v;
  const keyCls = band ? KEY_CLASS[band] : "";
  const dupes = duplicateNames(r.adsets);
  const maxServed = Math.max(1, ...r.served.map((s) => s.spendCents));
  // Two bar columns went; the expansion spans what is left.
  const cols = 6 + (allCols ? 5 : 0);

  return (
    <>
      <tr className={`${styles.adsRow} ${open ? styles.adsRowOpen : ""}`} data-testid="ads-row"
        data-market={r.marketKey} data-band={band ?? undefined} onClick={onToggle}>
        <td>
          <span className={styles.adsMarket}>
            <span className={styles.adsCaret} aria-hidden>{open ? "▾" : "▸"}</span>
            {CITY_LABEL[r.marketKey] ?? r.marketKey}
            {/* THE SPENDING PERIOD AS A BADGE, not a column of six identical date ranges. */}
            {dark && (
              <span className={styles.adsBadge} data-testid="ads-dark"
                title={`Bought on ${r.spendDays} of ${windowDays} days, ${shortDay(r.firstSpend)} to ${shortDay(r.lastSpend)}. Its rate divides less spend by the same players, so it reads cheaper than it is.`}>
                dark
              </span>
            )}
          </span>
        </td>
        <td data-testid="ads-spend">{money0(r.spendCents)}</td>
        <td>{r.installs == null ? "—" : fmtInt(r.installs)}</td>
        <td className={styles.adsMuted} data-testid="ads-cpi">{money2(perUnit(r.spendCents, r.installs))}</td>
        {allCols && <td>{fmtInt(r.registrations)}</td>}
        <td data-testid="ads-newplayers">{fmtInt(r.becamePlayers)}</td>
        <td className={`${styles.adsKey} ${keyCls}`} data-testid="ads-cpnp">{money2(cpnp)}</td>
        {allCols && <td>{fmtInt(r.playedWithin7d)}</td>}
        {allCols && <td>{fmtInt(r.playedWithin30d)}</td>}
        {allCols && <td>{pct(shareOf(r.homeCents, r.spendCents))}</td>}
        {allCols && <td className={r.unknownCents > 0 ? styles.adsUnknown : undefined}>{pct(shareOf(r.unknownCents, r.spendCents))}</td>}
        {allCols && <td>{pct(shareOf(r.otherNamedCents, r.spendCents))}</td>}
        {/* THE SIGNED GAP ALONE, where the bar was. One number carries the whole reallocation
            read: positive returns more than it takes, negative takes more than it returns. */}
        <td data-testid="ads-gap" className={`${styles.adsGap} ${gap == null ? "" : gap > 0 ? styles.adsKeyGood : styles.adsKeyBad}`}>
          {gap == null ? "—" : `${gap > 0 ? "+" : "−"}${Math.abs(gap).toFixed(1)}`}
        </td>
      </tr>

      {open && (
        <tr className={styles.adsRowOpen}>
          <td colSpan={cols} style={{ padding: 0 }}>
            <div className={styles.adsDetail} data-testid="ads-detail">
              <div className={styles.adsDetailCol}>
                <div className={styles.adsDetailHead}>
                  Where the money landed · bought on {r.spendDays} of {windowDays} days
                  {r.firstSpend ? `, ${shortDay(r.firstSpend)} to ${shortDay(r.lastSpend)}` : ""}
                </div>
                {r.served.map((s) => {
                  const unk = s.marketRaw === UNKNOWN_MARKET;
                  return (
                    <div key={s.marketRaw} className={styles.adsLine} data-testid="ads-served-row">
                      <span className={`${styles.adsLineName} ${unk ? styles.adsUnknown : ""}`}>
                        {unk ? "Unknown · Meta did not say" : s.marketRaw}
                      </span>
                      <div className={styles.adsLineTrack}>
                        <div className={styles.adsFill} style={{ height: 8,
                          width: `${(s.spendCents / maxServed) * 100}%`,
                          background: unk ? "var(--gold-dot)" : "var(--div-above-2)" }} />
                      </div>
                      <span className={`${styles.adsLineVal} ${unk ? styles.adsUnknown : ""}`}>{money0(s.spendCents)}</span>
                    </div>
                  );
                })}
                {r.served.length === 0 && <div className={styles.adsMuted}>No spend in this window.</div>}
              </div>

              <div className={styles.adsDetailCol}>
                <div className={styles.adsDetailHead}>Ad sets</div>
                {r.adsets.map((a) => {
                  const dead = a.installs === 0 && a.spendCents > 0;
                  const shaky = a.confidence != null && a.confidence < CONFIDENCE_WORTH_FLAGGING;
                  return (
                    <div key={a.adsetId} className={styles.adsLine} data-testid="ads-adset-row" data-dead={dead || undefined}>
                      <span className={styles.adsLineName} title={a.campaignName ?? undefined}>
                        {a.adsetName ?? a.adsetId}
                        {dupes.has(a.adsetName ?? a.adsetId) && (
                          <span className={styles.adsMuted} data-testid="ads-adset-dupe"> · {a.campaignName ?? "no campaign"}</span>
                        )}
                        {shaky && (
                          <span className={styles.adsDead} data-testid="ads-adset-shaky">
                            {" "}· only {pct(a.confidence, 0)} here
                          </span>
                        )}
                      </span>
                      {/* SPEND WITH NOTHING TO SHOW FOR IT is the actionable line in this list —
                          five of Houston's seven ad sets, $674 of its $1,799 — and the first cut
                          did not mark it at all. */}
                      <span className={`${styles.adsLineVal} ${dead ? styles.adsDead : ""}`} data-testid="ads-adset-installs"
                        style={{ width: 150 }}>
                        {money0(a.spendCents)} · {a.installs == null ? "—" : dead ? "no installs" : `${fmtInt(a.installs)} installs`}
                      </span>
                    </div>
                  );
                })}
                {r.adsets.length === 0 && <div className={styles.adsMuted}>No ad sets in this window.</div>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
