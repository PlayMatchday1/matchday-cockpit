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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./growth.module.css";
import { fmtInt, fmtMoney } from "./format";
import {
  perUnit, shareOf, costBand, fairShareCents, overUnderCents, duplicateNames,
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

/* ── THE COLUMN DEFINITIONS, AS A REAL TOOLTIP ───────────────────────────────────────────────────
 *
 * THE `title` ATTRIBUTE DID NOT WORK AND WAS NEVER GOING TO. It waits about a second before the
 * browser decides you meant it, it was hung on an inline <svg> that reports its own hit area
 * inconsistently, it cannot be styled or line-wrapped, it never appears for a keyboard user at
 * all, and it is suppressed outright on touch. The icon looked live and answered nothing, which is
 * the one thing a control must not do.
 *
 * PORTALLED TO document.body, position: fixed. The table sits inside .tableWrap (overflow-x: auto)
 * inside a card with overflow: hidden, so a panel rendered in the header would be clipped twice
 * over. Portalling escapes both; placing off the trigger's own rect keeps it attached, and it is
 * re-placed on scroll in the CAPTURE phase so the table's own sideways scroll counts, not just the
 * window's.
 *
 * HOVER, CLICK, AND KEYBOARD FOCUS, and the three do not fight. On a pointer device the mouse
 * arrives before the click, so a naive toggle opens on hover then shuts on the click that follows
 * and the control reads as dead; hover-opened is provisional and closes on mouse-out, a click
 * takes ownership. Focus only opens what is not already open, so clicking (which also focuses)
 * cannot hand ownership over mid-gesture.
 *
 * IT NEVER CHANGES THE HEADER'S LAYOUT. The trigger is sized in the flow open or shut, with
 * negative margins so its 22px hit area cannot widen a column, and the panel is out of flow. */
function HeaderTip({ label, tip }: { label: string; tip: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const hoverOwned = useRef(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = TIP_WIDTH, M = 8;
    // RIGHT EDGES FLUSH, because every one of these headers is right-aligned and the rightmost
    // would otherwise run off the card. Clamped to the viewport either way.
    let left = r.right - W;
    left = Math.max(M, Math.min(left, window.innerWidth - W - M));
    setPos({ top: r.bottom + 6, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    // MEASURED MORE THAN ONCE. A single read on open is the layout at that instant, which after a
    // late reflow is the layout the trigger has already left.
    place();
    const raf = requestAnimationFrame(place);
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.adsTipBtn}
        data-testid="ads-tip-btn"
        aria-label={`What ${label} means`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (open && !hoverOwned.current) { setOpen(false); return; }
          hoverOwned.current = false;
          setOpen(true);
        }}
        onMouseEnter={() => { if (!open) { hoverOwned.current = true; setOpen(true); } }}
        onMouseLeave={() => { if (hoverOwned.current) setOpen(false); }}
        onFocus={() => { if (!open) { hoverOwned.current = false; setOpen(true); } }}
        onBlur={() => { if (!hoverOwned.current) setOpen(false); }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.01" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div role="tooltip" className={styles.adsTip} data-testid="ads-tip"
          style={{ top: pos.top, left: pos.left, width: TIP_WIDTH }}>
          <div className={styles.adsTipHead}>{label}</div>
          {tip}
        </div>,
        document.body,
      )}
    </>
  );
}

const TIP_WIDTH = 284;

function Th({ label, tip, className }: { label: string; tip?: React.ReactNode; className?: string }) {
  return (
    <th className={className}>
      <span className={styles.adsTh}>{label}{tip && <HeaderTip label={label} tip={tip} />}</span>
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
      /* WHAT THIS MARKET WOULD HOLD IF BUDGET FOLLOWED PLAYERS, against what it holds. Positive
       * is over. It is the same arithmetic the points version did, in the unit anyone would act
       * in: "$1,175 more than its players justify" is a decision, "−15.0 points" is homework. */
      over: overUnderCents(r.spendCents, fairShareCents(r.becamePlayers, totals?.becamePlayers ?? 0, totals?.spendCents ?? 0)),
    };
  }), [rows, windowDays, blended, totals]);

  /* ── THE ARITHMETIC, ON THE MARKET AT THE TOP OF THE SORT ───────────────────────────────────
   * "Red means it's taking more than its share" states the idea and leaves the number unprovable.
   * This walks the calculation on a row the reader can see, so the column can be checked rather
   * than believed.
   *
   * DERIVED, NOT WRITTEN INTO THE COPY. A hardcoded worked example is right for one window and
   * silently wrong for every other one — every figure in it moves when the range changes — and a
   * worked example that disagrees with the table it sits above is worse than none.
   *
   * THE SHARE IS SHOWN TO TWO DECIMALS ON PURPOSE. At one, "6.2% of $7,830" multiplies out to
   * $486 against the $484 on the row, and a reader checking the sum would find it did not. The
   * money comes from the exact share either way; two decimals is what makes the printed version
   * reconcile. */
  const overUnderTip = useMemo(() => {
    const idea = "This market's share of new players, applied to total spend, is its fair share. Over / under is what it actually spent minus that.";
    const legend = "Red means it's spending more than its players justify.";
    const top = view[0];
    if (!top || !totals || totals.becamePlayers <= 0 || totals.spendCents <= 0) {
      return <><p>{idea}</p><p>{legend}</p></>;
    }
    const { r, over } = top;
    const share = r.becamePlayers / totals.becamePlayers;
    const fair = share * totals.spendCents;
    return (
      <>
        <p>{idea}</p>
        <p className={styles.adsTipEg} data-testid="ads-tip-example">
          {CITY_LABEL[r.marketKey] ?? r.marketKey}: {fmtInt(r.becamePlayers)} of{" "}
          {fmtInt(totals.becamePlayers)} new players is {(share * 100).toFixed(2)}%.{" "}
          {(share * 100).toFixed(2)}% of {money0(totals.spendCents)} is {money0(fair)}. It spent{" "}
          {money0(r.spendCents)}, so {over == null ? "—" : `${over > 0 ? "+" : "−"}${money0(Math.abs(over))}`}.
        </p>
        <p>{legend}</p>
      </>
    );
  }, [view, totals]);

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
                    <Th label="Spend" tip="What Meta charged for ads shown in this market." />
                    <Th label="Installs" tip="App installs from this market's ads. Meta won't say which city an install came from, so we credit it to the market its ad set was targeting." />
                    <Th label="CPI" tip="Spend divided by installs. The two are counted slightly differently, so treat it as close rather than exact." />
                    {allCols && <Th label="Regs" tip="People who signed up here, whether they've played yet or not." />}
                    {/* THE RECONCILIATION POINT TRAVELS WITH THE NUMBER. It was a footnote under
                        the table carrying live counts; it is now the last sentence of this
                        definition, where someone reading the column will actually meet it. */}
                    <Th label="New players" tip="People who signed up in this market and have since played a match. Includes everyone, not just people the ads brought in. Markets we don't buy ads in are left out of this table, so these don't add up to the company total." />
                    {/* NO BAR BESIDE IT. The figure is already the largest thing on the row and
                        colour-coded; a bar re-encoding the same number across seven rows added a
                        column and no information. */}
                    <Th label="Cost per new player" className={styles.adsHeadKey}
                      tip="Spend divided by every new player in the market, including ones who found us on their own. Use it to compare markets, not as what a player costs to acquire." />
                    {allCols && <Th label="7d" tip="New players who played within 7 days of signing up. These don't change as time passes, so they're safe to compare across dates." />}
                    {allCols && <Th label="30d" tip="New players who played within 30 days of signing up. These don't change as time passes, so they're safe to compare across dates." />}
                    {allCols && <Th label="Home" tip="How much of this market's spend Meta served inside the market." />}
                    {allCols && <Th label="Unattributed" tip="Spend Meta wouldn't tell us the location of. Not money that went elsewhere, money with no location attached." />}
                    {allCols && <Th label="Other" tip="Spend served into other named markets." />}
                    {/* IN MONEY, NOT POINTS. "Share of players less share of spend" asked the
                        reader to turn a percentage-point difference into a budget before it meant
                        anything, and nobody moves points. Same arithmetic, stated as dollars. */}
                    <Th label="Over / under" className={styles.adsHeadKey} tip={overUnderTip} />
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
                    {/* NO TOTAL. The fair shares partition the same total the actual spends do,
                        so the column sums to zero by construction and printing it would be
                        printing an identity, not a measurement. */}
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* NOTHING UNDER THE TABLE. The "paid markets only" footnote is now the last line of
                the New players definition, where it travels with the number it qualifies, and the
                "Registrations, 7d and 30d…" link duplicated the All columns button sitting in the
                controls above. Two lines of chrome for one button and one sentence. */}
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

type ViewRow = { r: MarketRow; span: number; dark: boolean; cpnp: number | null; band: Band | null; over: number | null };

function Row({ v, open, onToggle, windowDays, allCols }: {
  v: ViewRow; open: boolean; onToggle: () => void;
  windowDays: number; allCols: boolean;
}) {
  const { r, band, cpnp, over, dark } = v;
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
        {/* A DARK MARKET IS UNBANDED HERE TOO, for the same reason its rate is. Its spend stopped
            part-way through a window its players accrued across all of, so "under by $X" is
            measuring the stop, not the allocation. The figure is shown and left grey: neutral,
            not a verdict. */}
        <td data-testid="ads-over"
          className={`${styles.adsOverUnder} ${over == null ? "" : dark ? styles.adsKeyDark : over > 0 ? styles.adsKeyBad : styles.adsKeyGood}`}>
          {over == null ? "—" : `${over > 0 ? "+" : "−"}${money0(Math.abs(over))}`}
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
