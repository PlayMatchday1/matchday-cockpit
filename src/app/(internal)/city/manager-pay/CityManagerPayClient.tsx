"use client";

// Phase 25 Part B — the city manager's Manager Pay. Built to docs/mockups/cmgr-v1_1.html.
//
// THE JOB THIS PAGE IS FOR: reassigning. Production carried ZERO unassigned matches across eight
// weeks, so a city manager is not filling blanks — they are covering when a manager cannot make it.
// The header and the week subtitle say that. The unassigned handling is still built in full (the
// model supports a null manager and it is cheap insurance) and simply reads as "nothing to look at"
// when the count is zero.
//
// NO CITY FILTER: one city per account, so there is nothing to filter. A fixed badge states the
// scope, and the scope is enforced SERVER-SIDE — this component could not see another city if it
// tried, because the route never puts one in the response.
//
// PAY IS THE REAL MODEL, never a flat $20: $20 solo, $30 solo tournament (maxPlayerCount >= 25),
// $20 + $20 co-managed. 37% of matches are tournaments, so a flat rate would be visibly wrong most
// days. The impact line calls payAmount() — the same function that computes the payroll.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
import { payAmount } from "@/lib/managerPayCompute";
import { reassignImpact } from "@/lib/cityManagerPayModel";
import PayPeriodBar from "@/components/PayPeriodBar";

const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", mint: "#e0f2e7",
  ink: "#12241d", muted: "#6d7b74", muted2: "#9aa8a1", line: "#e6ebe8", hair: "#eff3f1",
  surface: "#ffffff", rail: "#f6f9f7", chipBg: "#eef3f0", chipLine: "#e2eae5",
  warnBg: "#fdf1d0", warnInk: "#8a6300", warnLine: "#e3c369",
  critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9", ok: "#12704a",
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mondayOf = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
// The "last completed" Monday — the same definition the admin bar uses for its chip.
function defaultWeekStart(): string {
  const t = new Date();
  const m = mondayOf(t);
  m.setDate(m.getDate() - 7);
  return ymd(m);
}
const short = (iso: string) => { const d = new Date(iso.slice(0, 10) + "T00:00:00"); return `${MO[d.getMonth()]} ${d.getDate()}`; };

type MatchRow = {
  matchId: number; fieldTitle: string | null; startDate: string; centralDate: string;
  centralWeekday: string; centralTime: string; name: string | null; maxPlayerCount: number | null;
  playerCount: number | null; isCancelled: boolean;
  primaryManagerName: string | null; primaryManagerEmail: string | null;
  secondManagerName: string | null; managerId?: number | null;
};
type ManagerRow = {
  managerEmail: string | null; managerName: string; managerId: number | null;
  matchCount: number; baseTotal: number; adjustment: number; adjustmentNotes: string | null; total: number;
};
type CitySection = { cityIdentifier: string; managers: ManagerRow[]; matches: MatchRow[]; total: number; baseTotal: number; adjustment: number };
type Payload = {
  weekStart: string; weekEnd: string; payDate: string; cityIdentifier: string;
  payRun?: string | null; effectiveArrival?: string | null; arrivalError?: string | null;
  arrivalOverride?: { by?: string | null; at: string; reason: string } | null;
  city: CitySection | null; managers: { id: number; name: string; email: string | null }[];
  you: { email: string; matched: boolean; unmatchedAccount: boolean };
};

async function authFetch(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
}

