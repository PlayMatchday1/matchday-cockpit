// Phase 29 Part B — reviews, SCOPED ON THE SERVER.
//
// WHY THIS EXISTS. Every review surface today calls useReviewData, which paginates the WHOLE of
// mdapi_reviews into the browser (~23k rows) and filters in JavaScript. Scoping a city manager
// that way would mean shipping every city's reviews — names, emails, comments — to their machine
// and hiding most of them with a filter. That is a data leak wearing a filter, and it is the
// reason a city manager has had no Reviews page at all rather than a badly-scoped one.
//
// THE SCOPE COMES FROM THE SESSION, NEVER FROM THE REQUEST. city_identifier is read fresh from the
// caller's app_users row on every request — no JWT caching, so a revoke takes effect on the next
// call. A city manager who passes ?city=HOU while scoped to DFW is REFUSED (403): not silently
// given DFW, and certainly not given HOU. A silent fallback would teach nobody that they tried.
//
// The filter is pushed into the QUERY (`.in("city_name", …)`), never applied after fetching, and
// every derived figure the page shows is computed from the scoped rows. A count computed before
// scoping is a leak of a different shape — it tells you how many reviews the other cities have.

import { resolveSessionUser } from "@/lib/adminAuth";
import { can } from "@/lib/capabilities";
import { cityManagerGate } from "@/lib/cityManagerAuth";
import { confinedCity, isConfined, assertConfinedScope } from "@/lib/cityConfinement";
import { adminGate } from "@/lib/adminAuth";
import { CITY_SCOPES, resolveCityScope, cityNameFor } from "@/lib/cityScope";
import { CITY_ABBR_TO_COCKPIT, CSV_TO_COCKPIT_CITY } from "@/lib/cityMap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// mdapi_reviews stores city_name (the platform's label, e.g. "Dallas / Fort Worth"), while the
// scope is a city_identifier (DFW). Both maps already exist and disagree about the display name
// ("Dallas / Fort Worth" → cockpit "Dallas"), so the join goes through them rather than guessing:
//   identifier → cockpit city → every raw city_name that normalises to it.
// Returning the RAW names lets the filter be pushed into SQL instead of applied in memory.
export function rawCityNamesFor(identifier: string): string[] {
  const cockpit = CITY_ABBR_TO_COCKPIT[identifier];
  if (cockpit) {
    return Object.entries(CSV_TO_COCKPIT_CITY).filter(([, v]) => v === cockpit).map(([k]) => k);
  }
  // FALLBACK TO THE ONE AUTHORITATIVE PAIR LIST. cityMap's two maps predate cityScope and do not
  // know WAW; adding it there would be a SECOND place the identifier↔name mapping lives, and two
  // copies of a mapping is how a filter silently starts returning nothing. cityScope.ts is where
  // WAW ↔ "Warsaw" is written, so an identifier this map has never heard of asks that list instead
  // of returning [] — which would filter on an empty set and look exactly like "no reviews".
  const name = cityNameFor(identifier);
  return name ? [name] : [];
}

const SELECT =
  "api_id, city_name, field_title, manager_first_name, manager_last_name, star_rating, start_date, user_id, updated_at_rating, comment, user_first_name, user_last_name, user_email, tags_rating";

