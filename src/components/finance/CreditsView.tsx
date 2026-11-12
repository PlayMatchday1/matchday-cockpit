"use client";

// FINANCE › CREDITS (Ryan, 2026-11-10). Admins only. Two tabs, Monthly the default:
//   Monthly  the monthly player credits report: cancellation credits issued (rebuilt from bookings), staff credits
//            issued, credits used, the month-end balance from the nightly snapshot, and Unexplained once a month
//            has a night snapshot at both ends (/api/admin/credits)
//   Staff    the Staff Credits page, moved in unchanged (StaffCreditsView); ?month=YYYY-MM opens it on that month
// LAYOUT (2026-11-11): the table is the only thing that stands out. Under it, one grey line of counts for what to
// act on (negative balances, matches credited twice, member credits since the last stored month), which expands
// to a small table linked to Player Lookup and is absent when there is nothing; and "How these numbers are
// calculated", which expands the notes. Rebuild a month lives in the ⋯ menu beside Download. No red anywhere.
// The tab is in the URL (?tab=). It is written with history.replaceState: /admin/finance/* is prerendered
// static, and router.replace to the same path does not navigate there (FinanceShell, measured).

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import StaffCreditsView from "@/components/finance/StaffCreditsView";
import { dayLabel, monthLabel, monthlyCsv, UNEXPLAINED_FLAG_CENTS, type MonthlyRow } from "@/lib/creditsReport";

type Row = MonthlyRow & { matchCancelCents: number; playerCancelCents: number; closedAt: string | null };
type Snap = { day: string; taken_at: string; triggered_by: string; outstanding_cents: number; players_with_balance: number; negative_count: number; negative_cents: number };
type Report = {
  today: string; rows: Row[]; latestSnapshot: Snap | null; snapshotsFrom: string | null; snapshotError: string | null; closedError: string | null; rebuiltFrom: string;
  memberCredits: { bookingId: number; userId: number; playerName: string; matchId: number; matchName: string | null; matchDay: string | null; kind: "match" | "player"; day: string; cents: number }[];
  negatives: { id: number; name: string; city: string | null; cents: number; syncedAt: string | null }[];
  doubles: { matchId: number; matchName: string | null; matchDay: string | null; players: { id: number; name: string; cents: number }[]; cents: number; creditedAt: string }[];
  lastStoredMonth: string | null; matchesSyncedAt: string | null;
};
type Tab = "monthly" | "staff";
const TABS: { key: Tab; label: string }[] = [{ key: "monthly", label: "Monthly" }, { key: "staff", label: "Staff" }];
const lookup = (id: number) => `/match-ops/player-lookup?id=${id}`;

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CARD = "rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10";
const TH = "px-3 py-2 text-left";
const THR = "px-3 py-2 text-right";
const TDR = "px-3 py-2 text-right tabular-nums";
const NOTE = "text-xs text-deep-green/55";
const TOGGLE = "text-xs text-deep-green/55 underline decoration-deep-green/20 underline-offset-2 hover:text-deep-green";

