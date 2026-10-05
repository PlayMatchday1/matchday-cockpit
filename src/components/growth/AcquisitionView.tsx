"use client";

/* ACQUISITION — where new players come from (Ryan, 2026-10-04; redesigned the same day to be read
 * in ten seconds). Replaces the Ads page; /lifecycle/ads redirects here.
 *
 *   date bar · "Data through" (hover: each source) · "skewed by ads" before Jul 15
 *   four tiles: New players, Registrations, Ad spend, Website store clicks
 *   one table, a row per market, expandable to its Meta detail and its city + venue pages
 *   Homepage and site-wide · Other pages (closed) · Sources (closed)
 *
 * NO EXPLANATORY TEXT ON THE PAGE. Caveats live in (i) hovers on the column that needs them. Every
 * source is compared on the days it has data for (lib/acquisitionModel.sourceWindows). Downloads
 * read "—" until the Apple sync lands.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import styles from "./growth.module.css";
import { fmtInt } from "./format";
import {
  MILESTONES, SKEWED_BEFORE, avgPosition, costPer, presetRange, sameDaysLastMonth,
  type Group, type LinkSplit, type MarketRowView, type MarketSide, type Measures, type PageLine, type Preset,
  type SourceKey, type SourceWindow, type WebsiteTable, type Window,
} from "@/lib/acquisitionModel";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (ymd: string | null | undefined) => { if (!ymd) return "—"; const [, m, d] = ymd.split("-"); return `${MON[Number(m) - 1]} ${Number(d)}`; };
const todayChicago = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const money = (c: number | null | undefined) => (c == null ? "—" : `$${Math.round(c / 100).toLocaleString("en-US")}`);
const money2 = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

type Totals = { spendCents: number | null; registrations: number; newPlayers: number; web: Measures };
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
  const spendTip = `Meta spend. Meta's columns start Aug 1, when the ad account was rebuilt${metaFrom && metaFrom > range.since ? ` (this range: from ${short(metaFrom)})` : ""}.`;

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
            <Tile k="New players" v={fmtInt(t.newPlayers)} cur={t.newPlayers} prev={tp?.newPlayers} />
            <Tile k="Registrations" v={fmtInt(t.registrations)} cur={t.registrations} prev={tp?.registrations} />
            <Tile k="Ad spend" v={money(t.spendCents)} cur={t.spendCents} prev={tp?.spendCents} />
            <Tile k="Website store clicks" v={fmtInt(web?.storeClicks ?? 0)} cur={web?.storeClicks} prev={webP?.storeClicks} />
          </div>

          {/* ── 3 · ONE ROW PER MARKET ──────────────────────────────────────────────────────── */}
          <div className={`${styles.card} acq-card`} data-testid="acq-markets">
            <div className={styles.tableWrap}>
              <table className={`${styles.adsTable} acq-table`}>
                <thead><tr>
                  <th>Market</th>
                  <th>Ad spend <Info tip={spendTip} /></th>
                  <th>Registrations</th>
                  <th>New players</th>
                  <th>Website visits</th>
                  <th>Store clicks</th>
                  <th>Search clicks <Info tip={`Google Search runs about 2 days behind; compared on the days it has (through ${short(data.freshness.gsc)}).`} /></th>
                  <th>Downloads <Info tip="iPhone downloads from App Store Connect. Shown once Apple's daily reports are wired in." /></th>
                </tr></thead>
                <tbody>
                  {data.markets.map((r) => {
                    const isOpen = open.has(r.key), p = compareOn ? r.prev : null;
                    return (
                      <Fragment key={r.key}>
                        <tr className="acq-row" data-testid="acq-market" data-market={r.key} aria-expanded={isOpen} onClick={() => toggle(r.key)}>
                          <td><span className="acq-caret">{isOpen ? "▾" : "▸"}</span>{r.label}</td>
                          <Cell v={r.cur.meta ? money(r.cur.meta.spendCents) : "—"} cur={r.cur.meta?.spendCents} prev={p?.meta?.spendCents} />
                          <Cell v={fmtInt(r.cur.ours.registrations)} cur={r.cur.ours.registrations} prev={p?.ours.registrations} />
                          <Cell v={fmtInt(r.cur.ours.newPlayers)} cur={r.cur.ours.newPlayers} prev={p?.ours.newPlayers} />
                          <Cell v={fmtInt(r.cur.web.visits)} cur={r.cur.web.visits} prev={p?.web.visits} />
                          <Cell v={fmtInt(r.cur.web.storeClicks)} cur={r.cur.web.storeClicks} prev={p?.web.storeClicks} />
                          <Cell v={fmtInt(r.cur.web.searchClicks)} cur={r.cur.web.searchClicks} prev={p?.web.searchClicks} />
                          <td className="acq-dash">—</td>
                        </tr>
                        {isOpen && <MarketDetail r={r} p={p} regSince={data.metaWindow.regSince} />}
                      </Fragment>
                    );
                  })}
                  {data.notAttributed.cur > 0 && (
                    <tr data-testid="acq-notattributed">
                      <td className="acq-muted">Spend not tied to a market</td>
                      <Cell v={money(data.notAttributed.cur)} cur={data.notAttributed.cur} prev={compareOn ? data.notAttributed.prev : null} />
                      <td colSpan={6} />
                    </tr>
                  )}
                  <tr className={`${styles.adsTotal} acq-total`} data-testid="acq-total">
                    <td>Total</td>
                    <Cell v={money(t.spendCents)} cur={t.spendCents} prev={tp?.spendCents} />
                    <Cell v={fmtInt(t.registrations)} cur={t.registrations} prev={tp?.registrations} />
                    <Cell v={fmtInt(t.newPlayers)} cur={t.newPlayers} prev={tp?.newPlayers} />
                    <Cell v={fmtInt(t.web.visits)} cur={t.web.visits} prev={tp?.web.visits} />
                    <Cell v={fmtInt(t.web.storeClicks)} cur={t.web.storeClicks} prev={tp?.web.storeClicks} />
                    <Cell v={fmtInt(t.web.searchClicks)} cur={t.web.searchClicks} prev={tp?.web.searchClicks} />
                    <td className="acq-dash">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* ── 4 · THE REST OF THE WEBSITE ─────────────────────────────────────────────────── */}
          <div className={`${styles.card} acq-card`} data-testid="acq-site">
            <div className={styles.tableWrap}>
              <table className={`${styles.adsTable} acq-table acq-small`}>
                <thead><tr><th>Website</th><th>Visits</th><th>Store clicks</th><th>Search clicks</th><th>Avg position</th></tr></thead>
                <tbody>
                  <SiteRow label="Homepage and site-wide" testId="acq-site-home"
                    groups={[data.site.cur, data.cities.cur]} prevGroups={compareOn ? [data.site.prev, data.cities.prev] : []} />
                  <SiteRow label="Other pages" testId="acq-site-other" expandable open={open.has("other")} onToggle={() => toggle("other")}
                    groups={[data.otherPages.cur]} prevGroups={compareOn ? [data.otherPages.prev] : []} />
                </tbody>
              </table>
            </div>
          </div>

          {/* ── 5 · SOURCES (closed) ────────────────────────────────────────────────────────── */}
          <details className="acq-sources" data-testid="acq-sources">
            <summary>Sources</summary>
            <Sources links={data.current.links} prev={compareOn ? data.compare?.links ?? null : null} />
          </details>
        </>
      )}
    </div>
  );
}

