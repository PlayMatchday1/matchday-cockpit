"use client";

// Games-per-week demand for the Slate strip: booked spots ÷ 18.
//
// A booked spot is a real (non-fake) player who took and held a seat that week —
// INCLUDING absents, because an absent booked a spot and nobody else could take
// it, so it is still demand. This is the ONE place absents count: everything
// else on the page (who showed up, cancel players) correctly excludes them. The
// shared mapper drops absents, so the strip cannot use it — this reads mdapi
// directly and keeps absents in, fakes out.
//
// Excluded from a booked spot: fake accounts (never existed), WAITING
// (incomplete payment, not yet a seat), player-cancelled seats (gave it back),
// and every player of a cancelled match (the match didn't happen).
//
// PAGINATION (why selectAll): PostgREST caps every response at ~1000 rows. A
// high-volume city (Austin: ~8,700 player rows over 8 weeks) blew straight
// through that cap when the fetch was a bare `.in(...).select()` — the first
// ~1000 rows came back (week 1 complete, week 2 half, weeks 3-8 gone) and the
// strip silently lost most of its data. Every read here is now windowed with
// selectAll, which loops 1000-row `.range()` pages until a short page ends it.
// We chose client pagination over a server-side RPC deliberately: it keeps a
// single source of truth for the spots computation (the same JS verified against
// the approved Dallas values), it deploys atomically (an RPC would leave the
// strip broken until the migration was pasted by hand), and the page already
// ships comparable row volumes through the paginated shared mapper for the
// Cancel Patterns card. selectAll requires a stable `.order()` on a unique
// column — we use api_id on both tables.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { selectAll } from "@/lib/supabasePagination";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";

const CODE_BY_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(CITY_CODE_TO_DISPLAY).map(([code, display]) => [display, code]),
);

export const MATCH_DENOMINATOR = 18; // a full match
// Keep chunks well under PostgREST's ~2KB URL limit (200 ids × ~7 chars ≈ 1.4KB),
// matching the shared mapper's IN_CHUNK. Each chunk is still paginated, so this
// only bounds URL length, never row count.
const IN_CHUNK = 200;

export type DemandWeek = {
  weekStart: Date;
  spots: number;
  ratio: number;
  isCurrent: boolean;
  // false → the city had NO matches at all in mdapi that week (a genuine data
  // gap). Rendered hatched / "no data" and excluded from any average. A week
  // with matches but zero booked spots on ran matches (e.g. every match was
  // cancelled) is a TRUE 0: hasData stays true.
  hasData: boolean;
};

function localMonday(d: Date): Date {
  const g = d.getDay();
  const diff = g === 0 ? -6 : 1 - g;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
}
function weekKeyLocal(d: Date): string {
  const m = localMonday(d);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
}

type MatchRow = { api_id: number; start_date: string; is_cancelled: boolean | null };
type PlayerRow = {
  match_api_id: number;
  user_is_fake_player: boolean | null;
  paid_status: string | null;
  canceled_at: string | null;
};

export function useWeeklyDemand(city: string, weeksBack = 8): { weekly: DemandWeek[]; loading: boolean } {
  const [weekly, setWeekly] = useState<DemandWeek[]>([]);
  const [loading, setLoading] = useState(true);

  const weeks = useMemo(() => {
    const cur = localMonday(new Date());
    const out: Date[] = [];
    for (let i = weeksBack - 1; i >= 0; i--) out.push(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 7 * i));
    return out;
  }, [weeksBack]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const code = CODE_BY_DISPLAY[city] ?? city;
      const from = weeks[0];
      const end = new Date(weeks[weeks.length - 1].getFullYear(), weeks[weeks.length - 1].getMonth(), weeks[weeks.length - 1].getDate() + 6);
      const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}T00:00:00`;
      const toStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}T23:59:59`;

      // 1. Matches for the city in the window (paginated; a city can exceed 1000
      //    matches over a long window). Stable order by api_id for selectAll.
      const matches = await selectAll<MatchRow>(() =>
        supabase
          .from("mdapi_matches")
          .select("api_id, start_date, is_cancelled")
          .eq("city_identifier", code)
          .is("deleted_at", null)
          .gte("start_date", fromStr)
          .lte("start_date", toStr)
          .order("api_id"),
      );

      const cancelled = new Set(matches.filter((m) => m.is_cancelled).map((m) => m.api_id));
      const startById = new Map(matches.map((m) => [m.api_id, m.start_date]));
      const ranIds = matches.map((m) => m.api_id).filter((id) => !cancelled.has(id));

      // hasData: any match (ran or cancelled) in mdapi for that week.
      const matchesPerWeek = new Map<string, number>();
      for (const w of weeks) matchesPerWeek.set(weekKeyLocal(w), 0);
      for (const m of matches) {
        const k = weekKeyLocal(new Date(m.start_date.replace(/([+-]\d\d:\d\d|Z)$/, "")));
        if (matchesPerWeek.has(k)) matchesPerWeek.set(k, matchesPerWeek.get(k)! + 1);
      }

      const perWeek = new Map<string, number>();
      for (const w of weeks) perWeek.set(weekKeyLocal(w), 0);

      // 2. Player rows for ran matches, chunked by id AND paginated within each
      //    chunk (this is the cap fix — a bare .in() truncated at 1000 rows).
      for (let i = 0; i < ranIds.length; i += IN_CHUNK) {
        const batch = ranIds.slice(i, i + IN_CHUNK);
        const players = await selectAll<PlayerRow>(() =>
          supabase
            .from("mdapi_match_players")
            .select("match_api_id, user_is_fake_player, paid_status, canceled_at")
            .in("match_api_id", batch)
            .is("deleted_at", null)
            .order("api_id"),
        );
        for (const p of players) {
          if (p.user_is_fake_player) continue; // fakes: never count
          if (p.paid_status === "WAITING") continue; // not a seat yet
          if (p.canceled_at) continue; // gave the seat back
          // absents are KEPT — they booked a seat.
          const start = startById.get(p.match_api_id);
          if (!start) continue;
          const key = weekKeyLocal(new Date(start.replace(/([+-]\d\d:\d\d|Z)$/, "")));
          if (perWeek.has(key)) perWeek.set(key, perWeek.get(key)! + 1);
        }
      }

      const out: DemandWeek[] = weeks.map((w, i) => {
        const wk = weekKeyLocal(w);
        const spots = perWeek.get(wk) ?? 0;
        return {
          weekStart: w,
          spots,
          ratio: Math.round((spots / MATCH_DENOMINATOR) * 10) / 10,
          isCurrent: i === weeks.length - 1,
          hasData: (matchesPerWeek.get(wk) ?? 0) > 0,
        };
      });
      setWeekly(out);
    } catch {
      setWeekly([]);
    } finally {
      setLoading(false);
    }
  }, [city, weeks]);

  useEffect(() => { void load(); }, [load]);
  return { weekly, loading };
}
