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
  metaRegistrationsUsable, spendVsAverageExample, META_REG_FROM, rateIsThin, MIN_PLAYERS_FOR_RATE,
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
type Mode = "rebuild" | "floor" | "d30" | "d7" | "custom";
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
const MONTH_DAY = (ymd: string) => shortDay(ymd);
/* META'S REGISTRATION COLUMNS, BLANK RATHER THAN WRONG. A window that starts before the SDK event
 * existed would divide weeks of spend by days of registrations; a dash with a reason on hover is
 * the honest rendering. */
const REG_BLANK_TIP =
  `Meta could not count registrations before ${MONTH_DAY(META_REG_FROM)}, when the in-app signup ` +
  `event went live. This window starts earlier, so these columns would divide a full window of ` +
  `spend by a few days of registrations. Pick a range starting ${MONTH_DAY(META_REG_FROM)} or ` +
  `later to see them.`;
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
function HeaderTip({ label, tip, trigger, triggerClass }: {
  label: string; tip: React.ReactNode;
  /* THE TRIGGER IS USUALLY THE CIRCLED i, and for an in-cell marker it is the marker's own words.
   * Same panel either way: `title` was tried on that marker and it is the same attribute that
   * failed on these headers — about a second of delay, unstyleable, invisible to a keyboard user,
   * suppressed on touch. A marker that looks like it explains itself and does not is worse than
   * no marker. */
  trigger?: React.ReactNode; triggerClass?: string;
}) {
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
        className={triggerClass ?? styles.adsTipBtn}
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
        {trigger ?? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.01" />
          </svg>
        )}
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

/* ── THE WORKED EXAMPLE, COMPUTED FROM THE ROW IT NAMES ─────────────────────────────────────────
 * Houston unless the window does not contain it, then the biggest spender. Every figure is derived
 * from live data: a hardcoded example is right for one window and quietly wrong for every other,
 * and this one sits inside a tooltip where nobody would notice it had gone stale. */
