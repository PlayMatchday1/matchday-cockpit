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

import { useEffect, useMemo, useState } from "react";
import { usePhone } from "@/lib/usePhone";
import CancelRanking, { type RankTone } from "@/components/CancelRanking";
import { supabase } from "@/lib/supabase";
import { useMatchWindowData } from "@/lib/useMatchData";
import { getCancelHeatmap, type SlotRow } from "@/lib/cityStats";
import { useWeeklyDemand, type DemandWeek } from "@/lib/slateDemand";
import { fieldCodeMap, fieldCode } from "@/lib/slateFieldCodes";
import { canonicalVenueName } from "@/lib/venueResolver";
import SlateFieldPnL from "@/components/SlateFieldPnL";
import { VISIBLE_CITIES } from "@/lib/types";
import SlateWeekSchedule from "@/components/SlateWeekSchedule";
import { fetchLegacyMatchRegistrations } from "@/lib/mdapiMatchesRead";
import { useFinanceData } from "@/lib/useFinanceData";
import { detectDppPriceShifts, type DppPriceChange, type DppRegistration } from "@/lib/dppPriceHistory";
// LIFTED OUT OF THIS FILE, imported back. Pure move — see src/lib/notes.ts.
import NoteList from "@/components/NoteList";
import { fmtWk, wkKeyToDate, type SlateNote } from "@/lib/notes";
import {
  parseCapture, captureReadout, timeMinutes, CAPTURE_GRAMMAR, type Day,
} from "@/lib/slateCapture";

