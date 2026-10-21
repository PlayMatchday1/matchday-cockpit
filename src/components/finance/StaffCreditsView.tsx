"use client";

// CREDITS GIVEN BY STAFF (Ryan, 2026-10-21). Who gave what, from change_log (lib/staffCredits,
// /api/admin/staff-credits). Admins only: the rail hides it from everyone else and the route refuses
// them. A summary per staff member for the picked range, the months it covers, and the detail list
// with filters, flags and a CSV of exactly what is listed.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import {
  FLAG_LABEL, chicagoDay, filterEntries, monthlyBreakdown, staffCreditsCsv, staffSummary,
  type CreditEntry, type CreditFilter,
} from "@/lib/staffCredits";

const money = (c: number | null) => (c == null ? "-" : `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`);
const signed = (c: number) => `${c > 0 ? "+" : c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const toCents = (s: string) => { const n = Number(s); return s.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100); };

const INPUT = "rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none";
const CARD = "overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10";
const TH = "px-3 py-2 text-left";

export default function StaffCreditsView() {
  const { appUser, isLoading } = useAuth();
  const isAdmin = appUser?.is_admin === true && appUser.is_service_account !== true;
  const today = chicagoDay(new Date().toISOString());
  const [entries, setEntries] = useState<CreditEntry[] | null>(null);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [tags, setTags] = useState<Record<string, "warsaw" | "test">>({});
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<CreditFilter>({ since: `${today.slice(0, 8)}01`, until: today, staff: "", player: "", minCents: null, maxCents: null, reason: "", flaggedOnly: false });
  const [minText, setMinText] = useState(""), [maxText, setMaxText] = useState("");

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) { setErr("Sign in again."); return; }
      const r = await fetch("/api/admin/staff-credits", { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      if (!alive) return;
      if (!r.ok || !j?.entries) { setErr(j?.error ?? `HTTP ${r.status}`); return; }
      setEntries(j.entries);
      setNames(new Map(Object.entries(j.names as Record<string, string>).map(([k, v]) => [Number(k), v])));
      setTags(j.tags ?? {});
    })().catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [isAdmin]);

  const filter = useMemo(() => ({ ...f, minCents: toCents(minText), maxCents: toCents(maxText) }), [f, minText, maxText]);
  const rangeOnly = useMemo(() => filterEntries(entries ?? [], { ...filter, staff: "", player: "", minCents: null, maxCents: null, reason: "", flaggedOnly: false }, names), [entries, filter, names]);
  const listed = useMemo(() => filterEntries(entries ?? [], filter, names), [entries, filter, names]);
  const summary = useMemo(() => staffSummary(rangeOnly), [rangeOnly]);
  const months = useMemo(() => monthlyBreakdown(rangeOnly), [rangeOnly]);
  const staffList = useMemo(() => [...new Set((entries ?? []).map((e) => e.staff))].sort(), [entries]);
  const monthStaff = useMemo(() => [...new Set(months.flatMap((m) => Object.keys(m.byStaff)))].sort(), [months]);

  const downloadCsv = () => {
    const blob = new Blob([staffCreditsCsv(listed, names)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `staff-credits-${filter.since}-to-${filter.until}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (isLoading) return null;
  if (!isAdmin) return <p className="text-sm text-deep-green/65" data-testid="sc-denied">This page is for admins only.</p>;

  return (
    <div data-testid="staff-credits">
      <div className="mb-5">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">Credits given by staff</h1>
        <p className="mt-2 text-sm text-deep-green/65">Every credit changed in the Clubhouse since Aug 14, 2026, with who did it and why. Dates are Central time. Warsaw players and our own test accounts are included and tagged.</p>
        <p className="mt-2 rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-sm text-deep-green" data-testid="sc-retool-note">
          Credits changed in Retool aren&apos;t recorded and don&apos;t appear here. Use Player Lookup to give credits.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <label className="text-xs font-bold text-deep-green/60">From<br /><input type="date" className={INPUT} value={f.since} max={f.until} data-testid="sc-since" onChange={(e) => e.target.value && setF({ ...f, since: e.target.value })} /></label>
        <label className="text-xs font-bold text-deep-green/60">To<br /><input type="date" className={INPUT} value={f.until} min={f.since} data-testid="sc-until" onChange={(e) => e.target.value && setF({ ...f, until: e.target.value })} /></label>
        <label className="text-xs font-bold text-deep-green/60">Staff<br />
          <select className={INPUT} value={f.staff} data-testid="sc-staff" onChange={(e) => setF({ ...f, staff: e.target.value })}>
            <option value="">Everyone</option>
            {staffList.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold text-deep-green/60">Player<br /><input className={INPUT} placeholder="Name or ID" value={f.player} data-testid="sc-player" onChange={(e) => setF({ ...f, player: e.target.value })} /></label>
        <label className="text-xs font-bold text-deep-green/60">Amount from ($)<br /><input className={`${INPUT} w-24`} inputMode="decimal" value={minText} data-testid="sc-min" onChange={(e) => setMinText(e.target.value)} /></label>
        <label className="text-xs font-bold text-deep-green/60">to ($)<br /><input className={`${INPUT} w-24`} inputMode="decimal" value={maxText} data-testid="sc-max" onChange={(e) => setMaxText(e.target.value)} /></label>
        <label className="text-xs font-bold text-deep-green/60">Reason contains<br /><input className={INPUT} value={f.reason} data-testid="sc-reason" onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
        <label className="flex items-center gap-1.5 pb-2 text-sm text-deep-green"><input type="checkbox" checked={f.flaggedOnly} data-testid="sc-flagged" onChange={(e) => setF({ ...f, flaggedOnly: e.target.checked })} /> Flagged only</label>
      </div>

      {err && <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-sm text-coral">Could not load: {err}</div>}
      {!entries && !err && <p className="text-sm text-deep-green/55">Loading…</p>}

      {entries && (
        <>
          <section className={`${CARD} mb-5`} data-testid="sc-summary">
            <div className="px-4 pt-3 text-sm font-bold text-deep-green">By staff member, {f.since} to {f.until}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                  <tr className="border-b border-cream-line"><th className={TH}>Staff</th><th className={TH}>Credits given</th><th className={TH}>Total added</th><th className={TH}>Total removed</th><th className={TH}>Average credit</th><th className={TH}>Net</th></tr>
                </thead>
                <tbody>
                  {summary.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-deep-green/55">No credits changed in this range.</td></tr>}
                  {summary.map((r) => (
                    <tr key={r.staff} className="border-b border-cream-line/60" data-testid="sc-summary-row" data-staff={r.staff}>
                      <td className="px-3 py-2">{r.staff}</td><td className="px-3 py-2">{r.given}</td><td className="px-3 py-2">{money(r.addedCents)}</td>
                      <td className="px-3 py-2">{money(r.removedCents)}</td><td className="px-3 py-2">{money(r.avgGivenCents)}</td><td className="px-3 py-2 font-bold">{signed(r.netCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={`${CARD} mb-5`} data-testid="sc-months">
            <div className="px-4 pt-3 text-sm font-bold text-deep-green">Month by month</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                  <tr className="border-b border-cream-line"><th className={TH}>Month</th><th className={TH}>Credits given</th><th className={TH}>Added</th><th className={TH}>Removed</th><th className={TH}>Net</th>
                    {monthStaff.map((s) => <th key={s} className={TH}>{s.split("@")[0]}</th>)}</tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.month} className="border-b border-cream-line/60" data-testid="sc-month-row" data-month={m.month} data-net={m.netCents}>
                      <td className="px-3 py-2">{monthName(m.month)}</td><td className="px-3 py-2">{m.given}</td><td className="px-3 py-2">{money(m.addedCents)}</td>
                      <td className="px-3 py-2">{money(m.removedCents)}</td><td className="px-3 py-2 font-bold">{signed(m.netCents)}</td>
                      {monthStaff.map((s) => <td key={s} className="px-3 py-2">{m.byStaff[s] ? signed(m.byStaff[s]) : ""}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={CARD} data-testid="sc-detail">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
              <span className="text-sm font-bold text-deep-green">{listed.length} change{listed.length === 1 ? "" : "s"}</span>
              <button type="button" className="rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream hover:bg-deep-green-soft disabled:opacity-40" disabled={listed.length === 0} data-testid="sc-csv" onClick={downloadCsv}>Download CSV</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                  <tr className="border-b border-cream-line"><th className={TH}>When</th><th className={TH}>Staff</th><th className={TH}>Player</th><th className={TH}>Amount</th><th className={TH}>Before</th><th className={TH}>After</th><th className={TH}>Reason</th><th className={TH}>Flags</th></tr>
                </thead>
                <tbody>
                  {listed.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-deep-green/55">Nothing matches these filters.</td></tr>}
                  {listed.map((e) => (
                    <tr key={e.id} className={`border-b border-cream-line/60 ${e.counted ? "" : "opacity-50"}`} data-testid="sc-row" data-staff={e.staff} data-amount={e.amountCents}>
                      <td className="whitespace-nowrap px-3 py-2">{when(e.at)}</td>
                      <td className="px-3 py-2">{e.staff}</td>
                      <td className="px-3 py-2">{e.playerId != null
                        ? <a className="font-semibold underline decoration-deep-green/30 hover:decoration-deep-green" href={`/match-ops/player-lookup?id=${e.playerId}`}>{names.get(e.playerId) || `#${e.playerId}`}</a>
                        : "-"}
                        {e.playerId != null && tags[e.playerId] && (
                          <span className="ml-1 rounded-full bg-cream-soft px-1.5 text-[10px] font-semibold text-deep-green/70" data-testid="sc-tag">{tags[e.playerId] === "warsaw" ? "Warsaw" : "Test account"}</span>
                        )}</td>
                      <td className={`px-3 py-2 font-bold ${e.amountCents < 0 ? "text-coral" : ""}`}>{signed(e.amountCents)}</td>
                      <td className="px-3 py-2">{money(e.beforeCents)}</td>
                      <td className="px-3 py-2">{money(e.afterCents)}</td>
                      <td className="px-3 py-2">{e.reason || <span className="text-deep-green/45">none given</span>}{!e.counted && <span className="ml-1 text-deep-green/55">(not applied: {e.outcome})</span>}</td>
                      <td className="px-3 py-2">{e.flags.map((fl) => (
                        <span key={fl} className="mr-1 inline-block rounded-full border border-coral/40 bg-coral-soft px-1.5 text-[10px] font-semibold text-coral-hover">{FLAG_LABEL[fl]}</span>
                      ))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
