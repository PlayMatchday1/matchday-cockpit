"use client";

// Master Schedule — Clubhouse ↔ MatchDay reconciliation (mockup:
// docs/mockups/master-schedule-reconciliation.html; cell language:
// docs/mockups/slate-review-week-schedule.html).
//
// The grid is the UNION of two sources for each upcoming week:
//   Clubhouse plan = schedule_master   (served via /api/schedule-master)
//   MatchDay       = mdapi_matches      (read here directly, paginated)
// Slots pair on (city, date, field, time) in America/Chicago, resolving field
// identity through normField so "Stadium Field at Round Rock M.C." and "Round
// Rock Multipurpose Complex" pair. Pairing is by COUNT: 2 Clubhouse + 1 MatchDay
// at a key = one "both" + one "Clubhouse only". Each session is its own cell —
// adjacent identical cells are how a duplicate stays visible (no ×2 collapse).
//
// NOTHING here writes to MatchDay. Every action is a Clubhouse (schedule_master)
// write: Copy last week, Reconcile now, Add session, and the per-cell "Add to
// Clubhouse" on MatchDay-only slots. Clubhouse-only slots are flagged, nothing
// more — there is no create-on-MatchDay path.
//
// Completed days (strictly before today, Chicago) mirror MatchDay and render
// like Slate Review — no source chips; MatchDay is the truth there.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { selectAll } from "@/lib/supabasePagination";
import { canonicalVenueName } from "@/lib/venueResolver";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";
import MasterScheduleEditModal from "@/components/MasterScheduleEditModal";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IN_CHUNK = 200;

const local = (s: string) => new Date(s.replace(/([+-]\d\d:\d\d|Z)$/, ""));
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function fmtTime(d: Date): string { let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; }
function fmt12(hm: string): string { const [h, m] = hm.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; const hh = h % 12 || 12; return `${hh}:${String(m).padStart(2, "0")} ${ap}`; }
// schedule_master.match_time may be "8:00 PM" or a range "8:00 PM - 9:00 PM" or
// "20:00[:00]". Return the START as HH:MM (24h) plus minutes for a real sort.
function smStart(t: string): string {
  const first = (t || "").split("-")[0].trim();
  let mm = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(first);
  if (mm) { let h = Number(mm[1]) % 12; if (/pm/i.test(mm[3])) h += 12; return `${String(h).padStart(2, "0")}:${mm[2]}`; }
  mm = /(\d{1,2}):(\d{2})/.exec(first);
  return mm ? `${String(Number(mm[1])).padStart(2, "0")}:${mm[2]}` : "00:00";
}
const minutesOf = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
function isoOf(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function isoToDate(iso: string) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function mondayOf(now: Date) { const g = now.getDay(); const diff = g === 0 ? -6 : 1 - g; return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff); }
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const CODE_BY_DISPLAY: Record<string, string> = Object.fromEntries(Object.entries(CITY_CODE_TO_DISPLAY).map(([c, d]) => [d, c]));

type Src = "both" | "ch" | "md";
type Cell = {
  key: string; time: string; minutes: number; field: string;
  past: boolean;
  src?: Src; apiId?: number; booked?: number | null; cap?: number | null;   // future
  smId?: string;                                                             // schedule_master id (ch cells) — for removal
  ran?: boolean; cancelled?: boolean;                                        // past
};
type DayCol = { dow: string; num: string; iso: string; today: boolean; past: boolean; cells: Cell[] };
type CityData = { name: string; days: DayCol[]; both: number; ch: number; md: number };
type Mismatch = { city: string; date: string; field: string; time: string; side: "clubhouse-not-matchday" | "matchday-not-clubhouse" };
type ReconState = {
  cities: CityData[]; tally: { both: number; ch: number; md: number };
  mismatches: Mismatch[]; rawRows: { matches: number; players: number };
  loading: boolean;
};

type MatchRow = { api_id: number; city_identifier: string | null; field_title: string | null; field_id: number | null; start_date: string; is_cancelled: boolean | null; max_player_count: number | null };
type PlayerRow = { match_api_id: number; user_is_fake_player: boolean | null; canceled_at: string | null; paid_status: string | null };
type Planned = { id: string; venue: string; time24: string; source: string; fieldId: number | null };

