"use client";

// Master Schedule lens on /cities. One section per city, with a
// 7-column Mon..Sun grid of match slots for the selected week.
// Backed by the schedule_master table (legacy MatchDay master
// schedule HTML, seeded once in migration 0038).
//
// Bubbles render as "{time} {abbr}" using ops-team shorthand from
// src/lib/venueAbbreviations.ts. Hovering a bubble shows the full
// "{time-range} - {detail}" string via the title attribute.
//
// Changes vs last week:
//   The component fetches the selected week AND the previous week
//   in parallel. A small banner above the grid summarizes counts;
//   per-city change rows list added / dropped / time-changed slots.
//   In the grid itself, added bubbles get a green dot, dropped
//   bubbles render as a strikethrough "ghost" in the same day cell.
//
//   "Same slot" is keyed on (city, day_of_week, abbr). Multiple
//   matches with the same abbr on the same day are paired
//   positionally after sort-by-time, so a Friday SJD@6PM + SJD@8PM
//   versus a previous Friday with only SJD@6PM cleanly reports the
//   8PM as added (not as a "SJD time changed").

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getAbbr } from "@/lib/venueAbbreviations";
import MasterScheduleEditModal, {
  type EditableRow,
} from "./MasterScheduleEditModal";

type MatchOut = {
  id: string;
  venue: string;
  detail: string;
  time: string;
  max_spots: number;
};

type DayOut = {
  date: string;
  day_of_week: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  matches: MatchOut[];
};

type CityOut = { name: string; total: number; days: DayOut[] };

type Payload = {
  week_start: string;
  week_end: string;
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
  changedCount: number;
};

type GhostMatch = {
  id: string; // previous week match id
  detail: string;
  abbr: string;
  time: string; // full string for tooltip
  time_short: string;
};

type ChangePill =
  | { kind: "added"; dayOfWeek: string; abbr: string; time_short: string }
  | { kind: "dropped"; dayOfWeek: string; abbr: string; time_short: string }
  | { kind: "cancelled"; dayOfWeek: string; abbr: string; time_short: string }
  | {
      kind: "changed";
      dayOfWeek: string;
      abbr: string;
      oldTime: string;
      newTime: string;
    };

const EMPTY_DIFF: Diff = {
  hasAny: false,
  addedIds: new Set(),
  ghostsByCell: new Map(),
  perCity: new Map(),
  addedCount: 0,
  droppedCount: 0,
  changedCount: 0,
};

const DOW_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

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

type EditorState =
  | { kind: "closed" }
  | { kind: "edit"; row: EditableRow }
  | { kind: "create"; defaults: { city?: string; match_date?: string } };

