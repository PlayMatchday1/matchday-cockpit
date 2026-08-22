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
  p_city: string | null;
  p_member: Member;
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
const DEFAULTS: Record<string, unknown> = {
  p_search: null, p_reg_from: null, p_reg_to: null, p_history: "any",
  p_play_mode: "any", p_play_from: null, p_play_to: null, p_city: null, p_member: "any",
};
function compact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k in DEFAULTS && v === DEFAULTS[k]) continue;
    out[k] = v;
  }
  return out;
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

  const args: Args = {
    p_search: (url.searchParams.get("q") ?? "").trim() || null,
    p_reg_from, p_reg_to,
    p_history: history,
    p_play_mode, p_play_from, p_play_to,
    p_city: scope ? cityNameFor(scope) : null,
    p_member: member,
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
    const [pageRes, statsRes] = await Promise.all([
      supabase.rpc("player_finder_page", { ...compact(args), p_limit: size, p_offset: (page - 1) * size }),
      supabase.rpc("player_finder_stats", compact(args)),
    ]);
    if (pageRes.error) throw new Error(pageRes.error.message);
    if (statsRes.error) throw new Error(statsRes.error.message);

    const rows = (pageRes.data ?? []) as PageRow[];
    const s = ((statsRes.data ?? [])[0] ?? {}) as Record<string, number | string | null>;
    // THE TOTAL COMES FROM THE STATS ROW, so an empty page still carries a real count rather than
    // reporting zero because there was nothing on page 4.
    const total = Number(s.players ?? 0);

    const { data: fresh } = await supabase
      .from("mdapi_users").select("synced_at").order("synced_at", { ascending: false }).limit(1);
    const syncedAt = ((fresh ?? [])[0] as { synced_at?: string } | undefined)?.synced_at ?? null;

    return Response.json({
      players: rows.map(shape),
      total, page, size, sort, dir,
      // WHAT THE SERVER ACTUALLY APPLIED, not what was asked for. The client lights its controls
      // from this, so a preset overridden by a range cannot stay lit, and a play window suppressed
      // by History = never played is visibly suppressed rather than quietly ignored.
      applied: {
        q: args.p_search, reg: regPreset, regFrom: regFromRaw, regTo: regToRaw,
        hist: history, play: playPreset, playFrom: playFromRaw, playTo: playToRaw,
        playMode: p_play_mode, playSuppressed, member, city: scope ?? null,
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