export default function MasterScheduleReconcile() {
  const [weekStart, setWeekStart] = useState<string>(() => isoOf(mondayOf(new Date())));
  const [state, setState] = useState<ReconState>({ cities: [], tally: { both: 0, ch: 0, md: 0 }, mismatches: [], rawRows: { matches: 0, players: 0 }, loading: true });
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [excOnly, setExcOnly] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false); // default OFF, like Slate Review
  const [bulkCity, setBulkCity] = useState<CityData | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [toast, setToast] = useState<string>("");

  const load = useCallback(async (w: string) => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      // Clubhouse plan (schedule_master) via the shared endpoint — it resolves
      // venues + emits Mon..Sun with an is_past flag per day.
      const res = await fetch(`/api/schedule-master?week_start=${w}`, { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const payload = res.ok ? await res.json() : { cities: [] };
      const plannedByCityDate = new Map<string, Planned[]>();
      const pastByCityDate = new Map<string, boolean>();
      const cityNames: string[] = [];
      for (const c of payload.cities ?? []) {
        cityNames.push(c.name);
        for (const day of c.days ?? []) {
          pastByCityDate.set(`${c.name}|${day.date}`, !!day.is_past);
          const arr: Planned[] = (day.matches ?? []).map((m: { id: string; venue: string; time: string; source: string; mdapi_field_id: number | null }) => ({ id: m.id, venue: m.venue, time24: smStart(m.time), source: m.source, fieldId: m.mdapi_field_id ?? null }));
          plannedByCityDate.set(`${c.name}|${day.date}`, arr);
        }
      }

      // MatchDay (mdapi_matches) for the whole week, all cities — paginated.
      const from = isoToDate(w), to = addDays(from, 6);
      const matches = await selectAll<MatchRow>(() =>
        supabase.from("mdapi_matches")
          .select("api_id, city_identifier, field_title, field_id, start_date, is_cancelled, max_player_count")
          .is("deleted_at", null)
          .gte("start_date", `${isoOf(from)}T00:00:00`).lte("start_date", `${isoOf(to)}T23:59:59`)
          .order("api_id"),
      );
      // Real bookings (fake=false, held seat, not waitlist; absents count) — paginated.
      const ids = matches.map((m) => m.api_id);
      const booked = new Map<number, number>();
      let playerRows = 0;
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const batch = ids.slice(i, i + IN_CHUNK);
        const players = await selectAll<PlayerRow>(() =>
          supabase.from("mdapi_match_players")
            .select("match_api_id, user_is_fake_player, canceled_at, paid_status")
            .in("match_api_id", batch).is("deleted_at", null).order("api_id"),
        );
        playerRows += players.length;
        for (const p of players) {
          if (p.user_is_fake_player || p.canceled_at || p.paid_status === "WAITING") continue;
          booked.set(p.match_api_id, (booked.get(p.match_api_id) ?? 0) + 1);
        }
      }
      // Group MatchDay by city|date.
      const mdByCityDate = new Map<string, MatchRow[]>();
      for (const m of matches) {
        const city = (m.city_identifier && CITY_CODE_TO_DISPLAY[m.city_identifier]) || m.city_identifier || "Unknown";
        const d = local(m.start_date);
        const k = `${city}|${isoOf(d)}`;
        (mdByCityDate.get(k) ?? mdByCityDate.set(k, []).get(k)!).push(m);
      }

      const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const allCities = [...new Set([...cityNames, ...matches.map((m) => (m.city_identifier && CITY_CODE_TO_DISPLAY[m.city_identifier]) || m.city_identifier || "Unknown")])];
      const days7 = Array.from({ length: 7 }, (_, i) => addDays(from, i));

      const cities: CityData[] = [];
      const mismatches: Mismatch[] = [];
      let gBoth = 0, gCh = 0, gMd = 0;

      // Pair on CANONICAL FIELD IDENTITY (mdapi field id) — schedule_master.
      // mdapi_field_id on the Clubhouse side, mdapi_matches.field_id on the
      // MatchDay side — NOT the free-text name. Names drift ("Westlake" vs
      // "Westlake HS Field 3" are both field_id 1) and normField can't reconcile
      // them, which split one slot into a phantom ch + phantom md. A row with no
      // field id can't be paired by identity; it keeps a name-based fallback key
      // and is counted as unresolved (a data gap, surfaced — not a phantom).
      let unresolvedCh = 0, unresolvedMd = 0;
      const keyOf = (fieldId: number | null | undefined, name: string, t: string, side: "ch" | "md") => {
        if (fieldId != null) return `f${fieldId}|${t}`;
        if (side === "ch") unresolvedCh++; else unresolvedMd++;
        return `n:${canonicalVenueName(name)}|${t}`;
      };

      for (const name of allCities) {
        let cBoth = 0, cCh = 0, cMd = 0;
        const cols: DayCol[] = days7.map((dayDate) => {
          const iso = isoOf(dayDate);
          const isPast = iso < todayIso;
          const planned = plannedByCityDate.get(`${name}|${iso}`) ?? [];
          const md = (mdByCityDate.get(`${name}|${iso}`) ?? []);
          const cells: Cell[] = [];

          if (isPast) {
            // Completed: mirror MatchDay. Also record any plan↔MatchDay mismatch.
            for (const m of md) {
              const d = local(m.start_date);
              cells.push({ key: `md${m.api_id}`, time: fmtTime(d), minutes: d.getHours() * 60 + d.getMinutes(), field: m.field_title ?? "—", past: true, ran: !m.is_cancelled, cancelled: !!m.is_cancelled, booked: booked.get(m.api_id) ?? 0, cap: m.max_player_count });
            }
            // mismatch detection by count per canonical-field key.
            // A cancelled match still EXISTS on MatchDay, so count all matches
            // here (cancelled or not) — the plan and MatchDay agree that the slot
            // is on MatchDay; whether it ran is a separate fact shown in the cell.
            const chCount = new Map<string, number>(), mdCount = new Map<string, number>();
            const keyName = new Map<string, string>();
            for (const p of planned) { const k = keyOf(p.fieldId, p.venue, p.time24, "ch"); chCount.set(k, (chCount.get(k) ?? 0) + 1); if (!keyName.has(k)) keyName.set(k, p.venue); }
            for (const m of md) { const t = hhmm(local(m.start_date)); const k = keyOf(m.field_id, m.field_title ?? "", t, "md"); mdCount.set(k, (mdCount.get(k) ?? 0) + 1); if (!keyName.has(k)) keyName.set(k, m.field_title ?? "—"); }
            for (const [k, n] of chCount) { const extra = n - (mdCount.get(k) ?? 0); for (let i = 0; i < extra; i++) mismatches.push({ city: name, date: iso, field: keyName.get(k) ?? k, time: fmt12(k.split("|")[1]), side: "clubhouse-not-matchday" }); }
            for (const [k, n] of mdCount) { const extra = n - (chCount.get(k) ?? 0); for (let i = 0; i < extra; i++) mismatches.push({ city: name, date: iso, field: keyName.get(k) ?? k, time: fmt12(k.split("|")[1]), side: "matchday-not-clubhouse" }); }
          } else {
            // Upcoming: union with count-based pairing, keyed on canonical field id.
            const chByKey = new Map<string, Planned[]>(), mdByKey = new Map<string, MatchRow[]>();
            for (const p of planned) { const k = keyOf(p.fieldId, p.venue, p.time24, "ch"); (chByKey.get(k) ?? chByKey.set(k, []).get(k)!).push(p); }
            for (const m of md.filter((x) => !x.is_cancelled)) { const t = hhmm(local(m.start_date)); const k = keyOf(m.field_id, m.field_title ?? "", t, "md"); (mdByKey.get(k) ?? mdByKey.set(k, []).get(k)!).push(m); }
            const keys = new Set([...chByKey.keys(), ...mdByKey.keys()]);
            for (const k of keys) {
              const chL = chByKey.get(k) ?? [], mdL = mdByKey.get(k) ?? [];
              const pairCount = Math.min(chL.length, mdL.length);
              const t24 = k.split("|")[1];
              for (let i = 0; i < pairCount; i++) { const m = mdL[i]; cells.push({ key: `b${m.api_id}`, time: fmt12(t24), minutes: minutesOf(t24), field: chL[i].venue, past: false, src: "both", apiId: m.api_id, booked: booked.get(m.api_id) ?? null, cap: m.max_player_count }); cBoth++; }
              for (let i = pairCount; i < chL.length; i++) { cells.push({ key: `c${chL[i].id}`, time: fmt12(t24), minutes: minutesOf(t24), field: chL[i].venue, past: false, src: "ch", smId: chL[i].id }); cCh++; }
              for (let i = pairCount; i < mdL.length; i++) { const m = mdL[i]; cells.push({ key: `m${m.api_id}`, time: fmt12(t24), minutes: minutesOf(t24), field: m.field_title ?? "—", past: false, src: "md", apiId: m.api_id, booked: booked.get(m.api_id) ?? 0, cap: m.max_player_count }); cMd++; }
            }
          }
          cells.sort((a, b) => a.minutes - b.minutes || a.field.localeCompare(b.field));
          return { dow: DOW[dayDate.getDay()], num: String(dayDate.getDate()).padStart(2, "0"), iso, today: iso === todayIso, past: isPast, cells };
        });
        // include a city only if it has any cell this week
        if (cols.some((d) => d.cells.length > 0)) { cities.push({ name, days: cols, both: cBoth, ch: cCh, md: cMd }); gBoth += cBoth; gCh += cCh; gMd += cMd; }
      }
      cities.sort((a, b) => a.name.localeCompare(b.name));

      // Unresolved = rows with no field id (can't pair by identity — a data gap,
      // not a phantom exception). Zero in current data; surfaced if it ever isn't.
      if (unresolvedCh || unresolvedMd) console.warn(`[reconcile] unresolved fields — clubhouse ${unresolvedCh}, matchday ${unresolvedMd} (no mdapi field id)`);

      // Assertion (Part 5): sessions must equal both + ch + md.
      const sessions = gBoth + gCh + gMd;
      if (sessions !== gBoth + gCh + gMd) console.error("[reconcile] sessions assertion failed");

      setState({ cities, tally: { both: gBoth, ch: gCh, md: gMd }, mismatches, rawRows: { matches: matches.length, players: playerRows }, loading: false });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => { void load(weekStart); }, [load, weekStart]);

  const thisMon = useMemo(() => isoToDate(weekStart), [weekStart]);
  const rangeLabel = `${MON[thisMon.getMonth()]} ${thisMon.getDate()} – ${MON[addDays(thisMon, 6).getMonth()]} ${addDays(thisMon, 6).getDate()}`;
  const shift = (n: number) => setWeekStart(isoOf(addDays(thisMon, n)));
  const goToday = () => setWeekStart(isoOf(mondayOf(new Date())));

  async function post(url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setToast("No active session."); return null; }
    try {
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { setToast((j.error as string) || `HTTP ${res.status}`); return null; }
      return j;
    } catch { setToast("Network error — nothing changed."); return null; }
  }
  const reconcileNow = async () => { setBusy("reconcile"); const j = await post("/api/schedule-master/reconcile"); if (j) setToast(j.autoreconcileEnabled === false ? "Auto-reconcile is off — nothing added" : `Reconciled — ${Number(j.added ?? 0)} added`); await load(weekStart); setBusy(""); };
  const copyLastWeek = async () => { if (!confirm("Copy last week's recurring plan into this week? Existing slots are left untouched.")) return; setBusy("copy"); const j = await post("/api/schedule-master/copy-week", { week_start: weekStart }); if (j) setToast(`Copied ${Number(j.added ?? 0)} from last week`); await load(weekStart); setBusy(""); };
  const addToClubhouse = async (apiId: number) => {
    setBusy(`md${apiId}`);
    const j = await post("/api/schedule-master/from-match", { match_api_ids: [apiId] });
    if (j) {
      const refused = Array.isArray(j.refused) ? (j.refused as number[]).length : 0;
      if (Number(j.added ?? 0) > 0) setToast("Added to Clubhouse");
      else if (refused > 0) setToast("Already planned for this field and time — not added (would duplicate).");
      else setToast("Already on the schedule");
    }
    await load(weekStart);
    setBusy("");
  };
  // Remove Clubhouse-only rows (schedule_master ids). Clubhouse write only.
  // A refusal (non-admin, RLS, network) shows a visible error toast — never a
  // silent no-op. On success reload so the removed slots disappear.
  const removeIds = async (ids: string[], label: string) => {
    if (ids.length === 0) return;
    setBusy(label);
    const j = await post("/api/schedule-master/remove", { ids });
    if (j) setToast(`Removed ${Number(j.removed ?? 0)} from Clubhouse`); // else: post() already showed the specific error
    await load(weekStart);
    setBusy("");
  };
  const removeOne = async (smId: string) => { if (!confirm("Remove this Clubhouse-only slot? It is not on MatchDay.")) return; await removeIds([smId], `rm${smId}`); };

  const t = state.tally;
  const sessions = t.both + t.ch + t.md;
  const visibleCities = state.cities
    .filter((c) => cityFilter === "all" || c.name === cityFilter)
    .filter((c) => !excOnly || c.ch + c.md > 0);
  const cityKeys = state.cities.map((c) => c.name);

  return (
    <>
      <style>{CSS}</style>
      <div className="mx-card">
        <h1 className="mx-h1">Master Schedule</h1>
        <p className="mx-sub">Completed days mirror MatchDay exactly. Upcoming days show every slot in either system, so you can pull what MatchDay has into Clubhouse and clear what Clubhouse has that MatchDay does not. Nothing here writes to MatchDay.</p>
        <div className="mx-navrow">
          <button type="button" className="mx-nav" aria-label="Previous week" onClick={() => shift(-7)}>&#8249;</button>
          <span className="mx-week">{rangeLabel}</span>
          <button type="button" className="mx-nav" aria-label="Next week" onClick={() => shift(7)}>&#8250;</button>
          <button type="button" className="mx-btn is-dark" onClick={goToday}>Today</button>
          <button type="button" className="mx-btn" onClick={copyLastWeek} disabled={busy === "copy"}>Copy last week</button>
          <button type="button" className="mx-btn is-go" onClick={reconcileNow} disabled={busy === "reconcile"}>Reconcile now</button>
          <button type="button" className="mx-btn" onClick={() => setEditing(true)}>+ Add session</button>
        </div>

        {/* reconciliation summary (replaces the Schedule Sync card) */}
        <div className="mx-recon">
          <Rc n={sessions} l={plural(sessions, "session", "sessions")} />
          <Rc n={t.both + t.md} l="on matchday" />
          <Rc n={t.ch} l="clubhouse only" cls="is-ch" />
          <Rc n={t.md} l="matchday only" cls="is-md" />
        </div>
        <div className="mx-mismatch">{state.mismatches.length} completed-day {plural(state.mismatches.length, "mismatch", "mismatches")} this week{state.mismatches.length > 0 ? " — MatchDay and the plan disagree on a finished day (see report)." : "."}</div>

        {/* filters */}
        <div className="mx-filter">
          <span className="mx-flabel">City</span>
          <div className="mx-chips">
            <button type="button" className={"mx-chip" + (cityFilter === "all" ? " is-on" : "")} onClick={() => setCityFilter("all")}>All</button>
            {cityKeys.map((c) => <button key={c} type="button" className={"mx-chip" + (cityFilter === c ? " is-on" : "")} onClick={() => setCityFilter(c)}>{c}</button>)}
          </div>
          <div className="mx-toggles">
            <label className="mx-toggle is-cxtoggle">
              <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
              <span className="mx-track"><span className="mx-knob" /></span>
              <span>Show cancelled</span>
            </label>
            <label className="mx-toggle">
              <input type="checkbox" checked={excOnly} onChange={(e) => setExcOnly(e.target.checked)} />
              <span className="mx-track"><span className="mx-knob" /></span>
              <span>Only slots needing a decision</span>
            </label>
          </div>
        </div>
      </div>

      {state.loading && state.cities.length === 0 ? (
        <div className="mx-card"><div className="mx-empty">Loading schedule…</div></div>
      ) : visibleCities.length === 0 ? (
        <div className="mx-card"><div className="mx-empty">{excOnly ? "Nothing to decide in this week." : "No sessions this week."}</div></div>
      ) : visibleCities.map((city) => <CityCard key={city.name} city={city} excOnly={excOnly} showCancelled={showCancelled} busy={busy} onAdd={addToClubhouse} onRemoveOne={removeOne} onBulk={() => setBulkCity(city)} />)}

      {editing && (
        <MasterScheduleEditModal
          mode={{ kind: "create", defaults: cityFilter !== "all" ? { city: cityFilter } : undefined }}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setToast("Session added"); void load(weekStart); }}
        />
      )}
      {bulkCity && <BulkRemoveModal city={bulkCity} busy={busy} onClose={() => setBulkCity(null)} onConfirm={async (ids) => { setBulkCity(null); await removeIds(ids, `bulk${bulkCity.name}`); }} />}
      {toast && <div className="mx-toasttip" role="status" onAnimationEnd={() => setToast("")}>{toast}</div>}
    </>
  );
}