export default function CitiesMasterScheduleLens() {
  const [weekStart, setWeekStart] = useState<string>(() =>
    isoDate(mondayOfChicago(new Date())),
  );
  const [current, setCurrent] = useState<Payload | null>(null);
  const [previous, setPrevious] = useState<Payload | null>(null);
  const [discrepancies, setDiscrepancies] = useState<Discrepancies | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

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
      const [cur, prev, disc] = await Promise.all([
        fetchWeek(ws),
        fetchWeek(prevWs),
        fetchDiscrepancies(ws),
      ]);
      setCurrent(cur);
      setPrevious(prev);
      setDiscrepancies(disc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCurrent(null);
      setPrevious(null);
      setDiscrepancies(null);
    } finally {
      setLoading(false);
    }
  }, []);

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
  const diff = useMemo(() => buildDiff(current, previous), [current, previous]);
  const cancelledRefs = useMemo(
    () => buildCancelledRefs(discrepancies),
    [discrepancies],
  );

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
            Recurring weekly match slots, by city.
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
      ) : !current ? null : (
        <>
          {diff.hasAny && (
            <DiffSummaryBanner
              addedCount={diff.addedCount}
              droppedCount={diff.droppedCount}
              changedCount={diff.changedCount}
            />
          )}
          {discrepancies && (
            <DiscrepancyBanner data={discrepancies} />
          )}
          <div className="space-y-5">
            {current.cities.map((c) => (
              <CitySection
                key={c.name}
                city={c}
                todayIso={todayIso}
                diff={diff}
                cancelledKeys={cancelledRefs.keys}
                cancelledPills={cancelledRefs.perCity.get(c.name) ?? []}
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
  changedCount,
}: {
  addedCount: number;
  droppedCount: number;
  changedCount: number;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border-[1.5px] border-cream-line bg-cream-soft px-4 py-2.5 shadow-md shadow-deep-green/10">
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
      {changedCount > 0 && (
        <span className="rounded-full bg-yellow-soft px-2 py-0.5 text-[11px] font-bold text-deep-green ring-1 ring-yellow-pos/60">
          {changedCount} time changed
        </span>
      )}
    </div>
  );
}

function CitySection({
  city,
  todayIso,
  diff,
  cancelledKeys,
  cancelledPills,
  onEditMatch,
}: {
  city: CityOut;
  todayIso: string;
  diff: Diff;
  cancelledKeys: Set<string>;
  cancelledPills: ChangePill[];
  onEditMatch: (row: EditableRow) => void;
}) {
  // Week-vs-week diff pills + cancellation pills, combined in
  // Mon..Sun order so the operator scans one row per city.
  const dowIndex = new Map<string, number>(DOW_ORDER.map((d, i) => [d, i]));
  const pills = useMemo(() => {
    const combined = [
      ...(diff.perCity.get(city.name) ?? []),
      ...cancelledPills,
    ];
    combined.sort(
      (a, b) =>
        (dowIndex.get(a.dayOfWeek) ?? 99) - (dowIndex.get(b.dayOfWeek) ?? 99),
    );
    return combined;
    // dowIndex is stable per render; safe to leave out of deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, cancelledPills, city.name]);
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
      <div className="grid grid-cols-7 gap-2">
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
            />
          );
        })}
      </div>
    </div>
  );
}

