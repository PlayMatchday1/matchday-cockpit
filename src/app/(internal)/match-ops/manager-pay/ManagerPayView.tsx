"use client";

// Manager Pay — Match Ops. Moved from /managers (Finance). Same data, same math:
// reads /api/manager-pay/week (compute unchanged) and reuses the Gusto CSV lib
// and the adjustments POST. New layout (mockup docs/mockups/managerpay-v1_2.html):
// ONE board, per city — band header, that city's week strip, the column header,
// the manager rows, unassigned rows, city total. The strip pays for the rows
// below it; proximity is the point. All derivation is in src/lib/managerPayView.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  addDays, weekdayUtc, TOURNAMENT_THRESHOLD,
  type ManagerPayWeekPayload, type CitySection, type MatchSummary, type ManagerRow, type ManagerMatch,
} from "@/lib/managerPayCompute";
import {
  money, payDayLabel, managerNamesOf, isUnassigned, cardRate, computeTiles,
  managerRowFlags, FLAG_NOUN, canShowWeekStrip, bandRendersColumnHeader, managerRowsForMatch,
} from "@/lib/managerPayView";
import { buildGustoRows, gustoCsvFromRows, findGustoNameConflicts, type GustoAliasMap, type GustoConflict } from "@/lib/gustoCsv";

