"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fmtInt } from "./format";
import {
  WINDOWS, DEFAULT_WINDOW, DEFAULT_HEAVY, HEAVY_MIN, HEAVY_MAX, TIERS, TIER_NAME,
  clampHeavy, tierDefinition, tierOf, toggleTier, emailDisplay, contactRoute, isStale, DAYS_RED,
  type Tier, type WindowKind,
} from "@/lib/churnModel";

// CHURN — the lapsed players worth calling, and how to call them.
//
// ── WHAT THIS REBUILD FIXED ──────────────────────────────────────────────────────────────────
//
// 1. THE WINDOW DEFAULTED TO ALL TIME, so 9,427 people — a third of everyone who ever registered
//    — arrived as one list, and a player last seen in September 2024, 704 days gone, sat beside
//    someone who lapsed in May. Measured at the 90-day floor: all time 9,427 · 12 months 4,719 ·
//    THIS YEAR 3,166. This year is the default now.
//
// 2. THE "10+ PRIOR MATCHES" TILE SAID "click to show only these" AND CLICKING DID NOTHING —
//    because it was a <button> containing a <button>, which the HTML parser silently unnests: the
//    inner control escapes the tile and the outer one stops being what it looks like. THE TILES
//    ARE DIVS with role="button", tabIndex and an Enter/Space handler, precisely so the Heavy tile
//    can carry the +/− stepper INSIDE it and stay valid.
//
// 3. TEN WAS AN UNEXPLAINED CONSTANT. It is a stepper, and the middle tile's label is DERIVED from
//    it — raise it to 14 and the middle tile reads "3 to 13 matches" — so the label and the filter
//    cannot disagree.
//
// 4. IT SHOWED A PLAYER ID AND NOTHING ELSE. A churn list you cannot contact is a report, not a
//    task. Name, email, phone, city, field, matches, spent, last played, days gone — and MEMBERS
//    are flagged, because someone still paying who has stopped playing is the most urgent row here.
//
// 5. Days gone past 270 in red; the footer totals what these players spent before they stopped, so
//    the list has a size in dollars rather than only in people.

const DAY_OPTIONS = [30, 60, 90, 120] as const;
const PAGE_SIZE = 12;
const FIRST_MATCH = "2023-04-10";

