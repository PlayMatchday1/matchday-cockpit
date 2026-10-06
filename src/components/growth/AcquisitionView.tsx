"use client";

/* ACQUISITION — where new players come from (Ryan, 2026-10-04; redesigned the same day to be read
 * in ten seconds). Replaces the Ads page; /lifecycle/ads redirects here.
 *
 *   date bar · "Data through" (hover: each source) · "skewed by ads" before Jul 15
 *   four tiles: First-time players, Registrations, Ad spend, Website store clicks
 *   (Ryan, 2026-10-05, from the mock) three tables:
 *     Meta ads             a row per market: Meta's spend / installs / registrations / cost per
 *                          registration beside our own registrations and first-time players
 *     Website              a row per market (Google rank first), expandable to its pages and the exact
 *                          rank queries; Homepage and site-wide; Other pages (collapsed); whole-site Total
 *     iPhone downloads by source  Apple's first-time downloads (lib/acquisitionModel.downloadsTable):
 *                          Standard's top-level rows, always complete; Detailed's sub-rows only when
 *                          Detailed covers every day of the range (Ryan, 2026-10-06)
 *
 * NO EXPLANATORY TEXT ON THE PAGE. Caveats live in (i) tooltips, in Ryan's exact wording (TIP). Every
 * source is compared on the days it has data for (lib/acquisitionModel.sourceWindows). Target badges
 * (green / amber / red) read lib/acquisitionTargets.
 */

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./growth.module.css";
import { fmtInt } from "./format";
import {
  MILESTONES, SKEWED_BEFORE, clickRate, costPer, presetRange, sameDaysLastMonth,
  type DownloadsTable, type DlSub, type DlTag, type DlTop, type Group, type MarketRowView, type Measures, type PageLine, type Preset, type RankedPage,
  type SourceKey, type SourceWindow, type WebsiteTable, type Window,
} from "@/lib/acquisitionModel";
import { clickRateBand, cprBand, rankBand, type Band } from "@/lib/acquisitionTargets";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (ymd: string | null | undefined) => { if (!ymd) return "—"; const [, m, d] = ymd.split("-"); return `${MON[Number(m) - 1]} ${Number(d)}`; };
const todayChicago = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const money = (c: number | null | undefined) => (c == null ? "—" : `$${Math.round(c / 100).toLocaleString("en-US")}`);
const money2 = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

type Totals = {
  spendCents: number | null; installs: number | null; metaRegs: number | null; regSpendCents: number;
  registrations: number; firstTime: number; web: Measures;
};

/* EVERY (i) IN ONE PLACE, in Ryan's exact wording (2026-10-06). */
const TIP = {
  spend: "What we paid Meta in this period. Data starts Aug 1.",
  installs: "App installs Meta says came from our ads. Meta's own count.",
  metaRegs: "Sign-ups Meta says came from our ads. Meta's own count, from Sep 12.",
  cpr: "Ad spend divided by Meta registrations. Target: under $5.",
  allRegs: "Every new sign-up in this market, from any source.",
  firstTime: "People who played their first MatchDay match in this period, from any source.",
  rank: "Where our city page shows on Google for \"pickup soccer [city]\". 1 is the top. Lower is better. Target: 3 or better.",
  searchClicks: "People who clicked through to us from Google search.",
  visits: "Visits to these pages on our website.",
  storeClicks: "Taps on the App Store or Google Play button. Wanting to download, not a download yet.",
  clickRate: "Store clicks divided by visits. Target: 20% or more.",
  webDownloads: "iPhone downloads Apple says came from our website.",
  iphone: "First-time iPhone downloads, counted by Apple. Android comes later.",
  share: "Percent of all iPhone downloads.",
  cost: "What we paid for this source.",
  apps: "People who tapped through from another app, mostly Instagram and Facebook. Includes ads and normal posts.",
  web: "People who tapped through from a website: share links, our site, or Google.",
  search: "People who searched in the App Store and downloaded.",
  browse: "People who found us browsing the App Store.",
  other: "Downloads Apple can't place, including small numbers it hides for privacy.",
};
/* THE EXCLUSION (0208), stated in the All registrations tooltip (Ryan, 2026-10-06; it replaced the
 * "Not counted …" line under the Meta table). Re-registrations are still left out of every count but
 * are not mentioned on the page. */
const allRegsTip = (internal: number) => `${TIP.allRegs} Staff, test and fake accounts are left out (${fmtInt(internal)} this period).`;
const totalTip = (outsideUS: number, poland: number) =>
  "All first-time iPhone downloads." + (outsideUS > 0 ? ` Includes ${fmtInt(outsideUS)} from outside the US (${fmtInt(poland)} from Poland, the licensee).` : "");
