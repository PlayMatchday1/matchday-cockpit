"use client";

// Master Schedule lens on /cities. One section per city, with a
// 7-column Mon..Sun grid of match slots for the selected week.
// Backed by the schedule_master table (legacy MatchDay master
// schedule HTML, seeded once in migration 0038).
//
// Bubbles render as "{time} {venue}" using the canonical venue
// name from schedule_master.venue (post-migration 0040 these are
// always one of the 21 keys in src/lib/venueAliases.ts). Hovering
// a bubble shows the full "{time-range} - {detail}" string via
// the title attribute so the per-field granularity stays
// accessible.
//
// Changes vs last week:
//   The component fetches the selected week AND the previous week
//   in parallel. A small banner above the grid summarizes counts;
//   per-city change rows list added / dropped slots. In the grid
//   itself, added bubbles get a green dot, dropped bubbles render
//   as a strikethrough "ghost" in the same day cell.
//
//   Slot identity is (city, day_of_week, venue, time). Within each
//   (city, day, venue) bucket we intersect by time string:
//     - time in both prev and cur → unchanged (no pill)
//     - time in cur only          → added
//     - time in prev only         → dropped (ghost in the day cell)
//
//   No "time changed" pairing. The earlier positional-pairing logic
//   mislabeled additions as moves whenever new slots were inserted
//   at indices already occupied by existing-and-unchanged slots
//   (e.g. adding a 9AM in front of an existing 6PM made the diff
//   call it "6PM → 9AM"). Without a reliable per-slot identity
//   beyond venue+time, a genuine move and a (drop + add) at
//   different times are indistinguishable; we prefer the honest
//   two-pill rendering.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Plus, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import MasterScheduleEditModal, {
  type EditableRow,
} from "./MasterScheduleEditModal";

type MatchOut = {
  id: string;
  venue: string;
  detail: string;
  time: string;
  max_spots: number;
  mdapi_field_id: number | null;
  // 'template' = recurring weekly slot; 'manual'/'auto_completed' = one-off.
  // Drives the dashed (one-off) vs solid (recurring) border in the grid.
  source: string;
  // Future planning: is this planned slot already on MatchDay? When false the
  // grid flags it so ops knows to create it in the app.
  in_matchday?: boolean;
};

// What mdapi_matches actually recorded — rendered for completed (past) days.
type ActualOut = {
  api_id: number;
  venue: string;
  detail: string;
  time: string;
  max_spots: number | null;
  player_count: number | null;
  is_cancelled: boolean;
};

type DayOut = {
  date: string;
  day_of_week: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  is_past?: boolean;
  matches: MatchOut[];
  actual_matches?: ActualOut[];
};

type CityOut = { name: string; total: number; days: DayOut[] };

type Payload = {
  week_start: string;
  week_end: string;
  today?: string;
  cities: CityOut[];
};

type Diff = {
  hasAny: boolean;
  // Current-week match ids that are new vs last week. Drives the
  // green dot indicator in the grid.
  addedIds: Set<string>;
  // City|DayOfWeek → ghost matches to render in that cell.
  ghostsByCell: Map<string, GhostMatch[]>;
  // Per-city, day-ordered lists for the change row.
  perCity: Map<string, ChangePill[]>;
  // Totals for the top banner.
  addedCount: number;
  droppedCount: number;
};

type GhostMatch = {
  id: string; // previous week match id
  detail: string;
  venue: string;
  time: string; // full string for tooltip
  time_short: string;
};

type ChangePill =
  | { kind: "added"; dayOfWeek: string; venue: string; time_short: string }
  | { kind: "dropped"; dayOfWeek: string; venue: string; time_short: string };

const EMPTY_DIFF: Diff = {
  hasAny: false,
  addedIds: new Set(),
  ghostsByCell: new Map(),
  perCity: new Map(),
  addedCount: 0,
  droppedCount: 0,
};

const DOW_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// ============================================================
// Duplicate detection (S2/S3) — Master Schedule only.
// ============================================================
// A venue cannot run two matches on one field at one time. So for each
// (city, venue, start_time, day) slot:
//     extras = max(0, matches_in_slot - fields_mapped_to_that_venue)
// fields_mapped comes from fin_venue_fields (COUNT of rows for the fin_venue).
//
// !! When the eventual DELETE/dedup is written, its key MUST include field_id.
// NEMP (fin_venue 2) genuinely runs two concurrent field_ids — 10 ("North East
// Metropolitan Park") and 17 ("NEMP Tournaments") — so a dedup keyed on
// (venue, start_time) alone would delete real, distinct matches. This ticket
// only SURFACES duplicates; it never deletes (S4).
type FieldMap = {
  fieldToVenue: Map<number, number>; // mdapi_field_id → fin_venue_id
  venueFieldCount: Map<number, number>; // fin_venue_id → number of fields
  venueName: Map<number, string>; // fin_venue_id → name
};

type SlotDup = {
  n: number;
  fieldsMapped: number | null; // null = venue not mapped
  extras: number;
  state: "clean" | "dup" | "unchecked";
};

type DupModel = {
  bySlot: Map<string, SlotDup>; // key: city|date|venue|compactTime — matches the tile key
  totalDup: number;
  perVenue: { city: string; venue: string; fields: number; slots: number; extras: number }[];
  unmapped: { city: string; venue: string; sessions: number }[];
  unmappedSessions: number;
};

function computeDupModel(payload: Payload | null, fm: FieldMap | null): DupModel {
  const bySlot = new Map<string, SlotDup>();
  const empty: DupModel = { bySlot, totalDup: 0, perVenue: [], unmapped: [], unmappedSessions: 0 };
  if (!payload || !fm) return empty;
  const perVenue = new Map<string, { city: string; venue: string; fields: number; slots: number; extras: number }>();
  const unmapped = new Map<string, { city: string; venue: string; sessions: number }>();
  let totalDup = 0;
  let unmappedSessions = 0;

  for (const c of payload.cities) {
    for (const d of c.days) {
      // Group the day's matches into (venue, start_time) slots.
      const groups = new Map<string, MatchOut[]>();
      for (const m of d.matches) {
        const k = `${m.venue}|${compactTime(m.time)}`;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
      }
      for (const [gk, ms] of groups) {
        const [venue] = gk.split("|");
        const n = ms.length;
        // Resolve the fin_venue from any match's field_id.
        let finVenue: number | null = null;
        for (const m of ms) {
          if (m.mdapi_field_id != null && fm.fieldToVenue.has(m.mdapi_field_id)) {
            finVenue = fm.fieldToVenue.get(m.mdapi_field_id)!;
            break;
          }
        }
        const slotKey = `${c.name}|${d.date}|${gk}`;
        if (finVenue == null) {
          // Outcome (c): unmapped — duplicates can't be checked.
          bySlot.set(slotKey, { n, fieldsMapped: null, extras: 0, state: "unchecked" });
          unmappedSessions += n;
          const uk = `${c.name}|${venue}`;
          const prev = unmapped.get(uk) ?? { city: c.name, venue, sessions: 0 };
          prev.sessions += n;
          unmapped.set(uk, prev);
          continue;
        }
        const fields = fm.venueFieldCount.get(finVenue) ?? 0;
        const extras = Math.max(0, n - fields);
        bySlot.set(slotKey, {
          n,
          fieldsMapped: fields,
          extras,
          state: extras > 0 ? "dup" : "clean",
        });
        if (extras > 0) {
          totalDup += extras;
          const vk = `${c.name}|${venue}`;
          const prev = perVenue.get(vk) ?? { city: c.name, venue, fields, slots: 0, extras: 0 };
          prev.slots += 1;
          prev.extras += extras;
          prev.fields = fields;
          perVenue.set(vk, prev);
        }
      }
    }
  }
  return {
    bySlot,
    totalDup,
    perVenue: [...perVenue.values()].sort((a, b) => b.extras - a.extras),
    unmapped: [...unmapped.values()].sort((a, b) => b.sessions - a.sessions),
    unmappedSessions,
  };
}

// Singular/plural helper — grep-proof against " 1 fields" / " 1 matches".
function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Discrepancies = {
  week_start: string;
  week_end: string;
  total_schedule_master: number;
  total_mdapi_matches: number;
  missing_in_db: Array<{
    id: string;
    city: string;
    venue: string;
    detail: string;
    match_date: string;
    match_time: string;
    max_spots: number;
  }>;
  extra_in_db: Array<{
    mdapi_match_id: number;
    city: string;
    venue: string;
    match_date: string;
    match_time: string;
    max_spots: number | null;
  }>;
  mismatched: Array<{
    schedule_master_id: string;
    mdapi_match_id: number;
    city: string;
    venue: string;
    match_date: string;
    match_time: string;
    diffs: string[];
  }>;
  cancelled: Array<{
    schedule_master_id: string;
    mdapi_match_id: number;
    city: string;
    venue: string;
    detail: string;
    match_date: string;
    match_time: string;
    max_spots: number;
  }>;
};

// §1/§4 auto-reconcile extras, served by /api/schedule-master/reconcile.
type AutoAddedRow = {
  id: string;
  match_api_id: number;
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
};
type ReconcileHeartbeat = {
  autoreconcile_enabled: boolean;
  last_attempted_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  last_error: string | null;
};
type ReconcileExtras = {
  heartbeat: ReconcileHeartbeat | null;
  autoAdded: AutoAddedRow[];
};

