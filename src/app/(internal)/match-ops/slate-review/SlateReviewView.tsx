"use client";

// Slate Review — the weekly per-city decision page (moved out of Finance into
// Match Ops). Pass 1: everything except the Match P&L-by-field card, which lands
// as a follow-up once its ran-count tie is verified. No placeholder where it
// goes — the section is simply absent.
//
// Every number is computed from the DB (via the shared, already-verified match
// helpers); nothing is typed. Order top→bottom is deliberate (spec): chips →
// lede → games-per-week strip → Master Schedule + capture → Cancel patterns →
// prices → honesty note.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useMatchWindowData } from "@/lib/useMatchData";
import { getCancelHeatmap, type SlotRow } from "@/lib/cityStats";
import { useWeeklyDemand, type DemandWeek } from "@/lib/slateDemand";
import { fieldCodeMap } from "@/lib/slateFieldCodes";
import { VISIBLE_CITIES } from "@/lib/types";
import CitiesMasterScheduleLens from "@/components/CitiesMasterScheduleLens";
import { fetchLegacyMatchRegistrations } from "@/lib/mdapiMatchesRead";
import { useFinanceData } from "@/lib/useFinanceData";
import { detectDppPriceShifts, type DppPriceChange, type DppRegistration } from "@/lib/dppPriceHistory";
import {
  parseCapture, captureReadout, deriveFieldCodes, timeMinutes, CAPTURE_GRAMMAR, type Capture, type Day,
} from "@/lib/slateCapture";