const FIRST_LABEL = "First-time players";
type Payload = {
  since: string; until: string;
  windows: Record<SourceKey, SourceWindow>;
  freshness: Record<SourceKey, string | null>;
  current: { website: WebsiteTable };
  compare: { website: WebsiteTable } | null;
  markets: MarketRowView[];
  totals: { cur: Totals; prev: Totals | null };
  notAttributed: { cur: number; prev: number | null };
  metaWindow: { cur: Window | null; regSince: string | null };
  site: { cur: Group | null; prev: Group | null };
  cities: { cur: Group | null; prev: Group | null };
  otherPages: { cur: Group | null; prev: Group | null };
  excluded: { internal: number; reRegistrations: number };
  downloads: null | {
    window: Window;
    cur: DownloadsTable; prev: DownloadsTable | null;
    web: { cur: WebDl; prev: WebDl | null };
    webFallback: boolean;
    splitStart: string | null;
  };
};
type WebDl = { byRow: Record<string, number>; site: number; est: number | null };

function change(cur: number | null | undefined, prev: number | null | undefined): string | null {
  if (cur == null || prev == null) return null;
  if (prev === 0) return cur === 0 ? null : "new";   // nothing against nothing is not a change
  const d = Math.round(((cur - prev) / prev) * 100);
  return `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)}%`;
}
/** The change, small, under its number. `invert` for figures where lower is better. */
function Chg({ cur, prev, invert }: { cur: number | null | undefined; prev: number | null | undefined; invert?: boolean }) {
  const t = change(cur, prev);
  if (t == null) return null;
  const up = t.startsWith("+") || t === "new", down = t.startsWith("−");
  const cls = (invert ? down : up) ? "up" : (invert ? up : down) ? "down" : "flat";
  return <span className={`acq-chg ${cls}`} data-testid="acq-chg">{t}</span>;
}
/* THE TOOLTIP (Ryan, 2026-10-06: the browser's title hover was slow and never opened on a phone).
 * Opens at once on mouse hover, on tap (touch) or on Enter / Space; closes on mouse leave, a tap
 * anywhere else, scroll or Escape. One open at a time. Rendered into <body> with fixed position, so a
 * table's scroll box never clips it, and kept inside the viewport, at most 260px wide. */
let closeOpenTip: (() => void) | null = null;
function Info({ tip, children, testId }: { tip: string; children?: React.ReactNode; testId?: string }) {
  const btn = useRef<HTMLButtonElement>(null), box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const pointer = useRef<string>("mouse");
  const hide = useRef(() => { setOpen(false); setPos(null); }).current;
  const show = () => { if (closeOpenTip && closeOpenTip !== hide) closeOpenTip(); closeOpenTip = hide; setOpen(true); };
  useLayoutEffect(() => {
    if (!open || !btn.current || !box.current) return;
    const r = btn.current.getBoundingClientRect(), b = box.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - b.width / 2, vw - b.width - 8));
    const top = r.top - b.height - 8 >= 8 ? r.top - b.height - 8 : r.bottom + 8;
    setPos({ left, top });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !box.current?.contains(t)) hide(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide);
      if (closeOpenTip === hide) closeOpenTip = null;
    };
  }, [open, hide]);
  return (
    <>
      <button type="button" ref={btn} className={children ? "acq-tipbtn" : "acq-i"} aria-label={children ? undefined : "More info"} aria-expanded={open}
        data-testid={testId ?? "acq-i"}
        onPointerDown={(e) => { pointer.current = e.pointerType; }}
        onPointerEnter={(e) => { if (e.pointerType === "mouse") show(); }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") hide(); }}
        onClick={(e) => { e.stopPropagation(); if (e.detail !== 0 && pointer.current === "mouse") show(); else if (open) hide(); else show(); }}>
        {children ?? "i"}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div ref={box} role="tooltip" data-testid="acq-tip"
          style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden", zIndex: 1000,
            maxWidth: "min(260px, calc(100vw - 16px))", width: "max-content", boxSizing: "border-box", background: "#003326", color: "#fff",
            font: "400 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif", letterSpacing: "normal", textTransform: "none", textAlign: "left",
            whiteSpace: "pre-line", padding: "9px 12px", borderRadius: 10, boxShadow: "0 6px 18px rgba(0,0,0,.18)", pointerEvents: "none" }}>
          {tip}
        </div>, document.body)}
    </>
  );
}
/** A value on a soft target badge (green / amber / red); plain when there is no band. */
function Badge({ band, children }: { band: Band | null; children: React.ReactNode }) {
  return band ? <span className={`acq-badge ${band}`} data-testid="acq-badge" data-band={band}>{children}</span> : <>{children}</>;
}
function Cell({ v, cur, prev, invert, cls, band }: { v: React.ReactNode; cur?: number | null; prev?: number | null; invert?: boolean; cls?: string; band?: Band | null }) {
  return <td className={cls}><span className="acq-n"><Badge band={band ?? null}>{v}</Badge></span><Chg cur={cur} prev={prev} invert={invert} /></td>;
}

const SOURCE_NAME: Record<SourceKey, string> = { gsc: "Google Search", web: "Website analytics", app: "App analytics", meta: "Meta", apple: "App Store" };

