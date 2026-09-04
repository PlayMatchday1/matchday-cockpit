"use client";

// Slate Review — Week Schedule grid (mockup: docs/mockups/slate-review-week-schedule.html).
//
// A SLATE-REVIEW-ONLY view. It does NOT touch CitiesMasterScheduleLens, which
// still powers /match-ops/master-schedule with its Schedule Sync card,
// Changes-vs-last-week banner and Add-session button. This is a separate,
// mdapi-driven component (total isolation) rather than a prop fork of that
// 2,363-line schedule_master-driven lens.
//
// Every number is read straight from mdapi via the paginated selectAll helper
// (an unpaginated select caps at 1000 rows and silently truncates). Booked
// figures are REAL: mdapi_match_players with user_is_fake_player = false AND
// canceled_at IS NULL AND paid_status <> 'WAITING' — never mdapi_matches.
// player_count, which is fake-inflated (16678 reports 16, real is 11).
// Cancellation is mdapi_matches.is_cancelled and nothing else. Absents count.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { selectAll } from "@/lib/supabasePagination";
import { canonicalVenueName } from "@/lib/venueResolver";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";
import { usePhone } from "@/lib/usePhone";

const CODE_BY_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(CITY_CODE_TO_DISPLAY).map(([code, display]) => [display, code]),
);

const IN_CHUNK = 200;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type SlotState = "ran" | "cx" | "upcoming" | "flag";
type Slot = {
  key: string;
  time: string;      // "6:30 PM"
  minutes: number;   // for sort
  field: string;     // raw field_title (display)
  state: SlotState;
  booked: number | null;
  cap: number | null;
};
type DayCol = { dow: (typeof ORDER)[number]; num: string; today: boolean; slots: Slot[] };
type ChangeRow = { dow: string; num: string; time: string; field: string };
type WeekData = {
  days: DayCol[];
  dropped: ChangeRow[];
  cancelled: ChangeRow[];
  counts: { slots: number; ran: number; upcoming: number; cancelled: number; dropped: number };
  rawRows: { matches: number; players: number };
  loading: boolean;
};

// mdapi start_date is venue-local wall-clock stamped at +00:00 — read the parts
// as local, ignoring the offset.
const local = (s: string) => new Date(s.replace(/([+-]\d\d:\d\d|Z)$/, ""));
function fmtTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

type MatchRow = { api_id: number; start_date: string; is_cancelled: boolean | null; field_title: string | null; max_player_count: number | null };
type PlayerRow = { match_api_id: number; user_is_fake_player: boolean | null; canceled_at: string | null; paid_status: string | null };

