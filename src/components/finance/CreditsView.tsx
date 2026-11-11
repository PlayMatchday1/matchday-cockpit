"use client";

// FINANCE › CREDITS (Ryan, 2026-11-10). Admins only. Three tabs, Monthly the default:
//   Monthly  the monthly player credits report: cancellation credits issued (rebuilt from bookings), staff credits
//            issued, credits used, and the month-end balance from the nightly snapshot (/api/admin/credits)
//   Staff    the Staff Credits page, moved in unchanged (StaffCreditsView); ?month=YYYY-MM opens it on that month
//   Flags    negative balances, double credits from "credit everyone who paid" on a later-cancelled match,
//            and the standing Retool note
// The tab is in the URL (?tab=). It is written with history.replaceState: /admin/finance/* is prerendered
// static, and router.replace to the same path does not navigate there (FinanceShell, measured).

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import StaffCreditsView from "@/components/finance/StaffCreditsView";
import { monthLabel, monthlyCsv, type MonthlyRow } from "@/lib/creditsReport";

type Row = MonthlyRow & { matchCancelCents: number; playerCancelCents: number; monthEndDay: string | null };
type Snap = { day: string; taken_at: string; triggered_by: string; outstanding_cents: number; players_with_balance: number; negative_count: number; negative_cents: number };
type Report = {
  today: string; rows: Row[]; latestSnapshot: Snap | null; snapshotsFrom: string | null; snapshotError: string | null;
  negatives: { id: number; name: string; city: string | null; cents: number; syncedAt: string | null }[];
  doubles: { matchId: number; matchName: string | null; matchDay: string | null; players: number; cents: number; creditedAt: string }[];
  creditAllMatches: number; matchesSyncedAt: string | null;
};
type Tab = "monthly" | "staff" | "flags";
const TABS: { key: Tab; label: string }[] = [{ key: "monthly", label: "Monthly" }, { key: "staff", label: "Staff" }, { key: "flags", label: "Flags" }];

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const CARD = "overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10";
const TH = "px-3 py-2 text-left";
const THR = "px-3 py-2 text-right";
const TDR = "px-3 py-2 text-right tabular-nums";