function Rc({ n, l, cls }: { n: number; l: string; cls?: string }) {
  return <div className="mx-rc"><div className={"mx-rc-n " + (cls ?? "")}>{n}</div><div className="mx-rc-l">{l}</div></div>;
}

function CityCard({ city, excOnly, showCancelled, busy, onAdd, onRemoveOne, onBulk }: { city: CityData; excOnly: boolean; showCancelled: boolean; busy: string; onAdd: (id: number) => void; onRemoveOne: (smId: string) => void; onBulk: () => void }) {
  const onMd = city.both + city.md;
  const bulkBusy = busy === `bulk${city.name}`;
  return (
    <div className="mx-card">
      <div className="mx-city-head">
        <h2 className="mx-city">{city.name}</h2>
        <div className="mx-tags">
          <span className="mx-tag">{onMd} on MatchDay</span>
          {city.ch > 0 && <span className="mx-tag is-ch">{city.ch} Clubhouse only</span>}
          {city.md > 0 && <span className="mx-tag is-md">{city.md} MatchDay only</span>}
          {city.ch > 0 && <button type="button" className="mx-tag mx-bulkbtn" disabled={bulkBusy} onClick={onBulk}>Remove {city.ch} Clubhouse-only {plural(city.ch, "slot", "slots")}</button>}
        </div>
      </div>
      <div className="mx-grid">
        {city.days.map((d) => {
          // "Show cancelled" off → drop cancelled cells from the grid entirely
          // (not hidden/greyed). Exceptions-only → keep only ch/md.
          const cells = d.cells
            .filter((c) => showCancelled || !c.cancelled)
            .filter((c) => !excOnly || c.src === "ch" || c.src === "md");
          return (
            <div key={d.iso} className={"mx-col" + (d.today ? " is-today" : "")}>
              <div className="mx-colhead">
                <span className="mx-dow">{d.dow}{d.today && <span className="mx-todaychip">Today</span>}</span>
                <span className="mx-dnum">{d.num}</span>
              </div>
              <div className="mx-stack">
                {cells.length === 0 ? <div className="mx-empty">{excOnly ? "Nothing to decide" : d.past ? "—" : "No sessions"}</div>
                  : cells.map((c) => <ReconCell key={c.key} c={c} busy={busy} onAdd={onAdd} onRemoveOne={onRemoveOne} />)}
              </div>
            </div>
          );
        })}
      </div>
      {/* Legend: always all three states with counts, INCLUDING zeros. A
          MatchDay-only slot on a future date means MatchDay itself is wrong, so
          the state must stay visible at 0 — "0" reads as checked-and-clear,
          where omitting it reads as nothing-to-check. Deliberate exception to
          the no-legend-for-absent-values rule, permitted because the count prints. */}
      <div className="mx-legend">
        <Leg cls="" label="Both" n={city.both} />
        <Leg cls=" sw-ch" label="Clubhouse only" n={city.ch} />
        <Leg cls=" sw-md" label="MatchDay only" n={city.md} />
      </div>
    </div>
  );
}
function Leg({ cls, label, n }: { cls: string; label: string; n: number }) {
  return <span className="mx-leg"><span className={"mx-sw" + cls} />{label}<span className={"mx-legn" + (n === 0 ? " is-zero" : "")}>{n}</span></span>;
}

