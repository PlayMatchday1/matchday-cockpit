/* ACTIVE CITIES — ONE LIST, AND IT IS growth_cities (Ryan, 2026-11-09).
 *
 * The cities MatchDay operates in are the rows of growth_cities (0253), the table behind 2026 Daily
 * Matches: add a city there and every page that asks "which cities are active" lists it; hide it there
 * (hidden = true) and it drops out of them. Before this, Player Activity, Acquisition and the app's
 * Players screen each carried their own hard-coded seven, none of which had Philadelphia, so
 * Philadelphia sat behind "Include cities outside active operations".
 *
 * Anything a page's data carries that is NOT here (El Paso, New York City, Warsaw, Unassigned) is
 * "outside active operations": still counted in totals, shown on its own only behind each page's toggle.
 *
 * A row is { name, code }:
 *   name  growth_cities.name, which is the growth display vocabulary (normalizeMatchCity /
 *         normalizeDeclared print "Dallas", "OKC", "Philadelphia"), so name-keyed pages match on it.
 *   code  growth_cities.short_code, the MatchDay city identifier (HOU, DFW, PHL).
 * A visible row with no short_code is listed by name only; nothing code-keyed can match it.
 *
 * Read with a 60-second process cache: a change on Daily Matches shows within a minute. */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ActiveCity = { name: string; code: string | null };

/** Acquisition's market keys predate this list and spell Houston "HTX" (acq_page_map, Meta's
 *  market_key). Every other active city's market key is its MatchDay code. */
export const acqMarketKey = (code: string) => (code === "HOU" ? "HTX" : code);

let cache: { at: number; list: ActiveCity[] } | null = null;
const TTL_MS = 60_000;

export async function loadActiveCities(sb: SupabaseClient): Promise<ActiveCity[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const { data, error } = await sb.from("growth_cities").select("name, short_code, hidden, sort_order").order("sort_order");
  if (error) throw new Error(`growth_cities: ${error.message}`);
  const list = ((data ?? []) as { name: string; short_code: string | null; hidden: boolean | null }[])
    /* WARSAW NEVER JOINS A US LIST, even if a row for it appeared (Daily Matches refuses it by name
     * too). It is a partner market with its own confined view. */
    .filter((c) => c.hidden !== true && String(c.name ?? "").trim() && c.short_code !== "WAW" && !/^warsaw$/i.test(String(c.name).trim()))
    .map((c) => ({ name: String(c.name).trim(), code: c.short_code ? String(c.short_code).trim() : null }));
  cache = { at: Date.now(), list };
  return list;
}