const C = {
  forestDeep: "#072a20", forest: "#0d3b2e", accent: "#35c77f", mint: "#e0f2e7",
  ink: "#12241d", muted: "#626f68", ok: "#12704a", red: "#c8401f",
  line: "#e6ebe8", hair: "#eff3f1", surface: "#ffffff", canvas: "#eef2ef",
  chipBg: "#eef3f0", chipLine: "#e2eae5", colBg: "#f9fbfa", colLine: "#e0e8e3",
  slotBg: "#f3f7f4", slotLine: "#e2ebe6", gold: "#e3c369", goldInk: "#8a6300",
  nsInk: "#566661",
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
// The 1-of-4 step needs its border: #e7ecea sits too close to the day-cell
// background (--slot-bg #f3f7f4) and the chip would lose its shape without it.
const RAMP: Record<number, { bg: string; fg: string; border?: string }> = {
  1: { bg: "#e7ecea", fg: "#12241d", border: "#d4ded9" },
  2: { bg: "#eda01e", fg: "#12241d" },
  3: { bg: "#8b2c17", fg: "#ffffff" },
  4: { bg: "#d62015", fg: "#ffffff" },
};
const DAYS: Day[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// One decimal for every non-zero value (40.9, 4.0, 3.9); a plain "0" for zero.
const barFmt = (x: number) => (x === 0 ? "0" : x.toFixed(1));

// Phase 26 — the note box PERSISTS (table slate_notes, migration 0119, route /api/slate-notes).
// It is a to-do list: a row sits there until someone takes the action and deletes it.
// The row type, the week chip, the author shortener and the list markup all moved to
// src/lib/notes.ts + src/components/NoteList.tsx so Match Promotion renders the SAME list.

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
}
export default function SlateReviewView() {
  const [city, setCity] = useState<string>("Austin");
  const isPhone = usePhone();
  const [citySheet, setCitySheet] = useState(false);
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
      {/* CITY — chips on a desktop, one button and a sheet on a phone. Seven chips wrap to two
          rows at 390px and the filter you are not changing should cost nothing on screen. Single
          select either way; the semantics are identical. */}
      {isPhone ? (
        <>
          <button type="button" data-testid="slate-city-btn" onClick={() => setCitySheet(true)}
            className="mb-3 flex w-full items-center gap-2 rounded-[10px] border px-3 text-[13.5px] font-bold"
            style={{ borderColor: C.colLine, background: C.surface, color: C.forestDeep, minHeight: 44 }}>
            <span className="min-w-0 flex-1 text-left">{city}</span>
            <span aria-hidden className="flex-none text-[9px]" style={{ color: C.muted }}>▼</span>
          </button>
          {citySheet && (
            <>
              <div data-testid="slate-city-scrim" onClick={() => setCitySheet(false)}
                className="fixed inset-0 z-[60]" style={{ background: "rgba(18,36,29,.42)" }} />
              <div data-testid="slate-city-sheet" role="dialog" aria-label="City"
                className="fixed inset-x-0 bottom-0 z-[61] flex flex-col rounded-t-[16px] bg-white"
                style={{ maxHeight: "82vh", paddingBottom: "env(safe-area-inset-bottom)", boxShadow: "0 -8px 28px rgba(16,40,28,.2)" }}>
                <div className="flex items-center gap-2 border-b px-3.5 pb-2.5 pt-3" style={{ borderColor: C.hair }}>
                  <b className="text-[14px]">City</b>
                  <button type="button" data-testid="slate-city-done" onClick={() => setCitySheet(false)}
                    className="ml-auto rounded-[9px] px-3 text-[12.5px] font-bold text-white"
                    style={{ background: C.forest, minHeight: 34 }}>Done</button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {/* SEVEN, NOT EIGHT — El Paso is in HIDDEN_CITIES and VISIBLE_CITIES is the list
                      the chips already used. Same source, same set. */}
                  {VISIBLE_CITIES.map((c) => (
                    <button key={c} type="button" data-testid="slate-city-item" data-name={c} data-on={c === city ? "1" : "0"}
                      onClick={() => { setCity(c); setCitySheet(false); }}
                      className="flex w-full items-center gap-2.5 border-b px-3.5 text-left text-[13.5px]"
                      style={{ borderColor: C.hair, minHeight: 48, fontWeight: c === city ? 800 : 600, color: c === city ? C.ink : C.forest }}>
                      <span aria-hidden className="flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full border"
                        style={{ borderColor: c === city ? C.forest : "#C6D4CC", background: c === city ? C.forest : "#fff" }}>
                        {c === city && <i className="block h-[7px] w-[7px] rounded-full bg-white" />}
                      </span>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          {/* STACKED. "Slate Review · San Antonio" plus a range does not fit one 350px line, and
              the city is already named on the button above it. */}
          <div className="mb-4">
            <h1 className="m-0 text-[19px] font-bold tracking-[-0.2px]" style={{ color: C.forestDeep }}>Slate Review</h1>
            <span className="mt-0.5 block text-[12px]" style={{ color: C.muted }}>{rangeLabel}</span>
          </div>
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            {VISIBLE_CITIES.map((c) => {
              const on = c === city;
              return (
                <button key={c} type="button" onClick={() => setCity(c)}
                  className="min-h-[30px] rounded-full border px-[14px] py-1.5 text-[13px] font-semibold"
                  style={on ? { background: C.forestDeep, borderColor: C.forestDeep, color: "#fff" } : { background: "#f5f7f6", borderColor: C.colLine, color: C.forest }}>
                  {c}
                </button>
              );
            })}
          </div>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h1 className="m-0 text-[19px] font-bold tracking-[-0.2px]" style={{ color: C.forestDeep }}>Slate Review · {city}</h1>
            <span className="text-[12px]" style={{ color: C.muted }}>{rangeLabel}</span>
          </div>
        </>
      )}

      {/* games per week strip */}
      <Card>
        <SHead title="GAMES PER WEEK · LAST 8 WEEKS" />
        <p className="m-0 mb-3.5 text-[12.5px]" style={{ color: C.muted }}>Total spots booked ÷ 18 · excludes waitlist</p>
        {isPhone ? <GamesBars weekly={weekly} /> : <GamesStrip weekly={weekly} />}
      </Card>

      {/* quick capture (in-memory, in-meeting) — separate tool, kept */}
      <Card>
        <SHead title={`MASTER SCHEDULE · ${city}`} />
        <CaptureBar city={city} fields={fields} weekStart={weekStart} />
      </Card>

      {/* week schedule grid — Slate-Review-only rebuild (mockup). Master Schedule
          page keeps CitiesMasterScheduleLens with its Sync/Changes/Add features. */}
      <SlateWeekSchedule city={city} weekStart={weekStart} onWeekStartChange={setWeekStart} />

      {/* cancel patterns */}
      <CancelCard rows={rows} city={city} fields={fields} />

      {/* match P&L by field */}
      <SlateFieldPnL city={city} />

      {/* prices */}
      <PricesCard city={city} />

      {/* THE "HOW THESE NUMBERS ARE BUILT" CARD IS DELETED, no replacement. Every window it
          described is already stated on the control that sets it. */}
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
                  style={{ height: 96, opacity: 0.55, background: "repeating-linear-gradient(135deg,#c8d4ce 0 5px,#e2e9e6 5px 10px)" }} />
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

/* ── GAMES PER WEEK, TURNED ON ITS SIDE (phone) ───────────────────────────────
 * Eight vertical bars need eight columns, and at 390px that is 31.4px against a "Aug 3" label of
 * 34px, so every label shears — as does "in progress", which renders as in / prog / ress. Rotated,
 * each row has the full width and the label is simply text on a line.
 *
 * ALL THREE STATES SURVIVE THE ROTATION, and that is the point of writing it out rather than
 * reusing the vertical component with a transform. NO DATA IS NOT ZERO: a week with no source rows
 * is hatched, labelled "no data", and excluded from the scale — collapsing it into a 0 would state
 * that the city ran no games in a week nobody measured. */
function GamesBars({ weekly }: { weekly: DemandWeek[] }) {
  const max = Math.max(1, ...weekly.filter((w) => w.hasData).map((w) => w.ratio));
  return (
    <div data-testid="games-bars" className="flex flex-col gap-1.5">
      {weekly.map((w) => {
        const noData = !w.hasData;
        const pct = noData ? 100 : Math.max(2, Math.round((w.ratio / max) * 100));
        return (
          <div key={w.weekStart.toISOString()} data-testid="games-bar" data-nodata={noData ? "1" : "0"}
            className="flex items-center gap-2" style={{ minHeight: 26 }}>
            <span className="flex-none text-[11.5px] font-semibold" style={{ width: 54, color: C.muted }}>{fmtWk(w.weekStart)}</span>
            <span className="min-w-0 flex-1 overflow-hidden rounded-[4px]" style={{ height: 14, background: C.hair }}>
              <span className="block h-full rounded-[4px]" style={{
                width: `${pct}%`,
                opacity: noData ? 0.55 : 1,
                background: noData
                  ? "repeating-linear-gradient(135deg,#c8d4ce 0 5px,#e2e9e6 5px 10px)"
                  : w.isCurrent ? "repeating-linear-gradient(135deg,#35c77f 0 5px,#a6e6c6 5px 10px)" : C.accent,
              }} />
            </span>
            <span className="flex-none text-right text-[12.5px] font-bold tabular-nums"
              style={{ width: 34, color: noData ? C.muted : C.forestDeep }}>{noData ? "–" : barFmt(w.ratio)}</span>
            {(noData || w.isCurrent) && (
              <span className="flex-none whitespace-nowrap text-[10.5px] font-semibold" style={{ color: C.muted }}>
                {noData ? "no data" : "in progress"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── quick capture — PERSISTED (Phase 26) ─────────────────────────────────────
//
// NOTES ARE NOT WEEK-SCOPED: a note stays visible for its city whatever week is selected, tagged
// with the week it was written on, until someone deletes it. PROPOSALS are pinned to their day AND
// their week — a proposed slot means nothing against a different week, so changing week hides it.
// No auto-expiry and no "show more": the list is the to-do list, and it shrinks by being done.
function CaptureBar({ city, fields, weekStart }: { city: string; fields: string[]; weekStart: string }) {
  const isPhone = usePhone();
  const [val, setVal] = useState("");
  const [caps, setCaps] = useState<SlateNote[]>([]);
  const [copy, setCopy] = useState<"" | "ok" | "manual">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load this city's rows. A city change is a different list, not a cleared one.
  useEffect(() => {
    let dead = false;
    setLoading(true); setVal(""); setCopy(""); setErr(null);
    (async () => {
      try {
        const res = await authFetch(`/api/slate-notes?city=${encodeURIComponent(city)}`);
        const j = await res.json().catch(() => ({}));
        if (dead) return;
        if (!res.ok) { setErr(j?.error || `Could not load notes (${res.status})`); setCaps([]); }
        else setCaps((j.notes ?? []) as SlateNote[]);
      } catch (e) { if (!dead) { setErr(e instanceof Error ? e.message : String(e)); setCaps([]); } }
      finally { if (!dead) setLoading(false); }
    })();
    return () => { dead = true; };
  }, [city]);

  const parsed = useMemo(() => parseCapture(val, fields), [val, fields]);
  const readout = captureReadout(parsed);

  // CONFIRM THEN APPEND. The row is rendered only after the insert succeeds and only from the
  // row the SERVER returned — never optimistically. On failure the typed text stays in the box so
  // nothing a person said out loud is lost to a network blip.
  const commit = async () => {
    if (busy) return;
    const raw = val.trim();
    if (!raw) return;
    setBusy(true); setErr(null);
    try {
      const res = await authFetch(`/api/slate-notes`, { method: "POST", body: JSON.stringify({ city, raw, weekStart, fields }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.note) { setErr(j?.error || `Not saved (${res.status}) — your text is still here.`); return; }
      setCaps((cs) => [j.note as SlateNote, ...cs]);
      setVal(""); setCopy("");
    } catch (e) {
      setErr(`${e instanceof Error ? e.message : String(e)} — your text is still here.`);
    } finally { setBusy(false); }
  };

  // HARD delete — it is gone, here and in the table. The row leaves the list only after the
  // server confirms, for the same reason the add waits.
  const drop = async (id: string) => {
    setErr(null);
    try {
      const res = await authFetch(`/api/slate-notes?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j?.error || `Could not delete (${res.status})`); return; }
      setCaps((cs) => cs.filter((c) => c.id !== id));
      setCopy("");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  // What is ON SCREEN for the selected week: every note for the city + only this week's proposals.
  const visible = useMemo(
    () => caps.filter((c) => c.kind === "note" || c.weekStart === weekStart),
    [caps, weekStart],
  );

  const capText = () => {
    const slots = visible.filter((c) => c.kind === "proposal");
    const notes = visible.filter((c) => c.kind !== "proposal");
    const L = [`${city} · week of ${weekStart} · slate review`];
    if (slots.length) { L.push("", "Proposed slots"); slots.forEach((c) => L.push(`- ${c.day} ${c.timeTxt} · ${c.fieldTxt}   (typed: "${c.raw}")`)); }
    if (notes.length) { L.push("", "Notes"); notes.forEach((c) => L.push(`- ${c.raw}${c.weekStart !== weekStart ? `   (week of ${c.weekStart})` : ""}`)); }
    return L.join("\n");
  };
  const copyAll = async () => {
    const t = capText();
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); setCopy("ok"); }
      else setCopy("manual");
    } catch { setCopy("manual"); }
  };

  const props = visible.filter((c) => c.kind === "proposal").slice().sort((a, b) => (a.timeMin ?? 0) - (b.timeMin ?? 0));

  return (
    <div>
      <p className="m-0 mb-2.5 text-[12.5px]" style={{ color: C.muted }}>
        Talk through the week live: what you type becomes a dashed proposal on the day below, or is kept as a note. Everything here is saved and shared — it stays until someone deletes it.
      </p>
      <div className="flex items-stretch gap-2">
        <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commit(); } if (e.key === "Escape") setVal(""); }}
          autoComplete="off" spellCheck={false} aria-label="Add a slot or a note" data-testid="slate-note-input"
          placeholder="Add 8PM thurs Crossbar — or just type a note"
          className="h-[34px] min-w-0 flex-1 rounded-[10px] border px-[11px] text-[13px]" style={{ borderColor: C.colLine, background: C.surface }} />
        <button type="button" onClick={() => void commit()} disabled={busy} data-testid="slate-note-add"
          className="h-[34px] flex-none rounded-[10px] px-4 text-[12px] font-bold text-white disabled:opacity-60" style={{ background: C.forest }}>{busy ? "Saving…" : "Add"}</button>
      </div>
      {err && <div data-testid="slate-note-error" className="mt-1.5 rounded-[8px] border px-2.5 py-1.5 text-[11.5px] font-semibold" style={{ background: "#fdeeea", borderColor: "#f2c4b8", color: C.red, overflowWrap: "anywhere" }}>{err}</div>}
      <div className="min-h-[32px] px-0.5 py-1.5 text-[11.5px] leading-[1.35]" style={{ color: C.muted }}>{readout || <span style={{ color: C.muted }}>{CAPTURE_GRAMMAR}</span>}</div>

      {/* PROPOSALS. On a phone the seven-column strip gives each day 38px, and the chip inside it
          carries `overflowWrap:anywhere` — which is why it rendered ONE CHARACTER PER LINE instead
          of overflowing. Without that property the layout would have broken visibly and been
          reported on day one; with it, it fits the screen perfectly and says nothing.

          THE DAY IS WRITTEN IN WORDS. The strip encoded the day by POSITION, so a list that simply
          drops the column loses information the grid was carrying. */}
      {isPhone && props.length > 0 && (
        <div className="mb-1 flex flex-col gap-1.5" data-testid="proposal-list">
          {DAYS.flatMap((ab) => props.filter((p) => p.day === ab).map((p) => (
            <div key={p.id} data-testid="slate-proposal" data-day={p.day}
              className="flex items-center gap-2 rounded-[10px] border border-dashed px-2.5 py-1.5"
              style={{ borderColor: C.gold, background: "#fffdf6", minHeight: 44 }}>
              <span className="flex-none text-[12px] font-extrabold" style={{ color: C.goldInk, width: 30 }}>{ab}</span>
              <span className="flex-none text-[12px] font-bold tabular-nums" style={{ color: C.goldInk }}>{p.timeTxt}</span>
              <span className="min-w-0 flex-1 text-[12px]" style={{ color: "#77673c", overflowWrap: "break-word", lineHeight: 1.3 }}>{p.fieldTxt}</span>
              <span className="flex-none rounded-[4px] border px-1 text-[9px] font-bold"
                style={{ background: "#fdf3d9", borderColor: C.gold, color: C.goldInk }}>NEW</span>
            </div>
          )))}
        </div>
      )}
      {!isPhone && props.length > 0 && (
        <div className="mb-1 grid grid-cols-7 gap-2">
          {DAYS.map((ab) => {
            const here = props.filter((p) => p.day === ab); // `props` is already sorted by timeMin
            return (
              <div key={ab} className="rounded-[10px] border p-1.5" style={{ borderColor: C.colLine, background: C.colBg, minHeight: 44 }}>
                <div className="mb-1 text-[9.5px] font-bold uppercase tracking-[0.09em]" style={{ color: C.muted }}>{ab}</div>
                {here.map((p) => (
                  <div key={p.id} data-testid="slate-proposal" data-day={p.day} className="mb-1 flex items-start gap-1.5 rounded-[8px] border border-dashed p-[5px_6px]" style={{ borderColor: C.gold }}>
                    <span className="min-w-0 flex-1" style={{ overflowWrap: "anywhere" }}>
                      <span className="block text-[11px] font-bold" style={{ color: C.goldInk }}>{p.timeTxt}</span>
                      <span className="block text-[10px]" style={{ color: "#77673c" }}>{p.fieldTxt}</span>
                    </span>
                    <span className="flex-none rounded-[4px] border px-1 text-[9px] font-bold" style={{ background: "#fdf3d9", borderColor: C.gold, color: C.goldInk }}>NEW</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* the list — a to-do list, not a meeting transcript */}
      {loading ? (
        <div className="mt-3 border-t pt-2.5 text-[11.5px]" style={{ borderColor: C.line, color: C.muted }}>Loading notes…</div>
      ) : visible.length > 0 && (
        <div className="mt-3 border-t pt-2.5" style={{ borderColor: C.line }}>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.8px]" style={{ color: C.muted }}>Open · {visible.length}</span>
            <span className="flex items-center gap-2">
              {copy === "ok" && <span className="text-[11px] font-bold" style={{ color: C.ok }}>Copied.</span>}
              <button type="button" onClick={copyAll} className="h-[28px] flex-none rounded-[8px] border px-3 text-[11px] font-bold" style={{ background: C.chipBg, borderColor: C.chipLine, color: C.forestDeep }}>Copy all</button>
            </span>
          </div>
          <NoteList notes={visible} onDelete={(id) => void drop(id)} />
          {copy === "manual" && (
            <textarea readOnly onClick={(e) => (e.target as HTMLTextAreaElement).select()} value={capText()} className="mt-2 h-[104px] w-full rounded-[8px] border p-2 text-[11.5px]" style={{ borderColor: C.colLine }} />
          )}
        </div>
      )}
    </div>
  );
}

// ── cancel patterns (Patterns view only; Numbers view removed) ────────────────
function CancelCard({ rows, city, fields }: { rows: Parameters<typeof getCancelHeatmap>[0]; city: string; fields: string[] }) {
  // Single source of chip labels — the curated hand-chosen shorthand, shared by
  // the Patterns view and the footer key. NOT title initials.
  const codes = useMemo(() => fieldCodeMap(fields), [fields]);
  // Cancelled-only heatmap over the last 4 completed weeks (Patterns' window).
  const hmCx = useMemo(() => getCancelHeatmap(rows, city, 8, new Date(), { includeAllSlots: false }), [rows, city]);

  return (
    <Card>
      <SHead title="CANCEL PATTERNS" />
      <Patterns hm={hmCx} codes={codes} city={city} />
    </Card>
  );
}
// last 4 fully-completed weeks (drop the current partial = last week key)
function completedWeeks(weeks: string[]): string[] {
  const done = weeks.slice(0, weeks.length - 1); // drop current
  return done.slice(-4);
}

/* SLOT → RANKED ROW. One row per slot, sorted by CancelRanking (most chronic first, then by spots
 * booked descending: a slot dying with 30 people on it is a bigger problem than one dying empty).
 * `booked` is the spots on the weeks it actually cancelled — the size of the problem, not a total
 * across weeks it ran fine. */
function PatternsRanking({ hm, wks, cxCount, city }: {
  hm: { weeks: string[]; slots: SlotRow[] }; wks: string[]; cxCount: (s: SlotRow) => number; city: string;
}) {
  const slots = hm.slots
    .map((s) => {
      const n = cxCount(s);
      const booked = wks.reduce((a, w) => a + (s.weeks[w]?.cancelled ? (s.weeks[w]?.spots ?? 0) : 0), 0);
      return { key: `${s.field}|${s.time}`, name: s.field, when: `${s.dow} ${s.time}`, booked, city, n };
    })
    .filter((x) => x.n > 0);
  return (
    <CancelRanking slots={slots} outOf={wks.length} ramp={RAMP as Record<number, RankTone>}
      collapseOnes wrapName
      emptyText="No slot cancelled in these four weeks." />
  );
}

function Patterns({ hm, codes, city }: { hm: { weeks: string[]; slots: SlotRow[] }; codes: Record<string, string>; city: string }) {
  const isPhone = usePhone();
  const wks = completedWeeks(hm.weeks); // oldest→newest among the 4
  const order = [...wks].reverse(); // most recent first
  // cancelCount per slot over the 4 completed weeks
  const cxCount = (s: SlotRow) => wks.reduce((a, w) => a + (s.weeks[w]?.cancelled ? 1 : 0), 0);
  const fieldsWithChip = new Set<string>();
  let totalCx = 0;
  for (const s of hm.slots) for (const w of wks) if (s.weeks[w]?.cancelled) { totalCx++; fieldsWithChip.add(s.field); }
  // THE COLLAPSE, STATED: 49 cancellations are 15 slots, and that difference is the argument.
  const rankedCount = hm.slots.filter((s) => cxCount(s) > 0).length;
  const stepsPresent = [4, 3, 2, 1].filter((n) => hm.slots.some((s) => cxCount(s) === n && wks.some((w) => s.weeks[w]?.cancelled)));
  const first = wkKeyToDate(wks[0]); const last = wkKeyToDate(wks[wks.length - 1]);

  return (
    <>
      {/* THE LEDE DESCRIBES WHAT IS ACTUALLY ON SCREEN. The desktop sentence talks about chips,
          blank days and a week-by-week grid; none of those exist in the ranking, so repeating it
          on a phone would describe a layout that is not there. Same window, same figures — the
          collapse from cancellations to slots is the thing the phone version has to say, because
          it is the difference between the two counts. */}
      {isPhone ? (
        <p className="m-0 mb-3 text-[12.5px]" style={{ color: C.muted }} data-testid="patterns-lede">
          The last {wks.length} fully completed weeks — {first ? fmtWk(first) : ""} to {last ? fmtWk(addDays(last, 6)) : ""}, {totalCx} {totalCx === 1 ? "cancellation" : "cancellations"} across {rankedCount} {rankedCount === 1 ? "slot" : "slots"}. Worst first: how many of the {wks.length} weeks the slot died, then how many people were on it. A slot that died once is not a pattern, so those sit behind the button at the end.
        </p>
      ) : (
        <p className="m-0 mb-3.5 text-[12.5px]" style={{ color: C.muted }} data-testid="patterns-lede">
          Every cancelled match, week by week, over the last {wks.length} fully completed weeks — {first ? fmtWk(first) : ""} to {last ? fmtWk(addDays(last, 6)) : ""}, {totalCx} {totalCx === 1 ? "cancellation" : "cancellations"}. Darker means the same slot cancelled in more of those weeks; the count is printed on every chip too. A blank day had none. Each chip reads field, time, and spots already booked.
        </p>
      )}
      {/* ── ON A PHONE, A RANKING ──────────────────────────────────────────────────────────────
          The seven-column grid gives each day 39.7px (page px-5 → 350, card padding → 314,
          six 6px gaps → 278, ÷ 7), and the chip inside carries overflowWrap:anywhere — which is
          why it rendered ONE CHARACTER PER LINE. The grid answers "when does this city struggle";
          the ranking answers "which slot is dying", which is the question a phone is for.

          THE COLLAPSE IS THE ARGUMENT: every cancellation in the grid is a cell, but the same slot
          dying four weeks running is ONE problem, and here it is one row. */}
      {isPhone ? (
        <PatternsRanking hm={hm} wks={wks} cxCount={cxCount} city={city} />
      ) : order.map((wk, bi) => {
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
      {/* STEP LEGEND — only steps ACTUALLY RENDERED, most-chronic first. On a phone the 1-of-4s sit
          behind a button, so while they are collapsed there is no 1-of-4 swatch on screen and the
          legend must not define one: a legend for an invisible colour is the same defect as an
          unexplained mark. All four steps stay defined in RAMP regardless. */}
      <div className="mt-3 flex flex-wrap gap-[5px_14px] text-[11px]" data-testid="patterns-legend" style={{ color: C.muted }}>
        {(isPhone ? stepsPresent.filter((n) => n > 1) : stepsPresent).map((n) => (
          <span key={n} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <i className="inline-block h-[11px] w-[11px] flex-none rounded-[3px]" style={{ background: RAMP[n].bg, border: RAMP[n].border ? `1px solid ${RAMP[n].border}` : undefined }} />
            {n} of {wks.length} {wks.length === 1 ? "week" : "weeks"}
          </span>
        ))}
      </div>
      {/* FIELD-CODE KEY — DESKTOP ONLY. The grid needs it because its chips carry only "OC"; every
          row of the phone ranking carries the whole field name, so a key there would define codes
          that appear nowhere on screen (one entry reads "NEMP NEMP"). fieldCodeMap still resolves
          the names either way — it is the KEY that goes, not the mapping. */}
      {!isPhone && fieldsWithChip.size > 0 && (
        <p className="mt-1.5 text-[11px]" style={{ color: C.muted }}>
          {[...fieldsWithChip].sort((a, b) => (codes[a] ?? a).localeCompare(codes[b] ?? b)).map((f, i) => <span key={f}>{i > 0 ? " · " : ""}<b style={{ color: C.forestDeep }}>{codes[f] ?? f}</b> {f}</span>)}
        </p>
      )}
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
          // Label from the SAME shared source as Cancel Patterns + the footer
          // key: normField(field_title) → fieldCode. Shows codes (HT, RR, OC…),
          // so this card matches the chips instead of mixing raw venue names.
          dppRegs.push({ matchStart: ms, venueId: vid, venueName: fieldCode(canonicalVenueName(r.field)), city: v.city, amountDollars: Number(r.match_price_paid ?? 0) });
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

  // Group consecutive changes for the same field so a reversal is legible: a
  // field that moves and moves back nets to zero across the window. Chronological
  // within each field.
  const groups = useMemo(() => {
    const m = new Map<string, DppPriceChange[]>();
    for (const c of inWin) { const a = m.get(c.venueName) ?? []; a.push(c); m.set(c.venueName, a); }
    return [...m.entries()].map(([code, arr]) => {
      const sorted = arr.slice().sort((a, b) => a.changeWeekStart.getTime() - b.changeWeekStart.getTime());
      const netZero = sorted.length > 1 && sorted[0].prevPriceDollars === sorted[sorted.length - 1].newPriceDollars;
      return { code, sorted, netZero };
    }).sort((a, b) => a.code.localeCompare(b.code));
  }, [inWin]);

  return (
    <Card>
      <SHead title="PRICE CHANGES" />
      {dpp === null ? (
        <p className="m-0 text-[12.5px]" style={{ color: C.muted }}>Loading price history…</p>
      ) : (
        <>
          {/* ── A TABLE, AT EVERY WIDTH ─────────────────────────────────────────────────────────
              This was a paragraph running "$12 → $15 around Aug 10, then → $13 around Aug 24"
              inline, per field, semicolon-separated. That is not easier to read at 1440px, just
              wider — so the table is not a phone variant, it is the section.

              THE ARROW IS THE COLUMN ORDER. From and To are adjacent, so a glyph between them
              would restate the layout; the colour carries the direction.

              NET ZERO IS A PROPERTY OF THE FIELD, NOT OF A ROW. detectDppPriceShifts marks a field
              that ended where it started after two or more moves; tagging a ROW would mean writing
              a row whose From equals its To, and a price that did not change is not a price
              change. */}
          {inWin.length === 0 ? (
            <p className="m-0 mb-2 text-[13px] leading-[1.6]" style={{ color: C.ink }}>DPP price did not change in this 8-week window.</p>
          ) : (
            <div className="mb-2 overflow-hidden rounded-[10px] border" style={{ borderColor: C.line }} data-testid="price-table">
              <div className="grid items-center gap-2 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.06em]"
                style={{ gridTemplateColumns: "1fr auto 52px 52px", background: C.colBg, color: C.muted, borderBottom: `1px solid ${C.line}` }}>
                <span>Field</span><span>Week</span><span className="text-right">From</span><span className="text-right">To</span>
              </div>
              {groups.map((g) => g.sorted.map((c, i) => {
                const up = c.newPriceDollars > c.prevPriceDollars;
                return (
                  <div key={`${g.code}-${i}`} data-testid="price-row" data-field={g.code}
                    data-from={c.prevPriceDollars} data-to={c.newPriceDollars}
                    className="grid items-center gap-2 border-b px-2.5 py-2 text-[12.5px] last:border-b-0"
                    style={{ gridTemplateColumns: "1fr auto 52px 52px", borderColor: C.hair }}>
                    {/* A RUN OF CHANGES ON ONE FIELD IS CONSECUTIVE ROWS, and only the first
                        prints the name — repeating it would read as four different fields. */}
                    <span className="min-w-0" style={{ overflowWrap: "break-word", lineHeight: 1.3 }}>
                      {i === 0 ? <b style={{ color: C.forestDeep }}>{g.code}</b> : <span aria-hidden style={{ color: C.line }}>&mdash;</span>}
                      {i === 0 && g.netZero && (
                        <em data-testid="price-netzero" className="ml-1.5 rounded-[4px] border px-1 text-[9.5px] font-bold not-italic"
                          style={{ background: C.chipBg, borderColor: C.chipLine, color: C.muted }}>net zero</em>
                      )}
                    </span>
                    <span className="whitespace-nowrap text-[11.5px]" style={{ color: C.muted }}>{fmtWk(c.changeWeekStart)}</span>
                    <span className="text-right tabular-nums" style={{ color: C.muted }}>${c.prevPriceDollars}</span>
                    <span className="text-right font-bold tabular-nums" style={{ color: up ? C.ok : C.red }}>${c.newPriceDollars}</span>
                  </div>
                );
              }))}
            </div>
          )}
          {/* EVERYTHING THE PROSE STATED SURVIVES — the out-of-window count and the
              two-or-more-matches rule are facts about the table, so they sit under it. */}
          <p className="m-0 mb-2 text-[12px] leading-[1.55]" style={{ color: C.muted }} data-testid="price-caveats">
            {inWin.length > 0 && <>DPP price moved {inWin.length} {inWin.length === 1 ? "time" : "times"} inside this window{groups.some((g) => g.netZero) ? "; a field tagged net zero ended where it started" : ""}.{" "}</>}
            {outWin > 0 && <>{outWin === 1 ? "One earlier change falls" : `A further ${outWin} earlier changes fall`} outside these eight weeks.{" "}</>}
            A change is recorded only when the new price holds for two or more matches, so one-off discounts never appear here.
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
function addDays(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
// mdapi match_start is venue-local wall clock with a fake offset — read its parts as local.
function parseLocalDate(s: string): Date | null {
  const p = s.slice(0, 16).split(/[- T:]/).map(Number);
  if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
  return new Date(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0);
}
