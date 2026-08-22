// PLAYER FINDER — every filter, every count and every tile, in SQL.
//
// THE RULE THIS ROUTE EXISTS TO KEEP. A browser that filters the page it happens to hold filters
// 50 rows and reports a confident wrong number for the other 30,195. So nothing here is computed
// from `rows`: the total is a `count: "exact"` with the SAME predicate as the page, each tile is
// its own count query, and the occupancy figures come from an aggregate function. The only thing
// derived from the returned rows is the rows themselves.
//
// IT READS THE VIEWS FROM 0133/0134, not the base tables. `player_finder_rows` is users LEFT JOINed
// to their play history, so "never played" is `plays = 0` rather than a NOT IN over 15,000 ids, and
// the activity filters are a WHERE like every other filter. Doing that aggregate in this route
// instead was measured at 163,981 roster rows and 12.7 seconds; in SQL it is one hash aggregate.
//
// THE TWO WINDOWS ARE SEPARATE AND THAT IS THE POINT. SIGNED UP filters people by `created_at`.
// PLAYED IN filters the MATCHES their spots sit in, by wall clock. "Signed up in August" and
// "played in August" are different questions and one control cannot answer both.
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { assertScope } from "@/lib/cityConfinement";
import { CITY_SCOPES, cityNameFor, resolveCityScope } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** The export walks the whole filtered set; this is the ceiling before it refuses rather than hangs. */
const EXPORT_MAX = 50_000;

type Activity = "any" | "never" | "once" | "active" | "lapsed";
type Member = "any" | "yes" | "no";

const ACTIVITIES = new Set<Activity>(["any", "never", "once", "active", "lapsed"]);
const MEMBERS = new Set<Member>(["any", "yes", "no"]);

const COLS =
  "id, email, first_name, last_name, phone_number, created_at, preferable_city_name, is_member, plays, last_played";

type Row = {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  created_at: string | null;
  preferable_city_name: string | null;
  is_member: boolean | null;
  plays: number | null;
  last_played: string | null;
};

type Filters = {
  q: string | null;
  regFrom: string | null;   // ISO instant, inclusive
  regTo: string | null;     // ISO instant, inclusive
  act: Activity;
  city: string | null;      // the CITY NAME as stored, already scope-checked
  member: Member;
  winFrom: string | null;   // YYYY-MM-DD wall clock, inclusive
  winTo: string | null;     // YYYY-MM-DD wall clock, inclusive
};

/* ── ONE FILTER BUILDER, USED BY THE PAGE AND BY EVERY COUNT ───────────────────────────────────
 * The count above the table and the tiles beside it have to mean the same thing as the rows. Two
 * predicates that drift is how a table shows 5 rows under a heading that says 12. */
