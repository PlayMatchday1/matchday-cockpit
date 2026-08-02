"use client";

// Games-per-week demand for the Slate strip + lede: booked spots ÷ 18.
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { CITY_CODE_TO_DISPLAY } from "@/lib/scheduleReconcile";

const CODE_BY_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(CITY_CODE_TO_DISPLAY).map(([code, display]) => [display, code]),
);

export const MATCH_DENOMINATOR = 18; // a full match

export type DemandWeek = { weekStart: Date; spots: number; ratio: number; isCurrent: boolean };

function localMonday(d: Date): Date {
  const g = d.getDay();
  const diff = g === 0 ? -6 : 1 - g;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
}
function weekKeyLocal(d: Date): string {
  const m = localMonday(d);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
}

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

      const mm = await supabase
        .from("mdapi_matches")
        .select("api_id, start_date, is_cancelled")
        .eq("city_identifier", code)
        .is("deleted_at", null)
        .gte("start_date", fromStr)
        .lte("start_date", toStr);
      const matches = (mm.data ?? []) as Array<{ api_id: number; start_date: string; is_cancelled: boolean | null }>;
      const cancelled = new Set(matches.filter((m) => m.is_cancelled).map((m) => m.api_id));
      const startById = new Map(matches.map((m) => [m.api_id, m.start_date]));
      const ids = matches.map((m) => m.api_id).filter((id) => !cancelled.has(id));

      const perWeek = new Map<string, number>();
      for (const w of weeks) perWeek.set(weekKeyLocal(w), 0);

      for (let i = 0; i < ids.length; i += 400) {
        const batch = ids.slice(i, i + 400);
        const pr = await supabase
          .from("mdapi_match_players")
          .select("match_api_id, user_is_fake_player, paid_status, canceled_at")
          .in("match_api_id", batch)
          .is("deleted_at", null);
        for (const p of (pr.data ?? []) as Array<{ match_api_id: number; user_is_fake_player: boolean | null; paid_status: string | null; canceled_at: string | null }>) {
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
        const spots = perWeek.get(weekKeyLocal(w)) ?? 0;
        return { weekStart: w, spots, ratio: Math.round((spots / MATCH_DENOMINATOR) * 10) / 10, isCurrent: i === weeks.length - 1 };
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
