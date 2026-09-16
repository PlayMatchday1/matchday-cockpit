/* GET /api/manager-pay/directory — the people who may be added to a pay sheet. READ ONLY.
 *
 * ── THE SOURCE CHANGED ON 2026-09-01, AND THE OLD ONE WAS WRONG ───────────────────────────────
 * This used to union "every manager_email that has ever appeared on a match" with the Gusto alias
 * table. That produced 102 people, unsorted, from every city, of whom 11 could actually be paid —
 * an operator adding someone to Atlanta was shown 91 people who would be refused on save.
 *
 * THE REAL SOURCE IS THE MATCHDAY CITY-MANAGER ROSTER: `GET /city-managers`, the same endpoint
 * behind Retool's CITY MANAGERS section. Read out of the production Retool export rather than
 * guessed:
 *     getCityManagers                  GET /city-managers?cityId={filterCityMnagersCity.value}
 *     getCityManagersForAttachToMatch  GET /city-managers/users?email={search}&cityId={match city}
 * No `/admin` prefix. `cityId` is the column that carries the city, and each row nests the full
 * city object whose `abbr` is exactly the ATX / HOU / SATX code the pay sheet groups by.
 *
 * MEASURED 2026-09-01: 100 rows total, and 100 is the REAL total, not a page cap — the per-city
 * queries sum to exactly the unfiltered call. The endpoint IGNORES page/limit — asking for page 2
 * returns the same rows — so it is fetched once, unfiltered, and grouped here.
 *
 * RE-MEASURED 2026-09-15: 106 rows, 85 distinct people (somebody rostered in two cities is two
 * rows). Per city: 29 ATX, 18 HOU, 17 SATX, 14 DFW, 10 STL, 9 ATL, 4 OKC, 3 NYC, 1 WAW, 1 ELP.
 * The roster moves; this count is a measurement with a date on it, not a constant.
 *
 * BEING ON A CITY'S ROSTER IS NOT THE SAME AS HAVING RUN A MATCH. 72 of the 100 have ever been
 * assigned one, and the two sets are not subsets of each other. The roster is the right list for
 * "who may be paid in this city"; match history is a record of what happened, which is a different
 * question and is what the old directory wrongly answered.
 *
 * ── gusto: null IS RETURNED, NOT FILTERED ─────────────────────────────────────────────────────
 * Only 12 of the 85 carry a Gusto mapping (re-measured 2026-09-15; it was 11 of 100 on 09-01).
 * They are returned anyway, with `gusto: null`, so the dialog can show them behind its "show all"
 * toggle with a chip saying why they cannot be saved. Omitting them server-side would read as
 * "this person does not exist" and send the operator looking for a free-text box — which is the
 * thing that must never exist here.
 *
 * THE OTHER 73 WERE IN A CLOSED LOOP UNTIL 2026-09-15. The only Gusto-alias editor in the app was
 * inside an expanded row on the pay sheet, and the only ways onto that sheet are managing a match
 * or being added through AddSomeoneModal — which refused anyone with no mapping. So a person who
 * had never managed a match could not acquire a mapping through any screen we ship. DFW and STL
 * had zero mapped people between them: 24 people nobody could pay. The add dialog now offers the
 * mapping form at the point of refusal, which is what closes it.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { apiGet } from "@/lib/matchdayStageApi";
import { selectAll } from "@/lib/supabasePagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type DirectoryEntry = {
  email: string;
  name: string;
  /** The Gusto mapping, or null. Null is returned, never hidden — see the header. */
  gusto: { firstName: string; lastName: string } | null;
  /** The city abbr from the roster row's nested city — "ATX", "HOU", … null if the API omits it. */
  city: string | null;
  /** The friendly city name, for the "they are in Houston" message when a search misses. */
  cityName: string | null;
};

type CityManagerRow = {
  userId?: number;
  cityId?: number;
  user?: { email?: string | null; firstName?: string | null; lastName?: string | null };
  city?: { abbr?: string | null; name?: string | null };
};

const displayName = (first?: string | null, last?: string | null, email?: string | null): string =>
  [first, last].filter(Boolean).join(" ").trim() || (email ?? "");

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    /* ONE UNFILTERED CALL. Grouping happens here rather than one request per city: the endpoint
     * returns the whole roster in a single response and ignores paging, so ten city-scoped calls
     * would be ten round trips for the same 100 rows. */
    const raw = await apiGet<CityManagerRow[] | { data?: CityManagerRow[] }>("production", "/city-managers");
    const rows = (Array.isArray(raw) ? raw : (raw.data ?? [])) as CityManagerRow[];

    const aliases = await selectAll<Record<string, unknown>>(() =>
      // select("*") not a column list — code deploys before migrations apply, and naming a column
      // that has not shipped yet would 500 the whole picker.
      auth.supabase.from("manager_gusto_aliases").select("*").order("manager_email"),
    );
    const aliasByEmail = new Map<string, { firstName: string; lastName: string }>();
    for (const a of aliases) {
      const e = String(a.manager_email ?? "").trim().toLowerCase();
      const first = String(a.gusto_first_name ?? "").trim();
      const last = String(a.gusto_last_name ?? "").trim();
      if (e && (first || last)) aliasByEmail.set(e, { firstName: first, lastName: last });
    }

    /* ONE ENTRY PER PERSON. Someone rostered in two cities appears twice in the API response; the
     * picker needs one row per person per city, so the key is email+city rather than email alone —
     * collapsing on email would silently drop their second city from that city's list. */
    const byKey = new Map<string, DirectoryEntry>();
    for (const r of rows) {
      const email = String(r.user?.email ?? "").trim().toLowerCase();
      if (!email) continue;
      const city = r.city?.abbr ? String(r.city.abbr).trim() : null;
      byKey.set(`${email}|${city ?? ""}`, {
        email,
        name: displayName(r.user?.firstName, r.user?.lastName, email),
        gusto: aliasByEmail.get(email) ?? null,
        city,
        cityName: r.city?.name ? String(r.city.name) : null,
      });
    }

    /* ALPHABETICAL BY NAME, once, here — so every consumer gets the same order and no caller has
     * to remember to sort. Locale compare so accented names sit where a reader expects. */
    const people = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));

    const byCity: Record<string, number> = {};
    for (const p of people) byCity[p.city ?? "—"] = (byCity[p.city ?? "—"] ?? 0) + 1;

    return Response.json(
      {
        people,
        total: people.length,
        withGusto: people.filter((p) => p.gusto).length,
        byCity,
        source: "GET /city-managers (MatchDay) — the roster behind Retool's CITY MANAGERS",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // LOUD. An empty picker and a failed read must never look the same.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