// Same "X min ago" phrasing as the Community tab's heartbeat.
function agoMinutes(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}
function fmtAgo(min: number | null): string {
  if (min == null) return "never";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

type EditorState =
  | { kind: "closed" }
  | { kind: "edit"; row: EditableRow }
  | { kind: "create"; defaults: { city?: string; match_date?: string } };

// Optional `city` prop filters the rendered grid to that city only.
// The schedule_master fetch stays full-payload (the API doesn't have
// a per-city filter and the payload is small — one week × 8 cities);
// only the render loop scopes down. Slate Review uses this; the
// /cities lens leaves the prop unset for the all-cities view.
//
// Week selection is controlled-or-uncontrolled: pass both
// `weekStart` and `onWeekStartChange` to share the week with another
// section (Slate Review wires it to its action-items list so both
// stay synced). Omit the props for self-managed state — the /cities
// lens leaves them off and owns its own week.
export default function CitiesMasterScheduleLens({
  city,
  weekStart: controlledWeekStart,
  onWeekStartChange,
  masterSchedule = false,
}: {
  city?: string;
  weekStart?: string;
  onWeekStartChange?: (next: string) => void;
  // S5 scope guard: ALL of S1/S2/S3/S7 (labelled tiles, ×N chips, duplicate
  // detection, collapsible banners) render only when this is true. Only the
  // /match-ops/master-schedule page passes it; /lifecycle, /lifecycle/[city] and
  // /admin/finance leave it false and come out byte-identical.
  masterSchedule?: boolean;
} = {}) {
  const [internalWeekStart, setInternalWeekStart] = useState<string>(() =>
    isoDate(mondayOfChicago(new Date())),
  );
  const isControlled =
    controlledWeekStart !== undefined && onWeekStartChange !== undefined;
  const weekStart = isControlled ? controlledWeekStart! : internalWeekStart;
  const setWeekStart = (next: string) => {
    if (isControlled) {
      onWeekStartChange!(next);
    } else {
      setInternalWeekStart(next);
    }
  };
  const [current, setCurrent] = useState<Payload | null>(null);
  const [previous, setPrevious] = useState<Payload | null>(null);
  const [discrepancies, setDiscrepancies] = useState<Discrepancies | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileExtras | null>(null);
  const [busyIds, setBusyIds] = useState<Set<number>>(() => new Set());
  // Per-city change chips are collapsed behind the summary by default (§4).
  const [showChanges, setShowChanges] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [copying, setCopying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // ---- S1–S7 (Master Schedule only) ----
  // Venue→field mapping for duplicate detection, fetched once when enabled.
  const [fieldMap, setFieldMap] = useState<FieldMap | null>(null);
  // Both banners collapse to their summary chip by default (S7.1).
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);

  useEffect(() => {
    if (!masterSchedule) return;
    let off = false;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const res = await fetch("/api/schedule-master/field-map", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const j = (await res.json()) as {
          fields: { fin_venue_id: number; mdapi_field_id: number }[];
          venues: { id: number; venue_name: string | null; city: string | null }[];
        };
        const fieldToVenue = new Map<number, number>();
        const venueFieldCount = new Map<number, number>();
        for (const f of j.fields) {
          fieldToVenue.set(f.mdapi_field_id, f.fin_venue_id);
          venueFieldCount.set(f.fin_venue_id, (venueFieldCount.get(f.fin_venue_id) ?? 0) + 1);
        }
        const venueName = new Map<number, string>();
        for (const v of j.venues) venueName.set(v.id, v.venue_name ?? `Venue ${v.id}`);
        if (!off) setFieldMap({ fieldToVenue, venueFieldCount, venueName });
      } catch {
        /* leave null → detector shows "can't be checked" rather than a wrong clean */
      }
    })();
    return () => {
      off = true;
    };
  }, [masterSchedule]);

  const load = useCallback(async (ws: string) => {
    setLoading(true);
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setError("No active session.");
        setLoading(false);
        return;
      }
      const headers = { Authorization: `Bearer ${token}` };
      const prevWs = isoDate(addDays(parseIso(ws), -7));
      const fetchWeek = async (w: string): Promise<Payload> => {
        const res = await fetch(`/api/schedule-master?week_start=${w}`, {
          headers,
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        return (await res.json()) as Payload;
      };
      const fetchDiscrepancies = async (
        w: string,
      ): Promise<Discrepancies | null> => {
        try {
          const res = await fetch(
            `/api/schedule-master/discrepancies?week_start=${w}`,
            { headers },
          );
          if (!res.ok) return null;
          return (await res.json()) as Discrepancies;
        } catch {
          return null;
        }
      };
      // Auto-reconcile (§1): the panel only READS state (GET — heartbeat +
      // auto-added list, never writes). The actual auto-add runs from the hourly
      // cron so last_success_at measures job health, not when a tab was opened,
      // and matches never age out of the 14-day window unobserved. An admin can
      // force an immediate run with the explicit "Reconcile now" button.
      // Failure here must not blank the panel.
      const fetchReconcile = async (): Promise<ReconcileExtras | null> => {
        try {
          const res = await fetch("/api/schedule-master/reconcile", {
            method: "GET",
            headers,
          });
          if (!res.ok) return null;
          const j = (await res.json()) as ReconcileExtras;
          return { heartbeat: j.heartbeat ?? null, autoAdded: j.autoAdded ?? [] };
        } catch {
          return null;
        }
      };
      const [cur, prev, disc, rec] = await Promise.all([
        fetchWeek(ws),
        fetchWeek(prevWs),
        fetchDiscrepancies(ws),
        fetchReconcile(),
      ]);
      setCurrent(cur);
      setPrevious(prev);
      setDiscrepancies(disc);
      setReconcile(rec);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCurrent(null);
      setPrevious(null);
      setDiscrepancies(null);
      setReconcile(null);
    } finally {
      setLoading(false);
    }
  }, [city]);

  useEffect(() => {
    void load(weekStart);
  }, [load, weekStart]);

  // Toast auto-dismiss after 2.5s.
  useEffect(() => {
    if (!toastMsg) return;
    const t = window.setTimeout(() => setToastMsg(null), 2500);
    return () => window.clearTimeout(t);
  }, [toastMsg]);

  const openCreate = useCallback(() => {
    setEditor({
      kind: "create",
      defaults: { match_date: weekStart },
    });
  }, [weekStart]);

  const openEdit = useCallback((row: EditableRow) => {
    setEditor({ kind: "edit", row });
  }, []);

  const onSaved = useCallback(
    (kind: "create" | "update" | "delete") => {
      setEditor({ kind: "closed" });
      setToastMsg(
        kind === "create"
          ? "Session created"
          : kind === "update"
            ? "Session updated"
            : "Session deleted",
      );
      void load(weekStart);
    },
    [load, weekStart],
  );

  const todayIso = useMemo(() => isoDate(mondayOfChicago(new Date(), 0)), []);
  // When the `city` prop is set (Slate Review embed), scope the
  // diff totals and the per-city pill map to that city. Standalone
  // /cities lens leaves city undefined → network-wide diff.
  const diff = useMemo(
    () => buildDiff(current, previous, city),
    [current, previous, city],
  );
  const cancelledRefs = useMemo(
    () => buildCancelledRefs(discrepancies),
    [discrepancies],
  );

  // Master-Schedule-only: per-slot duplicate model + the review count. Both are
  // computed from real rows every render (never typed), and drive the summary
  // chips, the collapsible cards, and the ×N tile chips.
  const dupModel = useMemo(
    () => (masterSchedule ? computeDupModel(current, fieldMap) : null),
    [masterSchedule, current, fieldMap],
  );
  const reviewCount = useMemo(() => {
    if (!masterSchedule || !discrepancies) return 0;
    // Match DiscrepancyBanner's own "need review" = actionable set only
    // (extra-in-db + mismatched); missing/cancelled/auto-added are informational.
    const scope = (arr: { city?: string }[]) =>
      city ? arr.filter((r) => r.city === city).length : arr.length;
    return scope(discrepancies.extra_in_db) + scope(discrepancies.mismatched);
  }, [masterSchedule, discrepancies, city]);
  const sessionCount = useMemo(
    () =>
      (current?.cities ?? [])
        .filter((c) => !city || c.name === city)
        .reduce((sum, c) => sum + c.total, 0),
    [current, city],
  );
  // S7.8: a card can never be open for work that doesn't exist — AND the open
  // flag with "this category has rows" on every render so clearing the last
  // item auto-collapses the card.
  const reviewCardOpen = reviewOpen && reviewCount > 0;
  const dupOpen2 = dupOpen && (dupModel?.totalDup ?? 0) > 0;

  // §2 one-click add + Undo. Both mutate schedule_master, then reload so the
  // discrepancy buckets and auto-added list re-derive from the server.
  const withBusy = useCallback(
    async (ids: number[], run: (token: string) => Promise<Response>) => {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setToastMsg("No active session.");
        return;
      }
      setBusyIds((prev) => new Set([...prev, ...ids]));
      try {
        const res = await run(token);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        return j as Record<string, unknown>;
      } catch (err) {
        setToastMsg(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  const addToClubhouse = useCallback(
    async (matchIds: number[]) => {
      if (matchIds.length === 0) return;
      const j = await withBusy(matchIds, (token) =>
        fetch("/api/schedule-master/from-match", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ match_api_ids: matchIds }),
        }),
      );
      if (!j) return;
      const added = Number(j.added ?? 0);
      const already = Number(j.alreadyPresent ?? 0);
      setToastMsg(
        added > 0
          ? `Added ${added} to schedule${already ? ` (${already} already present)` : ""}`
          : "Already on the schedule",
      );
      await load(weekStart);
    },
    [withBusy, load, weekStart],
  );

  const undoOneOff = useCallback(
    async (matchApiId: number) => {
      const j = await withBusy([matchApiId], (token) =>
        fetch(`/api/schedule-master/from-match?match_api_id=${matchApiId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      if (!j) return;
      setToastMsg(Number(j.deleted ?? 0) > 0 ? "Removed from schedule" : "Nothing to remove");
      await load(weekStart);
    },
    [withBusy, load, weekStart],
  );

  // Explicit, deliberate immediacy affordance — the only in-app write trigger
  // for auto-reconcile. Background runs come from the cron; a page load never
  // writes. Idempotent, so a stray double-click is harmless.
  const reconcileNow = useCallback(async () => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      setToastMsg("No active session.");
      return;
    }
    setReconciling(true);
    try {
      const res = await fetch("/api/schedule-master/reconcile", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error((j.error as string) || `HTTP ${res.status}`);
      if (j.autoreconcileEnabled === false) {
        setToastMsg("Auto-reconcile is off — nothing added");
      } else {
        const n = Number(j.added ?? 0);
        setToastMsg(n > 0 ? `Reconciled — ${n} added` : "Reconciled — nothing to add");
      }
      await load(weekStart);
    } catch (err) {
      setToastMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setReconciling(false);
    }
  }, [load, weekStart]);

  // Build this week's plan from last week's recurring template — the "copy to
  // create in master schedule" for planning ahead. Server skips slots that
  // already exist; the newly-created future slots then show the "off MD" flag
  // until they're added on MatchDay.
  const copyLastWeek = useCallback(async () => {
    if (!confirm("Copy last week's recurring plan into this week? Existing slots are left untouched.")) return;
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setToastMsg("No active session."); return; }
    setCopying(true);
    try {
      const res = await fetch("/api/schedule-master/copy-week", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ week_start: weekStart }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error((j.error as string) || `HTTP ${res.status}`);
      const added = Number(j.added ?? 0);
      const skipped = Number(j.skipped ?? 0);
      setToastMsg(added > 0 ? `Copied ${added} from last week${skipped ? ` · ${skipped} already there` : ""}` : "Nothing to copy — this week already matches last week");
      await load(weekStart);
    } catch (err) {
      setToastMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCopying(false);
    }
  }, [load, weekStart]);

  const shift = (days: number) => {
    const d = parseIso(weekStart);
    d.setUTCDate(d.getUTCDate() + days);
    setWeekStart(isoDate(d));
  };
  const goToday = () => setWeekStart(isoDate(mondayOfChicago(new Date())));

  return (
    <section>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-deep-green">
            Master Schedule
          </h2>
          <p className="mt-1 text-sm text-deep-green/65">
            Completed days show what actually ran on MatchDay; upcoming days show the plan, with a flag on any slot not yet on MatchDay.
          </p>
        </div>
        <div className="inline-flex items-center gap-2">
          <WeekNav
            weekStart={weekStart}
            weekEnd={current?.week_end ?? weekStart}
            onPrev={() => shift(-7)}
            onNext={() => shift(7)}
            onToday={goToday}
          />
          {!city && (
            <button
              type="button"
              onClick={copyLastWeek}
              disabled={copying}
              title="Create this week's plan from last week's recurring template. Existing slots are left as-is; new ones show a flag until they're added on MatchDay."
              className="inline-flex items-center gap-1 rounded-full border border-cream-line bg-white px-3 py-1 text-xs font-bold text-deep-green/75 transition hover:bg-cream-soft disabled:opacity-50"
            >
              {copying ? "Copying…" : "Copy last week"}
            </button>
          )}
          {!city && (
            <button
              type="button"
              onClick={reconcileNow}
              disabled={reconciling}
              title="Auto-add any completed matches missing on Clubhouse now (also runs hourly)"
              className="inline-flex items-center gap-1 rounded-full border border-cream-line bg-white px-3 py-1 text-xs font-bold text-deep-green/75 transition hover:bg-cream-soft disabled:opacity-50"
            >
              {reconciling ? "Reconciling…" : "Reconcile now"}
            </button>
          )}
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1 rounded-full bg-mint px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
          >
            <Plus aria-hidden className="h-3.5 w-3.5" /> Add session
          </button>
        </div>
      </div>

      {loading && !current ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading schedule…
        </div>
      ) : error ? (
        <div className="rounded-2xl border-[1.5px] border-coral/40 bg-coral-soft p-6 text-sm text-coral-hover shadow-md shadow-deep-green/10">
          {error}
        </div>
      ) : !current ? null : masterSchedule ? (
        // ---- Master Schedule: summary chips + collapsible cards (S7) ----
        <>
          <SummaryStrip
            sessionCount={sessionCount}
            cityCount={current.cities.filter((c) => !city || c.name === city).length}
            reviewCount={reviewCount}
            reviewOpen={reviewCardOpen}
            onToggleReview={() => setReviewOpen((v) => !v)}
            dupCount={dupModel?.totalDup ?? 0}
            dupOpen={dupOpen2}
            onToggleDup={() => setDupOpen((v) => !v)}
            uncheckedSessions={dupModel?.unmappedSessions ?? 0}
          />
          {reviewCardOpen && (
            <div data-ms-review-card>
              {/* S7.4: header X collapses it. The count lives on the chip, not
                  here (S7.3) — passed hideCount. */}
              <DiscrepancyBanner
                data={discrepancies!}
                city={city}
                reconcile={reconcile}
                busyIds={busyIds}
                onAdd={addToClubhouse}
                onUndo={undoOneOff}
                hideCount
                onClose={() => setReviewOpen(false)}
              />
            </div>
          )}
          {dupOpen2 && dupModel && (
            <DuplicateCard model={dupModel} onClose={() => setDupOpen(false)} />
          )}
          <div className="space-y-5" data-ms-board>
            {current.cities
              .filter((c) => !city || c.name === city)
              .map((c) => (
                <CitySection
                  key={c.name}
                  city={c}
                  todayIso={todayIso}
                  diff={diff}
                  showChanges={showChanges}
                  cancelledKeys={cancelledRefs.keys}
                  onEditMatch={openEdit}
                  dupBySlot={dupModel?.bySlot ?? null}
                />
              ))}
          </div>
        </>
      ) : (
        <>
          {diff.hasAny && (
            <DiffSummaryBanner
              addedCount={diff.addedCount}
              droppedCount={diff.droppedCount}
              expanded={showChanges}
              onToggle={() => setShowChanges((v) => !v)}
            />
          )}
          {discrepancies && (
            <DiscrepancyBanner
              data={discrepancies}
              city={city}
              reconcile={reconcile}
              busyIds={busyIds}
              onAdd={addToClubhouse}
              onUndo={undoOneOff}
            />
          )}
          <div className="space-y-5">
            {current.cities
              .filter((c) => !city || c.name === city)
              .map((c) => (
                <CitySection
                  key={c.name}
                  city={c}
                  todayIso={todayIso}
                  diff={diff}
                  showChanges={showChanges}
                  cancelledKeys={cancelledRefs.keys}
                  onEditMatch={openEdit}
                />
              ))}
          </div>
        </>
      )}

      {editor.kind !== "closed" && (
        <MasterScheduleEditModal
          mode={
            editor.kind === "edit"
              ? { kind: "edit", row: editor.row }
              : { kind: "create", defaults: editor.defaults }
          }
          onClose={() => setEditor({ kind: "closed" })}
          onSaved={onSaved}
        />
      )}

      {toastMsg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-deep-green px-4 py-2 text-xs font-bold text-cream shadow-xl"
        >
          {toastMsg}
        </div>
      )}
    </section>
  );
}

function WeekNav({
  weekStart,
  weekEnd,
  onPrev,
  onNext,
  onToday,
}: {
  weekStart: string;
  weekEnd: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const label = `${fmtShort(weekStart)} - ${fmtShort(weekEnd)}`;
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous week"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-cream-line bg-white text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>
      <div className="rounded-full border border-cream-line bg-white px-3 py-1 text-xs font-bold tabular-nums text-deep-green">
        {label}
      </div>
      <button
        type="button"
        onClick={onNext}
        aria-label="Next week"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-cream-line bg-white text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onToday}
        className="rounded-full bg-deep-green px-3 py-1 text-xs font-bold text-cream transition hover:bg-deep-green-hover"
      >
        Today
      </button>
    </div>
  );
}

function DiffSummaryBanner({
  addedCount,
  droppedCount,
  expanded,
  onToggle,
}: {
  addedCount: number;
  droppedCount: number;
  // The summary chip is also the toggle: the per-city change chips live in
  // each city card and stay collapsed until this is expanded (§4 declutter).
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={expanded}
      className="mb-5 flex w-full flex-wrap items-center gap-2 rounded-2xl border-[1.5px] border-cream-line bg-cream-soft px-4 py-2.5 text-left shadow-md shadow-deep-green/10 transition hover:bg-cream-soft/70"
    >
      <span className="text-[11px] font-bold uppercase tracking-wider text-deep-green/70">
        Changes vs last week
      </span>
      {addedCount > 0 && (
        <span className="rounded-full bg-mint-soft px-2 py-0.5 text-[11px] font-bold text-deep-green ring-1 ring-mint/40">
          {addedCount} added
        </span>
      )}
      {droppedCount > 0 && (
        <span className="rounded-full bg-coral-soft px-2 py-0.5 text-[11px] font-bold text-coral-hover ring-1 ring-coral/40">
          {droppedCount} dropped
        </span>
      )}
      <span className="ml-auto text-[11px] font-semibold text-deep-green/50">
        {expanded ? "Hide per-city −" : "Show per-city +"}
      </span>
    </button>
  );
}

function CitySection({
  city,
  todayIso,
  diff,
  showChanges,
  cancelledKeys,
  onEditMatch,
  dupBySlot = null,
}: {
  city: CityOut;
  todayIso: string;
  diff: Diff;
  showChanges: boolean;
  cancelledKeys: Set<string>;
  onEditMatch: (row: EditableRow) => void;
  // Master Schedule only: when present, day cells render grouped labelled
  // tiles with ×N duplicate chips instead of one pill per match.
  dupBySlot?: Map<string, SlotDup> | null;
}) {
  // Week-vs-week diff pills only. Cancellations show as in-grid
  // strikethrough bubbles + the Schedule Sync count pill at the top of
  // the tab; surfacing them again in the per-city row was loud
  // and crowded out the diff signal. Collapsed behind the summary chip
  // by default (§4) — only shown when the user expands changes.
  const pills = showChanges ? (diff.perCity.get(city.name) ?? []) : [];
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-deep-green">{city.name}</h3>
        <span className="rounded-full bg-cream-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
          {city.total} {city.total === 1 ? "match" : "matches"}
        </span>
      </div>
      {pills.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {pills.map((p, i) => (
            <ChangeRowPill key={i} pill={p} />
          ))}
        </div>
      )}
      <div className="hidden md:grid grid-cols-7 gap-2">
        {city.days.map((d) => {
          const cellKey = `${city.name}|${d.day_of_week}`;
          return (
            <DayCell
              key={d.date}
              city={city.name}
              day={d}
              todayIso={todayIso}
              addedIds={diff.addedIds}
              cancelledKeys={cancelledKeys}
              ghosts={diff.ghostsByCell.get(cellKey) ?? []}
              onEditMatch={onEditMatch}
              dupBySlot={dupBySlot}
            />
          );
        })}
      </div>
      {/* Mobile agenda — vertical day-by-day list. Replaces the 7-col
          grid whose day-of-week labels otherwise wrap one letter per
          line on narrow screens. */}
      <div className="md:hidden space-y-2">
        {city.days.map((d) => {
          const cellKey = `${city.name}|${d.day_of_week}`;
          return (
            <DayAgenda
              key={d.date}
              city={city.name}
              day={d}
              todayIso={todayIso}
              addedIds={diff.addedIds}
              cancelledKeys={cancelledKeys}
              ghosts={diff.ghostsByCell.get(cellKey) ?? []}
              onEditMatch={onEditMatch}
            />
          );
        })}
      </div>
    </div>
  );
}

// Mobile agenda row for one day. Renders a day header (DOW + date),
// then the day's matches (or a thin "—" row for empty days, to keep
// the Mon→Sun rhythm visible while scrolling). Match rows reuse the
// same proposed-change states as DayCell: green dot for added,
// strikethrough+coral for cancelled, dashed-border ghost row for
// dropped-vs-last-week. Today gets a mint header strip; past days
// dim their match rows.
function DayAgenda({
  city,
  day,
  todayIso,
  addedIds,
  cancelledKeys,
  ghosts,
  onEditMatch,
}: {
  city: string;
  day: DayOut;
  todayIso: string;
  addedIds: Set<string>;
  cancelledKeys: Set<string>;
  ghosts: GhostMatch[];
  onEditMatch: (row: EditableRow) => void;
}) {
  const isToday = day.date === todayIso;
  const isPast = day.date < todayIso;
  const hasContent = day.matches.length > 0 || ghosts.length > 0;
  return (
    <div>
      <div
        className={`flex items-baseline justify-between rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wider ${
          isToday
            ? "bg-mint-soft text-deep-green"
            : isPast
              ? "text-deep-green/40"
              : "text-deep-green/65"
        }`}
      >
        <span>
          {day.day_of_week} <span className="tabular-nums">{day.date.slice(8)}</span>
        </span>
        {isToday && (
          <span className="rounded-full bg-mint px-1.5 py-0.5 text-[9px] text-deep-green">
            Today
          </span>
        )}
      </div>
      <div className="mt-1 space-y-1 pl-1">
        {isPast ? (
          // Completed day → actuals from MatchDay (read-only).
          (day.actual_matches ?? []).length === 0 ? (
            <div className="px-2 py-0.5 text-[11px] text-deep-green/30">—</div>
          ) : (
            (day.actual_matches ?? []).map((a) => (
              <div
                key={a.api_id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px]"
                title={`${a.is_cancelled ? "Cancelled · " : ""}${a.time} · ${a.venue} · from MatchDay`}
              >
                <span className={a.is_cancelled ? "text-coral-hover line-through" : "text-deep-green/75"}>
                  <span className="font-bold tabular-nums">{compactTime(a.time)}</span> {a.venue}
                  {!a.is_cancelled && a.player_count != null && (
                    <span className="text-deep-green/45"> · {a.player_count}{a.max_spots ? `/${a.max_spots}` : ""}</span>
                  )}
                </span>
              </div>
            ))
          )
        ) : !hasContent ? (
          <div className="px-2 py-0.5 text-[11px] text-deep-green/30">—</div>
        ) : (
          <>
            {day.matches.map((m) => {
              const key = `${city}|${day.date}|${m.venue}|${compactTime(m.time)}`;
              const cancelled = cancelledKeys.has(key);
              return (
                <AgendaMatchRow
                  key={m.id}
                  time={m.time}
                  venue={m.venue}
                  detail={m.detail}
                  dim={isPast}
                  added={addedIds.has(m.id)}
                  cancelled={cancelled}
                  oneOff={m.source !== "template"}
                  notInMatchday={m.in_matchday === false}
                  onClick={() =>
                    onEditMatch({
                      id: m.id,
                      city,
                      venue: m.venue,
                      detail: m.detail,
                      match_date: day.date,
                      match_time: m.time,
                      max_spots: m.max_spots,
                      mdapi_field_id: m.mdapi_field_id,
                    })
                  }
                />
              );
            })}
            {ghosts.map((g) => (
              <AgendaGhostRow
                key={g.id}
                time={g.time}
                venue={g.venue}
                detail={g.detail}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function AgendaMatchRow({
  time,
  venue,
  detail,
  dim,
  added,
  cancelled,
  oneOff,
  notInMatchday = false,
  onClick,
}: {
  time: string;
  venue: string;
  detail: string;
  dim: boolean;
  added: boolean;
  cancelled: boolean;
  oneOff: boolean;
  notInMatchday?: boolean;
  onClick: () => void;
}) {
  const short = compactTime(time);
  const bgClass = notInMatchday ? "bg-warn-bg/60" : added ? "bg-mint-soft" : dim ? "bg-cream-soft" : "bg-white";
  // Dashed outline = one-off; solid ring = recurring template; amber = off MatchDay.
  const outlineClass = notInMatchday
    ? "ring-1 ring-[#e3c369]"
    : oneOff
      ? `border border-dashed ${added ? "border-mint" : "border-deep-green/40"}`
      : added
        ? "ring-1 ring-mint/60"
        : "ring-1 ring-cream-line";
  const textClass = cancelled
    ? "text-coral-hover"
    : dim
      ? "text-deep-green/40"
      : "text-deep-green";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit ${time} ${detail}${cancelled ? " (cancelled)" : ""}${oneOff ? " (one-off)" : ""}${notInMatchday ? " (not on MatchDay yet)" : ""}`}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition focus:outline-none focus:ring-2 focus:ring-mint ${bgClass} ${outlineClass} ${textClass}`}
      title={
        cancelled
          ? `Cancelled match · ${time} - ${detail}`
          : `${notInMatchday ? "Not on MatchDay yet — add it in the app · " : ""}${oneOff ? "One-off · " : ""}${time} - ${detail}`
      }
    >
      {notInMatchday ? (
        <span aria-hidden title="Not on MatchDay yet" className="shrink-0 text-[11px] font-extrabold leading-none text-warn-ink">▲</span>
      ) : added ? (
        <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-mint" />
      ) : null}
      <span
        className={`min-w-[3rem] font-bold tabular-nums ${cancelled ? "line-through" : ""}`}
      >
        {short}
      </span>
      <span className={`min-w-0 flex-1 truncate ${cancelled ? "line-through" : ""}`}>
        {venue}
      </span>
    </button>
  );
}

function AgendaGhostRow({
  time,
  venue,
  detail,
}: {
  time: string;
  venue: string;
  detail: string;
}) {
  const short = compactTime(time);
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-dashed border-deep-green/30 bg-cream-soft/60 px-2 py-1.5 text-xs text-deep-green/55"
      title={`Dropped vs last week · ${time} - ${detail}`}
    >
      <span aria-hidden className="font-bold">-</span>
      <span className="min-w-[3rem] font-bold tabular-nums">{short}</span>
      <span className="min-w-0 flex-1 truncate">{venue}</span>
    </div>
  );
}

function ChangeRowPill({ pill }: { pill: ChangePill }) {
  if (pill.kind === "added") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-mint-soft px-2 py-0.5 text-[11px] font-medium text-deep-green ring-1 ring-mint/40">
        <span className="font-bold">+</span> {pill.dayOfWeek} {pill.time_short}{" "}
        {pill.venue}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-coral-soft px-2 py-0.5 text-[11px] font-medium text-coral-hover ring-1 ring-coral/40">
      <span className="font-bold">-</span> {pill.dayOfWeek} {pill.time_short}{" "}
      {pill.venue}
    </span>
  );
}

function DayCell({
  city,
  day,
  todayIso,
  addedIds,
  cancelledKeys,
  ghosts,
  onEditMatch,
  dupBySlot = null,
}: {
  city: string;
  day: DayOut;
  todayIso: string;
  addedIds: Set<string>;
  cancelledKeys: Set<string>;
  ghosts: GhostMatch[];
  onEditMatch: (row: EditableRow) => void;
  dupBySlot?: Map<string, SlotDup> | null;
}) {
  const isToday = day.date === todayIso;
  const isPast = day.date < todayIso;
  // Master Schedule: one labelled tile per (venue, time) slot with a ×N chip.
  const slots = dupBySlot
    ? (() => {
        const groups = new Map<string, MatchOut[]>();
        for (const m of day.matches) {
          const k = `${m.venue}|${compactTime(m.time)}`;
          (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
        }
        return [...groups.entries()].sort((a, b) =>
          compactTime(a[1][0].time).localeCompare(compactTime(b[1][0].time), undefined, { numeric: true }),
        );
      })()
    : null;
  return (
    <div
      className={`flex min-h-[80px] flex-col rounded-md border ${
        isToday
          ? "border-mint bg-mint-soft/40"
          : "border-cream-line bg-cream-soft/30"
      } p-1.5`}
    >
      <div
        className={`flex items-baseline justify-between text-[10px] font-bold uppercase tracking-wider ${
          isToday ? "text-deep-green" : "text-deep-green/60"
        }`}
      >
        <span>{day.day_of_week}</span>
        <span className="tabular-nums">{day.date.slice(8)}</span>
      </div>
      <div className="mt-1 flex flex-col gap-1">
        {isPast ? (
          // Completed day → mirror mdapi exactly. This is what actually
          // happened; it is read-only, like Manager Pay's closed weeks.
          (day.actual_matches ?? []).length === 0 ? (
            <span className="text-[11px] text-deep-green/30">—</span>
          ) : (
            (day.actual_matches ?? []).map((a) => (
              <ActualPill
                key={a.api_id}
                time={a.time}
                venue={a.venue}
                cancelled={a.is_cancelled}
                players={a.player_count}
                maxSpots={a.max_spots}
              />
            ))
          )
        ) : day.matches.length === 0 && ghosts.length === 0 ? (
          <span className="text-[11px] text-deep-green/30">—</span>
        ) : slots ? (
          <>
            {slots.map(([gk, ms]) => {
              const m = ms[0];
              const slotKey = `${city}|${day.date}|${gk}`;
              const cancelled = cancelledKeys.has(`${city}|${day.date}|${m.venue}|${compactTime(m.time)}`);
              return (
                <SlotTile
                  key={gk}
                  time={m.time}
                  venue={m.venue}
                  n={ms.length}
                  dup={dupBySlot!.get(slotKey) ?? null}
                  dim={isPast}
                  cancelled={cancelled}
                  oneOff={m.source !== "template"}
                  notInMatchday={ms.some((x) => x.in_matchday === false)}
                  onClick={() =>
                    onEditMatch({
                      id: m.id,
                      city,
                      venue: m.venue,
                      detail: m.detail,
                      match_date: day.date,
                      match_time: m.time,
                      max_spots: m.max_spots,
                      mdapi_field_id: m.mdapi_field_id,
                    })
                  }
                />
              );
            })}
            {ghosts.map((g) => (
              <GhostPill key={g.id} time={g.time} venue={g.venue} detail={g.detail} />
            ))}
          </>
        ) : (
          <>
            {day.matches.map((m) => {
              const key = `${city}|${day.date}|${m.venue}|${compactTime(m.time)}`;
              const cancelled = cancelledKeys.has(key);
              return (
                <MatchPill
                  key={m.id}
                  time={m.time}
                  venue={m.venue}
                  detail={m.detail}
                  dim={isPast}
                  added={addedIds.has(m.id)}
                  cancelled={cancelled}
                  oneOff={m.source !== "template"}
                  notInMatchday={m.in_matchday === false}
                  onClick={() =>
                    onEditMatch({
                      id: m.id,
                      city,
                      venue: m.venue,
                      detail: m.detail,
                      match_date: day.date,
                      match_time: m.time,
                      max_spots: m.max_spots,
                      mdapi_field_id: m.mdapi_field_id,
                    })
                  }
                />
              );
            })}
            {ghosts.map((g) => (
              <GhostPill
                key={g.id}
                time={g.time}
                venue={g.venue}
                detail={g.detail}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// Display time: compactTime strips ":00" but drops the space (it feeds slot
// keys); for the tile we want "7 PM" / "6:30 PM".
function displayTime(time: string): string {
  return compactTime(time).replace(/(AM|PM)$/, " $1");
}

// S1/S2/S3 — one labelled tile per (venue, time) slot with a ×N duplicate chip.
function SlotTile({
  time,
  venue,
  n,
  dup,
  dim,
  cancelled,
  oneOff,
  notInMatchday = false,
  onClick,
}: {
  time: string;
  venue: string;
  n: number;
  dup: SlotDup | null;
  dim: boolean;
  cancelled: boolean;
  oneOff: boolean;
  notInMatchday?: boolean;
  onClick: () => void;
}) {
  const state = dup?.state ?? "clean";
  // ×N chip styling by outcome (S3): amber dup / grey clean / dashed "?" unchecked.
  const chip =
    n <= 1
      ? null
      : state === "dup"
        ? { cls: "border border-[#e3c369] bg-warn-bg text-warn-ink", txt: `×${n}` }
        : state === "unchecked"
          ? { cls: "border border-dashed border-deep-green/45 text-deep-green/60", txt: `×${n} ?` }
          : { cls: "bg-cream-soft text-deep-green/60 ring-1 ring-cream-line", txt: `×${n}` };
  const tip =
    state === "dup"
      ? `${displayTime(time)} · ${venue} · ${plural(dup!.extras, "possible duplicate")}`
      : state === "unchecked"
        ? `${displayTime(time)} · ${venue} · duplicates can't be checked`
        : `${displayTime(time)} · ${venue}`;
  // A planned future slot not yet on MatchDay is the loud case: amber ring +
  // tint + an "off MatchDay" chip, so ops knows to create it in the app.
  const outline = notInMatchday
    ? "ring-1 ring-[#e3c369]"
    : oneOff
      ? "border border-dashed border-deep-green/40"
      : state === "dup"
        ? "ring-1 ring-[#e3c369]"
        : "ring-1 ring-cream-line";
  const tip2 = notInMatchday ? `${tip} · not on MatchDay yet — add it in the app` : tip;
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip2}
      aria-label={tip2}
      className={`flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1 text-left transition focus:outline-none focus:ring-2 focus:ring-mint ${
        notInMatchday ? "bg-warn-bg/60" : state === "dup" ? "bg-warn-bg/50" : dim ? "bg-cream-soft" : "bg-white"
      } ${outline}`}
    >
      <span className="flex items-center gap-1">
        <span
          aria-hidden
          className={`inline-flex h-2 w-2 shrink-0 items-center justify-center text-[9px] font-bold leading-none ${
            cancelled ? "text-coral-hover" : ""
          }`}
        >
          {cancelled ? "✕" : <span className={`h-1.5 w-1.5 rounded-full ${state === "dup" ? "bg-[#d99a12]" : "bg-deep-green/40"}`} />}
        </span>
        <span className={`text-[11px] font-bold tabular-nums ${cancelled ? "text-coral-hover line-through" : "text-deep-green"}`}>
          {displayTime(time)}
        </span>
        {(chip || notInMatchday) && (
          <span className="ml-auto flex items-center gap-1">
            {notInMatchday && (
              <span className="rounded-full border border-[#e3c369] bg-warn-bg px-1.5 py-px text-[9px] font-extrabold leading-none text-warn-ink">off MD</span>
            )}
            {chip && (
              <span className={`rounded-full px-1.5 py-px text-[9px] font-extrabold leading-none ${chip.cls}`}>{chip.txt}</span>
            )}
          </span>
        )}
      </span>
      <span className={`min-w-0 truncate text-[11px] ${cancelled ? "text-coral-hover line-through" : dim ? "text-deep-green/45" : "text-deep-green/80"}`}>
        {venue}
      </span>
    </button>
  );
}