/* The PostgREST builder type is not exported in a form that survives a chain of conditional
 * `.eq()/.gte()` calls, and naming it wrongly here would be a type that lies rather than one that
 * helps. It is `any` in exactly two places — this builder and the tile predicates — and nowhere
 * that touches a value. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, "public", "public", any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(q: any, f: Filters): any {
  let out = q;
  // THE SEARCH BLOB IS PRE-LOWERED IN THE VIEW, so this is a plain LIKE on one column rather than
  // an .or() across four that would re-state the escaping rules at every call site.
  if (f.q) out = out.like("search_blob", `%${f.q.toLowerCase()}%`);
  if (f.regFrom) out = out.gte("created_at", f.regFrom);
  if (f.regTo) out = out.lte("created_at", f.regTo);
  if (f.city) out = out.eq("preferable_city_name", f.city);
  if (f.member === "yes") out = out.eq("is_member", true);
  if (f.member === "no") out = out.not("is_member", "is", true);
  if (f.act === "never") out = out.eq("plays", 0);
  if (f.act === "once") out = out.eq("plays", 1);
  if (f.act === "active") out = out.gte("last_played", daysAgo(30));
  if (f.act === "lapsed") out = out.not("last_played", "is", null).lt("last_played", daysAgo(60));
  return out;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

/** A count with the finder's predicate plus whatever extra the tile needs. Never a row fetch. */
async function tally(db: Db, f: Filters, extra: (q: Q) => Q = (q) => q): Promise<number> {
  const base = db.from("player_finder_rows").select("id", { count: "exact", head: true });
  const { count, error } = await extra(applyFilters(base, f));
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;

  const url = new URL(req.url);
  const asked = url.searchParams.get("city");

  /* ── SCOPE IS A BOUNDARY, THE CITY SELECT IS A CONVENIENCE ──────────────────────────────────
   * A confined account's city is taken from the DATABASE ROW, never from the query string, so
   * widening the dropdown client-side reaches nothing. An unconfined account may narrow if it
   * asks; an unknown value is refused rather than quietly widened back to everyone. */
  // THE BOUNDARY, BEFORE ANY QUERY. A confined account naming another city is refused outright —
  // not silently re-pointed at its own, because a silent re-point looks like the feature working.
  const scopeCheck = assertScope(auth.confinedCity, asked === "all" ? null : asked, auth.confinedCity !== null);
  if (!scopeCheck.ok) return Response.json({ error: scopeCheck.error }, { status: scopeCheck.status });

  let scope: string | null = auth.confinedCity;
  if (!scope && asked && asked !== "all") {
    if (!resolveCityScope(asked)) {
      return Response.json({ error: `${JSON.stringify(asked)} is not a known city.` }, { status: 400 });
    }
    scope = asked;
  }

  const act = (url.searchParams.get("act") ?? "any") as Activity;
  const member = (url.searchParams.get("member") ?? "any") as Member;
  if (!ACTIVITIES.has(act)) return Response.json({ error: `unknown activity ${JSON.stringify(act)}` }, { status: 400 });
  if (!MEMBERS.has(member)) return Response.json({ error: `unknown member filter ${JSON.stringify(member)}` }, { status: 400 });

  /* ── SIGNED UP: A PRESET OR A RANGE, NEVER BOTH ─────────────────────────────────────────────
   * Two date filters both lit is a lie about what is being shown, so an explicit from/to wins and
   * the preset is reported back as "all" — the client lights what the server actually applied
   * rather than what the user last clicked. */
  const regFromRaw = url.searchParams.get("regFrom");
  const regToRaw = url.searchParams.get("regTo");
  const hasRange = !!(regFromRaw || regToRaw);
  const preset = hasRange ? "all" : (url.searchParams.get("reg") ?? "all");
  const presetDays = preset === "7" ? 7 : preset === "30" ? 30 : preset === "90" ? 90 : null;

  const regFrom = hasRange
    ? (regFromRaw ? new Date(`${regFromRaw}T00:00:00`).toISOString() : null)
    : presetDays ? daysAgo(presetDays) : null;
  // INCLUSIVE TO THE END OF THE DAY. A `to` of the 21st that stops at midnight silently drops
  // everyone who signed up on the day the operator picked.
  const regTo = hasRange && regToRaw ? new Date(`${regToRaw}T23:59:59.999`).toISOString() : null;

  // PLAYED IN — a month, its own window, read only by the occupancy figures.
  const win = url.searchParams.get("win");
  let winFrom: string | null = null, winTo: string | null = null;
  if (win && /^\d{4}-\d{2}$/.test(win)) {
    const [y, m] = win.split("-").map(Number);
    winFrom = `${win}-01`;
    winTo = `${win}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  }

  const cityName = scope ? cityNameFor(scope) : null;
  const f: Filters = {
    q: (url.searchParams.get("q") ?? "").trim() || null,
    regFrom, regTo, act, member, city: cityName, winFrom, winTo,
  };

  const wantExport = url.searchParams.get("export") === "1";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("size") ?? PAGE_SIZE) || PAGE_SIZE));
  const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  const SORTS: Record<string, string> = {
    id: "id", name: "first_name", email: "email", phone: "phone_number",
    registered: "created_at", city: "preferable_city_name", member: "is_member", last_match: "last_played",
  };
  const sortKey = url.searchParams.get("sort") ?? "registered";
  const col = SORTS[sortKey] ?? "created_at";

  try {
    // ── THE PAGE, AND THE COUNT THAT DESCRIBES IT ─────────────────────────────────────────────
    const { data, count, error } = await applyFilters(
      supabase.from("player_finder_rows").select(COLS, { count: "exact" }),
      f,
    ).order(col, { ascending: dir === "asc", nullsFirst: false })
      .order("id", { ascending: true })   // a stable tiebreak: without one, paging repeats rows
      .range((page - 1) * size, (page - 1) * size + size - 1);
    if (error) throw new Error(error.message);
    const total = count ?? 0;

    /* ── EXPORT WALKS THE WHOLE FILTERED SET ───────────────────────────────────────────────────
     * Exporting the hundred rows already on screen is useless for outreach, which is the entire
     * point of the feature. Paged, ordered, and capped so a runaway request refuses instead of
     * hanging. */
    if (wantExport) {
      if (total > EXPORT_MAX) {
        return Response.json({ error: `${total.toLocaleString()} rows is above the ${EXPORT_MAX.toLocaleString()} export ceiling — narrow the filters.` }, { status: 413 });
      }
      const all: Row[] = [];
      for (let from = 0; from < total; from += 1000) {
        const { data: chunk, error: e2 } = await applyFilters(
          supabase.from("player_finder_rows").select(COLS), f,
        ).order(col, { ascending: dir === "asc", nullsFirst: false })
          .order("id", { ascending: true })
          .range(from, from + 999);
        if (e2) throw new Error(e2.message);
        all.push(...((chunk ?? []) as unknown as Row[]));
        if ((chunk ?? []).length < 1000) break;
      }
      return Response.json({ players: all.map(shape), total, exported: all.length });
    }

    // ── THE TILES — EVERY ONE ITS OWN COUNT ───────────────────────────────────────────────────
    // Run together: they are independent head-counts and the page waits for the slowest, not the
    // sum. A city tile is not even asked for when a city filter is on, because it would be dropped.
    const cityTilesWanted = !cityName;
    const [never, members, wk, mo, heavy, named, occ, cityCounts, medianAge, newest] = await Promise.all([
      tally(supabase, f, (q: Q) => q.eq("plays", 0)),
      tally(supabase, f, (q: Q) => q.eq("is_member", true)),
      tally(supabase, f, (q: Q) => q.gte("created_at", daysAgo(7))),
      tally(supabase, f, (q: Q) => q.gte("created_at", daysAgo(30))),
      tally(supabase, f, (q: Q) => q.gte("plays", 2)),
      tally(supabase, f, (q: Q) => q.not("first_name", "is", null).neq("first_name", "")),
      occupancy(supabase, f),
      cityTilesWanted ? cityBreakdown(supabase, f) : Promise.resolve<[string, number][]>([]),
      median(supabase, f, total),
      newestSignup(supabase, f),
    ]);

    const players = ((data ?? []) as unknown as Row[]).map(shape);

    // The mirror's own clock — a signup from an hour ago is not here yet, and somebody watching a
    // city launch would read that as a broken filter.
    const { data: fresh } = await supabase
      .from("mdapi_users").select("synced_at").order("synced_at", { ascending: false }).limit(1);
    const syncedAt = ((fresh ?? [])[0] as { synced_at?: string } | undefined)?.synced_at ?? null;

    return Response.json({
      players, total, page, size, sort: sortKey, dir,
      // WHAT THE SERVER ACTUALLY APPLIED, not what was asked for — the client lights its controls
      // from this, so a preset overridden by a date range cannot stay lit.
      applied: { q: f.q, reg: preset, regFrom: regFromRaw, regTo: regToRaw, act, member, win: win ?? null, city: scope ?? null },
      stats: {
        players: total, never, members, week: wk, month30: mo, heavy, named,
        cities: cityCounts.length,
        topCity: cityCounts[0] ? { name: cityCounts[0][0], n: cityCounts[0][1] } : null,
        medianAgeDays: medianAge, newest,
        spots: occ.spots, matches: occ.matches, matchesFull: occ.matches_full, capacity: occ.capacity,
      },
      scope: scope ?? null, scopeName: cityName, confined: !!auth.confinedCity,
      syncedAt,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

function shape(r: Row) {
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

/** The occupancy aggregate — a match-grain answer about a player-grain selection. */
async function occupancy(db: Db, f: Filters) {
  const { data, error } = await db.rpc("player_finder_occupancy", {
    p_search: f.q, p_reg_from: f.regFrom, p_reg_to: f.regTo,
    p_activity: f.act, p_city: f.city, p_member: f.member,
    p_win_from: f.winFrom, p_win_to: f.winTo,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as { spots?: number; matches?: number; matches_full?: number; capacity?: number } | undefined;
  return {
    spots: Number(row?.spots ?? 0), matches: Number(row?.matches ?? 0),
    matches_full: Number(row?.matches_full ?? 0), capacity: Number(row?.capacity ?? 0),
  };
}

/* CITY COUNTS, ONE HEAD-COUNT EACH. There are eleven distinct values in 30,245 rows, so eleven
 * counts is cheaper than any GROUP BY workaround and it uses the same predicate as everything
 * else. Not asked for at all when a city filter is on — that tile is dropped anyway. */
/* SOURCED FROM THE SCOPE ALLOWLIST, not typed out again — CITY_SCOPES is the single place a city
 * identifier is mapped to its name, and a second spelling here is exactly how a filter silently
 * returns nothing.
 *
 * PLUS TWO THE DATA HOLDS THAT THE ALLOWLIST DOES NOT: "New York City" (350 signups) and
 * "El Paso" (83). They are real preferred-city values with no city scope, so they can be COUNTED
 * in the Cities and Top city tiles but cannot be FILTERED to — filtering is the security boundary
 * and it only ever accepts an allowlisted identifier. Leaving them out would make "Cities" read 8
 * when it is 10, which is a wrong number rather than a restriction. */
const KNOWN_CITIES = [...CITY_SCOPES.map((c) => c.name), "New York City", "El Paso"];
async function cityBreakdown(db: Db, f: Filters): Promise<[string, number][]> {
  const counts = await Promise.all(
    KNOWN_CITIES.map(async (c) => [c, await tally(db, f, (q: Q) => q.eq("preferable_city_name", c))] as [string, number]),
  );
  return counts.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
}

/** The median signup age, by asking SQL for the middle row rather than sorting 30,245 in Node. */
async function median(db: Db, f: Filters, total: number): Promise<number | null> {
  if (total === 0) return null;
  const mid = Math.floor(total / 2);
  const { data, error } = await applyFilters(db.from("player_finder_rows").select("created_at"), f)
    .order("created_at", { ascending: false }).order("id", { ascending: true }).range(mid, mid);
  if (error) throw new Error(error.message);
  const iso = ((data ?? [])[0] as { created_at?: string } | undefined)?.created_at;
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400_000));
}

async function newestSignup(db: Db, f: Filters): Promise<string | null> {
  const { data, error } = await applyFilters(db.from("player_finder_rows").select("created_at"), f)
    .order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null;
}