function Tile({ k, v, cur, prev }: { k: string; v: string; cur: number | null | undefined; prev: number | null | undefined }) {
  return (
    <div className="acq-tile" data-testid="acq-tile">
      <div className="acq-tk">{k}</div>
      <div className="acq-tv">{v}</div>
      <Chg cur={cur} prev={prev} />
    </div>
  );
}

function MarketDetail({ r, p, regSince }: { r: MarketRowView; p: MarketSide | null; regSince: string | null }) {
  const m = r.cur.meta, mp = p?.meta ?? null;
  const cpr = m ? costPer(m.regSpendCents, m.metaRegs) : null, cprP = mp ? costPer(mp.regSpendCents, mp.metaRegs) : null;
  const cpnp = m && m.spendCents > 0 ? costPer(m.spendCents, m.metaPlayers) : null, cpnpP = mp && mp.spendCents > 0 ? costPer(mp.spendCents, mp.metaPlayers) : null;
  const regTip = `Signups Meta could credit to an ad. Meta could only see registrations from Sep 12${regSince ? `, so this range counts from ${short(regSince)}` : ""}.`;
  return (
    <tr className="acq-detail" data-testid="acq-detail">
      <td colSpan={8}>
        {m && (
          <div className="acq-meta">
            <div><span className="acq-dk">Meta installs</span><span className="acq-n">{m.installs == null ? "—" : fmtInt(m.installs)}</span><Chg cur={m.installs} prev={mp?.installs} /></div>
            <div><span className="acq-dk">Meta registrations <Info tip={regTip} /></span><span className="acq-n">{m.metaRegs == null ? "—" : fmtInt(m.metaRegs)}</span><Chg cur={m.metaRegs} prev={mp?.metaRegs} /></div>
            <div><span className="acq-dk">Cost per registration <Info tip={regTip} /></span><span className="acq-n">{money2(cpr)}</span><Chg cur={cpr} prev={cprP} invert /></div>
            <div><span className="acq-dk">Cost per new player <Info tip="Ad spend divided by every new player in the market, including ones who found us on their own. Under 10 new players the figure moves a lot." /></span><span className="acq-n">{money2(cpnp)}</span><Chg cur={cpnp} prev={cpnpP} invert /></div>
          </div>
        )}
        {r.pages.length > 0 ? (
          <table className="acq-pages">
            <thead><tr><th>Page</th><th>Visits</th><th>Store clicks</th><th>Search clicks</th><th>Avg position</th></tr></thead>
            <tbody>{r.pages.map((pg: PageLine) => (
              <tr key={pg.path} data-testid="acq-page"><td title={pg.path}>{pg.label}</td><td>{fmtInt(pg.visits)}</td><td>{fmtInt(pg.storeClicks)}</td><td>{fmtInt(pg.searchClicks)}</td><td>{avgPosition(pg) == null ? "—" : avgPosition(pg)!.toFixed(1)}</td></tr>
            ))}</tbody>
          </table>
        ) : <div className="acq-muted">No website pages for this market.</div>}
      </td>
    </tr>
  );
}