export default function CreditsView() {
  const { appUser, isLoading } = useAuth();
  const isAdmin = appUser?.is_admin === true && appUser.is_service_account !== true;
  const params = useSearchParams();
  const urlTab = params?.get("tab");
  const tab: Tab = urlTab === "staff" ? "staff" : "monthly";
  const staffMonth = params?.get("month") ?? null;
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /* REBUILD MONTH: one stored month at a time. `confirm` is the month awaiting a second click; the result says
   * what changed, or why it didn't. */
  const [confirmMonth, setConfirmMonth] = useState<string | null>(null);
  const [busyMonth, setBusyMonth] = useState<string | null>(null);
  const [rebuilt, setRebuilt] = useState<{ month: string; text: string; ok: boolean } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flagsOpen, setFlagsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

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
  }, [isAdmin, reloadKey]);

  const rebuildMonth = async (month: string) => {
    setBusyMonth(month); setConfirmMonth(null); setMenuOpen(false); setRebuilt(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) { setRebuilt({ month, ok: false, text: "Sign in again." }); return; }
      const r = await fetch("/api/admin/credits/rebuild", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ month }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.after) { setRebuilt({ month, ok: false, text: `Not rebuilt: ${j?.error ?? `HTTP ${r.status}`}` }); return; }
      const total = (f: { match_cancel_cents: number; player_cancel_cents: number; staff_cents: number }) => f.match_cancel_cents + f.player_cancel_cents + f.staff_cents;
      const same = JSON.stringify(j.before) === JSON.stringify(j.after);
      setRebuilt({ month, ok: true, text: `${monthLabel(month)} rebuilt${same ? ", no change" : ""}: total issued ${money(total(j.before))} → ${money(total(j.after))}, credits used ${money(j.before.used_cents)} → ${money(j.after.used_cents)}.${j.logged ? "" : ` It was NOT logged to the change log: ${j.logError}`}` });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setRebuilt({ month, ok: false, text: `Not rebuilt: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyMonth(null);
    }
  };

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

  const stored = report ? [...report.rows].reverse().filter((r) => r.closedAt) : [];
  const showUnexplained = !!report?.rows.some((r) => r.unexplainedCents != null);

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

      {tab !== "staff" && err && <p className="text-sm text-deep-green/70" data-testid="cr-load-error">Could not load: {err}</p>}
      {tab !== "staff" && !report && !err && <p className="text-sm text-deep-green/55">Loading…</p>}

      {tab === "monthly" && report && (
        <>
          <section className={CARD} data-testid="cr-monthly">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
              <span className="text-sm font-bold text-deep-green">Player credits by month (USD, Central time)</span>
              <div className="relative flex items-center gap-1">
                <button type="button" className="rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream hover:bg-deep-green-soft" data-testid="cr-csv" onClick={download}>Download CSV</button>
                {stored.length > 0 && (
                  <button type="button" aria-label="More" aria-expanded={menuOpen} data-testid="cr-menu"
                    className="rounded-full px-2 py-0.5 text-base leading-none text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
                    onClick={() => { setMenuOpen((o) => !o); setConfirmMonth(null); }}>⋯</button>
                )}
                {menuOpen && (
                  <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-lg border border-cream-line bg-white p-2 text-xs text-deep-green shadow-md" data-testid="cr-menu-panel">
                    <div className="px-1 pb-1 font-bold">Rebuild a month</div>
                    {confirmMonth == null ? (
                      <>
                        {stored.map((r) => (
                          <button key={r.month} type="button" data-testid="cr-rebuild" data-month={r.month} disabled={busyMonth != null}
                            title={`Stored ${new Date(r.closedAt!).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" })}. Rebuild it from the bookings and overwrite the stored figures.`}
                            className="block w-full rounded px-1 py-1 text-left hover:bg-cream-soft disabled:opacity-40" onClick={() => setConfirmMonth(r.month)}>
                            {busyMonth === r.month ? "Rebuilding…" : monthLabel(r.month)}
                          </button>
                        ))}
                        <p className="px-1 pt-1 text-deep-green/55">Reruns a stored month from the bookings and overwrites it.</p>
                      </>
                    ) : (
                      <div className="space-y-2 px-1">
                        <p>Overwrite the stored {monthLabel(confirmMonth)} figures?</p>
                        <div className="flex gap-1">
                          <button type="button" className="rounded-full bg-deep-green px-2 py-0.5 font-bold text-cream" data-testid="cr-rebuild-confirm" onClick={() => rebuildMonth(confirmMonth)}>Overwrite {monthLabel(confirmMonth)}</button>
                          <button type="button" className="rounded-full border border-cream-line px-2 py-0.5 text-deep-green/70" onClick={() => setConfirmMonth(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            {report.closedError && <p className={`px-4 pt-1 ${NOTE}`} data-testid="cr-closed-error">{report.closedError}.</p>}
            {report.snapshotError && <p className={`px-4 pt-1 ${NOTE}`} data-testid="cr-snapshot-error">{report.snapshotError}. Month-end balances are missing because of it, not because none were taken.</p>}
            {busyMonth && <p className={`px-4 pt-1 ${NOTE}`}>Rebuilding {monthLabel(busyMonth)}…</p>}
            {rebuilt && <p className={`px-4 pt-1 text-xs ${rebuilt.ok ? "text-deep-green/55" : "font-semibold text-attn"}`} data-testid="cr-rebuild-result" data-ok={rebuilt.ok}>{rebuilt.text}</p>}
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
                  <tr className="border-b border-cream-line">
                    <th className={TH}>Month</th><th className={THR}>Cancellation credits issued</th><th className={THR}>Staff credits issued</th>
                    <th className={THR}>Total issued</th><th className={THR}>Credits used</th><th className={THR}>Month-end balance</th>
                    {showUnexplained && <th className={THR}>Unexplained</th>}
                  </tr>
                </thead>
                <tbody>
                  {[...report.rows].reverse().map((r) => (
                    <tr key={r.month} className="border-b border-cream-line/60 last:border-0" data-testid="cr-row" data-month={r.month}
                      data-cancellation={r.cancellationCents} data-staff={r.staffCents} data-used={r.usedCents} data-unexplained={r.unexplainedCents ?? ""}>
                      <td className="px-3 py-2">{monthLabel(r.month)}{r.partialThrough && <span className="ml-1 text-xs text-deep-green/55">(through {dayLabel(r.partialThrough)})</span>}</td>
                      <td className={TDR} title={`Matches we cancelled ${money(r.matchCancelCents)} · players cancelling more than 24 hours ahead ${money(r.playerCancelCents)}`}>{money(r.cancellationCents)}</td>
                      <td className={TDR}>
                        {r.staffRecorded
                          ? <a className="underline decoration-deep-green/30 hover:decoration-deep-green" href={`/admin/finance/credits?tab=staff&month=${r.month}`}
                              data-testid="cr-staff-link" onClick={(e) => { e.preventDefault(); go("staff", r.month); }}>{money(r.staffCents)}</a>
                          : <span className="text-deep-green/45" data-testid="cr-staff-unrecorded" title="Not recorded before Aug 14, 2026">–</span>}
                      </td>
                      <td className={`${TDR} font-bold`}>{money(r.totalIssuedCents)}</td>
                      <td className={TDR}>{money(r.usedCents)}</td>
                      <td className={TDR}>{r.monthEndCents == null ? ""
                        : r.partialThrough
                          ? <span className="text-deep-green/70">{money(r.monthEndCents)} <span className="text-xs">as of {r.balanceAsOf ? dayLabel(r.balanceAsOf) : ""}</span></span>
                          : money(r.monthEndCents)}</td>
                      {showUnexplained && (
                        <td className={`${TDR} ${r.unexplainedCents != null && Math.abs(r.unexplainedCents) > UNEXPLAINED_FLAG_CENTS ? "font-bold text-attn" : ""}`} data-testid="cr-unexplained">
                          {r.unexplainedCents == null ? "" : money(r.unexplainedCents)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="mt-3 space-y-2 px-1">
            {report.rows.some((r) => !r.staffRecorded) && <p className={NOTE} data-testid="cr-staff-footnote">– Staff credits weren&apos;t recorded before Aug 14, 2026, so those months show cancellation credits only.</p>}
            <Flags report={report} open={flagsOpen} onToggle={() => setFlagsOpen((o) => !o)} />
            <div>
              <button type="button" className={TOGGLE} aria-expanded={notesOpen} data-testid="cr-notes-toggle" onClick={() => setNotesOpen((o) => !o)}>How these numbers are calculated</button>
              {notesOpen && <Notes report={report} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* WHAT TO ACT ON: counts only, one grey line; it expands to a small table. Each part shows only when it has
 * something in it, and the whole line is absent when nothing does. Negative balances are as the night pass last
 * read them; "credited twice" is a "credit everyone who paid" run on a match later cancelled; member credits are
 * bookings a member paid for on a match not free for members, credited back since the last stored month. */
function Flags({ report, open, onToggle }: { report: Report; open: boolean; onToggle: () => void }) {
  const { negatives, doubles, memberCredits } = report;
  const twice = doubles.flatMap((d) => d.players.map((p) => ({ ...p, d })));
  if (negatives.length === 0 && twice.length === 0 && memberCredits.length === 0) return null;
  const since = report.lastStoredMonth ? `since ${monthLabel(report.lastStoredMonth)} was stored` : "since Dec 2025";
  const counts = [
    negatives.length ? `${plural(negatives.length, "negative balance")} (${money(negatives.reduce((a, n) => a + n.cents, 0))})` : null,
    doubles.length ? `${plural(doubles.length, "match", "matches")} credited twice (${money(doubles.reduce((a, d) => a + d.cents, 0))})` : null,
    memberCredits.length ? plural(memberCredits.length, "member credit") : null,
  ].filter(Boolean).join(" · ");
  const name = (id: number, n: string) => <a className="underline decoration-deep-green/30 hover:decoration-deep-green" href={lookup(id)}>{n || `#${id}`}</a>;
  const Head = ({ title, cols }: { title: string; cols: string[] }) => (
    <>
      <tr><td colSpan={4} className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">{title}</td></tr>
      <tr className="border-b border-cream-line text-deep-green/55">{cols.map((c, i) => <td key={c} className={`px-2 py-1 ${i === 1 ? "text-right" : ""}`}>{c}</td>)}</tr>
    </>
  );
  const TD = "px-2 py-1";
  return (
    <div data-testid="cr-flags">
      <button type="button" className={TOGGLE} aria-expanded={open} data-testid="cr-flags-toggle" onClick={onToggle}>{counts}</button>
      {open && (
        <div className="mt-1 max-w-2xl overflow-x-auto">
          <table className="w-full text-xs text-deep-green/80">
            <tbody>
              {negatives.length > 0 && <>
                <Head title="Negative balances" cols={["Player", "Amount", "", ""]} />
                {negatives.map((n) => (
                  <tr key={`n${n.id}`} className="border-b border-cream-line/60" data-testid="cr-negative" data-cents={n.cents}>
                    <td className={TD}>{name(n.id, n.name)}</td><td className={`${TD} text-right tabular-nums`}>{money(n.cents)}</td><td className={TD} colSpan={2} />
                  </tr>
                ))}
              </>}
              {twice.length > 0 && <>
                <Head title="Credited twice (credit everyone who paid, then the match was cancelled)" cols={["Player", "Amount", "Match", "Date"]} />
                {twice.map((p) => (
                  <tr key={`d${p.d.matchId}-${p.id}`} className="border-b border-cream-line/60" data-testid="cr-double" data-match={p.d.matchId} data-cents={p.cents}>
                    <td className={TD}>{name(p.id, p.name)}</td><td className={`${TD} text-right tabular-nums`}>{money(p.cents)}</td>
                    <td className={TD}>{p.d.matchName ?? `#${p.d.matchId}`}</td><td className={TD}>{p.d.matchDay ? shortDay(p.d.matchDay) : ""}</td>
                  </tr>
                ))}
              </>}
              {memberCredits.length > 0 && <>
                <Head title={`Member credits on paid matches ${since}`} cols={["Player", "Amount", "Match", "Date"]} />
                {memberCredits.map((c) => (
                  <tr key={`m${c.bookingId}`} className="border-b border-cream-line/60" data-testid="cr-member-credit" data-cents={c.cents}>
                    <td className={TD}>{name(c.userId, c.playerName)}</td><td className={`${TD} text-right tabular-nums`}>{money(c.cents)}</td>
                    <td className={TD}>{c.matchName ?? `#${c.matchId}`} <span className="text-deep-green/50">({c.kind === "match" ? "we cancelled it" : "left more than 24 hours ahead"})</span></td>
                    <td className={TD}>{shortDay(c.day)}</td>
                  </tr>
                ))}
              </>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* THE NOTES: one short line per column, then what is left out and where the figures come from. */
function Notes({ report }: { report: Report }) {
  const stored = report.rows.some((r) => r.closedAt);
  const lines: [string, string][] = [
    ["Month", stored
      ? `Central time, in USD. Credits began Dec 23, 2025. Months before ${monthLabel(report.rebuiltFrom)} are stored two days after they end; later months are rebuilt each time the page opens.`
      : "Central time, in USD. Credits began Dec 23, 2025. Every month is rebuilt each time the page opens, and stored two days after it ends."],
    ["Cancellation credits issued", "Rebuilt from bookings, because the app records none. A match we cancel credits everyone still on it, on the match day. A player who leaves more than 24 hours ahead gets a paid booking back as credit, on the day they left. Members leaving 6 to 24 hours ahead get nothing."],
    ["Staff credits issued", "The Staff tab's net for the month, without Warsaw players or test accounts. Recorded from Aug 14, 2026; earlier months show – because nothing recorded them, and their Total issued is cancellation credits only."],
    ["Total issued", "Cancellation credits plus staff credits."],
    ["Credits used", "Credit spent on paid bookings, on the booking day."],
    ["Month-end balance", `The night snapshot on the 1st of the next month${report.snapshotsFrom ? `; snapshots start ${shortDay(report.snapshotsFrom)}` : "; no snapshot has been taken yet"}. Blank when there isn't one. The current month shows the latest snapshot and its date.`],
    ["Unexplained", "How far the balance moved beyond credits issued less credits used. Shown once a month has a night snapshot at both ends, from December on. Amber when it is over $25 either way."],
  ];
  return (
    <div className="mt-2 max-w-3xl space-y-1 text-xs text-deep-green/60" data-testid="cr-notes">
      {lines.map(([k, v]) => <p key={k}><span className="font-semibold text-deep-green/75">{k}.</span> {v}</p>)}
      <p>Members get credits like anyone on a match that isn&apos;t free for members. On a match free for members their own spot costs $0, so it is credited $0.</p>
      <p>Left out everywhere: @matchday.com and @playmatchday.com accounts, deleted accounts, fake players and Warsaw. Credit held in another currency&apos;s wallet reads $0.</p>
      <p>Rebuild a month, in the ⋯ menu, reruns a stored month from the bookings and overwrites it. It is logged in the Change Log; the night run never overwrites.</p>
      {report.matchesSyncedAt && <p>Bookings as of the last match sync, {when(report.matchesSyncedAt)}.</p>}
      <p data-testid="cr-retool-note">Credits changed in Retool aren&apos;t recorded anywhere and won&apos;t appear here. Use Player Lookup to give credits.</p>
    </div>
  );
}