function SpendVsAverageTip({ example, blended }: { example: ReturnType<typeof spendVsAverageExample>; blended: number | null }) {
  return (
    <>
      <p>
        Compares actual spending with what the same number of new players would cost at the
        company-wide average. Green means you spent less; red means you spent more.
      </p>
      {example && blended != null && (
        <p className={styles.adsTipEg} data-testid="ads-sva-example">
          Example: {CITY_LABEL[example.market] ?? example.market}&rsquo;s {fmtInt(example.players)} new
          players would cost {money0(example.atAverageCents)} at the company average. You spent{" "}
          {money0(example.spendCents)}, which is {money0(Math.abs(example.deltaCents))}{" "}
          {example.deltaCents < 0 ? "less" : "more"}.
        </p>
      )}
    </>
  );
}

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
  /* META'S COLUMNS ARE BLANK FOR A WINDOW THAT PREDATES THE EVENT. Keyed on the window the SERVER
   * actually used, not on what the control asked for, because the route clamps to the floor. */
  const regUsable = data ? metaRegistrationsUsable(data.since) : false;
  const example = useMemo(
    () => spendVsAverageExample(rows, blended),
    [rows, blended],
  );
  const view = useMemo(() => rows.map((r) => {
    const span = r.firstSpend && r.lastSpend ? daysBetween(r.firstSpend, r.lastSpend) : 0;
    const dark = span > 0 && span < windowDays * SHORT_SPAN;
    /* ── NO SPEND IS NOT A COST OF ZERO ──────────────────────────────────────────────────────
     * A market that bought nothing in the window has no cost per new player, and $0.00 is a claim
     * that its players were free. It also banded GREEN, because 0 divided by anything is under
     * the blended rate, so the market that spent nothing read as the best performer on the page.
     * `dark` did not catch it: dark keys on a SHORT SPAN, and a market with no spend at all has
     * a span of zero, so it was never dark to begin with. */
    const noSpend = r.spendCents <= 0;
    const cpnp = noSpend ? null : perUnit(r.spendCents, r.becamePlayers);
    /* A RATE ON A HANDFUL OF PLAYERS KEEPS ITS FIGURE AND LOSES ITS VERDICT. See rateIsThin. */
    const thin = rateIsThin(r.becamePlayers);
    return {
      r, span, dark, cpnp, noSpend, thin,
      band: thin ? null : costBand(cpnp, blended, dark),
      /* WHAT THIS MARKET WOULD HOLD IF BUDGET FOLLOWED PLAYERS, against what it holds. Positive
       * is over. It is the same arithmetic the points version did, in the unit anyone would act
       * in: "$1,175 more than its players justify" is a decision, "−15.0 points" is homework. */
      over: noSpend
        ? null   // nothing was spent, so there is nothing to compare with the average
        : overUnderCents(r.spendCents, fairShareCents(r.becamePlayers, totals?.becamePlayers ?? 0, totals?.spendCents ?? 0)),
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
            /* STATED, NOT DROPPED. The line used to omit the figure entirely on a window Meta
             * cannot answer for, which leaves a reader counting five items where there were six
             * and wondering which one they misread. Saying "none before Sep 12" costs four words
             * and answers the question the gap was raising. */
            ? `${money0(totals.spendCents)} spend · ${fmtInt(totals.installs)} installs · ${regUsable ? `${fmtInt(totals.metaRegistrations)} registrations from ads` : `no registrations from ads before ${shortDay(META_REG_FROM)}`} · ${fmtInt(totals.registrations)} all registrations · ${fmtInt(totals.becamePlayers)} new players · ${money2(blended)} blended`
            : "…"}
        </span>
        <div className={styles.adsControls}>
          <div className={styles.adsPills} data-testid="ads-presets">
            {/* ── SINCE REBUILD, AND IT DOES NOT EXIST YET ────────────────────────────────────
                Rendered only when the server found a registration-optimized ad set that has
                actually spent. Today none has: the live cohort is APP_INSTALLS and the old
                conversion cohort stopped on 2026-08-28, before the event it would have optimised
                for existed. A preset that is always there and always empty teaches nothing; one
                that appears the day the data does is the control doing its job. */}
            {data?.rebuildStart && (
              <button type="button" data-testid="ads-preset-rebuild"
                title={`The first day a registration-optimized ad set spent (${shortDay(data.rebuildStart)}).`}
                className={mode === "rebuild" ? `${styles.adsPill} ${styles.adsPillOn}` : styles.adsPill}
                onClick={() => preset("rebuild", data.rebuildStart!)}>Since rebuild</button>
            )}
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
          Meta can only credit some signups to ads, so its registrations read low. Our own counts
          include everyone. Recent days are still filling, so cost per new player reads too
          expensive.
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
                  {/* ── TWO GROUPS, SO THE SOURCE IS OBVIOUS ────────────────────────────────────
                      Six of the nine columns are two different measurements of the same thing, and
                      the page never said which came from where. Meta counts what Meta can credit;
                      we count everyone. Spend sits outside both because Meta is the only possible
                      source for it, and Spend vs. average sits outside because it is derived from
                      both sides at once. */}
                  <tr className={styles.adsGroupRow} data-testid="ads-group-row">
                    <th colSpan={2} />
                    <th colSpan={4} className={styles.adsGroupMeta} data-testid="ads-group-meta">From Meta</th>
                    {/* 7d and 30d are ours; Home, Unattributed and Other are Meta's view of where
                        it served the money, so under All columns they get their own Meta group
                        rather than being labelled as ours for being positioned late. */}
                    <th colSpan={allCols ? 5 : 3} className={styles.adsGroupOurs} data-testid="ads-group-ours">From our data</th>
                    {allCols && <th colSpan={3} className={styles.adsGroupMeta} data-testid="ads-group-meta2">From Meta</th>}
                    <th className={styles.adsGroupEdge} />
                  </tr>
                  <tr>
                    <Th label="Market" />
                    <Th label="Spend" tip="What Meta charged for ads shown in this market." />

                    {/* ── FROM META ──────────────────────────────────────────────────────────── */}
                    <Th label="Installs" className={styles.adsGroupStart}
                      tip="App installs from this market's ads. Meta won't say which city an install came from, so we credit it to the market its ad set was targeting." />
                    <Th label="CPI" tip="Spend divided by installs. The two are counted slightly differently, so treat it as close rather than exact." />
                    <Th label="Registrations from ads"
                      tip={regUsable
                        ? "Signups Meta could connect to someone clicking or seeing an ad. Meta receives every signup but can only credit some of them to ads, so this is lower than the real number from ads, never higher."
                        : REG_BLANK_TIP} />
                    <Th label="Cost / reg"
                      tip={regUsable
                        ? "Spend divided by registrations from ads. Reads high, because Meta can't credit every signup the ads brought in."
                        : REG_BLANK_TIP} />

                    {/* ── FROM OUR DATA ──────────────────────────────────────────────────────── */}
                    {/* ALL REGISTRATIONS IS NO LONGER BEHIND "All columns". The two registration
                        counts only mean anything beside each other: one of them alone is a number
                        with no scale. */}
                    <Th label="All registrations" className={styles.adsGroupStart}
                      tip="Everyone who signed up in this market, counted in our own data, whether or not an ad brought them." />
                    <Th label="New players"
                      tip="People who signed up in this market and have since played a match. Includes everyone, not just people the ads brought in. Markets we don't buy ads in are left out of this table, so these don't add up to the company total." />
                    <Th label="Cost / new player" className={styles.adsHeadKey}
                      tip="Spend divided by every new player in the market, including ones who found us on their own. Use it to compare markets, not as what a player costs to acquire." />
                    {allCols && <Th label="7d" tip="New players who played within 7 days of signing up. These don't change as time passes, so they're safe to compare across dates." />}
                    {allCols && <Th label="30d" tip="New players who played within 30 days of signing up. These don't change as time passes, so they're safe to compare across dates." />}
                    {allCols && <Th label="Home" className={styles.adsGroupStart} tip="How much of this market's spend Meta served inside the market." />}
                    {allCols && <Th label="Unattributed" tip="Spend Meta wouldn't tell us the location of. Not money that went elsewhere, money with no location attached." />}
                    {allCols && <Th label="Other" tip="Spend served into other named markets." />}

                    <Th label="Spend vs. average" className={`${styles.adsHeadKey} ${styles.adsGroupStart}`}
                      tip={<SpendVsAverageTip example={example} blended={blended} />} />
                  </tr>
                </thead>
                <tbody>
                  {view.map((v) => (
                    <Row key={v.r.marketKey} v={v} open={open === v.r.marketKey} allCols={allCols} regUsable={regUsable}
                      onToggle={() => setOpen((o) => (o === v.r.marketKey ? null : v.r.marketKey))}
                      windowDays={windowDays} />
                  ))}
                  <tr className={styles.adsTotal} data-testid="ads-total-row">
                    <td>Total</td>
                    <td>{money0(totals?.spendCents ?? 0)}</td>
                    <td className={styles.adsGroupStart}>{fmtInt(totals?.installs ?? 0)}</td>
                    <td className={styles.adsMuted}>{money2(perUnit(totals?.spendCents ?? 0, totals?.installs ?? 0))}</td>
                    <td>{regUsable ? fmtInt(totals?.metaRegistrations ?? 0) : "—"}</td>
                    <td className={styles.adsMuted}>{regUsable ? money2(perUnit(totals?.spendCents ?? 0, totals?.metaRegistrations ?? 0)) : "—"}</td>
                    <td className={styles.adsGroupStart}>{fmtInt(totals?.registrations ?? 0)}</td>
                    <td>{fmtInt(totals?.becamePlayers ?? 0)}</td>
                    <td className={styles.adsKey}>{money2(blended)}</td>
                    {allCols && <td>{fmtInt(totals?.playedWithin7d ?? 0)}</td>}
                    {allCols && <td>{fmtInt(rows.reduce((a, r) => a + r.playedWithin30d, 0))}</td>}
                    {allCols && <td className={styles.adsGroupStart} colSpan={3} />}
                    {/* NO TOTAL. The fair shares partition the same total the actual spends do,
                        so the column sums to zero by construction and printing it would be
                        printing an identity, not a measurement. */}
                    <td className={styles.adsGroupStart} />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* ── ONE LINE, AND ONLY WHEN THE COLUMNS ARE BLANK ───────────────────────────────
                Two dashed columns with the reason only on hover read as broken data. A reader who
                does not hover concludes the pull is failing, which is the opposite of what the
                dashes mean. It names the presets that DO answer, so the next click is obvious
                rather than a hunt. It disappears entirely on a window that has the data, because
                a permanent caveat is a caveat nobody reads. */}
            {!regUsable && (
              <div className={styles.adsBlankNote} data-testid="ads-reg-blank-note">
                Meta could not see registrations before {shortDay(META_REG_FROM)}, so this window
                has none to show. Pick{" "}
                {data.rebuildStart && (<><b>Since rebuild</b> or </>)}<b>7d</b>.
              </div>
            )}
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

type ViewRow = { r: MarketRow; span: number; dark: boolean; cpnp: number | null; band: Band | null; over: number | null; noSpend: boolean; thin: boolean };

function Row({ v, open, onToggle, windowDays, allCols, regUsable }: {
  v: ViewRow; open: boolean; onToggle: () => void;
  windowDays: number; allCols: boolean;
  /** False when the window starts before Meta could count registrations. See REG_BLANK_TIP. */
  regUsable: boolean;
}) {
  const { r, band, cpnp, over, dark, thin } = v;
  const keyCls = band ? KEY_CLASS[band] : "";
  const dupes = duplicateNames(r.adsets);
  const maxServed = Math.max(1, ...r.served.map((s) => s.spendCents));
  // Two bar columns went; the expansion spans what is left.
  const cols = 10 + (allCols ? 5 : 0);

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
        <td className={styles.adsGroupStart}>{r.installs == null ? "—" : fmtInt(r.installs)}</td>
        <td className={styles.adsMuted} data-testid="ads-cpi">{money2(perUnit(r.spendCents, r.installs))}</td>
        {/* BLANK, NOT ZERO, FOR A WINDOW THAT PREDATES THE EVENT. See REG_BLANK_TIP. */}
        <td data-testid="ads-metareg">{!regUsable ? <span className={styles.adsMuted} title={REG_BLANK_TIP}>—</span> : r.metaRegistrations == null ? "—" : fmtInt(r.metaRegistrations)}</td>
        <td className={styles.adsMuted} data-testid="ads-costreg">
          {!regUsable ? <span title={REG_BLANK_TIP}>—</span> : money2(perUnit(r.spendCents, r.metaRegistrations))}
        </td>
        <td className={styles.adsGroupStart} data-testid="ads-allreg">{fmtInt(r.registrations)}</td>
        <td data-testid="ads-newplayers">{fmtInt(r.becamePlayers)}</td>
        <td className={`${styles.adsKey} ${keyCls}`} data-testid="ads-cpnp">
          {money2(cpnp)}
          {/* THE FIGURE STAYS, THE VERDICT GOES. An operator watching a new market wants to see
              the first numbers arrive; what they must not get is a colour telling them what the
              numbers mean while one player still moves the answer by a tenth. */}
          {thin && cpnp != null && (
            <>
              {" "}
              <HeaderTip label="too few" triggerClass={styles.adsThin}
                trigger={<span data-testid="ads-thin">too few</span>}
                tip={
                  <>
                    {/* IT READS LIKE META'S LEARNING PHASE AND IT IS NOT. Saying what it is not is
                        the first line, because that is the wrong reading a reader arrives with. */}
                    <p>
                      Nothing to do with Meta&rsquo;s learning phase. This is our own count:{" "}
                      {CITY_LABEL[r.marketKey] ?? r.marketKey} has {fmtInt(r.becamePlayers)} new
                      player{r.becamePlayers === 1 ? "" : "s"} in this window, too few for the cost
                      figure to be reliable.
                    </p>
                    <p>
                      One more or fewer would move it by{" "}
                      {Math.round(100 / r.becamePlayers)}%. We stop ranking a market below{" "}
                      {MIN_PLAYERS_FOR_RATE} new players, which is where one arrival stops moving
                      the answer by more than a tenth. The figure is still shown; only the colour
                      ranking it is withheld.
                    </p>
                  </>
                } />
            </>
          )}
        </td>
        {allCols && <td>{fmtInt(r.playedWithin7d)}</td>}
        {allCols && <td>{fmtInt(r.playedWithin30d)}</td>}
        {allCols && <td className={styles.adsGroupStart}>{pct(shareOf(r.homeCents, r.spendCents))}</td>}
        {allCols && <td className={r.unknownCents > 0 ? styles.adsUnknown : undefined}>{pct(shareOf(r.unknownCents, r.spendCents))}</td>}
        {allCols && <td>{pct(shareOf(r.otherNamedCents, r.spendCents))}</td>}
        {/* A DARK MARKET IS UNBANDED HERE TOO, for the same reason its rate is. Its spend stopped
            part-way through a window its players accrued across all of, so "under by $X" is
            measuring the stop, not the allocation. The figure is shown and left grey: neutral,
            not a verdict. */}
        {/* A DARK MARKET IS A DASH, not a number. Its spend stopped part-way through a window its
            players accrued across all of, so the comparison measures the stop. */}
        <td data-testid="ads-over"
          className={`${styles.adsOverUnder} ${styles.adsGroupStart} ${over == null || dark ? "" : over > 0 ? styles.adsKeyBad : styles.adsKeyGood}`}>
          {over == null || dark ? <span className={styles.adsMuted}>—</span> : `${over > 0 ? "+" : "−"}${money0(Math.abs(over))}`}
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
                        {/* ── THE ATTRIBUTION WINDOW, ON THE LINE ─────────────────────────────
                            Six of the seven live ad sets are 1-day click only; Atlanta's Android
                            one also carries 1-day view and 1-day engaged video view, so Meta can
                            credit it for a signup nobody clicked. Its cost per registration sits
                            on a looser basis than its neighbours', and without this the two read
                            like the same measurement. */}
                        {a.attribution && (
                          <span className={styles.adsMuted} data-testid="ads-adset-attribution"
                            title="The windows Meta will credit a registration against. A wider window credits more signups to the same spend, so a cost per registration is only comparable with an ad set on the same windows.">
                            {" "}· {a.attribution}
                          </span>
                        )}
                      </span>
                      {/* SPEND WITH NOTHING TO SHOW FOR IT is the actionable line in this list —
                          five of Houston's seven ad sets, $674 of its $1,799 — and the first cut
                          did not mark it at all. */}
                      <span className={`${styles.adsLineVal} ${dead ? styles.adsDead : ""}`} data-testid="ads-adset-installs"
                        style={{ width: 200 }}>
                        {money0(a.spendCents)} · {a.installs == null ? "—" : dead ? "no installs" : `${fmtInt(a.installs)} installs`}
                        {regUsable && a.registrations != null && a.registrations > 0 && ` · ${fmtInt(a.registrations)} regs`}
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
