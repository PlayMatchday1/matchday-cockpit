"use client";

// Read-only Manager Pay, driven ONLY by /api/manager-pay/shared (token-authed).
// No session, no writes, no admin controls. Shows the week nav, city filter, four
// tiles, the day grid with matches, the manager rows with amounts, and both pay
// dates from Part A. Everyone with the link sees all managers.

import { useEffect, useMemo, useState } from "react";
import type { SharedManagerPayPayload, SharedMatch } from "@/lib/managerPaySharedPayload";

const C = {
  forestDeep: "#072a20", forest: "#0d3b2e", accent: "#35c77f", amount: "#e2502b", mint: "#e0f2e7",
  ink: "#12241d", muted: "#6d7b74", muted2: "#b3c2ba", warnBg: "#fdf1d0", warnInk: "#8a6300", warnLine: "#e3c369",
  critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9", ok: "#12704a",
  railA: "#fafbfa", railB: "#f6f9f7", board: "#f8faf9", chipBg: "#eef3f0", chipLine: "#e2eae5",
  line: "#e6ebe8", hair: "#eff3f1", surface: "#ffffff", cream: "#f4f1ea",
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const money = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const dshort = (iso: string) => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const dfull = (iso: string) => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function weekdayUtc(iso: string): number { return new Date(`${iso}T00:00:00.000Z`).getUTCDay(); }
function snapToMonday(iso: string): string { const wd = weekdayUtc(iso); return addDays(iso, wd === 0 ? -6 : -(wd - 1)); }
function defaultWeekStart(): string { return addDays(snapToMonday(new Date().toISOString().slice(0, 10)), -7); }

const namesOf = (m: SharedMatch) => [m.primaryManagerName, m.secondManagerName].filter((s): s is string => !!s);

export default function SharedManagerPayView({ token }: { token: string }) {
  const [weekStart, setWeekStart] = useState<string>(() => defaultWeekStart());
  const [payload, setPayload] = useState<SharedManagerPayPayload | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "notfound" | "error">("loading");
  const [city, setCity] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const res = await fetch(`/api/manager-pay/shared?token=${encodeURIComponent(token)}&week=${encodeURIComponent(weekStart)}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 404) { setStatus("notfound"); setPayload(null); return; }
        if (!res.ok) { setStatus("error"); setPayload(null); return; }
        setPayload((await res.json()) as SharedManagerPayPayload);
        setStatus("ok");
      } catch { if (!cancelled) setStatus("error"); }
    })();
    return () => { cancelled = true; };
  }, [token, weekStart]);

  const scoped = useMemo(() => {
    if (!payload) return [];
    return city ? payload.cities.filter((c) => c.cityIdentifier === city) : payload.cities;
  }, [payload, city]);

  const tiles = useMemo(() => {
    const managers = scoped.flatMap((c) => c.managers);
    const matches = scoped.flatMap((c) => c.matches);
    return {
      total: scoped.reduce((s, c) => s + c.total, 0),
      managersPaid: managers.filter((m) => m.total > 0).length,
      cities: new Set(managers.filter((m) => m.total > 0).map((m) => m.cityIdentifier ?? "?")).size,
      matchesPaid: matches.filter((m) => !m.isCancelled && namesOf(m).length > 0).length,
      onCalendar: matches.length,
    };
  }, [scoped]);

  const shell = (inner: React.ReactNode) => (
    <div style={{ minHeight: "100vh", background: C.cream, color: C.ink, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif" }}>
      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "26px 18px 64px" }}>{inner}</div>
    </div>
  );

  if (status === "notfound") {
    return shell(
      <div className="rounded-[14px] border p-8 text-center" style={{ background: C.surface, borderColor: C.line }}>
        <div className="text-[18px] font-[800]" style={{ color: C.forestDeep }}>This link is no longer valid</div>
        <div className="mt-1.5 text-[13px]" style={{ color: C.muted }}>Ask your admin for the current Manager Pay link.</div>
      </div>,
    );
  }
  if (status === "error") return shell(<div className="p-8 text-[13px]" style={{ color: C.critInk }}>Couldn’t load pay for this week. Refresh to try again.</div>);
  if (!payload) return shell(<div className="p-8 text-[13px]" style={{ color: C.muted }}>Loading…</div>);

  const isDefault = weekStart === defaultWeekStart();
  const arrival = payload.effectiveArrival;

  return shell(
    <>
      <div className="mb-4">
        <div className="text-[11px] font-[800] uppercase tracking-[0.12em]" style={{ color: C.accent }}>Matchday</div>
        <h1 className="m-0 mt-0.5 text-[24px] font-[800] tracking-[-0.3px]" style={{ color: C.forestDeep }}>Manager Pay</h1>
        <div className="mt-1 text-[12.5px]" style={{ color: C.muted }}>What each manager is owed for the week of {dshort(payload.weekStart)} – {dfull(payload.weekEnd)}.</div>
      </div>

      {/* week bar + both pay dates */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border" style={{ background: C.surface, borderColor: C.line, padding: "11px 14px" }}>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))} className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border" style={{ background: C.railA, borderColor: C.chipLine, color: C.forest }}>‹</button>
          <span className="whitespace-nowrap text-[14px] font-[800]" style={{ color: C.forestDeep }}>{dshort(payload.weekStart)} – {dfull(payload.weekEnd)}</span>
          <button type="button" aria-label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))} className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border" style={{ background: C.railA, borderColor: C.chipLine, color: C.forest }}>›</button>
        </div>
        <span className="rounded-full border px-[9px] py-[3px] text-[10.5px] font-[800] tracking-[0.05em]" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>
          {isDefault ? "LAST COMPLETED" : weekStart > defaultWeekStart() ? "IN PROGRESS" : "PAST WEEK"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" style={{ color: C.muted }}>
          <span>Pay run <b style={{ color: C.ink }}>{payload.payRun ? dfull(payload.payRun) : "—"}</b></span>
          <span>
            Est. arrival <b style={{ color: C.ink }}>{arrival ? dfull(arrival) : "unavailable"}</b>
            {payload.arrivalOverride && (
              <span className="ml-1.5 rounded-full border px-[7px] py-[2px] text-[9.5px] font-[800]" title={`Adjusted by ${payload.arrivalOverride.by ?? "an admin"} on ${payload.arrivalOverride.at} — ${payload.arrivalOverride.reason}`} style={{ background: C.warnBg, borderColor: C.warnLine, color: C.warnInk }}>ADJUSTED</span>
            )}
          </span>
        </div>
      </div>

      {/* city chips */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Chip on={city === ""} onClick={() => setCity("")}>All cities <i className="not-italic opacity-70">{payload.cities.reduce((s, c) => s + c.managers.length, 0)}</i></Chip>
        {payload.cities.map((c) => <Chip key={c.cityIdentifier} on={city === c.cityIdentifier} onClick={() => setCity(c.cityIdentifier)}>{c.cityIdentifier} <i className="not-italic opacity-70">{c.managers.length}</i></Chip>)}
      </div>

      {/* four tiles */}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[12px] border" style={{ background: "linear-gradient(180deg,#effaf3,#ffffff)", borderColor: "#bfe2cf", padding: "13px 15px" }}>
          <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>TOTAL PAYOUT</div>
          <div className="mt-1 text-[27px] font-[800] leading-none tracking-[-0.6px]" style={{ color: C.amount }}>{money(tiles.total)}</div>
          <div className="mt-1.5 text-[11px]" style={{ color: C.muted }}>owed this week{city ? ` · ${city} only` : ""}</div>
        </div>
        <Tile label="MANAGERS PAID" value={String(tiles.managersPaid)} note={`in ${tiles.cities} cit${tiles.cities === 1 ? "y" : "ies"}`} />
        <Tile label="MATCHES PAID" value={String(tiles.matchesPaid)} note={`of ${tiles.onCalendar} on the calendar`} />
        <Tile label="ESTIMATED ARRIVAL" value={arrival ? dshort(arrival) : "—"} note={payload.payRun ? `pay run ${dshort(payload.payRun)}` : "pending"} accent />
      </div>

      {/* board */}
      <section className="rounded-[13px] border" style={{ background: C.surface, borderColor: C.line }}>
        {scoped.length === 0 || scoped.every((c) => c.managers.length === 0 && c.matches.length === 0) ? (
          <div className="px-4 py-9 text-center text-[12.5px]" style={{ color: C.muted }}>No matches on this week.</div>
        ) : scoped.map((c) => (
          <div key={c.cityIdentifier}>
            <div className="flex items-baseline gap-2.5 border-t border-b px-4 py-2" style={{ background: C.railB, borderTopColor: C.line, borderBottomColor: C.hair }}>
              <span className="rounded-[5px] px-[7px] py-[2px] text-[11px] font-[800] tracking-[0.05em]" style={{ background: C.forest, color: "#fff" }}>{c.cityIdentifier}</span>
              <span className="text-[13px] font-[800]" style={{ color: C.forestDeep }}>{c.cityIdentifier}</span>
              <span className="text-[11.5px] font-semibold" style={{ color: C.muted }}>{c.managers.length} manager{c.managers.length === 1 ? "" : "s"}</span>
              <span className="ml-auto text-[12.5px] font-[800]" style={{ color: C.ink }}>{money(c.total)}</span>
            </div>

            {/* day grid */}
            <WeekStrip weekStart={payload.weekStart} matches={c.matches} />

            {/* managers + amounts */}
            {c.managers.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr className="text-[10px] font-bold tracking-[0.07em]" style={{ color: C.muted }}>
                      <th className="border-b px-4 py-2 text-left" style={{ borderColor: C.line }}>MANAGER</th>
                      <th className="border-b px-2 py-2 text-left" style={{ borderColor: C.line }}>MATCHES</th>
                      <th className="border-b px-2 py-2 text-right" style={{ borderColor: C.line }}>MATCH PAY</th>
                      <th className="border-b px-2 py-2 text-right" style={{ borderColor: C.line }}>ADJUSTMENT</th>
                      <th className="border-b px-4 py-2 text-right" style={{ borderColor: C.line }}>TOTAL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.managers.map((m) => (
                      <tr key={m.managerName}>
                        <td className="border-b px-4 py-2.5 font-bold" style={{ borderColor: C.hair, color: C.forestDeep }}>{m.managerName}</td>
                        <td className="border-b px-2 py-2.5" style={{ borderColor: C.hair, color: C.muted }}>{m.matchCount}</td>
                        <td className="border-b px-2 py-2.5 text-right tabular-nums" style={{ borderColor: C.hair, color: m.baseTotal ? C.ink : C.muted2 }}>{money(m.baseTotal)}</td>
                        <td className="border-b px-2 py-2.5 text-right tabular-nums" style={{ borderColor: C.hair, color: m.adjustment ? C.ink : C.muted2 }}>{m.adjustment ? money(m.adjustment) : "—"}</td>
                        <td className="border-b px-4 py-2.5 text-right font-[800] tabular-nums" style={{ borderColor: C.hair, color: C.ink }}>{money(m.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        <div className="border-t px-4 py-3 text-[11.5px] leading-[1.6]" style={{ background: C.railB, borderColor: C.line, color: C.muted }}>
          The week runs Monday–Sunday. The pay run is the Tuesday after it ends; the estimated arrival is 4 banking days later
          (weekends and US Federal Reserve holidays don’t settle). Amounts are read-only here.
        </div>
      </section>
    </>,
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
function Tile({ label, value, note, accent }: { label: string; value: string; note: string; accent?: boolean }) {
  return (
    <div className="rounded-[12px] border" style={{ background: C.surface, borderColor: C.line, padding: "13px 15px" }}>
      <div className="text-[10.5px] font-bold tracking-[0.08em]" style={{ color: C.muted }}>{label}</div>
      <div className="mt-1 text-[27px] font-[800] leading-none tracking-[-0.6px]" style={{ color: accent ? C.forest : C.forestDeep }}>{value}</div>
      <div className="mt-1.5 text-[11px]" style={{ color: C.muted }}>{note}</div>
    </div>
  );
}

function WeekStrip({ weekStart, matches }: { weekStart: string; matches: SharedMatch[] }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return (
    <div style={{ background: C.railA, borderBottom: `1px solid ${C.line}` }}>
      <div className="grid grid-cols-7 gap-2 px-4 py-3">
        {days.map((iso, i) => {
          const dayMatches = matches.filter((m) => m.centralDate === iso);
          return (
            <div key={iso} className="min-w-0">
              <div className="pb-1.5 text-[10px] font-bold tracking-[0.07em]" style={{ color: C.muted }}>{DOW[i].toUpperCase()}<b className="mt-0.5 block text-[12px]" style={{ color: C.forestDeep }}>{dshort(iso)}</b></div>
              {dayMatches.length === 0 ? <div className="px-0.5 py-1.5 text-[11px]" style={{ color: C.muted2 }}>—</div>
                : dayMatches.map((m) => <MatchCard key={m.matchId} m={m} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function MatchCard({ m }: { m: SharedMatch }) {
  const names = namesOf(m);
  const tournament = (m.maxPlayerCount ?? 0) >= 25;
  const cancelled = m.isCancelled;
  const unassigned = !cancelled && names.length === 0;
  const style: React.CSSProperties = cancelled ? { background: "#fdf7f5", borderColor: C.critLine }
    : unassigned ? { background: "#fefaf8", borderColor: C.critLine }
    : tournament ? { background: "#fffdf6", borderColor: C.warnLine } : { background: C.surface, borderColor: C.line };
  return (
    <div className="mb-1.5 rounded-[9px] border" style={{ ...style, padding: "7px 8px" }}>
      <div className="text-[11px] font-[800]" style={{ color: cancelled ? C.critInk : C.forestDeep, textDecoration: cancelled ? "line-through" : undefined }}>{tournament ? "🏆 " : ""}{m.centralTime}</div>
      <div className="mt-0.5 text-[10.5px] leading-[1.3]" style={{ color: cancelled ? C.critInk : C.ink }}>{m.fieldTitle ?? "—"}</div>
      <div className="mt-[3px] text-[10.5px] font-bold" style={{ color: names.length ? C.muted : C.critInk }}>{names.length ? names.join(" + ") : "No manager assigned"}</div>
      <div className="mt-[3px] flex flex-wrap items-center gap-[5px] text-[10px]" style={{ color: C.muted }}>
        <span>{m.playerCount ?? 0}/{m.maxPlayerCount ?? "?"} signed up</span>
        {cancelled ? <span>cancelled</span> : unassigned ? <span>{money(0)}</span>
          : <span className="font-[800]" style={{ color: C.ok }}>{money(m.payPerManager)}{names.length > 1 ? " each" : ""}</span>}
      </div>
    </div>
  );
}