export default function CityManagerPayClient() {
  const { appUser } = useAuth();
  const [week, setWeek] = useState(() => ymd(mondayOf(new Date())));
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  // The same Week + pay / Pay only toggle the admin bar carries.
  const [view, setView] = useState<"both" | "pay">("both");
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await authFetch(`/api/manager-pay/city-week?week=${week}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error || `Could not load the week (${res.status})`); setData(null); }
      else setData(j as Payload);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setData(null); }
    finally { setLoading(false); }
  }, [week]);
  useEffect(() => { void load(); }, [load]);

  const city = data?.city ?? null;
  const matches = useMemo(() => city?.matches ?? [], [city]);
  const payRows = useMemo(() => (city?.managers ?? []).slice().sort((a, b) => b.total - a.total), [city]);

  // ── the four tiles, all derived from the same array ──
  const cityTotal = city?.total ?? 0;
  const cancelled = matches.filter((m) => m.isCancelled);
  const unassigned = matches.filter((m) => !m.isCancelled && !m.primaryManagerName);
  const paidMatches = matches.filter((m) => !m.isCancelled && m.primaryManagerName).length;

  const openMatch = matches.find((m) => m.matchId === openId) ?? null;

  if (loading && !data) return <div className="p-8 text-sm" style={{ color: C.muted }}>Loading your week…</div>;

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-5" style={{ color: C.ink }}>
      {/* ── header: the scope, stated, with no filter ── */}
      <div className="mb-1 flex flex-wrap items-center gap-2.5">
        <h1 className="m-0 text-[20px] font-bold tracking-[-0.2px]" style={{ color: C.forestDeep }}>Manager Pay</h1>
        <span data-testid="city-badge" className="rounded-full border px-2.5 py-[3px] text-[11.5px] font-bold"
          style={{ background: C.mint, borderColor: "#bfe4cf", color: C.ok }}>{data?.cityIdentifier ?? appUser?.city_identifier ?? ""}</span>
      </div>
      {/* THE REAL JOB, first line. Not "fill the gaps" — reassigning when someone cannot make it. */}
      <p data-testid="city-note" className="m-0 mb-3.5 text-[12.5px]" style={{ color: C.muted }}>
        The week of {data ? short(data.weekStart) : "—"} — what your city owes, and who worked it. Click any match to
        change who is on it when a manager cannot make it. Your account covers {data?.cityIdentifier ?? ""}; other
        cities are not shown and cannot be reached from this login.
      </p>

      {/* THE PERIOD BAR — the app's own component, city-scoped. This tier previously had no period
          controls at all and could only ever see one week; the bar was inline in ManagerPayView, so
          there was nothing to mount. It is shared now, not rebuilt.
          The arrival "Change" is a WRITE (PUT /api/manager-pay/pay-arrival) and is rendered
          DISABLED with its reason rather than hidden — see PayPeriodBar's header. */}
      {data && (
        <PayPeriodBar
          weekStart={data.weekStart}
          weekEnd={data.weekEnd}
          defaultWeekStart={defaultWeekStart()}
          payRun={data.payRun ?? data.payDate ?? null}
          effectiveArrival={data.effectiveArrival ?? null}
          arrivalError={data.arrivalError ?? null}
          arrivalOverride={data.arrivalOverride ?? null}
          onWeek={setWeek}
          view={view}
          onView={setView}
          canChangeArrival={false}
          arrivalDisabledReason="only MatchDay can move this date"
        />
      )}

      {/* NO UNMATCHED-ACCOUNT WARNING. The YOU chip is a convenience: when the login email does not
          appear in this city's manager rows, no row is marked and that is the whole effect. The pay,
          the city scope and every figure on the page are correct either way, so a warning here
          announced a problem that did not exist. */}
      {err && <div role="alert" className="mb-3 rounded-[10px] border px-3 py-2 text-[12px] font-semibold" style={{ background: C.critBg, borderColor: C.critLine, color: C.critInk }}>{err}</div>}

      {/* ── tiles ── */}
      <div data-testid="tiles" className="cm-tiles mb-4 grid gap-2.5">
        <Tile label="TOTAL PAYOUT" value={money(cityTotal)} foot={data ? `pays ${short(data.payDate)}` : ""} />
        <Tile label="MANAGERS PAID" value={String(payRows.length)} foot={payRows.length === 1 ? "one manager" : "across the week"} />
        <Tile label="MATCHES PAID" value={String(paidMatches)}
          // cancelled and unassigned are counted SEPARATELY: different problems, neither pays.
          foot={`${cancelled.length} cancelled · ${unassigned.length} with no manager — neither pays`} />
        <Tile label="NEEDS A LOOK" value={String(unassigned.length)}
          foot={unassigned.length === 0 ? "every match that will run has a manager" : "will run with nobody assigned"} />
      </div>

      {/* the callout only exists when it is true */}
      {unassigned.length > 0 && (
        <div data-testid="unassigned-note" className="mb-3 rounded-[10px] border px-3 py-2 text-[12px] font-semibold"
          style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>
          {unassigned.length} match{unassigned.length === 1 ? " has" : "es have"} nobody assigned. {unassigned.length === 1 ? "It" : "They"} will
          still run, and {unassigned.length === 1 ? "it pays" : "they pay"} nobody until someone is on {unassigned.length === 1 ? "it" : "them"}.
        </div>
      )}

      {/* ── the week ── */}
      <section className="mb-4 rounded-[12px] border" style={{ background: C.surface, borderColor: C.line }}>
        {/* PAY ONLY hides the week grid — the toggle in the period bar has to DO something, or it
            is a control that looks live and does nothing. */}
        {view === "both" && (<>
        <div className="border-b px-4 py-3" style={{ borderColor: C.hair }}>
          <h2 className="m-0 text-[12px] font-bold tracking-[0.07em]" style={{ color: C.muted }}>THE WEEK, AND WHAT IT PAYS</h2>
          <p className="m-0 mt-1 text-[11.5px]" style={{ color: C.muted2 }}>
            {matches.length} match{matches.length === 1 ? "" : "es"} · click a match to change who is on it
          </p>
        </div>
        <div data-testid="week" className="cm-week grid gap-2 p-3">
          {DAYS.map((d) => {
            const here = matches.filter((m) => m.centralWeekday?.slice(0, 3) === d);
            return (
              <div key={d} className="cm-day rounded-[10px] border p-2" style={{ borderColor: C.chipLine, background: C.rail, minHeight: 64 }}>
                <div className="mb-1.5 text-[9.5px] font-bold uppercase tracking-[0.1em]" style={{ color: C.muted2 }}>{d}</div>
                {here.map((m) => {
                  const isCx = m.isCancelled;
                  const noMgr = !isCx && !m.primaryManagerName;
                  return (
                    <button key={m.matchId} type="button" onClick={() => setOpenId(m.matchId)}
                      // THE ONLY CHANGE TO THIS PAGE (Phase 29c): an anchor so Gameday Ops can
                      // link to a MATCH rather than to the page. Clicking a match on the read-only
                      // board scrolls to its row here. Deliberately an id and not a ?match= param
                      // that auto-opens the sheet — the sheet is the WRITE, and a write that opens
                      // itself because of where you clicked last is not a write anyone asked for.
                      id={`match-${m.matchId}`}
                      data-testid="match-card" data-match-id={m.matchId}
                      data-state={isCx ? "cancelled" : noMgr ? "unassigned" : "ok"}
                      className="mb-1.5 block w-full rounded-[9px] border p-[7px_8px] text-left"
                      // scrollMarginTop clears the sticky header, so the anchored row lands below
                      // it rather than under it.
                      style={{ scrollMarginTop: "96px",
                        ...(isCx ? { background: C.critBg, borderColor: C.critLine }
                          : noMgr ? { background: C.warnBg, borderColor: C.warnLine }
                          : { background: C.surface, borderColor: C.chipLine }) }}>
                      <span className="block text-[11px] font-bold" style={{ color: isCx ? C.critInk : C.forestDeep, textDecoration: isCx ? "line-through" : undefined }}>
                        {m.centralTime} · {m.fieldTitle ?? "—"}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1">
                        <span className="text-[10.5px] font-semibold" style={{ color: noMgr ? C.warnInk : C.muted, overflowWrap: "anywhere" }}>
                          {isCx ? "—" : m.primaryManagerName ?? "No manager"}
                        </span>
                        {isCx && <span className="rounded-[4px] border px-1 text-[9px] font-bold" style={{ background: "#fff", borderColor: C.critLine, color: C.critInk }}>CANCELLED</span>}
                        {!isCx && <span className="ml-auto text-[10.5px] font-bold" style={{ color: C.ok }}>{money(payAmount(m.maxPlayerCount, !!m.secondManagerName))}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        </>)}
      </section>

      {/* ── the pay table — whole city, read-only ── */}
      <section className="rounded-[12px] border" style={{ background: C.surface, borderColor: C.line }}>
        <div className="border-b px-4 py-3" style={{ borderColor: C.hair }}>
          <h2 className="m-0 text-[12px] font-bold tracking-[0.07em]" style={{ color: C.muted }}>WHAT THE CITY PAYS</h2>
        </div>
        <div className="overflow-x-auto">
          <table data-testid="paytable" className="w-full border-collapse">
            <thead><tr>
              {["MANAGER", "MATCHES", "MATCH PAY", "ADJUSTMENT", "TOTAL"].map((h, i) => (
                <th key={h} className={`border-b px-4 py-2 text-[10px] font-bold tracking-[0.07em] ${i > 1 ? "text-right" : "text-left"}`}
                  style={{ color: C.muted, background: C.rail, borderColor: C.hair }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {payRows.map((r) => {
                const isYou = (r.managerEmail ?? "").toLowerCase() === (data?.you.email ?? "").toLowerCase();
                return (
                  <tr key={r.managerEmail ?? r.managerName} data-testid="pay-row">
                    <td className="border-b px-4 py-2.5 text-[13px]" style={{ borderColor: C.hair }}>
                      <span className="font-semibold" style={{ color: C.forestDeep, overflowWrap: "anywhere" }}>{r.managerName}</span>
                      {isYou && <span data-testid="you-chip" className="ml-1.5 rounded-[4px] border px-1 text-[9px] font-bold" style={{ background: C.mint, borderColor: "#bfe4cf", color: C.ok }}>YOU</span>}
                      {r.adjustmentNotes && <span className="cm-only-mobile block text-[11px]" style={{ color: C.muted }}>{r.adjustmentNotes}</span>}
                    </td>
                    <td className="border-b px-4 py-2.5 text-[13px]" style={{ borderColor: C.hair, color: C.muted }}>{r.matchCount}</td>
                    <td className="border-b px-4 py-2.5 text-right text-[13px]" style={{ borderColor: C.hair }}>{money(r.baseTotal)}</td>
                    <td className="border-b px-4 py-2.5 text-right text-[13px]" style={{ borderColor: C.hair }}>
                      {r.adjustment ? money(r.adjustment) : <span style={{ color: C.muted2 }}>—</span>}
                      {r.adjustmentNotes && <span className="cm-hide-mobile block text-[11px]" style={{ color: C.muted }}>{r.adjustmentNotes}</span>}
                    </td>
                    <td className="border-b px-4 py-2.5 text-right text-[13px] font-bold" style={{ borderColor: C.hair, color: C.forestDeep }}>{money(r.total)}</td>
                  </tr>
                );
              })}
              <tr>
                <td className="px-4 py-2.5 text-[13px] font-bold" style={{ color: C.forestDeep }}>{data?.cityIdentifier} total</td>
                <td className="px-4 py-2.5 text-[13px]" style={{ color: C.muted }}>{paidMatches}</td>
                <td className="px-4 py-2.5 text-right text-[13px]">{money(city?.baseTotal ?? 0)}</td>
                <td className="px-4 py-2.5 text-right text-[13px]">{money(city?.adjustment ?? 0)}</td>
                <td className="px-4 py-2.5 text-right text-[14px] font-extrabold" style={{ color: C.forestDeep }}>{money(cityTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {/* one folded line per manager, phone only — its OWN class, never a shared layout class */}
        <div className="cm-only-mobile border-t px-4 py-2 text-[11.5px]" style={{ borderColor: C.hair, color: C.muted }}>
          Match pay and adjustments are folded away on a phone — the total is the column that matters here.
        </div>
        <div data-testid="readonly-note" className="border-t px-4 py-2.5 text-[11.5px]" style={{ borderColor: C.hair, color: C.muted }}>
          <b>Pay figures are read-only.</b> Match pay follows from who worked — change the manager on a match and the
          money moves with it. Adjustments are entered by MatchDay; message them if a figure looks wrong.
        </div>
      </section>

      {openMatch && (
        <MatchSheet
          m={openMatch}
          managers={data?.managers ?? []}
          city={data?.cityIdentifier ?? ""}
          payRows={payRows}
          cityTotal={cityTotal}
          onClose={() => setOpenId(null)}
          onSaved={(msg) => { setOpenId(null); setToast(msg); void load(); setTimeout(() => setToast(null), 4000); }}
        />
      )}
      {toast && <div data-testid="toast" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-[10px] px-3.5 py-2 text-[12.5px] font-bold text-white" style={{ background: C.forestDeep }}>{toast}</div>}

      <style>{`
        .cm-tiles{grid-template-columns:repeat(4,1fr)}
        .cm-week{grid-template-columns:repeat(7,1fr)}
        .cm-only-mobile{display:none}
        @media(max-width:900px){ .cm-tiles{grid-template-columns:repeat(2,1fr)} }
        @media(max-width:760px){
          .cm-week{grid-template-columns:1fr}   /* one day per row */
          .cm-only-mobile{display:block}
          .cm-hide-mobile{display:none}
        }
      `}</style>
    </div>
  );
}

function Tile({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="rounded-[12px] border p-3" style={{ background: C.surface, borderColor: C.line }}>
      <div className="text-[9.5px] font-bold uppercase tracking-[0.11em]" style={{ color: C.muted2 }}>{label}</div>
      <div className="mt-1 text-[22px] font-extrabold leading-none" style={{ color: C.forestDeep }}>{value}</div>
      <div className="mt-1.5 text-[11px]" style={{ color: C.muted, overflowWrap: "anywhere" }}>{foot}</div>
    </div>
  );
}

// ── the match sheet: EXACTLY ONE form control ──
function MatchSheet({ m, managers, city, payRows, cityTotal, onClose, onSaved }: {
  m: MatchRow; managers: { id: number; name: string; email: string | null }[]; city: string;
  payRows: ManagerRow[]; cityTotal: number; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const coManaged = !!m.secondManagerName;
  const locked = m.isCancelled || coManaged;
  const currentId = m.managerId ?? managers.find((x) => x.name === m.primaryManagerName)?.id ?? null;
  const [pick, setPick] = useState<number | null>(currentId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = pick !== currentId;

  const fee = payAmount(m.maxPlayerCount, coManaged);
  const nameOf = (id: number | null) => (id == null ? null : managers.find((x) => x.id === id)?.name ?? `Manager ${id}`);
  const totalOf = (id: number | null) => {
    const n = nameOf(id);
    return n ? (payRows.find((r) => r.managerName === n)?.total ?? 0) : 0;
  };

  // THE MONEY CONSEQUENCE, BEFORE THE CLICK — computed by the tested pure model, read live at
  // render time from the real pay rules (never a flat $20).
  const impact = dirty && !locked
    ? reassignImpact({
        fee, fromName: nameOf(currentId), toName: nameOf(pick),
        fromTotal: totalOf(currentId), toTotal: totalOf(pick), cityTotal,
      }).text || null
    : null;

  const save = async () => {
    if (!dirty || busy || locked) return;
    setBusy(true); setErr(null);
    try {
      const res = await authFetch(`/api/manager-pay/city-week`, { method: "POST", body: JSON.stringify({ matchId: m.matchId, managerId: pick }) });
      const j = await res.json().catch(() => ({}));
      // CONFIRM THEN APPLY — the pay table does not move until the write is accepted, and on
      // failure the sheet stays open with the pick intact.
      if (!res.ok) { setErr(j?.error || `Not saved (${res.status})`); return; }
      if (j?.landed === false) { setErr("NOT APPLIED — MatchDay accepted the request but the re-read shows the manager unchanged. Nothing was moved; check the match before trying again."); return; }
      onSaved(pick ? `${nameOf(pick)} is on ${m.fieldTitle ?? "this match"}.` : "This match now has no manager.");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40" style={{ background: "rgba(7,42,32,.35)" }} />
      <div data-testid="match-sheet" role="dialog" aria-label="Change the manager"
        className="fixed bottom-0 right-0 top-0 z-50 w-full max-w-[420px] overflow-y-auto border-l p-4"
        style={{ background: C.surface, borderColor: C.line }}>
        <div className="mb-1 flex items-start gap-2">
          <h3 className="m-0 flex-1 text-[15px] font-bold" style={{ color: C.forestDeep, overflowWrap: "anywhere" }}>{m.fieldTitle ?? "Match"}</h3>
          <button type="button" onClick={onClose} aria-label="Close" data-testid="sheet-close"
            className="h-8 w-8 flex-none rounded-[8px] border text-[13px]" style={{ borderColor: C.chipLine, color: C.muted }}>✕</button>
        </div>
        <p className="m-0 mb-3 text-[11.5px]" style={{ color: C.muted }}>{m.centralWeekday} · {m.centralTime}</p>

        {/* read-only facts */}
        <dl className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
          {[["Date", m.centralDate], ["Kick-off", m.centralTime], ["Field", m.fieldTitle ?? "—"],
            ["Signed up", `${m.playerCount ?? 0}${m.maxPlayerCount ? ` of ${m.maxPlayerCount}` : ""}`],
            ["Pays", m.isCancelled ? "$0 — cancelled" : money(fee)],
            ["Status", m.isCancelled ? "Cancelled" : coManaged ? "Two managers" : "Scheduled"]].map(([k, v]) => (
            <div key={k as string}><dt className="text-[9.5px] font-bold uppercase tracking-[0.09em]" style={{ color: C.muted2 }}>{k}</dt>
              <dd className="m-0 font-semibold" style={{ color: C.ink }}>{v}</dd></div>
          ))}
        </dl>

        {m.isCancelled && (
          <div data-testid="sheet-locked" className="mb-3 rounded-[9px] border px-2.5 py-2 text-[11.5px] font-semibold" style={{ background: C.critBg, borderColor: C.critLine, color: C.critInk }}>
            This match was cancelled, so it pays nobody. Players were credited and told.
          </div>
        )}
        {!m.isCancelled && coManaged && (
          <div data-testid="sheet-locked" className="mb-3 rounded-[9px] border px-2.5 py-2 text-[11.5px] font-semibold" style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>
            This match has two managers and pays both. It cannot be changed here without saying which one is
            moving — message MatchDay to change either of them.
          </div>
        )}

        {/* THE ONE FORM CONTROL */}
        <label className="mb-1 block text-[9.5px] font-bold uppercase tracking-[0.09em]" style={{ color: C.muted2 }}>Manager</label>
        <select data-testid="sheet-manager" value={pick ?? ""} disabled={locked || busy}
          onChange={(e) => setPick(e.target.value === "" ? null : Number(e.target.value))}
          className="h-10 w-full rounded-[9px] border px-2.5 text-[13px] disabled:opacity-60"
          style={{ borderColor: C.chipLine, background: locked ? C.rail : C.surface }}>
          <option value="">No manager</option>
          {managers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <p data-testid="sheet-scope" className="m-0 mt-1.5 text-[11px]" style={{ color: C.muted }}>Only managers in {city} can be assigned.</p>
        <p data-testid="sheet-only" className="m-0 mt-1 text-[11px]" style={{ color: C.muted }}>
          The manager is the only thing you can change here. For times, fields, prices or anything else, message MatchDay.
        </p>

        {impact && (
          <div data-testid="sheet-impact" className="mt-3 rounded-[9px] border px-2.5 py-2 text-[12px]" style={{ background: C.mint, borderColor: "#bfe4cf", color: C.ok }}>
            {impact}
          </div>
        )}
        {err && <div role="alert" data-testid="sheet-error" className="mt-3 rounded-[9px] border px-2.5 py-2 text-[11.5px] font-semibold" style={{ background: C.critBg, borderColor: C.critLine, color: C.critInk }}>{err}</div>}

        <button type="button" onClick={() => void save()} disabled={!dirty || busy || locked} data-testid="sheet-save"
          className="mt-3 h-10 w-full rounded-[9px] text-[13px] font-bold text-white disabled:opacity-45"
          style={{ background: C.forest }}>
          {busy ? "Saving…" : pick == null ? "Remove the manager" : `Assign ${nameOf(pick) ?? ""}`}
        </button>
      </div>
    </>
  );
}