export default function CreditsView() {
  const { appUser, isLoading } = useAuth();
  const isAdmin = appUser?.is_admin === true && appUser.is_service_account !== true;
  const params = useSearchParams();
  const urlTab = params?.get("tab");
  const tab: Tab = urlTab === "staff" || urlTab === "flags" ? urlTab : "monthly";
  const staffMonth = params?.get("month") ?? null;
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const go = (t: Tab, month?: string) => {
    const qs = new URLSearchParams();
    if (t !== "monthly") qs.set("tab", t);
    if (month) qs.set("month", month);
    const s = qs.toString();
    window.history.replaceState(null, "", s ? `/admin/finance/credits?${s}` : "/admin/finance/credits");
  };

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) { setErr("Sign in again."); return; }
      const r = await fetch("/api/admin/credits", { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => null);
      if (!alive) return;
      if (!r.ok || !j?.rows) { setErr(j?.error ?? `HTTP ${r.status}`); return; }
      setReport(j as Report);
    })().catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [isAdmin]);

  const download = () => {
    if (!report) return;
    const blob = new Blob([monthlyCsv([...report.rows].reverse())], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `player-credits-by-month-${report.today}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (isLoading) return null;
  if (!isAdmin) return <p className="text-sm text-deep-green/65" data-testid="cr-denied">This page is for admins only.</p>;

  return (
    <div data-testid="credits">
      <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">Credits</h1>
      <div className="mt-4 mb-5 flex gap-1 border-b border-cream-line" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} data-testid={`cr-tab-${t.key}`}
            className={`-mb-px rounded-t-md border-b-2 px-4 py-2 text-sm font-bold ${tab === t.key ? "border-deep-green text-deep-green" : "border-transparent text-deep-green/55 hover:text-deep-green"}`}
            onClick={() => go(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === "staff" && <StaffCreditsView key={staffMonth ?? "now"} month={staffMonth} embedded />}

      {tab !== "staff" && err && <div className="mb-4 rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-sm text-coral">Could not load: {err}</div>}
      {tab !== "staff" && !report && !err && <p className="text-sm text-deep-green/55">Loading…</p>}

      {tab === "monthly" && report && (
        <section className={CARD} data-testid="cr-monthly">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
            <span className="text-sm font-bold text-deep-green">Player credits by month (USD, Central time)</span>
            {report.snapshotError && <span className="w-full rounded-md border border-coral/40 bg-coral-soft/40 px-2 py-1 text-xs text-coral" data-testid="cr-snapshot-error">{report.snapshotError}. Month-end balances are missing because of it, not because none were taken.</span>}
            <button type="button" className="rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream hover:bg-deep-green-soft" data-testid="cr-csv" onClick={download}>Download CSV</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                <tr className="border-b border-cream-line">
                  <th className={TH}>Month</th><th className={THR}>Cancellation credits issued</th><th className={THR}>Staff credits issued</th>
                  <th className={THR}>Total issued</th><th className={THR}>Credits used</th><th className={THR}>Month-end balance</th>
                </tr>
              </thead>
              <tbody>
                {[...report.rows].reverse().map((r) => (
                  <tr key={r.month} className="border-b border-cream-line/60" data-testid="cr-row" data-month={r.month}
                    data-cancellation={r.cancellationCents} data-staff={r.staffCents} data-used={r.usedCents}>
                    <td className="px-3 py-2">{monthLabel(r.month)}{r.partialThrough && <span className="ml-1 text-xs text-deep-green/55">(through {shortDay(r.partialThrough)})</span>}</td>
                    <td className={TDR} title={`Matches we cancelled ${money(r.matchCancelCents)} · players cancelling more than 24 hours ahead ${money(r.playerCancelCents)}`}>{money(r.cancellationCents)}</td>
                    <td className={TDR}>
                      <a className="underline decoration-deep-green/30 hover:decoration-deep-green" href={`/admin/finance/credits?tab=staff&month=${r.month}`}
                        data-testid="cr-staff-link" onClick={(e) => { e.preventDefault(); go("staff", r.month); }}>{money(r.staffCents)}</a>
                    </td>
                    <td className={`${TDR} font-bold`}>{money(r.totalIssuedCents)}</td>
                    <td className={TDR}>{money(r.usedCents)}</td>
                    <td className={TDR}>{r.monthEndCents != null
                      ? money(r.monthEndCents)
                      : r.partialThrough && report.latestSnapshot
                        ? <span className="text-deep-green/70">{money(Number(report.latestSnapshot.outstanding_cents))} <span className="text-xs">as of {shortDay(report.latestSnapshot.day)}</span></span>
                        : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1 px-4 py-3 text-xs text-deep-green/60">
            <p>Cancellation credits are rebuilt from bookings, because the app records none: a match we cancelled credits every booking still on it (what the player paid plus credit they spent), dated by the match; a player who cancels more than 24 hours ahead is credited for a paid booking, dated by the cancellation. Members cancelling 6 to 24 hours ahead get no credit and are not counted.</p>
            <p>Credits used is the credit spent on paid bookings, dated by the booking. Staff credits are the Staff tab&apos;s net for the month, less Warsaw players and test accounts; recorded from Aug 14, 2026.</p>
            <p>Month-end balance is the night snapshot taken on the 1st{report.snapshotsFrom ? `; snapshots start ${shortDay(report.snapshotsFrom)}` : "; no snapshot has been taken yet"}. Left out everywhere: @matchday.com and @playmatchday.com accounts, deleted accounts, fake players and Warsaw. A credit held in another currency&apos;s wallet reads $0.</p>
            {report.matchesSyncedAt && <p>Bookings as of the last match sync, {when(report.matchesSyncedAt)}.</p>}
          </div>
        </section>
      )}

      {tab === "flags" && report && (
        <div className="space-y-5">
          <p className="rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-sm text-deep-green" data-testid="cr-retool-note">
            Credits changed in Retool aren&apos;t recorded anywhere and won&apos;t appear on any of these tabs. Use Player Lookup to give credits.
          </p>

          <section className={CARD} data-testid="cr-negatives">
            <div className="px-4 pt-3 text-sm font-bold text-deep-green">Negative balances <span className="font-normal text-deep-green/60">({report.negatives.length}, the app shouldn&apos;t allow these)</span></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                  <tr className="border-b border-cream-line"><th className={TH}>Player</th><th className={TH}>City</th><th className={THR}>Balance</th><th className={TH}>Read</th></tr>
                </thead>
                <tbody>
                  {report.negatives.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-deep-green/55">No player has a negative balance.</td></tr>}
                  {report.negatives.map((n) => (
                    <tr key={n.id} className="border-b border-cream-line/60" data-testid="cr-negative" data-cents={n.cents}>
                      <td className="px-3 py-2"><a className="font-semibold underline decoration-deep-green/30 hover:decoration-deep-green" href={`/match-ops/player-lookup?id=${n.id}`}>{n.name || `#${n.id}`}</a></td>
                      <td className="px-3 py-2">{n.city ?? ""}</td>
                      <td className={`${TDR} font-bold text-coral`}>{money(n.cents)}</td>
                      <td className="px-3 py-2 text-xs text-deep-green/60">{n.syncedAt ? when(n.syncedAt) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-deep-green/60">Balances as the night pass last read them; the Read column says when.</p>
          </section>

          <section className={CARD} data-testid="cr-doubles">
            <div className="px-4 pt-3 text-sm font-bold text-deep-green">Credited twice <span className="font-normal text-deep-green/60">(&quot;credit everyone who paid&quot;, then the match was cancelled)</span></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                  <tr className="border-b border-cream-line"><th className={TH}>Match</th><th className={TH}>Match day</th><th className={TH}>Staff credit</th><th className={THR}>Players</th><th className={THR}>Paid twice</th></tr>
                </thead>
                <tbody>
                  {report.doubles.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-deep-green/55">None. Staff have used it on {report.creditAllMatches} match{report.creditAllMatches === 1 ? "" : "es"}, and none was cancelled afterwards.</td></tr>}
                  {report.doubles.map((d) => (
                    <tr key={d.matchId} className="border-b border-cream-line/60" data-testid="cr-double" data-cents={d.cents}>
                      <td className="px-3 py-2">{d.matchName ?? `#${d.matchId}`} <span className="text-xs text-deep-green/55">#{d.matchId}</span></td>
                      <td className="px-3 py-2">{d.matchDay ? shortDay(d.matchDay) : ""}</td>
                      <td className="px-3 py-2">{when(d.creditedAt)}</td>
                      <td className={TDR}>{d.players}</td>
                      <td className={`${TDR} font-bold`}>{money(d.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-deep-green/60">The amount is what the staff run gave to players whose booking was still on the match when it was cancelled, so the cancel credited them again.</p>
          </section>
        </div>
      )}
    </div>
  );
}
