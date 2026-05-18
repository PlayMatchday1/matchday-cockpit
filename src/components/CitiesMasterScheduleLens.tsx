"use client";

// Master Schedule lens on /cities. One section per city, with a
// 7-column Mon..Sun grid of match slots for the selected week.
// Backed by the schedule_master table (legacy MatchDay master
// schedule HTML, seeded once in migration 0038).
//
// Data fetch: /api/schedule-master?week_start=YYYY-MM-DD. The route
// returns all 8 cities in canonical order with exactly 7 day slots
// each, so the render code is straight iteration with no missing-
// day guards.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";

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

export default function CitiesMasterScheduleLens() {
  const [weekStart, setWeekStart] = useState<string>(() =>
    isoDate(mondayOfChicago(new Date())),
  );
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      const res = await fetch(`/api/schedule-master?week_start=${ws}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const j = (await res.json()) as Payload;
      setData(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(weekStart);
  }, [load, weekStart]);

  const todayIso = useMemo(() => isoDate(mondayOfChicago(new Date(), 0)), []);

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
        <WeekNav
          weekStart={weekStart}
          weekEnd={data?.week_end ?? weekStart}
          onPrev={() => shift(-7)}
          onNext={() => shift(7)}
          onToday={goToday}
        />
      </div>

      {loading && !data ? (
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading schedule…
        </div>
      ) : error ? (
        <div className="rounded-2xl border-[1.5px] border-coral/40 bg-coral-soft p-6 text-sm text-coral-hover shadow-md shadow-deep-green/10">
          {error}
        </div>
      ) : !data ? null : (
        <div className="space-y-5">
          {data.cities.map((c) => (
            <CitySection key={c.name} city={c} todayIso={todayIso} />
          ))}
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
  const label = `${fmtShort(weekStart)} – ${fmtShort(weekEnd)}`;
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

function CitySection({ city, todayIso }: { city: CityOut; todayIso: string }) {
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-bold text-deep-green">{city.name}</h3>
        <span className="rounded-full bg-cream-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/65">
          {city.total} {city.total === 1 ? "match" : "matches"}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {city.days.map((d) => (
          <DayCell key={d.date} day={d} todayIso={todayIso} />
        ))}
      </div>
    </div>
  );
}

function DayCell({ day, todayIso }: { day: DayOut; todayIso: string }) {
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
        {day.matches.length === 0 ? (
          <span className="text-[11px] text-deep-green/30">—</span>
        ) : (
          day.matches.map((m) => (
            <MatchPill
              key={m.id}
              time={m.time}
              detail={m.detail}
              dim={isPast}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MatchPill({
  time,
  detail,
  dim,
}: {
  time: string;
  detail: string;
  dim: boolean;
}) {
  // Compact start-time label: "7p" / "6:30p" / "9a".
  const short = compactTime(time);
  return (
    <div
      className={`truncate rounded px-1.5 py-0.5 text-[11px] leading-tight ${
        dim
          ? "bg-cream-soft text-deep-green/40"
          : "bg-white text-deep-green ring-1 ring-cream-line"
      }`}
      title={`${time} · ${detail}`}
    >
      <span className="font-bold tabular-nums">{short}</span>{" "}
      <span>{detail}</span>
    </div>
  );
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

// Monday-of-week relative to a given anchor day in America/Chicago.
// `offsetDays = -daysFromMonday` snaps to Monday; pass 0 to get the
// Chicago-calendar today (used for past/today styling).
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

// "7:00 PM - 8:00 PM" → "7p", "6:30 PM" → "6:30p", "9 AM" → "9a".
// Falls back to the raw string if unparseable so nothing is hidden.
function compactTime(time: string): string {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = (m[3] ?? "").toUpperCase();
  const suffix = ampm === "AM" ? "a" : ampm === "PM" ? "p" : "";
  return min === 0 ? `${h}${suffix}` : `${h}:${m[2]}${suffix}`;
}
