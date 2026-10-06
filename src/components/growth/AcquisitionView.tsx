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
 *     Downloads by source  Apple's split, one Instagram and Facebook row; "—" until the Apple sync
 *   page.link first opens, collapsed at the very bottom until the Apple sync replaces it
 *
 * NO EXPLANATORY TEXT ON THE PAGE. Caveats live in (i) hovers on the column that needs them. Every
 * source is compared on the days it has data for (lib/acquisitionModel.sourceWindows). Downloads
 * read "—" until the Apple sync lands.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import styles from "./growth.module.css";
import { fmtInt } from "./format";
import {
  MILESTONES, SKEWED_BEFORE, clickRate, costPer, presetRange, sameDaysLastMonth,
  type Group, type LinkSplit, type MarketRowView, type Measures, type PageLine, type Preset, type RankedPage,
  type SourceKey, type SourceWindow, type WebsiteTable, type Window,
} from "@/lib/acquisitionModel";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (ymd: string | null | undefined) => { if (!ymd) return "—"; const [, m, d] = ymd.split("-"); return `${MON[Number(m) - 1]} ${Number(d)}`; };
const todayChicago = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const money = (c: number | null | undefined) => (c == null ? "—" : `$${Math.round(c / 100).toLocaleString("en-US")}`);
const money2 = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

type Totals = {
  spendCents: number | null; installs: number | null; metaRegs: number | null; regSpendCents: number;
  registrations: number; firstTime: number; web: Measures;
};

/* EVERY HOVER IN ONE PLACE, in the mock's wording (Ryan, 2026-10-05): one plain sentence on how the
 * number is calculated and where it comes from. The few that depend on the range are built below. */
const TIP = {
  installs: "Installs Meta credits to an ad. Meta's own count.",
  allRegs: "Every MatchDay sign-up in this range from any source, not only ads, from our own database, by the city chosen at signup.",
  rank: "Average Google position of the city page for \"pickup soccer [city]\", plus \"pick up soccer [city]\" and \"pickup soccer near me\" where Google has them for that page. 1 is the top result; lower is better.",
  visits: "Website sessions on these pages (Google Analytics). One person on one trip to the site counts once.",
  storeClicks: "Taps on an App Store or Google Play button on these pages. An intent to download, not a download.",
  clickRate: "Store clicks divided by visits: how many visitors tapped an App Store or Google Play button.",
  webDownloads: "iPhone first-time downloads Apple credits to these pages (App Store web referrer). Apple reports 1 to 2 days late. Shows — until Apple's reports arrive.",
  iphone: "First-time iPhone downloads, from Apple App Store analytics. Re-downloads are not counted. Android comes later. Shows — until Apple's reports arrive.",
  share: "This source as a share of all iPhone downloads in the range.",
  cost: "What we paid for this source in the range: Meta spend on Instagram and Facebook, nothing on the others.",
};

/* FIRST-TIME PLAYERS, PLAYER ACTIVITY'S DEFINITION (Ryan, 2026-10-05). People whose first MatchDay
 * match ever was in the range, from any source, in that match's city — the same rows Player Activity
 * counts, so the two pages tie. It replaced "Registrants who played" (counted by signup) and its
 * 7-day rate. It is not linked to ads; it sits beside spend to be read over time. */
