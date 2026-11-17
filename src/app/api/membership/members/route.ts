// THE MEMBERS PAGE — list, search, CSV and city settings, all reads.
//
//   GET ?env=production|staging&city=ATX&tab=current&page=1      one page of one tab, with counts
//   city=ALL                                                      every city together (not for a confined account)
//   GET ?env=…&q=garcia&city=ATX                                  search: EVERY city, EVERY status
//   GET ?env=…&city=ATX&tab=current&format=csv                    the current filter, every page
//   …&sort=since|member|phone|duration|price|next|paid|strikes&dir=asc|desc   on every mode, every page
//
// THE GATE IS THE MEMBERSHIP CAPABILITY, the same one /api/membership uses: anyone who can open the
// Membership section can read members. Writes are separate routes with their own grants.
//
// SEARCH NEVER REACHES MATCHDAY. It runs in memory over rows this route already loaded (production:
// our mirror, read with a fixed query; the search text is never part of any query, SQL or HTTP). MatchDay's list endpoint pastes `email` into raw SQL (subscriptions.repository.ts:53-54
// at backend 8965437), so the search text is never sent to it — not on production, not on staging.
//
// A CONFINED ACCOUNT sees its own city only: one pill, no "All cities", and search is narrowed to that
// city. Frame 6 says "every city"; confinement wins over the design.
//
// CITY PILLS (Ryan, 2026-11-16): the list response carries `pills` (cityPills), each count the city's
// Current tab count. A city is valid when it is in CITY_SCOPES or is a MatchDay city in cityMap
// (Philadelphia). NYC and WAW members are in no pill and not in All cities (Ryan, 2026-11-17); the
// Warsaw operator, confined to WAW, still sees their own city as before. With city=ALL there are no city settings to read: the member price and strike fine are
// per city, and reading every city's would be eight MatchDay calls a load. So in All cities prices show
// in whole dollars with no Custom price chip, and the MEMBERS card counts every city.
import { authenticateCapability } from "@/lib/capabilityAuth";
import { assertScope } from "@/lib/cityConfinement";
import { resolveCityScope, cityNameFor } from "@/lib/cityScope";
import { makeServerClient } from "@/lib/supabaseServer";
import { countActiveMembers } from "@/lib/membershipStats";
import { cityFromAbbr } from "@/lib/cityMap";
import { loadMemberRows, loadAllRowStripe, loadPaidSinceStart, readCitySettings } from "@/lib/membersPageData";
import {
  ALL_CITIES, cityPills, memberCityName, TABS, tabCounts, tabRows, pageOf, searchMembers, searchSummary, membersCsv, rowView, sortRows, defaultSort, isSortKey,
  type Tab, type MemberRow, type RowStripe, type Sort,
} from "@/lib/membersPageModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const isEnv = (x: string | null): x is "production" | "staging" => x === "production" || x === "staging";
const isTab = (x: string | null): x is Tab => TABS.some((t) => t.tab === x);

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "membership");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const env = url.searchParams.get("env");
  if (!isEnv(env)) return Response.json({ error: "env must be production or staging" }, { status: 400 });

  const confined = auth.confinedCity;
  const askedCity = url.searchParams.get("city");
  const sc = assertScope(confined, askedCity, confined !== null);
  if (!sc.ok) return Response.json({ error: sc.error }, { status: sc.status });
  const asked = (askedCity ?? "").trim();

  const sb = makeServerClient();
  const now = Date.now();
  try {
    const fresh = url.searchParams.get("fresh") === "1";
    const [{ rows: all, syncedAt, source }, stripe, paid] = await Promise.all([
      // A refresh after an edit re-reads the rows and Stripe facts; no edit here changes what was paid.
      loadMemberRows(env, sb, fresh), loadAllRowStripe(sb, env, fresh), loadPaidSinceStart(sb, env),
    ]);
    // MatchDay cities only, for the pills and All cities. Search still covers every row.
    const mdRows = all.filter((r) => cityFromAbbr(r.city) != null);
    const city = confined ?? (asked === ALL_CITIES || !asked ? ALL_CITIES
      : resolveCityScope(asked)?.identifier ?? (cityFromAbbr(asked) != null ? asked : null));
    if (!city) return Response.json({ error: "Pick a city." }, { status: 400 });
    const isAll = city === ALL_CITIES;
    const nameOf = (id: string) => memberCityName(id, cityNameFor);
    const settings = url.searchParams.get("settings") === "0" || isAll ? null : await readCitySettings(env, city);
    const planCents = settings?.planCents ?? null;

    /* Every row of the tab (or the search) is viewed and sorted here, then paged, so a sort or a search
     * covers every page. A paid figure is 0 for a production membership with no invoice, null on staging. */
    const view = (rows: readonly MemberRow[], st: Map<number, RowStripe>, plan: (c: string) => number | null) =>
      rows.map((r) => ({
        ...r,
        ...rowView(r, st.get(r.membershipId), paid ? paid.get(r.membershipId) ?? 0 : null, now, plan(r.city)),
        cityName: nameOf(r.city),
      }));
    const sk = url.searchParams.get("sort"), sd = url.searchParams.get("dir");
    const askedSort: Sort | null = isSortKey(sk) ? { key: sk, dir: sd === "desc" ? "desc" : "asc" } : null;
    const csvOut = (rows: ReturnType<typeof view>, name: string) => new Response(membersCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });

    /* ── SEARCH ───────────────────────────────────────────────────────────────────────────── */
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q) {
      const pool = confined ? all.filter((r) => r.city === confined) : all;
      const hits = searchMembers(pool, q);
      /* The plan price of a result's OWN city is only known for the picked one; other cities show
       * whole dollars (and no Custom price chip) rather than a guess. */
      const plan = (c: string) => (c === city ? planCents : null);
      // Unsorted, a search keeps its own order: live memberships first, newest first.
      const viewed = view(hits, stripe, plan);
      const ordered = askedSort ? sortRows(viewed, askedSort) : viewed;
      if (url.searchParams.get("format") === "csv") return csvOut(ordered, `members-search`);
      const pg = pageOf(ordered, Number(url.searchParams.get("page") ?? 1));
      return Response.json({
        mode: "search", env, source, syncedAt, q, city, sort: askedSort,
        summary: searchSummary(hits, isAll ? null : nameOf(city)),
        confinedTo: confined, page: pg.page, pages: pg.pages, total: pg.total, rows: pg.rows,
      });
    }

    /* ── ONE TAB OF ONE CITY ──────────────────────────────────────────────────────────────── */
    const tabParam = url.searchParams.get("tab");
    const tab: Tab = isTab(tabParam) ? tabParam : "current";
    const cityRows = isAll ? (confined ? all.filter((r) => r.city === confined) : mdRows) : all.filter((r) => r.city === city);
    const counts = tabCounts(cityRows, now);
    const sort = askedSort ?? defaultSort(tab);
    const ordered = sortRows(view(tabRows(isAll ? mdRows : all, city, tab, now), stripe, () => planCents), sort);

    if (url.searchParams.get("format") === "csv") return csvOut(ordered, `members-${isAll ? "all-cities" : city}-${tab}`);

    const pg = pageOf(ordered, Number(url.searchParams.get("page") ?? 1));
    return Response.json({
      mode: "list", env, source, syncedAt, city, tab, counts, confinedTo: confined, sort,
      cityName: isAll ? "All cities" : nameOf(city),
      pills: cityPills(confined ? all.filter((r) => r.city === confined) : mdRows, now, nameOf),
      payingCount: countActiveMembers(cityMirrorShape(cityRows), new Date(now)),
      settings: settings && { ...settings, payingCount: countActiveMembers(cityMirrorShape(cityRows), new Date(now)) },
      page: pg.page, pages: pg.pages, total: pg.total, rows: pg.rows,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** countActiveMembers takes the mirror's own field names; this maps a normalised row back. */
function cityMirrorShape(rows: readonly MemberRow[]) {
  return rows.map((r) => ({
    status: r.status, price: r.priceDollars, member_email: r.email,
    activation_date: r.activationDate, canceled_at: r.canceledAt, city_identifier: r.city,
  }));
}
