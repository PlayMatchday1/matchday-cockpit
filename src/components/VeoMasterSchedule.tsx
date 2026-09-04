"use client";

// Master Schedule — Veo coverage (spec: mockups/veo-v1.html).
//
// Two views over one week of the fleet:
//   Schedule     — per city, a 7-day grid of match cards; a Veo-marked card
//                  inverts to the dark forest card with a yellow camera chip.
//                  Toggling the chip persists camera INTENT (POST /api/veo/intent).
//   Veo coverage — the week as one grid (rows = cameras, cols = 7 days) plus a
//                  worklist diff between Clubhouse intent and the 🎥 app emoji.
//
// Data comes from GET /api/veo (VeoWeek). Mutations POST /api/veo/intent and
// /api/veo/cameras, then refetch so counters + grid + worklist update without a
// page reload. The whole VeoWeek lives in state; every derived number is
// recomputed from it. The raw MatchDay name (which may carry a 🎥) is never
// rendered — the API delivers an already emoji-stripped `name`, and `hasEmoji`
// carries the emoji fact separately.
//
// The three grid states stay QUIET→LOUD and are NOT inverted: covered is a faint
// mint wash (the norm), an idle owned camera is a hairline em-dash, an open
// city-day is a loud coral cell (the to-do). The dark inversion lives only on the
// Schedule cards, where a Veo match is the exception among many.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nameForVeo } from "@/lib/veoNameSync";
import { useAuth, canEditMatches } from "@/lib/useAuth";
import { isConfined } from "@/lib/cityConfinement";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { supabase } from "@/lib/supabase";
import { usePhone } from "@/lib/usePhone";
// THE SERVER'S OWN RESOLVERS, called on the client. venueResolver is pure — no supabase, no
// fetch, no async — so the two cannot disagree about what a venue is called.
import { canonicalVenueName } from "@/lib/venueResolver";
import { CITY_SCOPES } from "@/lib/cityScope";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";
import { downloadCsv, plural } from "@/components/growth/format";
import RefreshIcon from "@/components/RefreshIcon";
import { buildCopyBody, copyConfirmLine, type SourceMatch } from "@/lib/copyMatch";
import {
  buildMonthGrid, applyFilters, fieldsAvailable, reconcileFields, fieldCountLabel,
  defaultRange, rangeTitle, priceLabel, shiftRangeMonth, countLabel, fillTone,
  fieldCounts, busiestDay, isoDow,
  type GridDay, type GridMatch,
} from "@/lib/monthGrid";
import MatchDrawer, { DRAWER_W, type DrawerMatch } from "@/components/MatchDrawer";
import type { DrawerPatch } from "./MatchDrawer";

type VeoDay = { dow: string; date: number; iso: string; today: boolean };
type VeoCity = { city: string; cameras: number };
type VeoMatch = {
  apiId: number; city: string; dayIdx: number; time: string; minutes: number;
  venue: string; name: string; rawName: string; veo: boolean; hasEmoji: boolean;
};
type VeoCode = { code: string; confirmed: boolean };
type VeoCodesRef = { city: string; codes: VeoCode[] };
type VeoWeek = {
  weekStart: string;
  days: VeoDay[];
  cities: VeoCity[];
  matches: VeoMatch[];
  codesRef: VeoCodesRef[];
  seededThisWeek: number;
  generatedAt: string;
  /** max(synced_at) over the week — the DATA's age, not the read's. Null on an empty week. */
  dataAsOf: string | null;
};

type Unit = { venue: string; times: string[] };
type View = "schedule" | "veo" | "month";

/* ONE KEY FOR THE WHOLE PREFERENCE BLOB. The view, the range, the city and the field selection are
 * read and written together — four keys would let them drift out of step on a partial write. */
const VMS_PREFS = "vms:prefs";

// ── derived helpers (pure over VeoWeek) ─────────────────────────────────────
const camerasOf = (w: VeoWeek, city: string) => w.cities.find((c) => c.city === city)?.cameras ?? 0;
const veoMatchesOf = (w: VeoWeek, city: string) => w.matches.filter((m) => m.city === city && m.veo);
const cityCode = (city: string) => city.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase();

// A city-day needs one camera per DISTINCT VENUE (two matches at one venue are
// back-to-back on one camera). One row per owned camera ALWAYS — an idle second
// camera is still a row. More distinct venues on a night than cameras owned adds
// rows, flagged over capacity.
function unitsFor(w: VeoWeek, city: string): (Unit | null)[][] {
  const owned = camerasOf(w, city);
  const ms = veoMatchesOf(w, city);
  const byDay: Unit[][] = w.days.map((_, d) => {
    const dayMs = ms.filter((m) => m.dayIdx === d).sort((a, b) => a.minutes - b.minutes);
    const venues = [...new Set(dayMs.map((m) => m.venue))];
    return venues.map((v) => ({ venue: v, times: dayMs.filter((m) => m.venue === v).map((m) => m.time) }));
  });
  // At least one row so every fleet city surfaces (its Open/idle days show).
  const width = Math.max(1, owned, ...byDay.map((x) => x.length));
  return Array.from({ length: width }, (_, i) => byDay.map((day) => day[i] ?? null));
}

type Stats = { covered: number; total: number; used: number; capacity: number; gaps: number; over: number };
function computeStats(w: VeoWeek): Stats {
  const covered = w.matches.filter((m) => m.veo).length;
  const owned = w.cities.reduce((a, c) => a + c.cameras, 0);
  let used = 0, gaps = 0, over = 0;
  for (const { city } of w.cities) {
    const rows = unitsFor(w, city);
    const ownedC = camerasOf(w, city);
    w.days.forEach((_, d) => {
      const filled = rows.filter((r) => r[d]).length;
      if (filled === 0) gaps++; else used += filled;
      if (filled > ownedC) over++;
    });
  }
  return { covered, total: w.matches.length, used, capacity: owned * 7, gaps, over };
}

const sortMatches = (a: VeoMatch, b: VeoMatch) =>
  a.dayIdx - b.dayIdx || a.city.localeCompare(b.city) || a.minutes - b.minutes;

const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

// Shift a Monday (YYYY-MM-DD) by whole weeks, returning the new Monday. Parsed as
// a LOCAL date so month/year boundaries roll over correctly.
function shiftWeek(mondayIso: string, deltaWeeks: number): string {
  const [y, m, d] = mondayIso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + deltaWeeks * 7);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

// "Mon 3 – Sun 9 Aug 2026", collapsing the shared month/year; spans months/years
// when the week straddles a boundary ("Mon 30 Jun – Sun 6 Jul 2026").
function weekRangeLabel(days: VeoDay[]): string {
  if (days.length < 7) return "";
  const a = days[0], b = days[6];
  const [ay, am] = a.iso.split("-").map(Number);
  const [by, bm] = b.iso.split("-").map(Number);
  const start =
    ay !== by ? `${a.dow} ${a.date} ${MON_ABBR[am - 1]} ${ay}`
    : am !== bm ? `${a.dow} ${a.date} ${MON_ABBR[am - 1]}`
    : `${a.dow} ${a.date}`;
  const end = `${b.dow} ${b.date} ${MON_ABBR[bm - 1]} ${by}`;
  return `${start} – ${end}`;
}

// A view of the week narrowed to the selected cities (empty set = all cities).
// Both the stat tiles AND the coverage grid read from this, so the filter moves
// every number together — nothing is computed from the unfiltered week.
function filterWeek(week: VeoWeek, cities: Set<string>): VeoWeek {
  if (cities.size === 0) return week;
  return {
    ...week,
    cities: week.cities.filter((c) => cities.has(c.city)),
    matches: week.matches.filter((m) => cities.has(m.city)),
  };
}
// Match ids in the same city + day as `apiId`, ordered by time — the set the
// drawer's up/down arrows step through.
function siblingsOf(week: VeoWeek, apiId: number): number[] {
  const m = week.matches.find((x) => x.apiId === apiId);
  if (!m) return [apiId];
  return week.matches.filter((x) => x.city === m.city && x.dayIdx === m.dayIdx)
    .sort((a, b) => a.minutes - b.minutes).map((x) => x.apiId);
}

