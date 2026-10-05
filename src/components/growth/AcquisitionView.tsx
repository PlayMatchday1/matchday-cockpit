"use client";

/* ACQUISITION — where downloads and new players come from: ads, the website, player shares and the
 * App Store (Ryan, 2026-10-04). Replaces the Ads page; /lifecycle/ads redirects here.
 *
 * ONE DATE BAR FOR EVERYTHING ON THE PAGE. MTD by default, with "vs same days last month" on: every
 * count carries its change against the same days a month earlier (Oct 1–4 against Sep 1–4).
 *
 * WHAT IS NOT HERE YET. Apple's reports (first-time downloads by source, App Store downloads from
 * ads, website downloads by tag) arrive a day after the report requests were created; until the
 * Apple sync is wired in, every cell that needs them says "Waiting for Apple" rather than showing
 * a zero or a guess. The Google sources (Search Console, both GA4 properties) are live.
 */

import { useEffect, useMemo, useState } from "react";
import styles from "./growth.module.css";
import { fmtInt } from "./format";
import AdsOverviewPanel from "./AdsOverviewPanel";
import {
  MILESTONES, SKEWED_BEFORE, avgPosition, clickRate, presetRange, sameDaysLastMonth,
  type Group, type LinkSplit, type Measures, type Preset, type WebsiteTable,
} from "@/lib/acquisitionModel";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (ymd: string | null | undefined) => { if (!ymd) return "—"; const [, m, d] = ymd.split("-"); return `${MON[Number(m) - 1]} ${Number(d)}`; };
const span = (s: string, u: string) => (s === u ? short(s) : `${short(s)} to ${short(u)}`);
const todayChicago = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const WAIT = "Waiting for Apple";

type Payload = {
  since: string; until: string;
  current: { website: WebsiteTable; links: LinkSplit };
  compare: { since: string; until: string; website: WebsiteTable; links: LinkSplit } | null;
  freshness: { gsc: string | null; web: string | null; app: string | null; meta: string | null; apple: string | null };
  mappedRows: number;
};

function pctChange(cur: number | null | undefined, prev: number | null | undefined): string | null {
  if (cur == null || prev == null) return null;
  if (prev === 0) return cur === 0 ? "0%" : "new";
  const d = Math.round(((cur - prev) / prev) * 100);
  return `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)}%`;
}
function Chg({ cur, prev, invert }: { cur: number | null | undefined; prev: number | null | undefined; invert?: boolean }) {
  const t = pctChange(cur, prev);
  if (t == null) return null;
  const up = t.startsWith("+") || t === "new", down = t.startsWith("−");
  const color = (invert ? down : up) ? "#15803d" : (invert ? up : down) ? "#b42318" : "#6b7c73";
  return <span className="acq-chg" style={{ color }} data-testid="acq-chg"> {t}</span>;
}

