// REGISTERED PLAYERS — the list under Player Lookup's search box.
//
// ONE RULE: mdapi_users where preferable_city_name is the account's city. These are SIGNUPS —
// people we can approach — which is the whole point of the table.
//
// THE ROSTER UNION IS GONE, and the counts say why: it added 11 rows to Warsaw's 1 and every one
// of them was a placeholder — Guest 1-7, NYCSC x3, Manager, all on 5555555555, all registered to
// Atlanta or New York, all sitting on Warsaw rosters because somebody put them there to fill a
// match. Warsaw is 1 real signup. A one-row table in a city that is three days old is the right
// answer, and it will grow.
//
// AND WITH THE ROSTER HALF GONE THERE IS NO SCALING LIMIT. The union needed a match-by-match walk,
// because mdapi_match_players has no foreign key to mdapi_matches and PostgREST cannot embed the
// join; that walk capped the feature at 400 matches and returned a 501 above it, which meant it
// worked for Warsaw and nowhere else. This is a single .eq() with SQL paging, so Austin (12,477
// signups), Houston (5,750) and San Antonio (3,317) work exactly as Warsaw does.
//
// WHY THE MIRROR AND NOT THE API. GET /admin/players lists everyone and pages and sorts, but it
// REFUSES every city parameter — ?cityId, ?cityIdentifier and ?city each come back 400 "property
// should not exist". Scoping it would mean paging all 30,449 rows on every request and filtering
// locally, which is not a source. mdapi_users carries every column but last-match, and the filter
// is a real WHERE, so the count is a real count.
//
// THE COST OF THE MIRROR IS STALENESS, and the page says so out loud — a registration from an hour
// ago is not here yet, and somebody watching a city launch would read that as a broken filter.
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { assertScope } from "@/lib/cityConfinement";
import { cityNameFor, resolveCityScope } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type SortKey = "id" | "name" | "email" | "phone" | "registered" | "last_match" | "member";

/**
 * Every sortable column except last_match maps to a real column, so the ORDER BY and the OFFSET
 * both go into SQL and a page is a page whatever the city's size.
 */
const DB_SORT: Partial<Record<SortKey, string>> = {
  id: "id",
  name: "first_name",
  email: "email",
  phone: "phone_number",
  registered: "created_at",
  member: "is_member",
};

type PgResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Page every row of a PostgREST query — it caps at 1,000 and an unpaged read truncates silently. */
async function pageAll<T>(mk: (from: number, to: number) => PgResult<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await mk(from, from + 999);
    if (error) throw new Error(String((error as { message?: string }).message ?? error));
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

type UserRow = {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  created_at: string | null;
  preferable_city_name: string | null;
  is_member: boolean | null;
};

const COLS =
  "id, email, first_name, last_name, phone_number, created_at, preferable_city_name, is_member";

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;

  const url = new URL(req.url);
  const asked = url.searchParams.get("city");

  // THE BOUNDARY, BEFORE ANY QUERY. A confined account naming another city is refused outright —
  // not silently re-pointed at its own, because a silent re-point teaches nothing and looks like
  // the feature working.
  const scopeCheck = assertScope(
    auth.confinedCity,
    asked === "all" ? null : asked,
    auth.confinedCity !== null,
  );
  if (!scopeCheck.ok) {
    return Response.json({ error: scopeCheck.error }, { status: scopeCheck.status });
  }

  // An UNCONFINED account may narrow to a city if it asks; an unknown value is refused rather than
  // quietly widened back to everyone.
  let scope: string | null = auth.confinedCity;
  if (!scope && asked && asked !== "all") {
    if (!resolveCityScope(asked)) {
      return Response.json({ error: `${JSON.stringify(asked)} is not a known city.` }, { status: 400 });
    }
    scope = asked;
  }

  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(url.searchParams.get("size") ?? PAGE_SIZE) || PAGE_SIZE),
  );
  const sort = (url.searchParams.get("sort") ?? "registered") as SortKey;
  const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";

  try {
    const nowIso = new Date().toISOString();
    const cityName = scope ? cityNameFor(scope) : null;

    // ── THE FILTER, THE COUNT AND THE PAGE — all three in SQL ──────────────────────────────────
    // The count is taken with the SAME predicate as the rows, so the number above the table is the
    // number of rows the account can actually reach. A total counting people they cannot see is a
    // leak that shows a figure instead of a row.
    const col = DB_SORT[sort] ?? "created_at";
    const from = (page - 1) * size;
    let q = supabase
      .from("mdapi_users")
      .select(COLS, { count: "exact" })
      .neq("is_fake_player", true);
    if (cityName) q = q.eq("preferable_city_name", cityName);
    const { data, count, error } = await q
      .order(col, { ascending: dir === "asc" })
      .range(from, from + size - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as UserRow[];
    const total = count ?? 0;

    // ── LAST MATCH PLAYED — one query for the page, never one per player ────────────────────────
    // PLAYED means a start_date in the PAST: it answers "has this signup ever actually turned up",
    // which is what you want to know before approaching them. Warsaw's three matches are all in
    // the future, so its rows read a dash — showing the next match instead would fill the column
    // with dates meaning the opposite of the header.
    const pageIds = rows.map((r) => Number(r.id));
    const lastPlayed = new Map<number, string>();
    if (pageIds.length > 0) {
      const mp = await pageAll<{ user_id: number; match_api_id: number }>((f, t) =>
        supabase
          .from("mdapi_match_players")
          .select("user_id, match_api_id")
          .in("user_id", pageIds)
          .range(f, t),
      );
      const matchIds = [...new Set(mp.map((r) => Number(r.match_api_id)))];
      const dateOf = new Map<number, string>();
      for (let i = 0; i < matchIds.length; i += 300) {
        const chunk = matchIds.slice(i, i + 300);
        if (chunk.length === 0) continue;
        const { data: ms } = await supabase
          .from("mdapi_matches")
          .select("api_id, start_date")
          .in("api_id", chunk)
          .lt("start_date", nowIso);
        for (const m of (ms ?? []) as { api_id: number; start_date: string }[]) {
          dateOf.set(Number(m.api_id), m.start_date);
        }
      }
      for (const r of mp) {
        const d = dateOf.get(Number(r.match_api_id));
        if (!d) continue;
        const prev = lastPlayed.get(Number(r.user_id));
        if (!prev || d > prev) lastPlayed.set(Number(r.user_id), d);
      }
    }

    const players = rows.map((r) => ({
      id: Number(r.id),
      name: [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null,
      email: r.email ?? null,
      phone: r.phone_number ?? null,
      registered: r.created_at ?? null,
      last_match: lastPlayed.get(Number(r.id)) ?? null,
      member: r.is_member === true,
      city: r.preferable_city_name ?? null,
    }));

    // LAST MATCH IS THE ONE COLUMN SQL CANNOT ORDER — it is derived from two other tables. Sorting
    // it would mean resolving it for every row in the city, not just the page, which is the kind
    // of walk this route just got rid of. So the request is answered in registration order and the
    // response SAYS SO rather than returning a page sorted by something the caller did not ask for.
    const sortNote =
      sort === "last_match"
        ? "Last match is derived from the match mirror and cannot be ordered in the query — showing newest registration first."
        : null;

    // ── THE MIRROR'S OWN CLOCK ─────────────────────────────────────────────────────────────────
    const { data: fresh } = await supabase
      .from("mdapi_users")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1);
    const syncedAt = ((fresh ?? [])[0] as { synced_at?: string } | undefined)?.synced_at ?? null;

    return Response.json({
      players,
      total,
      page,
      size,
      sort,
      dir,
      sortNote,
      scope: scope ?? null,
      scopeName: cityName,
      syncedAt,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