// S7 — the summary strip. The count lives ONLY here (S7.3); each count chip is
// the button that opens its card. All-clear is a chip, never a full-width bar.
function SummaryStrip({
  sessionCount,
  cityCount,
  reviewCount,
  reviewOpen,
  onToggleReview,
  dupCount,
  dupOpen,
  onToggleDup,
  uncheckedSessions,
}: {
  sessionCount: number;
  cityCount: number;
  reviewCount: number;
  reviewOpen: boolean;
  onToggleReview: () => void;
  dupCount: number;
  dupOpen: boolean;
  onToggleDup: () => void;
  uncheckedSessions: number;
}) {
  const allClear = reviewCount === 0 && dupCount === 0 && uncheckedSessions === 0;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-sm font-bold text-deep-green">
        {plural(sessionCount, "session")} this week
      </span>
      <span className="text-sm text-deep-green/45">·</span>
      <span className="text-sm text-deep-green/65">{plural(cityCount, "city", "cities")}</span>

      {reviewCount > 0 && (
        <SummaryChip
          on={reviewOpen}
          onClick={onToggleReview}
          tone="warn"
          label={`${reviewCount} need review`}
        />
      )}
      {dupCount > 0 && (
        <SummaryChip
          on={dupOpen}
          onClick={onToggleDup}
          tone="warn"
          label={plural(dupCount, "possible duplicate")}
        />
      )}
      {allClear && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-mint-soft px-3 py-1 text-xs font-bold text-deep-green ring-1 ring-mint/40">
          <CircleCheck aria-hidden className="h-3.5 w-3.5 text-deep-green/70" />
          MatchDay agrees on every session
        </span>
      )}
    </div>
  );
}