export async function GET(req: Request) {
  const sess = await resolveSessionUser(req);
  if (!sess.ok) return Response.json({ error: sess.error }, { status: sess.status });

  // THE CHECKBOX DECIDES. This required Admin OR the city tier and never looked at Match Ops, so a
  // Match Ops holder was refused a page that lives inside Match Ops. isAdmin is still computed —
  // it decides SCOPE below (all cities vs one), which is a different question from access.
  // THE BOUNDARY IS EVALUATED BEFORE THE ADMIN TERM, and beats it: a confined admin is scoped,
  // not unscoped. See cityConfinement.ts for why this disagrees with the city-manager tier.
  const boundCity = confinedCity(sess.row);
  const isAdmin = boundCity === null && adminGate(sess.row).ok;
  const cm = cityManagerGate(sess.row, sess.email);
  if (!can(sess.row, "matchops", sess.email) && !cm.ok) {
    return Response.json({ error: "Reviews needs Match Ops access. Ask an admin to tick it on the User access screen." }, { status: 403 });
  }

  const asked = new URL(req.url).searchParams.get("city");

  // A CONFINED ACCOUNT MAY NAME ITS OWN CITY AND NOTHING ELSE. Hiding the city control does not
  // stop a request; this is what turns ?city=ATX into a 403 instead of Austin's reviews.
  if (isConfined(sess.row)) {
    const scopeCheck = assertConfinedScope(sess.row, asked === "all" ? null : asked);
    if (!scopeCheck.ok) return Response.json({ error: scopeCheck.error }, { status: scopeCheck.status });
  }

  // ── THE SCOPE DECISION ────────────────────────────────────────────────────────────────────────
  let scopeIdentifier: string | null;   // null = all cities (admin only)
  if (isAdmin) {
    // An admin gets everything, or ONE city when they ask for it. An unknown value is refused
    // rather than quietly widened back to everything — asking for a city you cannot name is a
    // mistake worth surfacing.
    if (asked != null && asked !== "" && asked !== "all") {
      if (!resolveCityScope(asked)) {
        return Response.json({ error: `${JSON.stringify(asked)} is not a known city.` }, { status: 400 });
      }
      scopeIdentifier = asked;
    } else {
      scopeIdentifier = null;
    }
  } else {
    // A CITY MANAGER IS PINNED TO THEIR OWN CITY. The session decides; the query string may only
    // agree with it. Anything else is refused — this is the attack the whole endpoint exists for.
    // The boundary outranks the city-manager scope; both are session-derived, never request-derived.
    scopeIdentifier = boundCity ?? (cm.ok ? cm.cityIdentifier : null);
    if (asked != null && asked !== "" && asked !== scopeIdentifier) {
      return Response.json({
        error: `You are scoped to ${scopeIdentifier}. This account cannot read ${JSON.stringify(asked)}.`,
        scope: scopeIdentifier,
      }, { status: 403 });
    }
  }

  // ── THE QUERY, filtered in SQL ───────────────────────────────────────────────────────────────
  let q = sess.supabase.from("mdapi_reviews").select(SELECT)
    .order("start_date", { ascending: true })
    .order("api_id", { ascending: true });
  if (scopeIdentifier) {
    const names = rawCityNamesFor(scopeIdentifier);
    // A scope that maps to no city_name must return NOTHING, never everything. `.in` with an empty
    // array is the correct expression of that, and is stated here so nobody "fixes" it later.
    q = q.in("city_name", names);
  }

  // Paginated, but SERVER-side, and only over rows this caller may see.
  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    rows.push(...(data ?? []) as Row[]);
    if (!data || data.length < PAGE) break;
  }

  // ── EVERY DERIVED FIGURE IS COMPUTED FROM THE SCOPED SET ─────────────────────────────────────
  const rated = rows.filter((r) => r.star_rating != null);
  const withComment = rated.filter((r) => typeof r.comment === "string" && (r.comment as string).trim() !== "");
  const sum = rated.reduce((s, r) => s + Number(r.star_rating ?? 0), 0);
  const byCity = new Map<string, { count: number; stars: number }>();
  for (const r of rated) {
    const c = String(r.city_name ?? "—");
    const g = byCity.get(c) ?? { count: 0, stars: 0 };
    g.count++; g.stars += Number(r.star_rating ?? 0);
    byCity.set(c, g);
  }

  return Response.json({
    scope: scopeIdentifier,                       // null = all cities
    scopeName: scopeIdentifier ? CITY_SCOPES.find((c) => c.identifier === scopeIdentifier)?.name ?? null : null,
    isAdmin,
    rows,
    counts: {
      total: rows.length,
      rated: rated.length,
      withComment: withComment.length,
      withoutComment: rated.length - withComment.length,
      averageStars: rated.length ? Math.round((sum / rated.length) * 100) / 100 : null,
      // the leaderboard, from the scoped set — a city manager's contains exactly one city
      byCity: [...byCity.entries()].map(([city, g]) => ({ city, count: g.count, averageStars: Math.round((g.stars / g.count) * 100) / 100 }))
        .sort((a, b) => b.count - a.count),
    },
  });
}
