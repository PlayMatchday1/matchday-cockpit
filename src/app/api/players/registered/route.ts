// REGISTERED PLAYERS — the list under Player Lookup's search box.
//
// WHY THE MIRROR AND NOT THE API. GET /admin/players lists everyone (30,449) and pages and sorts,
// but it REFUSES every city parameter — ?cityId, ?cityIdentifier and ?city each come back
// 400 "property should not exist". Scoping it would mean paging all 30,449 rows on every request
// and filtering locally, which is not a source, it is a workaround. mdapi_users carries every
// column this table needs except last-match, and mdapi_match_players joins to mdapi_matches for
// the city rule AND the date. So the filter is a real WHERE, the count is a real count, and a
// page is two queries.
//
// THE COST OF THE MIRROR IS STALENESS, and the page says so out loud: 30,387 mirrored against
// 30,449 live when this was built. A registration from an hour ago is not here yet, and somebody
// watching a city launch will read that as a broken filter rather than a stale table unless the
// last sync time is on screen.
//
// THE UNION. This is a REGISTRATION list first: preferable_city_name is what the player chose at
// signup, and it answers "how many registered this week". The roster half exists so nobody is
// missed — a player who turned up to a Warsaw match without changing their profile is a Warsaw
// player whatever their settings say. Deduped by id, and which half matched is a COLUMN, because
// "3 players" hides that it is 1 registration and 2 walk-ins.
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { assertScope } from "@/lib/cityConfinement";
import { cityNameFor, resolveCityScope } from "@/lib/cityScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/* THE SCOPED PATH HAS A CEILING, AND IT REFUSES RATHER THAN MELTS.
 *
 * The roster half of the union has to go match-by-match: mdapi_match_players has NO foreign key to
 * mdapi_matches, so PostgREST cannot embed the join ("Could not find a relationship"), and without
 * DDL there is no way to add one from here. So the route enumerates the city's matches and looks
 * up rosters in chunks — fine for a new city, hopeless for an old one. Austin has 6,614 matches and
 * ~130,000 roster rows; that attempt returned a 500 with an empty message, which is the worst of
 * both worlds: no data and no reason.
 *
 * ABOVE THIS LINE THE ROUTE SAYS SO. A refusal that names the limit is recoverable — somebody adds
 * the FK, or an RPC, and lifts it. A timeout is not. Warsaw is 3 matches; every city that needs
 * this today is far below the ceiling, and the day one is not, the message says exactly what to fix.
 */
const MAX_SCOPE_MATCHES = 400;