type ChurnRow = {
  u: number; city: string; field: string; days: number; matches: number; last: string;
  name: string | null; email: string | null; phone: string | null; spent: number; isMember: boolean;
};
type ChurnResponse = {
  impossible: boolean; impliedDate: string;
  window: { after: string | null; before: string; days: number };
  tiles: { filteredPlayers: number; fields: number; heavy: number; regular: number; tried: number };
  total: number; rows: ChurnRow[]; availableFields: string[];
  page: number; pageSize: number; days: number;
  heavy: number; spent: number; members: number; windowStart: string; scrubbed: number;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtYmd(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return `${MON[m - 1]} ${d}, ${y}`;
}
function todayYmd(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
const money = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

type Applied = { city: string; field: string; days: number; after: string; win: WindowKind; tier: Tier | null; threshold: number; page: number };

function buildQuery(a: Applied): string {
  const sp = new URLSearchParams();
  sp.set("city", a.city); sp.set("field", a.field); sp.set("days", String(a.days));
  if (a.after) sp.set("after", a.after);
  sp.set("win", a.win);
  if (a.tier) sp.set("tier", a.tier);
  sp.set("threshold", String(a.threshold));
  sp.set("page", String(a.page));
  return sp.toString();
}

export default function ChurnPanel({ authHeaders, scopeChip, cities: cityProp }: {
  authHeaders: Record<string, string>; scopeChip?: ReactNode; cities?: string[];
}) {
  const [applied, setApplied] = useState<Applied>({
    city: "all", field: "all", days: 90, after: "", win: DEFAULT_WINDOW, tier: null, threshold: DEFAULT_HEAVY, page: 0,
  });
  const [resp, setResp] = useState<ChurnResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const set = useCallback((patch: Partial<Applied>) => {
    setApplied((a) => ({ ...a, ...patch, page: patch.page ?? 0 }));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/lifecycle/churn?${buildQuery(applied)}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((j: ChurnResponse) => { if (alive) { setResp(j); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [applied, authHeaders]);

  async function downloadCsv() {
    const res = await fetch(`/api/lifecycle/churn?${buildQuery(applied)}&format=csv`, { headers: authHeaders });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `churn-${applied.days}d.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const rows = resp?.rows ?? [];
  const total = resp?.total ?? 0;
  const tiles = resp?.tiles ?? { filteredPlayers: 0, fields: 0, heavy: 0, regular: 0, tried: 0 };
  const heavy = clampHeavy(resp?.heavy ?? applied.threshold);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fields = useMemo(() => [...new Set(resp?.availableFields ?? [])], [resp]);
  // The city list comes from the page's own growth data when it has one; the fallback is the
  // markets that exist, not a guess.
  /* DEDUPED. g.data.cities arrives with repeats — React logged "two children with the same key"
   * on every render, which is not cosmetic: two options with one key means React can keep the wrong
   * one alive across an update, and a city select that swaps its own value is a filter nobody
   * chose. Same for the field list, which is deduped server-side but is not this component's to
   * assume. */
  const cities = useMemo(
    () => [...new Set(cityProp?.length ? cityProp : ["Austin", "Dallas", "Houston", "San Antonio", "Atlanta", "St. Louis", "OKC", "Warsaw"])],
    [cityProp],
  );

  /* THE STEPPER LIVES INSIDE THE HEAVY TILE, and the tile is a DIV. A <button> may not contain a
   * <button>: the parser unnests it, the stepper escapes the tile, and the tile stops behaving like
   * the control it looks like — which is exactly why "click to show only these" did nothing. */
  const bump = (d: number) => set({ threshold: clampHeavy(heavy + d), page: 0 });
  const clickTier = (t: Tier) => set({ tier: toggleTier(applied.tier, t), page: 0 });
  const tileKey = (e: React.KeyboardEvent, t: Tier) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clickTier(t); }
  };

  return (
    <div className="mcChurn" data-testid="churn">
      <style>{CHURN_CSS}</style>
      <div className="card">
        <div className="head">
          <div>
            <div className="title">Churn</div>
            <div className="sub">Players who stopped, and how to reach them.</div>
          </div>
          <div className="headr">
            {scopeChip}
            <button type="button" className="csv" data-testid="churn-export" onClick={downloadCsv}>Download CSV</button>
          </div>
        </div>

        {/* ── THE WINDOW. Three buttons plus a date box that overrides them; picking a button
            clears the box, so exactly one bound is ever in force. ─────────────────────────── */}
        <div className="filters">
          <div className="fld">
            <label>Window</label>
            <div className="wbs" data-testid="churn-windows">
              {WINDOWS.map((w) => (
                <button key={w.kind} type="button" data-testid={`churn-win-${w.kind}`} data-win={w.kind}
                  className={`wb${!applied.after && applied.win === w.kind ? " on" : ""}`}
                  aria-pressed={!applied.after && applied.win === w.kind}
                  onClick={() => set({ win: w.kind, after: "" })}>{w.label}</button>
              ))}
            </div>
          </div>
          <div className="fld">
            <label htmlFor="churnAfter">Last played after</label>
            <input id="churnAfter" type="date" min={FIRST_MATCH} max={todayYmd()} value={applied.after}
              data-testid="churn-after" onChange={(e) => set({ after: e.target.value })} />
          </div>
          <div className="fld">
            <label htmlFor="churnGone">Not played for</label>
            <select id="churnGone" value={applied.days} data-testid="churn-days" onChange={(e) => set({ days: Number(e.target.value) })}>
              {DAY_OPTIONS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="churnCity">City</label>
            <select id="churnCity" value={applied.city} onChange={(e) => set({ city: e.target.value, field: "all" })}>
              <option value="all">All cities</option>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="churnField">Field</label>
            <select id="churnField" value={applied.field} onChange={(e) => set({ field: e.target.value })}>
              <option value="all">All fields</option>
              {fields.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>

        {/* ── THREE TILES THAT WORK ─────────────────────────────────────────────────────────── */}
        <div className="tiles" data-testid="churn-tiles">
          {TIERS.map((t) => (
            <div key={t} role="button" tabIndex={0} data-testid={`churn-tile-${t}`} data-tier={t}
              aria-pressed={applied.tier === t}
              className={`tile${applied.tier === t ? " on" : ""}`}
              onClick={() => clickTier(t)} onKeyDown={(e) => tileKey(e, t)}>
              <div className="tile-l">{TIER_NAME[t]}</div>
              <div className="tile-v" data-testid={`churn-count-${t}`}>{fmtInt(tiles[t === "regular" ? "regular" : t])}</div>
              {/* THE DEFINITION IS UNDER EVERY TILE, and the middle one is derived from the
                  stepper so the label and the filter cannot drift apart. */}
              <div className="tile-f" data-testid={`churn-def-${t}`}>{tierDefinition(t, heavy)}</div>
              {t === "heavy" && (
                /* INSIDE the tile — legal because the tile is a div, not a button. */
                <div className="step" data-testid="churn-stepper" onClick={(e) => e.stopPropagation()}>
                  <button type="button" aria-label="Lower the threshold" data-testid="churn-step-down"
                    disabled={heavy <= HEAVY_MIN} onClick={() => bump(-1)}>−</button>
                  <b data-testid="churn-threshold">{heavy}+</b>
                  <button type="button" aria-label="Raise the threshold" data-testid="churn-step-up"
                    disabled={heavy >= HEAVY_MAX} onClick={() => bump(1)}>+</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="count" data-testid="churn-count">
          {loading && !resp ? "Loading…"
            : total === 0 ? "No players match these filters."
            : <span>{fmtInt(total)} player{total === 1 ? "" : "s"} · last played on or after {fmtYmd(resp?.windowStart === "0000-01-01" ? null : resp?.windowStart) || "the first match"}, and not for {applied.days}+ days</span>}
          {resp && resp.members > 0 && <span className="memwarn" data-testid="churn-members">{resp.members} still paying</span>}
          {/* SAID, NOT SILENT. A deleted account cannot be contacted, so it is off the list — but a
              list that just got smaller with no explanation is a list nobody trusts. */}
          {resp && resp.scrubbed > 0 && (
            <span className="scrub" data-testid="churn-scrubbed">
              {resp.scrubbed} deleted account{resp.scrubbed === 1 ? "" : "s"} not shown
            </span>
          )}
        </div>

        <div className="tblwrap">
          <table className="tbl" data-testid="churn-table">
            <thead>
              <tr>
                <th>Player</th>
                <th className="drop">Field</th>
                <th className="r">Matches</th>
                <th className="r drop">Spent</th>
                <th className="drop">Last played</th>
                <th className="r">Days gone</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const e = emailDisplay(p);
                const c = contactRoute(p);
                return (
                  <tr key={p.u} data-testid="churn-row" data-days={p.days} data-matches={p.matches} data-last={p.last}>
                    <td className="who">
                      <span className="nm">
                        {p.name ?? `ID ${p.u}`}
                        {p.isMember && <span className="mem" data-testid="churn-member">MEMBER</span>}
                      </span>
                      {/* THE PHONE NEVER DROPS, on any width — for the 142 of 1,000 players on an
                          Apple relay address it is the only route there is. */}
                      <span className="con">
                        <span className={`em ${e.kind}`} data-testid="churn-email" data-kind={e.kind}>{e.text}</span>
                        <span className="ph" data-testid="churn-phone">{p.phone ?? "no phone on file"}</span>
                        <span className="ct">{p.city}</span>
                      </span>
                      {!c.reachable && <span className="unreach" data-testid="churn-unreachable">{c.how}</span>}
                    </td>
                    <td className="drop">{p.field}</td>
                    <td className="r mono">{fmtInt(p.matches)}</td>
                    <td className="r mono drop">{money(p.spent)}</td>
                    <td className="drop">{fmtYmd(p.last)}</td>
                    <td className={`r mono${isStale(p.days) ? " red" : ""}`} data-testid="churn-days-cell">{fmtInt(p.days)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr data-testid="churn-foot">
                <th>{fmtInt(total)} player{total === 1 ? "" : "s"}</th>
                <th className="drop" />
                <th className="r" />
                <th className="r drop" data-testid="churn-foot-spent">{money(resp?.spent ?? 0)}</th>
                <th className="drop" />
                <th className="r">spent before they stopped</th>
              </tr>
            </tfoot>
          </table>
        </div>

        {pages > 1 && (
          <div className="pager">
            <button type="button" data-testid="churn-prev" disabled={applied.page <= 0 || loading}
              onClick={() => setApplied((a) => ({ ...a, page: a.page - 1 }))}>‹ Previous</button>
            <span>Page <b>{applied.page + 1}</b> of <b>{pages}</b></span>
            <button type="button" data-testid="churn-next" disabled={applied.page >= pages - 1 || loading}
              onClick={() => setApplied((a) => ({ ...a, page: a.page + 1 }))}>Next ›</button>
          </div>
        )}
      </div>
    </div>
  );
}

const CHURN_CSS = `
.mcChurn .card{background:#fff;border:1px solid #E4EAE5;border-radius:12px;overflow:hidden}
.mcChurn .head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;flex-wrap:wrap}
.mcChurn .headr{margin-left:auto;display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.mcChurn .title{font-weight:800;font-size:16px;letter-spacing:-.2px}
.mcChurn .sub{color:#6E8076;font-size:12.5px;margin-top:2px}
.mcChurn .csv{border:1px solid #E4EAE5;background:#fff;border-radius:8px;padding:7px 13px;font:inherit;font-weight:700;font-size:12.5px;color:#3C4F44;cursor:pointer}
.mcChurn .filters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;padding:0 16px 12px;border-bottom:1px solid #EFF3EF}
.mcChurn .fld{display:flex;flex-direction:column;gap:4px}
.mcChurn .fld label{font-size:10px;font-weight:800;letter-spacing:.09em;color:#93A49A;text-transform:uppercase}
.mcChurn .fld select,.mcChurn .fld input{border:1px solid #E4EAE5;border-radius:8px;padding:6px 9px;font:inherit;font-size:13px;color:#3C4F44;background:#fff;min-height:32px}
.mcChurn .wbs{display:flex;gap:4px}
.mcChurn .wb{border:1px solid #E4EAE5;background:#fff;border-radius:8px;padding:6px 11px;font:inherit;font-size:12.5px;font-weight:600;color:#3C4F44;cursor:pointer;min-height:32px}
.mcChurn .wb.on{background:#0F3323;border-color:#0F3323;color:#fff}
.mcChurn .tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding:12px 16px}
.mcChurn .tile{border:1px solid #E4EAE5;border-radius:10px;padding:11px 13px;background:#F9FBF9;cursor:pointer;text-align:left;position:relative}
.mcChurn .tile:hover{border-color:#BDEBD1}
.mcChurn .tile:focus-visible{outline:2px solid #0F3323;outline-offset:2px}
.mcChurn .tile.on{background:#E4FBEC;border-color:#0B7A3E;box-shadow:inset 0 0 0 1px #0B7A3E}
.mcChurn .tile-l{font-size:10.5px;font-weight:800;letter-spacing:.09em;color:#8C9E93;text-transform:uppercase}
.mcChurn .tile-v{font-size:26px;font-weight:800;letter-spacing:-.7px;color:#10231A;font-variant-numeric:tabular-nums;margin-top:2px}
.mcChurn .tile-f{font-size:11.5px;color:#6E8076;margin-top:2px}
.mcChurn .step{position:absolute;top:9px;right:10px;display:flex;align-items:center;gap:5px;background:#fff;border:1px solid #E4EAE5;border-radius:999px;padding:2px 5px}
.mcChurn .step button{border:0;background:none;font:inherit;font-size:14px;font-weight:800;color:#3C4F44;cursor:pointer;width:18px;line-height:1;padding:0}
.mcChurn .step button:disabled{opacity:.3;cursor:not-allowed}
.mcChurn .step b{font-size:11.5px;font-variant-numeric:tabular-nums;color:#10231A;min-width:24px;text-align:center}
.mcChurn .count{padding:0 16px 10px;font-size:12.5px;color:#6E8076;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.mcChurn .count>span{flex:none}
.mcChurn .scrub{background:#F4F7F4;border:1px solid #E4EAE5;color:#6E8076;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:600}
.mcChurn .memwarn{background:#FFF6E3;border:1px solid #F0D8A8;color:#7A5008;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:700}
.mcChurn .tblwrap{overflow-x:auto;border-top:1px solid #E4EAE5}
.mcChurn .tbl{border-collapse:separate;border-spacing:0;width:100%;table-layout:auto}
.mcChurn .tbl th,.mcChurn .tbl td{padding:8px 12px;border-bottom:1px solid #EFF3EF;text-align:left;vertical-align:top}
.mcChurn .tbl thead th{background:#F7FAF8;font-size:10px;letter-spacing:.09em;color:#8C9E93;text-transform:uppercase;white-space:nowrap}
.mcChurn .tbl td{font-size:13px}
.mcChurn .tbl .r{text-align:right}
.mcChurn .mono{font-variant-numeric:tabular-nums;white-space:nowrap}
.mcChurn .red{color:#C0341A;font-weight:700}
.mcChurn .who{min-width:0}
.mcChurn .nm{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13.5px;overflow-wrap:anywhere}
.mcChurn .mem{background:#FFF6E3;border:1px solid #F0D8A8;color:#7A5008;border-radius:4px;padding:0 5px;font-size:9.5px;font-weight:800;letter-spacing:.06em}
.mcChurn .con{display:flex;gap:10px;flex-wrap:wrap;margin-top:2px;font-size:11.5px;color:#6E8076}
.mcChurn .con .em.relay{color:#5B4BC4;font-style:italic}
.mcChurn .con .em.none{color:#B0763A}
.mcChurn .con .ph{font-variant-numeric:tabular-nums;color:#3C4F44}
.mcChurn .con .em{overflow-wrap:anywhere;min-width:0}
.mcChurn .unreach{display:block;margin-top:2px;font-size:11px;color:#C0341A}
.mcChurn .tbl tfoot th{background:#F7FAF8;font-size:11.5px;color:#3C4F44;font-weight:700;border-bottom:0;white-space:nowrap}
.mcChurn .pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:11px 16px;border-top:1px solid #EFF3EF;font-size:12.5px;color:#6E8076}
.mcChurn .pager button{border:1px solid #E4EAE5;background:#fff;border-radius:8px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:600;color:#3C4F44;cursor:pointer;min-height:32px}
.mcChurn .pager button:disabled{opacity:.4;cursor:not-allowed}
/* NARROW: Field, Spent and Last played go. Name, email, PHONE and days gone stay — reaching
   someone is what this page is for, and the phone is the only route to a relay address. */
@media (max-width:760px){
  .mcChurn .drop{display:none}
  .mcChurn .tiles{grid-template-columns:1fr}
  .mcChurn .tbl th,.mcChurn .tbl td{padding:8px 10px}
}
`;
