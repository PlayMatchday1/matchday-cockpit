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
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { supabase } from "@/lib/supabase";
import { downloadCsv, plural } from "@/components/growth/format";
import MatchDrawer, { DRAWER_W, type DrawerMatch } from "@/components/MatchDrawer";

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
};

type Unit = { venue: string; times: string[] };
type View = "schedule" | "veo";

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
  const mayWriteName = canEditMatches(appUser);
  const [nameFailed, setNameFailed] = useState<Map<number, string>>(new Map());
  // WHAT WE ACTUALLY WROTE, so the next toggle diffs against reality rather than the lagging
  // mirror. Without this, toggling on then straight off computes from the stale (un-emoji'd) name,
  // finds no 🎥 to strip, sends nothing, and leaves the camera on a match whose flag is off.
  const [wroteName, setWroteName] = useState<Map<number, string>>(new Map());
  const [view, setView] = useState<View>("schedule");
  const [busy, setBusy] = useState(false);
  // "" = current week; otherwise a date (YYYY-MM-DD) within the selected week.
  const [weekRef, setWeekRef] = useState<string>("");
  const [navBusy, setNavBusy] = useState(false);
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
  async function load(ref: string) {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const url = ref ? `/api/veo?week=${encodeURIComponent(ref)}` : "/api/veo";
      const res = await fetch(url, { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as VeoWeek;
      setWeek(json);
      setError("");
    } catch {
      setError("Couldn't load Veo coverage. Try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(""); }, []);

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
  const goPrev = () => { if (week) void navigate(shiftWeek(week.weekStart, -1)); };
  const goNext = () => { if (week) void navigate(shiftWeek(week.weekStart, 1)); };
  const goToday = () => void navigate("");

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

  const openCard = useCallback((id: number) => {
    if (drawerId != null && drawerId !== id && drawerDirty) { showToast("Save or revert the open match first.", true); return; }
    setDrawerId(id);
  }, [drawerId, drawerDirty, showToast]);

  const closeDrawer = useCallback(() => { setDrawerId(null); setDrawerDirty(false); }, []);

  // Patch the ONE card after a save — never refetch the whole week.
  const patchCard = useCallback((id: number, patch: { name: string; startDate: string; venue: string | null; city: string | null }) => {
    setWeek((w) => {
      if (!w) return w;
      return {
        ...w,
        matches: w.matches.map((m) => {
          if (m.apiId !== id) return m;
          const time = patch.startDate ? patch.startDate.slice(11, 16) : m.time;
          const [H, M] = time.split(":").map(Number);
          const h12 = `${(H % 12) || 12}:${String(M).padStart(2, "0")} ${H >= 12 ? "PM" : "AM"}`;
          return { ...m, name: patch.name || m.name, time: h12, minutes: H * 60 + M, venue: patch.venue || m.venue, city: patch.city || m.city };
        }),
      };
    });
  }, []);

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
            {week && (
              <div className="vms-wknav" aria-busy={navBusy}>
                <button type="button" className="vms-navbtn" onClick={goPrev} disabled={navBusy} aria-label="Previous week" title="Previous week">‹</button>
                <div className={"vms-wklabel" + (isCurrentWeek ? "" : " vms-wklabel-away")}>
                  <span className="vms-wkrange">{weekRangeLabel(week.days)}</span>
                  <span className={"vms-wktag" + (isCurrentWeek ? " vms-wktag-now" : "")}>{isCurrentWeek ? "This week" : "Not current week"}</span>
                </div>
                <button type="button" className="vms-navbtn" onClick={goNext} disabled={navBusy} aria-label="Next week" title="Next week">›</button>
                <button type="button" data-testid="today" className={"vms-btn vms-todaybtn" + (isCurrentWeek ? "" : " vms-todaybtn-hot")} onClick={goToday} disabled={navBusy || isCurrentWeek} title="Jump to the current week">Today</button>
                {/* COPY MATCH — one at a time, by construction: it acts on the SELECTED match, and
                    only one card can be selected. It navigates to the create form and writes
                    nothing; the copy exists only in that form until Create is pressed. */}
                <button
                  type="button"
                  data-testid="copy-match"
                  className="vms-btn"
                  disabled={drawerId == null}
                  title={drawerId == null ? "Select a match first" : `Copy match ${drawerId}`}
                  onClick={() => { if (drawerId != null) window.location.href = `/match-ops/matches/new?from=${drawerId}`; }}
                >
                  {drawerId == null ? "Copy match" : `Copy match ${drawerId}`}
                </button>
              </div>
            )}
            <span className="vms-control-label">View</span>
            <div className="vms-segmented" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === "schedule"} className={"vms-seg-btn" + (view === "schedule" ? " vms-active" : "")} onClick={() => setView("schedule")}>Schedule</button>
              <button type="button" role="tab" aria-selected={view === "veo"} className={"vms-seg-btn" + (view === "veo" ? " vms-active" : "")} onClick={() => setView("veo")}>Veo coverage</button>
            </div>
            <button type="button" className="vms-btn" onClick={exportWorklist} disabled={!week}>Export worklist</button>
          </div>
        </div>

        {week && week.cities.length > 0 && (
          <div className="vms-filter" data-testid="city-filter" role="group" aria-label="Filter cities">
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
      ) : !week || !fweek ? null : view === "schedule" ? (
        <ScheduleView week={fweek} busy={busy} onToggle={toggleIntent} onRetry={retryName} onOpen={openCard} selectedId={drawerId} failed={nameFailed} />
      ) : (
        <VeoView week={fweek} stats={stats!} busy={busy} onCameras={setCameras} needEmoji={needEmoji} needClubhouse={needClubhouse} onExport={exportWorklist} />
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
`;