export default function AcquisitionView({ authHeaders }: { authHeaders: Record<string, string> }) {
  const today = todayChicago();
  const [preset, setPreset] = useState<Preset>("mtd");
  const [custom, setCustom] = useState(() => presetRange("mtd", today));
  const [compareOn, setCompareOn] = useState(true);
  const range = preset === "custom" ? custom : presetRange(preset, today);
  const cmp = useMemo(() => (compareOn ? sameDaysLastMonth(range.since, range.until) : null), [compareOn, range.since, range.until]);

  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // The sign-in header arrives a moment after mount; asking before it only earns a 401.
    if (!authHeaders.Authorization && !authHeaders.authorization) return;
    setErr(null);
    const qs = new URLSearchParams({ since: range.since, until: range.until, ...(cmp ? { compare: "1" } : {}) });
    fetch(`/api/lifecycle/acquisition?${qs}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j.error) setErr(j.error); else setData(j); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [range.since, range.until, cmp, authHeaders]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const t = data?.totals.cur, tp = compareOn ? data?.totals.prev ?? null : null;
  const web = data?.current.website.total, webP = compareOn ? data?.compare?.website.total : undefined;
  // "Data through": the latest day any live source has; the hover lists each source's own day.
  const through = data ? (["gsc", "web", "app", "meta", "apple"] as SourceKey[]).map((k) => data.freshness[k]).filter(Boolean).sort().pop() : null;
  const throughTip = data
    ? (["gsc", "web", "app", "meta", "apple"] as SourceKey[]).map((k) => `${SOURCE_NAME[k]}: ${data.freshness[k] ? short(data.freshness[k]) : "waiting for Apple"}`).join("\n")
      + "\nApp Store runs 1 to 2 days behind.\nOur players: today"
      + "\nEach source is compared on the days it has data for."
    : "";
  const dl = data?.downloads ?? null;
  const webDl = dl?.web.cur ?? null, webDlP = compareOn ? dl?.web.prev ?? null : null;
  /* A Website row's downloads: its tagged count, or "—" (never 0) when it has none. */
  const rowDl = (key: string) => (webDl ? { n: webDl.byRow[key] || null, p: webDlP ? webDlP.byRow[key] ?? 0 : null } : undefined);
  /* The Website total: Apple's playmatchday.com count, or — once the fallback is on (Oct 13 with the
   * site still unnamed in Apple's daily feed) — the estimate, marked "est.". */
  const fb = !!dl?.webFallback;
  const siteDl = webDl ? { n: (fb ? webDl.est : webDl.site) || null, p: webDlP ? (fb ? webDlP.est : webDlP.site) : null, est: fb } : undefined;

  return (
    <div className="acq" data-testid="acq">
      <style>{CSS}</style>

      {/* ── 1 · DATE BAR ────────────────────────────────────────────────────────────────────── */}
      <div className="acq-bar" data-testid="acq-datebar">
        <span className={styles.adsPills}>
          {([["mtd", "MTD"], ["last", "Last month"], ["d7", "7d"], ["d30", "30d"], ["custom", "Custom"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-testid={`acq-preset-${k}`}
              className={preset === k ? `${styles.adsPill} ${styles.adsPillOn}` : styles.adsPill}
              onClick={() => { if (k === "custom") setCustom(range); setPreset(k); }}>{label}</button>
          ))}
        </span>
        {preset === "custom" && (
          <span className="acq-dates">
            <input type="date" className={styles.adsBtn} aria-label="From" data-testid="acq-since" value={custom.since} max={custom.until}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, since: e.target.value }))} />
            <input type="date" className={styles.adsBtn} aria-label="To" data-testid="acq-until" value={custom.until} min={custom.since} max={today}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, until: e.target.value }))} />
          </span>
        )}
        <select className={`${styles.adsBtn} acq-ms`} data-testid="acq-milestones" value="" aria-label="Milestones"
          onChange={(e) => { const d = e.target.value; if (d) { setCustom({ since: d, until: today }); setPreset("custom"); } }}>
          <option value="">Milestones</option>
          {MILESTONES.map((m) => <option key={m.day} value={m.day}>{m.label}</option>)}
        </select>
        <label className="acq-cmp" data-testid="acq-compare">
          <input type="checkbox" checked={compareOn} onChange={(e) => setCompareOn(e.target.checked)} /> vs same days last month
        </label>
        {range.since < SKEWED_BEFORE && <Info tip="Website traffic before Jul 15 included Meta ads." testId="acq-skewed"><span className="acq-tag">skewed by ads</span></Info>}
        <span className="acq-throughwrap"><Info tip={throughTip} testId="acq-through"><span className="acq-through">Data through {short(through)}</span></Info></span>
      </div>

      {err && <div className={`${styles.stateMsg} ${styles.errorMsg}`} data-testid="acq-error">Could not load: {err}</div>}
      {!data && !err && <div className={styles.stateMsg}>Loading…</div>}

      {data && t && (
        <>
          {/* ── 2 · FOUR TILES ──────────────────────────────────────────────────────────────── */}
          <div className="acq-tiles" data-testid="acq-tiles">
            <Tile k={FIRST_LABEL} tip={TIP.firstTime} v={fmtInt(t.firstTime)} cur={t.firstTime} prev={tp?.firstTime} />
            <Tile k="Registrations" tip={allRegsTip(data.excluded.internal)} v={fmtInt(t.registrations)} cur={t.registrations} prev={tp?.registrations} />
            <Tile k="Ad spend" v={money(t.spendCents)} cur={t.spendCents} prev={tp?.spendCents} />
            <Tile k="Website store clicks" v={fmtInt(web?.storeClicks ?? 0)} cur={web?.storeClicks} prev={webP?.storeClicks} />
          </div>

          {/* ── 3 · META ADS ────────────────────────────────────────────────────────────────── */}
          <section className={`${styles.card} acq-card`} data-testid="acq-meta">
            <h2 className="acq-h2">Meta ads</h2>
            <div className={styles.tableWrap}>
              <table className={`${styles.adsTable} acq-table`}>
                <thead><tr>
                  <th>Market</th>
                  <th>Ad spend <Info tip={TIP.spend} /></th>
                  <th>Meta installs <Info tip={TIP.installs} /></th>
                  <th>Meta registrations <Info tip={TIP.metaRegs} /></th>
                  <th>Cost per registration <Info tip={TIP.cpr} /></th>
                  <th>All registrations <Info tip={allRegsTip(data.excluded.internal)} /></th>
                  <th>{FIRST_LABEL} <Info tip={TIP.firstTime} /></th>
                </tr></thead>
                <tbody>
                  {data.markets.map((r) => {
                    const p = compareOn ? r.prev : null, m = r.cur.meta, mp = p?.meta ?? null;
                    return (
                      <tr key={r.key} data-testid="acq-meta-row" data-market={r.key}>
                        <td>{r.label}</td>
                        <Cell v={m ? money(m.spendCents) : "—"} cur={m?.spendCents} prev={mp?.spendCents} />
                        <Cell v={m?.installs == null ? "—" : fmtInt(m.installs)} cur={m?.installs} prev={mp?.installs} />
                        <Cell v={m?.metaRegs == null ? "—" : fmtInt(m.metaRegs)} cur={m?.metaRegs} prev={mp?.metaRegs} />
                        <Cell v={money2(m ? costPer(m.regSpendCents, m.metaRegs) : null)} cur={m ? costPer(m.regSpendCents, m.metaRegs) : null} prev={mp ? costPer(mp.regSpendCents, mp.metaRegs) : null} invert band={cprBand(m ? costPer(m.regSpendCents, m.metaRegs) : null)} />
                        <Cell v={fmtInt(r.cur.ours.registrations)} cur={r.cur.ours.registrations} prev={p?.ours.registrations} />
                        <Cell v={fmtInt(r.cur.ours.firstTime)} cur={r.cur.ours.firstTime} prev={p?.ours.firstTime} />
                      </tr>
                    );
                  })}
                  {data.notAttributed.cur > 0 && (
                    <tr data-testid="acq-notattributed">
                      <td className="acq-muted">Spend not tied to a market</td>
                      <Cell v={money(data.notAttributed.cur)} cur={data.notAttributed.cur} prev={compareOn ? data.notAttributed.prev : null} />
                      <td colSpan={5} />
                    </tr>
                  )}
                  <tr className={`${styles.adsTotal} acq-total`} data-testid="acq-meta-total">
                    <td>Total</td>
                    <Cell v={money(t.spendCents)} cur={t.spendCents} prev={tp?.spendCents} />
                    <Cell v={t.installs == null ? "—" : fmtInt(t.installs)} cur={t.installs} prev={tp?.installs} />
                    <Cell v={t.metaRegs == null ? "—" : fmtInt(t.metaRegs)} cur={t.metaRegs} prev={tp?.metaRegs} />
                    <Cell v={money2(costPer(t.regSpendCents, t.metaRegs))} cur={costPer(t.regSpendCents, t.metaRegs)} prev={tp ? costPer(tp.regSpendCents, tp.metaRegs) : null} invert band={cprBand(costPer(t.regSpendCents, t.metaRegs))} />
                    <Cell v={fmtInt(t.registrations)} cur={t.registrations} prev={tp?.registrations} />
                    <Cell v={fmtInt(t.firstTime)} cur={t.firstTime} prev={tp?.firstTime} />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 4 · WEBSITE ─────────────────────────────────────────────────────────────────── */}
          <section className={`${styles.card} acq-card`} data-testid="acq-markets">
            <h2 className="acq-h2">Website</h2>
            <div className={styles.tableWrap}>
              <table className={`${styles.adsTable} acq-table`}>
                <thead><tr>
                  <th>Market</th>
                  <th>Google rank <Info tip={TIP.rank} /></th>
                  <th>Search clicks <Info tip={TIP.searchClicks} /></th>
                  <th>Visits <Info tip={TIP.visits} /></th>
                  <th>Store clicks <Info tip={TIP.storeClicks} /></th>
                  <th>Click rate <Info tip={TIP.clickRate} /></th>
                  <th>iPhone downloads <Info tip={TIP.webDownloads} /></th>
                </tr></thead>
                <tbody>
                  {data.markets.map((r) => {
                    const isOpen = open.has(r.key), p = compareOn ? r.prev : null;
                    return (
                      <Fragment key={r.key}>
                        <tr className="acq-row" data-testid="acq-market" data-market={r.key} aria-expanded={isOpen} onClick={() => toggle(r.key)}>
                          <td><span className="acq-caret">{isOpen ? "▾" : "▸"}</span>{r.label}</td>
                          <RankCell rank={r.cur.rank} prev={p ? p.rank : undefined} badge />
                          <WebCells m={r.cur.web} p={p?.web ?? null} dl={rowDl(r.key)} badge />
                        </tr>
                        {isOpen && (r.pages.length
                          ? r.pages.map((pg) => <PageRow key={pg.path} pg={pg} />)
                          : <tr className="acq-sub"><td colSpan={7} className="acq-muted">No website pages for this market in this range.</td></tr>)}
                      </Fragment>
                    );
                  })}
                  <SiteRow label="Homepage and site-wide" testId="acq-site-home" dl={rowDl("site")} open={open.has("home")} onToggle={() => toggle("home")}
                    groups={[data.site.cur, data.cities.cur]} prevGroups={compareOn ? [data.site.prev, data.cities.prev] : []} />
                  <SiteRow label="Other pages" testId="acq-site-other" dl={rowDl("other")} count open={open.has("other")} onToggle={() => toggle("other")}
                    groups={[data.otherPages.cur]} prevGroups={compareOn ? [data.otherPages.prev] : []} />
                  <tr className={`${styles.adsTotal} acq-total`} data-testid="acq-total">
                    <td>Total</td>
                    <td className="acq-dash">—</td>
                    <WebCells m={t.web} p={tp?.web ?? null} dl={siteDl} badge />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 5 · IPHONE DOWNLOADS BY SOURCE ──────────────────────────────────────────────── */}
          <section className={`${styles.card} acq-card`} data-testid="acq-sources-table">
            <h2 className="acq-h2">iPhone downloads by source</h2>
            <div className={styles.tableWrap}>
              <table className={`${styles.adsTable} acq-table`}>
                <thead><tr>
                  <th>Source</th>
                  <th>iPhone downloads <Info tip={TIP.iphone} /></th>
                  <th>Share <Info tip={TIP.share} /></th>
                  <th>Cost <Info tip={TIP.cost} /></th>
                </tr></thead>
                <tbody>
                  <DownloadRows dl={dl} compareOn={compareOn} />
                </tbody>
              </table>
            </div>
          </section>

        </>
      )}
    </div>
  );
}

function Tile({ k, v, cur, prev, tip, sub }: { k: string; v: string; cur: number | null | undefined; prev: number | null | undefined; tip?: string; sub?: React.ReactNode }) {
  return (
    <div className="acq-tile" data-testid="acq-tile">
      <div className="acq-tk">{k}{tip && <> <Info tip={tip} /></>}</div>
      <div className="acq-tv">{v}</div>
      <Chg cur={cur} prev={prev} />
      {sub && <div className="acq-tsub">{sub}</div>}
    </div>
  );
}

/** Google rank: one decimal; its change is the move in positions, and DOWN is good (green). */
function RankCell({ rank, prev, badge }: { rank: number | null; prev?: number | null; badge?: boolean }) {
  const d = rank != null && prev != null ? Math.round((rank - prev) * 10) / 10 : null;
  // The band reads the number as shown (one decimal), so "3.0" is never amber.
  const band = badge && rank != null ? rankBand(Math.round(rank * 10) / 10) : null;
  return (
    <td data-testid="acq-rank">
      <span className="acq-n"><Badge band={band}>{rank == null ? "—" : rank.toFixed(1)}</Badge></span>
      {d != null && d !== 0 && <span className={`acq-chg ${d < 0 ? "up" : "down"}`} data-testid="acq-chg">{d > 0 ? "+" : "−"}{Math.abs(d).toFixed(1)}</span>}
    </td>
  );
}
/** Search clicks · Visits · Store clicks · Click rate · Downloads — the same five on every row. */
function WebCells({ m, p, dl, badge }: { m: Measures; p: Measures | null; dl?: { n: number | null; p: number | null; est?: boolean }; badge?: boolean }) {
  const cr = clickRate(m);
  // The band reads the rate as shown (whole percent).
  const band = badge && cr != null ? clickRateBand(Math.round(cr * 100) / 100) : null;
  return (
    <>
      <Cell v={fmtInt(m.searchClicks)} cur={m.searchClicks} prev={p?.searchClicks} />
      <Cell v={fmtInt(m.visits)} cur={m.visits} prev={p?.visits} />
      <Cell v={fmtInt(m.storeClicks)} cur={m.storeClicks} prev={p?.storeClicks} />
      <td><span className="acq-n"><Badge band={band}>{cr == null ? "—" : `${Math.round(cr * 100)}%`}</Badge></span></td>
      {dl && dl.n != null
        ? <Cell v={<>{fmtInt(dl.n)}{dl.est && <span className="acq-est" data-testid="acq-web-est"> est.</span>}</>} cur={dl.n} prev={dl.p} />
        : <td className="acq-dash" data-testid="acq-dl-dash">—</td>}
    </>
  );
}
/** A page inside an expanded market: the same columns, then the exact rank queries and positions. */
function PageRow({ pg }: { pg: RankedPage }) {
  return (
    <>
      <tr className="acq-sub" data-testid="acq-page">
        <td title={pg.path}>{pg.label}</td>
        <RankCell rank={pg.rank} />
        <WebCells m={pg} p={null} />
      </tr>
      {pg.queries.length > 0 && (
        <tr className="acq-sub acq-qrow" data-testid="acq-page-queries">
          <td colSpan={7}>{pg.queries.map((q) => (
            <span key={q.query} className="acq-q">“{q.query}” <b>{q.position.toFixed(1)}</b></span>
          ))}</td>
        </tr>
      )}
    </>
  );
}

function sumGroups(gs: (Group | null | undefined)[]): Measures & { pages: PageLine[] } {
  const m = { impressions: 0, px: 0, searchClicks: 0, visits: 0, storeClicks: 0, pages: [] as PageLine[] };
  for (const g of gs) { if (!g) continue; m.impressions += g.impressions; m.px += g.px; m.searchClicks += g.searchClicks; m.visits += g.visits; m.storeClicks += g.storeClicks; m.pages.push(...g.pages); }
  return m;
}
function SiteRow({ label, groups, prevGroups, count, open, onToggle, testId, dl }: {
  label: string; groups: (Group | null)[]; prevGroups: (Group | null)[]; count?: boolean; open: boolean; onToggle: () => void; testId: string;
  dl?: { n: number | null; p: number | null };
}) {
  const m = sumGroups(groups), p = prevGroups.length ? sumGroups(prevGroups) : null;
  return (
    <>
      <tr data-testid={testId} className="acq-row acq-siterow" onClick={onToggle} aria-expanded={open}>
        <td><span className="acq-caret">{open ? "▾" : "▸"}</span>{label}{count && <span className="acq-muted"> · {m.pages.length}</span>}</td>
        <td className="acq-dash">—</td>
        <WebCells m={m} p={p} dl={dl} badge />
      </tr>
      {open && m.pages.map((pg) => (
        <tr key={pg.path} className="acq-sub" data-testid="acq-other-page">
          <td title={pg.path}>{pg.label === pg.path ? pg.path : pg.label}</td>
          <td className="acq-dash">—</td>
          <WebCells m={pg} p={null} />
        </tr>
      ))}
    </>
  );
}

/* THE iPHONE DOWNLOADS TABLE (Ryan, 2026-10-06). Top-level rows are Apple's Standard report and
 * always complete. Sub-rows are Detailed's and appear only when it covers every day of the range
 * (DownloadsTable.split); otherwise the two parents say from which day the breakdown exists. A row
 * compares only against a window with the same shape: a sub-row only when both windows are split.
 * Cost is Meta's iPhone spend over exactly the same days as the downloads. */
const SUB_LABEL: Record<DlSub, string> = {
  igfb: "Instagram and Facebook", otherApps: "Other apps", share: "Player share links", site: "Our website", google: "Google", otherSites: "Other sites",
};
function DownloadRows({ dl, compareOn }: { dl: Payload["downloads"]; compareOn: boolean }) {
  if (!dl) {
    return (<>
      {(["From apps", "From websites", "App Store search", "App Store browse", "Other"]).map((l) => (
        <tr key={l} data-testid="acq-source-row"><td><b>{l}</b></td><td className="acq-dash">—</td><td className="acq-dash">—</td><td /></tr>
      ))}
      <tr className="acq-total" data-testid="acq-source-total"><td>Total</td><td className="acq-dash">—</td><td className="acq-dash">—</td><td /></tr>
    </>);
  }
  const D = dl.cur, P = compareOn ? dl.prev : null, sp = D.split, spP = P?.split ?? null;
  const cost = (c: number | null) => (c == null ? "—" : money(c));
  const row = (o: { key: string; level: 0 | 1 | 2 | 3; label: React.ReactNode; tip?: string; n: number | null; prev?: number | null; cost: string; note?: string | null; flag?: boolean; testId?: string }) => (
    <tr key={o.key} className={o.level ? "acq-dlsub" : undefined} data-testid={o.testId ?? (o.level ? "acq-source-sub" : "acq-source-row")} data-source={o.key} data-level={o.level}>
      <td className={`acq-lvl${o.level}`}>
        {o.level === 0 ? <b>{o.label}</b> : o.label}{o.tip && <> <Info tip={o.tip} /></>}
        {o.flag && <> <Info tip="Meta claims more than Apple counted" testId="acq-meta-over"><span className="acq-flag">!</span></Info></>}
        {o.note && <span className="acq-srcsub" data-testid="acq-split-note">{o.note}</span>}
      </td>
      {o.n == null ? <td className="acq-dash">—</td> : <Cell v={fmtInt(o.n)} cur={o.n} prev={o.prev ?? null} band={o.flag ? "red" : null} />}
      <td>{o.n == null ? <span className="acq-dash">—</span> : <span className="acq-n">{pct(o.n, D.total)}</span>}</td>
      <td><span className="acq-n">{o.cost}</span></td>
    </tr>
  );
  const from = !sp ? (D.splitFrom && D.splitFrom > dl.window.since ? D.splitFrom : dl.splitStart) : null;
  const note = !sp && from ? `Breakdown available from ${short(from)}` : null;
  const subPrev = (k: DlSub) => (sp && spP ? spP.sub[k] : null);
  const tagRows = (under: DlSub | DlTop, level: 2 | 3) => (sp?.tags ?? []).filter((t: DlTag) => t.under === under).map((t) =>
    row({ key: `tag:${under}:${t.tag}`, level, label: t.tag, n: t.n, prev: spP ? spP.tags.find((x) => x.under === under && x.tag === t.tag)?.n ?? 0 : null, cost: "$0", testId: "acq-source-tag" }));
  const out: React.ReactNode[] = [];
  out.push(row({ key: "apps", level: 0, label: "From apps", tip: TIP.apps, n: D.top.apps, prev: P?.top.apps, cost: cost(D.spendCents), note }));
  if (sp) {
    out.push(row({ key: "igfb", level: 1, label: SUB_LABEL.igfb, n: sp.sub.igfb, prev: subPrev("igfb"), cost: cost(D.spendCents), flag: sp.metaOver }));
    if (sp.metaApple != null) out.push(row({ key: "meta-apple", level: 2, label: "Meta ads (Apple's count)", n: sp.metaApple, prev: spP?.metaApple, cost: cost(sp.metaAppleSpendCents) }));
    if (sp.metaEst != null || sp.metaApple == null) out.push(row({ key: "meta-est", level: 2, label: "Meta ads (est.)", n: sp.metaEst, prev: spP?.metaEst, cost: cost(sp.metaEstSpendCents) }));
    out.push(row({ key: "organic", level: 2, label: "Organic (est.)", n: sp.organic, prev: spP?.organic, cost: "$0" }));
    out.push(...tagRows("igfb", 2));
    out.push(row({ key: "otherApps", level: 1, label: SUB_LABEL.otherApps, n: sp.sub.otherApps, prev: subPrev("otherApps"), cost: "$0" }));
    out.push(...tagRows("otherApps", 2));
  }
  out.push(row({ key: "web", level: 0, label: "From websites", tip: TIP.web, n: D.top.web, prev: P?.top.web, cost: "$0", note }));
  if (sp) for (const k of ["share", "site", "google", "otherSites"] as const) {
    out.push(row({ key: k, level: 1, label: SUB_LABEL[k], n: sp.sub[k], prev: subPrev(k), cost: "$0" }));
    out.push(...tagRows(k, 2));
  }
  out.push(row({ key: "search", level: 0, label: "App Store search", tip: TIP.search, n: D.top.search, prev: P?.top.search, cost: "$0" }));
  if (sp) out.push(...tagRows("search", 2));
  out.push(row({ key: "browse", level: 0, label: "App Store browse", tip: TIP.browse, n: D.top.browse, prev: P?.top.browse, cost: "$0" }));
  if (sp) out.push(...tagRows("browse", 2));
  out.push(row({ key: "other", level: 0, label: "Other", tip: TIP.other, n: D.top.other, prev: P?.top.other, cost: "$0" }));
  if (sp) out.push(...tagRows("other", 2));
  out.push(
    <tr key="total" className="acq-total" data-testid="acq-source-total">
      <td>Total <Info tip={totalTip(D.outsideUS, D.poland)} /></td>
      <Cell v={fmtInt(D.total)} cur={D.total} prev={P?.total} />
      <td><span className="acq-n">100%</span></td>
      <td><span className="acq-n">{cost(D.spendCents)}</span></td>
    </tr>,
  );
  return <>{out}</>;
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

const CSS = `
.acq .acq-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.acq .acq-dates{display:inline-flex;gap:6px}
.acq .acq-ms{width:auto;max-width:160px}
.acq .acq-cmp{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600}
.acq .acq-tag{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;background:#fde9bf;color:#7a4e06;border-radius:4px;padding:2px 6px}
.acq .acq-through{font-size:11.5px;color:var(--muted,#5c7168);border-bottom:1px dotted currentColor;cursor:help}
.acq .acq-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}
.acq .acq-tile{background:#fff;border:1px solid var(--line,#e3e7e1);border-radius:12px;padding:12px 14px}
.acq .acq-tk{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#5c7168)}
.acq .acq-tv{font-size:26px;font-weight:800;line-height:1.15;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.acq .acq-chg{display:block;font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;color:#6b7c73}
.acq .acq-chg.up{color:#15803d}.acq .acq-chg.down{color:#b42318}
.acq .acq-card{margin-top:14px;overflow:hidden}
.acq .acq-table td{vertical-align:top}
.acq .acq-n{display:block}
.acq .acq-row{cursor:pointer}
.acq .acq-row:hover td{background:#f7faf8}
.acq .acq-caret{display:inline-block;width:14px;color:var(--muted,#5c7168);font-size:11px}
.acq .acq-dash{color:var(--muted,#5c7168)}
.acq .acq-muted{color:var(--muted,#5c7168);font-size:.78rem}
.acq .acq-foot{margin:-4px 2px 14px;font-size:11.5px;color:var(--muted,#5c7168)}
.acq .acq-tsub{margin-top:2px;font-size:11.5px;color:var(--muted,#5c7168)}
.acq .acq-i{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;padding:0;border-radius:50%;border:1px solid currentColor;background:transparent;color:inherit;font:800 9.5px/1 system-ui,sans-serif;text-transform:none;cursor:help;opacity:.6;vertical-align:1px;margin-left:2px;position:relative}
.acq .acq-i::after{content:"";position:absolute;inset:-9px}
.acq .acq-i[aria-expanded=true]{opacity:1}
.acq .acq-tipbtn{all:unset;cursor:help;display:inline-flex}
.acq .acq-tipbtn:focus-visible,.acq .acq-i:focus-visible{outline:2px solid #2cdb87;outline-offset:2px}
.acq .acq-throughwrap{margin-left:auto}
.acq .acq-badge{display:inline-block;min-width:40px;text-align:right;padding:2px 7px;border-radius:6px;font-weight:600}
.acq .acq-badge.green{background:#e3f4ea;color:#14532d}
.acq .acq-badge.amber{background:#fff1d2;color:#7a4b00}
.acq .acq-badge.red{background:#fbe3e1;color:#8e1b14}
.acq .acq-flag{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#b42318;color:#fff;font-size:11px;font-weight:800}
.acq .acq-est{font-size:11px;color:var(--muted,#5c7168);font-weight:500}
.acq .acq-dlsub td{background:#f7faf8}
.acq .acq-lvl1{padding-left:28px!important}
.acq .acq-lvl2{padding-left:46px!important;font-size:.8rem}
.acq .acq-lvl3{padding-left:64px!important;font-size:.78rem}
.acq .acq-detail td{background:#f7faf8;padding:12px 18px 14px 32px;text-align:left}
.acq .acq-meta{display:flex;flex-wrap:wrap;gap:22px;margin-bottom:12px}
.acq .acq-meta>div{display:flex;flex-direction:column}
.acq .acq-dk{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#5c7168)}
.acq .acq-meta .acq-n{font-size:16px;font-weight:800;font-variant-numeric:tabular-nums}
.acq .acq-pages{width:100%;max-width:720px;border-collapse:collapse;font-size:.78rem}
.acq .acq-pages th{text-align:right;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#5c7168);padding:4px 8px;border-bottom:1px solid var(--line,#e3e7e1)}
.acq .acq-pages td{text-align:right;padding:4px 8px;font-variant-numeric:tabular-nums;border-bottom:1px solid #eef1ec}
.acq .acq-pages th:first-child,.acq .acq-pages td:first-child{text-align:left}
.acq .acq-sub td:first-child{padding-left:32px;font-size:.76rem;color:var(--muted,#5c7168)}
.acq .acq-sources{margin-top:14px;background:#fff;border:1px solid var(--line,#e3e7e1);border-radius:12px;padding:10px 16px}
.acq .acq-sources summary{cursor:pointer;font-weight:800;font-size:13px}
.acq .acq-h2{margin:14px 16px 6px;font-size:16px;font-weight:800;color:var(--ink,#003326)}
.acq .acq-siterow td{background:#f7f9f7}
.acq .acq-qrow td{padding-top:0;white-space:normal}
.acq .acq-q{display:inline-block;margin:0 14px 4px 0;font-size:.74rem;color:var(--muted,#5c7168)}
.acq .acq-q b{color:var(--ink,#13261f);font-weight:700}
.acq .acq-srcsub{display:block;font-size:11.5px;color:var(--muted,#5c7168);font-weight:400}
.acq .acq-src{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-top:10px}
@media (max-width:760px){
  .acq .acq-table th:first-child,.acq .acq-table td:first-child{position:sticky;left:0;z-index:1;background:#fff;box-shadow:1px 0 0 #eef1ec}
  .acq .acq-table .acq-total td:first-child,.acq .acq-table .acq-siterow td:first-child{background:#f1f4f1}
  .acq .acq-table .acq-qrow td:first-child{position:static}
  .acq .acq-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
  .acq .acq-throughwrap{margin-left:0}
  .acq .acq-tv{font-size:22px}
}
`;