export default function AcquisitionView({ authHeaders }: { authHeaders: Record<string, string> }) {
  const today = todayChicago();
  const [preset, setPreset] = useState<Preset>("mtd");
  const [custom, setCustom] = useState(() => presetRange("mtd", today));
  const [compareOn, setCompareOn] = useState(true);
  const range = preset === "custom" ? custom : presetRange(preset, today);
  const cmp = useMemo(() => (compareOn ? sameDaysLastMonth(range.since, range.until) : null), [compareOn, range.since, range.until]);

  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    // The sign-in header arrives a moment after mount; asking before it only earns a 401.
    if (!authHeaders.Authorization && !authHeaders.authorization) return;
    setLoading(true); setErr(null);
    const qs = new URLSearchParams({ since: range.since, until: range.until, ...(cmp ? { cmpSince: cmp.since, cmpUntil: cmp.until } : {}) });
    fetch(`/api/lifecycle/acquisition?${qs}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j.error) setErr(j.error); else setData(j); setLoading(false); })
      .catch((e) => { if (alive) { setErr(String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [range.since, range.until, cmp, authHeaders]);

  const links = data?.current.links, prevLinks = data?.compare?.links;
  const vs = cmp ? ` vs ${span(cmp.since, cmp.until)}` : "";
  const appleLagging = range.until >= today;   // Apple runs 1–2 days behind: early-month MTD reads low

  return (
    <div className="acq" data-testid="acq">
      <style>{CSS}</style>

      {/* ── THE DATE BAR ────────────────────────────────────────────────────────────────────── */}
      <div className="acq-bar" data-testid="acq-datebar">
        <span className={styles.adsPills}>
          {([["mtd", "MTD"], ["last", "Last month"], ["d7", "7d"], ["d30", "30d"], ["custom", "Custom"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-testid={`acq-preset-${k}`}
              className={preset === k ? `${styles.adsPill} ${styles.adsPillOn}` : styles.adsPill}
              onClick={() => { if (k === "custom") setCustom(range); setPreset(k); }}>{label}</button>
          ))}
        </span>
        {preset === "custom" && (
          <>
            <input type="date" className={styles.adsBtn} aria-label="From" data-testid="acq-since" value={custom.since} max={custom.until}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, since: e.target.value }))} />
            <input type="date" className={styles.adsBtn} aria-label="To" data-testid="acq-until" value={custom.until} min={custom.since} max={today}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, until: e.target.value }))} />
          </>
        )}
        <select className={styles.adsBtn} data-testid="acq-milestones" value="" aria-label="Milestones"
          onChange={(e) => { const d = e.target.value; if (d) { setCustom({ since: d, until: today }); setPreset("custom"); } }}>
          <option value="">Milestones ▾</option>
          {MILESTONES.map((m) => <option key={m.day} value={m.day}>{m.label} → today</option>)}
        </select>
        <label className="acq-cmp" data-testid="acq-compare">
          <input type="checkbox" checked={compareOn} onChange={(e) => setCompareOn(e.target.checked)} /> vs same days last month
        </label>
      </div>

      {/* ── HOW CURRENT EACH SOURCE IS ─────────────────────────────────────────────────────── */}
      <div className="acq-fresh" data-testid="acq-freshness">
        <b>Data through:</b>{" "}
        Google Search · {short(data?.freshness.gsc)} · Website analytics · {short(data?.freshness.web)} ·
        App analytics · {short(data?.freshness.app)} · Meta · {short(data?.freshness.meta)} ·
        App Store · <span className="acq-wait">{WAIT}</span> (Apple reports 1 to 2 days late) · Our players · today
      </div>
      <div className="acq-note" data-testid="acq-showing">
        Showing {span(range.since, range.until)}{vs}.
        {range.since < SKEWED_BEFORE && " Website numbers before Jul 15 are marked “skewed by ads”: that traffic included Meta ads."}
        {appleLagging && " Apple runs a day or two behind, so the newest days will read low once its downloads are in."}
      </div>

      {err && <div className={`${styles.stateMsg} ${styles.errorMsg}`} data-testid="acq-error">Could not load: {err}</div>}
      {loading && !data && <div className={styles.stateMsg}>Loading acquisition data…</div>}

      {/* ── TILES ───────────────────────────────────────────────────────────────────────────── */}
      <div className="acq-tiles" data-testid="acq-tiles">
        <Tile k="iPhone downloads" sub="all sources" wait />
        <Tile k="From ads" sub="Instagram and Facebook, incl. ad links via page.link (est.)" wait />
        <Tile k="From the website" sub="playmatchday.com" wait />
        <Tile k="From player shares" sub={links ? `floor: ${fmtInt(links.share)} first opens from share links (app analytics)` : "in-app share links"} wait
          extra={links ? <Chg cur={links.share} prev={prevLinks?.share} /> : null} />
        <Tile k="From Instagram (organic)" sub={links ? `${fmtInt(links.ig_social)} first opens from Instagram links (app analytics)` : "Instagram links"} wait
          extra={links ? <Chg cur={links.ig_social} prev={prevLinks?.ig_social} /> : null} />
      </div>

      {/* ── 1 · DOWNLOADS BY SOURCE ─────────────────────────────────────────────────────────── */}
      <section className={styles.card} style={{ marginTop: 14 }} data-testid="acq-sources">
        <div className={styles.cardHead}><div>
          <span className={styles.cardTitle}>1 · Downloads by source</span>
          <div className={styles.cardSub}>First-time iPhone downloads from App Store Connect, by where they came from. Android installs come later (Google Play).</div>
        </div></div>
        <div className={styles.tableWrap}>
          <table className={styles.adsTable}>
            <thead><tr><th>Source</th><th>Comes from</th><th>First-time downloads</th><th>Share</th><th>Cost</th></tr></thead>
            <tbody>
              {SOURCES.map((s) => (
                <tr key={s.name} data-testid="acq-source-row">
                  <td><b>{s.name}</b>{s.est && <span className="acq-est"> est.</span>}</td>
                  <td className={styles.adsMuted}>{s.from}</td>
                  <td className="acq-wait">{WAIT}
                    {s.name === "Player shares" && links && <div className="acq-floor" data-testid="acq-share-floor">floor {fmtInt(links.share)} first opens (iPhone + Android){compareOn && <Chg cur={links.share} prev={prevLinks?.share} />}</div>}
                  </td>
                  <td className={styles.adsMuted}>—</td>
                  <td className={styles.adsMuted}>{s.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {links && links.total > 0 && (
          <div className="acq-split" data-testid="acq-link-split">
            page.link first opens this range: {fmtInt(links.total)} — share links {pct(links.share, links.total)} · Instagram organic {pct(links.ig_social, links.total)} ·
            Meta ads {pct(links.paid, links.total)} · other {pct(links.other, links.total)}. Apple&rsquo;s page.link downloads will be split by these shares, marked est.
          </div>
        )}
      </section>

      {/* ── 2 · ADS BY MARKET ───────────────────────────────────────────────────────────────── */}
      <section style={{ marginTop: 18 }} data-testid="acq-ads">
        <div className="acq-h">2 · Ads by market</div>
        <div className="acq-note">Spend appears only here: the website, player shares and the App Store cost $0. Meta can only see registrations from Sep 12 on; for a range starting earlier those columns show the count since Sep 12.</div>
        <AdsOverviewPanel authHeaders={authHeaders} range={range} compare={cmp} apple />
      </section>

      {/* ── 3 · WEBSITE BY CITY AND PAGE ────────────────────────────────────────────────────── */}
      {data && <WebsiteSection w={data.current.website} prev={data.compare?.website ?? null} mapped={data.mappedRows} compareOn={compareOn} />}
    </div>
  );
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

const SOURCES: { name: string; from: string; cost: string; est?: boolean }[] = [
  { name: "Ads", from: "Instagram, Facebook (App Referrer) plus ad links through page.link", cost: "Meta spend", est: true },
  { name: "Player shares", from: "In-app share links (page.link)", cost: "$0", est: true },
  { name: "Instagram organic", from: "Instagram links through page.link", cost: "$0", est: true },
  { name: "Website", from: "playmatchday.com", cost: "$0" },
  { name: "Google, direct", from: "google.com straight to the store", cost: "$0" },
  { name: "App Store search", from: "Searched inside the App Store", cost: "$0" },
  { name: "App Store browse", from: "Charts, features, similar apps", cost: "$0" },
  { name: "Other / unknown", from: "Everything Apple cannot place", cost: "$0" },
];

function Tile({ k, sub, wait, extra }: { k: string; sub: string; wait?: boolean; extra?: React.ReactNode }) {
  return (
    <div className="acq-tile" data-testid="acq-tile">
      <div className="acq-tk">{k}</div>
      <div className={wait ? "acq-tv acq-wait" : "acq-tv"}>{wait ? WAIT : null}</div>
      <div className="acq-ts">{sub}{extra}</div>
    </div>
  );
}

function WebsiteSection({ w, prev, mapped, compareOn }: { w: WebsiteTable; prev: WebsiteTable | null; mapped: number; compareOn: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const prevBy = new Map((prev?.groups ?? []).map((g) => [g.key, g]));
  const prevPage = new Map((prev?.groups ?? []).flatMap((g) => g.pages.map((p) => [p.path, p] as const)));
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const cells = (m: Measures, p: Measures | undefined) => (
    <>
      <td>{avgPosition(m) == null ? "—" : avgPosition(m)!.toFixed(1)}{compareOn && p && <Chg cur={avgPosition(m)} prev={avgPosition(p)} invert />}</td>
      <td>{fmtInt(m.searchClicks)}{compareOn && <Chg cur={m.searchClicks} prev={p?.searchClicks} />}</td>
      <td className="acq-gs">{fmtInt(m.visits)}{compareOn && <Chg cur={m.visits} prev={p?.visits} />}</td>
      <td>{fmtInt(m.storeClicks)}{compareOn && <Chg cur={m.storeClicks} prev={p?.storeClicks} />}</td>
      <td>{clickRate(m) == null ? "—" : `${(clickRate(m)! * 100).toFixed(1)}%`}</td>
      <td className={`acq-gs ${styles.adsMuted}`}>{WAIT}</td>
    </>
  );
  return (
    <section className={styles.card} style={{ marginTop: 18 }} data-testid="acq-website">
      <div className={styles.cardHead}><div>
        <span className={styles.cardTitle}>3 · Website by city and page</span>
        <div className={styles.cardSub}>
          Click a city to see its pages. Visits are sessions. Store clicks are taps on the App Store or Google Play buttons.
          Downloads by page come from Apple&rsquo;s campaign tags from Oct 1; earlier dates will be estimated from each page&rsquo;s share of store clicks, marked est.
          {w.skewed && <> <span className="acq-skew" data-testid="acq-skewed">skewed by ads</span> this range starts before Jul 15, when the site&rsquo;s traffic included Meta ads.</>}
          {mapped === 0 && <> No pages are mapped to cities yet, so every page is under &ldquo;Not yet mapped&rdquo;.</>}
        </div>
      </div></div>
      <div className={styles.tableWrap}>
        <table className={styles.adsTable}>
          <thead>
            <tr><th /><th colSpan={2}>From Google Search</th><th colSpan={3} className="acq-gs">From the website</th><th className="acq-gs">From Apple</th></tr>
            <tr><th>City / page</th><th>Avg position</th><th>Search clicks</th><th className="acq-gs">Visits</th><th>Store clicks</th><th>Click rate</th><th className="acq-gs">Downloads</th></tr>
          </thead>
          <tbody>
            {w.groups.map((g: Group) => {
              const expandable = g.kind === "city" || g.kind === "unmapped" || g.pages.length > 1;
              const isOpen = open.has(g.key);
              return [
                <tr key={g.key} data-testid="acq-web-group" data-kind={g.kind} onClick={() => expandable && toggle(g.key)} style={{ cursor: expandable ? "pointer" : undefined }}>
                  <td><b>{expandable ? (isOpen ? "▾ " : "▸ ") : ""}{g.label}</b>{g.kind !== "city" && <span className={styles.adsMuted}> · {g.pages.length} page{g.pages.length === 1 ? "" : "s"}</span>}</td>
                  {cells(g, prevBy.get(g.key))}
                </tr>,
                ...(isOpen ? g.pages.map((p) => (
                  <tr key={`${g.key}:${p.path}`} className="acq-sub" data-testid="acq-web-page">
                    <td title={p.path}>{p.label === p.path ? p.path : `${p.label}`}<span className={styles.adsMuted}>{p.label === p.path ? "" : ` · ${p.path}`}</span></td>
                    {cells(p, prevPage.get(p.path))}
                  </tr>
                )) : []),
              ];
            })}
            <tr className={styles.adsTotal} data-testid="acq-web-total"><td>Total</td>{cells(w.total, prev?.total)}</tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

const CSS = `
.acq .acq-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.acq .acq-cmp{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--forest,#123)}
.acq .acq-fresh{margin-top:10px;font-size:12px;color:var(--muted,#5c7168)}
.acq .acq-note{margin-top:6px;font-size:12px;color:var(--muted,#5c7168)}
.acq .acq-wait{color:#8a6d1f;font-weight:600;font-size:12px}
.acq .acq-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px}
.acq .acq-tile{background:#fff;border:1px solid var(--line,#e3e7e1);border-radius:12px;padding:12px 14px}
.acq .acq-tk{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#5c7168)}
.acq .acq-tv{font-size:22px;font-weight:800;margin:4px 0 2px}
.acq .acq-tv.acq-wait{font-size:14px}
.acq .acq-ts{font-size:11.5px;color:var(--muted,#5c7168)}
.acq .acq-chg{font-size:10.5px;font-weight:700;white-space:nowrap}
.acq .acq-est{font-size:10px;font-weight:800;color:#8a6d1f;text-transform:uppercase}
.acq .acq-floor{font-size:11px;color:var(--muted,#5c7168);font-weight:500}
.acq .acq-split{padding:10px 18px;font-size:12px;color:var(--muted,#5c7168);border-top:1px solid var(--line,#e3e7e1)}
.acq .acq-h{font-size:15px;font-weight:800}
.acq .acq-gs{border-left:1px solid var(--line,#e3e7e1)}
.acq .acq-sub td:first-child{padding-left:34px;font-size:.78rem}
.acq .acq-skew{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;background:#fde9bf;color:#7a4e06;border-radius:4px;padding:0 5px}
`;
