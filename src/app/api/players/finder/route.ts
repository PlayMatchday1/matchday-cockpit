// PLAYER FINDER — every filter, every count and every tile, in SQL.
//
// THE RULE THIS ROUTE EXISTS TO KEEP. A browser that filters the page it happens to hold filters
// 50 rows and reports a confident wrong number for the other 30,195. So nothing here is computed
// from `rows`: the total comes back with the aggregate row, and every tile with it. The only thing
// derived from the returned rows is the rows themselves.
//
// TWO WINDOWS, AND THEY ARE TWINS. SIGNED UP filters on `created_at`; PLAYED filters on the dates
// of the player's own spots. Both take presets or an explicit from–to, and both are read by ONE
// predicate — `player_finder_ids` in 0135 — which the page and the stats both join to. There is no
// second place a filter can be applied, which is what stops the band describing a different set of
// people than the table under it.
//
// PLAYED USED TO DRIVE ONLY THE TILES. That was the bug: the rows ignored the month select, so the
// band and the table could disagree about the same person — 0134's failure one level up.
//
// WHY RPCs AND NOT PostgREST. "Played between 1 and 14 August" is an EXISTS over that player's
// spots. It is NOT derivable from `last_played`: someone whose most recent match is in September
// may still have played in August, and a `last_played BETWEEN` test silently drops them. The
// presets alone would fit in PostgREST; an arbitrary range does not, and two code paths behind one
// control is how the halves come apart.
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { assertScope } from "@/lib/cityConfinement";
import { cityNameFor, resolveCityScope } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** The export walks the whole filtered set; this is the ceiling before it refuses rather than hangs. */
const EXPORT_MAX = 50_000;

type History = "any" | "never" | "once" | "multi";
type Member = "any" | "yes" | "no";
type PlayMode = "any" | "window" | "lapsed";

const HISTORIES = new Set<History>(["any", "never", "once", "multi"]);
const MEMBERS = new Set<Member>(["any", "yes", "no"]);
/** The PLAYED presets, in the client's vocabulary. `not60` is the one SIGNED UP cannot have. */
const PLAY_PRESETS = new Set(["all", "7", "30", "90", "not60"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, "public", "public", any, any>;

type Args = {
  p_search: string | null;
  p_reg_from: string | null;
  p_reg_to: string | null;
  p_history: History;
  p_play_mode: PlayMode;
  p_play_from: string | null;
  p_play_to: string | null;
  /** HOME city — the city on the player's account (preferable_city_name). NOT where they played. */
  p_city: string | null;
  p_member: Member;
  /** Home city IS NULL. 4,010 players have none, and a "= Austin" filter has always dropped them
   *  silently; this is what makes them reachable. */
  p_city_unset: boolean;
  // ── PLAYED AT — filters on the MATCHES, not on the player (migration 0147) ──
  p_match_city: string | null;
  p_field_id: number | null;
  p_kick_from: string | null;   // "HH:MM" wall clock
  p_kick_to: string | null;
  p_match_from: string | null;  // "YYYY-MM-DD" wall-clock day
  p_match_to: string | null;
};

type PageRow = {
  id: number; email: string | null; first_name: string | null; last_name: string | null;
  phone_number: string | null; created_at: string | null; preferable_city_name: string | null;
  is_member: boolean | null; plays: number | null; last_played: string | null;
};

/* ── SEND ONLY WHAT DIFFERS FROM THE SQL DEFAULT ───────────────────────────────────────────────
 * MEASURED, and it is a cliff rather than a slope. player_finder_page unfiltered:
 *
 *   arguments omitted where they equal the default   →  494ms
 *   the same values passed as explicit nulls         →  8s statement timeout
 *
 * Identical function, identical values. Omitted, PostgREST leaves the SQL defaults in place and the
 * planner constant-folds `p_play_mode = 'any'`, sees the play-window branch is unreachable and
 * removes it. Passed explicitly they arrive as bind parameters, nothing can be folded, and every
 * branch must be planned for the general case.
 *
 * This is the production call path, so this is the shape that has to be fast. 0138 hardens the SQL
 * so a caller that does pass explicit nulls is merely slower rather than dead; until it is applied,
 * this is what keeps the page under a second. */
/* OMIT WHAT IS AT ITS DEFAULT. This is not tidiness — 0136 measured it: an argument PASSED
 * EXPLICITLY arrives as a parameter the planner cannot fold, and the same function that ran in
 * 424ms with the argument omitted hit an 8-second timeout with it supplied. Every new filter below
 * is listed here so an unused one is never sent. */
const DEFAULTS: Record<string, unknown> = {
  p_search: null, p_reg_from: null, p_reg_to: null, p_history: "any",
  p_play_mode: "any", p_play_from: null, p_play_to: null, p_city: null, p_member: "any",
  p_city_unset: false, p_match_city: null, p_field_id: null,
  p_kick_from: null, p_kick_to: null, p_match_from: null, p_match_to: null,
};
function compact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k in DEFAULTS && v === DEFAULTS[k]) continue;
    out[k] = v;
  }
  return out;
}