const C = {
  forest: "#0d3b2e", forestDeep: "#072a20", accent: "#35c77f", mint: "#e0f2e7", amount: "#e2502b",
  ink: "#12241d", muted: "#6d7b74", muted2: "#b3c2ba", warnBg: "#fdf1d0", warnInk: "#8a6300", warnLine: "#e3c369",
  critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9", ok: "#12704a",
  railA: "#fafbfa", railB: "#f6f9f7", board: "#f8faf9", chipBg: "#eef3f0", chipLine: "#e2eae5",
  line: "#e6ebe8", hair: "#eff3f1", surface: "#ffffff",
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dshort = (iso: string) => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const dfull = (iso: string) => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
function snapToMonday(iso: string): string { const wd = weekdayUtc(iso); return addDays(iso, wd === 0 ? -6 : -(wd - 1)); }
function defaultWeekStart(): string { const t = new Date().toISOString().slice(0, 10); return addDays(snapToMonday(t), -7); }
const rowKey = (r: ManagerRow) => `${r.cityIdentifier ?? "Unknown"}::${r.managerName}`;

export default function ManagerPayView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const weekStart = useMemo(() => {
    const w = params.get("week");
    return w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? snapToMonday(w) : defaultWeekStart();
  }, [params]);

  const [payload, setPayload] = useState<ManagerPayWeekPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [city, setCity] = useState("");
  const [onlyAttn, setOnlyAttn] = useState(false);
  const [view, setView] = useState<"both" | "pay">("both");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [aliasMap, setAliasMap] = useState<GustoAliasMap>({});
  const [adjEdit, setAdjEdit] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<GustoConflict[] | null>(null);
  const [arrivalEdit, setArrivalEdit] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const setWeek = (w: string) => {
    const p = new URLSearchParams(params.toString());
    p.set("week", w);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      try {
        const res = await fetch(`/api/manager-pay/week?week=${encodeURIComponent(weekStart)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(json?.error ?? `HTTP ${res.status}`); setPayload(null); }
        else { setPayload(json as ManagerPayWeekPayload); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [weekStart, refreshKey]);

  const isAdmin = payload?.isAdmin ?? false;
  useEffect(() => {
    if (!isAdmin) { setAliasMap({}); return; }
    let cancelled = false;
    (async () => {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      try {
        const res = await fetch("/api/manager-pay/aliases", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setAliasMap((json.aliases ?? {}) as GustoAliasMap);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, refreshKey]);

  const saveAdjustment = useCallback(async (r: ManagerRow, amount: number, notes: string | null) => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { alert("Sign in to edit adjustments."); return; }
    const res = await fetch("/api/manager-pay/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ managerEmail: r.managerEmail, managerId: r.managerId, weekStart, amount, notes }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { alert(`Save failed: ${json?.error ?? res.status}`); return; }
    setAdjEdit(null);
    setRefreshKey((k) => k + 1);
  }, [weekStart]);

  // Admin: set / reset the estimated-arrival override for this week.
  const saveArrival = useCallback(async (arrivalDate: string, reason: string): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return "No active session.";
    const res = await fetch("/api/manager-pay/pay-arrival", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ weekStart, arrivalDate, reason }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return (json?.error as string) ?? `HTTP ${res.status}`;
    setArrivalEdit(false);
    setRefreshKey((k) => k + 1);
    return null;
  }, [weekStart]);
  const resetArrival = useCallback(async () => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return;
    const res = await fetch(`/api/manager-pay/pay-arrival?week=${encodeURIComponent(weekStart)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) { setArrivalEdit(false); setRefreshKey((k) => k + 1); }
  }, [weekStart]);

  const downloadGusto = useCallback(() => {
    if (!payload) return;
    const rows = buildGustoRows(payload, city || "ALL", aliasMap);
    // Payroll safety: two managers exporting the same First+Last would pay one
    // twice and the other nothing. Block, and let the admin set an alias.
    const found = findGustoNameConflicts(rows);
    if (found.length) { setConflicts(found); return; }
    const csv = gustoCsvFromRows(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gusto-manager-pay-${weekStart}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [payload, aliasMap, city, weekStart]);

  // Save (PUT) or clear (DELETE, when both names blank) one Gusto alias.
  // Returns an error string on failure, null on success — the inline editor
  // renders it. Two separate name fields, written to the CSV verbatim (never
  // re-split from managerName).
  const saveAlias = useCallback(async (email: string, firstName: string, lastName: string, note: string | null): Promise<string | null> => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return "No active session.";
    const clearing = !firstName.trim() && !lastName.trim();
    const res = await fetch(
      `/api/manager-pay/aliases${clearing ? `?email=${encodeURIComponent(email.toLowerCase())}` : ""}`,
      {
        method: clearing ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: clearing ? undefined : JSON.stringify({ managerEmail: email, firstName, lastName, note }),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return (json?.error as string) ?? `HTTP ${res.status}`;
    setRefreshKey((k) => k + 1);
    return null;
  }, []);

  const focusMatch = useCallback((matchId: number) => {
    if (!payload) return;
    // which manager rows worked this match (co-managed opens both)
    const keys = managerRowsForMatch(payload, matchId).map(rowKey);
    if (keys.length) {
      setOpen((prev) => { const n = new Set(prev); keys.forEach((k) => n.add(k)); return n; });
    }
    // let the rows render, then flash + scroll
    setTimeout(() => {
      const root = listRef.current;
      if (!root) return;
      const sel = keys.length
        ? keys.map((k) => `[data-mkey="${cssEscape(k)}"]`)
        : [`[data-uid="${matchId}"]`];
      const els = sel.map((s) => root.querySelector<HTMLElement>(s)).filter(Boolean) as HTMLElement[];
      els.forEach((e) => { e.classList.remove("mp-flash"); void e.offsetWidth; e.classList.add("mp-flash"); });
      els[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
  }, [payload]);

  if (loading && !payload) return <div className="p-8 text-sm" style={{ color: C.muted }}>Loading manager pay…</div>;
  if (error) return <div className="m-4 rounded-xl border p-4 text-sm" style={{ borderColor: C.critLine, background: C.critBg, color: C.critInk }}>{error}</div>;
  if (!payload) return null;

  const tiles = computeTiles(payload, city || null, isAdmin);
  const filtering = !!city || onlyAttn;
  const scopeCities = city ? payload.cities.filter((c) => c.cityIdentifier === city) : payload.cities;
  const cityChips = payload.cities.map((c) => ({ k: c.cityIdentifier, n: c.managers.length }));
  const fullScopedTotal = scopeCities.reduce((s, c) => s + c.total, 0);
  const canStrip = canShowWeekStrip(view, onlyAttn);

  // bands that will render (have manager rows OR unassigned matches in scope)
  const bands = scopeCities
    .map((c) => {
      const rows = onlyAttn ? c.managers.filter((r) => managerRowFlags(r, isAdmin).length > 0) : c.managers;
      const un = c.matches.filter(isUnassigned);
      return { c, rows, un };
    })
    .filter((b) => b.rows.length || (!onlyAttn && b.un.length));
  const nBands = bands.length;

  const clearFilters = () => { setCity(""); setOnlyAttn(false); };

  return (
    <div className="min-w-0 px-1 pb-16" style={{ color: C.ink }}>
      <style>{`
        .mp-grid{display:grid;align-items:center;grid-template-columns:minmax(260px,1fr) 170px 120px 260px 120px 40px;gap:0 14px;padding:0 16px}
        @media(max-width:1400px){.mp-grid{grid-template-columns:minmax(200px,1fr) 140px 104px 210px 106px 36px;gap:0 10px;padding:0 12px}}
        @keyframes mpflash{0%{background:#dcf3e5}70%{background:#eefaf2}100%{background:transparent}}
        .mp-flash{animation:mpflash 1.5s ease-out 1}
      `}</style>

      {/* head */}
      <div className="mb-3.5 flex flex-wrap items-start gap-3.5">
        <div>
          <h1 className="m-0 text-[23px] font-[800] tracking-[-0.3px]" style={{ color: C.forestDeep }}>Manager Pay</h1>
          <div className="mt-1 text-[12.5px]" style={{ color: C.muted }}>
            What each manager is owed for the week of {dshort(payload.weekStart)} – {dfull(payload.weekEnd)}, and the file that pays them.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setRefreshKey((k) => k + 1)} className="inline-flex items-center gap-1.5 rounded-[9px] border px-3 py-2 text-[12.5px] font-bold" style={{ background: C.surface, borderColor: C.chipLine, color: C.forest }}>Refresh</button>
          {isAdmin && (
            <button type="button" onClick={() => setShareOpen(true)} className="inline-flex items-center gap-1.5 rounded-[9px] border px-3 py-2 text-[12.5px] font-bold" style={{ background: C.surface, borderColor: C.chipLine, color: C.forest }}>Share link</button>
          )}
          {isAdmin && (
            <button type="button" onClick={downloadGusto} className="inline-flex items-center gap-1.5 rounded-[9px] border px-3 py-2 text-[12.5px] font-bold" style={{ background: C.accent, borderColor: C.accent, color: "#06281d" }}>Gusto CSV</button>
          )}
        </div>
      </div>

      {/* week bar */}
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[12px] border p-[11px_14px]" style={{ background: C.surface, borderColor: C.line, padding: "11px 14px" }}>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous week" onClick={() => setWeek(addDays(weekStart, -7))} className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border" style={{ background: C.railA, borderColor: C.chipLine, color: C.forest }}>‹</button>
          <span className="whitespace-nowrap text-[14.5px] font-[800]" style={{ color: C.forestDeep }}>{dshort(payload.weekStart)} – {dfull(payload.weekEnd)}</span>
          <button type="button" aria-label="Next week" onClick={() => setWeek(addDays(weekStart, 7))} className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border" style={{ background: C.railA, borderColor: C.chipLine, color: C.forest }}>›</button>
        </div>
        <span className="rounded-full border px-[9px] py-[3px] text-[10.5px] font-[800] tracking-[0.05em]" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>
          {weekStart === defaultWeekStart() ? "LAST COMPLETED" : weekStart > defaultWeekStart() ? "IN PROGRESS" : "PAST WEEK"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" style={{ color: C.muted }}>
          <span>Pay run <b style={{ color: C.ink }}>{dfull(payload.payRun ?? payload.payDate)}</b></span>
          <span className="inline-flex items-center gap-1.5">
            Est. arrival <b style={{ color: C.ink }}>{payload.effectiveArrival ? dfull(payload.effectiveArrival) : (payload.arrivalError ? "unavailable" : "—")}</b>
            {payload.arrivalOverride && (
              <span title={`Adjusted by ${payload.arrivalOverride.by ?? "an admin"} on ${payload.arrivalOverride.at} — ${payload.arrivalOverride.reason}`} className="rounded-full border px-[7px] py-[2px] text-[9.5px] font-[800]" style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>ADJUSTED</span>
            )}
            {isAdmin && <button type="button" onClick={() => setArrivalEdit((v) => !v)} className="text-[10.5px] font-bold underline" style={{ color: C.ok }}>{arrivalEdit ? "Close" : "Change"}</button>}
          </span>
        </div>
        {arrivalEdit && isAdmin && (
          <div className="w-full">
            <ArrivalEditor computed={payload.estimatedArrival} override={payload.arrivalOverride} onSave={saveArrival} onReset={resetArrival} />
          </div>
        )}
        <div className="inline-flex overflow-hidden rounded-[9px] border" style={{ borderColor: C.chipLine, background: C.railA }}>
          <button type="button" onClick={() => setView("both")} className="px-[13px] py-[7px] text-[12.5px] font-bold" style={view === "both" ? { background: C.accent, color: "#06281d" } : { background: "transparent", color: C.muted }}>Week + pay</button>
          <button type="button" onClick={() => setView("pay")} className="px-[13px] py-[7px] text-[12.5px] font-bold" style={view === "pay" ? { background: C.accent, color: "#06281d" } : { background: "transparent", color: C.muted }}>Pay only</button>
        </div>
      </div>

      {/* city chips (scope) */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Chip on={city === ""} onClick={() => setCity("")}>All cities <i className="not-italic opacity-70">{payload.cities.reduce((s, c) => s + c.managers.length, 0)}</i></Chip>
        {cityChips.map((c) => (
          <Chip key={c.k} on={city === c.k} onClick={() => setCity(c.k)}>{c.k} <i className="not-italic opacity-70">{c.n}</i></Chip>
        ))}
      </div>

      {/* tiles */}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[12px] border p-[13px_15px]" style={{ background: "linear-gradient(180deg,#effaf3,#ffffff)", borderColor: "#bfe2cf", padding: "13px 15px" }}>
          <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>TOTAL PAYOUT</div>
          <div data-mp="total" className="mt-1 text-[27px] font-[800] leading-none tracking-[-0.6px]" style={{ color: C.amount }}>{money(tiles.totalPayout)}</div>
          <div className="mt-1.5 text-[11px]" style={{ color: C.muted }}><b style={{ color: C.ink }}>{money(tiles.matchPay)}</b> in match pay + <b style={{ color: C.ink }}>{money(tiles.adjTotal)}</b> across {tiles.adjCount} adjustment{tiles.adjCount === 1 ? "" : "s"}, typed by hand{city ? ` · ${city} only` : ""}</div>
        </div>
        <Tile label="MANAGERS PAID" value={String(tiles.managersPaid)} note={`in ${tiles.citiesPaid} cit${tiles.citiesPaid === 1 ? "y" : "ies"} · pays ${payDayLabel(payload.payDate)}`} />
        <Tile label="MATCHES PAID" value={String(tiles.matchesPaid)} note={`of ${tiles.matchesOnCalendar} on the calendar · ${tiles.cancelled} cancelled and ${tiles.unassigned} with nobody assigned, neither of which pays`} />
        <div className="rounded-[12px] border p-[13px_15px]" style={{ background: C.surface, borderColor: C.line, padding: "13px 15px" }}>
          <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>NEEDS A LOOK</div>
          <div data-mp="needslook" className="mt-1 text-[27px] font-[800] leading-none tracking-[-0.6px]" style={{ color: tiles.needsLook ? C.warnInk : C.forestDeep }}>{tiles.needsLook}</div>
          <div className="mt-1.5 text-[11px]" style={{ color: C.muted }}>
            {tiles.needsLook ? tiles.breakdown.map((b) => `${b.n} ${FLAG_NOUN[b.kind](b.n)}`).join(", ") : "every match has a manager and every adjustment has a reason"}
          </div>
          {tiles.needsLook > 0 && (
            <button type="button" onClick={() => setOnlyAttn((v) => !v)} className="mt-2 self-start rounded-[8px] border px-[9px] py-[5px] text-[11px] font-[800]" style={{ background: C.railA, borderColor: C.chipLine, color: C.ok }}>
              {onlyAttn ? "Showing only these — show all" : "Show only these"}
            </button>
          )}
        </div>
      </div>

      {/* board */}
      <section className="rounded-[13px] border" style={{ background: C.surface, borderColor: C.line }}>
        <div className="flex items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: C.line }}>
          <h2 className="m-0 text-[14px] font-bold" style={{ color: C.forestDeep }}>{canStrip ? "The week, and what it pays" : "Payout run"}</h2>
          <span className="text-[11.5px] font-bold" style={{ color: C.muted }}>
            {bands.reduce((s, b) => s + b.rows.length, 0)} manager{bands.reduce((s, b) => s + b.rows.length, 0) === 1 ? "" : "s"}
            {tiles.unassigned ? ` · ${tiles.unassigned} unassigned match${tiles.unassigned === 1 ? "" : "es"}` : ""}
            {canStrip ? ` · ${scopeCities.reduce((s, c) => s + c.matches.length, 0)} matches on the week — click a match to open its pay row`
              : onlyAttn ? " · weeks hidden while you are filtered to these" : ""}
          </span>
          {filtering && <button type="button" onClick={clearFilters} className="ml-auto rounded-[7px] border px-2.5 py-1.5 text-[11.5px] font-bold" style={{ background: C.surface, borderColor: C.chipLine, color: C.forest }}>Clear filters</button>}
        </div>

        <div ref={listRef}>
          {bands.length === 0 ? (
            <div className="px-4 py-9 text-center text-[12.5px]" style={{ color: C.muted }}>Nothing matches these filters.</div>
          ) : bands.map(({ c, rows, un }) => {
            const shutCity = shut.has(c.cityIdentifier);
            const cd = new Set(rows.flatMap((r) => r.matches.map((m) => m.matchId))).size; // distinct paid matches
            const cm = rows.reduce((s, r) => s + r.matchCount, 0); // shifts worked
            const coManaged = cm - cd;
            const cb = rows.reduce((s, r) => s + r.baseTotal, 0);
            const ca = rows.reduce((s, r) => s + r.adjustment, 0);
            return (
              <div key={c.cityIdentifier}>
                {/* band header */}
                <div className="flex items-baseline gap-2.5 border-t border-b px-4 py-2" style={{ background: C.railB, borderTopColor: C.line, borderBottomColor: C.hair }}>
                  <span className="rounded-[5px] px-[7px] py-[2px] text-[11px] font-[800] tracking-[0.05em]" style={{ background: C.forest, color: "#fff" }}>{c.cityIdentifier}</span>
                  <span className="text-[13px] font-[800]" style={{ color: C.forestDeep }}>{c.cityIdentifier}</span>
                  <span className="text-[11.5px] font-semibold" style={{ color: C.muted }}>
                    {cd} paid match{cd === 1 ? "" : "es"} · {rows.length} manager{rows.length === 1 ? "" : "s"}{coManaged > 0 ? ` · ${coManaged} co-managed` : ""}{un.length ? ` · ${un.length} unassigned` : ""}
                  </span>
                  <span className="ml-auto text-[12.5px] font-[800]" style={{ color: C.ink }}>{money(cb + ca)}</span>
                  {canStrip && (
                    <button type="button" onClick={() => setShut((prev) => { const n = new Set(prev); if (n.has(c.cityIdentifier)) n.delete(c.cityIdentifier); else n.add(c.cityIdentifier); return n; })}
                      className="ml-2.5 inline-flex items-center gap-1 rounded-[7px] border px-[9px] py-1 text-[11px] font-[800]" style={{ background: C.surface, borderColor: C.chipLine, color: C.muted }}>
                      {shutCity ? "Show week" : "Hide week"}
                    </button>
                  )}
                </div>

                {/* week strip */}
                {canStrip && !shutCity && <WeekStrip city={c} weekStart={payload.weekStart} onCard={focusMatch} />}

                {/* column header — only for bands that have manager rows */}
                {bandRendersColumnHeader(rows) && (
                  <div className="mp-grid border-b text-[10.5px] font-bold tracking-[0.07em]" style={{ background: C.board, borderColor: C.line, color: C.muted, paddingTop: 8, paddingBottom: 8 }}>
                    <div>MANAGER</div><div>MATCHES WORKED</div><div className="text-right">MATCH PAY</div><div>ADJUSTMENT</div><div className="text-right">TOTAL</div><div />
                  </div>
                )}

                {rows.map((r) => (
                  <MgrRow key={rowKey(r)} r={r} isAdmin={isAdmin} open={open.has(rowKey(r))}
                    editing={adjEdit === rowKey(r)}
                    alias={r.managerEmail ? aliasMap[r.managerEmail.toLowerCase()] : undefined}
                    onToggle={() => setOpen((prev) => { const n = new Set(prev); const k = rowKey(r); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                    onEditAdj={() => setAdjEdit(rowKey(r))} onCancelAdj={() => setAdjEdit(null)}
                    onSaveAdj={(amt, notes) => saveAdjustment(r, amt, notes)}
                    onSaveAlias={saveAlias} />
                ))}
                {un.map((m) => <UnRow key={m.matchId} m={m} />)}

                {/* per-city total — suppressed when only one band renders */}
                {nBands > 1 && rows.length > 0 && (
                  <div className="mp-grid border-b text-[12px] font-[800]" style={{ background: C.railB, borderColor: C.line, color: C.muted, paddingTop: 9, paddingBottom: 9 }}>
                    <div>{c.cityIdentifier} total</div>
                    <div>{cm}{cm !== cd ? <div className="text-[10.5px] font-bold" style={{ color: C.muted }}>across {cd} matches</div> : null}</div>
                    <div className="text-right">{money(cb)}</div><div>{money(ca)}</div><div className="text-right">{money(cb + ca)}</div><div />
                  </div>
                )}
              </div>
            );
          })}

          {/* grand total */}
          {bands.length > 0 && (() => {
            const gb = bands.reduce((s, b) => s + b.rows.reduce((t, r) => t + r.baseTotal, 0), 0);
            const ga = bands.reduce((s, b) => s + b.rows.reduce((t, r) => t + r.adjustment, 0), 0);
            const gm = bands.reduce((s, b) => s + b.rows.reduce((t, r) => t + r.matchCount, 0), 0);
            const gd = new Set(bands.flatMap((b) => b.rows.flatMap((r) => r.matches.map((m) => m.matchId)))).size;
            const cn = city || null;
            return (
              <div data-mp="grand" className="mp-grid text-[13px] font-[800]" style={onlyAttn
                ? { background: C.railB, borderTop: `1px solid ${C.line}`, color: C.muted, paddingTop: 14, paddingBottom: 14 }
                : { background: "linear-gradient(180deg,#effaf3,#ffffff)", borderTop: "1px solid #bfe2cf", color: C.forestDeep, paddingTop: 14, paddingBottom: 14 }}>
                <div>{onlyAttn ? <>Rows that need a look<div className="text-[10.5px] font-bold" style={{ color: C.muted }}>of {money(fullScopedTotal)} owed{cn ? ` in ${cn}` : " this week"}</div></> : (cn ? `${cn} total` : "Total payout")}</div>
                <div>{gm}{gm !== gd ? <div className="text-[10.5px] font-bold" style={{ color: C.muted }}>across {gd} matches</div> : null}</div>
                <div className="text-right">{money(gb)}</div><div>{money(ga)} in adjustments</div>
                <div className="text-right"><span style={{ fontSize: 17, color: onlyAttn ? C.ink : C.amount }}>{money(gb + ga)}</span></div><div />
              </div>
            );
          })()}
        </div>

        <div className="border-t px-4 py-3 text-[11.5px] leading-[1.65]" style={{ background: C.railB, borderColor: C.line, color: C.muted }}>
          {footerText(payload)}
        </div>
      </section>

      {conflicts && <ConflictModal conflicts={conflicts} onClose={() => setConflicts(null)} onSaveAlias={saveAlias} />}
      {shareOpen && <ShareLinkModal onClose={() => setShareOpen(false)} />}
    </div>
  );
}

// Inline editor for the estimated-arrival override (admin). A real date input +
// required reason; Save writes the override, Reset returns to the computed value.
function ArrivalEditor({ computed, override, onSave, onReset }: {
  computed: string | null | undefined; override: { date: string; reason: string } | null | undefined;
  onSave: (date: string, reason: string) => Promise<string | null>; onReset: () => void;
}) {
  const [date, setDate] = useState(override?.date ?? computed ?? "");
  const [reason, setReason] = useState(override?.reason ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!date || !reason.trim()) { setMsg("A date and a reason are required."); return; }
    setSaving(true); setMsg(null);
    const err = await onSave(date, reason.trim());
    setSaving(false);
    if (err) setMsg(err);
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[10px] border p-2.5" style={{ background: C.railA, borderColor: C.chipLine }}>
      <span className="text-[10.5px] font-bold uppercase tracking-[0.08em]" style={{ color: C.muted }}>Override arrival</span>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 rounded-[7px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }} />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="h-8 w-[240px] rounded-[7px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }} />
      <button type="button" disabled={saving} onClick={save} className="rounded-[7px] px-3 py-1.5 text-[11.5px] font-bold disabled:opacity-40" style={{ background: C.accent, color: "#06281d" }}>Save</button>
      {override && <button type="button" onClick={onReset} className="rounded-[7px] border px-3 py-1.5 text-[11.5px] font-bold" style={{ borderColor: C.chipLine, color: C.muted }}>Reset to computed</button>}
      {computed && <span className="text-[11px]" style={{ color: C.muted }}>computed: {dfull(computed)}</span>}
      {msg && <span className="text-[11px]" style={{ color: C.critInk }}>{msg}</span>}
    </div>
  );
}

// Shareable read-only link management (admin). The token is stored hashed, so the
// plaintext link is shown only right after a rotation; otherwise the modal shows
// when it was last rotated and offers a fresh rotation (which invalidates the old
// link). The link points at the public /pay/<token> surface.
function ShareLinkModal({ onClose }: { onClose: () => void }) {
  const [rotatedAt, setRotatedAt] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [link, setLink] = useState<string | null>(null); // shown once, post-rotate
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/manager-pay/share-token", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (res.ok) { const j = await res.json(); setHasToken(!!j.hasToken); setRotatedAt(j.rotatedAt ?? null); }
    })();
  }, []);

  const rotate = async () => {
    setBusy(true); setErr(null);
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setErr("No active session."); setBusy(false); return; }
    const res = await fetch("/api/manager-pay/share-token", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr((j?.error as string) ?? `HTTP ${res.status}`); return; }
    setLink(`${window.location.origin}/pay/${j.token}`);
    setHasToken(true); setRotatedAt(j.rotatedAt ?? null); setCopied(false);
  };
  const copy = async () => { if (link) { await navigator.clipboard.writeText(link); setCopied(true); } };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0" style={{ background: "rgba(6,26,18,.42)" }} />
      <div className="relative w-full max-w-[540px] rounded-[16px] border p-5" style={{ background: C.surface, borderColor: C.line }}>
        <h2 className="m-0 text-[16px] font-[800]" style={{ color: C.forestDeep }}>Shareable read-only link</h2>
        <p className="mt-1.5 text-[12.5px]" style={{ color: C.muted }}>
          One link, no login. Anyone with it sees this page read-only — no exports, no edits. Rotating makes a new link and
          instantly kills the old one; do that when a manager leaves.
        </p>
        <div className="mt-3 rounded-[11px] border p-3" style={{ borderColor: C.line, background: C.railB }}>
          <div className="text-[10.5px] font-bold uppercase tracking-[0.08em]" style={{ color: C.muted }}>Current link</div>
          {link ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <input readOnly value={link} className="h-9 min-w-0 flex-1 rounded-[8px] border px-2 text-[12px]" style={{ borderColor: C.chipLine, color: C.ink }} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" onClick={copy} className="rounded-[8px] px-3 py-2 text-[12px] font-bold" style={{ background: C.accent, color: "#06281d" }}>{copied ? "Copied" : "Copy"}</button>
            </div>
          ) : (
            <div className="mt-1 text-[12.5px]" style={{ color: C.ink }}>
              {hasToken ? "A link exists. It’s stored hashed, so it can’t be shown again — rotate to generate a fresh link to copy." : "No link yet — generate one below."}
            </div>
          )}
          <div className="mt-2 text-[11px]" style={{ color: C.muted }}>{rotatedAt ? `Last rotated ${dfull(rotatedAt.slice(0, 10))}` : "Never rotated"}</div>
        </div>
        {err && <div className="mt-2 text-[11.5px]" style={{ color: C.critInk }}>{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-[8px] border px-3 py-1.5 text-[12.5px] font-bold" style={{ borderColor: C.chipLine, color: C.muted }}>Close</button>
          <button type="button" disabled={busy} onClick={rotate} className="rounded-[8px] px-4 py-1.5 text-[12.5px] font-bold disabled:opacity-40" style={{ background: C.forest, color: "#fff" }}>{busy ? "Rotating…" : hasToken ? "Rotate link" : "Generate link"}</button>
        </div>
      </div>
    </div>
  );
}

function ConflictModal({ conflicts, onClose, onSaveAlias }: { conflicts: GustoConflict[]; onClose: () => void; onSaveAlias: SaveAlias }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0" style={{ background: "rgba(6,26,18,.42)" }} />
      <div className="relative max-h-[86vh] w-full max-w-[560px] overflow-y-auto rounded-[16px] border p-5" style={{ background: C.surface, borderColor: C.line }}>
        <h2 className="m-0 text-[16px] font-[800]" style={{ color: C.critInk }}>Two managers share a payroll name</h2>
        <p className="mt-1.5 text-[12.5px]" style={{ color: C.muted }}>Gusto matches by First + Last. These would pay one person twice and another nothing. Give each a distinct Gusto name, then export again.</p>
        <div className="mt-3 flex flex-col gap-4">
          {conflicts.map((c) => (
            <div key={c.name} className="rounded-[11px] border p-3" style={{ borderColor: C.critLine, background: C.critBg }}>
              <div className="text-[12.5px] font-[800]" style={{ color: C.critInk }}>Both map to “{c.name}”</div>
              <div className="mt-2 flex flex-col gap-2">
                {c.rows.map((r) => <ConflictAliasRow key={r.email || r.origName} email={r.email} first={r.firstName} last={r.lastName} onSaveAlias={onSaveAlias} onSaved={onClose} />)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end"><button type="button" onClick={onClose} className="rounded-[8px] border px-3 py-1.5 text-[12.5px] font-bold" style={{ borderColor: C.chipLine, color: C.muted }}>Close</button></div>
      </div>
    </div>
  );
}
function ConflictAliasRow({ email, first, last, onSaveAlias, onSaved }: { email: string; first: string; last: string; onSaveAlias: SaveAlias; onSaved: () => void }) {
  const [f, setF] = useState(first);
  const [l, setL] = useState(last);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!email || !f.trim() || !l.trim()) return;
    setSaving(true);
    const e = await onSaveAlias(email, f.trim(), l.trim(), null);
    setSaving(false);
    if (e) setErr(e); else onSaved(); // re-export re-checks conflicts
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px]" style={{ color: C.ink }}>{email || "(no email)"}</span>
      <input value={f} onChange={(e) => setF(e.target.value)} placeholder="First" className="h-8 w-[110px] rounded-[7px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }} />
      <input value={l} onChange={(e) => setL(e.target.value)} placeholder="Last" className="h-8 w-[110px] rounded-[7px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }} />
      <button type="button" disabled={saving || !email || !f.trim() || !l.trim()} onClick={save} className="rounded-[7px] px-2.5 py-1 text-[11px] font-bold disabled:opacity-40" style={{ background: C.accent, color: "#06281d" }}>Save</button>
      {err && <span className="w-full text-[11px]" style={{ color: C.critInk }}>{err}</span>}
    </div>
  );
}

function cssEscape(s: string): string { return s.replace(/["\\]/g, "\\$&"); }

function footerText(p: ManagerPayWeekPayload): string {
  const SOLO = 20, TOUR = 30, T = TOURNAMENT_THRESHOLD;
  const total = p.cities.reduce((s, c) => s + c.matches.length, 0);
  const cancelled = p.cities.reduce((s, c) => s + c.matches.filter((m) => m.isCancelled).length, 0);
  const paid = p.cities.reduce((s, c) => s + c.matches.filter((m) => !m.isCancelled && managerNamesOf(m).length > 0).length, 0);
  const unassigned = p.cities.reduce((s, c) => s + c.matches.filter(isUnassigned).length, 0);
  return (
    `A manager is paid ${money(SOLO)} for a match they run on their own, ${money(TOUR)} if that match is a tournament ` +
    `(capacity ${T}+ players) run solo, and ${money(SOLO)} each when two run it together — so a co-managed tournament ` +
    `costs ${money(SOLO * 2)} and a solo one costs ${money(TOUR)}; the tournament premium does not apply when co-managed. ` +
    `Open a manager's row to see the rate each match paid and why. A co-managed match is worked twice and paid twice, so ` +
    `the Matches worked column adds up to more than the number of matches — every total row names both figures. Cancelled ` +
    `matches pay nothing, and neither does a match nobody was assigned to: of the ${total} matches on this week's calendar, ` +
    `${cancelled} were cancelled and ${unassigned} have no manager, which is why ${paid} were paid. Player counts are sign-ups ` +
    `as of the match, not a record of who actually played — MatchDay does not capture that. Adjustments are the only figures here ` +
    `that are typed rather than derived; each shows its reason and the date it was entered, and one with no reason is flagged ` +
    `amber. A row needs a look when a match in that city has nobody assigned (a red row under that city's managers), a manager ` +
    `has no payroll email on file (a red chip by their name, which would bounce their Gusto row), or an adjustment was entered ` +
    `with no reason. The Needs a look tile counts each once, under its most urgent kind, so the numbers add up to the things ` +
    `and not to the reasons. Each city shows its week directly above its own managers: click a match to open the rows of the ` +
    `managers who worked it, Hide week to fold one city's strip, or Pay only to fold them all and scan straight down the run. ` +
    `The week runs Monday to Sunday and pays 2 days after it ends: ${dfull(p.weekStart)} – ${dfull(p.weekEnd)} pays ${dfull(p.payDate)}.`
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-full border px-[13px] py-[6px] text-[12px] font-bold"
      style={on ? { background: C.forest, borderColor: C.forest, color: "#fff" } : { background: C.surface, borderColor: C.chipLine, color: C.muted }}>
      {children}
    </button>
  );
}
function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-[12px] border" style={{ background: C.surface, borderColor: C.line, padding: "13px 15px" }}>
      <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>{label}</div>
      <div className="mt-1 text-[27px] font-[800] leading-none tracking-[-0.6px]" style={{ color: C.forestDeep }}>{value}</div>
      <div className="mt-1.5 text-[11px]" style={{ color: C.muted }}>{note}</div>
    </div>
  );
}

function WeekStrip({ city, weekStart, onCard }: { city: CitySection; weekStart: string; onCard: (id: number) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return (
    <div style={{ background: C.railA, borderBottom: `1px solid ${C.line}` }}>
      <div className="grid grid-cols-7 gap-2 px-4 py-3">
        {days.map((iso, i) => {
          const dayMatches = city.matches.filter((m) => m.centralDate === iso);
          return (
            <div key={iso} className="min-w-0">
              <div className="pb-1.5 text-[10px] font-bold tracking-[0.07em]" style={{ color: C.muted }}>{DOW[i].toUpperCase()}<b className="mt-0.5 block text-[12px]" style={{ color: C.forestDeep }}>{dshort(iso)}</b></div>
              {dayMatches.length === 0 ? <div className="px-0.5 py-1.5 text-[11px]" style={{ color: C.muted2 }}>—</div>
                : dayMatches.map((m) => <MatchCard key={m.matchId} m={m} onClick={() => onCard(m.matchId)} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchCard({ m, onClick }: { m: MatchSummary; onClick: () => void }) {
  const r = cardRate(m);
  const names = managerNamesOf(m);
  const base: React.CSSProperties = { borderColor: C.line, background: C.surface };
  const style: React.CSSProperties = r.kind === "cancelled" ? { ...base, background: "#fdf7f5", borderColor: C.critLine }
    : r.kind === "unassigned" ? { ...base, background: "#fefaf8", borderColor: C.critLine }
    : r.tournament ? { ...base, background: "#fffdf6", borderColor: C.warnLine } : base;
  const strike = r.kind === "cancelled";
  return (
    <div data-mid={m.matchId} onClick={r.clickable ? onClick : undefined} title={r.clickable ? "Show the pay row for this match" : undefined}
      className={`mb-1.5 rounded-[9px] border p-[7px_8px] ${r.clickable ? "cursor-pointer hover:shadow-sm" : ""}`} style={{ ...style, padding: "7px 8px" }}>
      <div className="text-[11px] font-[800]" style={{ color: strike ? C.critInk : C.forestDeep, textDecoration: strike ? "line-through" : undefined }}>{r.tournament ? "🏆 " : ""}{m.centralTime}</div>
      <div className="mt-0.5 text-[10.5px] leading-[1.3]" style={{ color: strike ? C.critInk : C.ink, textDecoration: strike ? "line-through" : undefined }}>{m.fieldTitle ?? "—"}</div>
      <div className="mt-[3px] text-[10.5px] font-bold" style={{ color: names.length ? C.muted : C.critInk }}>{names.length ? names.join(" + ") : "No manager assigned"}</div>
      <div className="mt-[3px] flex flex-wrap items-center gap-[5px] text-[10px]" style={{ color: strike ? C.critInk : C.muted }}>
        <span>{m.playerCount ?? 0}/{m.maxPlayerCount ?? "?"} signed up</span>
        {r.kind === "cancelled" ? <span>cancelled</span>
          : r.kind === "unassigned" ? <span>{money(0)}</span>
          : <><span className="font-[800]" style={{ color: C.ok }}>{money(r.amount)}{r.each ? " each" : ""}</span>{r.reason && <span className="font-bold" style={{ color: C.warnInk }}>{r.reason}</span>}</>}
      </div>
    </div>
  );
}

function MgrRow({ r, isAdmin, open, editing, alias, onToggle, onEditAdj, onCancelAdj, onSaveAdj, onSaveAlias }: {
  r: ManagerRow; isAdmin: boolean; open: boolean; editing: boolean; alias: Alias | undefined;
  onToggle: () => void; onEditAdj: () => void; onCancelAdj: () => void; onSaveAdj: (amt: number, notes: string | null) => void; onSaveAlias: SaveAlias;
}) {
  const flags = managerRowFlags(r, isAdmin);
  const tny = r.matches.filter((m) => m.payAmount === 30).length;
  const hasAdj = r.adjustment !== 0;
  return (
    <>
      <div data-mkey={rowKey(r)} className="mp-grid cursor-pointer border-b" style={{ borderColor: C.hair, background: open ? "#fbfdfc" : undefined }} onClick={onToggle}>
        <div style={{ padding: "11px 0", minWidth: 0 }}>
          <div className="flex flex-wrap items-center gap-[7px] text-[13.5px] font-bold" style={{ color: C.forestDeep }}>
            <span>{r.managerName}</span>
            {/* Never silently substitute: show the Gusto name beside the real one. */}
            {alias && <span title={`Exports to Gusto as "${alias.firstName} ${alias.lastName}"`} className="rounded-[5px] px-[6px] py-[2px] text-[9.5px] font-[800]" style={{ background: C.mint, color: C.ok }}>Gusto: {alias.firstName} {alias.lastName}</span>}
            {flags.includes("noEmail") && <span className="rounded-full border px-[7px] py-[2px] text-[9.5px] font-[800]" style={{ background: C.critBg, borderColor: C.critLine, color: C.critInk }}>NO PAYROLL EMAIL</span>}
            {flags.includes("bareReason") && <span className="rounded-full border px-[7px] py-[2px] text-[9.5px] font-[800]" style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>NO REASON</span>}
          </div>
          <div className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[11px]" style={{ color: C.muted }}>{isAdmin ? (r.managerEmail ?? "—") : "\u00a0"}</div>
        </div>
        <div style={{ padding: "11px 0" }}>
          <div className="text-[13px] font-[800]">{r.matchCount}</div>
          <div className="mt-0.5 text-[10.5px] font-bold" style={{ color: C.muted }}>{tny ? `${r.matchCount - tny} at ${money(20)} · ${tny} at ${money(30)}` : `all at ${money(20)}`}</div>
        </div>
        <div className="text-right" style={{ padding: "11px 0" }}><span className="text-[13.5px] font-[800] tabular-nums" style={{ color: r.baseTotal ? C.ink : C.muted2 }}>{money(r.baseTotal)}</span></div>
        <div style={{ padding: "11px 0", minWidth: 0 }} onClick={(e) => e.stopPropagation()}>
          {editing ? <AdjEditor r={r} onCancel={onCancelAdj} onSave={onSaveAdj} />
            : hasAdj ? (
              <div className="flex flex-col gap-0.5">
                <div className="text-[13px] font-[800] tabular-nums" style={{ color: C.ink }}>{money(r.adjustment)}</div>
                <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px]" style={{ color: r.adjustmentNotes ? C.muted : C.warnInk }} title={r.adjustmentNotes ?? "No reason written down"}>
                  {r.adjustmentNotes ?? "No reason written down"}{r.adjustmentAt ? ` · ${dshort(r.adjustmentAt.slice(0, 10))}` : ""}
                </div>
                {isAdmin && r.managerEmail && <button type="button" onClick={onEditAdj} className="mt-0.5 self-start text-[10.5px] font-bold underline" style={{ color: C.ok }}>Edit</button>}
              </div>
            ) : isAdmin && r.managerEmail ? (
              <button type="button" onClick={onEditAdj} className="self-start rounded-[7px] border border-dashed px-[9px] py-[5px] text-[11.5px] font-bold" style={{ background: C.railA, borderColor: C.chipLine, color: C.muted }}>+ Add adjustment</button>
            ) : <span className="text-[11.5px]" style={{ color: C.muted2 }}>—</span>}
        </div>
        <div className="text-right" style={{ padding: "11px 0" }}><span className="text-[13.5px] font-[800] tabular-nums" style={{ color: C.ink }}>{money(r.total)}</span></div>
        <div style={{ padding: "11px 0" }}><span className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-[13px]" style={{ color: C.muted }}>{open ? "▾" : "▸"}</span></div>
      </div>
      {open && <MgrDetail r={r} isAdmin={isAdmin} alias={alias} onSaveAlias={onSaveAlias} />}
    </>
  );
}

// A Gusto payroll alias for one manager — First/Last written to the CSV
// verbatim, plus an optional note. saveAlias clears it (DELETE) when both names
// are blank, and returns an error string (or null on success).
type Alias = { firstName: string; lastName: string; note?: string | null };
type SaveAlias = (email: string, firstName: string, lastName: string, note: string | null) => Promise<string | null>;

// Inline Gusto-alias editor, in the expanded manager row. Two separate name
// fields (never one, never re-split from managerName); clearing both removes
// the alias so the CSV falls back to the schedule name.
function AliasEditor({ managerEmail, managerName, alias, onSaveAlias }: { managerEmail: string; managerName: string; alias: Alias | undefined; onSaveAlias: SaveAlias }) {
  const [first, setFirst] = useState(alias?.firstName ?? "");
  const [last, setLast] = useState(alias?.lastName ?? "");
  const [note, setNote] = useState(alias?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setFirst(alias?.firstName ?? ""); setLast(alias?.lastName ?? ""); setNote(alias?.note ?? ""); setMsg(null);
  }, [alias?.firstName, alias?.lastName, alias?.note]);

  const clearing = !first.trim() && !last.trim();
  const dirty = first.trim() !== (alias?.firstName ?? "") || last.trim() !== (alias?.lastName ?? "") || (note.trim() || null) !== (alias?.note ?? null);
  const invalid = !clearing && (!first.trim() || !last.trim());
  const save = async () => {
    if (!dirty || invalid) return;
    setSaving(true); setMsg(null);
    const err = await onSaveAlias(managerEmail, first.trim(), last.trim(), note.trim() || null);
    setSaving(false);
    setMsg(err ?? (clearing ? "Alias cleared" : "Saved"));
  };
  const inputCls = "h-8 rounded-[7px] border px-2 text-[12px] outline-none disabled:opacity-60";
  return (
    <div className="mb-3 rounded-[10px] border p-2.5" style={{ background: C.surface, borderColor: C.line }}>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: C.muted }}>
        Gusto payroll name
        <span className="text-[10.5px] font-normal normal-case tracking-normal" style={{ color: C.muted2 }}>overrides the CSV First/Last for {managerName} — leave blank to use the schedule name</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={first} disabled={saving} onChange={(e) => setFirst(e.target.value)} placeholder="First name" aria-label="Gusto first name" className={`${inputCls} w-32`} style={{ borderColor: C.chipLine }} />
        <input value={last} disabled={saving} onChange={(e) => setLast(e.target.value)} placeholder="Last name" aria-label="Gusto last name" className={`${inputCls} w-32`} style={{ borderColor: C.chipLine }} />
        <input value={note} disabled={saving} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Alias note" className={`${inputCls} w-40`} style={{ borderColor: C.chipLine }} />
        <button type="button" onClick={save} disabled={saving || !dirty || invalid} className="rounded-[7px] px-3 py-1 text-[11.5px] font-bold disabled:opacity-40" style={{ background: C.accent, color: "#06281d" }}>{clearing && alias ? "Clear alias" : "Save alias"}</button>
        {invalid && <span className="text-[11px]" style={{ color: C.critInk }}>Both first and last name required.</span>}
        {msg && !invalid && <span className="text-[11px]" style={{ color: C.muted }}>{msg}</span>}
      </div>
    </div>
  );
}

function AdjEditor({ r, onCancel, onSave }: { r: ManagerRow; onCancel: () => void; onSave: (amt: number, notes: string | null) => void }) {
  const [amt, setAmt] = useState(r.adjustment ? String(r.adjustment) : "");
  const [notes, setNotes] = useState(r.adjustmentNotes ?? "");
  return (
    <div className="flex flex-col gap-1.5">
      <input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder="Amount" className="h-8 rounded-[7px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }} />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reason" className="h-8 rounded-[7px] border px-2 text-[12px]" style={{ borderColor: C.chipLine }} />
      <div className="flex gap-1.5">
        <button type="button" onClick={() => onSave(Number(amt) || 0, notes.trim() || null)} className="rounded-[7px] px-2.5 py-1 text-[11px] font-bold" style={{ background: C.accent, color: "#06281d" }}>Save</button>
        <button type="button" onClick={onCancel} className="rounded-[7px] border px-2.5 py-1 text-[11px] font-bold" style={{ borderColor: C.chipLine, color: C.muted }}>Cancel</button>
      </div>
    </div>
  );
}

function MgrDetail({ r, isAdmin, alias, onSaveAlias }: { r: ManagerRow; isAdmin: boolean; alias: Alias | undefined; onSaveAlias: SaveAlias }) {
  const rateWhy = (m: ManagerMatch): string => {
    if (m.coManaged) return `co-managed — ${money(20)} each`;
    if ((m.maxPlayerCount ?? 0) >= TOURNAMENT_THRESHOLD && m.payAmount === 30) return `tournament (capacity ${m.maxPlayerCount})`;
    return "ran on their own";
  };
  return (
    <div className="border-b px-4 py-3" style={{ background: C.board, borderColor: C.line }}>
      {isAdmin && r.managerEmail && <AliasEditor managerEmail={r.managerEmail} managerName={r.managerName} alias={alias} onSaveAlias={onSaveAlias} />}
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-[10px] font-bold tracking-[0.07em]" style={{ color: C.muted }}>
            <th className="border-b py-1.5 pr-2.5 text-left" style={{ borderColor: C.hair }}>WHEN</th>
            <th className="border-b py-1.5 pr-2.5 text-left" style={{ borderColor: C.hair }}>FIELD</th>
            <th className="border-b py-1.5 pr-2.5 text-left" style={{ borderColor: C.hair }}>SIGN-UPS</th>
            <th className="border-b py-1.5 pr-2.5 text-left" style={{ borderColor: C.hair }}>RATE APPLIED, AND WHY</th>
            <th className="border-b py-1.5 text-right" style={{ borderColor: C.hair }}>PAY</th>
          </tr>
        </thead>
        <tbody>
          {r.matches.map((m) => (
            <tr key={m.matchId} className="text-[11.5px]" style={{ color: C.ink }}>
              <td className="border-b py-1.5 pr-2.5" style={{ borderColor: C.hair, color: C.muted }}>{m.centralWeekday} {dshort(m.centralDate)} · {m.centralTime}</td>
              <td className="border-b py-1.5 pr-2.5 font-bold" style={{ borderColor: C.hair }}>{m.fieldTitle ?? "—"}{(m.maxPlayerCount ?? 0) >= TOURNAMENT_THRESHOLD && <span className="ml-1.5 rounded-[5px] border px-[5px] text-[10px] font-[800]" style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>TOURNAMENT</span>}</td>
              <td className="border-b py-1.5 pr-2.5" style={{ borderColor: C.hair, color: C.muted }}>—</td>
              <td className="border-b py-1.5 pr-2.5" style={{ borderColor: C.hair, color: C.muted }}>{rateWhy(m)}</td>
              <td className="border-b py-1.5 text-right font-[800] tabular-nums" style={{ borderColor: C.hair }}>{money(m.payAmount)}</td>
            </tr>
          ))}
          {r.adjustment !== 0 && (
            <tr className="text-[11.5px]" style={{ color: C.ink }}>
              <td className="py-1.5 pr-2.5" style={{ color: C.muted }}>{r.adjustmentAt ? dshort(r.adjustmentAt.slice(0, 10)) : "—"}</td>
              <td className="py-1.5 pr-2.5 font-bold">Adjustment</td>
              <td className="py-1.5 pr-2.5" style={{ color: C.muted }}>—</td>
              <td className="py-1.5 pr-2.5" style={{ color: C.muted }}>{r.adjustmentNotes ?? <b style={{ color: C.warnInk }}>no reason written down</b>}</td>
              <td className="py-1.5 text-right font-[800] tabular-nums">{money(r.adjustment)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function UnRow({ m }: { m: MatchSummary }) {
  return (
    <div data-uid={m.matchId} className="mp-grid border-b" style={{ background: "#fefaf8", borderColor: C.hair, paddingTop: 9, paddingBottom: 9 }}>
      <div style={{ minWidth: 0 }}>
        <div className="flex items-center gap-[7px] text-[12.5px] font-[800]" style={{ color: C.critInk }}>No manager assigned<span className="rounded-full border px-[7px] py-[2px] text-[9.5px]" style={{ background: C.critBg, borderColor: C.critLine }}>DOES NOT PAY</span></div>
        <div className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[11px]" style={{ color: C.muted }}>{m.centralWeekday} {dshort(m.centralDate)} · {m.centralTime} · {m.fieldTitle ?? "—"}{(m.maxPlayerCount ?? 0) >= TOURNAMENT_THRESHOLD ? " · tournament" : ""}</div>
      </div>
      <div><div className="text-[13px] font-[800]" style={{ color: C.muted2 }}>—</div><div className="mt-0.5 text-[10.5px] font-bold" style={{ color: C.muted }}>{m.playerCount ?? 0} of {m.maxPlayerCount ?? "?"} signed up</div></div>
      <div className="text-right"><span className="text-[13.5px] font-[800]" style={{ color: C.muted2 }}>{money(0)}</span></div>
      <div><span className="text-[11.5px]" style={{ color: C.muted2 }}>—</span></div>
      <div className="text-right"><span className="text-[13.5px] font-[800]" style={{ color: C.muted2 }}>{money(0)}</span></div><div />
    </div>
  );
}