const C = {
  forestDeep: "#072a20", forest: "#0d3b2e", accent: "#35c77f", mint: "#e0f2e7",
  ink: "#12241d", muted: "#626f68", ok: "#12704a", red: "#c8401f",
  line: "#e6ebe8", hair: "#eff3f1", surface: "#ffffff", canvas: "#f4efe4",
  chipBg: "#eef3f0", chipLine: "#e2eae5", colBg: "#fdfbf5", colLine: "#e8e0cf",
  slotBg: "#f8f3e7", slotLine: "#eae1cd", gold: "#e3c369", goldInk: "#8a6300",
  nsInk: "#6f6858",
};
// Cancel Patterns chronic scale — four distinct, eyedropped colours for
// n-of-4-weeks cancelled. Contrast (text on bg): 1=13.7:1, 2=7.4:1, 3=8.5:1,
// 4=5.2:1 — all well above 4.5:1. Change any hex and recompute.
//
// DELIBERATELY NON-MONOTONIC IN LIGHTNESS: 3-of-4 (#8b2c17) is darker than
// 4-of-4 (#d62015). This is approved and safe ONLY because the exact n/4 count
// is printed on every chip, so colour reinforces the count and is never the sole
// encoding. Do not "correct" this into a sequential light→dark ramp.
//
// The 1-of-4 step needs its border: #f0ece3 sits too close to the day-cell
// background (--slot-bg #f8f3e7) and the chip would lose its shape without it.
const RAMP: Record<number, { bg: string; fg: string; border?: string }> = {
  1: { bg: "#f0ece3", fg: "#12241d", border: "#e2ddd0" },
  2: { bg: "#eda01e", fg: "#12241d" },
  3: { bg: "#8b2c17", fg: "#ffffff" },
  4: { bg: "#d62015", fg: "#ffffff" },
};
const DAYS: Day[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// One decimal for every non-zero value (40.9, 4.0, 3.9); a plain "0" for zero.
const barFmt = (x: number) => (x === 0 ? "0" : x.toFixed(1));
const fmtWk = (d: Date) => `${MON[d.getMonth()]} ${d.getDate()}`;

type CapItem = Capture & { id: number };

export default function SlateReviewView() {
  const [city, setCity] = useState<string>("Austin");
  const [weekStart, setWeekStart] = useState<string>(() => {
    const d = new Date(); const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
    return `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}`;
  });
  const { rows, scheduledMatches, loading } = useMatchWindowData(12, city);
  const { weekly } = useWeeklyDemand(city, 8); // booked spots ÷ 18, absents INCLUDED, fakes out

  const fields = useMemo(() => {
    const set = new Set<string>();
    for (const m of scheduledMatches) if (m.city === city && m.field) set.add(m.field);
    return [...set].sort();
  }, [scheduledMatches, city]);

  if (loading && rows.length === 0) {
    return <div className="mx-auto max-w-[1180px] px-5 py-8 text-sm" style={{ color: C.muted }}>Loading slate…</div>;
  }

  // Window range = first day of the first week … last day of the last week.
  // (The last bar's weekStart is the START of the final bucket, not the window
  // end — printing it as the end was wrong: it read "Jun 8 – Jul 27".)
  const rangeLabel = weekly.length
    ? `${fmtWk(weekly[0].weekStart)} – ${fmtWk(addDays(weekly[weekly.length - 1].weekStart, 6))}`
    : "";

  return (
    <div className="mx-auto max-w-[1180px] px-5 pb-16" style={{ color: C.ink }}>
      {/* city chips */}
      <div className="mb-5 flex flex-wrap gap-2">
        {VISIBLE_CITIES.map((c) => {
          const on = c === city;
          return (
            <button key={c} type="button" onClick={() => setCity(c)}
              className="min-h-[30px] rounded-full border px-[14px] py-1.5 text-[13px] font-semibold"
              style={on ? { background: C.forestDeep, borderColor: C.forestDeep, color: "#fff" } : { background: "#fbf8f1", borderColor: C.colLine, color: C.forest }}>
              {c}
            </button>
          );
        })}
      </div>

      {/* head — title + window range only (lede removed) */}
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="m-0 text-[19px] font-bold tracking-[-0.2px]" style={{ color: C.forestDeep }}>Slate Review · {city}</h1>
        <span className="text-[12px]" style={{ color: C.muted }}>{rangeLabel}</span>
      </div>

      {/* games per week strip */}
      <Card>
        <SHead title="GAMES PER WEEK · LAST 8 WEEKS" />
        <p className="m-0 mb-3.5 text-[12.5px]" style={{ color: C.muted }}>Total spots booked ÷ 18</p>
        <GamesStrip weekly={weekly} />
      </Card>

      {/* master schedule (reused) + quick capture */}
      <Card>
        <SHead title={`MASTER SCHEDULE · ${city}`} />
        <CaptureBar city={city} fields={fields} weekStart={weekStart} />
        <div className="mt-2">
          <CitiesMasterScheduleLens city={city} weekStart={weekStart} onWeekStartChange={setWeekStart} />
        </div>
      </Card>

      {/* cancel patterns */}
      <CancelCard rows={rows} city={city} fields={fields} />

      {/* prices */}
      <PricesCard city={city} />

      {/* honesty note */}
      <Card>
        <SHead title="HOW THESE NUMBERS ARE BUILT" />
        <p className="m-0 text-[12.5px] leading-[1.6]" style={{ color: C.muted }}>
          Field cost is charged only to matches that actually ran; if we pay for a pitch when a match cancels, that sunk cost isn’t on any net figure here, so a field with real cancellations looks a little kinder than it was. The cancellation figures on this page use the last four completed weeks for the patterns view and the completed weeks of the eight-week window for the slot-by-slot grid — the current, partial week is left out of both, since a part-week can’t be compared with a finished one. Player and spot counts exclude fake accounts.
        </p>
      </Card>
    </div>
  );
}

// ── shells ───────────────────────────────────────────────────────────────────
function Card({ children }: { children: React.ReactNode }) {
  return <div className="mb-[18px] rounded-2xl border p-[18px_18px_16px]" style={{ background: C.surface, borderColor: C.line }}>{children}</div>;
}
function SHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3.5">
      <h2 className="m-0 text-[12px] font-bold uppercase tracking-[0.9px]" style={{ color: C.forestDeep }}>{title}</h2>
      {right}
    </div>
  );
}