/* ── THE FIELD LIST FOR THE "PLAYED AT" CONTROL ───────────────────────────────────────────────
 *
 * One entry per mdapi field_id that has ever hosted a match, with its city, so the Field select
 * can be narrowed to the chosen city. Built by paging mdapi_matches once and CACHED IN PROCESS —
 * the alternative is ~10 paged reads on every keystroke, and this list changes when a new pitch
 * opens, not when someone types.
 *
 * NOT from fin_venue_fields: only 41 of the 79 live field IDs are mapped to a venue, and a Field
 * select that silently omits 38 pitches is worse than no select. This reads the matches, which is
 * where the field actually appears.
 *
 * The TITLE is the one on the field's most recent match — MatchDay renames a field occasionally
 * (one has, out of 79) and the current name is the one an operator recognises. */
type FieldOption = { fieldId: number; title: string; city: string | null };
let fieldCache: { at: number; list: FieldOption[] } | null = null;
const FIELD_TTL_MS = 10 * 60 * 1000;

async function fieldOptions(db: Db): Promise<FieldOption[]> {
  if (fieldCache && Date.now() - fieldCache.at < FIELD_TTL_MS) return fieldCache.list;
  const latest = new Map<number, { ms: number; title: string; city: string | null }>();
  let last = 0;
  for (;;) {
    const { data, error } = await db
      .from("mdapi_matches")
      .select("api_id, field_id, field_title, city_name, start_date")
      .is("deleted_at", null)
      .gt("api_id", last)
      .order("api_id")
      .limit(1000);
    if (error) break;                       // a field list that fails is an empty select, not a 500
    const rows = (data ?? []) as { api_id: number; field_id: number | null; field_title: string | null; city_name: string | null; start_date: string | null }[];
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.field_id == null) continue;
      const ms = Date.parse(String(r.start_date ?? "").slice(0, 10)) || 0;
      const cur = latest.get(r.field_id);
      if (!cur || ms > cur.ms) latest.set(r.field_id, { ms, title: r.field_title ?? `field ${r.field_id}`, city: r.city_name ?? null });
    }
    last = rows[rows.length - 1].api_id;
    if (rows.length < 1000) break;
  }
  const list = [...latest.entries()]
    .map(([fieldId, v]) => ({ fieldId, title: v.title, city: v.city }))
    .sort((a, b) => (a.city ?? "").localeCompare(b.city ?? "") || a.title.localeCompare(b.title));
  fieldCache = { at: Date.now(), list };
  return list;
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
const daysAgoDay = (n: number) => ymd(new Date(Date.now() - n * 86400_000));

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;

  const url = new URL(req.url);
  const asked = url.searchParams.get("city");

  /* ── SCOPE IS A BOUNDARY, THE CITY SELECT IS A CONVENIENCE ──────────────────────────────────
   * A confined account's city comes from the DATABASE ROW, never from the query string, so
   * widening the dropdown client-side reaches nothing. Refused outright rather than silently
   * re-pointed at their own city — a silent re-point looks like the feature working. */
  const scopeCheck = assertScope(auth.confinedCity, asked === "all" ? null : asked, auth.confinedCity !== null);
  if (!scopeCheck.ok) return Response.json({ error: scopeCheck.error }, { status: scopeCheck.status });

  let scope: string | null = auth.confinedCity;
  if (!scope && asked && asked !== "all") {
    if (!resolveCityScope(asked)) {
      return Response.json({ error: `${JSON.stringify(asked)} is not a known city.` }, { status: 400 });
    }
    scope = asked;
  }

  const history = (url.searchParams.get("hist") ?? "any") as History;
  const member = (url.searchParams.get("member") ?? "any") as Member;
  if (!HISTORIES.has(history)) return Response.json({ error: `unknown history ${JSON.stringify(history)}` }, { status: 400 });
  if (!MEMBERS.has(member)) return Response.json({ error: `unknown member filter ${JSON.stringify(member)}` }, { status: 400 });

  /* ── SIGNED UP: A PRESET OR A RANGE, NEVER BOTH ─────────────────────────────────────────────
   * Two date filters both lit is a lie about what is being shown, so an explicit from/to wins and
   * the preset is reported back as the default — the client lights what the server APPLIED rather
   * than what the user last clicked. */
  const regFromRaw = url.searchParams.get("regFrom");
  const regToRaw = url.searchParams.get("regTo");
  const regRange = !!(regFromRaw || regToRaw);
  const regPreset = regRange ? "all" : (url.searchParams.get("reg") ?? "all");
  const regDays = regPreset === "7" ? 7 : regPreset === "30" ? 30 : regPreset === "90" ? 90 : null;
  const p_reg_from = regRange
    ? (regFromRaw ? new Date(`${regFromRaw}T00:00:00`).toISOString() : null)
    : regDays ? daysAgoIso(regDays) : null;
  // INCLUSIVE TO THE END OF THE DAY. A `to` that stops at midnight silently drops everyone who
  // signed up on the day the operator picked.
  const p_reg_to = regRange && regToRaw ? new Date(`${regToRaw}T23:59:59.999`).toISOString() : null;

  /* ── PLAYED: THE SAME SHAPE, PLUS ONE THING SIGNED UP CANNOT HAVE ───────────────────────────
   * "Not in 60+ days" is a negation, and a negation only means anything over a set of events.
   * Signing up is ONE event, so negating a signup window has no meaning and that row does not
   * offer it. Same override rules otherwise: a typed date beats the preset, a preset clears the
   * dates, and the server reports which one it actually applied. */
  const playFromRaw = url.searchParams.get("playFrom");
  const playToRaw = url.searchParams.get("playTo");
  const playRange = !!(playFromRaw || playToRaw);
  const playPresetRaw = url.searchParams.get("play") ?? "all";
  if (!PLAY_PRESETS.has(playPresetRaw)) {
    return Response.json({ error: `unknown played window ${JSON.stringify(playPresetRaw)}` }, { status: 400 });
  }
  const playPreset = playRange ? "all" : playPresetRaw;

  let p_play_mode: PlayMode = "any";
  let p_play_from: string | null = null;
  let p_play_to: string | null = null;
  if (playRange) {
    p_play_mode = "window";
    p_play_from = playFromRaw || null;
    p_play_to = playToRaw || null;
  } else if (playPreset === "not60") {
    p_play_mode = "lapsed";
  } else if (playPreset === "7" || playPreset === "30" || playPreset === "90") {
    p_play_mode = "window";
    p_play_from = daysAgoDay(Number(playPreset));
  }

  /* HISTORY = never played AND a play window cannot both be true. The client disables the row and
   * says why; this drops the window so the two are never sent together, and 0135 ignores it a third
   * time. A disabled control is a courtesy — the rule has to live where the rule is applied. */
  const playSuppressed = history === "never" && p_play_mode !== "any";
  if (history === "never") {
    p_play_mode = "any";
    p_play_from = null;
    p_play_to = null;
  }

  /* ── PLAYED AT: THE MATCH FILTERS ───────────────────────────────────────────────────────────
   * These describe the MATCHES a player was at — a different question from every filter above,
   * which describe the player. `homeCity=unset` is the one that needs saying out loud: it selects
   * players whose account carries no city, which a home-city equality test has always excluded.
   *
   * A CONFINED ACCOUNT CANNOT WIDEN matchCity past its own boundary, for the same reason the home
   * city select cannot: the scope comes from the database row and the query string is a
   * convenience. assertScope refuses rather than silently re-pointing. */
  /* HOME CITY IS THE BOUNDARY. PLAYED-AT CITY IS A FILTER. THEY ARE NOT THE SAME THING, and
   * conflating them is what broke Warsaw: this block used to open `let matchCity =
   * auth.confinedCity`, copied from the home-city scope above, which set p_match_city on EVERY
   * confined request whether or not the operator had touched the control. A confined account then
   * saw home-city AND played-in-city — an intersection — instead of home-city. Warsaw went from 14
   * to 5, and the 9 missing were exactly the new signups who had not played yet, who are the
   * outreach list.
   *
   * SO IT DEFAULTS TO NULL: no filter unless one is asked for. The boundary is still absolute, and
   * it is assertScope that enforces it — a confined account naming another city is REFUSED above,
   * not silently re-pointed. Forcing the value was never what kept the boundary; refusing is. */
  const matchCityAsked = url.searchParams.get("matchCity");
  const matchScope = assertScope(auth.confinedCity, matchCityAsked === "all" ? null : matchCityAsked, auth.confinedCity !== null);
  if (!matchScope.ok) return Response.json({ error: matchScope.error }, { status: matchScope.status });
  let matchCity: string | null = null;
  if (matchCityAsked && matchCityAsked !== "all") {
    if (!resolveCityScope(matchCityAsked)) {
      return Response.json({ error: `${JSON.stringify(matchCityAsked)} is not a known city.` }, { status: 400 });
    }
    matchCity = matchCityAsked;
  }

  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const timeArg = (k: string) => {
    const v = url.searchParams.get(k);
    if (!v) return null;
    if (!HHMM.test(v)) return undefined;      // undefined = reject, distinct from "not sent"
    return `${v}:00`;
  };
  const dayArg = (k: string) => {
    const v = url.searchParams.get(k);
    if (!v) return null;
    return YMD.test(v) ? v : undefined;
  };
  const p_kick_from = timeArg("kickFrom"), p_kick_to = timeArg("kickTo");
  const p_match_from = dayArg("matchFrom"), p_match_to = dayArg("matchTo");
  for (const [k, v] of Object.entries({ kickFrom: p_kick_from, kickTo: p_kick_to, matchFrom: p_match_from, matchTo: p_match_to })) {
    if (v === undefined) return Response.json({ error: `${k} must be ${k.startsWith("kick") ? "HH:MM" : "YYYY-MM-DD"}` }, { status: 400 });
  }
  const fieldRaw = url.searchParams.get("fieldId");
  const p_field_id = fieldRaw ? Number(fieldRaw) : null;
  if (fieldRaw && !Number.isInteger(p_field_id)) {
    return Response.json({ error: "fieldId must be an integer" }, { status: 400 });
  }

  const args: Args = {
    p_search: (url.searchParams.get("q") ?? "").trim() || null,
    p_reg_from, p_reg_to,
    p_history: history,
    p_play_mode, p_play_from, p_play_to,
    p_city: scope ? cityNameFor(scope) : null,
    p_member: member,
    p_city_unset: url.searchParams.get("homeCity") === "unset",
    p_match_city: matchCity ? cityNameFor(matchCity) : null,
    p_field_id,
    p_kick_from: p_kick_from ?? null,
    p_kick_to: p_kick_to ?? null,
    p_match_from: p_match_from ?? null,
    p_match_to: p_match_to ?? null,
  };

  const wantExport = url.searchParams.get("export") === "1";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("size") ?? PAGE_SIZE) || PAGE_SIZE));
  /* THE TABLE IS NEWEST-FIRST AND HAS NO SORT CONTROL. The page function used to take a sort
   * column and serve it with a six-branch CASE that no index could satisfy — a general-case cost
   * on every request for a feature nothing sends. Adding one later means an index and a
   * measurement, not a parameter. */
  const sort = "registered";
  const dir = "desc";

  try {
    if (wantExport) return await exportAll(supabase, args);

    /* TWO ROUND TRIPS, TOTAL — the page and one aggregate row. This replaced a page fetch plus
     * seven tile counts plus ten per-city counts plus a median plus a newest plus an occupancy
     * call: about twenty, every one of which had to agree with the others by construction rather
     * than by sharing a predicate. */
    /* ── REFRESH MEANS REBUILD, BUT ONLY WHEN THERE IS SOMETHING TO REBUILD ────────────────────
     * The button used to call this route and nothing else, which re-read a stale set and
     * re-rendered the same staleness — honest, and useless to the person clicking it. It now
     * rebuilds the precomputed set first.
     *
     * ONLY WHEN STALE. A rebuild is ~3s and takes a brief exclusive lock on both matviews, so
     * firing one on every click would make a no-op button expensive and let repeated clicks queue
     * locks behind each other. The staleness check is the rate limit: once the set is current, the
     * second click is a plain re-read.
     *
     * BEST-EFFORT, LIKE THE SYNC'S. A failed rebuild must not fail the read — the page still has a
     * set to show and a banner to say how old it is. 0147 shipped a refresh that threw on every
     * call (pg_safeupdate, an UPDATE with no WHERE) and the only reason anyone noticed was that
     * banner, so the read staying up is what makes the failure visible rather than fatal. */
    let rebuilt = false;
    if (url.searchParams.get("rebuild") === "1") {
      const { data: pre } = await supabase.rpc("player_finder_freshness");
      if (((pre ?? [])[0] as { stale?: boolean } | undefined)?.stale === true) {
        const { error: refreshErr } = await supabase.rpc("refresh_player_finder_views");
        if (refreshErr) console.warn("[finder] manual rebuild failed:", refreshErr.message);
        else rebuilt = true;
      }
    }

    const [pageRes, statsRes, fields] = await Promise.all([
      supabase.rpc("player_finder_page", { ...compact(args), p_limit: size, p_offset: (page - 1) * size }),
      supabase.rpc("player_finder_stats", compact(args)),
      fieldOptions(supabase),
    ]);
    if (pageRes.error) throw new Error(pageRes.error.message);
    if (statsRes.error) throw new Error(statsRes.error.message);

    const rows = (pageRes.data ?? []) as PageRow[];
    const s = ((statsRes.data ?? [])[0] ?? {}) as Record<string, number | string | null>;
    // THE TOTAL COMES FROM THE STATS ROW, so an empty page still carries a real count rather than
    // reporting zero because there was nothing on page 4.
    const total = Number(s.players ?? 0);

    /* THE AGE OF THE SET, NOT THE AGE OF THE MIRROR. This used to read mdapi_users.synced_at,
     * which answers "how old is the data we copied" — but since 0147 the finder reads a
     * precomputed set built FROM that mirror, and it is the set's age that governs what is on
     * screen. `stale` is true when a sync landed and the rebuild did not follow it, which is the
     * one state a fast table can be in that a slow view never could: confidently wrong. */
    const { data: freshRows } = await supabase.rpc("player_finder_freshness");
    const fresh = (freshRows ?? [])[0] as
      { refreshed_at?: string; source_synced_at?: string; stale?: boolean } | undefined;
    const syncedAt = fresh?.refreshed_at ?? null;
    const sourceSyncedAt = fresh?.source_synced_at ?? null;
    const stale = fresh?.stale === true;

    return Response.json({
      players: rows.map(shape),
      total, page, size, sort, dir,
      // The set's own freshness — the page prints this instead of a count that looks current.
      freshness: { refreshedAt: syncedAt, sourceSyncedAt, stale, rebuilt },
      // How many players carry NO home city. Printed beside the Home city control so "= Austin"
      // cannot silently drop them; counted over the whole estate, so it does not move with the
      // other filters.
      noHomeCity: Number(s.no_home_city ?? 0),
      // Every field that has hosted a match, with its city, so the Field select can narrow to it.
      fields,
      // WHAT THE SERVER ACTUALLY APPLIED, not what was asked for. The client lights its controls
      // from this, so a preset overridden by a range cannot stay lit, and a play window suppressed
      // by History = never played is visibly suppressed rather than quietly ignored.
      applied: {
        q: args.p_search, reg: regPreset, regFrom: regFromRaw, regTo: regToRaw,
        hist: history, play: playPreset, playFrom: playFromRaw, playTo: playToRaw,
        playMode: p_play_mode, playSuppressed, member, city: scope ?? null,
        homeCity: args.p_city_unset ? "unset" : (scope ?? "all"),
        matchCity: matchCity ?? null, fieldId: p_field_id,
        kickFrom: url.searchParams.get("kickFrom"), kickTo: url.searchParams.get("kickTo"),
        matchFrom: url.searchParams.get("matchFrom"), matchTo: url.searchParams.get("matchTo"),
      },
      stats: {
        players: total,
        never: Number(s.never ?? 0), members: Number(s.members ?? 0),
        week: Number(s.week ?? 0), month30: Number(s.month30 ?? 0),
        heavy: Number(s.heavy ?? 0), named: Number(s.named ?? 0),
        cities: Number(s.cities ?? 0),
        topCity: s.top_city ? { name: String(s.top_city), n: Number(s.top_city_n ?? 0) } : null,
        medianAgeDays: s.median_age_days == null ? null : Number(s.median_age_days),
        newest: s.newest == null ? null : String(s.newest),
        // NULL, NOT ZERO, when the window is a negation. A negation has no window to total, and a
        // figure labelled with one would be lying about its own scope. The client drops the tiles.
        spots: s.spots == null ? null : Number(s.spots),
        matches: s.matches == null ? null : Number(s.matches),
        matchesFull: s.matches_full == null ? null : Number(s.matches_full),
        capacity: s.capacity == null ? null : Number(s.capacity),
      },
      scope: scope ?? null, scopeName: args.p_city, confined: !!auth.confinedCity,
      syncedAt,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/* THE EXPORT WALKS THE WHOLE FILTERED SET, paged. Exporting the fifty rows already on screen is
 * useless for the outreach this exists for. Capped so a runaway request refuses instead of hanging. */
async function exportAll(db: Db, args: Args) {
  // THE TOTAL COMES FROM STATS, the same predicate the page joins to. The page used to carry its
  // own `count(*) over ()` so the two could not disagree; that materialised all 30,245 rows on
  // every request and timed out. The shared predicate is what keeps them honest, not a second count.
  const head = await db.rpc("player_finder_stats", compact(args));
  if (head.error) throw new Error(head.error.message);
  const total = Number(((head.data ?? [])[0] as { players?: number } | undefined)?.players ?? 0);
  if (total > EXPORT_MAX) {
    return Response.json({ error: `${total.toLocaleString()} rows is above the ${EXPORT_MAX.toLocaleString()} export ceiling — narrow the filters.` }, { status: 413 });
  }
  const all: PageRow[] = [];
  for (let off = 0; off < total; off += 1000) {
    const { data, error } = await db.rpc("player_finder_page", { ...compact(args), p_limit: 1000, p_offset: off });
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as PageRow[];
    all.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return Response.json({ players: all.map(shape), total, exported: all.length });
}

function shape(r: PageRow) {
  return {
    id: Number(r.id),
    name: [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null,
    email: r.email ?? null,
    phone: r.phone_number ?? null,
    city: r.preferable_city_name ?? null,
    registered: r.created_at ?? null,
    last_match: r.last_played ?? null,
    member: r.is_member === true,
    plays: Number(r.plays ?? 0),
  };
}