function SummaryChip({
  on,
  onClick,
  label,
  tone,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  tone: "warn";
}) {
  void tone;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={on}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition ${
        on
          ? "bg-warn-ink text-warn-bg ring-1 ring-warn-ink"
          : "bg-warn-bg text-warn-ink ring-1 ring-[#e3c369] hover:brightness-95"
      }`}
    >
      {label}
      <ChevronDown
        aria-hidden
        className={`h-3.5 w-3.5 transition-transform ${on ? "rotate-180" : ""}`}
      />
    </button>
  );
}

// S3 roll-up card — no total in the header (S7.3, the chip owns the count).
function DuplicateCard({ model, onClose }: { model: DupModel; onClose: () => void }) {
  return (
    <div data-ms-dup-card className="mb-5 rounded-2xl border-[1.5px] border-[#e3c369] bg-warn-bg/60 p-5 shadow-md shadow-deep-green/10">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-warn-ink">
          More matches than the venue has fields. Two matches cannot share one field at one time.
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Collapse duplicates"
          className="shrink-0 rounded-full p-1 text-warn-ink/70 transition hover:bg-warn-ink/10"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {model.perVenue.map((v) => (
          <span
            key={`${v.city}|${v.venue}`}
            className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-deep-green ring-1 ring-[#e3c369]"
          >
            <span className="font-bold uppercase">{v.city}</span> {v.venue} · {plural(v.fields, "field")} · {plural(v.slots, "slot")} <span className="font-bold text-warn-ink">+{v.extras}</span>
          </span>
        ))}
      </div>
      {model.unmappedSessions > 0 && (
        <p className="mt-3 text-xs text-warn-ink">
          {plural(model.unmappedSessions, "session")} cannot be checked —{" "}
          {model.unmapped.map((u, i) => (
            <span key={`${u.city}|${u.venue}`}>
              {i > 0 ? ", " : ""}
              {u.city} · {u.venue}
            </span>
          ))}{" "}
          {model.unmapped.length === 1 ? "is" : "are"} not mapped to any field.{" "}
          {/* No dedicated field-mapping page exists in the app (fin_venue_fields
              has no admin UI) — plain text, not a link that bounces. */}
          <span className="font-bold">Map fields</span>
        </p>
      )}
    </div>
  );
}

function MatchPill({
  time,
  venue,
  detail,
  dim,
  added,
  cancelled,
  oneOff,
  notInMatchday = false,
  onClick,
}: {
  time: string;
  venue: string;
  detail: string;
  dim: boolean;
  added: boolean;
  cancelled: boolean;
  // One-off (manual / auto-reconciled) vs recurring template. Drawn as a
  // dashed border — orthogonal to the mint "added" treatment, so a slot can
  // be both a one-off AND newly-added and read as both.
  oneOff: boolean;
  // Future planned slot not yet on MatchDay — amber flag so ops adds it.
  notInMatchday?: boolean;
  onClick: () => void;
}) {
  const short = compactTime(time);
  // Background respects added / dim / normal. Cancelled is a pure
  // text treatment (coral color + strikethrough) so an in-grid
  // cancellation reads as a subtle marker, not a loud red block —
  // the loud per-city pill row at the top of each city section is
  // where cancellations grab attention. Mint dot still renders
  // when added, so an "added AND cancelled" slot keeps both
  // signals.
  const bgClass = notInMatchday
    ? "bg-warn-bg/60"
    : added
      ? "bg-mint-soft"
      : dim
        ? "bg-cream-soft"
        : "bg-white";
  // Dashed outline = one-off; solid ring = recurring template; amber ring wins
  // for a slot not yet on MatchDay.
  const outlineClass = notInMatchday
    ? "ring-1 ring-[#e3c369]"
    : oneOff
      ? `border border-dashed ${added ? "border-mint" : "border-deep-green/40"}`
      : added
        ? "ring-1 ring-mint/60"
        : dim
          ? ""
          : "ring-1 ring-cream-line";
  const textClass = cancelled
    ? "text-coral-hover"
    : dim
      ? "text-deep-green/40"
      : "text-deep-green";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit ${time} ${detail}${cancelled ? " (cancelled)" : ""}${oneOff ? " (one-off)" : ""}${notInMatchday ? " (not on MatchDay yet)" : ""}`}
      className={`flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] leading-tight transition hover:ring-2 hover:ring-mint focus:outline-none focus:ring-2 focus:ring-mint ${bgClass} ${outlineClass} ${textClass}`}
      title={
        cancelled
          ? `Cancelled match · ${time} - ${detail}`
          : `${notInMatchday ? "Not on MatchDay yet — add it in the app · " : ""}${oneOff ? "One-off · " : ""}${time} - ${detail}`
      }
    >
      {notInMatchday ? (
        <span aria-hidden title="Not on MatchDay yet" className="shrink-0 text-[10px] font-extrabold leading-none text-warn-ink">▲</span>
      ) : added ? (
        <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-mint" />
      ) : null}
      <span className={`min-w-0 break-words ${cancelled ? "line-through" : ""}`}>
        <span className="font-bold tabular-nums">{short}</span>{" "}
        <span>{venue}</span>
      </span>
    </button>
  );
}

