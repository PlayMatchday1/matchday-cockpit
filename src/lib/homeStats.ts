// Home hero scoreboard data. Real numbers only — no hardcoded tiles.
//
// Matches / wk: count of mdapi_matches that HAPPENED in the trailing 7 days —
// is_cancelled=false (per the auto_canceled-vs-is_cancelled distinction, a
// non-cancelled match is one that occurred), start_date in [now-7d, now).
// Read-only. It does NOT join mdapi_match_players, so no fake player can enter
// the count. Returns null on error → the hero renders two tiles, never a guess.

import { supabase } from "@/lib/supabase";

export async function fetchMatchesPerWeek(): Promise<number | null> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const { count, error } = await supabase
    .from("mdapi_matches")
    .select("api_id", { count: "exact", head: true })
    .eq("is_cancelled", false)
    .gte("start_date", weekAgo.toISOString())
    .lt("start_date", now.toISOString());
  if (error) return null;
  return count ?? null;
}