function useSlateWeek(city: string, weekStart: string): WeekData {
  const [data, setData] = useState<WeekData>({
    days: [], dropped: [], cancelled: [],
    counts: { slots: 0, ran: 0, upcoming: 0, cancelled: 0, dropped: 0 },
    rawRows: { matches: 0, players: 0 }, loading: true,
  });

  const load = useCallback(async () => {
    setData((d) => ({ ...d, loading: true }));
    try {
      const code = CODE_BY_DISPLAY[city] ?? city;
      const thisMon = isoToDate(weekStart);
      const prevMon = addDays(thisMon, -7);
      const thisSun = addDays(thisMon, 6);
      const ymd = (d: Date, end = false) => `${isoOf(d)}T${end ? "23:59:59" : "00:00:00"}`;

      // Matches for this week AND last week (last week needed for "dropped").
      const matches = await selectAll<MatchRow>(() =>
        supabase.from("mdapi_matches")
          .select("api_id, start_date, is_cancelled, field_title, max_player_count")
          .eq("city_identifier", code).is("deleted_at", null)
          .gte("start_date", ymd(prevMon)).lte("start_date", ymd(thisSun, true))
          .order("api_id"),
      );

      // Real booked counts, chunked + paginated. fake=false, held seat, not waitlist.
      const ids = matches.map((m) => m.api_id);
      const booked = new Map<number, number>();
      let playerRowCount = 0;
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const batch = ids.slice(i, i + IN_CHUNK);
        const players = await selectAll<PlayerRow>(() =>
          supabase.from("mdapi_match_players")
            .select("match_api_id, user_is_fake_player, canceled_at, paid_status")
            .in("match_api_id", batch).is("deleted_at", null).order("api_id"),
        );
        playerRowCount += players.length;
        for (const p of players) {
          if (p.user_is_fake_player) continue;
          if (p.canceled_at) continue;
          if (p.paid_status === "WAITING") continue;
          booked.set(p.match_api_id, (booked.get(p.match_api_id) ?? 0) + 1);
        }
      }

      // Planned-but-not-on-MatchDay slots for this week (city-filtered).
      const flagsByDow = new Map<string, { time: string; minutes: number; field: string }[]>();
      try {
        const res = await fetch(`/api/schedule-master?week_start=${weekStart}`, { cache: "no-store" });
        if (res.ok) {
          const payload = await res.json();
          const cityOut = (payload?.cities ?? []).find((c: { name: string }) => c.name === city);
          for (const day of cityOut?.days ?? []) {
            for (const m of day.matches ?? []) {
              if (m.in_matchday === false) {
                const arr = flagsByDow.get(day.day_of_week) ?? [];
                arr.push({ time: m.time, minutes: minutesOf(m.time), field: m.venue });
                flagsByDow.set(day.day_of_week, arr);
              }
            }
          }
        }
      } catch { /* flags are additive; grid renders without them */ }

      const now = new Date();
      const thisWeek = matches.filter((m) => {
        const d = local(m.start_date);
        return d >= thisMon && d <= new Date(thisSun.getFullYear(), thisSun.getMonth(), thisSun.getDate(), 23, 59, 59);
      });

      // Build day columns.
      const todayIso = isoOf(now);
      const days: DayCol[] = ORDER.map((dow, i) => {
        const dayDate = addDays(thisMon, i);
        return { dow, num: String(dayDate.getDate()).padStart(2, "0"), today: isoOf(dayDate) === todayIso, slots: [] };
      });
      const dayByDow = new Map(days.map((d) => [d.dow, d]));

      let ran = 0, upcoming = 0, cancelled = 0;
      for (const m of thisWeek) {
        const d = local(m.start_date);
        const dow = DOW[d.getDay()];
        const col = dayByDow.get(dow as (typeof ORDER)[number]);
        if (!col) continue;
        let state: SlotState;
        if (m.is_cancelled) { state = "cx"; cancelled++; }
        else if (d < now) { state = "ran"; ran++; }
        else { state = "upcoming"; upcoming++; }
        col.slots.push({
          key: `${m.api_id}`,
          time: fmtTime(d), minutes: d.getHours() * 60 + d.getMinutes(),
          field: m.field_title ?? "—",
          state,
          booked: booked.get(m.api_id) ?? (state === "cx" || state === "ran" ? 0 : null),
          cap: m.max_player_count,
        });
      }
      // Flag cells (planned, not on MatchDay) — additive, not counted in `slots`.
      for (const [dow, arr] of flagsByDow) {
        const col = dayByDow.get(dow as (typeof ORDER)[number]);
        if (!col) continue;
        for (const f of arr) col.slots.push({ key: `flag-${dow}-${f.time}-${f.field}`, time: f.time, minutes: f.minutes, field: f.field, state: "flag", booked: null, cap: null });
      }
      for (const col of days) col.slots.sort((a, b) => a.minutes - b.minutes || a.field.localeCompare(b.field));

      // Dropped: (dow, normField(field), time) that ran last week and has NO slot
      // (any state) at that key this week. Same 3-part key Cancel Patterns uses.
      const keyOf = (m: MatchRow) => {
        const d = local(m.start_date);
        return `${DOW[d.getDay()]}|${canonicalVenueName(m.field_title ?? "")}|${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
      };
      const thisKeys = new Set(thisWeek.map(keyOf));
      const lastWeek = matches.filter((m) => { const d = local(m.start_date); return d >= prevMon && d < thisMon; });
      const dropped: ChangeRow[] = [];
      const seenDrop = new Set<string>();
      for (const m of lastWeek) {
        if (m.is_cancelled) continue;
        const k = keyOf(m);
        if (thisKeys.has(k) || seenDrop.has(k)) continue;
        seenDrop.add(k);
        const d = local(m.start_date);
        dropped.push({ dow: DOW[d.getDay()], num: String(d.getDate()).padStart(2, "0"), time: fmtTime(d), field: m.field_title ?? "—" });
      }
      dropped.sort((a, b) => ORDER.indexOf(a.dow as (typeof ORDER)[number]) - ORDER.indexOf(b.dow as (typeof ORDER)[number]) || minutesOf(a.time) - minutesOf(b.time));

      // Cancelled-this-week rows for the Changes section.
      const cancelledRows: ChangeRow[] = thisWeek.filter((m) => m.is_cancelled).map((m) => {
        const d = local(m.start_date);
        return { dow: DOW[d.getDay()], num: String(d.getDate()).padStart(2, "0"), time: fmtTime(d), field: m.field_title ?? "—" };
      }).sort((a, b) => ORDER.indexOf(a.dow as (typeof ORDER)[number]) - ORDER.indexOf(b.dow as (typeof ORDER)[number]) || minutesOf(a.time) - minutesOf(b.time));

      const slots = ran + upcoming + cancelled;
      // Assertion (Part 5): slots must equal ran + cancelled + upcoming.
      if (slots !== ran + cancelled + upcoming) {
        // eslint-disable-next-line no-console
        console.error(`[SlateWeekSchedule] breakdown assertion failed: ${slots} != ${ran}+${cancelled}+${upcoming}`);
      }

      setData({
        days, dropped, cancelled: cancelledRows,
        counts: { slots, ran, upcoming, cancelled, dropped: dropped.length },
        rawRows: { matches: matches.length, players: playerRowCount }, loading: false,
      });
    } catch {
      setData((d) => ({ ...d, loading: false }));
    }
  }, [city, weekStart]);

  useEffect(() => { void load(); }, [load]);
  return data;
}

function minutesOf(t: string): number {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(t);
  if (!m) return 0;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export default function SlateWeekSchedule({
  city, weekStart, onWeekStartChange,
}: { city: string; weekStart: string; onWeekStartChange: (next: string) => void }) {
  const isPhone = usePhone();
  const [showCx, setShowCx] = useState(false);
  const wk = useSlateWeek(city, weekStart);

  const thisMon = useMemo(() => isoToDate(weekStart), [weekStart]);
  const thisSun = useMemo(() => addDays(thisMon, 6), [thisMon]);
  const rangeLabel = `${MON[thisMon.getMonth()]} ${thisMon.getDate()} – ${MON[thisSun.getMonth()]} ${thisSun.getDate()}`;
  const shift = (n: number) => onWeekStartChange(isoOf(addDays(thisMon, n)));
  const goToday = () => {
    const d = new Date(); const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day;
    onWeekStartChange(isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff)));
  };

  const c = wk.counts;

  return (
    <>
      <style>{CSS}</style>
      <div className="ms-card">
        <div className="ms-head">
          <div>
            <p className="ms-eyebrow">Week schedule</p>
            <h2 className="ms-city">{city}</h2>
            <p className="ms-sub">Completed days show what actually ran on MatchDay. Upcoming days show the plan.</p>
            <div className="ms-navrow">
              <button type="button" className="ms-nav" aria-label="Previous week" onClick={() => shift(-7)}>&#8249;</button>
              <span className="ms-week">{rangeLabel}</span>
              <button type="button" className="ms-nav" aria-label="Next week" onClick={() => shift(7)}>&#8250;</button>
              <button type="button" className="ms-today-btn" onClick={goToday}>Today</button>
            </div>
          </div>
          {/* header breakdown replaces the old "N MATCHES" chip */}
          <div className="ms-counts">
            <Count n={c.slots} l={plural(c.slots, "slot", "slots")} />
            <Count n={c.ran} l="ran" />
            <Count n={c.upcoming} l="upcoming" />
            <Count n={c.cancelled} l="cancelled" cx />
            <Count n={c.dropped} l="dropped" cx />
          </div>
        </div>

        <div className="ms-toolbar">
          <label className="ms-toggle">
            <input type="checkbox" checked={showCx} onChange={(e) => setShowCx(e.target.checked)} />
            <span className="ms-track"><span className="ms-knob" /></span>
            <span>Show cancelled in grid</span>
          </label>
        </div>

        {wk.loading && wk.days.length === 0 ? (
          <div className="ms-empty">Loading schedule…</div>
        ) : (
          isPhone ? (
          /* ── DAY SECTIONS ON A PHONE ────────────────────────────────────────────────────────
             SAME SHAPE AS THE MASTER SCHEDULE'S MOBILE AGENDA, deliberately: these are the two
             views a manager moves between, and they must not give two different answers to "what
             is a day on a phone".

             THIS REPLACES the minmax(132px,1fr) horizontal scroll below. That rule was a correct
             fix for the shear — the grid fitted the screen and said nothing legible — but it is
             superseded rather than reverted: the seven columns are gone on a phone, so there is no
             scrolling row left for a day header to desync from. */
          <div className="ms-agenda" data-testid="ms-agenda">
            {wk.days.map((day) => {
              const slots = day.slots.filter((s) => s.state !== "cx" || showCx);
              const hiddenCx = showCx ? 0 : day.slots.filter((s) => s.state === "cx").length;
              // ONLY DAYS WITH SOMETHING ON THEM get a section — seven empty headers to scroll
              // past is the same defect pointing the other way.
              if (slots.length === 0 && hiddenCx === 0) return null;
              return (
                <div key={day.dow}>
                  <div className={"ms-agday" + (day.today ? " is-today" : "")} data-testid="ms-agday" data-dow={day.dow}>
                    <b>{day.dow} {day.num}</b>
                    {day.today && <span className="ms-todaychip">Today</span>}
                    <span className="ms-agn">
                      {slots.length} match{slots.length === 1 ? "" : "es"}
                      {hiddenCx > 0 && ` \u00b7 ${hiddenCx} cancelled hidden`}
                    </span>
                  </div>
                  {slots.map((s) => <AgendaRow key={s.key} s={s} />)}
                </div>
              );
            })}
          </div>
          ) : (
          <div className="ms-grid">
            {wk.days.map((day) => (
              <div key={day.dow} className={"ms-col" + (day.today ? " is-today" : "")}>
                <div className="ms-colhead">
                  <span className="ms-dow">{day.dow}{day.today && <span className="ms-todaychip">Today</span>}</span>
                  <span className="ms-dnum">{day.num}</span>
                </div>
                <div className="ms-stack">
                  {day.slots.filter((s) => s.state !== "cx" || showCx).map((s) => <Cell key={s.key} s={s} />)}
                </div>
              </div>
            ))}
          </div>
          )
        )}

        <div className="ms-legend">
          <span className="ms-leg"><span className="ms-swatch" />Ran</span>
          <span className="ms-leg"><span className="ms-swatch sw-planned" />Upcoming</span>
          <span className="ms-leg"><span className="ms-swatch sw-flag" />Not yet on MatchDay</span>
          <span className="ms-leg"><span className="ms-swatch sw-cx" />Cancelled</span>
          <span className="ms-leg"><span className="ms-swatch sw-today" />Today</span>
        </div>
      </div>

      {/* Changes from last week */}
      <div className="ms-card">
        <h2 className="ms-chg-title">Changes from last week</h2>
        <p className="ms-chg-sub">Everything on the schedule that did not play as planned. Kept out of the grid above so the grid only ever answers one question: what ran, and what is coming.</p>

        <div className="ms-grp">
          <div className="ms-grp-head">
            <span className="ms-grp-name">Dropped</span>
            <span className="ms-grp-n">{wk.dropped.length}</span>
          </div>
          <p className="ms-grp-note">Ran last week, never made it onto this week&rsquo;s schedule.</p>
          {wk.dropped.length ? (
            <div className="ms-rows">
              {wk.dropped.map((r, i) => (
                <div key={i} className="ms-row is-drop">
                  <span className="ms-row-day">{r.dow} {r.num}</span>
                  <span className="ms-row-time">{r.time}</span>
                  <span className="ms-row-field">{r.field}</span>
                  <span className="ms-row-tag">Dropped</span>
                </div>
              ))}
            </div>
          ) : <p className="ms-grp-empty">Nothing dropped — every slot that ran last week is on this week&rsquo;s schedule.</p>}
        </div>

        <div className="ms-grp" style={{ marginBottom: 0 }}>
          <div className="ms-grp-head">
            <span className="ms-grp-name">Cancelled this week</span>
            <span className="ms-grp-n is-cx">{wk.cancelled.length}</span>
          </div>
          <p className="ms-grp-note">Made it onto this week&rsquo;s schedule, then cancelled.</p>
          {wk.cancelled.length ? (
            <div className="ms-rows is-split" style={{ gridTemplateRows: `repeat(${Math.ceil(wk.cancelled.length / 2)}, auto)` }}>
              {wk.cancelled.map((r, i) => (
                <div key={i} className="ms-row">
                  <span className="ms-row-day">{r.dow} {r.num}</span>
                  <span className="ms-row-time">{r.time}</span>
                  <span className="ms-row-field">{r.field}</span>
                </div>
              ))}
            </div>
          ) : <p className="ms-grp-empty">No match on this week&rsquo;s schedule was cancelled.</p>}
        </div>
      </div>
    </>
  );
}

function Count({ n, l, cx }: { n: number; l: string; cx?: boolean }) {
  return (
    <div className="ms-count">
      <div className={"ms-count-n" + (cx ? " is-cx" : "")}>{n}</div>
      <div className="ms-count-l">{l}</div>
    </div>
  );
}

/* ONE SLOT, ONE FULL-WIDTH ROW. The field is written out and WRAPS rather than ellipsing — a
 * truncated field name is the same swallow the seven-column grid commits, and an agenda row can
 * grow because nothing sits beside it to be knocked out of alignment. */
function AgendaRow({ s }: { s: Slot }) {
  const stateClass = { ran: "", cx: " is-cx", upcoming: " is-planned", flag: " is-flag" }[s.state];
  const hasFig = (s.state === "ran" || s.state === "cx") && s.booked != null && s.cap != null;
  const over = hasFig && s.booked! > s.cap!;
  const full = hasFig && s.booked! >= s.cap!;
  const isCx = s.state === "cx";
  return (
    <div className={"ms-agrow" + stateClass} data-testid="ms-agrow" data-state={s.state}>
      <b className="ms-agtime">{s.time}</b>
      <span className="ms-agfield">{s.field}</span>
      {hasFig ? (
        <span className={"ms-agnum" + (isCx ? " is-cx" : over ? " is-over" : full ? " is-full" : "")}>{s.booked} / {s.cap}</span>
      ) : s.state === "flag" ? (
        <span className="ms-flagchip">Not on MatchDay</span>
      ) : null}
      {isCx && <span className="ms-agcx">CX</span>}
    </div>
  );
}

function Cell({ s }: { s: Slot }) {
  const stateClass = { ran: "", cx: " is-cx", upcoming: " is-planned", flag: " is-flag" }[s.state];
  const hasFig = (s.state === "ran" || s.state === "cx") && s.booked != null && s.cap != null;
  const over = hasFig && s.booked! > s.cap!;
  const full = hasFig && s.booked! >= s.cap!;
  const pct = hasFig ? Math.min(100, (s.booked! / Math.max(1, s.cap!)) * 100) : 0;
  const isCx = s.state === "cx";
  return (
    <div className={"ms-cell" + stateClass} data-state={s.state}>
      <div className="ms-cell-time">{s.time}</div>
      <div className="ms-cell-field" title={s.field}>{s.field}</div>
      <div className="ms-cell-players">
        {hasFig ? (
          <>
            <span className={"ms-pnum" + (isCx ? " is-cx" : over ? " is-over" : full ? " is-full" : "")}>{s.booked} / {s.cap}</span>
            <div className={"ms-meter" + (isCx ? " is-cx" : "")}>
              <span className={"ms-meterfill" + (isCx ? " is-cx" : over ? " is-over" : "")} style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : s.state === "flag" ? (
          <span className="ms-flagchip">Not on MatchDay</span>
        ) : (
          <>
            <span className="ms-pnote" title="Not booked yet">&mdash;</span>
            <div className={"ms-meter is-empty" + (isCx ? " is-cx" : "")} />
          </>
        )}
      </div>
    </div>
  );
}

// Namespaced (ms-) so a later global .cell/.slot/.note can't win on equal
// specificity. Palette values only — no invented colours.
const CSS = `
.ms-card{background:#ffffff;border:1px solid #e6ebe8;border-radius:16px;padding:22px 22px 18px;margin-bottom:18px}
.ms-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:4px;flex-wrap:wrap}
.ms-eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#626f68;margin:0 0 6px}
.ms-city{font-size:22px;font-weight:800;letter-spacing:-.015em;color:#0d3b2e;margin:0;line-height:1.1}
.ms-sub{font-size:13px;color:#626f68;margin:8px 0 0;line-height:1.5;max-width:62ch}
.ms-navrow{display:flex;align-items:center;gap:8px;margin:16px 0 6px}
.ms-nav{width:30px;height:30px;border-radius:999px;border:1px solid #e2eae5;background:#fff;color:#566661;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.ms-week{border:1px solid #e2eae5;background:#eef3f0;color:#12241d;border-radius:999px;padding:6px 15px;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.ms-today-btn{border:1px solid #0d3b2e;background:#0d3b2e;color:#fff;border-radius:999px;padding:6px 15px;font-size:12.5px;font-weight:700;cursor:pointer}
/* WRAP, not nowrap: five count blocks at 16px side padding measure ~417px and overflowed a
   390px viewport horizontally (pre-existing, caught by verify-slate-notes gate 5). At 1600 there
   is room for one line, so the desktop band is unchanged. */
.ms-counts{display:flex;gap:0;align-items:stretch;flex-wrap:wrap;justify-content:flex-end}
.ms-count{padding:0 16px;border-left:1px solid #eff3f1;text-align:right}
.ms-count:first-child{border-left:0}
.ms-count-n{font-size:19px;font-weight:800;color:#12241d;line-height:1.15;font-variant-numeric:tabular-nums}
.ms-count-n.is-cx{color:#8f2d15}
.ms-count-l{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#626f68;margin-top:3px;white-space:nowrap}
.ms-toolbar{display:flex;align-items:center;justify-content:flex-end;margin:2px 0 12px}
.ms-toggle{display:inline-flex;align-items:center;gap:9px;cursor:pointer;font-size:12.5px;color:#566661;font-weight:600}
.ms-toggle input{position:absolute;opacity:0;width:0;height:0}
.ms-track{width:36px;height:20px;border-radius:999px;background:#eef3f0;border:1px solid #e2eae5;position:relative;transition:background .12s,border-color .12s;flex:0 0 auto}
.ms-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;border:1px solid #e2eae5;transition:left .12s}
.ms-toggle input:checked + .ms-track{background:#35c77f;border-color:#35c77f}
.ms-toggle input:checked + .ms-track .ms-knob{left:18px;border-color:#35c77f}
.ms-toggle input:focus-visible + .ms-track{outline:2px solid #0d3b2e;outline-offset:2px}
.ms-empty{padding:28px 8px;color:#626f68;font-size:13px}
.ms-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px;align-items:start}
.ms-col{background:#f9fbfa;border:1px solid #e0e8e3;border-radius:12px;padding:8px 8px 10px;min-width:0}
.ms-col.is-today{border-color:#35c77f;box-shadow:inset 3px 0 0 #35c77f}
/* WRAP RATHER THAN SHEAR. The TODAY column's header carries an extra badge, so at tablet widths
   it needed 80px in a 68px track and the day number was clipped — measured at 768 and 1024. It is
   the only element on this grid that does not fit its column, and letting it take a second line
   costs nothing while a sheared date costs the reader the day they are looking at. */
.ms-colhead{display:flex;align-items:baseline;justify-content:space-between;gap:6px;flex-wrap:wrap;
  min-width:0;padding:4px 4px 9px;margin-bottom:2px;border-bottom:1px solid #e0e8e3}
.ms-dow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#626f68}
.ms-col.is-today .ms-dow{color:#12704a}
.ms-dnum{font-size:14px;font-weight:800;color:#566661;font-variant-numeric:tabular-nums}
.ms-col.is-today .ms-dnum{color:#12704a}
.ms-todaychip{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#12704a;background:#e0f2e7;border-radius:999px;padding:2px 6px;margin-left:6px;vertical-align:1px}
.ms-stack{display:flex;flex-direction:column;gap:7px;padding-top:9px}
.ms-cell{background:#f3f7f4;border:1px solid #e2ebe6;border-radius:9px;padding:9px 10px 10px;min-width:0}
.ms-cell-time{font-size:13px;font-weight:800;color:#12241d;line-height:1.25;font-variant-numeric:tabular-nums;letter-spacing:-.005em}
/* Exactly two lines: min-height is a floor, but a long field name wraps to a
   third line at narrow column widths and breaks cross-column alignment. Clamp to
   two lines (fixed 33px) so every cell is identical height at 1280 and 1600; the
   full name stays available via the title tooltip. */
.ms-cell-field{font-size:12.5px;font-weight:500;color:#566661;line-height:1.32;margin-top:3px;overflow-wrap:break-word;min-height:33px;height:33px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ms-cell-players{display:flex;align-items:center;gap:8px;margin-top:7px}
.ms-pnum{font-size:12px;font-weight:700;color:#12241d;font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto}
.ms-pnum.is-full{color:#12704a}
.ms-pnum.is-over{color:#8a6300}
.ms-meter{height:4px;border-radius:2px;background:#e0f2e7;overflow:hidden;width:100%;min-width:0}
.ms-meterfill{height:100%;border-radius:2px;background:#35c77f;display:block}
.ms-meterfill.is-over{background:#d9a521}
.ms-pnote{font-size:12px;font-weight:700;color:#566661;font-variant-numeric:tabular-nums;flex:0 0 auto}
.ms-meter.is-empty{background:transparent;border:1px dashed #cfd9d3;height:5px;border-radius:3px}
.ms-cell.is-planned{background:#fff;border-style:dashed;border-color:#cfd9d3}
.ms-cell.is-flag{background:#fff;border-style:solid;border-color:#e3c369}
.ms-flagchip{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#8a6300;background:#fbf2dd;border:1px solid #e3c369;border-radius:999px;padding:2px 7px}
.ms-cell.is-cx{background:#fbe9e3;border-color:#f0cec2}
.ms-cell.is-cx .ms-cell-time,.ms-cell.is-cx .ms-cell-field{color:#8f2d15;text-decoration:line-through}
.ms-pnum.is-cx{color:#8f2d15}
.ms-cell.is-cx .ms-pnote{color:#8f2d15}
.ms-cell.is-cx .ms-meter.is-empty{border-color:#e0b3a4}
.ms-meter.is-cx{background:#f2cdc0}
.ms-meterfill.is-cx{background:#8f2d15}
.ms-legend{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:16px;padding-top:14px;border-top:1px solid #eff3f1}
.ms-leg{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:#566661;font-weight:600}
.ms-swatch{width:22px;height:14px;border-radius:4px;border:1px solid #e2ebe6;background:#f3f7f4;flex:0 0 auto}
.ms-swatch.sw-planned{background:#fff;border-style:dashed;border-color:#cfd9d3}
.ms-swatch.sw-flag{background:#fff;border-color:#e3c369}
.ms-swatch.sw-cx{background:#fbe9e3;border-color:#f0cec2}
.ms-swatch.sw-today{background:#fff;border-color:#35c77f;box-shadow:inset 3px 0 0 #35c77f}
.ms-chg-title{font-size:15px;font-weight:800;color:#0d3b2e;margin:0;letter-spacing:-.01em}
.ms-chg-sub{font-size:12.5px;color:#626f68;margin:6px 0 18px;line-height:1.5;max-width:78ch}
.ms-grp{margin-bottom:26px}
.ms-grp-head{display:flex;align-items:center;gap:9px;margin-bottom:3px}
.ms-grp-name{font-size:11.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#566661}
.ms-grp-n{font-size:11px;font-weight:800;color:#12241d;background:#eef3f0;border:1px solid #e2eae5;border-radius:999px;padding:1px 8px;font-variant-numeric:tabular-nums}
.ms-grp-n.is-cx{color:#8f2d15;background:#fbe9e3;border-color:#f0cec2}
.ms-grp-note{font-size:12px;color:#626f68;margin:2px 0 10px;line-height:1.45}
.ms-grp-empty{font-size:12.5px;color:#626f68;margin:2px 0 0;line-height:1.45}
.ms-rows{border-top:1px solid #eff3f1}
.ms-rows.is-split{display:grid;grid-auto-flow:column;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:34px}
@media (max-width:1100px){.ms-rows.is-split{display:block}}
.ms-row{display:flex;align-items:baseline;gap:12px;padding:9px 2px;border-bottom:1px solid #eff3f1}
.ms-row-day{font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#626f68;flex:0 0 62px;font-variant-numeric:tabular-nums}
.ms-row-time{font-size:12.5px;font-weight:700;color:#12241d;flex:0 0 74px;font-variant-numeric:tabular-nums}
.ms-row-field{font-size:12.5px;font-weight:500;color:#566661;min-width:0;line-height:1.35}
.ms-row.is-drop .ms-row-time{color:#8f2d15}
.ms-row-tag{margin-left:auto;flex:0 0 auto;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#8f2d15;background:#fbe9e3;border-radius:999px;padding:2px 8px}

/* ── THE WEEK GRID ON A PHONE ─────────────────────────────────────────────────────────────────
   NO BACKTICK MAY APPEAR IN THIS BLOCK - it sits inside a template literal.

   MEASURED at 390px: repeat(7, minmax(0,1fr)) gave columns of 34.9px and sheared 57 elements -
   the day header needed 58px in a 17px box, and every cell 52px in 20px. The ZERO in minmax(0,...)
   is what permits that: it lets a track shrink below its own content rather than overflowing, so
   the grid fits the screen perfectly and says nothing legible.

   Below 640px the minimum becomes a real one and the grid scrolls itself. The page still never
   scrolls sideways. Desktop is untouched - minmax(0,1fr) is right there, where seven columns fit. */
/* THE AGENDA. Only rendered below 640px - the seven-column grid is not rendered there at all, so
   the horizontal scroll that used to carry it is gone rather than adjusted. There is no scrolling
   row left for a day header to desync from. */
.ms-agenda{display:flex;flex-direction:column}
.ms-agday{display:flex;align-items:baseline;gap:7px;padding:8px 2px 6px;border-top:1px solid #eff3f1}
.ms-agenda > div:first-child .ms-agday{border-top:0}
.ms-agday b{font-size:12.5px;font-weight:800;color:#12241d}
.ms-agday.is-today b{color:#12704a}
.ms-agn{margin-left:auto;font-size:11px;font-weight:700;color:#626f68;font-variant-numeric:tabular-nums}
.ms-agrow{display:flex;align-items:center;gap:9px;min-height:44px;padding:7px 10px;margin-bottom:5px;
  border:1px solid #e2ebe6;border-radius:10px;background:#f9fbfa}
.ms-agrow.is-planned{background:#ffffff}
.ms-agrow.is-flag{background:#fdf6ec;border-color:#e8d3ae}
.ms-agrow.is-cx{background:#fbeee9;border-color:#f0cec2}
.ms-agtime{flex:0 0 62px;font-size:12.5px;font-weight:800;color:#12241d;font-variant-numeric:tabular-nums;
  white-space:nowrap}
/* THE FIELD WRAPS, IT DOES NOT ELLIPSE. overflow-wrap:break-word breaks a long WORD only as a last
   resort; it does not shatter every word into one character per line the way anywhere does. */
.ms-agfield{flex:1;min-width:0;font-size:12.5px;font-weight:600;color:#566661;line-height:1.3;
  overflow-wrap:break-word}
.ms-agrow.is-cx .ms-agfield{text-decoration:line-through;color:#a4796d}
.ms-agnum{flex:0 0 auto;font-size:11.5px;font-weight:800;color:#12241d;font-variant-numeric:tabular-nums;
  white-space:nowrap}
.ms-agnum.is-full{color:#12704a}
.ms-agnum.is-over{color:#8f2d15}
.ms-agnum.is-cx{color:#a4796d}
.ms-agcx{flex:0 0 auto;font-size:9.5px;font-weight:900;letter-spacing:.05em;color:#8f2d15;
  background:#fbe9e3;border-radius:4px;padding:1px 5px}

`;