// ActualPill — a completed-day cell sourced straight from mdapi_matches. This is
// what actually happened; read-only (you can't edit history). Cancelled shows
// struck-through; a non-cancelled match shows its signed-up count.
function ActualPill({
  time,
  venue,
  cancelled,
  players,
  maxSpots,
}: {
  time: string;
  venue: string;
  cancelled: boolean;
  players: number | null;
  maxSpots: number | null;
}) {
  const short = compactTime(time);
  return (
    <div
      title={`${cancelled ? "Cancelled · " : ""}${time} · ${venue}${cancelled ? "" : ` · ${players ?? 0}${maxSpots ? `/${maxSpots}` : ""} signed up`} · from MatchDay`}
      className={`flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] leading-tight ${cancelled ? "bg-cream-soft" : "bg-white ring-1 ring-cream-line"}`}
    >
      <span className={`min-w-0 break-words ${cancelled ? "text-coral-hover line-through" : "text-deep-green/75"}`}>
        <span className="font-bold tabular-nums">{short}</span>{" "}
        <span>{venue}</span>
        {!cancelled && players != null && (
          <span className="text-deep-green/45"> · {players}{maxSpots ? `/${maxSpots}` : ""}</span>
        )}
      </span>
    </div>
  );
}

// DB sync status banner. Compares schedule_master to mdapi_matches
// over the selected week via /api/schedule-master/discrepancies.
// Each count pill is click-to-expand; sections fold to nothing if
// their count is zero. The banner itself hides when all three
// counts are zero.
type BannerSection =
  | "clubhouse"
  | "matchday"
  | "mismatched"
  | "cancelled"
  | "autoadded";