const FIRST_LABEL = "First-time players";
const FIRST_TIP = "Everyone who played their first MatchDay match in this range, from any source. Not linked to ads; compare it against ad spend over time.";
type Payload = {
  since: string; until: string;
  windows: Record<SourceKey, SourceWindow>;
  freshness: Record<SourceKey, string | null>;
  current: { website: WebsiteTable; links: LinkSplit };
  compare: { website: WebsiteTable; links: LinkSplit } | null;
  markets: MarketRowView[];
  totals: { cur: Totals; prev: Totals | null };
  notAttributed: { cur: number; prev: number | null };
  metaWindow: { cur: Window | null; regSince: string | null };
  site: { cur: Group | null; prev: Group | null };
  cities: { cur: Group | null; prev: Group | null };
  otherPages: { cur: Group | null; prev: Group | null };
  excluded: { internal: number; reRegistrations: number };
};

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
function Info({ tip }: { tip: string }) {
  return <span className="acq-i" title={tip} aria-label={tip} tabIndex={0}>i</span>;
}
function Cell({ v, cur, prev, invert, cls }: { v: React.ReactNode; cur?: number | null; prev?: number | null; invert?: boolean; cls?: string }) {
  return <td className={cls}><span className="acq-n">{v}</span><Chg cur={cur} prev={prev} invert={invert} /></td>;
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
  const through = data ? (["gsc", "web", "app", "meta"] as SourceKey[]).map((k) => data.freshness[k]).filter(Boolean).sort().pop() : null;
  const throughTip = data
    ? (["gsc", "web", "app", "meta"] as SourceKey[]).map((k) => `${SOURCE_NAME[k]}: ${short(data.freshness[k])}`).join("\n")
      + "\nApp Store: waiting for Apple (runs 1 to 2 days behind)\nOur players: today"
      + "\nEach source is compared on the days it has data for."
    : "";
  const metaFrom = data?.metaWindow.cur?.since;
  const spendTip = `What Meta charged us in this date range, per market. Meta reporting starts Aug 1${metaFrom && metaFrom > range.since ? ` (this range: from ${short(metaFrom)})` : ""}.`;
  const regSince = data?.metaWindow.regSince;
  const regTip = `Registrations Meta credits to an ad (someone tapped an ad, installed, and signed up within 7 days). Meta's own count. Available from Sep 12${regSince ? ` (this range: from ${short(regSince)})` : ""}.`;
  const cprTip = `Ad spend divided by Meta registrations, both from Sep 12 on, when Meta could first see registrations.`;
  const searchTip = `Clicks from Google search results to these pages (Search Console). Google reports about 2 days late (through ${short(data?.freshness.gsc)}).`;

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
        {range.since < SKEWED_BEFORE && <span className="acq-tag" data-testid="acq-skewed" title="Website traffic before Jul 15 included Meta ads.">skewed by ads</span>}
        <span className="acq-through" data-testid="acq-through" title={throughTip}>Data through {short(through)}</span>
      </div>

      {err && <div className={`${styles.stateMsg} ${styles.errorMsg}`} data-testid="acq-error">Could not load: {err}</div>}
      {!data && !err && <div className={styles.stateMsg}>Loading…</div>}

      {data && t && (
        <>
          {/* ── 2 · FOUR TILES ──────────────────────────────────────────────────────────────── */}
          <div className="acq-tiles" data-testid="acq-tiles">
            <Tile k={FIRST_LABEL} tip={FIRST_TIP} v={fmtInt(t.firstTime)} cur={t.firstTime} prev={tp?.firstTime} />
            <Tile k="Registrations" tip={TIP.allRegs} v={fmtInt(t.registrations)} cur={t.registrations} prev={tp?.registrations} />
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
                  <th>Ad spend <Info tip={spendTip} /></th>
                  <th>Meta installs <Info tip={TIP.installs} /></th>
                  <th>Meta registrations <Info tip={regTip} /></th>
                  <th>Cost per registration <Info tip={cprTip} /></th>
                  <th>All registrations <Info tip={TIP.allRegs} /></th>
                  <th>{FIRST_LABEL} <Info tip={FIRST_TIP} /></th>
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
                        <Cell v={money2(m ? costPer(m.regSpendCents, m.metaRegs) : null)} cur={m ? costPer(m.regSpendCents, m.metaRegs) : null} prev={mp ? costPer(mp.regSpendCents, mp.metaRegs) : null} invert />
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
                    <Cell v={money2(costPer(t.regSpendCents, t.metaRegs))} cur={costPer(t.regSpendCents, t.metaRegs)} prev={tp ? costPer(tp.regSpendCents, tp.metaRegs) : null} invert />
                    <Cell v={fmtInt(t.registrations)} cur={t.registrations} prev={tp?.registrations} />
                    <Cell v={fmtInt(t.firstTime)} cur={t.firstTime} prev={tp?.firstTime} />
                  </tr>
                </tbody>
              </table>
            </div>
            {/* THE EXCLUSION, STATED (0208). Staff, @matchday.com and fake accounts are not players, and a
              * player who deleted their account and signed up again is one person. Leaving them out
              * silently would make the counts drop with no visible reason. */}
            <div className="acq-foot" data-testid="acq-excluded">
              Not counted, signups in this range: {fmtInt(data.excluded.internal)} staff, test or fake {data.excluded.internal === 1 ? "account" : "accounts"} · {fmtInt(data.excluded.reRegistrations)} {data.excluded.reRegistrations === 1 ? "re-registration" : "re-registrations"} of an existing player.
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
                  <th>Search clicks <Info tip={searchTip} /></th>
                  <th>Visits <Info tip={TIP.visits} /></th>
                  <th>Store clicks <Info tip={TIP.storeClicks} /></th>
                  <th>Click rate <Info tip={TIP.clickRate} /></th>
                  <th>Downloads <Info tip={TIP.webDownloads} /></th>
                </tr></thead>
                <tbody>
                  {data.markets.map((r) => {
                    const isOpen = open.has(r.key), p = compareOn ? r.prev : null;
                    return (
                      <Fragment key={r.key}>
                        <tr className="acq-row" data-testid="acq-market" data-market={r.key} aria-expanded={isOpen} onClick={() => toggle(r.key)}>
                          <td><span className="acq-caret">{isOpen ? "▾" : "▸"}</span>{r.label}</td>
                          <RankCell rank={r.cur.rank} prev={p ? p.rank : undefined} />
                          <WebCells m={r.cur.web} p={p?.web ?? null} />
                        </tr>
                        {isOpen && (r.pages.length
                          ? r.pages.map((pg) => <PageRow key={pg.path} pg={pg} />)
                          : <tr className="acq-sub"><td colSpan={7} className="acq-muted">No website pages for this market in this range.</td></tr>)}
                      </Fragment>
                    );
                  })}
                  <SiteRow label="Homepage and site-wide" testId="acq-site-home" open={open.has("home")} onToggle={() => toggle("home")}
                    groups={[data.site.cur, data.cities.cur]} prevGroups={compareOn ? [data.site.prev, data.cities.prev] : []} />
                  <SiteRow label="Other pages" testId="acq-site-other" count open={open.has("other")} onToggle={() => toggle("other")}
                    groups={[data.otherPages.cur]} prevGroups={compareOn ? [data.otherPages.prev] : []} />
                  <tr className={`${styles.adsTotal} acq-total`} data-testid="acq-total">
                    <td>Total</td>
                    <td className="acq-dash">—</td>
                    <WebCells m={t.web} p={tp?.web ?? null} />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 5 · DOWNLOADS BY SOURCE ─────────────────────────────────────────────────────── */}
          <section className={`${styles.card} acq-card`} data-testid="acq-sources-table">
            <h2 className="acq-h2">Downloads by source</h2>
            <div className={styles.tableWrap}>
              <table className={`${styles.adsTable} acq-table`}>
                <thead><tr>
                  <th>Source</th>
                  <th>iPhone downloads <Info tip={TIP.iphone} /></th>
                  <th>Share <Info tip={TIP.share} /></th>
                  <th>Cost <Info tip={TIP.cost} /></th>
                </tr></thead>
                <tbody>
                  {DL_SOURCES.map((src) => (
                    <tr key={src.key} data-testid="acq-source-row" data-source={src.key}>
                      <td><b>{src.label}</b> <Info tip={src.tip} /><span className="acq-srcsub">{src.sub}</span></td>
                      <td className="acq-dash">—</td>
                      <td className="acq-dash">—</td>
                      <td><span className="acq-n">{src.key === "meta" ? money(t.spendCents) : "$0"}</span></td>
                    </tr>
                  ))}
                  <tr className={`${styles.adsTotal} acq-total`}>
                    <td>Total</td><td className="acq-dash">—</td><td className="acq-dash">—</td><td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 6 · page.link FIRST OPENS — collapsed at the bottom until the Apple sync replaces it ── */}
          <details className="acq-sources" data-testid="acq-sources">
            <summary>page.link first opens</summary>
            <LinkOpens links={data.current.links} prev={compareOn ? data.compare?.links ?? null : null} />
          </details>
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
function RankCell({ rank, prev }: { rank: number | null; prev?: number | null }) {
  const d = rank != null && prev != null ? Math.round((rank - prev) * 10) / 10 : null;
  return (
    <td data-testid="acq-rank">
      <span className="acq-n">{rank == null ? "—" : rank.toFixed(1)}</span>
      {d != null && d !== 0 && <span className={`acq-chg ${d < 0 ? "up" : "down"}`} data-testid="acq-chg">{d > 0 ? "+" : "−"}{Math.abs(d).toFixed(1)}</span>}
    </td>
  );
}
/** Search clicks · Visits · Store clicks · Click rate · Downloads — the same five on every row. */
function WebCells({ m, p }: { m: Measures; p: Measures | null }) {
  const cr = clickRate(m);
  return (
    <>
      <Cell v={fmtInt(m.searchClicks)} cur={m.searchClicks} prev={p?.searchClicks} />
      <Cell v={fmtInt(m.visits)} cur={m.visits} prev={p?.visits} />
      <Cell v={fmtInt(m.storeClicks)} cur={m.storeClicks} prev={p?.storeClicks} />
      <td><span className="acq-n">{cr == null ? "—" : `${Math.round(cr * 100)}%`}</span></td>
      <td className="acq-dash">—</td>
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
function SiteRow({ label, groups, prevGroups, count, open, onToggle, testId }: {
  label: string; groups: (Group | null)[]; prevGroups: (Group | null)[]; count?: boolean; open: boolean; onToggle: () => void; testId: string;
}) {
  const m = sumGroups(groups), p = prevGroups.length ? sumGroups(prevGroups) : null;
  return (
    <>
      <tr data-testid={testId} className="acq-row acq-siterow" onClick={onToggle} aria-expanded={open}>
        <td><span className="acq-caret">{open ? "▾" : "▸"}</span>{label}{count && <span className="acq-muted"> · {m.pages.length}</span>}</td>
        <td className="acq-dash">—</td>
        <WebCells m={m} p={p} />
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

/* THE SOURCES APPLE'S DOWNLOAD REPORTS SPLIT BY, in the mock's wording. Instagram and Facebook is ONE
 * row: Apple's app referrer cannot tell a paid ad from an organic post, so it is never split here. */
const DL_SOURCES: { key: string; label: string; sub: string; tip: string }[] = [
  { key: "meta", label: "Instagram and Facebook", sub: "Ads + organic",
    tip: "Downloads where Apple says the person came from the Instagram or Facebook app (App Store \"app referrer\"). Apple cannot tell a paid ad from an organic post, so this is both. For ads alone, see Meta installs in the Meta ads table." },
  { key: "share", label: "Player share links", sub: "In-app shares",
    tip: "Downloads that came through a MatchDay share link (page.link). Apple counts these as web referrer page.link." },
  { key: "web", label: "Website", sub: "playmatchday.com",
    tip: "Downloads where Apple says the person came from playmatchday.com (web referrer). Mostly Safari on iPhone." },
  { key: "google", label: "Google", sub: "google.com",
    tip: "Downloads straight from a Google search result to the App Store, without visiting our site." },
  { key: "search", label: "App Store search", sub: "Searched in the App Store",
    tip: "People who searched inside the App Store and downloaded (Apple source type \"App Store search\")." },
  { key: "browse", label: "App Store browse", sub: "Charts, Today tab, similar apps",
    tip: "People who found us browsing the App Store (Apple source type \"App Store browse\")." },
  { key: "other", label: "Other", sub: "Unknown or other",
    tip: "Everything Apple cannot attribute or attributes elsewhere: other apps, other websites, \"unavailable\"." },
];

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
function LinkOpens({ links, prev }: { links: LinkSplit; prev: LinkSplit | null }) {
  return (
    <div className="acq-src">
      <table className="acq-pages">
        <thead><tr><th>Source <Info tip="App first opens through page.link links, from app analytics (iPhone and Android), by where the link came from. Share links are the player-shares floor. Replaced by the Downloads by source table once Apple's reports arrive." /></th><th>Opens</th><th>Share</th></tr></thead>
        <tbody>
          {([["Share links", links.share, prev?.share], ["Instagram organic", links.ig_social, prev?.ig_social], ["Meta ads", links.paid, prev?.paid], ["Other", links.other, prev?.other]] as const).map(([k, n, pv]) => (
            <tr key={k} data-testid="acq-link-row"><td>{k}</td><td><span className="acq-n">{fmtInt(n)}</span><Chg cur={n} prev={pv} /></td><td>{pct(n, links.total)}</td></tr>
          ))}
          <tr className="acq-total"><td>Total</td><td><span className="acq-n">{fmtInt(links.total)}</span><Chg cur={links.total} prev={prev?.total} /></td><td>100%</td></tr>
        </tbody>
      </table>
    </div>
  );
}

const CSS = `
.acq .acq-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.acq .acq-dates{display:inline-flex;gap:6px}
.acq .acq-ms{width:auto;max-width:160px}
.acq .acq-cmp{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600}
.acq .acq-tag{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;background:#fde9bf;color:#7a4e06;border-radius:4px;padding:2px 6px}
.acq .acq-through{margin-left:auto;font-size:11.5px;color:var(--muted,#5c7168);border-bottom:1px dotted currentColor;cursor:help}
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
.acq .acq-i{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;border:1px solid currentColor;font-size:9px;font-weight:800;font-style:normal;text-transform:none;cursor:help;opacity:.6;vertical-align:1px;margin-left:2px}
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
  .acq .acq-through{margin-left:0}
  .acq .acq-tv{font-size:22px}
}
`;