function sumGroups(gs: (Group | null | undefined)[]): Measures & { pages: PageLine[] } {
  const m = { impressions: 0, px: 0, searchClicks: 0, visits: 0, storeClicks: 0, pages: [] as PageLine[] };
  for (const g of gs) { if (!g) continue; m.impressions += g.impressions; m.px += g.px; m.searchClicks += g.searchClicks; m.visits += g.visits; m.storeClicks += g.storeClicks; m.pages.push(...g.pages); }
  return m;
}
function SiteRow({ label, groups, prevGroups, expandable, open, onToggle, testId }: {
  label: string; groups: (Group | null)[]; prevGroups: (Group | null)[]; expandable?: boolean; open?: boolean; onToggle?: () => void; testId: string;
}) {
  const m = sumGroups(groups), p = prevGroups.length ? sumGroups(prevGroups) : null;
  return (
    <>
      <tr data-testid={testId} className={expandable ? "acq-row" : undefined} onClick={expandable ? onToggle : undefined}>
        <td>{expandable && <span className="acq-caret">{open ? "▾" : "▸"}</span>}{label}{expandable && <span className="acq-muted"> · {m.pages.length}</span>}</td>
        <Cell v={fmtInt(m.visits)} cur={m.visits} prev={p?.visits} />
        <Cell v={fmtInt(m.storeClicks)} cur={m.storeClicks} prev={p?.storeClicks} />
        <Cell v={fmtInt(m.searchClicks)} cur={m.searchClicks} prev={p?.searchClicks} />
        <Cell v={avgPosition(m) == null ? "—" : avgPosition(m)!.toFixed(1)} cur={avgPosition(m)} prev={p ? avgPosition(p) : null} invert />
      </tr>
      {expandable && open && m.pages.map((pg) => (
        <tr key={pg.path} className="acq-sub" data-testid="acq-other-page">
          <td title={pg.path}>{pg.path}</td><td>{fmtInt(pg.visits)}</td><td>{fmtInt(pg.storeClicks)}</td><td>{fmtInt(pg.searchClicks)}</td>
          <td>{avgPosition(pg) == null ? "—" : avgPosition(pg)!.toFixed(1)}</td>
        </tr>
      ))}
    </>
  );
}

const SOURCES = ["Ads", "Player shares", "Instagram organic", "Website", "Google, direct", "App Store search", "App Store browse", "Other / unknown"];
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
function Sources({ links, prev }: { links: LinkSplit; prev: LinkSplit | null }) {
  return (
    <div className="acq-src">
      <table className="acq-pages">
        <thead><tr><th>Downloads by source</th><th>iPhone downloads <Info tip="From App Store Connect, once Apple's daily reports are wired in. page.link downloads will be split by the shares below, marked est." /></th></tr></thead>
        <tbody>{SOURCES.map((s) => <tr key={s} data-testid="acq-source-row"><td>{s}</td><td className="acq-dash">—</td></tr>)}</tbody>
      </table>
      <table className="acq-pages">
        <thead><tr><th>page.link first opens <Info tip="App first opens through page.link links, from app analytics (iPhone and Android), by where the link came from. Share links are the player-shares floor." /></th><th>Opens</th><th>Share</th></tr></thead>
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
.acq .acq-src{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-top:10px}
@media (max-width:760px){
  .acq .acq-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
  .acq .acq-through{margin-left:0}
  .acq .acq-tv{font-size:22px}
}
`;