type SortKey = "id" | "name" | "email" | "phone" | "registered" | "last_match" | "member" | "basis";
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
  const scopeCheck = assertScope(auth.confinedCity, asked === "all" ? null : asked, auth.confinedCity !== null);
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

    // ── THE ID SET, WHEN SCOPED ────────────────────────────────────────────────────────────────
    // Two in-query filters, unioned by id. Only IDs are fetched here, never rows — the page's rows
    // are fetched once the order and offset are known, so this stays cheap even for a large city.
    let registeredIds: Set<number> | null = null;
    let rosterIds: Set<number> | null = null;
    if (scope) {
      const cityName = cityNameFor(scope);
      const regRows = await pageAll<{ id: number }>((f, t) =>
        supabase
          .from("mdapi_users")
          .select("id")
          .eq("preferable_city_name", cityName ?? " ")
          .neq("is_fake_player", true)
          .range(f, t),
      );
      registeredIds = new Set(regRows.map((r) => Number(r.id)));

      const matchRows = await pageAll<{ api_id: number }>((f, t) =>
        supabase.from("mdapi_matches").select("api_id").eq("city_identifier", scope).range(f, t),
      );
      const matchIds = matchRows.map((r) => Number(r.api_id));
      if (matchIds.length > MAX_SCOPE_MATCHES) {
        return Response.json({
          error:
            `${cityNameFor(scope) ?? scope} has ${matchIds.length.toLocaleString()} matches, over the ` +
            `${MAX_SCOPE_MATCHES} this list can walk. The roster half of the union needs a match-by-match ` +
            `lookup because mdapi_match_players has no foreign key to mdapi_matches, so PostgREST cannot ` +
            `join them. Lifting this needs that key (or an RPC), not a bigger number here.`,
        }, { status: 501 });
      }
      rosterIds = new Set<number>();
      // .in() over a large id list would blow the URL, so the roster lookup is chunked.
      for (let i = 0; i < matchIds.length; i += 200) {
        const chunk = matchIds.slice(i, i + 200);
        if (chunk.length === 0) continue;
        const rp = await pageAll<{ user_id: number }>((f, t) =>
          supabase
            .from("mdapi_match_players")
            .select("user_id")
            .in("match_api_id", chunk)
            .neq("user_is_fake_player", true)
            .range(f, t),
        );
        for (const r of rp) if (r.user_id != null) rosterIds.add(Number(r.user_id));
      }
    }

    let rows: UserRow[] = [];
    let total = 0;
    const basisCounts = { registered: 0, roster: 0, both: 0 };

    if (scope) {
      const union = new Set<number>([...(registeredIds ?? []), ...(rosterIds ?? [])]);
      // A SCOPED SET IS SMALL ENOUGH TO ORDER WHOLE, so every column — including the two computed
      // ones — sorts across the entire result rather than within a page.
      const ids = [...union];
      const all: UserRow[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        if (chunk.length === 0) continue;
        const { data, error } = await supabase.from("mdapi_users").select(COLS).in("id", chunk);
        if (error) throw new Error(error.message);
        all.push(...((data ?? []) as unknown as UserRow[]));
      }
      rows = all;

      /* THE COUNT IS THE ROWS THAT RESOLVED, NOT THE IDS THAT MATCHED.
       *
       * A roster carries user_ids that mdapi_users does not always have — measured on WAW: 13
       * distinct roster user_ids, 12 of them present in the users mirror. Counting the id set
       * would print "13 players" above a table that can only ever show 12, which is the same
       * class of leak as a total that counts rows the viewer cannot see: a number nobody can
       * reconcile against what is on screen.
       *
       * The basis split is counted off the SAME resolved rows, so the three figures always add up
       * to the total printed beside them. */
      total = rows.length;
      for (const r of rows) {
        const reg = registeredIds?.has(Number(r.id)) === true;
        const ros = rosterIds?.has(Number(r.id)) === true;
        if (reg && ros) basisCounts.both++;
        else if (reg) basisCounts.registered++;
        else basisCounts.roster++;
      }
    } else {
      // UNSCOPED IS 30,179 ROWS, so the order and the offset go into the query. The two computed
      // columns cannot be ordered in SQL here; asking for them falls back to registration order
      // and the response says so rather than returning a page sorted by something else.
      const col = DB_SORT[sort] ?? "created_at";
      const { count, error: cErr } = await supabase
        .from("mdapi_users")
        .select("id", { count: "exact", head: true })
        .neq("is_fake_player", true);
      if (cErr) throw new Error(cErr.message);
      total = count ?? 0;
      const from = (page - 1) * size;
      const { data, error } = await supabase
        .from("mdapi_users")
        .select(COLS)
        .neq("is_fake_player", true)
        .order(col, { ascending: dir === "asc" })
        .range(from, from + size - 1);
      if (error) throw new Error(error.message);
      rows = (data ?? []) as unknown as UserRow[];
    }

    // ── LAST MATCH PLAYED — one query for the page, never one per player ────────────────────────
    // PLAYED means a start_date in the PAST. Warsaw's three matches are all in the future, so every
    // Warsaw row reads a dash today. That is the honest answer; showing the next match instead
    // would fill the column with dates that mean the opposite of what the header says.
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
        const { data } = await supabase
          .from("mdapi_matches")
          .select("api_id, start_date")
          .in("api_id", chunk)
          .lt("start_date", nowIso);
        for (const m of (data ?? []) as { api_id: number; start_date: string }[]) {
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

    const basisOf = (id: number): "registered" | "roster" | "both" | null => {
      if (!scope) return null;
      const r = registeredIds?.has(id) === true;
      const o = rosterIds?.has(id) === true;
      return r && o ? "both" : r ? "registered" : "roster";
    };

    let out = rows.map((r) => ({
      id: Number(r.id),
      name: [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null,
      email: r.email ?? null,
      phone: r.phone_number ?? null,
      registered: r.created_at ?? null,
      last_match: lastPlayed.get(Number(r.id)) ?? null,
      member: r.is_member === true,
      city: r.preferable_city_name ?? null,
      basis: basisOf(Number(r.id)),
    }));

    let sortNote: string | null = null;
    if (scope) {
      const s = (x: string | null) => (x ?? "").toLowerCase();
      const cmp = (a: (typeof out)[number], b: (typeof out)[number]): number => {
        switch (sort) {
          case "id":
            return a.id - b.id;
          case "name":
            return s(a.name).localeCompare(s(b.name));
          case "email":
            return s(a.email).localeCompare(s(b.email));
          case "phone":
            return s(a.phone).localeCompare(s(b.phone));
          case "member":
            return Number(a.member) - Number(b.member);
          case "basis":
            return s(a.basis).localeCompare(s(b.basis));
          // NULLS LAST in both directions — a player who has never played is not "earliest".
          case "last_match": {
            if (!a.last_match && !b.last_match) return 0;
            if (!a.last_match) return 1;
            if (!b.last_match) return -1;
            return a.last_match < b.last_match ? -1 : 1;
          }
          default:
            return s(a.registered) < s(b.registered) ? -1 : s(a.registered) > s(b.registered) ? 1 : 0;
        }
      };
      const nullsLast = sort === "last_match";
      out.sort((a, b) => {
        const c = cmp(a, b);
        if (nullsLast && (!a.last_match || !b.last_match)) return c;
        return dir === "asc" ? c : -c;
      });
      const from = (page - 1) * size;
      out = out.slice(from, from + size);
    } else if (sort === "last_match" || sort === "basis") {
      sortNote = `${sort} cannot be ordered across all cities — showing newest registration first.`;
    }

    // ── THE MIRROR'S OWN CLOCK ─────────────────────────────────────────────────────────────────
    const { data: fresh } = await supabase
      .from("mdapi_users")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1);
    const syncedAt = ((fresh ?? [])[0] as { synced_at?: string } | undefined)?.synced_at ?? null;

    return Response.json({
      players: out,
      total,
      page,
      size,
      sort,
      dir,
      sortNote,
      scope: scope ?? null,
      scopeName: scope ? cityNameFor(scope) : null,
      basisCounts: scope ? basisCounts : null,
      syncedAt,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
