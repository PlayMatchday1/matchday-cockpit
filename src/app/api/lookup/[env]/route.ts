// Player Lookup read route (Phase 18) — READ-ONLY. Two shapes:
//   GET ?q=<term>&page=<n>  -> search. Returns a light row per hit — no strikes, no
//                     payments, no card data — plus the TRUE total and the page.
//
// ── THE CLAIM THIS HEADER SHIPPED WITH, AND THE CORRECTION ────────────────────────────────────
// It read, verbatim:
//
//     GET ?q=<term>  -> search. Universal fuzzy: /admin/players?email=<term> matches
//                       email, name AND phone-digits (confirmed live); a pure id uses
//                       ?id=<n> (exact).
//
// CORRECTION (2026-08-26). `?email=` matches EMAIL and PHONE — NOT name. Measured on production
// over four terms (153 hits): every hit has the term in its EMAIL and there are ZERO name-only
// hits. Anderson King (id 395, kinga11592@gmail.com) was unreachable by "anderson" and always
// reachable by "king" for exactly that reason. The API exposes no name parameter at all, so a
// NAME is answered from our own mirror instead — see the search block below.
//   GET ?id=<n>    -> one profile: identity, facts, membership, match history and the
//                     read-only STRIKES summary (server-computed activeStrikes + per-log
//                     reason joined from the user-match's userStatus). PAYMENTS and
//                     ACCOUNT-HISTORY are still NOT built — this route never returns Stripe
//                     charge or ban-history data, so those empty panels can't lie.
//
// Writes (add to / remove from a match) do NOT live here — they reuse the existing
// guarded roster route (/api/matchday/{env}/roster/{matchId}) so there is ONE write
// path with the EDIT MATCHES gate, deny-lists and recordWrite already on it.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { cityNameFor } from "@/lib/cityScope";
import { CONFINED_CITY_ERROR, playerInConfinedScope } from "@/lib/cityConfinement";
import { playedInCity, hasPlayedInCity, nameMatchesInCity, ScopeTooLargeError } from "@/lib/playerCityScope";
import { isFakePlayerEmail } from "@/lib/mdapiFakePlayer";
import { apiGet, StageHostGuardError, StageConfigError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import {
  detectKind, serverQuery, usesMirror, splitNameTerms, nameOrFilter, SEARCH_PAGE_SIZE,
} from "@/lib/playerLookupModel";
import { makeServerClient } from "@/lib/supabaseServer";
import { buildProfile } from "@/lib/playerProfile";
import { loadMirrorHistory } from "@/lib/mirrorHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const name = (r: Record<string, unknown>) => [str(r.firstName), str(r.lastName)].filter(Boolean).join(" ").trim() || `User ${r.id}`;

// Ban status: permanent ban = EXPELLED; timed/active ban = SUSPENDED; else OK.
function banStatus(r: Record<string, unknown>): "expelled" | "suspended" | "ok" {
  if (r.isBanPermanent === true) return "expelled";
  if (r.isBanned === true) return "suspended";
  return "ok";
}

function activeSub(subs: unknown): Record<string, unknown> | null {
  if (!Array.isArray(subs) || !subs.length) return null;
  // prefer a non-cancelled subscription, else the most recent row
  const rows = subs as Record<string, unknown>[];
  const live = rows.find((s) => !s.canceledAt && (s.status == null || String(s.status).toLowerCase() !== "canceled"));
  return live ?? rows[0];
}

function lightRow(r: Record<string, unknown>) {
  const city = (r.preferableCity as Record<string, unknown> | undefined) ?? null;
  return {
    id: num(r.id), name: name(r), email: str(r.email), phone: str(r.phoneNumber),
    city: city ? str(city.name) : null,
    status: banStatus(r), // present when the list row carries ban flags; else "ok"
    hasMembership: activeSub(r.userSubscriptions) != null, // only if list row carries subs
  };
}

/* ── WHY A SEARCH CAME BACK SHORT, IN THE LOGS AND NOWHERE ELSE ────────────────────────────────
 * Junior read as a data problem for a week because the page said "No player found" and no surface
 * anywhere said a row had been removed by scope. Nothing changes on screen — telling a confined
 * operator "3 hidden" would leak the existence of players outside their city — but the next time
 * this happens the answer is one log line instead of four rounds of reading this file.
 *
 * ONLY WHEN IT ACTUALLY DROPS SOMETHING. A line per search would bury the one that matters. */
function logScopeDrop(kind: string, email: string, city: string | null, before: number, after: number) {
  if (after >= before) return;
  console.warn(
    `[lookup] city scope removed ${before - after} of ${before} ${kind} result(s) for ${email} ` +
    `(confined to ${city}). Reason: neither home city nor a played match in that city.`,
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const id = url.searchParams.get("id");

  try {
    // ---- profile ----
    if (id !== null) {
      if (!/^\d+$/.test(id)) return Response.json({ error: "id must be numeric" }, { status: 400 });
      // Detail + list, in parallel. preferableCity is on the LIST row but NOT the detail
      // payload (confirmed live), so the profile reads it from the list — otherwise the
      // header renders "—" for a field the API actually has.
      const [raw, listRow] = await Promise.all([
        apiGet<Record<string, unknown>>(env, `/admin/players/${id}`),
        apiGet<{ data?: Record<string, unknown>[] }>(env, `/admin/players`, { id, limit: 1, page: 1 })
          .then((r) => (Array.isArray(r) ? r[0] : (r.data ?? [])[0]) ?? null)
          .catch(() => null),
      ]);
      /* ── WHAT "A WARSAW PLAYER" IS ───────────────────────────────────────────────────────────
       * The only city a PLAYER carries is preferableCity — their own declared city, on the list
       * row. The alternatives were: (a) this field, (b) "has played ≥1 Warsaw match", (c) "has
       * played ONLY Warsaw matches". (b) and (c) are derivations over match history, which the
       * SEARCH endpoint does not return at all — so neither can filter a search without fetching
       * every candidate's profile first.
       *
       * PICKED: (a) preferableCity — BUT IT IS A PREFERENCE, NOT A FACT, and nothing here should
       * be read as though the platform knows where a player belongs. It is a setting the player
       * chose. Both errors follow directly:
       *   · a Warsaw regular who set "Austin" is INVISIBLE to the Warsaw account;
       *   · an Austin regular who set "Warsaw" is VISIBLE to it.
       * It is used because it is the only city that exists at player level, not because it is
       * right. Treat it as a soft SORT of the search list, never as the boundary.
       *
       * THE BOUNDARY IS THIS REFUSAL. Omitting someone from a list does not stop ?id= being typed,
       * so a request for a player outside the scope is refused outright — 403, not a filtered-empty
       * result, so the difference between "no such player" and "not yours" stays visible to us and
       * invisible to them.
       *
       * ── THE CORRECTION THE BLOCK ABOVE PREDICTED ──────────────────────────────────────────────
       * "a Warsaw regular who set 'Austin' is INVISIBLE to the Warsaw account" was written as a
       * known cost of using preferableCity. It came true twice, by name: 88519 and 88512. The
       * boundary is now a UNION — home city OR a played match in the city — so option (b) from
       * that list is no longer "a derivation the search endpoint cannot return": it is one indexed
       * read against the mirror, which this route already talks to for name search. */
      if (auth.confinedCity) {
        const lr = (listRow ?? {}) as Record<string, unknown>;
        const pc = (lr.preferableCity as Record<string, unknown> | undefined) ?? null;
        const want = cityNameFor(auth.confinedCity);
        const homeMatches = pc ? str(pc.name) === want : false;
        /* THE MIRROR IS ONLY ASKED WHEN THE CHEAP BRANCH SAYS NO. A Warsaw-home player is already
         * in scope, and a query to prove it again would be a round trip per profile view. */
        const played = homeMatches
          ? false
          : await hasPlayedInCity(makeServerClient(), want ?? "", Number(id));
        const allowed = playerInConfinedScope(auth.confinedCity, {
          homeCityName: pc ? str(pc.name) : null,
          homeCityAbbr: pc ? str(pc.abbr) : null,
          /* A SYNTHETIC PLAYER NEVER ENTERS THROUGH THE NEW DOOR. See the search block below. */
          playedInScope: played && !isFakePlayerEmail(str(lr.email) ?? str(raw?.email)),
        });
        if (!allowed) return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
      }
      /* THE MAPPING MOVED TO src/lib/playerProfile.ts, UNCHANGED, and this route now calls it.
       * The Player Chats context pane shows the same player — Ryan's ask was that it show "all the
       * player data from player look up so you dont have to go to player look up" — and two copies
       * of this mapping would drift silently: a pane and a page quoting different credit balances
       * during a billing argument, with no error anywhere. */
      /* THE MIRROR'S ROWS, so this page shows the same history the chat pane does. The API omits
       * every booking whose match was cancelled (five players measured, five omitted — see
       * docs/matchday-api-facts.md), which meant the pane could list a match this page could not,
       * while the pane's own footer button sent the operator here to look at it.
       *
       * CHARGES ARE NOT FETCHED HERE. This page reads Stripe from its own endpoint, in the browser,
       * after the profile has rendered — deliberately, so a Stripe outage cannot blank the page. So
       * the rows arrive with `charge: undefined` ("not looked for") and PaymentsPanel applies the
       * same attachCharges join client-side when the charges land. */
      const mirrorRows = await loadMirrorHistory(makeServerClient(), Number(id));

      const profile = await buildProfile({
        raw,
        listRow,
        mirrorRows,
        resolveActor: async (userId) => {
          const b = await apiGet<Record<string, unknown>>(env, `/admin/players/${userId}`).catch(() => null);
          const bd = b && typeof b === "object" && "data" in b ? (b.data as Record<string, unknown>) : b;
          return bd ? name(bd) : null;
        },
      });

      return Response.json({ env, ...profile });
    }

    // ---- search ----
    if (q !== null) {
      const d = detectKind(q);
      if (d.kind === "empty") return Response.json({ kind: d.kind, results: [], total: 0, page: 1, pageSize: SEARCH_PAGE_SIZE, totalKnown: true });
      const pageN = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
      const want = auth.confinedCity ? cityNameFor(auth.confinedCity) : null;

      /* ── A NAME GOES TO THE MIRROR, AND ONLY FOR ITS IDS ──────────────────────────────────────
       * The upstream endpoint has NO name parameter — `?email=` matches email and phone and
       * nothing else — so a name cannot be asked of it at all.
       *
       * THE MIRROR IS NOT THE ANSWER, IT IS THE INDEX. Player Lookup goes to the API on purpose so
       * every field on screen is live; returning mdapi_users rows would quietly make this the one
       * screen showing yesterday's email and yesterday's ban state. So the mirror finds candidate
       * IDs and each row shown is fetched FRESH from the API by id.
       *
       * THE COST OF THAT IS A STALENESS WINDOW ON DISCOVERY, not on detail: a player who registered
       * after the last sync is not findable BY NAME until it runs. mdapi_users is refreshed twice a
       * day — a full pass at 09:00 UTC and an incremental inside the 11:00 UTC cron — so the worst
       * case is about 22 hours. They remain findable by EMAIL, PHONE and ID the moment they exist,
       * because those three still go straight to the API. The response says so in `via`. */
      if (usesMirror(d.kind)) {
        const sb = makeServerClient();
        const terms = splitNameTerms(q);
        // ONE PREDICATE PER WORD, ANDed. "anderson king" is two predicates, not one impossible
        // substring; order does not matter, so "king anderson" finds the same person.
        // ONE definition of "matches a name" — nameOrFilter is the query form of
        // matchesNameTerms, and player-lookup-search-test asserts the two agree.
        const named = (cols: string, opts?: { count?: "exact"; head?: boolean }) => {
          let q = sb.from("mdapi_users").select(cols, opts);
          for (const t of terms) {
            const f = nameOrFilter(t);
            if (f) q = q.or(f);
          }
          // Ordered the same way the API orders — first_name ascending — so the two paths agree
          // about who is on page 1. last_name and id break ties so paging is deterministic.
          return q.order("first_name", { ascending: true }).order("last_name", { ascending: true }).order("id", { ascending: true });
        };
        const from = (pageN - 1) * SEARCH_PAGE_SIZE;
        let pageIds: number[];
        let count: number | null;
        if (want) {
          /* A CITY ACCOUNT: THE NAME FIRST, THEN THE CITY (Ryan, 2026-11-02). Every name match, then
           * only those whose home city is this one or who played here, checked by id on the server
           * (nameMatchesInCity). Nothing about the players left out leaves this route: no count, no
           * "hidden". A name too broad to check gets a hint to type more, also without a count. */
          const inCity = await nameMatchesInCity(sb, (cols, head) => named(cols, head ? { count: "exact", head: true } : undefined) as never, want);
          if (inCity == null) {
            return Response.json({ kind: d.kind, results: [], page: pageN, pageSize: SEARCH_PAGE_SIZE, total: 0, totalKnown: false, dropped: 0, via: "mirror", terms, hint: "Type more of the name." });
          }
          count = inCity.length;
          pageIds = inCity.slice(from, from + SEARCH_PAGE_SIZE);
        } else {
          const { data, count: c, error } = await named("id", { count: "exact" }).range(from, from + SEARCH_PAGE_SIZE - 1);
          /* AN ERROR IS NOT AN EMPTY RESULT. `?.length ?? 0` on a failed PostgREST call renders a
           * swallowed error and a genuinely empty search identically — that has already cost us a
           * wrong answer on this very table. */
          if (error) return Response.json({ error: `name search failed: ${error.message}` }, { status: 500 });
          count = c;
          pageIds = (data ?? []).map((r) => Number((r as unknown as { id: unknown }).id));
        }

        const ids = pageIds.filter(Number.isFinite);
        /* THE LIST IS THE MIRROR'S, NOT A LIVE READ PER ROW (Ryan, 2026-11-02). Each row is built
         * from mdapi_users: its raw MatchDay player row from the last sync (name, email, phone, city,
         * ban flags, through the same lightRow) and is_member. It read every row live from MatchDay,
         * 25 calls, and the slowest set the time (2.5 s seen). The profile still reads the player
         * live when it is opened, so email and ban state are current there. */
        const mirrorRes = ids.length ? await sb.from("mdapi_users").select("id, raw, is_member").in("id", ids) : { data: [], error: null };
        if (mirrorRes.error) return Response.json({ error: `name search failed: ${mirrorRes.error.message}` }, { status: 500 });
        const byId = new Map((mirrorRes.data ?? []).map((r) => [Number((r as { id: unknown }).id), r as { raw: unknown; is_member: unknown }]));
        const live = ids.map((id) => byId.get(id)).filter((r): r is { raw: unknown; is_member: unknown } => r != null)
          .map((r) => ({ ...(r.raw as Record<string, unknown>), __member: r.is_member === true }));
        const dropped = ids.length - live.length;
        let results = live.map((r) => ({ ...lightRow(r), hasMembership: r.__member }));
        /* THE SAME UNION AGAIN, ON THE ROWS THE API HANDED BACK. The query above already scoped
         * the ids; this is the belt to that braces, and it has to ask the same question or it
         * would re-narrow to home city and undo the widening one line after making it.
         *
         * The ids are already known to be in scope, so the only thing to re-check is that the API
         * row still agrees — and the played-in answer is carried over rather than re-queried. */
        if (want) {
          const scoped = await playedInCity(sb, want, results.map((r) => r.id ?? 0));
          const before = results.length;
          results = results.filter((r) => playerInConfinedScope(auth.confinedCity, {
            homeCityName: r.city,
            playedInScope: scoped.has(r.id ?? 0) && !isFakePlayerEmail(r.email),
          }));
          logScopeDrop("name", auth.email, want, before, results.length);
        }
        return Response.json({
          kind: d.kind, results, page: pageN, pageSize: SEARCH_PAGE_SIZE,
          total: count ?? 0, totalKnown: count != null, dropped,
          via: "mirror", terms,
        });
      }

      /* EMAIL, PHONE AND ID GO STRAIGHT TO THE API, and the header now reads the total the API has
       * been returning all along. `limit: 15, page: 1` was hardcoded here; the 15 rows it produced
       * were reported as "15 matches" for terms with 18, 69, 299 and 396 real hits. */
      const query = { ...serverQuery(d), limit: SEARCH_PAGE_SIZE, page: pageN };
      const r = await apiGet<{ data?: Record<string, unknown>[]; totalItems?: number } | Record<string, unknown>[]>(env, `/admin/players`, query);
      const rows = Array.isArray(r) ? r : ((r as { data?: Record<string, unknown>[] }).data ?? []);
      const totalItems = Array.isArray(r) ? undefined : (r as { totalItems?: number }).totalItems;
      // THE SEARCH LIST, SCOPED. Filtered on the server before serialization — the upstream
      // /admin/players has no city parameter, so this cannot be an in-query filter; what it can be
      // is a filter no row escapes, and a `results` array whose length is the filtered length.
      let results = rows.map(lightRow);
      let total = typeof totalItems === "number" ? totalItems : null;
      if (auth.confinedCity) {
        const before = results.length;
        /* THIS IS THE LINE THAT ATE JUNIOR. `r.city === want` on rows the upstream API returned
         * with no match history attached — so a Warsaw regular whose stated city was Austin was
         * dropped here, and the page said "No player found".
         *
         * THE HISTORY IS NOT ON THESE ROWS AND CANNOT BE. /admin/players returns no roster, so the
         * played-in half is resolved against the mirror for the handful of ids on this page. It is
         * one indexed read for at most SEARCH_PAGE_SIZE ids. */
        const scoped = await playedInCity(makeServerClient(), want ?? "", results.map((r) => r.id ?? 0));
        results = results.filter((r) => playerInConfinedScope(auth.confinedCity, {
          homeCityName: r.city,
          playedInScope: scoped.has(r.id ?? 0) && !isFakePlayerEmail(r.email),
        }));
        logScopeDrop(d.kind, auth.email, want, before, results.length);
        /* A CONFINED ACCOUNT'S TOTAL IS NOT KNOWABLE FROM totalItems — that count is the unscoped
         * one, and the filter runs after the page arrives. Printing it would tell a Warsaw operator
         * there are 69 matches when they can see four. So the total is withheld, and the header
         * says the total is not known rather than inventing one. */
        if (before !== results.length || total !== null) total = null;
      }
      return Response.json({
        kind: d.kind, results, page: pageN, pageSize: SEARCH_PAGE_SIZE,
        total: total ?? results.length, totalKnown: total !== null, dropped: 0, via: "api",
      });
    }

    return Response.json({ error: "q or id required" }, { status: 400 });
  } catch (e) {
    if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
    if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
    /* A REFUSAL, NOT A DEGRADED PAGE. The city boundary could not be expressed in one query, so no
     * answer is given rather than a page scoped to a truncated list. See playerCityScope.ts. */
    if (e instanceof ScopeTooLargeError) {
      console.error(`[lookup] ${e.message}`);
      return Response.json({ error: e.message }, { status: 500 });
    }
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