function DiscrepancyBanner({
  data,
  // When set (Slate Review embed), scope every count + drilldown
  // list to that city. Network-wide totals are noise when the user
  // is focused on one city; Atlanta should see Atlanta's missing /
  // extra / mismatched / cancelled, not the network's. Unset →
  // network-wide (standalone /cities lens).
  city,
  reconcile,
  busyIds,
  onAdd,
  onUndo,
  hideCount = false,
  onClose,
}: {
  data: Discrepancies;
  city?: string;
  reconcile: ReconcileExtras | null;
  busyIds: Set<number>;
  onAdd: (matchIds: number[]) => void;
  onUndo: (matchApiId: number) => void;
  // Master Schedule (S7.3/S7.4): the count lives on the summary chip, so the
  // card header suppresses its own number; onClose renders the header X.
  hideCount?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<BannerSection | null>(null);
  // "Add to Clubhouse" — matches live on MatchDay but absent from Clubhouse.
  // Auto-reconcile has already claimed the *completed* ones, so what remains
  // here is future / can't-tell: the one-click-add candidates.
  const extraRows = city
    ? data.extra_in_db.filter((r) => r.city === city)
    : data.extra_in_db;
  // "Create on MatchDay" — schedule rows with no MatchDay match. Read-only /
  // informational (§3): we never write to MatchDay.
  const missingRows = city
    ? data.missing_in_db.filter((r) => r.city === city)
    : data.missing_in_db;
  const mismatchedRows = city
    ? data.mismatched.filter((r) => r.city === city)
    : data.mismatched;
  const cancelledRows = city
    ? data.cancelled.filter((r) => r.city === city)
    : data.cancelled;
  const autoAddedRows = (reconcile?.autoAdded ?? []).filter(
    (r) => !city || r.city === city,
  );
  const clubhouse = extraRows.length;
  const matchday = missingRows.length;
  const mism = mismatchedRows.length;
  const canc = cancelledRows.length;
  const autoCount = autoAddedRows.length;
  // "Need review" is the actionable set only — things you can fix on Clubhouse.
  // Create-on-MatchDay and cancelled are informational; auto-added is done.
  const needReview = clubhouse + mism;
  const heartbeat = reconcile?.heartbeat ?? null;

  function toggle(k: BannerSection) {
    setOpen((cur) => (cur === k ? null : k));
  }
  const dateLabel = `${fmtShort(data.week_start)} - ${fmtShort(data.week_end)}`;
  const addAllBusy = extraRows.some((r) => busyIds.has(r.mdapi_match_id));

  const sectionBtn =
    "flex w-full items-center justify-between rounded-lg px-2 py-1 text-[11px] font-bold transition text-left";

  return (
    <div className="mb-5 rounded-2xl border-[1.5px] border-cream-line bg-cream-soft px-4 py-3 shadow-md shadow-deep-green/10">
      {/* Header: label + auto-reconcile heartbeat (like the Community tab). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-deep-green/70">
          Schedule Sync · {dateLabel}
        </span>
        <div className="flex items-center gap-2">
          {heartbeat && (
            <span
              title={heartbeat.last_error ?? undefined}
              className={`text-[10px] font-semibold tabular-nums ${
                !heartbeat.autoreconcile_enabled || heartbeat.last_status === "500"
                  ? "text-coral-hover"
                  : "text-deep-green/45"
              }`}
            >
              {!heartbeat.autoreconcile_enabled
                ? "Auto-reconcile off"
                : heartbeat.last_status === "500"
                  ? "Auto-reconcile · last run failed"
                  : `Auto-reconcile on · ran ${fmtAgo(agoMinutes(heartbeat.last_success_at))}`}
            </span>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Collapse review"
              className="shrink-0 rounded-full p-1 text-deep-green/60 transition hover:bg-deep-green/10"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Primary: one number, or a one-line all-clear at 0. On Master Schedule
          (hideCount) the count lives on the summary chip (S7.3) — the card
          shows the reasoning instead. */}
      <div className="mt-2">
        {hideCount ? (
          <span className="text-[13px] font-medium text-deep-green/70">
            These sessions differ from MatchDay — review and reconcile below.
          </span>
        ) : needReview > 0 ? (
          <span className="text-sm font-bold text-deep-green">
            {needReview} need review
          </span>
        ) : (
          <span className="text-[13px] font-semibold text-deep-green/60">
            ✓ Nothing needs review — schedule matches MatchDay
          </span>
        )}
      </div>

      <div className="mt-2 space-y-1">
        {/* Add to Clubhouse — actionable one-click add (§2). */}
        {clubhouse > 0 && (
          <div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggle("clubhouse")}
                aria-pressed={open === "clubhouse"}
                className={`${sectionBtn} flex-1 ${
                  open === "clubhouse"
                    ? "bg-yellow-pos text-deep-green"
                    : "bg-yellow-soft text-deep-green ring-1 ring-yellow-pos/60 hover:bg-yellow-soft/70"
                }`}
              >
                <span>Add to Clubhouse ({clubhouse})</span>
                <span aria-hidden className="text-deep-green/50">
                  {open === "clubhouse" ? "−" : "+"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onAdd(extraRows.map((r) => r.mdapi_match_id))}
                disabled={addAllBusy}
                className="shrink-0 rounded-full bg-mint px-2.5 py-1 text-[11px] font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
              >
                Add all
              </button>
            </div>
            {open === "clubhouse" && (
              <ul className="mt-2 space-y-0.5">
                {extraRows.map((r) => {
                  const busy = busyIds.has(r.mdapi_match_id);
                  return (
                    <li
                      key={r.mdapi_match_id}
                      className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-deep-green/75"
                    >
                      <span>
                        <span className="font-bold">{fmtShort(r.match_date)}</span>{" "}
                        <span className="text-deep-green/55">·</span> {r.city}{" "}
                        <span className="text-deep-green/55">·</span> {r.venue}{" "}
                        <span className="text-deep-green/55">·</span> {r.match_time}{" "}
                        <span className="text-deep-green/55">·</span> match #
                        {r.mdapi_match_id}
                      </span>
                      <button
                        type="button"
                        onClick={() => onAdd([r.mdapi_match_id])}
                        disabled={busy}
                        className="shrink-0 rounded-full bg-mint px-2 py-0.5 text-[10px] font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
                      >
                        {busy ? "…" : "Add"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* Mismatched — needs a human look. */}
        {mism > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggle("mismatched")}
              aria-pressed={open === "mismatched"}
              className={`${sectionBtn} ${
                open === "mismatched"
                  ? "bg-coral text-white"
                  : "bg-coral-soft/60 text-coral-hover ring-1 ring-coral/30 hover:bg-coral-soft/40"
              }`}
            >
              <span>Mismatched ({mism})</span>
              <span aria-hidden className="opacity-60">
                {open === "mismatched" ? "−" : "+"}
              </span>
            </button>
            {open === "mismatched" && (
              <ul className="mt-2 space-y-0.5">
                {mismatchedRows.map((r) => (
                  <li
                    key={r.schedule_master_id}
                    className="text-[11px] tabular-nums text-deep-green/75"
                  >
                    <span className="font-bold">{fmtShort(r.match_date)}</span>{" "}
                    <span className="text-deep-green/55">·</span> {r.city}{" "}
                    <span className="text-deep-green/55">·</span> {r.venue}{" "}
                    <span className="text-deep-green/55">·</span> {r.match_time}{" "}
                    <span className="text-deep-green/55">·</span>{" "}
                    <span className="text-coral-hover">{r.diffs.join(" / ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Create on MatchDay — informational only. No write path to MatchDay (§3). */}
        {matchday > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggle("matchday")}
              aria-pressed={open === "matchday"}
              className={`${sectionBtn} ${
                open === "matchday"
                  ? "bg-cream-line text-deep-green/80"
                  : "bg-cream text-deep-green/60 ring-1 ring-cream-line hover:bg-cream-line/60"
              }`}
            >
              <span>Create on MatchDay ({matchday}) · info only</span>
              <span aria-hidden className="opacity-50">
                {open === "matchday" ? "−" : "+"}
              </span>
            </button>
            {open === "matchday" && (
              <ul className="mt-2 space-y-0.5">
                {missingRows.map((r) => (
                  <li
                    key={r.id}
                    className="text-[11px] tabular-nums text-deep-green/70"
                  >
                    <span className="font-bold">{fmtShort(r.match_date)}</span>{" "}
                    <span className="text-deep-green/55">·</span> {r.city}{" "}
                    <span className="text-deep-green/55">·</span> {r.detail}{" "}
                    <span className="text-deep-green/55">·</span> {r.match_time}{" "}
                    <span className="text-deep-green/55">·</span> {r.max_spots} spots
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Cancelled this week — muted, not alarm-styled. */}
        {canc > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggle("cancelled")}
              aria-pressed={open === "cancelled"}
              className={`${sectionBtn} ${
                open === "cancelled"
                  ? "bg-cream-line text-deep-green/70"
                  : "bg-cream text-deep-green/55 ring-1 ring-cream-line hover:bg-cream-line/60"
              }`}
            >
              <span>Cancelled this week ({canc})</span>
              <span aria-hidden className="opacity-50">
                {open === "cancelled" ? "−" : "+"}
              </span>
            </button>
            {open === "cancelled" && (
              <ul className="mt-2 space-y-0.5">
                {cancelledRows.map((r) => (
                  <li
                    key={r.schedule_master_id}
                    className="text-[11px] tabular-nums text-deep-green/60 line-through decoration-deep-green/30"
                  >
                    <span className="font-bold">{fmtShort(r.match_date)}</span>{" "}
                    <span className="text-deep-green/45">·</span> {r.city}{" "}
                    <span className="text-deep-green/45">·</span> {r.detail}{" "}
                    <span className="text-deep-green/45">·</span> {r.match_time}{" "}
                    <span className="text-deep-green/45">·</span> match #
                    {r.mdapi_match_id}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Auto-added from completed matches — quiet line, expandable, per-row Undo. */}
      {autoCount > 0 && (
        <div className="mt-2 border-t border-cream-line pt-2">
          <button
            type="button"
            onClick={() => toggle("autoadded")}
            aria-pressed={open === "autoadded"}
            className="flex items-center gap-1 text-[11px] font-semibold text-deep-green/55 transition hover:text-deep-green/80"
          >
            <span aria-hidden>{open === "autoadded" ? "−" : "+"}</span>
            {autoCount} auto-added from completed matches
          </button>
          {open === "autoadded" && (
            <ul className="mt-2 space-y-0.5">
              {autoAddedRows.map((r) => {
                const busy = busyIds.has(r.match_api_id);
                return (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-deep-green/70"
                  >
                    <span>
                      <span className="font-bold">{fmtShort(r.match_date)}</span>{" "}
                      <span className="text-deep-green/55">·</span> {r.city}{" "}
                      <span className="text-deep-green/55">·</span> {r.venue}{" "}
                      <span className="text-deep-green/55">·</span> {r.match_time}{" "}
                      <span className="text-deep-green/55">·</span> match #
                      {r.match_api_id}
                    </span>
                    <button
                      type="button"
                      onClick={() => onUndo(r.match_api_id)}
                      disabled={busy}
                      className="shrink-0 rounded-full bg-cream px-2 py-0.5 text-[10px] font-bold text-deep-green/70 ring-1 ring-cream-line transition hover:bg-cream-line disabled:opacity-50"
                    >
                      {busy ? "…" : "Undo"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function GhostPill({
  time,
  venue,
  detail,
}: {
  time: string;
  venue: string;
  detail: string;
}) {
  const short = compactTime(time);
  return (
    <div
      className="flex items-center gap-1 rounded border border-dashed border-deep-green/30 bg-cream-soft/60 px-1.5 py-0.5 text-[11px] leading-tight text-deep-green/55"
      title={`Dropped vs last week · ${time} - ${detail}`}
    >
      <span aria-hidden className="font-bold">-</span>
      <span className="min-w-0 break-words">
        <span className="font-bold tabular-nums">{short}</span>{" "}
        <span>{venue}</span>
      </span>
    </div>
  );
}

// ============================================================
// Diff
// ============================================================

function buildDiff(
  current: Payload | null,
  previous: Payload | null,
  // When set, restrict every bucket / pill / count to this city.
  // Slate Review (city prop) passes the selected city so the
  // "Changes vs last week" banner only counts that city's slots.
  // Unset → network-wide totals (standalone /cities lens).
  cityFilter?: string,
): Diff {
  if (!current || !previous) return EMPTY_DIFF;
  const prevHasAny = previous.cities.some(
    (c) => (!cityFilter || c.name === cityFilter) && c.total > 0,
  );
  if (!prevHasAny) return EMPTY_DIFF;

  type Bucket = {
    id: string;
    time: string;
    time_short: string;
    venue: string;
    detail: string;
  };
  function bucketize(p: Payload): Map<string, Bucket[]> {
    const map = new Map<string, Bucket[]>();
    for (const c of p.cities) {
      if (cityFilter && c.name !== cityFilter) continue;
      for (const d of c.days) {
        for (const m of d.matches) {
          // Bucket key uses the canonical venue (post-0040 the value
          // already on schedule_master.venue). Multiple field
          // numbers at the same venue collapse to one bucket — e.g.
          // a Fri 8PM SJD Field 1 vs a Fri 8PM SJD Field 2 don't
          // surface as a "dropped + added", they pair as the same
          // slot.
          const key = `${c.name}|${d.day_of_week}|${m.venue}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({
            id: m.id,
            time: m.time,
            time_short: compactTime(m.time),
            venue: m.venue,
            detail: m.detail,
          });
        }
      }
    }
    // Sort each bucket by start time so positional pairing across
    // weeks is deterministic.
    for (const arr of map.values()) {
      arr.sort((a, b) => startMinutes(a.time) - startMinutes(b.time));
    }
    return map;
  }

  const curMap = bucketize(current);
  const prevMap = bucketize(previous);
  const allKeys = new Set([...curMap.keys(), ...prevMap.keys()]);

  const addedIds = new Set<string>();
  const ghostsByCell = new Map<string, GhostMatch[]>();
  const perCity = new Map<string, ChangePill[]>();
  let addedCount = 0;
  let droppedCount = 0;

  function pushPill(city: string, pill: ChangePill) {
    if (!perCity.has(city)) perCity.set(city, []);
    perCity.get(city)!.push(pill);
  }

  for (const key of allKeys) {
    const [city, dayOfWeek, venue] = key.split("|");
    const cur = curMap.get(key) ?? [];
    const prev = prevMap.get(key) ?? [];
    const prevTimes = new Set(prev.map((b) => b.time_short));
    const curTimes = new Set(cur.map((b) => b.time_short));
    // Added = cur slots whose time isn't in prev.
    for (const b of cur) {
      if (prevTimes.has(b.time_short)) continue;
      addedIds.add(b.id);
      addedCount++;
      pushPill(city, {
        kind: "added",
        dayOfWeek,
        venue,
        time_short: b.time_short,
      });
    }
    // Dropped = prev slots whose time isn't in cur. Render a ghost in
    // the matching day cell so the user sees what disappeared.
    for (const b of prev) {
      if (curTimes.has(b.time_short)) continue;
      const cellKey = `${city}|${dayOfWeek}`;
      if (!ghostsByCell.has(cellKey)) ghostsByCell.set(cellKey, []);
      ghostsByCell.get(cellKey)!.push({
        id: b.id,
        detail: b.detail,
        venue,
        time: b.time,
        time_short: b.time_short,
      });
      droppedCount++;
      pushPill(city, {
        kind: "dropped",
        dayOfWeek,
        venue,
        time_short: b.time_short,
      });
    }
  }

  // Sort per-city pills so Mon..Sun reads left-to-right.
  const dowIndex = new Map<string, number>(DOW_ORDER.map((d, i) => [d, i]));
  for (const arr of perCity.values()) {
    arr.sort((a, b) => {
      const ai = dowIndex.get(a.dayOfWeek) ?? 99;
      const bi = dowIndex.get(b.dayOfWeek) ?? 99;
      return ai - bi;
    });
  }

  // Sort ghost lists within a cell by start time.
  for (const arr of ghostsByCell.values()) {
    arr.sort((a, b) => startMinutes(a.time) - startMinutes(b.time));
  }

  const hasAny = addedCount > 0 || droppedCount > 0;
  return {
    hasAny,
    addedIds,
    ghostsByCell,
    perCity,
    addedCount,
    droppedCount,
  };
}

// ============================================================
// Cancelled cross-refs
// ============================================================
//
// Builds a Set of `${city}|${date}|${venue}|${time_short}` keys
// off the discrepancies response so DayCell can light up the
// matching MatchPill with the cancelled text treatment. Same
// shape DayCell uses to compute its lookup, so each side reads
// off the canonical schedule_master.venue value.

function buildCancelledRefs(
  disc: Discrepancies | null,
): { keys: Set<string> } {
  const keys = new Set<string>();
  if (!disc) return { keys };
  for (const c of disc.cancelled) {
    const time_short = compactTime(c.match_time);
    keys.add(`${c.city}|${c.match_date}|${c.venue}|${time_short}`);
  }
  return { keys };
}

// ============================================================
// Date / time helpers
// ============================================================

function parseIso(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function mondayOfChicago(now: Date, offsetMode: "monday" | 0 = "monday"): Date {
  const todayChicagoIso = now.toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  });
  const today = new Date(`${todayChicagoIso}T00:00:00Z`);
  if (offsetMode === 0) return today;
  const dow = today.getUTCDay();
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  today.setUTCDate(today.getUTCDate() - daysFromMonday);
  return today;
}

function fmtShort(iso: string): string {
  const d = parseIso(iso);
  return d.toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

// "7:00 PM - 8:00 PM" → "7PM", "6:30 PM" → "6:30PM", "9 AM" → "9AM".
// Uppercase AM/PM reads better than lowercase in narrow grid cells
// when paired with a 2-4 char venue abbreviation. Falls back to the
// raw string if unparseable so nothing is hidden.
function compactTime(time: string): string {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = (m[3] ?? "").toUpperCase();
  const suffix = ampm === "AM" ? "AM" : ampm === "PM" ? "PM" : "";
  return min === 0 ? `${h}${suffix}` : `${h}:${m[2]}${suffix}`;
}

function startMinutes(time: string): number {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time);
  if (!m) return Number.MAX_SAFE_INTEGER;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + min;
}