function ChangeRowPill({ pill }: { pill: ChangePill }) {
  if (pill.kind === "added") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-mint-soft px-2 py-0.5 text-[11px] font-medium text-deep-green ring-1 ring-mint/40">
        <span className="font-bold">+</span> {pill.dayOfWeek} {pill.time_short}{" "}
        {pill.abbr}
      </span>
    );
  }
  if (pill.kind === "dropped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-coral-soft px-2 py-0.5 text-[11px] font-medium text-coral-hover ring-1 ring-coral/40">
        <span className="font-bold">-</span> {pill.dayOfWeek} {pill.time_short}{" "}
        {pill.abbr}
      </span>
    );
  }
  if (pill.kind === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-coral px-2 py-0.5 text-[11px] font-medium text-white ring-1 ring-coral-hover/60">
        <span className="font-bold">×</span> {pill.dayOfWeek} {pill.time_short}{" "}
        {pill.abbr}{" "}
        <span className="font-bold uppercase tracking-wider opacity-90">
          cancelled
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-soft px-2 py-0.5 text-[11px] font-medium text-deep-green ring-1 ring-yellow-pos/60">
      {pill.dayOfWeek} {pill.abbr}: {pill.oldTime} → {pill.newTime}
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
        {day.matches.length === 0 && ghosts.length === 0 ? (
          <span className="text-[11px] text-deep-green/30">—</span>
        ) : (
          <>
            {day.matches.map((m) => {
              const key = `${city}|${day.date}|${getAbbr(m.detail)}|${compactTime(m.time)}`;
              const cancelled = cancelledKeys.has(key);
              return (
                <MatchPill
                  key={m.id}
                  time={m.time}
                  detail={m.detail}
                  dim={isPast}
                  added={addedIds.has(m.id)}
                  cancelled={cancelled}
                  onClick={() =>
                    onEditMatch({
                      id: m.id,
                      city,
                      venue: m.venue,
                      detail: m.detail,
                      match_date: day.date,
                      match_time: m.time,
                      max_spots: m.max_spots,
                    })
                  }
                />
              );
            })}
            {ghosts.map((g) => (
              <GhostPill key={g.id} time={g.time} detail={g.detail} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function MatchPill({
  time,
  detail,
  dim,
  added,
  cancelled,
  onClick,
}: {
  time: string;
  detail: string;
  dim: boolean;
  added: boolean;
  cancelled: boolean;
  onClick: () => void;
}) {
  const short = compactTime(time);
  const abbr = getAbbr(detail);
  // Style precedence: cancelled (red solid) > added (mint soft) >
  // dim (past) > normal. When both cancelled AND added, the mint
  // dot stays visible on top of the red background per the
  // operator-requested behavior.
  const variantClass = cancelled
    ? "bg-coral text-white ring-1 ring-coral-hover/60 hover:ring-2 hover:ring-coral-hover"
    : added
      ? "bg-mint-soft text-deep-green ring-1 ring-mint/60 hover:ring-2 hover:ring-mint"
      : dim
        ? "bg-cream-soft text-deep-green/40 hover:ring-2 hover:ring-mint"
        : "bg-white text-deep-green ring-1 ring-cream-line hover:ring-2 hover:ring-mint";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit ${time} ${detail}${cancelled ? " (cancelled)" : ""}`}
      className={`flex w-full flex-col items-stretch rounded px-1.5 py-0.5 text-left text-[11px] leading-tight transition focus:outline-none focus:ring-2 focus:ring-mint ${variantClass}`}
      title={cancelled ? `Cancelled match · ${time} - ${detail}` : `${time} - ${detail}`}
    >
      <span className="flex items-center gap-1 truncate">
        {added && (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-mint"
          />
        )}
        <span className={`truncate ${cancelled ? "line-through" : ""}`}>
          <span className="font-bold tabular-nums">{short}</span>{" "}
          <span>{abbr}</span>
        </span>
      </span>
      {cancelled && (
        <span className="mt-0.5 text-[9px] font-bold uppercase tracking-wider opacity-90">
          Cancelled
        </span>
      )}
    </button>
  );
}

// DB sync status banner. Compares schedule_master to mdapi_matches
// over a two-week window via /api/schedule-master/discrepancies.
// Each count pill is click-to-expand; sections fold to nothing if
// their count is zero. The banner itself hides when all three
// counts are zero.
function DiscrepancyBanner({ data }: { data: Discrepancies }) {
  const [open, setOpen] = useState<
    "missing" | "extra" | "mismatched" | "cancelled" | null
  >(null);
  const missing = data.missing_in_db.length;
  const extra = data.extra_in_db.length;
  const mism = data.mismatched.length;
  const canc = data.cancelled.length;
  if (missing === 0 && extra === 0 && mism === 0 && canc === 0) return null;

  function toggle(k: "missing" | "extra" | "mismatched" | "cancelled") {
    setOpen((cur) => (cur === k ? null : k));
  }
  const dateLabel = `${fmtShort(data.week_start)} - ${fmtShort(data.week_end)}`;

  return (
    <div className="mb-5 rounded-2xl border-[1.5px] border-cream-line bg-cream-soft px-4 py-2.5 shadow-md shadow-deep-green/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-deep-green/70">
          DB Sync · {dateLabel}
        </span>
        {missing > 0 && (
          <button
            type="button"
            onClick={() => toggle("missing")}
            aria-pressed={open === "missing"}
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold transition ${
              open === "missing"
                ? "bg-coral text-white"
                : "bg-coral-soft text-coral-hover ring-1 ring-coral/40 hover:bg-coral-soft/70"
            }`}
          >
            {missing} missing in DB
          </button>
        )}
        {extra > 0 && (
          <button
            type="button"
            onClick={() => toggle("extra")}
            aria-pressed={open === "extra"}
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold transition ${
              open === "extra"
                ? "bg-yellow-pos text-deep-green"
                : "bg-yellow-soft text-deep-green ring-1 ring-yellow-pos/60 hover:bg-yellow-soft/70"
            }`}
          >
            {extra} extra in DB
          </button>
        )}
        {mism > 0 && (
          <button
            type="button"
            onClick={() => toggle("mismatched")}
            aria-pressed={open === "mismatched"}
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold transition ${
              open === "mismatched"
                ? "bg-coral text-white"
                : "bg-coral-soft/60 text-coral-hover ring-1 ring-coral/30 hover:bg-coral-soft/40"
            }`}
          >
            {mism} mismatched
          </button>
        )}
        {canc > 0 && (
          <button
            type="button"
            onClick={() => toggle("cancelled")}
            aria-pressed={open === "cancelled"}
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold transition ${
              open === "cancelled"
                ? "bg-coral-hover text-white"
                : "bg-coral text-white hover:bg-coral-hover"
            }`}
          >
            {canc} cancelled this week and next
          </button>
        )}
      </div>
      {open === "missing" && (
        <ul className="mt-3 space-y-0.5">
          {data.missing_in_db.map((r) => (
            <li
              key={r.id}
              className="text-[11px] tabular-nums text-deep-green/75"
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
      {open === "extra" && (
        <ul className="mt-3 space-y-0.5">
          {data.extra_in_db.map((r) => (
            <li
              key={r.mdapi_match_id}
              className="text-[11px] tabular-nums text-deep-green/75"
            >
              <span className="font-bold">{fmtShort(r.match_date)}</span>{" "}
              <span className="text-deep-green/55">·</span> {r.city}{" "}
              <span className="text-deep-green/55">·</span> {r.venue}{" "}
              <span className="text-deep-green/55">·</span> {r.match_time}{" "}
              <span className="text-deep-green/55">·</span> match #
              {r.mdapi_match_id}
            </li>
          ))}
        </ul>
      )}
      {open === "mismatched" && (
        <ul className="mt-3 space-y-0.5">
          {data.mismatched.map((r) => (
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
      {open === "cancelled" && (
        <ul className="mt-3 space-y-0.5">
          {data.cancelled.map((r) => (
            <li
              key={r.schedule_master_id}
              className="text-[11px] tabular-nums text-deep-green/75"
            >
              <span className="font-bold">{fmtShort(r.match_date)}</span>{" "}
              <span className="text-deep-green/55">·</span> {r.city}{" "}
              <span className="text-deep-green/55">·</span> {r.detail}{" "}
              <span className="text-deep-green/55">·</span> {r.match_time}{" "}
              <span className="text-deep-green/55">·</span> match #
              {r.mdapi_match_id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GhostPill({ time, detail }: { time: string; detail: string }) {
  const short = compactTime(time);
  const abbr = getAbbr(detail);
  return (
    <div
      className="flex items-center gap-1 truncate rounded border border-dashed border-coral/50 bg-coral-soft/40 px-1.5 py-0.5 text-[11px] leading-tight text-coral-hover/70 line-through"
      title={`Dropped vs last week · ${time} - ${detail}`}
    >
      <X aria-hidden className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">
        <span className="font-bold tabular-nums">{short}</span>{" "}
        <span>{abbr}</span>
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
): Diff {
  if (!current || !previous) return EMPTY_DIFF;
  const prevHasAny = previous.cities.some((c) => c.total > 0);
  if (!prevHasAny) return EMPTY_DIFF;

  type Bucket = {
    id: string;
    time: string;
    time_short: string;
    detail: string;
  };
  function bucketize(p: Payload): Map<string, Bucket[]> {
    const map = new Map<string, Bucket[]>();
    for (const c of p.cities) {
      for (const d of c.days) {
        for (const m of d.matches) {
          const abbr = getAbbr(m.detail);
          const key = `${c.name}|${d.day_of_week}|${abbr}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({
            id: m.id,
            time: m.time,
            time_short: compactTime(m.time),
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
  let changedCount = 0;

  function pushPill(city: string, pill: ChangePill) {
    if (!perCity.has(city)) perCity.set(city, []);
    perCity.get(city)!.push(pill);
  }

  for (const key of allKeys) {
    const [city, dayOfWeek, abbr] = key.split("|");
    const cur = curMap.get(key) ?? [];
    const prev = prevMap.get(key) ?? [];
    const minLen = Math.min(cur.length, prev.length);
    for (let i = 0; i < minLen; i++) {
      if (cur[i].time_short !== prev[i].time_short) {
        changedCount++;
        pushPill(city, {
          kind: "changed",
          dayOfWeek,
          abbr,
          oldTime: prev[i].time_short,
          newTime: cur[i].time_short,
        });
      }
    }
    for (let i = minLen; i < cur.length; i++) {
      addedIds.add(cur[i].id);
      addedCount++;
      pushPill(city, {
        kind: "added",
        dayOfWeek,
        abbr,
        time_short: cur[i].time_short,
      });
    }
    for (let i = minLen; i < prev.length; i++) {
      const cellKey = `${city}|${dayOfWeek}`;
      if (!ghostsByCell.has(cellKey)) ghostsByCell.set(cellKey, []);
      ghostsByCell.get(cellKey)!.push({
        id: prev[i].id,
        detail: prev[i].detail,
        abbr,
        time: prev[i].time,
        time_short: prev[i].time_short,
      });
      droppedCount++;
      pushPill(city, {
        kind: "dropped",
        dayOfWeek,
        abbr,
        time_short: prev[i].time_short,
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

  const hasAny = addedCount > 0 || droppedCount > 0 || changedCount > 0;
  return {
    hasAny,
    addedIds,
    ghostsByCell,
    perCity,
    addedCount,
    droppedCount,
    changedCount,
  };
}

// ============================================================
// Cancelled cross-refs
// ============================================================
//
// Builds two derived shapes off the discrepancies response so the
// grid render and the per-city pill row can both light up cancelled
// slots without re-parsing the payload at every render:
//
//   keys     — Set keyed on `${city}|${date}|${abbr}|${time_short}`.
//              Looked up in DayCell for each rendered MatchPill.
//   perCity  — ChangePill list per city for the change row above
//              each city section.
//
// Both reuse getAbbr + compactTime so the keys built here match
// exactly what the grid bubbles produce.

function buildCancelledRefs(
  disc: Discrepancies | null,
): { keys: Set<string>; perCity: Map<string, ChangePill[]> } {
  const keys = new Set<string>();
  const perCity = new Map<string, ChangePill[]>();
  if (!disc) return { keys, perCity };
  for (const c of disc.cancelled) {
    const abbr = getAbbr(c.detail);
    const time_short = compactTime(c.match_time);
    keys.add(`${c.city}|${c.match_date}|${abbr}|${time_short}`);
    const dayOfWeek = dayOfWeekFromIso(c.match_date);
    if (!perCity.has(c.city)) perCity.set(c.city, []);
    perCity.get(c.city)!.push({
      kind: "cancelled",
      dayOfWeek,
      abbr,
      time_short,
    });
  }
  const dowIndex = new Map<string, number>(DOW_ORDER.map((d, i) => [d, i]));
  for (const arr of perCity.values()) {
    arr.sort(
      (a, b) =>
        (dowIndex.get(a.dayOfWeek) ?? 99) - (dowIndex.get(b.dayOfWeek) ?? 99),
    );
  }
  return { keys, perCity };
}

function dayOfWeekFromIso(
  iso: string,
): "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay();
  return (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const)[dow];
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