export default function VeoMasterSchedule() {
  const [week, setWeek] = useState<VeoWeek | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  // THE UNSYNCED MARKER IS SESSION STATE, NOT DERIVED STATE.
  //
  // It was derived from (flag, name) and that was wrong twice over. It cannot tell "this write
  // just failed" from "this predates the feature", so it flagged 38 historical rows nobody
  // touched — matches toggled through Clubhouse before the name write existed. And because
  // /api/veo reads the mdapi_matches MIRROR, which lags the write (measured: 6 of 6 landed writes
  // absent from the mirror an hour later), it also flagged every SUCCESSFUL write, which invited
  // the operator to hit Retry and send the identical name again. Three such duplicates are in
  // change_log as `notapplied`.
  //
  // Held for the life of the page: a marker means THIS page tried a write and it did not land.
  // Navigating away clears it, which is correct — the operator can toggle off and on again.
  // THE NAME WRITE GOES THROUGH THE MATCH EDIT ROUTE, so it needs EDIT MATCHES. This panel had no
  // permission check at all: a holder of Match Ops without EDIT MATCHES could toggle the chip, the
  // flag would land, and the name write would 403 into a permanent unsynced state with a Retry that
  // could never succeed. Same predicate the route enforces.
  const { appUser } = useAuth();
  /* A CONFINED ACCOUNT SEES ONE CITY, so two controls stop meaning anything.
   * The chip row is REMOVED, not defaulted and not disabled — a filter that cannot change the
   * answer is not a filter.
   *
   * VEO COVERAGE IS NOT DISABLED. It was, briefly, on my reasoning that Warsaw has no camera —
   * inferred from an absent veo_codes row and a missing fin_venue_fields link. That inference was
   * WRONG: Warsaw has a camera and those absences are a data gap. Reasoning from missing data to a
   * missing thing is the same mistake twice tonight. */
  const confined = isConfined(appUser);
  const mayWriteName = canEditMatches(appUser);
  const [nameFailed, setNameFailed] = useState<Map<number, string>>(new Map());
  // WHAT WE ACTUALLY WROTE, so the next toggle diffs against reality rather than the lagging
  // mirror. Without this, toggling on then straight off computes from the stale (un-emoji'd) name,
  // finds no 🎥 to strip, sends nothing, and leaves the camera on a match whose flag is off.
  const [wroteName, setWroteName] = useState<Map<number, string>>(new Map());
  /* THE VIEW AND THE FILTERS SURVIVE A RELOAD. Read in an effect rather than in the initialiser:
   * this component renders on the server first, and touching localStorage there throws. */
  const [view, setView] = useState<View>("schedule");
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [monthData, setMonthData] = useState<{ matches: GridMatch[]; dataAsOf: string | null } | null>(null);
  /* CANCELLED IS OFF BY DEFAULT and the label is "Show cancelled in grid" — the exact wording
   * SlateWeekSchedule.tsx:287 already uses. One control, one name, across two pages. */
  const [showCx, setShowCx] = useState(false);
  /* PHONE ONLY. Which bottom sheet is open, and which day the map has inked. Both are inert above
   * 640px because nothing renders the controls that set them. */
  const [sheet, setSheet] = useState<null | "city" | "field">(null);
  /* ── COPY ONTO PICKED DATES ────────────────────────────────────────────────────────────────
   * The month grid IS the picker. It is already a calendar of the right month, already knows
   * which days are past, and already sits under the button — a separate date control in a dialog
   * would be a second calendar disagreeing with the first about what month is showing.
   *
   * A Map of ISO date → "HH:MM", HELD ABOVE THE GRID and never on a cell, which is what lets the
   * ‹ › arrows work mid-pick and carry the picks with them. A multi-month copy is one operation. */
  const [copySrc, setCopySrc] = useState<SourceMatch | null>(null);
  const [picks, setPicks] = useState<Map<string, string>>(new Map());
  const [copyRun, setCopyRun] = useState<{ iso: string; hhmm: string; outcome: string; id?: number; error?: string }[] | null>(null);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  // IS THIS A PHONE — lib/usePhone, shared with Slate Review so the two views cannot disagree
  // about where a phone ends. Same breakpoint, same pre-paint timing, one implementation.
  const isPhone = usePhone();
  const [monthBusy, setMonthBusy] = useState(false);
  const [monthErr, setMonthErr] = useState<string | null>(null);
  const [fieldSel, setFieldSel] = useState<Set<string>>(new Set());
  const [droppedFields, setDroppedFields] = useState<string[]>([]);
  /* THE FIELD ROW'S OPEN STATE, persisted alongside the rest of the prefs blob so somebody who
   * works with the chips open is not folded up on every visit. Default closed. */
  const [fieldsOpen, setFieldsOpen] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VMS_PREFS);
      if (!raw) return;
      const p = JSON.parse(raw) as { view?: View; from?: string; to?: string; fields?: string[]; city?: string[]; fieldsOpen?: boolean };
      if (p.view === "month" || p.view === "veo" || p.view === "schedule") setView(p.view);
      if (p.from && p.to) setRange({ from: p.from, to: p.to });
      if (Array.isArray(p.fields)) setFieldSel(new Set(p.fields));
      if (Array.isArray(p.city)) setCityFilter(new Set(p.city));
      if (typeof p.fieldsOpen === "boolean") setFieldsOpen(p.fieldsOpen);
    } catch { /* private mode, or a prefs blob from an older shape — defaults are fine */ }
  }, []);
  const [busy, setBusy] = useState(false);
  // "" = current week; otherwise a date (YYYY-MM-DD) within the selected week.
  const [weekRef, setWeekRef] = useState<string>("");
  const [navBusy, setNavBusy] = useState(false);
  /* FRESHNESS. Copied in shape from Gameday Ops, and it means something WEAKER here, which the
   * button says out loud: Gameday Ops re-fetches the LIVE MatchDay API, this re-reads the
   * mdapi_matches MIRROR that one daily cron (vercel.json "0 11 * * *") refreshes. Re-reading
   * cannot make the mirror newer. What it does catch is everything that has already reached the
   * mirror since this tab was opened — another operator's edit, the cron itself, and the cancel
   * write-through — which on a tab left open for a week is the difference between a schedule and
   * a screenshot.
   *
   * NO AUTO-POLLING, same reason as Gameday Ops: the drawer edits a match in place and a
   * background refetch could move the card out from under it. Manual, plus the one automatic
   * refresh after a cancel this page itself performed. */
  const [refreshing, setRefreshing] = useState(false);
  const [resyncFail, setResyncFail] = useState<string | null>(null);
  const [staleFail, setStaleFail] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // City filter (empty = all). Drawer state. drawerDirty is reported UP by the
  // drawer so week-nav / card-switch / filter can be blocked while edits pend.
  const [cityFilter, setCityFilter] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [drawerDirty, setDrawerDirty] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ text: string; warn: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((text: string, warn = false) => {
    setToastMsg({ text, warn });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  // ref selects the week; "" asks the server for the current week. Keeps the old
  // week on screen until the new one arrives (no blanking on navigation).
  /* `repull` = "go to MatchDay first". Refresh sets it; week navigation and the initial load do
   * not — moving between weeks should be instant and does not need the source of truth. */
  async function load(ref: string, quiet = false, repull = false) {
    if (quiet) setRefreshing(true);
    setStaleFail(false);
    setResyncFail(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      /* RE-PULL THE VISIBLE WEEK FROM MATCHDAY BEFORE RE-READING. Re-reading a mirror cannot make
       * it newer; this is what makes the button mean what it says. Scoped to the week on screen
       * and skipping the roster crawl, so it is a button and not a sync.
       *
       * A FAILED RE-PULL IS SAID OUT LOUD AND THE READ STILL HAPPENS: showing the mirror is
       * better than showing nothing, but claiming it is fresh would be the original lie. */
      if (repull) {
        try {
          const q = ref ? `?week=${encodeURIComponent(ref)}` : "";
          const rs = await fetch(`/api/veo/resync${q}`, { method: "POST", headers, cache: "no-store" });
          if (!rs.ok) {
            const j = await rs.json().catch(() => ({}));
            setResyncFail(String(j?.error ?? `HTTP ${rs.status}`));
          }
        } catch (e) {
          setResyncFail(e instanceof Error ? e.message : String(e));
        }
      }

      const url = ref ? `/api/veo?week=${encodeURIComponent(ref)}` : "/api/veo";
      const res = await fetch(url, { cache: "no-store", headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as VeoWeek;
      setWeek(json);
      setError("");
    } catch {
      // A FAILED QUIET REFRESH KEEPS THE WEEK ON SCREEN and says so on the stamp. Stale data the
      // operator knows is stale beats an error where a schedule was.
      if (quiet) setStaleFail(true); else setError("Couldn't load Veo coverage. Try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
      /* THE STAMP IS NOT SET HERE ANY MORE. It used to be Date.now() on every successful fetch,
       * which reported the moment the QUERY ran and said nothing about the age of the data — the
       * button read "Updated 1:04 PM" over rows the 11:00 cron had written and nothing since.
       * It now comes from the payload's own dataAsOf (max synced_at), so it moves when the DATA
       * moved and not when the page merely asked again. */
    }
  }

  useEffect(() => { void load(""); }, []);

  /* ── THE MONTH RANGE ────────────────────────────────────────────────────────────────────────
   * Its own fetch, its own state. The week view keeps its own payload untouched, so switching to
   * Month and back leaves the week exactly as it was — no shared cache to invalidate. */
  const loadRange = useCallback(async (r: { from: string; to: string }, repull = false) => {
    setMonthBusy(true); setMonthErr(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      /* REFRESH RE-PULLS THE WHOLE VISIBLE RANGE, not just a week — one resync per week in it, so
       * the button means the same thing in Month as it does in Schedule. */
      if (repull) {
        for (let cur = r.from; cur <= r.to; ) {
          await fetch(`/api/veo/resync?week=${encodeURIComponent(cur)}`, { method: "POST", headers, cache: "no-store" })
            .catch(() => {});
          const d = new Date(`${cur}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7);
          cur = d.toISOString().slice(0, 10);
        }
      }
      const res = await fetch(`/api/veo/range?from=${r.from}&to=${r.to}`, { headers, cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setMonthData({ matches: j.matches as GridMatch[], dataAsOf: j.dataAsOf ?? null });
    } catch (e) {
      // A FAILED RANGE IS AN ERROR, never an empty grid — the two look identical otherwise.
      setMonthErr(e instanceof Error ? e.message : String(e));
    } finally { setMonthBusy(false); }
  }, []);

  // Default the range to the current calendar month the first time Month is opened.
  useEffect(() => {
    if (view !== "month" || range) return;
    setRange(defaultRange(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })));
  }, [view, range]);
  useEffect(() => { if (view === "month" && range) void loadRange(range); }, [view, range, loadRange]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VMS_PREFS, JSON.stringify({
        view, from: range?.from, to: range?.to, fields: [...fieldSel], city: [...cityFilter], fieldsOpen,
      }));
    } catch { /* private mode */ }
  }, [view, range, fieldSel, cityFilter, fieldsOpen]);

  /* ── THE FILTERED SET, AND THE CHIPS BUILT FROM IT ──────────────────────────────────────────
   * The field list comes from the matches actually in the range, so it can never offer a filter
   * with nothing behind it. When the range or the city changes, a selection that no longer has
   * matches is DROPPED and SAID — silently keeping it would filter the grid to nothing on a chip
   * the operator can no longer see. */
  const monthCity = useMemo(() => (cityFilter.size === 1 ? [...cityFilter][0] : null), [cityFilter]);
  const monthFields = useMemo(
    () => fieldsAvailable(monthData?.matches ?? [], monthCity), [monthData, monthCity]);
  useEffect(() => {
    if (view !== "month" || !monthData) return;
    const { kept, dropped } = reconcileFields(fieldSel, monthFields);
    if (dropped.length === 0) { if (droppedFields.length) setDroppedFields([]); return; }
    setFieldSel(kept); setDroppedFields(dropped);
  }, [view, monthData, monthFields, fieldSel, droppedFields.length]);

  const monthAll = useMemo(
    () => applyFilters(monthData?.matches ?? [], monthCity, fieldSel), [monthData, monthCity, fieldSel]);
  // WHAT THE GRID DRAWS. The header count is computed from this same list, so "165 matches" always
  // describes the grid underneath it rather than a set that includes rows nobody can see.
  const monthVisible = useMemo(
    () => (showCx ? monthAll : monthAll.filter((m) => !m.cancelled)), [monthAll, showCx]);
  const monthCxCount = useMemo(() => monthAll.filter((m) => m.cancelled).length, [monthAll]);
  const monthWeeks = useMemo(
    () => (range ? buildMonthGrid(range.from, range.to, monthVisible,
      new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })) : []),
    [range, monthVisible]);

  // Week navigation: shift from the displayed Monday (always a Monday), or jump
  // back to the current week. Shared by both views (it lives in the card header).
  async function navigate(ref: string) {
    if (navBusy) return;
    if (drawerDirty) { showToast("Save or revert the open match before changing weeks.", true); return; }
    setNavBusy(true);
    setWeekRef(ref);
    setDrawerId(null); // a new week's matches are different rows; close the drawer
    await load(ref);
    setNavBusy(false);
  }
  /* ── THE ARROWS STEP WHAT YOU ARE LOOKING AT ────────────────────────────────────────────────
   * These unconditionally moved `week.weekStart`. The month grid is built from `range` and never
   * reads the week, so in Month view the arrows refetched a week nobody could see, relabelled the
   * header, and left the grid exactly where it was. A week control left live in a view that does
   * not use weeks — the same fault that put a red "Not current week" flag above a September grid.
   *
   * They now write the state the visible grid is actually built from. In Month that is `range`,
   * which is also what the from/to inputs edit: ONE piece of state, two ways to set it, so the
   * two controls cannot disagree. */
  const goPrev = () => {
    if (view === "month") { if (range) setRange(shiftRangeMonth(range, -1)); return; }
    if (week) void navigate(shiftWeek(week.weekStart, -1));
  };
  const goNext = () => {
    if (view === "month") { if (range) setRange(shiftRangeMonth(range, 1)); return; }
    if (week) void navigate(shiftWeek(week.weekStart, 1));
  };
  const goToday = () => void navigate("");

  // 15s, not 30s: this drives the freshness age, and at 30s the "2 minutes" threshold could be
  // reported half a minute late — which reads as a stamp that is not ageing.
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 15000); return () => clearInterval(t); }, []);
  /* THE STAMP IS THE DATA'S AGE, NOT THE READ'S. `dataAsOf` is max(synced_at) over the week's
   * rows — the cron's write or a write-through, whichever touched one last. Pressing Refresh on a
   * week nothing has changed leaves it exactly where it was, which is the point: the button
   * reports what it found, not that it ran. */
  /* THE STAMP FOLLOWS THE VIEW. Month has its own payload and its own max(synced_at); reading the
   * week's stamp while looking at a range would report the freshness of data that is not on
   * screen. Neither moves on a no-op: both come from the DATA, not from the fetch. */
  const asOfSrc = view === "month" ? (monthData?.dataAsOf ?? null) : (week?.dataAsOf ?? null);
  const dataAsOfMs = asOfSrc ? Date.parse(asOfSrc) : null;
  const updatedAt = Number.isFinite(dataAsOfMs as number) ? (dataAsOfMs as number) : null;
  const updatedLabel = updatedAt == null ? "—" : new Date(updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  /* HOURS, NOT MINUTES. The mirror's normal age is measured from an 11:00 UTC cron, so a
   * minutes-only readout said "412m ago" by mid-afternoon on a perfectly healthy week. */
  const staleMins = updatedAt == null ? 0 : Math.floor((nowMs - updatedAt) / 60000);
  const staleLabel = staleMins >= 120 ? `${Math.floor(staleMins / 60)}h ago` : `${staleMins}m ago`;
  const doRefresh = useCallback(() => {
    if (refreshing || navBusy) return;
    // SAME MEANING IN BOTH VIEWS: re-pull the visible span from MatchDay, then re-read.
    if (view === "month" && range) { void loadRange(range, true); return; }
    void load(weekRef, true, true);
  }, [refreshing, navBusy, weekRef, view, range, loadRange]);


  async function post(url: string, body: unknown): Promise<boolean> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("No active session."); return false; }
    try {
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { setError(`HTTP ${res.status} — nothing changed.`); return false; }
      return true;
    } catch { setError("Network error — nothing changed."); return false; }
  }

  // THE NAME WRITE — the second half of the toggle, and the half players see.
  //
  // ORDER IS NOT NEGOTIABLE: the flag is the source of truth and is already flipped by the time
  // this runs. If the name write fails, the flag STAYS FLIPPED — the person meant to mark this
  // match VEO, and un-marking it behind their back would be a worse lie than an out-of-date name.
  // The chip derives "unsynced" from the two facts and offers a retry a HUMAN clicks.
  //
  // NO AUTOMATIC RETRY, EVER. There is no Idempotency-Key on this API. A duplicated name write is
  // visible to every player in that match, so a retry is a decision, not a fallback.
  //
  // THE DIFF IS THE REQUEST BODY: `changes` carries `name` and nothing else. Echoing startDate back
  // would re-shift it — those are LOCAL WALL CLOCK despite the Z suffix.
  async function writeName(apiId: number, rawName: string, enabled: boolean): Promise<{ outcome: string; sent: string } | null> {
    const edit = nameForVeo(rawName, enabled);
    if (!edit.change) return null; // NOT A CHANGE — send nothing at all.
    // Without EDIT MATCHES the request would 403. The flag still lands (the toggle is Clubhouse's
    // own record); the name simply is not written, and the chip says so rather than retrying.
    if (!mayWriteName) {
      setError("The camera flag is set. Writing the 🎥 into the match name needs EDIT MATCHES.");
      markFailed(apiId, enabled);
      return { outcome: "FAILED", sent: edit.next };
    }
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("No active session."); return { outcome: "FAILED", sent: edit.next }; }
    try {
      const res = await fetch(`/api/matchday/${FULL_EDITOR_ENV}/matches/${apiId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        // The existing match write path: admin + EDIT MATCHES, host-guarded on the parsed host,
        // recordWrite() into change_log with the old and new name, verdict from a re-read.
        body: JSON.stringify({ changes: { name: edit.next }, source: "Veo camera toggle", saveId: crypto.randomUUID() }),
      });
      const j = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
      if (!res.ok) {
        setError(`Camera mark not written to the match name: ${j.error ?? `HTTP ${res.status}`}`);
        markFailed(apiId, enabled);
        return { outcome: "FAILED", sent: edit.next };
      }
      // A 2xx IS NOT PROOF. The route classifies from a read-back; anything but `landed` is a
      // failure to surface, not a success to assume.
      const outcome = (j.outcome ?? "unknown").toUpperCase();
      if (outcome === "LANDED") {
        // Remember what landed. The mirror will not agree for a while, and the next toggle must
        // not be computed from a name we know is out of date.
        setWroteName((m) => new Map(m).set(apiId, edit.next));
        setNameFailed((m) => { const n = new Map(m); n.delete(apiId); return n; });
      } else {
        setError(`Camera mark reported ${outcome} — the match name may not have changed.`);
        markFailed(apiId, enabled);
      }
      return { outcome, sent: edit.next };
    } catch {
      setError("Network error writing the match name — the camera flag is set, the name is not.");
      markFailed(apiId, enabled);
      return { outcome: "FAILED", sent: edit.next };
    }
  }

  const markFailed = (apiId: number, enabled: boolean) =>
    setNameFailed((m) => new Map(m).set(apiId, enabled ? "the 🎥 was not added" : "the 🎥 is still there"));

  // The name this page believes MatchDay holds: what we last wrote, else the mirror's copy.
  const liveName = useCallback(
    (m: VeoMatch) => wroteName.get(m.apiId) ?? m.rawName,
    [wroteName],
  );

  // Optimistic: patch local state, POST, refetch on success / revert on failure.
  async function toggleIntent(apiId: number, enabled: boolean) {
    if (!week || busy) return;
    const snapshot = week;
    const match = week.matches.find((m) => m.apiId === apiId);
    setWeek({ ...week, matches: week.matches.map((m) => (m.apiId === apiId ? { ...m, veo: enabled } : m)) });
    setBusy(true);
    // FLAG FIRST. It is the source of truth; the name is derived from it.
    const ok = await post("/api/veo/intent", { matchApiId: apiId, enabled });
    if (ok) {
      // Then the name. A failure here does NOT roll the flag back.
      // A new attempt supersedes whatever the last one reported.
      setNameFailed((m) => { const n = new Map(m); n.delete(apiId); return n; });
      if (match) await writeName(apiId, liveName(match), enabled);
      await load(weekRef); // refetch the DISPLAYED week, not "now" — re-derives the synced state
    } else {
      setWeek(snapshot);
    }
    setBusy(false);
  }

  // The manual retry behind the unsynced chip. Same single write, no flag change, still no
  // automatic anything — it exists only because a person clicked it.
  // THE RETRY RUNS THE SAME TRANSFORM AND THE SAME NO-OP GUARD AS THE TOGGLE.
  //
  // The three `notapplied` rows on match 17956 were this path re-sending a name that was already
  // correct. The guard was not missing — writeName has always refused a no-change edit — it was
  // being fed a STALE name: rawName came from the mdapi_matches mirror, which lags the write, so
  // the transform saw a name with no 🎥 and computed a prefix that had already been applied.
  //
  // Two things close it. liveName() feeds the transform what we actually wrote, not the mirror's
  // copy. And a no-change decision now CLEARS the marker and says why, instead of returning
  // quietly and leaving a warning dot above a button that does nothing when clicked.
  async function retryName(apiId: number) {
    if (!week || busy) return;
    const match = week.matches.find((m) => m.apiId === apiId);
    if (!match) return;
    setError("");
    const edit = nameForVeo(liveName(match), match.veo);
    if (!edit.change) {
      // Already correct. No request, no change_log row — and the marker was stale, so it goes.
      setNameFailed((m) => { const n = new Map(m); n.delete(apiId); return n; });
      setError("The match name is already correct — nothing to write.");
      return;
    }
    setBusy(true);
    await writeName(apiId, liveName(match), match.veo);
    await load(weekRef);
    setBusy(false);
  }
  async function setCameras(city: string, cameras: number) {
    if (!week || busy || cameras < 0) return;
    const snapshot = week;
    setWeek({ ...week, cities: week.cities.map((c) => (c.city === city ? { ...c, cameras } : c)) });
    setBusy(true);
    const ok = await post("/api/veo/cameras", { city, cameras });
    if (ok) await load(weekRef); else setWeek(snapshot);
    setBusy(false);
  }

  // The week narrowed to the selected cities — stats AND coverage both read it.
  const fweek = useMemo<VeoWeek | null>(() => (week ? filterWeek(week, cityFilter) : null), [week, cityFilter]);
  const stats = useMemo<Stats | null>(() => (fweek ? computeStats(fweek) : null), [fweek]);
  // The displayed week contains the real "today" only when the server flagged one
  // of its days — the definitive "are we on the current week?" signal.
  const isCurrentWeek = week ? week.days.some((d) => d.today) : false;

  // ── drawer + filter handlers ──────────────────────────────────────────────
  const drawerCity = useMemo(() => (drawerId != null && week ? week.matches.find((m) => m.apiId === drawerId)?.city ?? null : null), [drawerId, week]);
  const drawerVeo = useMemo(() => (drawerId != null && week ? !!week.matches.find((m) => m.apiId === drawerId)?.veo : false), [drawerId, week]);
  const drawerSiblings = useMemo(() => (drawerId != null && week ? siblingsOf(week, drawerId) : []), [drawerId, week]);
  /* ── COPY MATCH ─────────────────────────────────────────────────────────────────────────────
   * It used to navigate to /matches/new?from=N — a form to fill in, which is not a copy. Now it
   * reads the source, asks once, creates an identical match, and opens the editor on the NEW one.
   *
   * THE COPY IS LIVE THE MOMENT IT IS CONFIRMED. A player can register against it before the date
   * is changed. That is the accepted tradeoff — there is deliberately no draft state, because a
   * draft is a second lifecycle for a match and the API has none. */
  const [copyBusy, setCopyBusy] = useState(false);
  /* ── STEP ONE: READ THE SOURCE, THEN HAND THE GRID OVER ────────────────────────────────────
   * The source is read LIVE from the API, not off the grid payload: the grid carries five fields
   * and a copy needs all 27. Reading the mirror would copy whatever the last sync happened to
   * hold. Unchanged from the single-copy flow — only what happens next is new. */
  const enterCopy = useCallback(async () => {
    if (drawerId == null || copyBusy) return;
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { showToast("No active session — sign in again.", true); return; }
    setCopyBusy(true);
    try {
      const sres = await fetch(`/api/matchday/production/matches/${drawerId}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const sj = await sres.json();
      if (!sres.ok) { showToast(`Couldn't read the match to copy: ${sj?.error ?? sres.status}`, true); return; }
      setCopySrc((sj.match ?? sj) as SourceMatch);
      setPicks(new Map());
      setCopyRun(null);
      setDrawerId(null);          // the drawer would cover the calendar you are about to pick on
    } catch (e) {
      showToast(`Couldn't read the match to copy: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally { setCopyBusy(false); }
  }, [drawerId, copyBusy, showToast]);

  const exitCopy = useCallback(() => { setCopySrc(null); setPicks(new Map()); }, []);

  /** The source's own time, which every picked date opens at. */
  const srcHHMM = typeof copySrc?.startDate === "string" ? String(copySrc.startDate).slice(11, 16) : "";

  const togglePick = useCallback((iso: string) => {
    setPicks((prev) => {
      const n = new Map(prev);
      if (n.has(iso)) n.delete(iso); else n.set(iso, srcHHMM);
      return n;
    });
  }, [srcHHMM]);

  /* ── STEP TWO: THE WRITES, ONE AT A TIME ───────────────────────────────────────────────────
   * SEQUENTIAL, awaited. Not Promise.all. There is no Idempotency-Key on this API and a write is
   * never retried, so firing four creates together makes a partial failure un-attributable —
   * exactly the condition the create route was written to avoid.
   *
   * NOTHING IS EVER RETRIED, automatically or on a timer. A second press is a fresh operator
   * decision, not a retry. */
  const runCopies = useCallback(async () => {
    if (!copySrc || picks.size === 0 || copyBusy) return;
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { showToast("No active session — sign in again.", true); return; }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    setCopyBusy(true);
    const out: { iso: string; hhmm: string; outcome: string; id?: number; error?: string }[] = [];
    setCopyRun([]);
    try {
      for (const [iso, hhmm] of [...picks.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        try {
          const res = await fetch(`/api/matchday/production/matches/create`, {
            method: "POST", headers,
            body: JSON.stringify({
              match: buildCopyBody(copySrc, { iso, hhmm }),
              source: "Master Schedule · copy to dates",
              /* allowDuplicate STAYS. A day that already holds the fixture is SHOWN, not refused —
               * the preview row lands in the same cell two rows under the existing match, so the
               * collision is visible at pick time, before anything is written, which is a better
               * place for it than a 409 afterwards. */
              allowDuplicate: true,
            }),
          });
          const j = await res.json();
          if (res.ok && j.outcome === "LANDED" && j.id) {
            out.push({ iso, hhmm, outcome: "LANDED", id: Number(j.id) });
            // THE VEO FLAG IS CLUBHOUSE-SIDE — a second write, best-effort, exactly as before.
            if (drawerVeo) {
              await fetch("/api/veo/intent", { method: "POST", headers,
                body: JSON.stringify({ matchApiId: j.id, enabled: true }) }).catch(() => {});
            }
          } else if (j.outcome === "UNKNOWN") {
            out.push({ iso, hhmm, outcome: "UNKNOWN", error: j.error ?? "the route could not read back what it wrote" });
          } else {
            out.push({ iso, hhmm, outcome: "FAILED", error: j.error ?? `HTTP ${res.status}` });
          }
        } catch (e) {
          // A THROW IS UNKNOWN, NOT FAILED. It may have landed; the route could not tell us.
          out.push({ iso, hhmm, outcome: "UNKNOWN", error: e instanceof Error ? e.message : String(e) });
        }
        setCopyRun([...out]);
      }
      /* NO EDITOR OPENS. Four matches cannot share one drawer, and the old flow opened it only
       * because there was exactly one copy. The grid re-reads WITHOUT repull — the data is already
       * right in Clubhouse, and a repull would resync every week in the range for writes just made. */
      if (view === "month" && range) await loadRange(range);
      else await load(weekRef, true);
      setPicks(new Map());
      setCopySrc(null);
    } finally { setCopyBusy(false); }
  }, [copySrc, picks, copyBusy, drawerVeo, view, range, loadRange, weekRef, showToast]);


  const openCard = useCallback((id: number) => {
    if (drawerId != null && drawerId !== id && drawerDirty) { showToast("Save or revert the open match first.", true); return; }
    setDrawerId(id);
  }, [drawerId, drawerDirty, showToast]);

  const closeDrawer = useCallback(() => { setDrawerId(null); setDrawerDirty(false); }, []);

  /* ── AFTER A SAVE: PATCH THE ONE CARD, IN BOTH GRIDS ─────────────────────────────────────────
   * Never refetch the whole week — that property is right and a round trip per save would be a
   * regression. What was missing is that this only ever touched `week`, so a save made from Month
   * left that grid on the old values; and the payload carried four fields while the month cell
   * renders price, capacity, players and a cancelled flag, so even in the week view a price edit
   * did not show.
   *
   * TWO CASES A PATCH CANNOT EXPRESS, and both re-read instead:
   *   the DATE MOVED — the month grid buckets by `date`, so the match must leave one cell and
   *     appear in another, or leave the visible range entirely; patching in place would draw it
   *     on the wrong day;
   *   the match was CANCELLED — whether it is drawn at all depends on the "Show cancelled"
   *     toggle, and the header's cancelled count has to move.
   *
   * The re-read is loadRange(range) WITHOUT repull. The data is already correct in Clubhouse the
   * moment the save returns; only the local copy is stale, and a repull would fire a resync per
   * week across the whole range for a change you just made yourself. */
  const patchCard = useCallback((id: number, patch: DrawerPatch) => {
    const hhmm = patch.startDate ? patch.startDate.slice(11, 16) : "";
    const newDate = patch.startDate ? patch.startDate.slice(0, 10) : "";
    /* ── THE PATCH SPEAKS THE API'S VOCABULARY; THE GRID SPEAKS ITS OWN ──────────────────────
     * The saved record carries the RAW field title and the API's city name. The grid holds the
     * CANONICAL venue (veoSchedule runs canonicalVenueName on the way in) and a DISPLAY city
     * (CITY_CODE_TO_DISPLAY). Writing the API's strings straight in made the match unmatchable by
     * the very filters built from those columns: with the STAR chip selected, `venue` became
     * "STAR Soccer Complex" and fields.has("STAR") was false, so the match vanished from the grid
     * and the header count dropped by one until a refresh re-read the canonical name.
     *
     * BOTH GO THROUGH THE SHARED RESOLVERS, so client and server cannot disagree about what a
     * place is called. canonicalVenueName is pure — no supabase, no fetch, no async — which is
     * what makes calling the server's own function here legitimate rather than a hand-rolled
     * shortening rule.
     *
     * THE CITY NEEDED IT TOO, and it is not hypothetical: measured against the live detail route,
     * DFW returns "Dallas / Fort Worth" where the grid holds "Dallas", and OKC returns
     * "Oklahoma City" where the grid holds "OKC". Two of the seven disagree. CITY_SCOPES maps the
     * API's name to the identifier and CITY_CODE_TO_DISPLAY maps that to the grid's — the same two
     * tables the rest of the app uses. */
    const gridVenue = (raw: string | null) => (raw ? canonicalVenueName(raw) : null);
    const gridCity = (apiName: string | null) => {
      if (!apiName) return null;
      const scope = CITY_SCOPES.find((c) => c.name === apiName);
      return scope ? (CITY_CODE_TO_DISPLAY[scope.identifier] ?? apiName) : apiName;
    };
    const venue = gridVenue(patch.venue);
    const city = gridCity(patch.city);

    setWeek((w) => {
      if (!w) return w;
      return {
        ...w,
        matches: w.matches.map((m) => {
          if (m.apiId !== id) return m;
          const time = hhmm || m.time;
          const [H, M] = time.split(":").map(Number);
          const h12 = `${(H % 12) || 12}:${String(M).padStart(2, "0")} ${H >= 12 ? "PM" : "AM"}`;
          return { ...m, name: patch.name || m.name, time: h12, minutes: H * 60 + M, venue: venue || m.venue, city: city || m.city };
        }),
      };
    });

    const moved = !!newDate && monthData?.matches.some((m) => m.apiId === id && m.date !== newDate);
    // BOTH SIDES COERCED. patch.cancelled is a real boolean today, but one changed caller away
    // from `false !== undefined` being permanently true — which would fire loadRange on every save.
    const cancelChanged = monthData?.matches.some((m) => m.apiId === id && !!m.cancelled !== !!patch.cancelled);
    if ((moved || cancelChanged) && range) { void loadRange(range); return; }

    setMonthData((d) => {
      if (!d) return d;
      return {
        ...d,
        matches: d.matches.map((m) => {
          if (m.apiId !== id) return m;
          const [H, M] = (hhmm || "00:00").split(":").map(Number);
          return {
            ...m,
            name: patch.name || m.name,
            venue: venue || m.venue,
            city: city || m.city,
            ...(hhmm ? { time: `${(H % 12) || 12}:${String(M).padStart(2, "0")} ${H >= 12 ? "PM" : "AM"}`, minutes: H * 60 + M } : {}),
            /* ?? m.x, NOT x. These were assigned unconditionally, so a null from the route wiped a
               value the cell was rendering. An absent field means UNCHANGED, not "now empty". */
            price: patch.price ?? m.price,
            capacity: patch.capacity ?? m.capacity,
            minPlayers: patch.minPlayers ?? m.minPlayers,
            cancelled: patch.cancelled ?? m.cancelled,
          };
        }),
      };
    });
  }, [monthData, range, loadRange]);

  // City filter toggle. Selecting/deselecting a chip; empty set = all. If the open
  // drawer's city drops out of view, the drawer closes.
  const toggleCity = useCallback((city: string | null) => {
    setCityFilter((prev) => {
      let next: Set<string>;
      if (city === null) next = new Set(); // "All cities"
      else { next = new Set(prev); if (next.has(city)) next.delete(city); else next.add(city); }
      const visible = next.size === 0 || (drawerCity != null && next.has(drawerCity));
      if (drawerId != null && drawerCity != null && !visible) {
        if (drawerDirty) showToast(`Discarded unsaved changes to match ${drawerId}.`, true);
        setDrawerId(null); setDrawerDirty(false);
      }
      return next;
    });
  }, [drawerCity, drawerId, drawerDirty, showToast]);

  // Worklist diff — two DISJOINT sections.
  const { needEmoji, needClubhouse } = useMemo(() => {
    if (!week) return { needEmoji: [] as VeoMatch[], needClubhouse: [] as VeoMatch[] };
    return {
      needEmoji: week.matches.filter((m) => m.veo && !m.hasEmoji).sort(sortMatches),
      needClubhouse: week.matches.filter((m) => !m.veo && m.hasEmoji).sort(sortMatches),
    };
  }, [week]);

  function exportWorklist() {
    if (!week) return;
    const dayLabel = (i: number) => { const d = week.days[i]; return d ? `${d.dow} ${String(d.date).padStart(2, "0")}` : "—"; };
    const rows: (string | number)[][] = [["Add the camera emoji"], ["Day", "City", "Venue", "Time", "Match name"]];
    for (const m of needEmoji) rows.push([dayLabel(m.dayIdx), m.city, m.venue, m.time, m.name]);
    rows.push([]);
    rows.push(["Marked in the app but not in Clubhouse"], ["Day", "City", "Venue", "Time", "Match name"]);
    for (const m of needClubhouse) rows.push([dayLabel(m.dayIdx), m.city, m.venue, m.time, m.name]);
    downloadCsv(`veo-worklist-${week.weekStart}.csv`, rows);
  }

  const drawerOpen = drawerId != null;

  return (
    <div className="vms" style={drawerOpen ? { maxWidth: "none", marginLeft: 0, marginRight: DRAWER_W } : undefined}>
      <style>{CSS}</style>

      <div className="vms-card">
        <div className="vms-head">
          <div>
            <div className="vms-h-title">Master Schedule</div>
            <div className="vms-h-sub">Mark the matches a Veo camera will cover, then switch to Veo coverage to see the week as one grid — which nights are covered, which are open, and where a camera is idle or short. Click a match to edit it.</div>
          </div>
          <div className="vms-h-right">
            {/* MONTH GETS A MONTH NAV. Not the week nav with different handlers — the week range
                label and the "Not current week" flag are statements about a week, and neither is
                true or even meaningful above a month grid. They do not render here at all. */}
            {view === "month" && (
              <div className="vms-wknav vms-wknav-month" data-testid="month-nav">
                <button type="button" className="vms-navbtn" onClick={goPrev} disabled={monthBusy}
                  aria-label="Previous month" title="Previous month">‹</button>
                <div className="vms-wklabel">
                  <span className="vms-wkrange" data-testid="month-nav-title">{range ? rangeTitle(range.from, range.to) : ""}</span>
                  <span className="vms-wktag vms-wktag-now">Month</span>
                </div>
                <button type="button" className="vms-navbtn" onClick={goNext} disabled={monthBusy}
                  aria-label="Next month" title="Next month">›</button>
              </div>
            )}
            {view !== "month" && week && (
              <div className="vms-wknav" aria-busy={navBusy}>
                <button type="button" className="vms-navbtn" onClick={goPrev} disabled={navBusy} aria-label="Previous week" title="Previous week">‹</button>
                <div className={"vms-wklabel" + (isCurrentWeek ? "" : " vms-wklabel-away")}>
                  <span className="vms-wkrange">{weekRangeLabel(week.days)}</span>
                  <span className={"vms-wktag" + (isCurrentWeek ? " vms-wktag-now" : "")}>{isCurrentWeek ? "This week" : "Not current week"}</span>
                </div>
                <button type="button" className="vms-navbtn" onClick={goNext} disabled={navBusy} aria-label="Next week" title="Next week">›</button>
                {/* JUMP TO A WEEK. Same pattern and same reasoning as GamedayBoard's day picker —
                    see the comment on `day-pick` there, which is written out in full. The short of
                    it is that this control does NO date arithmetic: <input type="date"> yields
                    "YYYY-MM-DD", fetchVeoWeek snaps ANY date inside a week to that week's Monday,
                    and the value goes straight into navigate() — the same function ‹ › and Today
                    call. No parse, no format, no new Date(), so the picker and the arrows cannot
                    disagree about which week is showing: they are one state and one setter.

                    THE VALUE IS week.weekStart, NOT weekRef. weekRef is "" for the current week
                    and would render an empty box; weekStart is the displayed week's Monday, which
                    is always a real date. It is also why picking a Wednesday visibly SNAPS: the
                    server answers with that week's Monday and the input re-renders holding it.

                    NOT <input type="week">. It is the semantically right control and Safari
                    degrades it to a plain text box with no warning, which is worse than a day
                    picker doing a week's job. */}
                <input type="date" className="vms-wkpick" data-testid="week-pick" aria-label="Jump to a week"
                  title="Jump to the week containing this date" disabled={navBusy}
                  value={week.weekStart} onChange={(e) => { if (e.target.value) void navigate(e.target.value); }} />
                <button type="button" data-testid="today" className={"vms-btn vms-todaybtn" + (isCurrentWeek ? "" : " vms-todaybtn-hot")} onClick={goToday} disabled={navBusy || isCurrentWeek} title="Jump to the current week">Today</button>
                {/* REFRESH + FRESHNESS. THE TITLE WAS TRUE AND IS NOT ANY MORE, so it changed with the
                    behaviour: it used to say this button re-reads the mirror and does not fetch
                    MatchDay, which was honest about a button that could not deliver freshness. It
                    now re-pulls the visible week from MatchDay first (POST /api/veo/resync), so
                    "Refresh the schedule" is finally what it does.

                    THE STAMP CHANGED WITH IT. It read "Updated <read time>" — the moment the query
                    ran, which said nothing about the age of the data and moved on every press,
                    including presses that fetched nothing. It now reads "Data as of <max
                    synced_at>" and only moves when the DATA did. */}
              </div>
            )}
            {/* ── COPY RENDERS IN EVERY VIEW, for the same reason Refresh does. It sat inside the
                `view !== "month"` branch, so Month — the view with a calendar in it, the one place
                a date picker belongs — was the one view without it. */}
            {/* IT CREATES LIVE. This comment used to say the button "navigates to the create
                form and writes nothing; the copy exists only in that form until Create is
                pressed" — untrue since the rewrite, and a comment describing the opposite of
                the code is worse than none. Copy now hands the grid over as a date picker and
                the writes happen on Create, one per picked date. */}
            {/* THE BUTTON NAMES THE MATCH IT WILL COPY, because on a 163-match month grid the
                selected card can be scrolled out of sight — and it ends in "to…" so it reads
                as a step, not as the write. */}
            <button
              type="button"
              data-testid="copy-match"
              className="vms-btn"
              disabled={drawerId == null || copyBusy}
              title={drawerId == null ? "Select a match first" : `Copy match ${drawerId} onto the dates you pick`}
              onClick={() => void enterCopy()}
            >
              {copyBusy ? "Reading…" : drawerId == null ? "Select a match first" : `Copy match ${drawerId} to…`}
            </button>

            {/* ── REFRESH RENDERS IN EVERY VIEW ─────────────────────────────────────────────────
                doRefresh has always branched for Month — `if (view === "month" && range) { void
                loadRange(range, true); return; }` — and loadRange's own comment says the button is
                meant to mean the same thing there. It simply sat inside the `view !== "month"`
                branch above, so Month never rendered it. The behaviour was built; only the control
                was missing.

                THE STAMP ALREADY READS THE RIGHT CLOCK: asOfSrc picks monthData.dataAsOf in Month
                and the week's everywhere else, so moving the block does not make Month show the
                week's timestamp. */}
            <span className="vms-fresh" data-testid="fresh">
                  <button type="button" className="vms-refresh" data-testid="vms-refresh"
                    disabled={refreshing || navBusy || monthBusy} aria-label="Refresh the schedule from MatchDay"
                    title={view === "month"
                      ? "Refresh the schedule. Re-pulls every week in this range from MatchDay into Clubhouse, then re-reads it — so an edit made anywhere shows up without waiting for the nightly sync."
                      : "Refresh the schedule. Re-pulls this week from MatchDay into Clubhouse, then re-reads it — so an edit made anywhere shows up without waiting for the nightly sync."}
                    onClick={doRefresh}>
                    <RefreshIcon size={14} spinning={refreshing} />
                    <span className="vms-rlab">{refreshing ? "Refreshing…" : "Refresh"}</span>
                  </button>
                  <span className={"vms-stamp" + (staleFail ? " vms-stamp-failed" : staleMins >= 2 ? " vms-stamp-stale" : "")} data-testid="updated-at">
                    {staleFail ? `Couldn't refresh · showing ${updatedLabel}`
                      : resyncFail ? `Couldn't reach MatchDay · showing data from ${updatedLabel}`
                      : updatedAt == null ? "Loading…"
                      : staleMins >= 2 ? `Data as of ${updatedLabel} · ${staleLabel}`
                      : `Data as of ${updatedLabel}`}
                  </span>
                </span>
            <span className="vms-control-label">View</span>
            <div className="vms-segmented" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === "schedule"} className={"vms-seg-btn" + (view === "schedule" ? " vms-active" : "")} onClick={() => setView("schedule")}>Schedule</button>
              <button type="button" role="tab" aria-selected={view === "veo"} data-testid="view-veo"
                className={"vms-seg-btn" + (view === "veo" ? " vms-active" : "")}
                onClick={() => setView("veo")}>Veo coverage</button>
              <button type="button" role="tab" aria-selected={view === "month"} data-testid="view-month"
                className={"vms-seg-btn" + (view === "month" ? " vms-active" : "")}
                onClick={() => setView("month")}>Month</button>
            </div>
          </div>
        </div>

        {/* The month modifier exists so the phone layout can hide THIS row without touching the
            week view's copy of it — the row is shared by all three views. */}
        {!confined && week && week.cities.length > 0 && (
          <div className={"vms-filter" + (view === "month" ? " vms-filter-month" : "")}
            data-testid="city-filter" role="group" aria-label="Filter cities">
            <span className="vms-control-label">Cities</span>
            <button type="button" data-testid="city-chip-all" aria-pressed={cityFilter.size === 0}
              className={"vms-chip" + (cityFilter.size === 0 ? " vms-chip-on" : "")} onClick={() => toggleCity(null)}>All cities</button>
            {week.cities.map(({ city }) => (
              <button type="button" key={city} data-testid={`city-chip-${city}`} aria-pressed={cityFilter.has(city)}
                className={"vms-chip" + (cityFilter.has(city) ? " vms-chip-on" : "")} onClick={() => toggleCity(city)}>{city}</button>
            ))}
          </div>
        )}

        {/* Stats live BEHIND the Veo coverage view only. On Schedule they are not
            rendered at all — the schedule is for editing, not the coverage read-out. */}
        {view === "veo" && stats && (
          <div className="vms-stats" data-testid="stats">
            <Stat l="Matches with Veo" v={stats.covered} f={`of ${stats.total} this week`} />
            <Stat l="Camera nights used" v={stats.used} f={`of ${stats.capacity} available · ${stats.capacity ? Math.round((stats.used / stats.capacity) * 100) : 0}%`} />
            <Stat l="Open nights" v={stats.gaps} f="city-days with matches, no camera" />
            <Stat l="Over capacity" v={stats.over} f={stats.over ? "more venues than cameras owned" : "none"} />
          </div>
        )}
      </div>

      {loading && !week ? (
        <div className="vms-card"><div className="vms-state">Loading Veo coverage…</div></div>
      ) : error && !week ? (
        <div className="vms-card"><div className="vms-state">{error} <button type="button" className="vms-btn" onClick={() => { setLoading(true); void load(weekRef); }}>Retry</button></div></div>
      ) : view === "month" ? (
        <>
          {/* THE RANGE AND THE FIELD CHIPS. Only in Month — the week view's own controls are
              untouched, which is what keeps "switch to Month and back" a no-op. */}
          {/* ── THE PHONE BAR ─────────────────────────────────────────────────────────────────
              TWO buttons and a switch. Below 640px the wrapped chip rows above are 491px of
              screen — 59% of a 390px phone — before a match is on it, and the field the operator
              is filtering on is the thing the grid then drops.

              TWO, NOT THREE, AND THE ARITHMETIC IS WHY. Three equal buttons across 350px give each
              112px, leaving 77px for a label plus a count badge, and "All fields" with a 23 badge
              is 89px. A third dropdown here truncates its own label, which is the grid's crime one
              row higher up. Cancelled is a BOOLEAN, not a picker: it belongs on the line that
              already states what is on screen, and moving it is what buys the other two the width
              to say what they mean. */}
          {isPhone && (
          <div className="vms-card vms-mob" data-testid="month-mobile-bar">
            <div className="vms-mobnav">
              <button type="button" className="vms-mobnavb" onClick={goPrev} aria-label="Previous month">‹</button>
              <div className="vms-mobtitle" data-testid="mob-title">{range ? rangeTitle(range.from, range.to) : ""}</div>
              <button type="button" className="vms-mobnavb" onClick={goNext} aria-label="Next month">›</button>
              <button type="button" className="vms-mobtoday"
                onClick={() => setRange(defaultRange(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })))}>
                Today
              </button>
            </div>
            <div className="vms-mobfbar">
              <button type="button" className={"vms-mobfb" + (monthCity ? " on" : "")}
                data-testid="mob-city" onClick={() => setSheet("city")}>
                <span className="lab">{monthCity ?? "All cities"}</span>
                <span className="car" aria-hidden>▼</span>
              </button>
              <button type="button" className={"vms-mobfb" + (fieldSel.size > 0 ? " on" : "")}
                data-testid="mob-field" onClick={() => setSheet("field")}>
                <span className="lab">{fieldSel.size > 0 ? "Fields" : "All fields"}</span>
                <span className="n">{fieldSel.size > 0 ? `${fieldSel.size} of ${monthFields.length}` : String(monthFields.length)}</span>
                <span className="car" aria-hidden>▼</span>
              </button>
            </div>
            <div className="vms-mobsum">
              <span className="txt" data-testid="mob-summary">
                <b>{monthBusy ? "…" : `${monthVisible.length} match${monthVisible.length === 1 ? "" : "es"}`}</b>
                {" · "}{monthCity ?? "all cities"}{" · "}{fieldCountLabel(fieldSel, monthFields)}
              </span>
              {monthCxCount > 0 && (
                <button type="button" className={"vms-mobcx" + (showCx ? " on" : "")}
                  data-testid="mob-showcx" aria-pressed={showCx} onClick={() => setShowCx((v) => !v)}>
                  <i aria-hidden /> {monthCxCount} cancelled
                </button>
              )}
            </div>
            {/* A DROPPED FILTER IS SAID HERE TOO — it is said on the desktop bar, and that bar is
                not on screen at this width. */}
            {droppedFields.length > 0 && (
              <div className="vms-mobdrop" data-testid="mob-dropped">
                {droppedFields.join(", ")} {droppedFields.length === 1 ? "has" : "have"} no matches in this range — removed from the filter
              </div>
            )}
          </div>
          )}

          {!isPhone && (
          <div className="vms-card vms-mbar" data-testid="month-bar">
            <div className="vms-mbarrow">
              <span className="vms-lbl">From</span>
              <input type="date" className="vms-date" data-testid="month-from" value={range?.from ?? ""}
                onChange={(e) => range && e.target.value && setRange({ ...range, from: e.target.value })} />
              <span className="vms-lbl">To</span>
              <input type="date" className="vms-date" data-testid="month-to" value={range?.to ?? ""}
                onChange={(e) => range && e.target.value && setRange({ ...range, to: e.target.value })} />
              <button type="button" className="vms-btn" data-testid="month-this"
                onClick={() => setRange(defaultRange(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })))}>
                This month
              </button>
              <label className="vms-mtoggle" data-testid="month-showcx">
                <input type="checkbox" checked={showCx} onChange={(e) => setShowCx(e.target.checked)} />
                <span className="vms-mtrack"><span className="vms-mknob" /></span>
                <span>Show cancelled in grid</span>
                {monthCxCount > 0 && <i className="vms-mcxn">{monthCxCount}</i>}
              </label>
              <span className="vms-mtitle" data-testid="month-title">{range ? rangeTitle(range.from, range.to) : ""}</span>
              <span className="vms-mstat" data-testid="month-count">
                {monthBusy ? "Loading…" : `${monthVisible.length} match${monthVisible.length === 1 ? "" : "es"}`}
                {" · "}{fieldCountLabel(fieldSel, monthFields)}
              </span>
            </div>
            {/* ── FIELD IS MULTI-SELECT, AND THE ROW FOLDS ────────────────────────────────────
                24 chips over three rows is ~150px of filter sitting above the calendar, so the
                row is collapsed by default.

                THE RULE THE PHONE BAR ALREADY FOLLOWS: the control states what IS filtered, never
                what is not. So collapsed is NOT a bare "Field ▾" with the selection hidden — the
                chosen fields stay on screen as removable chips and only the UNCHOSEN ones fold
                away. With nothing selected the line reads "All fields" plus a way in.

                Expanded is exactly the row as it was, so nothing is lost and no new layout has to
                be learned. */}
            <div className="vms-mbarrow vms-mchips" data-testid="month-fieldrow"
              data-open={fieldsOpen ? "1" : "0"}>
              <span className="vms-lbl">Field</span>
              {fieldsOpen ? (
                <>
                  <button type="button" data-testid="month-allfields"
                    className={"vms-chip" + (fieldSel.size === 0 ? " vms-chip-on" : "")}
                    onClick={() => setFieldSel(new Set())}>All fields</button>
                  {monthFields.map((f) => (
                    <button type="button" key={f} data-testid="month-field" data-field={f}
                      className={"vms-chip" + (fieldSel.has(f) ? " vms-chip-on" : "")}
                      onClick={() => setFieldSel((prev) => {
                        const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n;
                      })}>{f}</button>
                  ))}
                  <button type="button" data-testid="month-fold" className="vms-fdisc"
                    onClick={() => setFieldsOpen(false)}>Collapse <span aria-hidden>▴</span></button>
                </>
              ) : (
                <>
                  {fieldSel.size === 0 && (
                    <button type="button" data-testid="month-allfields" className="vms-chip vms-chip-on"
                      onClick={() => setFieldSel(new Set())}>All fields</button>
                  )}
                  {/* THE SELECTION STAYS ON SCREEN AND STAYS REMOVABLE while folded. */}
                  {monthFields.filter((f) => fieldSel.has(f)).map((f) => (
                    <button type="button" key={f} data-testid="month-field" data-field={f}
                      className="vms-chip vms-chip-on"
                      onClick={() => setFieldSel((prev) => { const n = new Set(prev); n.delete(f); return n; })}>
                      {f} <span aria-hidden className="vms-fx">×</span>
                    </button>
                  ))}
                  <button type="button" data-testid="month-fold" className="vms-fdisc"
                    onClick={() => setFieldsOpen(true)}>
                    {fieldSel.size === 0
                      ? `Choose from ${monthFields.length} field${monthFields.length === 1 ? "" : "s"}`
                      : `${monthFields.length - fieldSel.size} more field${monthFields.length - fieldSel.size === 1 ? "" : "s"}`}
                    {" "}<span aria-hidden>▼</span>
                  </button>
                  {fieldSel.size > 0 && (
                    <button type="button" data-testid="month-clearfields" className="vms-chip"
                      onClick={() => setFieldSel(new Set())}>Clear</button>
                  )}
                </>
              )}
              {/* A DROPPED FILTER IS SAID, not silently kept or silently removed — AND IT IS SAID
                  WHILE THE ROW IS FOLDED, which is the default state. */}
              {droppedFields.length > 0 && (
                <span className="vms-mdrop" data-testid="month-dropped">
                  {droppedFields.join(", ")} {droppedFields.length === 1 ? "has" : "have"} no matches in this range — removed from the filter
                </span>
              )}
            </div>
          </div>
          )}
          {monthErr ? (
            <div className="vms-card vms-merr" data-testid="month-error">
              <b>The range could not be loaded — this is not an empty month.</b> {monthErr}
            </div>
          ) : (
            <>
              {/* THE DESKTOP GRID IS NOT RENDERED ON A PHONE. It was only CSS-hidden, which was
                  survivable while MONTH_CAP kept it to six rows a cell — with the cap gone it
                  builds all 424 rows and hides them, which is the desktop's work reaching the
                  phone. Same rule as the phone layout not reaching the desktop. */}
              {!isPhone && (
                <MonthView weeks={monthWeeks} count={monthVisible.length} onOpen={openCard}
                  selectedId={drawerId} singleField={fieldSel.size === 1}
                  pick={copySrc ? {
                    srcId: Number(copySrc.id ?? 0),
                    srcIso: String(copySrc.startDate ?? "").slice(0, 10),
                    srcHHMM,
                    srcVenue: srcVenueName(copySrc),
                    picks, todayIso: todayIso(),
                    onToggle: togglePick,
                  } : undefined} />
              )}
              {/* THE PHONE'S TWO HALVES. Not rendered at all above 640px; the grid above is
                  hidden by CSS below it. */}
              {isPhone && <MonthMap weeks={monthWeeks} picked={pickedDay}
                onPick={(iso) => {
                  setPickedDay(iso);
                  document.querySelector(`[data-testid="mob-day"][data-iso="${iso}"]`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }} />}
              {isPhone && <MonthAgenda weeks={monthWeeks} allMatches={monthAll} showCx={showCx}
                picked={pickedDay} onOpen={openCard} />}
            </>
          )}
          {isPhone && sheet && (
            <PickerSheet
              kind={sheet}
              onClose={() => setSheet(null)}
              cities={(week?.cities ?? []).map((c) => c.city)}
              city={monthCity}
              onPickCity={(c) => { setCityFilter(c ? new Set([c]) : new Set()); setSheet(null); }}
              fields={monthFields}
              /* THE UNFILTERED RANGE, city-scoped only. `monthAll` has the FIELD filter already
                 applied, so counting from it made every unselected field read 0 — which is the
                 opposite of what this count is for: it exists so an empty filter is visibly empty
                 BEFORE you apply it. fieldCounts applies the city scope itself. */
              counts={fieldCounts(monthData?.matches ?? [], monthCity)}
              selected={fieldSel}
              onToggleField={(f) => setFieldSel((prev) => {
                const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n;
              })}
              onAllFields={() => setFieldSel(new Set())}
              dropped={droppedFields}
            />
          )}
        </>
      ) : !week || !fweek ? null : view === "schedule" ? (
        <ScheduleView week={fweek} busy={busy} onToggle={toggleIntent} onRetry={retryName} onOpen={openCard} selectedId={drawerId} failed={nameFailed} />
      ) : (
        <VeoView week={fweek} stats={stats!} busy={busy} onCameras={setCameras} needEmoji={needEmoji} needClubhouse={needClubhouse} onExport={exportWorklist} />
      )}

      {/* ── THE PICK FOOTER ─────────────────────────────────────────────────────────────────────
          The count appears three times on this bar and comes from ONE picks.size, so it cannot
          disagree with itself. */}
      {copySrc && (
        <div className="vms-copybar" data-testid="copy-bar">
          <div className="vms-copyhead">
            <b>Picking dates for {String(copySrc.id ?? "")}</b>
            <span className="vms-copysub">
              {hhmmTo12(srcHHMM)} · {srcVenueName(copySrc)}
            </span>
            <span className="vms-copyn" data-testid="copy-count">
              {picks.size} date{picks.size === 1 ? "" : "s"} selected · {picks.size} match{picks.size === 1 ? "" : "es"} will be created
            </span>
            <label className="vms-copyall">
              Set them all to
              <input type="time" data-testid="copy-setall" defaultValue={srcHHMM}
                onChange={(e) => { const v = e.target.value; if (v) setPicks((p) => new Map([...p].map(([k]) => [k, v]))); }} />
            </label>
          </div>
          {picks.size > 0 && (
            <div className="vms-copypills" data-testid="copy-pills">
              {[...picks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([iso, hhmm]) => {
                const outside = !range || iso < range.from || iso > range.to;
                return (
                  <span key={iso} className={"vms-copypill" + (hhmm !== srcHHMM ? " chg" : "")}
                    data-testid="copy-pill" data-iso={iso} data-hhmm={hhmm} data-changed={hhmm !== srcHHMM ? "1" : "0"}>
                    <b>{dayLabel(iso)}</b>
                    {outside && <i className="vms-copyout">next month</i>}
                    {/* THE TIME IS PER DATE and opens at the source's, so the common case is no
                        work. A date changed by hand is marked — a run of eight copies with one at
                        the wrong hour must not look like eight identical ones. Derived by comparing
                        to the source, never stored, so the mark cannot drift from the value. */}
                    <input type="time" value={hhmm} data-testid="copy-pill-time"
                      onChange={(e) => { const v = e.target.value; if (v) setPicks((p) => new Map(p).set(iso, v)); }} />
                    <button type="button" aria-label={`Remove ${iso}`} data-testid="copy-pill-x"
                      onClick={() => setPicks((p) => { const n = new Map(p); n.delete(iso); return n; })}>×</button>
                  </span>
                );
              })}
            </div>
          )}
          {[...picks.keys()].some((iso) => !range || iso < range.from || iso > range.to) && (
            <div className="vms-copynote" data-testid="copy-outnote">
              A date outside this range is still created — it will not appear in this grid until you page to it.
            </div>
          )}
          {copyRun && copyRun.length > 0 && (
            <div className="vms-copyres" data-testid="copy-results">
              {copyRun.map((r) => (
                <div key={r.iso} data-testid="copy-result" data-outcome={r.outcome} data-iso={r.iso}>
                  <b>{dayLabel(r.iso)} {hhmmTo12(r.hhmm)}</b>{" "}
                  <span className={`vms-oc oc-${r.outcome.toLowerCase()}`}>{r.outcome}</span>{" "}
                  {r.id ? <span>match {r.id}</span> : null}
                  {/* AN UNKNOWN IS NOT A FAILURE. outcome UNKNOWN means the route could not read
                      back what it wrote — it may well have landed. */}
                  {r.outcome === "UNKNOWN" && <span> — {r.error}. Reload before pressing again.</span>}
                  {r.outcome === "FAILED" && <span> — {r.error}</span>}
                </div>
              ))}
            </div>
          )}
          <div className="vms-copyact">
            <button type="button" className="vms-btn" data-testid="copy-cancel" onClick={exitCopy}>Cancel</button>
            <button type="button" className="vms-btn vms-btn-go" data-testid="copy-create"
              disabled={picks.size === 0 || copyBusy} onClick={() => void runCopies()}>
              {copyBusy ? "Creating…" : `Create ${picks.size} cop${picks.size === 1 ? "y" : "ies"}`}
            </button>
          </div>
        </div>
      )}

      {drawerOpen && drawerId != null && (
        <MatchDrawer
          key={drawerId}
          apiId={drawerId}
          cardVeo={drawerVeo}
          siblings={drawerSiblings}
          onClose={closeDrawer}
          onDirtyChange={setDrawerDirty}
          onSaved={(id, patch) => patchCard(id, patch)}
          onToggleVeo={(id, en) => void toggleIntent(id, en)}
          onStep={(id) => setDrawerId(id)}
          onToast={showToast}
          /* ONLY ON LANDED. useCancelMatch fires its callback for NOT APPLIED too and hands over
             the verdict; this passes nothing up unless the re-read confirmed the cancel, so a
             failed or unknown outcome leaves the grid exactly as it was with the message still on
             it. The write-through has already put is_cancelled into the mirror by the time this
             runs, so the re-read genuinely drops the card. */
          onCancelLanded={() => { showToast("Match cancelled — schedule refreshed."); void load(weekRef, true); }}
        />
      )}

      {toastMsg ? <div className={"vms-toast" + (toastMsg.warn ? " vms-toast-warn" : "")} role="status">{toastMsg.text}</div>
        : error && week ? <div className="vms-toast" role="status">{error}</div> : null}
    </div>
  );
}

function Stat({ l, v, f }: { l: string; v: number; f: string }) {
  return <div className="vms-stat"><div className="vms-stat-l">{l}</div><div className="vms-stat-v">{v}</div><div className="vms-stat-f">{f}</div></div>;
}

const CamIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
  </svg>
);

// ── schedule view ───────────────────────────────────────────────────────────
// Each match card is a real <button>: keyboard-focusable, Enter opens the drawer.
// The VEO badge inside it is a role="switch" span (NOT a nested button — invalid
// HTML) that stops propagation so toggling coverage never opens the drawer. The
// open card is marked by a ring; nothing else is dimmed — the week stays legible
// beside the pushed-open drawer.
function ScheduleView({ week, busy, onToggle, onRetry, onOpen, selectedId, failed }: {
  week: VeoWeek; busy: boolean; onToggle: (id: number, en: boolean) => void; onRetry: (id: number) => void;
  // Session-scoped: match id -> why the last attempt on THIS page did not land.
  failed: Map<number, string>;
  onOpen: (id: number) => void; selectedId: number | null;
}) {
  const veoKey = (e: React.KeyboardEvent, id: number, en: boolean) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onToggle(id, en); }
  };
  return (
    <div className="vms-card">
      {week.cities.map(({ city, cameras }) => {
        const n = veoMatchesOf(week, city).length;
        return (
          <div className="vms-city-block" key={city}>
            <div className="vms-city-head">
              <span className="vms-city-name">{city}</span>
              <span className="vms-city-tag">{cameras} {plural(cameras, "camera")} · {n} with Veo</span>
            </div>
            <div className="vms-days">
              {week.days.map((day, d) => {
                const ms = week.matches.filter((m) => m.city === city && m.dayIdx === d).sort((a, b) => a.minutes - b.minutes);
                return (
                  <div className={"vms-day" + (day.today ? " vms-today" : "")} key={day.iso}>
                    <div className="vms-day-h"><span className="vms-dow">{day.dow}</span><span className="vms-dnum">{String(day.date).padStart(2, "0")}</span></div>
                    {ms.length ? ms.map((m) => (
                      <button type="button" key={m.apiId} data-testid="card" data-id={m.apiId}
                        className={"vms-slot vms-cardbtn" + (m.veo ? " vms-veo" : "") + (selectedId === m.apiId ? " vms-sel" : "")}
                        aria-label={`${m.time} ${m.venue} — edit match ${m.apiId}`} onClick={() => onOpen(m.apiId)}>
                        <div className="vms-slot-t">{m.time}</div>
                        <div className="vms-slot-v">{m.venue}</div>
                        {/* THE MARKER IS THIS SESSION'S, not the data's. It appears only for a
                            write THIS page attempted and did not land — never for history, and
                            never for a write that succeeded but whose result the mirror has not
                            caught up with yet. */}
                        {(() => {
                          const off = failed.has(m.apiId);
                          return (
                            <span role="switch" data-testid="veo-badge" data-veo={m.apiId} tabIndex={0}
                              data-unsynced={off ? "true" : "false"}
                              className={"vms-cam" + (m.veo ? " vms-on" : "") + (off ? " vms-unsynced" : "")}
                              aria-checked={m.veo}
                              aria-label={`Veo camera for match ${m.apiId}${off ? " — name not updated" : ""}`}
                              title={off ? `name not updated — ${failed.get(m.apiId)}` : m.veo ? "Remove Veo" : "Assign Veo"}
                              onClick={(e) => { e.stopPropagation(); if (!busy) onToggle(m.apiId, !m.veo); }}
                              onKeyDown={(e) => !busy && veoKey(e, m.apiId, !m.veo)}>
                              <CamIcon />Veo
                              {off && <span className="vms-dot" data-testid="veo-unsynced-dot" aria-hidden />}
                            </span>
                          );
                        })()}
                        {failed.has(m.apiId) && (
                          <span className="vms-unsyncrow" data-testid="veo-unsynced">
                            <span className="vms-unsynctxt">name not updated</span>
                            {/* A HUMAN CLICKS THIS. Nothing retries on its own — a duplicate name
                                write is visible to every player in the match. */}
                            <span role="button" tabIndex={0} data-testid="veo-retry" data-retry={m.apiId}
                              className="vms-retry" title="Write the camera mark to the match name again"
                              onClick={(e) => { e.stopPropagation(); if (!busy) onRetry(m.apiId); }}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (!busy) onRetry(m.apiId); } }}>
                              Retry
                            </span>
                          </span>
                        )}
                        <span className="vms-edithint">EDIT</span>
                      </button>
                    )) : <div className="vms-none">No sessions</div>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── veo coverage view ───────────────────────────────────────────────────────
function VeoView({ week, stats, busy, onCameras, needEmoji, needClubhouse, onExport }: {
  week: VeoWeek; stats: Stats; busy: boolean;
  onCameras: (city: string, n: number) => void;
  needEmoji: VeoMatch[]; needClubhouse: VeoMatch[]; onExport: () => void;
}) {
  const dayLabel = (i: number) => { const d = week.days[i]; return d ? `${d.dow} ${String(d.date).padStart(2, "0")}` : "—"; };

  // veo_codes reference / drift vs inventory (computed, never hardcoded).
  const drift = week.cities.map(({ city, cameras }) => {
    const codes = week.codesRef.find((c) => c.city === city)?.codes ?? [];
    const confirmed = codes.filter((c) => c.confirmed).map((c) => c.code);
    const unconfirmed = codes.filter((c) => !c.confirmed).map((c) => c.code);
    const notes: string[] = [];
    if (confirmed.length !== cameras) {
      notes.push(confirmed.length === 0
        ? `owns ${cameras} ${plural(cameras, "camera")}, 0 codes`
        : `${confirmed.length} codes vs ${cameras} ${plural(cameras, "camera")}`);
    }
    if (unconfirmed.length) notes.push(`${unconfirmed.length} unconfirmed ${plural(unconfirmed.length, "code")} (${unconfirmed.join(", ")}) not counted`);
    return { city, cameras, confirmed, notes };
  });

  const worklistEmpty = needEmoji.length === 0 && needClubhouse.length === 0;

  return (
    <>
      <div className="vms-card">
        <div className="vms-grid-wrap">
          <table className="vms-grid">
            <thead>
              <tr>
                <th className="vms-corner">Veo</th>
                {week.days.map((d) => <th key={d.iso}>{d.dow} {String(d.date).padStart(2, "0")}</th>)}
              </tr>
            </thead>
            <tbody>
              {week.cities.flatMap(({ city }) => {
                const rows = unitsFor(week, city);
                const owned = camerasOf(week, city);
                const code = cityCode(city);
                return rows.map((row, ri) => {
                  const label = rows.length > 1 ? `${code}${ri + 1}` : code;
                  const spare = ri >= owned;
                  return (
                    <tr key={`${city}-${ri}`}>
                      <td className="vms-unit" title={city + (spare ? " — beyond the cameras this city owns" : "")}>
                        {label}{spare && <div className="vms-unit-x">unowned</div>}
                      </td>
                      {row.map((cell, d) => {
                        if (!cell) {
                          const anyThisDay = rows.some((r) => r[d]);
                          return ri === 0 && !anyThisDay
                            ? <td key={d}><div className="vms-cell vms-gapcell"><span className="vms-gap">Open</span></div></td>
                            : <td key={d}><div className="vms-cell vms-off"><span className="vms-empty">—</span></div></td>;
                        }
                        const over = ri >= owned;
                        return (
                          <td key={d}>
                            <div className={"vms-cell vms-on" + (over ? " vms-over" : "")}>
                              <div className="vms-cell-v">{cell.venue}</div>
                              <div className="vms-cell-t">{cell.times.join(" + ")}</div>
                              {over && <span className="vms-warn">no camera</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>

        <div className="vms-foot">
          <b>One row per camera the city owns.</b> A city with two cameras keeps a second row all week even when it is idle. <b>A coral cell</b> is an open night: the city has matches but no camera on any of them — the coral cells are this week&apos;s to-do list. <b>An em-dash</b> means that camera is free that night, not that the night is uncovered.
        </div>
        <div className="vms-foot">
          {stats.over
            ? <><b>{stats.over} {plural(stats.over, "night")} over capacity.</b> More venues are marked than the city owns cameras, so the extra rows are flagged <em>no camera</em>. Either drop one venue or move a camera in from a nearby city.</>
            : <><b>No night is over capacity.</b> Every marked venue has a camera that can reach it.</>}
        </div>
        <div className="vms-foot">
          Seeded {week.seededThisWeek} matches from the 🎥 emoji — cities running coverage without the emoji will read as Open until marked.
        </div>
      </div>

      <div className="vms-card">
        <div className="vms-inv-head">
          <strong>Camera inventory</strong>
          <span>How many Veo cameras each city owns. The − / + buttons change a real setting.</span>
        </div>
        <div className="vms-inv">
          {week.cities.map(({ city, cameras }) => (
            <div className="vms-inv-row" key={city}>
              <span className="vms-inv-city">{city}</span>
              <div className="vms-inv-ctl">
                <button type="button" className="vms-inv-btn" disabled={busy || cameras <= 0} aria-label={`Fewer cameras in ${city}`} onClick={() => onCameras(city, cameras - 1)}>−</button>
                <span className="vms-inv-n">{cameras}</span>
                <button type="button" className="vms-inv-btn" disabled={busy} aria-label={`More cameras in ${city}`} onClick={() => onCameras(city, cameras + 1)}>+</button>
              </div>
            </div>
          ))}
        </div>

        <div className="vms-foot">
          <b>veo_codes reference.</b> Confirmed codes per city, with any drift from the inventory above.
        </div>
        <div className="vms-drift">
          {drift.map((d) => (
            <div className="vms-drift-row" key={d.city}>
              <span className="vms-drift-city">{d.city}</span>
              <span className="vms-drift-codes">{d.confirmed.length ? d.confirmed.join(", ") : "no confirmed codes"}</span>
              {d.notes.length > 0
                ? <span className="vms-drift-flag">{d.notes.join(" · ")}</span>
                : <span className="vms-drift-ok">matches inventory</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="vms-card">
        <div className="vms-wl-head">
          <strong>Camera icon worklist</strong>
          <span>{needEmoji.length + needClubhouse.length} to reconcile · <button type="button" className="vms-linkbtn" onClick={onExport}>Export CSV</button></span>
        </div>
        {worklistEmpty ? (
          <div className="vms-state">Clubhouse intent and the app emoji agree — nothing to reconcile this week.</div>
        ) : (
          <>
            <WlSection title="Add the camera emoji" hint="Marked in Clubhouse, but no 🎥 in the app yet." rows={needEmoji} dayLabel={dayLabel} />
            <WlSection title="Marked in the app but not in Clubhouse" hint="Has the 🎥 emoji, but no camera intent in Clubhouse." rows={needClubhouse} dayLabel={dayLabel} />
          </>
        )}
      </div>
    </>
  );
}

function WlSection({ title, hint, rows, dayLabel }: {
  title: string; hint: string; rows: VeoMatch[]; dayLabel: (i: number) => string;
}) {
  return (
    <div className="vms-wl-sec">
      <div className="vms-wl-sec-h"><strong>{title}</strong><span>{rows.length}</span></div>
      <div className="vms-wl-hint">{hint}</div>
      {rows.length === 0 ? (
        <div className="vms-wl-none">None.</div>
      ) : (
        <table className="vms-wl">
          <thead><tr><th>Day</th><th>City</th><th>Venue</th><th>Time</th><th>Match name</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.apiId}>
                <td className="vms-nm">{dayLabel(m.dayIdx)}</td>
                <td>{m.city}</td>
                <td>{m.venue}</td>
                <td>{m.time}</td>
                <td>{m.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const CSS = `
.vms{
  --forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--paper:#fff;
  --line:#dfe4da;--slot:#EFF4EF;--mint:#2CDB87;--mintSoft:#dcf7e9;
  --yellow:#FFFF3E;--coral:#FF6955;--coralInk:#A83120;--coralBg:#FFE0DA;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  color:var(--ink);-webkit-font-smoothing:antialiased;max-width:1360px;margin:0 auto}
.vms *{box-sizing:border-box}
.vms-card{background:var(--paper);border:1px solid var(--line);border-radius:16px;
  box-shadow:0 9px 26px rgba(0,43,34,.075);overflow:hidden;margin-bottom:18px}

.vms-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
  padding:18px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vms-h-title{font-size:16px;font-weight:900;letter-spacing:-.2px;color:var(--forest)}
.vms-h-sub{font-size:12px;color:var(--muted);margin-top:5px;max-width:720px;line-height:1.45}
.vms-h-right{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
.vms-control-label{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.vms-segmented{display:inline-flex;background:var(--slot);border:1px solid var(--line);border-radius:10px;padding:3px}
.vms-seg-btn{border:0;background:transparent;font-size:11.5px;font-weight:800;color:var(--muted);
  padding:7px 14px;border-radius:8px;cursor:pointer;font-family:inherit}
.vms-seg-btn.vms-active{background:#fff;color:var(--forest);box-shadow:0 1px 3px rgba(0,43,34,.13)}
.vms-btn{border:1px solid var(--line);background:#fff;color:var(--forest);font-size:12px;font-weight:800;
  padding:8px 15px;border-radius:10px;cursor:pointer;font-family:inherit}
.vms-btn:hover{background:var(--slot)}
.vms-btn:disabled{opacity:.55;cursor:default}
.vms-linkbtn{border:0;background:transparent;color:var(--forest);font-weight:800;font-size:11px;cursor:pointer;font-family:inherit;text-decoration:underline;padding:0}

/* week navigation — lives in the card header next to View, drives both views */
.vms-wknav{display:inline-flex;align-items:center;gap:8px}
.vms-wknav[aria-busy="true"]{opacity:.6}
.vms-navbtn{border:1px solid var(--line);background:#fff;color:var(--forest);font-size:15px;font-weight:900;
  line-height:1;width:30px;height:30px;border-radius:9px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;justify-content:center}
.vms-navbtn:hover:not(:disabled){background:var(--slot)}
.vms-navbtn:disabled{opacity:.5;cursor:default}
/* The week picker sits with the arrows and takes their tokens, so it reads as one control group
   rather than a form field that wandered in. */
.vms-wkpick{border:1px solid var(--line);background:#fff;color:var(--forest);border-radius:9px;
  padding:6px 9px;font:inherit;font-size:12.5px;font-weight:700;min-height:32px;cursor:pointer}
.vms-wkpick:hover:not(:disabled){background:var(--slot)}
.vms-wkpick:disabled{opacity:.5;cursor:default}
.vms-wkpick:focus-visible{outline:2px solid var(--mint);outline-offset:1px}
.vms-fresh{display:inline-flex;align-items:center;gap:8px;margin-left:4px}
.vms-mbar{padding:10px 14px;display:flex;flex-direction:column;gap:8px}
.vms-mbarrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vms-lbl{font-size:10.5px;font-weight:700;letter-spacing:.09em;color:#93A49A;text-transform:uppercase}
.vms-date{border:1px solid var(--line);border-radius:8px;padding:6px 9px;font:inherit;font-size:13px;font-weight:600;background:#fff}
.vms-mtitle{font-size:14px;font-weight:800;margin-left:6px}
.vms-mstat{margin-left:auto;font-size:12px;font-weight:600;color:#6E8076}
.vms-chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 12px;font:inherit;font-size:12.5px;font-weight:600;color:#3C4F44;cursor:pointer;white-space:nowrap}
.vms-chip-on{background:#0F3323;border-color:#0F3323;color:#fff}
.vms-mdrop{font-size:11.5px;color:#8A5A08;background:#FFF6E3;border:1px solid #F0DFB8;border-radius:8px;padding:3px 9px}
.vms-merr{padding:14px 16px;font-size:13px;color:#7C2412;background:#FDECE8;border-color:#F2C6BC}
.vms-month{overflow:hidden}
.vms-mdow{display:grid;grid-template-columns:repeat(7,1fr);background:#F7FAF8;border-bottom:1px solid var(--line)}
.vms-mdow div{padding:7px 10px;font-size:10.5px;font-weight:700;letter-spacing:.09em;color:#8C9E93;text-transform:uppercase;border-right:1px solid #EFF3EF}
.vms-mdow div:last-child{border-right:0}
.vms-mweek{display:grid;grid-template-columns:repeat(7,1fr)}
/* THE ROW GROWS TO ITS BUSIEST DAY. This was height:126px with the list scrolling inside it,
 * which meant a Saturday with twenty matches showed about five and hid the rest behind a 5px
 * scrollbar most people never saw. A calendar that silently omits most of a day is worse than no
 * calendar. min-height keeps a quiet week from collapsing to a strip.
 *
 * CELLS IN A ROW STAY EQUAL. The week is display:grid, whose items stretch to the tallest track
 * by default — so equal height per row is the grid's own behaviour and needs no rule. What it does
 * need is for nothing inside to force a height, which is why the fixed one had to go rather than
 * be raised. */
.vms-mcell{min-height:126px;display:flex;flex-direction:column;min-width:0;background:#fff;border-right:1px solid #EFF3EF;border-bottom:1px solid #EFF3EF}
.vms-mcell:nth-child(7n){border-right:0}
/* THE OUT-OF-RANGE PADDING DAY DOES NOT STRETCH. It holds nothing by definition, so under a
   14-row week it became 14 rows of dimmed nothing - the largest block of whitespace on the page
   and the only one carrying no information at all. align-self:start stops it inflating; the tint
   still marks it as outside the range, and IN-RANGE cells keep stretching so the grid stays a
   grid. */
.vms-fdisc{border:1px dashed #cfdad3;background:#fff;border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;font-weight:700;color:#42513f;cursor:pointer;white-space:nowrap}
.vms-fdisc:hover{background:#f4f7f3;border-color:#b7c8bd}
.vms-fx{opacity:.6;font-weight:800}
.vms-mout{background:#FAFCFA;align-self:start;min-height:86px}
/* ── COPY-TO-DATES: the grid as a picker ── */
.vms-mpickable{cursor:pointer}
.vms-mpickable:hover{background:#F4FBF7}
.vms-mpick{box-shadow:inset 0 0 0 2px #35c77f;background:#F2FBF6}
.vms-mtick{font-size:11px;font-weight:800;color:#046B45}
.vms-msrc{font-size:9px;font-weight:800;letter-spacing:.06em;color:#42513f;background:#EEF3F0;border:1px solid #E2EAE5;border-radius:999px;padding:0 5px}
.vms-mprev{display:flex;align-items:baseline;gap:5px;margin-top:3px;padding:3px 6px;border:1px dashed #8fd3ae;border-radius:6px;background:#F6FDF9;font-size:10.5px}
.vms-mprev b{font-weight:800;color:#0F6B4F;font-variant-numeric:tabular-nums;white-space:nowrap}
.vms-mprev span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3d5245}
.vms-mprev i{margin-left:auto;font-style:normal;font-weight:800;color:#0F6B4F}
/* A TIME CHANGED BY HAND IS BLUE, in the cell and in its pill — a run of copies must not quietly
   contain one at the wrong hour. Derived from the value, never a stored flag. */
.vms-mprev.chg{border-color:#8ab6e8;background:#F4F9FE}
.vms-mprev.chg b,.vms-mprev.chg i{color:#1B5FA8}
/* AMBER: this day already holds the fixture at this time. Created anyway — shown, not refused. */
.vms-mprev.clash{border-color:#e3c369;background:#FDF7E6}
.vms-mprev.clash b,.vms-mprev.clash i{color:#8a6300}
.vms-mcell[data-clash="1"] .vms-mitem{background:#FDF7E6;border-color:#e3c369}

.vms-copybar{position:sticky;bottom:0;z-index:35;margin-top:10px;background:#fff;border:1px solid #DCE5E0;border-radius:14px;padding:11px 14px;box-shadow:0 -6px 22px rgba(16,40,28,.10)}
.vms-copyhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.vms-copyhead b{font-size:13.5px;font-weight:800}
.vms-copysub{font-size:12px;color:#6d7b74;font-weight:600}
.vms-copyn{font-size:12px;font-weight:700;color:#0F6B4F}
.vms-copyall{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:700;color:#3d5245}
.vms-copyall input,.vms-copypill input{border:1px solid #DCE5E0;border-radius:8px;padding:3px 6px;font:inherit;font-size:11.5px}
.vms-copypills{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.vms-copypill{display:inline-flex;align-items:center;gap:6px;border:1px solid #DCE5E0;border-radius:999px;padding:3px 5px 3px 11px;font-size:11.5px;background:#F9FBFA}
.vms-copypill b{font-weight:800;color:#12241d}
.vms-copypill.chg{border-color:#8ab6e8;background:#F4F9FE}
.vms-copypill.chg b{color:#1B5FA8}
.vms-copyout{font-style:normal;font-size:9.5px;font-weight:800;letter-spacing:.05em;color:#8a6300;background:#fdf1d0;border-radius:4px;padding:1px 5px}
.vms-copypill button{border:0;background:none;color:#9AA8A0;font:inherit;font-size:13px;line-height:1;cursor:pointer;padding:0 3px}
.vms-copynote{margin-top:8px;font-size:11.5px;color:#8a6300;background:#fdf1d0;border:1px solid #e3c369;border-radius:8px;padding:6px 9px;line-height:1.4}
.vms-copyres{margin-top:9px;display:flex;flex-direction:column;gap:3px;font-size:12px;max-height:150px;overflow-y:auto}
.vms-oc{font-weight:800;font-size:10.5px;letter-spacing:.04em}
.oc-landed{color:#0F6B4F}.oc-failed{color:#a8391a}.oc-unknown{color:#8a6300}
.vms-copyact{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.vms-btn-go{background:#0d3b2e;border-color:#0d3b2e;color:#fff}
.vms-btn-go:disabled{opacity:.45}
.vms-mout .vms-mnum{color:#C3CFC7}
.vms-mtoday{box-shadow:inset 0 0 0 2px #35c77f}
.vms-mhead{display:flex;align-items:center;gap:6px;padding:5px 9px 2px}
.vms-mnum{font-weight:700;font-size:13px}
.vms-mcount{margin-left:auto;font-size:10px;font-weight:800;color:#8A5A08;background:#FFF6E3;border-radius:999px;padding:1px 6px}
/* NO INTERNAL SCROLL. Every match the day holds is on the page; the page scrolls, not the cell. */
.vms-mlist{padding:0 6px 6px;display:flex;flex-direction:column;gap:3px}
.vms-mitem{display:flex;align-items:baseline;gap:5px;flex:0 0 auto;min-width:0;text-align:left;background:#F4F8F5;border:1px solid #E3ECE6;border-radius:6px;padding:3px 6px;font:inherit;cursor:pointer}
.vms-mitem:hover{background:#E4FBEC;border-color:#BCE8CD}
.vms-msel{background:#E4FBEC;border-color:#35c77f}
.vms-mitem b{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.vms-mitem span{min-width:0;flex:1;font-size:11px;color:#3C4F44;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* THE PRICE NEVER TRUNCATES. flex:0 0 auto + nowrap and NO overflow rule — it takes the width
 * it needs and the FIELD gives way, because "$15.0" and "$1" are wrong numbers rather than short
 * ones. The field beside it is the one that ellipses, and it carries a tooltip that does not.
 * tabular-nums so a column of prices lines up on the decimal point. */
.vms-mprice{flex:0 0 auto;font-style:normal;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;color:#2C6B45}
/* THE COUNT — real players over capacity. Plain ink by default: on a month grid almost every
   match is legitimately unfilled, so "not full yet" is the norm and gets no colour at all. */
.vms-mcnt{flex:0 0 auto;font-style:normal;font-size:10.5px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;color:#12241d;margin-left:auto;order:4}
/* FOUR THINGS IN ONE CELL, AND THE CELL IS 143px AT 1280. On one line the field was crushed to a
   single letter — "H", "O", "C" — which is not a field name, it is a smaller lie than an ellipsis.
   Below 1440 the row breaks after the field: time and field on top, count and price beneath,
   right-aligned. Every row breaks the same way, so the grid stays a grid. */
.vms-mitem b{order:1}
.vms-mitem span{order:2}
.vms-mitem .vms-mprice{order:5}
@media (max-width:1439px){
  .vms-mitem{flex-wrap:wrap;row-gap:1px}
  .vms-mitem::after{content:"";order:3;flex:0 0 100%;height:0}
}
.vms-mfull{color:#046B45}
/* AMBER IS TODAY ONLY. 143 of Austin's 165 September matches are below their minimum; colouring
   that everywhere would light 87% of the grid permanently and mean nothing. */
.vms-mlow{color:#8a6300}
/* PAST DAYS RECEDE. A day that has run has nothing left to decide. The numbers stay legible —
   this is a step back, not a hide. */
.vms-mpast .vms-mitem{opacity:.62;background:#F7F8F7;border-color:#EAEEEA}
.vms-mpast .vms-mnum{color:#6d7b74}
.vms-mtd{font-size:9px;letter-spacing:.7px;text-transform:uppercase;font-weight:800;color:#046B45;background:#e0f2e7;border-radius:999px;padding:1px 6px}
/* CANCELLED — struck through with a red left edge, and no count colour to read. */
.vms-mcx{background:#fdeae4;border-color:#f0bda9;box-shadow:inset 2px 0 0 #a8391a}
.vms-mcx b,.vms-mcx span{color:#a8391a;text-decoration:line-through;text-decoration-thickness:1px}
.vms-mcx .vms-mcnt,.vms-mcx .vms-mprice{color:#a8391a;opacity:.75}
.vms-mcount u{text-decoration:none;color:#a8391a;font-weight:700}
/* The cancelled toggle — same shape and same accent as Slate Review's. */
.vms-mtoggle{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:#3d5245;cursor:pointer;user-select:none}
.vms-mtoggle input{position:absolute;opacity:0;width:0;height:0}
.vms-mtrack{width:32px;height:18px;border-radius:999px;background:#dfe6e2;position:relative;transition:background .15s;flex:none}
.vms-mknob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:left .15s}
.vms-mtoggle input:checked + .vms-mtrack{background:#35c77f}
.vms-mtoggle input:checked + .vms-mtrack .vms-mknob{left:16px}
.vms-mtoggle input:focus-visible + .vms-mtrack{outline:2px solid #046B45;outline-offset:2px}
.vms-mcxn{font-style:normal;font-size:10px;font-weight:800;color:#a8391a;background:#fdeae4;border:1px solid #f0bda9;border-radius:999px;padding:0 6px}
.vms-mempty{padding:40px 18px;text-align:center;color:#6E8076;font-size:13px}
.vms-refresh{display:inline-flex;align-items:center;gap:6px;min-height:32px;border:1px solid var(--line);
  border-radius:9px;background:#fff;color:var(--forest);font:inherit;font-size:12px;font-weight:700;
  padding:0 10px;cursor:pointer}
.vms-refresh:hover:not(:disabled){background:var(--slot)}
.vms-refresh:disabled{opacity:.6;cursor:default}
.vms-stamp{font-size:12px;color:#3D5349;white-space:nowrap}
.vms-stamp-stale{color:#7C8A83}
.vms-stamp-failed{color:#A8391A;font-weight:600}
.vms-wklabel{display:flex;flex-direction:column;align-items:center;min-width:172px;line-height:1.15}
.vms-cam.vms-unsynced{box-shadow:inset 0 0 0 1.5px #d08a00}
.vms-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#d08a00;margin-left:5px;vertical-align:middle}
.vms-unsyncrow{position:relative;z-index:2;display:flex;align-items:center;gap:6px;margin-top:3px}
.vms-unsynctxt{font-size:10px;font-weight:800;color:#8a5a00;letter-spacing:.01em}
.vms-retry{font-size:10px;font-weight:800;color:#8a5a00;text-decoration:underline;cursor:pointer}
.vms-wkrange{font-size:12.5px;font-weight:900;color:var(--forest);white-space:nowrap;font-variant-numeric:tabular-nums}
.vms-wktag{font-size:8.5px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--muted)}
.vms-wktag-now{color:#046B45}
.vms-wklabel-away .vms-cam.vms-unsynced{box-shadow:inset 0 0 0 1.5px #d08a00}
.vms-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#d08a00;margin-left:5px;vertical-align:middle}
.vms-unsyncrow{position:relative;z-index:2;display:flex;align-items:center;gap:6px;margin-top:3px}
.vms-unsynctxt{font-size:10px;font-weight:800;color:#8a5a00;letter-spacing:.01em}
.vms-retry{font-size:10px;font-weight:800;color:#8a5a00;text-decoration:underline;cursor:pointer}
.vms-wkrange{color:var(--coralInk)}
.vms-wklabel-away .vms-wktag{color:var(--coralInk)}
.vms-todaybtn-hot{border-color:var(--forest);background:var(--forest);color:#fff}
.vms-todaybtn-hot:hover{background:var(--forest)}

.vms-stats{display:flex;gap:0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.vms-stat{flex:1;min-width:150px;padding:14px 20px;border-right:1px solid var(--line)}
.vms-stat:last-child{border-right:0}
.vms-stat-l{font-size:9px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.vms-stat-v{font-size:21px;font-weight:900;color:var(--forest);margin-top:5px;line-height:1;font-variant-numeric:tabular-nums}
.vms-stat-f{font-size:11px;color:var(--muted);margin-top:5px;font-weight:650}
.vms-state{padding:26px 20px;font-size:13px;color:var(--muted);font-weight:650;display:flex;gap:12px;align-items:center}

/* schedule view */
.vms-city-block{padding:16px 20px 18px;border-bottom:1px solid var(--line)}
.vms-city-block:last-child{border-bottom:0}
.vms-city-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap}
.vms-city-name{font-size:14px;font-weight:900;color:var(--forest)}
.vms-city-tag{font-size:10px;font-weight:850;color:var(--muted);background:var(--slot);border:1px solid var(--line);border-radius:99px;padding:4px 10px}

.vms-days{display:grid;grid-template-columns:repeat(7,1fr);gap:9px}
.vms-day{border:1px solid var(--line);border-radius:11px;padding:9px;min-height:96px;background:#fff}
.vms-day.vms-today{border-color:var(--mint);box-shadow:0 0 0 2px var(--mintSoft)}
.vms-day.vms-today .vms-dow,.vms-day.vms-today .vms-dnum{color:#046B45}
.vms-day-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.vms-dow{font-size:9px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.vms-dnum{font-size:11px;font-weight:900;color:var(--ink)}
.vms-slot{border:1px solid var(--line);border-radius:8px;padding:7px 8px;margin-bottom:6px;background:#fff}
.vms-slot:last-child{margin-bottom:0}
/* A Veo match inverts: dark forest card, yellow chip. Solid bg under the gradient
   so contrast measures honestly. */
.vms-slot.vms-veo{border-color:#003326;background-color:#073E2E;
  background-image:linear-gradient(135deg,#003326 0%,#0a5741 100%);
  box-shadow:0 3px 12px rgba(0,51,38,.28);position:relative;overflow:hidden}
.vms-slot.vms-veo::after{content:"";position:absolute;right:-14px;top:-14px;width:52px;height:52px;
  border-radius:50%;background:rgba(255,255,62,.10);pointer-events:none}
.vms-slot.vms-veo .vms-slot-t{color:#fff;position:relative}
.vms-slot.vms-veo .vms-slot-v{color:#AEE6CB;position:relative}
.vms-slot.vms-veo .vms-cam.vms-on{background:var(--yellow);border-color:var(--yellow);color:var(--forest);
  position:relative;box-shadow:0 1px 4px rgba(0,0,0,.22)}
.vms-slot-t{font-size:11px;font-weight:900;color:var(--ink);letter-spacing:-.1px}
.vms-slot-v{font-size:10px;color:var(--muted);font-weight:700;margin-top:2px;line-height:1.3}
.vms-cam{margin-top:6px;display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);
  background:#fff;border-radius:7px;padding:3px 7px;cursor:pointer;font-family:inherit;
  font-size:9px;font-weight:900;letter-spacing:.4px;text-transform:uppercase;color:var(--muted)}
.vms-cam:hover{background:var(--slot)}
.vms-cam:disabled{cursor:default;opacity:.75}
.vms-cam.vms-on{background:var(--mintSoft);border-color:#8fd9b6;color:#046B45}
.vms-slot.vms-veo .vms-cam{border-color:rgba(255,255,255,.30);background:rgba(255,255,255,.07);color:#CBEBDA}
.vms-cam svg{width:11px;height:11px;display:block}
.vms-none{font-size:10.5px;color:var(--muted);font-weight:700;padding:6px 2px}

/* card-as-button + selection ring (drawer edit) */
.vms{transition:margin-right .17s ease-out}
.vms-cardbtn{display:block;width:100%;text-align:left;cursor:pointer;font-family:inherit;position:relative}
.vms-cardbtn:hover{border-color:#9FC4B2;box-shadow:0 2px 7px rgba(0,42,28,.09)}
.vms-cardbtn:focus-visible{outline:2px solid var(--mintInk);outline-offset:2px}
.vms-cardbtn.vms-sel{box-shadow:0 0 0 3px var(--mint),0 6px 18px rgba(0,42,28,.20)}
.vms-cardbtn.vms-veo.vms-sel{box-shadow:0 0 0 3px var(--mint),0 6px 18px rgba(0,42,28,.30)}
.vms-edithint{pointer-events:none;position:absolute;right:8px;bottom:7px;font-size:9px;font-weight:900;letter-spacing:.5px;color:var(--mintInk);opacity:0}
.vms-slot.vms-veo .vms-edithint{color:var(--mint)}
.vms-cardbtn:hover .vms-edithint,.vms-cardbtn:focus-visible .vms-edithint{opacity:1}
span.vms-cam{cursor:pointer}
span.vms-cam:focus-visible{outline:2px solid var(--mintInk);outline-offset:2px}

/* city filter chips */
.vms-filter{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--line)}
.vms-chip{border:1px solid var(--line);background:#fff;color:var(--forest);font-family:inherit;font-size:11.5px;font-weight:800;
  padding:6px 13px;border-radius:99px;cursor:pointer}
.vms-chip:hover{background:var(--slot)}
.vms-chip-on{background:var(--forest);border-color:var(--forest);color:#fff}
.vms-toast-warn{background:var(--coralInk)}

/* veo grid */
.vms-grid-wrap{overflow-x:auto}
.vms-grid{width:100%;border-collapse:collapse;min-width:1080px}
.vms-grid th,.vms-grid td{border:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}
.vms-grid th{padding:10px 11px;font-size:10px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;
  color:var(--muted);background:var(--slot);white-space:nowrap}
.vms-grid th.vms-corner{width:92px}
.vms-grid td.vms-unit{font-size:12px;font-weight:900;color:var(--forest);background:var(--slot);
  white-space:nowrap;width:92px;padding:14px 11px}
/* Three states, loudest last — covered (quiet mint), idle (dash), open (loud coral). Not inverted. */
.vms-cell{border-radius:8px;padding:9px 10px;min-height:48px}
.vms-cell.vms-on{background:#F1FBF6;box-shadow:inset 3px 0 0 var(--mint)}
.vms-cell.vms-gapcell{background:#FFD3C9;box-shadow:inset 3px 0 0 var(--coral);display:flex;align-items:center;justify-content:center}
.vms-cell.vms-off{display:flex;align-items:center;justify-content:center;min-height:48px}
.vms-cell.vms-on.vms-over{background:var(--coralBg);box-shadow:inset 3px 0 0 var(--coral)}
.vms-cell-v{font-size:11.5px;font-weight:800;color:var(--forest);line-height:1.35}
.vms-cell-t{font-size:10.5px;color:var(--muted);font-weight:700;margin-top:3px}
.vms-gap{font-size:10px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;color:var(--coralInk)}
.vms-unit-x{font-size:8.5px;font-weight:850;letter-spacing:.4px;text-transform:uppercase;color:var(--coralInk);margin-top:3px}
.vms-empty{font-size:11px;color:#69756E;font-weight:700}
.vms-warn{display:inline-block;margin-top:6px;font-size:9px;font-weight:900;letter-spacing:.4px;
  text-transform:uppercase;background:var(--coral);color:var(--forest);border-radius:5px;padding:2px 7px}
.vms-foot{padding:14px 20px 18px;font-size:11px;color:var(--muted);line-height:1.6;max-width:1020px}
.vms-foot b{color:var(--ink);font-weight:800}
.vms-foot + .vms-foot{padding-top:0}

/* inventory + drift */
.vms-inv-head{padding:14px 20px;background:var(--slot);border-bottom:1px solid var(--line);display:flex;
  justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.vms-inv-head strong{font-size:12.5px;font-weight:900;color:var(--forest)}
.vms-inv-head span{font-size:11px;color:var(--muted);font-weight:700}
.vms-inv{display:flex;flex-wrap:wrap;gap:10px;padding:16px 20px}
.vms-inv-row{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:7px 10px}
.vms-inv-city{font-size:11.5px;font-weight:850;color:var(--forest)}
.vms-inv-ctl{display:inline-flex;align-items:center;gap:8px}
.vms-inv-btn{width:24px;height:24px;border:1px solid var(--line);background:#fff;border-radius:7px;
  font-size:14px;font-weight:900;color:var(--forest);cursor:pointer;line-height:1;font-family:inherit}
.vms-inv-btn:hover{background:var(--slot)}
.vms-inv-btn:disabled{opacity:.45;cursor:default}
.vms-inv-n{font-size:13px;font-weight:900;color:var(--forest);min-width:14px;text-align:center;font-variant-numeric:tabular-nums}
.vms-drift{padding:0 20px 16px;display:flex;flex-direction:column;gap:8px}
.vms-drift-row{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:11.5px}
.vms-drift-city{font-weight:900;color:var(--forest);min-width:96px}
.vms-drift-codes{color:var(--muted);font-weight:700}
.vms-drift-flag{color:var(--coralInk);font-weight:850;background:var(--coralBg);border-radius:6px;padding:2px 9px}
.vms-drift-ok{color:#046B45;font-weight:800;font-size:11px}

/* worklist */
.vms-wl-head{padding:14px 20px;background:var(--slot);border-bottom:1px solid var(--line);display:flex;
  justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.vms-wl-head strong{font-size:12.5px;font-weight:900;color:var(--forest)}
.vms-wl-head span{font-size:11px;color:var(--muted);font-weight:700}
.vms-wl-sec{border-bottom:1px solid var(--line)}
.vms-wl-sec:last-child{border-bottom:0}
.vms-wl-sec-h{display:flex;justify-content:space-between;align-items:center;padding:12px 20px 2px}
.vms-wl-sec-h strong{font-size:12px;font-weight:900;color:var(--forest)}
.vms-wl-sec-h span{font-size:11px;font-weight:850;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:99px;padding:1px 9px}
.vms-wl-hint{padding:0 20px 8px;font-size:11px;color:var(--muted);font-weight:650}
.vms-wl-none{padding:2px 20px 14px;font-size:11.5px;color:var(--muted);font-weight:700}
.vms-wl{width:100%;border-collapse:collapse}
.vms-wl th,.vms-wl td{border:0;border-top:1px solid var(--line);font-size:12px;font-variant-numeric:tabular-nums;padding:10px 20px;text-align:left}
.vms-wl th{background:#fff;font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
.vms-wl td.vms-nm{font-weight:800}
.vms-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--coralInk);color:#fff;
  font-size:12.5px;font-weight:700;padding:9px 16px;border-radius:999px;z-index:80}
/* ── THE WEEK GRID SCROLLS ON A PHONE ─────────────────────────────────────────────────────────
   NO BACKTICK MAY APPEAR IN THIS BLOCK - it sits inside a template literal.

   MEASURED at 390px: .vms-days held 687px of content in a 348px box with overflow-x visible and NO
   ancestor scrolling, so only Mon-Thu were reachable and Fri, Sat and Sun could not be got to at
   all. The page itself correctly does not scroll sideways, which is exactly why the days had to -
   without it the content is not clipped-and-obvious, it is silently absent.

   repeat(7, 1fr) cannot overflow: 1fr resolves against the container, so the columns just squash
   until they fit. A minimum width is what makes the row wider than its box and therefore
   scrollable. 132px keeps a time and a venue name legible. */
/* ── THE PHONE LAYOUT (below 640px) ───────────────────────────────────────────────────────────
   HIDDEN BY DEFAULT, so nothing above 640px changes: the desktop grid, both chip rows and the
   tablet range are untouched, and the only thing the media query below does to them is switch
   them off. */
.vms-mob,.vms-map,.vms-ag,.vms-sheet,.vms-scrim{display:none}

@media (max-width: 639.98px) {
  .vms-days{grid-template-columns:repeat(7,minmax(132px,1fr));overflow-x:auto;overflow-y:hidden;
    -webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;scrollbar-width:none;
    scroll-snap-type:x proximity;padding-bottom:2px}
  .vms-days::-webkit-scrollbar{display:none}
  .vms-day{scroll-snap-align:start}
  /* THE MONTH GRID IS NOT SHOWN ON A PHONE AT ALL, and the horizontal scroll goes with it.
     It used to be seven columns at minmax(112px,1fr) — 784px of grid in a 366px box — with
     .vms-mdow set to overflow-x:hidden above a row that scrolled, so the Mon…Sun labels could not
     follow the columns they label and every one was mislabelled after a swipe. Deleting the scroll
     deletes that bug rather than papering it: there is no header left to desync. */
  .vms-month{display:none}
  .vms-mbar{display:none}
  .vms-filter-month{display:none}
  /* The phone bar carries its own month nav, so the desktop one would be a second title and a
     second pair of arrows stacked above it. The VIEW switcher beside it stays — it is how you
     reach Month in the first place. */
  .vms-wknav-month{display:none}

  .vms-mob{display:block;padding:8px 10px}
  .vms-mobnav{display:flex;align-items:center;gap:8px}
  .vms-mobnavb{border:1px solid var(--line);background:#fff;border-radius:9px;width:34px;height:34px;
    flex:none;font:inherit;font-size:16px;font-weight:700;color:#3d5245;line-height:1}
  .vms-mobtitle{font-size:15px;font-weight:800;letter-spacing:-.2px;flex:1;min-width:0;text-align:center;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vms-mobtoday{border:1px solid var(--line);background:#fff;border-radius:9px;height:34px;padding:0 12px;
    flex:none;font:inherit;font-size:12.5px;font-weight:700;color:#3d5245}
  /* TWO BUTTONS. A third would leave 77px for a label plus a count badge, and "All fields" with a
     23 badge is 89px — it would truncate its own label. */
  .vms-mobfbar{display:flex;gap:6px;margin-top:8px}
  .vms-mobfb{flex:1 1 0;min-width:0;height:38px;border:1px solid var(--line);background:#fff;
    border-radius:10px;display:flex;align-items:center;gap:5px;padding:0 9px;font:inherit;
    font-size:12.5px;font-weight:700;color:#3d5245;text-align:left}
  .vms-mobfb .lab{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .vms-mobfb .car{flex:none;font-size:9px;color:#9AA8A0}
  .vms-mobfb .n{flex:none;background:#0d3b2e;color:#fff;border-radius:99px;font-size:10.5px;
    font-weight:800;padding:1px 6px;line-height:1.35}
  .vms-mobfb.on{background:#0d3b2e;border-color:#0d3b2e;color:#fff}
  .vms-mobfb.on .car{color:#9fc9b5}
  .vms-mobfb.on .n{background:rgba(255,255,255,.24)}
  .vms-mobsum{margin-top:8px;display:flex;align-items:center;gap:8px;font-size:11.5px;
    color:#6d7b74;font-weight:600}
  .vms-mobsum .txt{flex:1;min-width:0}
  .vms-mobsum b{color:#12241d;font-weight:800}
  /* CANCELLED IS A BOOLEAN, so it sits on the line that already states what is on screen rather
     than in the row of pickers. */
  .vms-mobcx{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;
    color:#3d5245;background:none;border:0;padding:4px 0;min-height:32px}
  .vms-mobcx i{width:30px;height:17px;border-radius:99px;background:#dfe6e2;position:relative;flex:none}
  .vms-mobcx i::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;
    border-radius:99px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:left .15s}
  .vms-mobcx.on i{background:#35c77f}
  .vms-mobcx.on i::after{left:15px}
  .vms-mobdrop{margin-top:7px;font-size:11.5px;color:#8a6300;background:#fdf1d0;
    border:1px solid #e3c369;border-radius:8px;padding:6px 8px;line-height:1.4}

  /* ── the map: seven columns that hold no text, so 52px a column is enough ── */
  .vms-map{display:block;margin-top:8px;overflow:hidden}
  .vms-mapdow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));background:#F7FAF8;
    border-bottom:1px solid var(--line)}
  .vms-mapdow div{padding:5px 0;text-align:center;font-size:9.5px;font-weight:800;
    letter-spacing:.06em;color:#8C9E93;text-transform:uppercase}
  .vms-mapwk{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
  .vms-mapc{height:38px;border-right:1px solid #EFF3EF;border-bottom:1px solid #EFF3EF;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
    background:#fff;font:inherit;padding:0;min-width:0}
  .vms-mapc:nth-child(7n){border-right:0}
  .vms-mapwk:last-of-type .vms-mapc{border-bottom:0}
  .vms-mapc b{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1}
  /* SOLID INK, 5px. A 4px hairline reads as an underline nobody would ask about — the same
     failure the green Veo dot and the fill bars were removed from the desktop grid for. */
  .vms-mapc .dot{height:5px;border-radius:99px;background:#5EA97F;min-width:5px}
  .vms-mapc.out{background:#FAFCFA}
  .vms-mapc.out b{color:#C3CFC7}
  .vms-mapc.past b{color:#93A49A}
  .vms-mapc.past .dot{background:#C3D4CA}
  .vms-mapc.today{background:#E9FAF0;box-shadow:inset 0 0 0 2px #35c77f}
  .vms-mapc.today b{color:#046B45;font-weight:800}
  .vms-mapc.sel{background:#0d3b2e}
  .vms-mapc.sel b{color:#fff}
  .vms-mapc.sel .dot{background:#7fd3a6}
  /* THE LEGEND IS NOT OPTIONAL. An unlabelled mark on this view has had to be explained aloud
     twice ("what are the yellow lines"). Explain it or drop it. */
  .vms-mapleg{display:flex;align-items:center;gap:5px;padding:5px 9px;border-top:1px solid #EFF3EF;
    background:#FBFDFB;font-size:10.5px;font-weight:600;color:#6d7b74}
  .vms-mapleg s{text-decoration:none;height:5px;border-radius:99px;background:#5EA97F;flex:none}

  /* ── the agenda: one match, one full-width row ── */
  .vms-ag{display:block;margin-top:8px;overflow:hidden}
  .vms-agempty{padding:22px 12px;text-align:center;font-size:12.5px;color:#6d7b74}
  .vms-agdh{display:flex;align-items:baseline;gap:7px;padding:8px 12px 6px;background:#F7FAF8;
    border-bottom:1px solid #EFF3EF;border-top:1px solid #EFF3EF}
  .vms-ag>div:first-child .vms-agdh{border-top:0}
  .vms-agdh b{font-size:12.5px;font-weight:800}
  .vms-agdh .td{font-size:9.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;
    color:#fff;background:#35c77f;border-radius:4px;padding:1px 5px}
  .vms-agdh .n{margin-left:auto;font-size:11px;font-weight:700;color:#6d7b74;
    font-variant-numeric:tabular-nums;text-align:right}
  .vms-agdh.past b,.vms-agdh.past .n{color:#93A49A}
  .vms-agi{display:flex;align-items:center;gap:9px;width:100%;padding:9px 12px;border:0;
    border-bottom:1px solid #EFF3EF;background:#fff;font:inherit;text-align:left;min-height:44px}
  .vms-agi:last-child{border-bottom:0}
  .vms-agi>b{flex:none;width:62px;font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums;
    white-space:nowrap}
  /* THE FIELD WRAPS. It does NOT ellipse — a truncated field is the grid's failure in miniature,
     and an agenda row can grow because nothing sits beside it to be knocked out of alignment. */
  .vms-agi>span{flex:1;min-width:0;font-size:12.5px;font-weight:600;color:#3d5245;
    white-space:normal;overflow-wrap:anywhere;line-height:1.3}
  .vms-agi>i{flex:none;font-style:normal;font-size:11.5px;font-weight:800;
    font-variant-numeric:tabular-nums;white-space:nowrap;color:#12241d}
  .vms-agfull{color:#046B45}
  .vms-aglow{color:#8a6300}
  .vms-agi>em.pr{flex:none;font-style:normal;font-size:11.5px;font-weight:700;
    font-variant-numeric:tabular-nums;white-space:nowrap;color:#046B45;width:44px;text-align:right}
  .vms-agi.cx{background:#FDF6F4}
  .vms-agi.cx>b,.vms-agi.cx>span,.vms-agi.cx>i,.vms-agi.cx>em{color:#b08278}
  .vms-agi.cx>span{text-decoration:line-through}
  .vms-agi .cxtag{flex:none;font-style:normal;font-size:9.5px;font-weight:900;letter-spacing:.05em;
    color:#a8391a;background:#fdeae4;border-radius:4px;padding:1px 5px}

  /* ── the sheet ── */
  .vms-scrim{display:block;position:fixed;inset:0;z-index:60;background:rgba(18,36,29,.42)}
  .vms-sheet{display:flex;flex-direction:column;position:fixed;left:0;right:0;bottom:0;z-index:61;
    background:#fff;border-radius:16px 16px 0 0;max-height:82vh;
    padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -8px 28px rgba(16,40,28,.2)}
  .vms-sh{display:flex;align-items:center;gap:8px;padding:12px 14px 10px;border-bottom:1px solid #EFF3EF}
  .vms-sh b{font-size:14px;font-weight:800}
  .vms-sh .cnt{font-size:11.5px;color:#6d7b74;font-weight:600}
  .vms-sh .x{margin-left:auto;border:1px solid #0d3b2e;background:#0d3b2e;color:#fff;border-radius:9px;
    height:32px;padding:0 12px;font:inherit;font-size:12.5px;font-weight:700}
  .vms-ssearch{margin:10px 14px 8px;height:38px;border:1px solid var(--line);border-radius:10px;
    padding:0 10px;font:inherit;font-size:13px;color:#12241d;background:#fff}
  .vms-sall{margin:0 14px 8px;display:flex;gap:6px}
  .vms-sall button{flex:1;height:34px;border:1px solid var(--line);background:#fff;border-radius:9px;
    font:inherit;font-size:12px;font-weight:700;color:#3d5245}
  .vms-sall button.on{background:#0d3b2e;border-color:#0d3b2e;color:#fff}
  .vms-sdrop{margin:0 14px 8px;font-size:11.5px;color:#8a6300;background:#fdf1d0;
    border:1px solid #e3c369;border-radius:8px;padding:6px 8px;line-height:1.4}
  .vms-slist{flex:1;min-height:0;overflow-y:auto;border-top:1px solid #EFF3EF}
  .vms-sempty{padding:18px 14px;font-size:12.5px;color:#6d7b74}
  .vms-sit{display:flex;align-items:center;gap:10px;width:100%;padding:0 14px;min-height:46px;
    border:0;border-bottom:1px solid #EFF3EF;background:#fff;font:inherit;font-size:13px;
    font-weight:600;color:#3d5245;text-align:left}
  .vms-sit .bx{flex:none;width:19px;height:19px;border-radius:5px;border:1.5px solid #C6D4CC;
    background:#fff;position:relative}
  .vms-sit.on .bx{background:#0d3b2e;border-color:#0d3b2e}
  .vms-sit.on .bx::after{content:"";position:absolute;left:6px;top:2px;width:5px;height:10px;
    border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg)}
  .vms-sit .nm{flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.3;padding:8px 0}
  .vms-sit .ct{flex:none;font-size:11px;font-weight:700;color:#9AA8A0;font-variant-numeric:tabular-nums}
  .vms-sit.on{color:#12241d;font-weight:700}
}
`;

/* ── MONTH VIEW ────────────────────────────────────────────────────────────────────────────────
 * A calendar grid over a date RANGE. It is an addition: the week view is untouched and the two
 * share the page's drawer, so clicking a match here opens the SAME editor the week view opens —
 * MatchDrawer is mounted once at page level and both views call the same openCard.
 *
 * DENSITY — AND THE CAP THAT USED TO BE HERE.
 *
 * This said: "Cells are a FIXED height and never stretch their row: a Saturday with nine matches
 * must not make every other Saturday nine rows tall." That was right about the MECHANISM — a week
 * row is as tall as its busiest day, because that is how CSS grid stretches — and MONTH_CAP = 6
 * plus a "+N more" button was the answer.
 *
 * THE CAP IS GONE, ON REQUEST, and this comment is kept rather than deleted because the reason it
 * existed has not stopped being true. What changed is the measurement: on the real September
 * board the cap was hiding 97 of 175 rows in the first two weeks — most of the month was behind a
 * click. It is survivable because September's days are UNIFORM, not spiky: 9 to 21 matches with a
 * median of 13, so the tallest day in a week is rarely more than 1.6x the median, and the stretch
 * costs about 27% whitespace.
 *
 * A MONTH WITH ONE 40-MATCH SATURDAY AND SIX QUIET DAYS WOULD BE A DIFFERENT ANSWER. That is the
 * condition under which this is worth revisiting — not a general dislike of tall rows.
 */
/* ── THE MONTH CELL ───────────────────────────────────────────────────────────────────────────
 * One line per match: time, field, count, price. Four things, in that order, every row the same
 * shape — the old entry was three pieces of text with no hierarchy and a 6px green dot.
 *
 * NO FILL BAR. A bar drawn beside the count is the same fact twice in a 145px cell, and the cell
 * has four things to fit already.
 *
 * NOTHING VEO. It has its own tab. The dot that used to sit before the price was unreadable as a
 * camera by anyone who had not been told it was one, and the width it took back belongs to the
 * count.
 */
function MonthView({ weeks, count, onOpen, selectedId, singleField, pick }: {
  weeks: GridDay[][]; count: number; onOpen: (id: number) => void;
  selectedId: number | null; singleField: boolean; pick?: PickMode;
}) {
  return (
    <div className="vms-card vms-month" data-testid="month-grid">
      <div className="vms-mdow">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}
      </div>
      {count === 0 ? (
        <div className="vms-mempty">No matches in this range with these filters.</div>
      ) : weeks.map((week, wi) => (
        <div className="vms-mweek" key={wi}>
          {week.map((d) => (
            <MonthCell key={d.iso} d={d} onOpen={onOpen} selectedId={selectedId}
              singleField={singleField} pick={pick} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── THE MONTH MAP (phone only) ───────────────────────────────────────────────────────────────
 * Seven columns that hold NO TEXT. That is the whole trick: the desktop cell has to carry a time,
 * a field, a count and a price — four things needing ~112px — and seven of those is 784px of grid
 * in a 366px box, which is why Fri, Sat and Sun were only reachable by a sideways swipe. A day
 * number and a density bar fit in 52px, so Saturday is on screen and nothing scrolls sideways.
 *
 * THE BAR IS MEASURED AGAINST THE BUSIEST DAY IN THE RANGE, not a constant: against a constant it
 * says nothing in a quiet month and saturates in a busy one. It has a legend under it because an
 * unlabelled mark on this exact view has already had to be explained out loud twice.
 */
function MonthMap({ weeks, picked, onPick }: {
  weeks: GridDay[][]; picked: string | null; onPick: (iso: string) => void;
}) {
  const peak = busiestDay(weeks);
  return (
    <div className="vms-card vms-map" data-testid="month-map">
      <div className="vms-mapdow">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      {weeks.map((wk, wi) => (
        <div className="vms-mapwk" data-testid="mob-mapweek" key={wi}>
          {wk.map((d) => {
            const n = d.inRange ? d.matches.length : 0;
            // FLOOR 5px so a single match is a visible mark rather than a hairline nobody sees;
            // hidden outright on a genuinely empty day, so "none" and "one" are not the same width.
            const w = peak > 0 && n > 0 ? Math.max(5, Math.round((n / peak) * 30)) : 5;
            return (
              <button type="button" key={d.iso} data-testid="mob-mapcell" data-iso={d.iso} data-n={n}
                aria-label={`${d.iso}, ${n} match${n === 1 ? "" : "es"}`}
                className={"vms-mapc" + (d.inRange ? "" : " out") + (d.isToday ? " today" : "")
                  + (d.isPast ? " past" : "") + (picked === d.iso ? " sel" : "")}
                onClick={() => n > 0 && onPick(d.iso)}>
                <b>{d.day}</b>
                <span className="dot" style={{ width: w, visibility: n > 0 ? "visible" : "hidden" }} />
              </button>
            );
          })}
        </div>
      ))}
      <div className="vms-mapleg" data-testid="mob-maplegend">
        <s style={{ width: 5 }} /><s style={{ width: 16 }} /><s style={{ width: 30 }} />
        <span>Bar = that day&rsquo;s match count, against the busiest day in the range.</span>
      </div>
    </div>
  );
}

/* ── THE AGENDA (phone only) ──────────────────────────────────────────────────────────────────
 * One match, one full-width row. 350px of content instead of 112 means the field is written out
 * rather than being the flex item that gives way.
 *
 * ONLY DAYS WITH MATCHES GET A SECTION. Thirty empty headers to scroll past is the same defect
 * pointing the other way; the map above still shows every day, so the month stays complete.
 *
 * NO +N MORE. A day here is a section, not a fixed-height cell, so it has no height to overflow —
 * The desktop grid's cap is gone too (see the density note above), so the two views agree: every
 * match a day holds is on screen in both.
 */
/* THE SOURCE'S FIELD. The detail route FLATTENS field.city.name and field.title onto the match as
 * `cityName` / `fieldTitle` (pickMatch in matchday/[env]/matches/[id]/route.ts), so `src.field` is
 * not there to read — the nested shape is kept as a fallback for anything handing over the raw
 * API object. Canonicalised, because that is the vocabulary the grid's own venue holds and the
 * preview is compared against it to spot a collision. */
function srcVenueName(src: SourceMatch | null): string {
  if (!src) return "";
  const flat = typeof src.fieldTitle === "string" ? src.fieldTitle : "";
  const nested = typeof (src.field as { title?: unknown } | null)?.title === "string"
    ? String((src.field as { title?: unknown }).title) : "";
  return canonicalVenueName(flat || nested);
}

/** "2026-09-18" → "Fri Sep 18". A CALENDAR DATE at UTC midnight, which cannot shift. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()]} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Today at the pitch, in the timezone the rest of Clubhouse reads operator dates in. */
const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/** "19:30" → "7:30 PM". Five characters in, a label out — no Date, no zone. */
function hhmmTo12(hhmm: string): string {
  const [H, M] = hhmm.split(":").map(Number);
  if (!Number.isFinite(H)) return hhmm;
  return `${(H % 12) || 12}:${String(M).padStart(2, "0")} ${H >= 12 ? "PM" : "AM"}`;
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Thu 3 Sep". isoDow does the weekday on a UTC-midnight date — a calendar bound, not an instant,
 *  so it cannot shift — and the day and month are sliced straight off the string. */
function agendaDate(iso: string): string {
  return `${DOW[isoDow(iso) - 1]} ${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
}

function MonthAgenda({ weeks, allMatches, showCx, picked, onOpen }: {
  weeks: GridDay[][]; allMatches: GridMatch[]; showCx: boolean;
  picked: string | null; onOpen: (id: number) => void;
}) {
  // How many cancelled the toggle is HIDING on each day — so a day can say so rather than just
  // being quietly shorter than the map above it claims.
  const hiddenCx = new Map<string, number>();
  if (!showCx) for (const m of allMatches) if (m.cancelled) hiddenCx.set(m.date, (hiddenCx.get(m.date) ?? 0) + 1);

  const days = weeks.flat().filter((d) => d.inRange && d.matches.length > 0);
  return (
    <div className="vms-card vms-ag" data-testid="month-agenda">
      {days.length === 0 ? (
        <div className="vms-agempty">No matches in this range with these filters.</div>
      ) : days.map((d) => {
        const cx = hiddenCx.get(d.iso) ?? 0;
        return (
          <div key={d.iso}>
            <div className={"vms-agdh" + (d.isPast ? " past" : "")} data-testid="mob-day" data-iso={d.iso}
              style={picked === d.iso ? { background: "#E9FAF0" } : undefined}>
              <b>{agendaDate(d.iso)}</b>
              {d.isToday && <span className="td">Today</span>}
              <span className="n">
                {d.matches.length} match{d.matches.length === 1 ? "" : "es"}
                {cx > 0 && ` · ${cx} cancelled hidden`}
              </span>
            </div>
            {d.matches.map((m) => {
              // AMBER ONLY ON TODAY, and fillTone is where that lives — never re-tested here.
              const tone = fillTone(m, d.isToday);
              return (
                <button type="button" key={m.apiId} className={"vms-agi" + (m.cancelled ? " cx" : "")}
                  data-testid="mob-match" data-id={m.apiId} data-tone={tone || "none"}
                  data-cancelled={m.cancelled ? "1" : "0"} onClick={() => onOpen(m.apiId)}>
                  <b>{m.time}</b>
                  {/* THE FIELD WRAPS, IT DOES NOT ELLIPSE. "LBJ Early College High School" is 207px
                      of text in a 173px column; an ellipsis there makes the check pass while the
                      operator reads a truncated field, which is the grid's failure in miniature. An
                      agenda can grow a row because nothing sits beside it to be knocked out of
                      alignment — the same property that made this an agenda at all. */}
                  <span>{m.venue}</span>
                  {m.cancelled && <em className="cxtag">CX</em>}
                  <i className={tone ? `vms-ag${tone}` : undefined}>{countLabel(m)}</i>
                  {priceLabel(m.price) !== null && <em className="pr">{priceLabel(m.price)}</em>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ── THE PICKER SHEET (phone only) ────────────────────────────────────────────────────────────
 * The same control Player Finder got, for the same reason: the filter you are NOT using should
 * cost nothing on screen. The button that opens it carries the current selection, so the bar
 * states what is filtered without listing what is not.
 *
 * SELECTING NOTHING STILL MEANS ALL — applyFilters is untouched, only its control changed. */
function PickerSheet({ kind, onClose, cities, city, onPickCity, fields, counts, selected, onToggleField, onAllFields, dropped }: {
  kind: "city" | "field"; onClose: () => void;
  cities: string[]; city: string | null; onPickCity: (c: string | null) => void;
  fields: string[]; counts: Map<string, number>; selected: ReadonlySet<string>;
  onToggleField: (f: string) => void; onAllFields: () => void; dropped: string[];
}) {
  const [q, setQ] = useState("");
  const isCity = kind === "city";
  // 23 fields is already past scanning and the board grows, which is what the search is for.
  const list = (isCity ? cities : fields).filter((x) => x.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="vms-scrim" data-testid="mob-scrim" onClick={onClose} />
      <div className="vms-sheet" data-testid="mob-sheet" data-kind={kind} role="dialog" aria-label={isCity ? "City" : "Field"}>
        <div className="vms-sh">
          <b>{isCity ? "City" : "Field"}</b>
          <span className="cnt" data-testid="mob-sheet-count">
            {isCity ? (city ?? "All cities") : `${selected.size || fields.length} of ${fields.length} selected`}
          </span>
          <button type="button" className="x" data-testid="mob-sheet-done" onClick={onClose}>Done</button>
        </div>
        <input className="vms-ssearch" data-testid="mob-sheet-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={isCity ? `Search ${cities.length} cities` : `Search ${fields.length} fields`} />
        <div className="vms-sall">
          {/* NOT LIT WHILE A SUBSET IS SELECTED — that would contradict the count beside it. */}
          <button type="button" data-testid="mob-sheet-all"
            className={(isCity ? !city : selected.size === 0) ? "on" : ""}
            onClick={() => (isCity ? onPickCity(null) : onAllFields())}>
            {isCity ? "All cities" : "All fields"}
          </button>
          {!isCity && <button type="button" data-testid="mob-sheet-clear" onClick={onAllFields}>Clear</button>}
        </div>
        {dropped.length > 0 && !isCity && (
          <div className="vms-sdrop" data-testid="mob-sheet-dropped">
            {dropped.join(", ")} {dropped.length === 1 ? "has" : "have"} no matches in this range — removed from the filter
          </div>
        )}
        <div className="vms-slist">
          {list.length === 0 ? (
            <div className="vms-sempty">Nothing matches &ldquo;{q}&rdquo;.</div>
          ) : list.map((x) => {
            const on = isCity ? city === x : selected.has(x);
            return (
              <button type="button" key={x} className={"vms-sit" + (on ? " on" : "")}
                data-testid="mob-sheet-item" data-name={x} data-on={on ? "1" : "0"}
                onClick={() => (isCity ? onPickCity(x) : onToggleField(x))}>
                <span className="bx" aria-hidden />
                <span className="nm">{x}</span>
                {!isCity && <span className="ct">{counts.get(x) ?? 0}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* PICK MODE. Passed down rather than read from a context so a cell stays a pure function of its
 * props — the picks live above the grid, which is what lets the ‹ › arrows carry them. */
export type PickMode = {
  srcId: number; srcIso: string; srcHHMM: string; srcVenue: string;
  picks: Map<string, string>; todayIso: string;
  onToggle: (iso: string) => void;
};

function MonthCell({ d, onOpen, selectedId, singleField, pick }: {
  d: GridDay; onOpen: (id: number) => void; selectedId: number | null;
  singleField: boolean; pick?: PickMode;
}) {
  // EVERY MATCH THE DAY HOLDS. No slice, so the cell's badge and its row count are the same
  // number by construction rather than by agreement.
  const shown = d.matches;
  const cx = d.matches.filter((m) => m.cancelled).length;
  /* EVERY DAY IS PICKABLE EXCEPT ONE ALREADY PAST — including the padding days of the neighbouring
     months, because "copy this Friday through October" is the actual use. */
  const picked = pick?.picks.has(d.iso) ?? false;
  const pickable = !!pick && !d.isPast;
  const pickTime = pick?.picks.get(d.iso) ?? "";
  const changed = picked && pickTime !== pick?.srcHHMM;
  /* THE COLLISION, COMPUTED ON EVERY RENDER AND NEVER STORED. A day already holding this fixture
     at this time is marked, not refused — the copy still lands. */
  const clash = picked && d.matches.some((m) => m.venue === pick?.srcVenue && m.time === hhmmTo12(pickTime));
  return (
    <div
      className={"vms-mcell" + (d.inRange ? "" : " vms-mout") + (d.isToday ? " vms-mtoday" : "")
        + (d.isPast ? " vms-mpast" : "") + (picked ? " vms-mpick" : "") + (pickable ? " vms-mpickable" : "")}
      data-testid="month-cell" data-iso={d.iso} data-inrange={d.inRange ? "1" : "0"}
      data-past={d.isPast ? "1" : "0"} data-today={d.isToday ? "1" : "0"}
      data-picked={picked ? "1" : "0"} data-clash={clash ? "1" : "0"}
      onClick={pickable ? () => pick!.onToggle(d.iso) : undefined}>
      <div className="vms-mhead">
        <span className="vms-mnum">{d.day}</span>
        {/* THE TICK AND THE SOURCE BADGE GO IN THE HEADER'S FLOW, never absolutely positioned:
            placed top-right they landed straight on the day's match count, so picking a day
            silently hid the number saying how busy it is. */}
        {picked && <span className="vms-mtick" data-testid="pick-tick" aria-label="picked">✓</span>}
        {pick && d.iso === pick.srcIso && <span className="vms-msrc" data-testid="pick-source">SOURCE</span>}
        {d.isToday && <span className="vms-mtd">Today</span>}
        {/* THE DAY'S COUNT, in the corner, so a scrolling cell says how much it holds. */}
        {d.matches.length > 0 && (
          <span className="vms-mcount" data-testid="month-daycount">
            {d.matches.length}{cx > 0 && <u> · {cx} cx</u>}
          </span>
        )}
      </div>
      <div className="vms-mlist">
        {shown.map((m) => {
          /* AMBER IS TODAY-ONLY, and fillTone is where that rule lives — never re-tested here.
             Green (at capacity) applies on any day. */
          const tone = fillTone(m, d.isToday);
          return (
            <button type="button" key={m.apiId} data-testid="month-match" data-id={m.apiId}
              data-cancelled={m.cancelled ? "1" : "0"} data-tone={tone || "none"}
              className={"vms-mitem" + (selectedId === m.apiId ? " vms-msel" : "")
                + (m.cancelled ? " vms-mcx" : "")}
              /* IN PICK MODE THE WHOLE CELL IS THE CONTROL, matches included. Otherwise clicking a
                 day that holds matches both picks it and opens the editor over the calendar you
                 are picking on. */
              onClick={(e) => { if (pick) { e.stopPropagation(); pick.onToggle(d.iso); return; } onOpen(m.apiId); }}
              /* THE TOOLTIP CARRIES THE UNTRUNCATED TEXT. The field ellipses in a narrow cell;
                 this is where the whole of it lives, count and price included. */
              title={[m.time, m.venue, m.name, countLabel(m), priceLabel(m.price),
                m.cancelled ? "CANCELLED" : null].filter(Boolean).join(" · ")}>
              <b>{m.time}</b>
              {/* The field, unless the filter is already down to a single field — at which point
                  the field is a constant and the NAME is what distinguishes one entry from another. */}
              <span>{singleField ? m.name : m.venue}</span>
              {/* REAL PLAYERS. countLabel subtracts the fakes; see monthGrid.realCount. */}
              <i className={"vms-mcnt" + (tone ? ` vms-m${tone}` : "")} data-testid="month-count-cell">
                {countLabel(m)}
              </i>
              {/* NULL RENDERS NOTHING — no element, no placeholder, no gap. priceLabel returns
                  null only for a missing price; a real 0 comes back "$0". */}
              {priceLabel(m.price) !== null && (
                <em className="vms-mprice" data-testid="month-price">{priceLabel(m.price)}</em>
              )}
            </button>
          );
        })}
        {picked && (
          <div className={"vms-mprev" + (changed ? " chg" : "") + (clash ? " clash" : "")}
            data-testid="pick-preview" data-changed={changed ? "1" : "0"}>
            <b>{hhmmTo12(pickTime)}</b>
            <span>{pick?.srcVenue}</span>
            <i>{clash ? "2nd" : "copy"}</i>
          </div>
        )}
      </div>
    </div>
  );
}