// ── games-per-week strip ─────────────────────────────────────────────────────
function GamesStrip({ weekly }: { weekly: DemandWeek[] }) {
  // Scale to the busiest week that HAS data (a no-data week has no bar).
  const max = Math.max(1, ...weekly.filter((w) => w.hasData).map((w) => w.ratio));
  return (
    <div className="grid gap-[9px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, weekly.length)}, 1fr)` }}>
      {weekly.map((w) => {
        // Three states: no-data (hatched grey, "no data", excluded from scaling);
        // true 0 (a visible baseline tick labelled "0"); a real value.
        const noData = !w.hasData;
        const h = Math.max(2, Math.round((w.ratio / max) * 96));
        return (
          <div key={w.weekStart.toISOString()} className="flex flex-col gap-[5px]">
            <div className="text-center text-[12.5px] font-bold leading-none" style={{ color: noData ? C.muted : C.forestDeep }}>{noData ? "–" : barFmt(w.ratio)}</div>
            <div className="flex items-end border-b" style={{ borderColor: C.line, height: 100 }}>
              {noData ? (
                <div className="w-full rounded-t-[4px]" title="no source rows this week"
                  style={{ height: 96, opacity: 0.55, background: "repeating-linear-gradient(135deg,#d8d2c4 0 5px,#efe9dc 5px 10px)" }} />
              ) : (
                <div className="w-full rounded-t-[4px]" style={{ height: h, background: w.isCurrent ? "repeating-linear-gradient(135deg,#35c77f 0 5px,#a6e6c6 5px 10px)" : C.accent }} />
              )}
            </div>
            <div className="text-center text-[11px] leading-[1.2]" style={{ color: C.muted }}>{fmtWk(w.weekStart)}</div>
            {noData ? (
              <div className="text-center text-[10.5px] font-semibold" style={{ color: C.muted }}>no data</div>
            ) : w.isCurrent ? (
              <div className="text-center text-[10.5px] font-semibold" style={{ color: C.muted }}>in progress</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── quick capture (in-memory only) ───────────────────────────────────────────
function CaptureBar({ city, fields, weekStart }: { city: string; fields: string[]; weekStart: string }) {
  const [val, setVal] = useState("");
  const [caps, setCaps] = useState<CapItem[]>([]);
  const [copy, setCopy] = useState<"" | "ok" | "manual">("");
  const idRef = useRef(0);
  // clear capture + input when the city changes (a new city is a new meeting scope)
  useEffect(() => { setCaps([]); setVal(""); setCopy(""); }, [city]);

  const parsed = useMemo(() => parseCapture(val, fields), [val, fields]);
  const readout = captureReadout(parsed);
  const codes = useMemo(() => deriveFieldCodes(fields), [fields]);

  const commit = () => {
    const p = parseCapture(val, fields);
    if (!p) return;
    setCaps((cs) => [...cs, { ...p, id: idRef.current++ }]);
    setVal(""); setCopy("");
  };
  const drop = (id: number) => { setCaps((cs) => cs.filter((c) => c.id !== id)); setCopy(""); };

  const capText = () => {
    const slots = caps.filter((c) => c.kind === "slot");
    const notes = caps.filter((c) => c.kind !== "slot");
    const L = [`${city} · week of ${weekStart} · slate review`];
    if (slots.length) { L.push("", "Proposed slots"); slots.forEach((c) => { if (c.kind === "slot") L.push(`- ${c.day} ${c.time} · ${c.fieldTxt}   (typed: "${c.raw}")`); }); }
    if (notes.length) { L.push("", "Notes"); notes.forEach((c) => L.push(`- ${c.raw}`)); }
    return L.join("\n");
  };
  const copyAll = async () => {
    const t = capText();
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); setCopy("ok"); }
      else setCopy("manual");
    } catch { setCopy("manual"); }
  };

  const props = caps.filter((c): c is CapItem & { kind: "slot" } => c.kind === "slot");

  return (
    <div>
      <p className="m-0 mb-2.5 text-[12.5px]" style={{ color: C.muted }}>
        Talk through the week live: what you type becomes a dashed proposal on the day below, or is kept as a note. Nothing is saved — this clears on reload.
      </p>
      <div className="flex items-stretch gap-2">
        <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") setVal(""); }}
          autoComplete="off" spellCheck={false} aria-label="Add a slot or a note"
          placeholder="Add 8PM thurs Crossbar — or just type a note"
          className="h-[34px] min-w-0 flex-1 rounded-[10px] border px-[11px] text-[13px]" style={{ borderColor: C.colLine, background: C.surface }} />
        <button type="button" onClick={commit} className="h-[34px] rounded-[10px] px-4 text-[12px] font-bold text-white" style={{ background: C.forest }}>Add</button>
      </div>
      <div className="min-h-[32px] px-0.5 py-1.5 text-[11.5px] leading-[1.35]" style={{ color: C.muted }}>{readout || <span style={{ color: C.muted }}>{CAPTURE_GRAMMAR}</span>}</div>

      {/* proposals day-aligned strip (the reused Master Schedule grid renders below) */}
      {props.length > 0 && (
        <div className="mb-1 grid grid-cols-7 gap-2">
          {DAYS.map((ab) => {
            const here = props.filter((p) => p.day === ab).sort((a, b) => a.min - b.min);
            return (
              <div key={ab} className="rounded-[10px] border p-1.5" style={{ borderColor: C.colLine, background: C.colBg, minHeight: 44 }}>
                <div className="mb-1 text-[9.5px] font-bold uppercase tracking-[0.09em]" style={{ color: C.muted }}>{ab}</div>
                {here.map((p) => (
                  <div key={p.id} className="mb-1 flex items-start gap-1.5 rounded-[8px] border border-dashed p-[5px_6px]" style={{ borderColor: C.gold }}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] font-bold" style={{ color: C.goldInk }}>{p.time}</span>
                      <span className="block text-[10px]" style={{ color: "#77673c" }}>{codes[p.field ?? ""] ? "" : ""}{p.fieldTxt}</span>
                    </span>
                    <span className="rounded-[4px] border px-1 text-[9px] font-bold" style={{ background: "#fdf3d9", borderColor: C.gold, color: C.goldInk }}>NEW</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* captured list */}
      {caps.length > 0 && (
        <div className="mt-3 border-t pt-2.5" style={{ borderColor: C.line }}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.8px]" style={{ color: C.muted }}>Captured in this meeting · {caps.length}</span>
            <span className="flex items-center gap-2">
              {copy === "ok" && <span className="text-[11px] font-bold" style={{ color: C.ok }}>Copied.</span>}
              <button type="button" onClick={copyAll} className="h-[28px] rounded-[8px] border px-3 text-[11px] font-bold" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.forestDeep }}>Copy all</button>
            </span>
          </div>
          {caps.map((c) => (
            <div key={c.id} className="flex items-start gap-2.5 border-t py-[7px] first:border-t-0" style={{ borderColor: C.hair }}>
              <span className="mt-0.5 flex-none rounded-[4px] border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.7px]" style={c.kind === "slot" ? { background: "#fdf3d9", borderColor: C.gold, color: C.goldInk } : { background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>{c.kind === "slot" ? "SLOT" : "NOTE"}</span>
              <span className="min-w-0 flex-1">
                {c.kind === "slot" ? (
                  <>
                    <span className="block text-[12.5px] font-semibold" style={{ color: C.ink }}>{c.day} {c.time} · {c.fieldTxt}</span>
                    <span className="block text-[11px]" style={{ color: C.muted }}>typed: “{c.raw}”</span>
                  </>
                ) : (
                  <span className="block text-[12.5px] font-semibold" style={{ color: C.ink }}>{c.raw}</span>
                )}
              </span>
              <button type="button" onClick={() => drop(c.id)} aria-label="Remove" className="h-[28px] w-[28px] flex-none rounded-[8px] border text-[12px]" style={{ borderColor: C.chipLine, color: C.muted }}>✕</button>
            </div>
          ))}
          {copy === "manual" && (
            <textarea readOnly onClick={(e) => (e.target as HTMLTextAreaElement).select()} value={capText()} className="mt-2 h-[104px] w-full rounded-[8px] border p-2 text-[11.5px]" style={{ borderColor: C.colLine }} />
          )}
        </div>
      )}
    </div>
  );
}

// ── cancel patterns (Patterns + Numbers tabs), both from getCancelHeatmap ─────
function CancelCard({ rows, city, fields }: { rows: Parameters<typeof getCancelHeatmap>[0]; city: string; fields: string[] }) {
  const [tab, setTab] = useState<"pat" | "num">("pat");
  const [show, setShow] = useState<"cx" | "all">("cx");
  const [sort, setSort] = useState<"day" | "bad">("day");
  // Single source of chip labels — the curated hand-chosen shorthand, shared by
  // the Patterns view, the Numbers view, and the footer key. NOT title initials.
  const codes = useMemo(() => fieldCodeMap(fields), [fields]);
  // Numbers grid needs every slot (all 8 weeks); include all slots when "Every match".
  const hm = useMemo(() => getCancelHeatmap(rows, city, 8, new Date(), { includeAllSlots: show === "all" }), [rows, city, show]);
  // Patterns needs only cancelled slots, so build off a cancelled-only heatmap.
  const hmCx = useMemo(() => getCancelHeatmap(rows, city, 8, new Date(), { includeAllSlots: false }), [rows, city]);

  const btn = (on: boolean): React.CSSProperties => on
    ? { background: C.forestDeep, borderColor: C.forestDeep, color: "#fff" }
    : { background: "#fbf8f1", borderColor: C.colLine, color: C.forest };

  return (
    <Card>
      <SHead title="CANCEL PATTERNS" right={
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5"><span className="text-[10.5px] font-bold uppercase tracking-[0.7px]" style={{ color: C.muted }}>View</span>
            <TabBtn on={tab === "pat"} onClick={() => setTab("pat")}>Patterns</TabBtn>
            <TabBtn on={tab === "num"} onClick={() => setTab("num")}>Numbers</TabBtn>
          </div>
          {tab === "num" && (
            <>
              <div className="flex items-center gap-1.5"><span className="text-[10.5px] font-bold uppercase tracking-[0.7px]" style={{ color: C.muted }}>Show</span>
                <TabBtn on={show === "cx"} onClick={() => setShow("cx")}>Cancellations</TabBtn>
                <TabBtn on={show === "all"} onClick={() => setShow("all")}>Every match</TabBtn>
              </div>
              <div className="flex items-center gap-1.5"><span className="text-[10.5px] font-bold uppercase tracking-[0.7px]" style={{ color: C.muted }}>Sort</span>
                <TabBtn on={sort === "day"} onClick={() => setSort("day")}>By day</TabBtn>
                <TabBtn on={sort === "bad"} onClick={() => setSort("bad")}>Worst first</TabBtn>
              </div>
            </>
          )}
        </div>
      } />
      {tab === "pat" ? <Patterns hm={hmCx} codes={codes} /> : <Numbers hm={hm} codes={codes} show={show} sort={sort} />}
    </Card>
  );
}
function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="min-h-[28px] rounded-full border px-3 py-[5px] text-[11px] font-bold uppercase tracking-[0.5px]"
    style={on ? { background: C.forestDeep, borderColor: C.forestDeep, color: "#fff" } : { background: "#fbf8f1", borderColor: C.colLine, color: C.forest }}>{children}</button>;
}

// last 4 fully-completed weeks (drop the current partial = last week key)
function completedWeeks(weeks: string[]): string[] {
  const done = weeks.slice(0, weeks.length - 1); // drop current
  return done.slice(-4);
}

function Patterns({ hm, codes }: { hm: { weeks: string[]; slots: SlotRow[] }; codes: Record<string, string> }) {
  const wks = completedWeeks(hm.weeks); // oldest→newest among the 4
  const order = [...wks].reverse(); // most recent first
  // cancelCount per slot over the 4 completed weeks
  const cxCount = (s: SlotRow) => wks.reduce((a, w) => a + (s.weeks[w]?.cancelled ? 1 : 0), 0);
  const fieldsWithChip = new Set<string>();
  let totalCx = 0;
  for (const s of hm.slots) for (const w of wks) if (s.weeks[w]?.cancelled) { totalCx++; fieldsWithChip.add(s.field); }
  const stepsPresent = [4, 3, 2, 1].filter((n) => hm.slots.some((s) => cxCount(s) === n && wks.some((w) => s.weeks[w]?.cancelled)));
  const first = wkKeyToDate(wks[0]); const last = wkKeyToDate(wks[wks.length - 1]);

  return (
    <>
      <p className="m-0 mb-3.5 text-[12.5px]" style={{ color: C.muted }}>
        Every cancelled match, week by week, over the last {wks.length} fully completed weeks — {first ? fmtWk(first) : ""} to {last ? fmtWk(addDays(last, 6)) : ""}, {totalCx} {totalCx === 1 ? "cancellation" : "cancellations"}. Darker means the same slot cancelled in more of those weeks; the count is printed on every chip too. A blank day had none. Each chip reads field, time, and spots already booked.
      </p>
      {order.map((wk, bi) => {
        const wd = wkKeyToDate(wk);
        return (
          <div key={wk} className="mb-3 last:mb-0">
            <div className="mb-1.5 flex items-baseline gap-2.5 text-[11px] font-bold uppercase tracking-[0.6px]" style={{ color: C.muted }}>
              <span>{wd ? `${fmtWk(wd)} – ${fmtWk(addDays(wd, 6))}` : wk}</span>
              {bi === 0 && <em className="text-[9.5px] not-italic" style={{ color: C.forestDeep }}>most recent</em>}
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {DAYS.map((ab, di) => {
                const here = hm.slots.filter((s) => s.dowIdx === di && s.weeks[wk]?.cancelled).sort((a, b) => timeMinutes(a.time) - timeMinutes(b.time) || a.field.localeCompare(b.field));
                return (
                  <div key={ab} className="rounded-[10px] border p-1.5" style={{ borderColor: C.colLine, background: C.colBg, minHeight: 56 }}>
                    <div className="mb-1 text-[9.5px] font-bold uppercase tracking-[0.9px]" style={{ color: C.muted }}>{ab}</div>
                    {here.map((s) => {
                      const cc = cxCount(s); const ramp = RAMP[cc] ?? RAMP[1];
                      return (
                        <div key={s.field + s.time} className="mb-1 flex items-baseline gap-1.5 rounded-[6px] p-[4px_6px] text-[10.5px] leading-[1.35]" style={{ background: ramp.bg, color: ramp.fg, border: ramp.border ? `1px solid ${ramp.border}` : undefined }}>
                          <span className="min-w-0 flex-1 font-semibold" style={{ overflowWrap: "anywhere" }}><b className="font-extrabold tracking-[0.3px]">{codes[s.field] ?? s.field}</b> {s.time} · {s.weeks[wk]?.spots ?? 0}</span>
                          <span className="flex-none text-[9.5px] font-bold">{cc}/{wks.length}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {/* step legend — only steps that occur, most-chronic first. All four steps
          are defined in RAMP even though today only three render. */}
      <div className="mt-3 flex flex-wrap gap-[5px_14px] text-[11px]" style={{ color: C.muted }}>
        {stepsPresent.map((n) => (
          <span key={n} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <i className="inline-block h-[11px] w-[11px] flex-none rounded-[3px]" style={{ background: RAMP[n].bg, border: RAMP[n].border ? `1px solid ${RAMP[n].border}` : undefined }} />
            {n} of {wks.length} {wks.length === 1 ? "week" : "weeks"}
          </span>
        ))}
      </div>
      {/* field-code key — only fields that have a chip, ordered alphabetically by code */}
      {fieldsWithChip.size > 0 && (
        <p className="mt-1.5 text-[11px]" style={{ color: C.muted }}>
          {[...fieldsWithChip].sort((a, b) => (codes[a] ?? a).localeCompare(codes[b] ?? b)).map((f, i) => <span key={f}>{i > 0 ? " · " : ""}<b style={{ color: C.forestDeep }}>{codes[f] ?? f}</b> {f}</span>)}
        </p>
      )}
    </>
  );
}

function Numbers({ hm, codes, show, sort }: { hm: { weeks: string[]; slots: SlotRow[] }; codes: Record<string, string>; show: "cx" | "all"; sort: "day" | "bad" }) {
  // Drop the current, partial week (always the last entry) so every rate
  // denominator is a finished week — matches the strip's in-progress flag and
  // the patterns view, and keeps the honesty note true.
  const weeks = hm.weeks.slice(0, -1);
  // rate per slot = weeks-cancelled / weeks-scheduled (both COUNTS of weeks) — bug #3 fix.
  const stat = (s: SlotRow) => {
    let cx = 0, sched = 0;
    for (const w of weeks) { const d = s.weeks[w]; if (!d) continue; sched++; if (d.cancelled) cx++; }
    return { cx, sched, rate: sched ? (cx / sched) * 100 : 0 };
  };
  // Only slots that were on the schedule in at least one completed week — a slot
  // that existed solely in the dropped current week would otherwise show all
  // dashes with a "0 of 0" rate.
  const list = hm.slots.filter((s) => stat(s).sched > 0);
  if (sort === "day") list.sort((a, b) => a.dowIdx - b.dowIdx || timeMinutes(a.time) - timeMinutes(b.time) || a.field.localeCompare(b.field));
  else list.sort((a, b) => { const sa = stat(a), sb = stat(b); return sb.cx - sa.cx || sb.rate - sa.rate; }); // cancellations then rate — both printed
  // per-week players footer
  const wkPlayers = weeks.map((w) => hm.slots.reduce((a, s) => a + (s.weeks[w] && !s.weeks[w].cancelled ? s.weeks[w].players : 0), 0));

  const th: React.CSSProperties = { padding: "8px 8px", fontSize: 9.5, letterSpacing: "0.6px", textTransform: "uppercase", color: C.muted, fontWeight: 700, borderBottom: `1px solid ${C.line}`, textAlign: "center" };
  const td: React.CSSProperties = { padding: "7px 8px", fontSize: 12, borderBottom: `1px solid ${C.hair}`, textAlign: "center" };

  return (
    <>
      <p className="m-0 mb-3.5 text-[12.5px]" style={{ color: C.muted }}>
        Every slot that cancelled at least once, over the {weeks.length} completed weeks in this window. <span style={{ color: C.red, fontWeight: 600 }}>✕ N</span> = cancelled with N already booked; {show === "cx" ? <span style={{ color: C.ok, fontWeight: 600 }}>·</span> : <span style={{ color: C.ok, fontWeight: 600 }}>N</span>} = ran{show === "all" ? ", N played" : ""}; <span style={{ color: C.nsInk, fontWeight: 600 }}>–</span> = not scheduled. The rate is out of the weeks the slot was on the schedule, with the denominator printed. Players are shown week by week at the foot and deliberately not totalled.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", width: "23%" }}>Slot</th>
              {weeks.map((w) => <th key={w} style={{ ...th, width: "6.75%" }}>{wkShort(w)}</th>)}
              <th style={{ ...th, width: "13%" }}>Rate</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => {
              const st = stat(s);
              return (
                <tr key={s.field + s.dowIdx + s.time}>
                  <td style={{ ...td, textAlign: "left" }}>
                    <span className="block font-semibold" style={{ color: C.ink }}>{codes[s.field] ?? s.field}</span>
                    <span className="block text-[10.5px]" style={{ color: C.muted }}>{s.dow} · {s.time}</span>
                  </td>
                  {weeks.map((w) => {
                    const d = s.weeks[w];
                    if (!d) return <td key={w} style={td}><span style={{ color: C.nsInk }}>–</span></td>;
                    if (d.cancelled) return <td key={w} style={{ ...td, background: "#fcefeb" }}><span style={{ color: C.red, fontWeight: 700 }}>✕ {d.spots}</span></td>;
                    return <td key={w} style={td}>{show === "cx" ? <span style={{ color: C.ok }}>·</span> : <span style={{ color: C.ok }}>{d.players}</span>}</td>;
                  })}
                  <td style={td}><span className="block font-bold" style={{ color: C.ink }}>{Math.round(st.rate)}%</span><span className="block text-[10px]" style={{ color: C.muted }}>{st.cx} of {st.sched}</span></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...td, textAlign: "left", fontWeight: 700, color: C.muted }}>Players on ran matches</td>
              {wkPlayers.map((p, i) => <td key={i} style={{ ...td, fontWeight: 700, color: p ? C.ink : C.nsInk }}>{p || "–"}</td>)}
              <td style={{ ...td, color: C.muted }}>—<span className="block text-[10px]">not totalled</span></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

// ── prices (prose) ───────────────────────────────────────────────────────────
function PricesCard({ city }: { city: string }) {
  const { data } = useFinanceData();
  const [dpp, setDpp] = useState<DppPriceChange[] | null>(null);
  const [mem, setMem] = useState<{ price: number | null; active: number | null; since: string | null } | null>(null);

  useEffect(() => {
    const fin = data;
    if (!fin) return;
    let cancelled = false;
    (async () => {
      // DPP shifts over ~16 weeks, resolved to venues in this city (mirrors SlateDppPriceHistory)
      try {
        const to = new Date();
        const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 16 * 7);
        const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const regs = await fetchLegacyMatchRegistrations(supabase, { fromDate: ymd(from), toDate: ymd(to) });
        const venueById = new Map(fin.venues.map((v) => [v.id, v]));
        const dppRegs: DppRegistration[] = [];
        for (const r of regs) {
          if (r.payment_type !== "DAILY PAID") continue;
          if (r.field_id == null) continue;
          const vid = fin.venueFields.get(r.field_id);
          if (vid == null) continue;
          const v = venueById.get(vid);
          if (!v || v.city !== city) continue;
          const ms = parseLocalDate(r.match_start);
          if (!ms) continue;
          dppRegs.push({ matchStart: ms, venueId: vid, venueName: v.venue_name, city: v.city, amountDollars: Number(r.match_price_paid ?? 0) });
        }
        const shifts = detectDppPriceShifts(dppRegs, { now: new Date() });
        if (!cancelled) setDpp(shifts);
      } catch { if (!cancelled) setDpp([]); }
      // membership: latest MAX price snapshot for the city + active count
      try {
        const r = await supabase.from("membership_price_snapshots").select("max_price_dollars, active_count_at_price, captured_at, city").eq("city", city).order("captured_at", { ascending: false }).limit(1);
        const row = (r.data ?? [])[0] as { max_price_dollars: number; active_count_at_price: number; captured_at: string } | undefined;
        if (!cancelled) setMem(row ? { price: row.max_price_dollars, active: row.active_count_at_price, since: row.captured_at } : { price: null, active: null, since: null });
      } catch { if (!cancelled) setMem({ price: null, active: null, since: null }); }
    })();
    return () => { cancelled = true; };
  }, [city, data]);

  const inWin = (dpp ?? []).filter((c) => c.weeksAgo <= 8);
  const outWin = (dpp ?? []).length - inWin.length;

  return (
    <Card>
      <SHead title="PRICE CHANGES" />
      {dpp === null ? (
        <p className="m-0 text-[12.5px]" style={{ color: C.muted }}>Loading price history…</p>
      ) : (
        <>
          <p className="m-0 mb-2 text-[13px] leading-[1.6]" style={{ color: C.ink }}>
            {inWin.length === 0
              ? "DPP price did not change in this 8-week window."
              : <>DPP price moved {inWin.length} {inWin.length === 1 ? "time" : "times"} inside this window: {inWin.map((c, i) => <span key={i}>{i > 0 ? "; " : ""}<b>{c.venueName} ${c.prevPriceDollars} → ${c.newPriceDollars}</b> around {fmtWk(c.changeWeekStart)}</span>)}.</>}
            {outWin > 0 && <> A further {outWin} earlier {outWin === 1 ? "change falls" : "changes fall"} outside these eight weeks.</>}
            {" "}A change is recorded only when the new price holds for two or more matches, so one-off discounts never appear here.
          </p>
          <p className="m-0 text-[13px] leading-[1.6]" style={{ color: C.ink }}>
            {mem && mem.price != null
              ? <>Membership MAX price is <b>${mem.price}</b>{mem.active != null ? <> and <b>{mem.active}</b> {mem.active === 1 ? "member is" : "members are"} active on it</> : ""}.</>
              : "No membership price on record for this city."}
          </p>
        </>
      )}
    </Card>
  );
}

// ── date helpers ─────────────────────────────────────────────────────────────
function wkKeyToDate(key: string): Date | null {
  // weekKey format "YYYY-MM-DD" (Monday). Parse locally.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function wkShort(key: string): string { const d = wkKeyToDate(key); return d ? `${MON[d.getMonth()]} ${d.getDate()}` : key; }
function addDays(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
// mdapi match_start is venue-local wall clock with a fake offset — read its parts as local.
function parseLocalDate(s: string): Date | null {
  const p = s.slice(0, 16).split(/[- T:]/).map(Number);
  if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
  return new Date(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0);
}
