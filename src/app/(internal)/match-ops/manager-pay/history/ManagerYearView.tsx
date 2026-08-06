"use client";

// Manager year report — admin-only. Derived entirely server-side from the match
// list + adjustments (src/lib/managerYearReport.ts); this view only renders it,
// downloads it as flat CSV, and prints it. Ported from mockups/mgryear-v1_2.html.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import type { YearReport, ManagerOption } from "@/lib/managerYearReport";

const money = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US");
const YEARS = (() => { const y = new Date().getUTCFullYear(); return [y, y - 1]; })();

export default function ManagerYearView() {
  const { appUser, isLoading } = useAuth();
  const [year, setYear] = useState<number>(YEARS[0]);
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [managerEmail, setManagerEmail] = useState<string>(""); // no preselect
  const [report, setReport] = useState<YearReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = useCallback(async () => (await supabase.auth.getSession()).data.session?.access_token ?? null, []);

  // manager list for the year (resets the selection — a manager may not exist across years)
  useEffect(() => {
    let alive = true;
    (async () => {
      const t = await token();
      if (!t) return;
      const res = await fetch(`/api/manager-pay/manager-year?year=${year}`, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
      if (!res.ok || !alive) return;
      const j = await res.json();
      if (alive) { setManagers(j.managers ?? []); setManagerEmail(""); setReport(null); }
    })();
    return () => { alive = false; };
  }, [year, token]);

  // the report — only once a manager is chosen (never render one unasked)
  useEffect(() => {
    if (!managerEmail) { setReport(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      const t = await token();
      if (!t) return;
      try {
        const res = await fetch(`/api/manager-pay/manager-year?year=${year}&manager=${encodeURIComponent(managerEmail)}`, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
        const j = await res.json();
        if (!alive) return;
        if (!res.ok) { setError(j?.error ?? `HTTP ${res.status}`); setReport(null); }
        else setReport(j as YearReport);
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [managerEmail, year, token]);

  const downloadCsv = useCallback(() => {
    if (!report) return;
    const esc = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const head = ["week_start", "match_date", "time", "field", "city", "kind", "two_manager", "pay", "note"];
    const lines = [head.join(",")];
    for (const r of report.rows) lines.push([r.weekStart, r.matchDate, r.time, r.field, r.city, r.cancelled ? "cancelled" : "match", r.twoManager ? "Y" : "N", r.cancelled ? "" : String(r.pay), ""].map((x) => esc(String(x))).join(","));
    for (const a of report.adjustments) lines.push([a.weekStart, a.date, "", "", "", "adjustment", "N", String(a.amount), a.reason].map((x) => esc(String(x))).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const el = document.createElement("a");
    el.href = URL.createObjectURL(blob);
    el.download = `manager-year-${report.managerName.replace(/\s+/g, "-").toLowerCase()}-${report.year}.csv`;
    el.click(); URL.revokeObjectURL(el.href);
  }, [report]);

  const sub = useMemo(() => report
    ? `${report.year} · organised by when matches were worked, not when they were paid · generated ${report.generatedAt} · times shown in Central`
    : "", [report]);

  if (!isLoading && appUser && !appUser.is_admin) {
    return <div className="myr"><div className="wrap"><div className="card" style={{ padding: 24 }}>The manager year report is admin-only.</div></div></div>;
  }

  return (
    <div className="myr">
      <style>{CSS}</style>
      <div className="wrap">
        <div className="hostbar noprint">
          <Link href="/match-ops/manager-pay" className="ht" style={{ textDecoration: "none" }}>‹ Manager Pay</Link>
          <span className="quiet" aria-current="page">Manager history</span>
        </div>

        <div className="card">
          <div className="chead">
            <div>
              <div className="ctitle">{report ? report.managerName : "Manager history"}</div>
              <div className="csub">{report ? sub : "Pick a manager to see their full year — matches, locations and week-by-week pay."}</div>
            </div>
            <div className="picks noprint">
              <select aria-label="Manager" value={managerEmail} onChange={(e) => setManagerEmail(e.target.value)}>
                <option value="">Select a manager…</option>
                {managers.map((m) => <option key={m.email} value={m.email}>{m.name}</option>)}
              </select>
              <select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <button type="button" className="btn" onClick={downloadCsv} disabled={!report}>Download CSV</button>
              <button type="button" className="btn" onClick={() => window.print()} disabled={!report}>Print</button>
            </div>
          </div>
          {report && (
            <div className="tiles">
              <div className="tile"><div className="tl">Matches worked</div><div className="tv" data-k="worked">{report.worked}</div><div className="tn">across {report.fieldCount} fields in {report.cityCount} cities</div></div>
              <div className="tile"><div className="tl">Cancelled</div><div className="tv" data-k="cancelled">{report.cancelled}</div><div className="tn">listed below, paid nothing</div></div>
              <div className="tile"><div className="tl">Weeks worked</div><div className="tv" data-k="weeks">{report.weeksWorked}</div><div className="tn">of {report.weeksElapsed} weeks elapsed in {report.year}</div></div>
              <div className="tile pay"><div className="tl">Total paid</div><div className="tv" data-k="total">{money(report.grand)}</div><div className="tn">{money(report.matchPay)} match pay {report.adjustmentsTotal < 0 ? "−" : "+"} {money(Math.abs(report.adjustmentsTotal))} adjustments</div></div>
            </div>
          )}
        </div>

        {loading && <div className="card" style={{ padding: 24 }}>Loading…</div>}
        {error && <div className="card" style={{ padding: 24, color: "#A83120" }}>{error}</div>}

        {report && (<>
          <div className="card">
            <div className="sec">
              <div className="sech">Where they worked</div>
              <table id="loc">
                <thead><tr><th>Field</th><th>City</th><th>Matches</th><th>Match pay</th></tr></thead>
                <tbody>
                  {report.fields.map((f) => (
                    <tr key={f.field} data-f={f.field}>
                      <td>{f.field}{f.isEvent && <span title="This looks like an event, not a venue" style={{ marginLeft: 6, fontSize: 9, fontWeight: 900, color: "#7A5200", background: "#FFF6D6", border: "1px solid #F0DC9B", borderRadius: 99, padding: "2px 6px" }}>EVENT?</span>}</td>
                      <td className="city" style={{ textAlign: "right" }}>{f.city}</td>
                      <td>{f.matches}</td><td>{money(f.pay)}</td>
                    </tr>
                  ))}
                  {report.cities.map((c) => (
                    <tr key={c.city} data-city={c.city}>
                      <td style={{ color: "#5C6B62", fontWeight: 800 }}>{c.city} — all fields</td><td></td>
                      <td style={{ color: "#5C6B62" }}>{c.matches}</td><td style={{ color: "#5C6B62" }}>{money(c.pay)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>All fields</td><td></td>
                  <td data-k="locmatches">{report.fields.reduce((a, r) => a + r.matches, 0)}</td>
                  <td data-k="locpay">{money(report.fields.reduce((a, r) => a + r.pay, 0))}</td></tr></tfoot>
              </table>
            </div>
            <div className="foot" data-k="locfoot">
              Match pay only. Adjustments ({money(report.adjustmentsTotal)}) are not attached to a field, so this column sums to match pay, not to Total paid. Cancelled matches are excluded from both columns.
            </div>
          </div>

          <div className="card">
            <div className="sec">
              <div className="sech">Week by week — newest first</div>
              <div id="weeks">
                {report.weeks.map((w) => (
                  <div className="wk" key={w.weekStart} data-week={w.weekStart}>
                    <div className="wkh">
                      <span className="wkr">{w.rangeLabel}</span>
                      <span className="wkd">Pay run {w.payRun ? fmtShort(w.payRun) : "—"} · arrives {w.arrival ? fmtShort(w.arrival) : "—"}</span>
                      <span className="wkt" data-wt={w.total}>{money(w.total)}</span>
                    </div>
                    {w.matches.map((m, i) => (
                      <div className={`mr${m.cancelled ? " cancelled" : ""}`} key={`m${i}`} data-w={w.weekStart}>
                        <div className="md">{m.dateLabel} · {m.time}</div>
                        <div><div className="mf">{m.field}</div><div className="mc">{m.city}</div></div>
                        <div>{m.cancelled ? <span className="pillx canc">Cancelled</span> : m.twoManager ? <span className="pillx two">Two managers</span> : null}</div>
                        <div className="mp">{m.cancelled ? "—" : money(m.pay)}</div>
                      </div>
                    ))}
                    {w.adjustments.map((a, i) => (
                      <div className="mr adjust" key={`a${i}`} data-w={w.weekStart} data-adj="1">
                        <div className="md">{fmtShort(a.date)}</div>
                        <div><div className="mf">{a.reason}</div><div className="mc">Adjustment</div></div>
                        <div><span className="pillx adj">Adjustment</span></div>
                        <div className="mp">{money(a.amount)}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="recon" data-k="recon">
              Reconciles: {report.worked} matches + {report.adjustments.length} adjustments = {money(report.grand)}. Week totals sum to {money(report.weeks.reduce((a, w) => a + w.total, 0))}. Field breakdown sums to {report.fields.reduce((a, r) => a + r.matches, 0)} matches and {money(report.fields.reduce((a, r) => a + r.pay, 0))} match pay.
              {report.collapsedCount > 0 && <> · {report.rawSpellings.length} raw spellings collapsed to one identity.</>}
              {report.events.length > 0 && <> · Events listed as fields: {report.events.join(", ")}.</>}
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtShort(iso: string): string { return `${MO[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`; }

const CSS = `
.myr{--forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--faint:#67746C;--paper:#fff;--line:#E3E8E0;
  --slot:#F7F9F6;--mintSoft:#E9FAF1;--mintEdge:#A8E7C9;--mintInk:#046B45;--amber:#FFF6D6;--amberEdge:#F0DC9B;
  --amberInk:#7A5200;--coralInk:#A83120;color:var(--ink);font-variant-numeric:tabular-nums}
.myr .wrap{max-width:1080px;margin:0 auto}
.myr .hostbar{display:flex;align-items:center;gap:14px;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:12px 18px;margin-bottom:18px;box-shadow:0 9px 26px rgba(0,51,38,.075)}
.myr .hostbar .ht{font-size:14px;font-weight:900;color:var(--forest)}
.myr .quiet{margin-left:auto;background:none;border:0;padding:0;font-family:inherit;font-size:12px;font-weight:850;color:var(--muted);text-decoration:underline;text-underline-offset:3px}
.myr .card{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 9px 26px rgba(0,51,38,.075);overflow:hidden;margin-bottom:18px}
.myr .chead{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;padding:18px 22px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.myr .ctitle{font-size:19px;font-weight:900;letter-spacing:-.4px;color:var(--forest)}
.myr .csub{font-size:11.5px;color:var(--muted);margin-top:5px;line-height:1.5;max-width:640px}
.myr .picks{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.myr select{font-family:inherit;font-size:12.5px;font-weight:800;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px 11px;cursor:pointer}
.myr .btn{font-family:inherit;font-size:12px;font-weight:900;border-radius:9px;padding:8px 14px;cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--forest)}
.myr .btn:disabled{opacity:.5;cursor:default}
.myr .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:18px 22px}
.myr .tile{background:var(--slot);border:1px solid var(--line);border-radius:13px;padding:13px 15px}
.myr .tile.pay{background:var(--mintSoft);border-color:var(--mintEdge)}
.myr .tl{font-size:9px;font-weight:900;letter-spacing:.9px;text-transform:uppercase;color:var(--muted)}
.myr .tv{font-size:27px;font-weight:900;letter-spacing:-1.1px;color:var(--forest);margin-top:6px;line-height:1}
.myr .tn{font-size:10.5px;font-weight:750;color:var(--muted);margin-top:7px;line-height:1.45}
.myr .sec{padding:4px 22px 18px}
.myr .sech{font-size:9.5px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:14px 0 9px}
.myr table{width:100%;border-collapse:separate;border-spacing:0}
.myr th{text-align:right;font-size:9px;font-weight:900;letter-spacing:.85px;text-transform:uppercase;color:var(--muted);padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.myr th:first-child{text-align:left}
.myr td{padding:9px 12px;text-align:right;font-size:12.5px;font-weight:800;border-bottom:1px solid #EDF1EC;white-space:nowrap}
.myr td:first-child{text-align:left;font-weight:850;color:var(--forest)}
.myr tfoot td{border-bottom:0;border-top:2px solid var(--forest);font-weight:900;color:var(--forest)}
.myr .city{font-size:11px;font-weight:750;color:var(--muted)}
.myr .wk{border:1px solid var(--line);border-radius:13px;margin-bottom:11px;overflow:hidden}
.myr .wkh{display:flex;align-items:center;gap:14px;padding:11px 15px;background:var(--slot);border-bottom:1px solid var(--line);flex-wrap:wrap}
.myr .wkr{font-size:12.5px;font-weight:900;color:var(--forest)}
.myr .wkd{font-size:10.5px;font-weight:750;color:var(--muted)}
.myr .wkt{margin-left:auto;font-size:13px;font-weight:900;color:var(--forest)}
.myr .mr{display:grid;grid-template-columns:152px 1fr 104px 82px;gap:12px;align-items:center;padding:9px 15px;border-top:1px solid #EDF1EC;font-size:12.5px}
.myr .mr:first-child{border-top:0}
.myr .md{font-weight:850;color:var(--ink)}
.myr .mf{font-weight:850;color:var(--forest)}
.myr .mc{font-size:11px;font-weight:750;color:var(--muted)}
.myr .mp{text-align:right;font-weight:900}
.myr .pillx{font-size:8.5px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;border-radius:99px;padding:3px 8px;white-space:nowrap;justify-self:start}
.myr .pillx.two{background:var(--mintSoft);color:var(--mintInk);border:1px solid var(--mintEdge)}
.myr .pillx.canc{background:#FDE9E5;color:var(--coralInk);border:1px solid #F3C4BB}
.myr .pillx.adj{background:var(--amber);color:var(--amberInk);border:1px solid var(--amberEdge)}
.myr .mr.cancelled .md,.myr .mr.cancelled .mf,.myr .mr.cancelled .mp{color:var(--faint)}
.myr .mr.cancelled .mf{text-decoration:line-through}
.myr .mr.adjust{background:#FFFDF4}
.myr .foot{padding:12px 22px 18px;font-size:11px;color:var(--muted);line-height:1.6}
.myr .recon{margin:0 22px 18px;padding:11px 14px;border-radius:11px;background:var(--mintSoft);border:1px solid var(--mintEdge);font-size:11px;font-weight:800;color:var(--mintInk);line-height:1.6}
@media print{
  .myr .hostbar,.myr .picks,.myr .noprint{display:none!important}
  .myr .card{box-shadow:none;border:0;margin:0 0 10px}
  .myr .wk{break-inside:avoid}
}
`;