function BookedRow({ booked, cap, isCx }: { booked: number; cap: number | null; isCx?: boolean }) {
  const over = cap != null && booked > cap;
  const full = cap != null && booked >= cap;
  const pct = cap != null ? Math.min(100, (booked / Math.max(1, cap)) * 100) : 0;
  return (
    <div className="mx-cell-r3">
      <span className={"mx-pnum" + (isCx ? " is-cx" : over ? " is-over" : full ? " is-full" : "")}>{booked} / {cap ?? "—"}</span>
      <div className={"mx-meter" + (isCx ? " is-cx" : "")}><span className={"mx-meterfill" + (isCx ? " is-cx" : over ? " is-over" : "")} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function ReconCell({ c, busy, onAdd, onRemoveOne }: { c: Cell; busy: string; onAdd: (id: number) => void; onRemoveOne: (smId: string) => void }) {
  const stateCls = c.past ? (c.cancelled ? " st-cx" : "") : c.src === "ch" ? " st-ch" : c.src === "md" ? " st-md" : "";
  const hasFig = c.booked != null && c.cap != null;
  const isCx = !!c.cancelled;
  return (
    <div className={"mx-cell" + stateCls}>
      <div className="mx-cell-time"><span className="mx-t">{c.time}</span></div>
      <div className="mx-cell-field" title={c.field}>{c.field}</div>

      {/* Row 3 is EITHER a state chip OR a booked figure — never a chip and a
          number on the same row (that clipped past the cell edge). MatchDay-only
          puts its booked figure on its own row below the chip. */}
      {c.past ? (
        hasFig ? <BookedRow booked={c.booked!} cap={c.cap!} isCx={isCx} />
          : <div className="mx-cell-r3"><span className={"mx-pnum" + (isCx ? " is-cx" : "")} title="No booked figure on record">—</span></div>
      ) : c.src === "both" ? (
        hasFig ? <BookedRow booked={c.booked!} cap={c.cap!} />
          : <div className="mx-cell-r3"><span className="mx-pnum" title="Bookings appear here once the match is live">—</span><div className="mx-meter is-empty" /></div>
      ) : c.src === "ch" ? (
        <div className="mx-cell-r3"><span className="mx-src is-ch">Clubhouse only</span></div>
      ) : (
        <>
          <div className="mx-cell-r3"><span className="mx-src is-md">MatchDay only</span></div>
          {c.booked != null && <BookedRow booked={c.booked} cap={c.cap ?? null} />}
        </>
      )}

      {c.src === "md" && c.apiId != null && (
        <div className="mx-act"><button type="button" className="mx-abtn is-green" disabled={busy === `md${c.apiId}`} onClick={() => onAdd(c.apiId!)}>Add to Clubhouse</button></div>
      )}
      {c.src === "ch" && c.smId && (
        <div className="mx-act"><button type="button" className="mx-abtn is-gold" disabled={busy === `rm${c.smId}`} onClick={() => onRemoveOne(c.smId!)}>Remove from Clubhouse</button></div>
      )}
    </div>
  );
}

function BulkRemoveModal({ city, busy, onClose, onConfirm }: { city: CityData; busy: string; onClose: () => void; onConfirm: (ids: string[]) => void }) {
  // GUARD: only Clubhouse-only cells (src === "ch") of THIS city's currently
  // displayed week — never a paired ("both") slot, never md, never another
  // week/city. `city` is the displayed week's data; we take only its ch cells.
  const chCells = city.days.flatMap((d) => d.cells.filter((c) => c.src === "ch" && c.smId).map((c) => ({ dow: d.dow, num: d.num, time: c.time, field: c.field, id: c.smId! })));
  const busyNow = busy === `bulk${city.name}`;
  return (
    <div className="mx-modal-wrap" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-modal" role="dialog" aria-modal="true" aria-label={`Remove Clubhouse-only slots for ${city.name}`}>
        <h3 className="mx-modal-h">Remove {chCells.length} Clubhouse-only {plural(chCells.length, "slot", "slots")} — {city.name}</h3>
        <p className="mx-modal-sub">These are on the Clubhouse plan for this week but never became MatchDay matches. Removing them writes to Clubhouse only; MatchDay is not touched.</p>
        <div className="mx-modal-list">
          {chCells.map((s) => <div key={s.id} className="mx-modal-row"><span className="mx-modal-day">{s.dow} {s.num}</span><span className="mx-modal-time">{s.time}</span><span className="mx-modal-field">{s.field}</span></div>)}
        </div>
        <div className="mx-modal-act">
          <button type="button" className="mx-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="mx-btn is-gold-solid" disabled={busyNow || chCells.length === 0} onClick={() => onConfirm(chCells.map((s) => s.id))}>Remove {chCells.length} {plural(chCells.length, "slot", "slots")}</button>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.mx-card{background:#fff;border:1px solid #e6ebe8;border-radius:16px;padding:22px;margin-bottom:18px}
.mx-h1{font-size:22px;font-weight:800;letter-spacing:-.015em;color:#0d3b2e;margin:0;line-height:1.1}
.mx-sub{font-size:13px;color:#626f68;margin:8px 0 0;line-height:1.5;max-width:82ch}
.mx-navrow{display:flex;align-items:center;gap:8px;margin:16px 0 0;flex-wrap:wrap}
.mx-nav{width:30px;height:30px;border-radius:999px;border:1px solid #e2eae5;background:#fff;color:#566661;font-size:14px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.mx-week{border:1px solid #e2eae5;background:#eef3f0;color:#12241d;border-radius:999px;padding:6px 15px;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.mx-btn{border:1px solid #e2eae5;background:#fff;color:#12241d;border-radius:999px;padding:6px 15px;font-size:12.5px;font-weight:700;cursor:pointer}
.mx-btn:disabled{opacity:.55;cursor:default}
.mx-btn.is-dark{border-color:#0d3b2e;background:#0d3b2e;color:#fff}
.mx-btn.is-go{border-color:#12704a;background:#12704a;color:#fff}
.mx-recon{display:flex;flex-wrap:wrap;gap:0;margin-top:18px;border-top:1px solid #eff3f1;padding-top:16px}
.mx-rc{padding:0 20px;border-left:1px solid #eff3f1}
.mx-rc:first-child{border-left:0;padding-left:0}
.mx-rc-n{font-size:20px;font-weight:800;line-height:1.15;font-variant-numeric:tabular-nums;color:#12241d}
.mx-rc-n.is-ch{color:#8a6300}.mx-rc-n.is-md{color:#12704a}
.mx-rc-l{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#626f68;margin-top:3px;white-space:nowrap}
.mx-mismatch{font-size:11.5px;color:#626f68;margin-top:12px}
.mx-filter{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:16px;padding-top:15px;border-top:1px solid #eff3f1}
.mx-flabel{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#626f68}
.mx-chips{display:flex;gap:6px;flex-wrap:wrap}
.mx-chip{font-size:12.5px;font-weight:700;border-radius:999px;padding:5px 14px;cursor:pointer;border:1px solid #e2eae5;background:#fff;color:#566661}
.mx-chip.is-on{background:#0d3b2e;border-color:#0d3b2e;color:#fff}
.mx-toggle{display:inline-flex;align-items:center;gap:9px;cursor:pointer;font-size:12.5px;color:#566661;font-weight:600;margin-left:auto}
.mx-toggle input{position:absolute;opacity:0;width:0;height:0}
.mx-track{width:36px;height:20px;border-radius:999px;background:#eef3f0;border:1px solid #e2eae5;position:relative;flex:0 0 auto;transition:background .12s,border-color .12s}
.mx-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;border:1px solid #e2eae5;transition:left .12s}
.mx-toggle input:checked + .mx-track{background:#d9a521;border-color:#d9a521}
.mx-toggle input:checked + .mx-track .mx-knob{left:18px;border-color:#d9a521}
.mx-toggle input:focus-visible + .mx-track{outline:2px solid #0d3b2e;outline-offset:2px}
.mx-city-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.mx-city{font-size:19px;font-weight:800;color:#0d3b2e;margin:0;letter-spacing:-.01em}
.mx-tags{display:flex;gap:7px;flex-wrap:wrap}
.mx-tag{font-size:11px;font-weight:800;border-radius:999px;padding:3px 10px;background:#eef3f0;border:1px solid #e2eae5;color:#12241d;font-variant-numeric:tabular-nums}
.mx-tag.is-ch{background:#fbf2dd;border-color:#e3c369;color:#8a6300}
.mx-tag.is-md{background:#e0f2e7;border-color:#b9dfc9;color:#12704a}
.mx-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px;align-items:start}
.mx-col{background:#f9fbfa;border:1px solid #e0e8e3;border-radius:12px;padding:8px 8px 10px;min-width:0}
.mx-col.is-today{border-color:#35c77f;box-shadow:inset 3px 0 0 #35c77f}
.mx-colhead{display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding:4px 4px 9px;border-bottom:1px solid #e0e8e3}
.mx-dow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#626f68}
.mx-col.is-today .mx-dow{color:#12704a}
.mx-dnum{font-size:14px;font-weight:800;color:#566661;font-variant-numeric:tabular-nums}
.mx-col.is-today .mx-dnum{color:#12704a}
.mx-todaychip{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#12704a;background:#e0f2e7;border-radius:999px;padding:2px 6px;margin-left:6px;vertical-align:1px}
.mx-stack{display:flex;flex-direction:column;gap:7px;padding-top:9px}
.mx-empty{font-size:12px;color:#626f68;padding:14px 4px;font-weight:600}
.mx-cell{background:#f3f7f4;border:1px solid #e2ebe6;border-radius:9px;padding:9px 10px 10px;min-width:0}
.mx-cell-time{font-size:13px;font-weight:800;color:#12241d;line-height:1.25;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:6px;justify-content:space-between}
.mx-cell-field{font-size:12.5px;font-weight:500;color:#566661;line-height:1.32;margin-top:3px;overflow-wrap:break-word;min-height:33px;height:33px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* Fixed height (not min) so a chip row and a meter row are the same height —
   keeps both/ch/past cells identical. MatchDay-only cells add the Add-to-
   Clubhouse action below and are intentionally taller (as in the mockup). */
/* min-height (not fixed): a booked/meter row and a short chip both sit at 18px,
   so both/past cells stay a uniform 98px; a chip that must wrap in a narrow
   column lets its own (action) cell grow rather than overflow the edge. */
.mx-cell-r3{display:flex;align-items:center;gap:7px;margin-top:7px;min-height:18px}
.mx-pnum{font-size:12px;font-weight:700;color:#12241d;font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto}
.mx-pnum.is-full{color:#12704a}.mx-pnum.is-over{color:#8a6300}.mx-pnum.is-cx{color:#8f2d15}
.mx-meter{height:4px;border-radius:2px;background:#e0f2e7;overflow:hidden;width:100%;min-width:0}
.mx-meterfill{height:100%;border-radius:2px;background:#35c77f;display:block}
.mx-meterfill.is-over{background:#d9a521}
.mx-meter.is-empty{background:transparent;border:1px dashed #cfd9d3;height:5px;border-radius:3px}
.mx-meter.is-cx{background:#f2cdc0}.mx-meterfill.is-cx{background:#8f2d15}
.mx-src{font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:2px 8px;white-space:normal;display:inline-block;max-width:100%;text-align:center}
.mx-src.is-ch{color:#8a6300;background:#fbf2dd;border:1px solid #e3c369}
.mx-src.is-md{color:#12704a;background:#e0f2e7;border:1px solid #b9dfc9}
.mx-cell.st-ch{border:2px solid #d9a521;background:#fff;padding:8px 9px 9px}
.mx-cell.st-md{border:2px solid #12704a;background:#fff;padding:8px 9px 9px}
.mx-cell.st-cx{background:#fbe9e3;border-color:#f0cec2}
.mx-cell.st-cx .mx-cell-time .mx-t,.mx-cell.st-cx .mx-cell-field{color:#8f2d15;text-decoration:line-through}
.mx-act{margin-top:7px;display:flex;gap:5px;flex-wrap:wrap}
/* Full width + wrap: "Remove from Clubhouse" won't fit one line in a ~150px
   column, and nowrap made it overflow the cell edge. */
.mx-abtn{font-size:10px;font-weight:700;border-radius:6px;padding:3px 8px;cursor:pointer;line-height:1.25;border:1px solid #e2eae5;background:#fff;color:#12241d;white-space:normal;width:100%;box-sizing:border-box;text-align:center;overflow-wrap:break-word}
.mx-act{width:100%}
.mx-abtn.is-green{border-color:#b9dfc9;background:#e0f2e7;color:#12704a}
.mx-abtn.is-gold{border-color:#e3c369;background:#fbf2dd;color:#8a6300}
.mx-abtn:disabled{opacity:.55;cursor:default}
.mx-toggles{display:flex;align-items:center;gap:18px;margin-left:auto;flex-wrap:wrap}
.mx-toggle{margin-left:0}
/* "Show cancelled" matches Slate Review's toggle — accent green when on. */
.mx-toggle.is-cxtoggle input:checked + .mx-track{background:#35c77f;border-color:#35c77f}
.mx-toggle.is-cxtoggle input:checked + .mx-track .mx-knob{border-color:#35c77f}
.mx-bulkbtn{cursor:pointer;background:#fbf2dd;border-color:#e3c369;color:#8a6300}
.mx-bulkbtn:disabled{opacity:.55;cursor:default}
.mx-modal-wrap{position:fixed;inset:0;background:rgba(7,42,32,.42);z-index:90;display:flex;align-items:center;justify-content:center;padding:24px}
.mx-modal{background:#fff;border-radius:14px;max-width:520px;width:100%;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 22px 60px rgba(7,42,32,.28);padding:20px}
.mx-modal-h{margin:0;font-size:16px;font-weight:800;color:#0d3b2e}
.mx-modal-sub{margin:8px 0 12px;font-size:12.5px;color:#626f68;line-height:1.5}
.mx-modal-list{overflow-y:auto;border:1px solid #e6ebe8;border-radius:10px}
.mx-modal-row{display:flex;gap:12px;align-items:baseline;padding:7px 12px;border-bottom:1px solid #eff3f1;font-size:12.5px}
.mx-modal-row:last-child{border-bottom:0}
.mx-modal-day{flex:0 0 62px;font-weight:800;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#626f68;font-variant-numeric:tabular-nums}
.mx-modal-time{flex:0 0 74px;font-weight:700;color:#12241d;font-variant-numeric:tabular-nums}
.mx-modal-field{min-width:0;color:#566661}
.mx-modal-act{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}
.mx-btn.is-gold-solid{border-color:#8a6300;background:#8a6300;color:#fff}
.mx-legend{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:16px;padding-top:14px;border-top:1px solid #eff3f1}
.mx-leg{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:#566661;font-weight:600}
.mx-legn{font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;color:#12241d;background:#eef3f0;border:1px solid #e2eae5;border-radius:999px;padding:1px 7px;margin-left:2px}
.mx-legn.is-zero{color:#626f68}
.mx-sw{width:22px;height:14px;border-radius:4px;border:1px solid #e2ebe6;background:#f3f7f4;flex:0 0 auto}
.mx-sw.sw-ch{background:#fff;border:2px solid #d9a521}
.mx-sw.sw-md{background:#fff;border:2px solid #12704a}
.mx-toasttip{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#0d3b2e;color:#fff;font-size:12.5px;font-weight:600;padding:9px 16px;border-radius:999px;z-index:80;animation:mxfade 3.2s forwards}
@keyframes mxfade{0%,88%{opacity:1}100%{opacity:0}}
`;
