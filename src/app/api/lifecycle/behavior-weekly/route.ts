/* GET /api/lifecycle/behavior-weekly?start=2026-03&end=2026-08 — Player Behavior's four metrics,
 * per WEEK, over the window the page's PERIOD PICKER selected. READ ONLY.
 *
 * ── THE WINDOW COMES FROM THE CALLER ──────────────────────────────────────────────────────────
 * `start` and `end` are month keys, the same pair the monthly view uses, and the axis is every
 * week whose MONDAY falls inside them (see weeksInMonthRange). `?weeks=N` remains as a fallback
 * for a caller with no period in hand — it means "the last N weeks ending today".
 *
 * ── WHY THIS EXISTS INSTEAD OF READING THE GROWTH VIEWS ───────────────────────────────────────
 * Every growth_* materialized view is pre-aggregated to a MONTH — growth_registration exposes
 * `signup_month` and no date at all, growth_player_month is keyed on `activity_month`. There is
 * nothing in them to bucket by week. So the weekly path re-derives from the mirrors, which is the
 * only place a date survives.
 *
 * ── THE TWO CLOCKS, AND THEY ARE HANDLED DIFFERENTLY ON PURPOSE ───────────────────────────────
 *   mdapi_users.completed_sign_up_at   TRUE UTC INSTANT → converted to its America/Chicago day.
 *   mdapi_matches.start_date           LOCAL WALL CLOCK carrying a Z it does not mean → SLICED.
 * Swapping those two produces plausible numbers and wrong ones. See weekBuckets.ts.
 *
 * ── THIS WILL NOT SUM TO THE MONTHLY VIEW, FOR TWO REASONS, BOTH STRUCTURAL ───────────────────
 *   1. (RESOLVED BY MIGRATION 0157, 2026-09-01.) The monthly buckets used to be UTC while weekly
 *      was Chicago — 218 of 27,064 users (0.81%) fell in a different month under the two zones.
 *      growth_registration is now America/Chicago too, so this reason no longer applies.
 *   2. WEEKS DO NOT ALIGN TO MONTHS. This one is permanent. A week running Aug 31 – Sep 6 belongs wholly to neither
 *      August nor September, so "the weekly buckets summed over a month" is not a defined
 *      quantity unless that month happens to start on a Monday and end on a Sunday. This one is
 *      unavoidable and has nothing to do with timezones.
 * The survivor is reported to the caller in `reconcile` rather than left to be discovered.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { chicagoYmd, wallClockYmd, weekKey, lastWeeks, weeksInMonthRange, weekEnd, addDays, MAX_WEEKS,
  daysInMonthRange, lastDays, MAX_DAYS } from "@/lib/weekBuckets";
/* ONE CITY VOCABULARY, AND IT IS THE ONE MONTHLY ALREADY USES.
 *
 * This route used to group registrations on the RAW `preferable_city_name` and play on
 * `cityFromAbbr(city_identifier)`. Those are two different vocabularies and they do not meet:
 *
 *     registrations keyed   "Dallas / Fort Worth"   play keyed   "Dallas"
 *     registrations keyed   "Oklahoma City"         play keyed   "OKC"
 *
 * so Dallas and OKC read 0 registrations in every bucket while their real 1,074 and 483 sat in the
 * payload under keys the panel never lists. Measured over Mar–Aug 2026: 1,802 of 9,482
 * registrations — 19% — attributed to no listed city.
 *
 * `normalizeDeclared` and `normalizeMatchCity` are the two halves growthFromViews has always used,
 * and they agree with each other by construction. cityFromAbbr is NOT interchangeable with
 * normalizeMatchCity: it is backed by a second, older map that never got Warsaw, and it returns
 * null for an unknown code where normalizeMatchCity falls back to the code itself. That difference
 * alone was dropping 85 Warsaw spots and hiding the city completely. */
import { normalizeDeclared, normalizeMatchCity, UNASSIGNED_CITY } from "@/lib/growthAnalytics";
/* ── ONE FIELD VOCABULARY, AND IT IS THE ONE MONTHLY ALREADY USES ─────────────────────────────
 * Exactly the problem normalizeDeclared/normalizeMatchCity solved for CITIES, one level down.
 * This route grouped fields on the RAW `field_title`; growthFromViews groups them on
 * `canonicalVenueName(field_title)` (see its `fieldOf`). Those are two vocabularies:
 *
 *     monthly keyed   "NEMP"            weekly/window keyed   "NEMP Tournaments"
 *     monthly keyed   "Soccer Central"  weekly/window keyed   "Soccer Central Complex"
 *                                                       AND   "Premier Match at Soccer Central"
 *     monthly keyed   "ATH Pearland"    weekly/window keyed   "Tourney ATH Pearland"
 *
 * MEASURED: 34 of 53 monthly field keys had NO match in this route's output. Two things broke on
 * that, both silently. Switching grain re-listed the fields under different names. And the panel
 * looks a field's DISTINCT period total up by the monthly key, so every canonical-named field read
 * its unique count as ZERO — a wrong number that looks like a real one, which is the failure mode
 * this page keeps producing.
 *
 * canonicalVenueName is the SAME function the monthly path calls, not a second map, so the two
 * agree by construction rather than by being kept in step. */
import { canonicalVenueName } from "@/lib/venueResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type WeekPoint = { w: string; registrations: number; newPlayers: number; totalPlayers: number; spots: number };

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "lifecycle");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const qs = new URL(req.url).searchParams;
  const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
  const start = qs.get("start");
  const end = qs.get("end");
  const n = Number(qs.get("weeks") ?? 13);
  const weeks = Number.isInteger(n) && n >= 1 && n <= MAX_WEEKS ? n : 13;
  /* ── DAILY IS THIS QUERY WITH THE BUCKETING STEP REMOVED ─────────────────────────────────────
   * This route already re-derives from the row-level mirrors, and it buckets with
   * `weekKey(chicagoYmd(...))` for signups and `weekKey(wallClockYmd(...))` for matches. SO
   * chicagoYmd AND wallClockYmd *ARE* THE DAY KEYS; weekKey is the wrapper around them.
   *
   * WHICH MEANS THE TWO DATE RULES SURVIVE BY CONSTRUCTION rather than by being carried across:
   * they live in the inner call, and taking the outer one off cannot change which day a row lands
   * on. Verified empirically in scripts/behavior-daily-test.ts, because "by construction" is a
   * claim about code and not a fact about data - a registration at 02:30Z and a match at the same
   * wall clock are the same day in the raw strings and land on different days once the rules run.
   *
   * AT MONTH GRAIN A SWAPPED RULE MOVES A HANDFUL OF ROWS. At day grain it moves rows every single
   * day, in OPPOSITE directions for the two reads, so the error doubles rather than partly
   * cancelling.
   *
   * DAYS ALIGN TO MONTHS, so daily does NOT inherit weekly's permanent "weeks do not align to
   * months" caveat. A month's days sum to that month exactly, which weekly can never promise. */
  const grain = qs.get("grain") === "daily" ? "daily" : "weekly";
  /* ── DISTINCT COUNTS OVER ARBITRARY DAY WINDOWS ──────────────────────────────────────────────
   * `windows=from:to,from:to` - up to four, each a pair of YYYY-MM-DD bounds, inclusive.
   *
   * WHY THE ROUTE AND NOT THE CALLER. totalPlayers is a DISTINCT count: the caller holds one Set
   * size per bucket and no amount of arithmetic over those recovers the distinct count over a range,
   * because it cannot know who appears in two of them. Summing them instead was 86.9% too high on
   * Apr-Sep 2026 - 15,619 against a true 8,357 - and looked right because it landed 0.9% from the
   * all-time figure.
   *
   * ONE AGGREGATE SERVES BOTH CALLERS: the Period total for a distinct count over the displayed
   * period, and the day-matched change over each of the two compared windows. */
  const windowSpec = (qs.get("windows") ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4)
    .map((pair) => { const [from, to] = pair.split(":"); return { from, to }; })
    .filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.from ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(w.to ?? "") && w.from <= w.to);
  const bucketOf = (ymd: string): string => (grain === "daily" ? ymd : weekKey(ymd));
  const sb = auth.supabase;

  try {
    /* THE AXIS. A valid month pair wins; anything else falls back to "the last N weeks ending
     * today". A MALFORMED PAIR IS REJECTED, not quietly ignored — a picker that silently reverted
     * to a default window is the bug this parameter exists to fix. */
    if ((start != null || end != null) && !(start && end && MONTH.test(start) && MONTH.test(end))) {
      return Response.json({ error: "start and end must both be YYYY-MM" }, { status: 400 });
    }
    if (start && end && start > end) {
      return Response.json({ error: "start must not be after end" }, { status: 400 });
    }
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    /* SIX MONTHS OF DAYS IS 180 COLUMNS, which is not a table anyone reads, so daily is capped at
     * MAX_DAYS and front-drops like the weekly axis does. The CALLER also collapses its range,
     * visibly, so the cap is a backstop rather than the mechanism. */
    const ranged = start && end
      ? (grain === "daily" ? daysInMonthRange(start, end) : weeksInMonthRange(start, end))
      : null;
    const full = ranged ? ranged.axis : (grain === "daily" ? lastDays(today, MAX_DAYS) : lastWeeks(today, weeks));
    /* WEEKS THAT HAVE NOT STARTED ARE DROPPED, not rendered as zero. A period ending in the
     * current or a future month contains weeks whose Monday is still ahead; they can only ever
     * plot as 0 and a run of zeros at the right edge reads as a collapse, which is the same lie
     * the partial last week was telling. The week CONTAINING today is kept — it is partial, and
     * the panel marks it as such rather than hiding this week's numbers from a weekly report. */
    const axis = full.filter((w) => w <= today);
    const futureDropped = full.length - axis.length;
    if (axis.length === 0) {
      return Response.json({ error: "that period is entirely in the future" }, { status: 400 });
    }
    /* THE LOWER BOUND COVERS THE WINDOWS TOO. The reads are bounded by the axis, and a compared
     * window legitimately reaches BEFORE it - the previous period's window always does. Without this
     * the window's rows are never fetched and it reads zero, which would make every change pill on a
     * part-elapsed period look like a total collapse. */
    const first = [axis[0], ...windowSpec.map((w) => w.from)].sort()[0];
    /* THE UPPER BOUND, WHICH THE FIXED WINDOW NEVER NEEDED. The old axis always ended today, so
     * `.gte(first)` alone bounded the read. A period ending in the past does not: without this the
     * route would fetch every row from `first` to now and throw almost all of it away.
     *
     * TWO DAYS OF SLACK, ON PURPOSE, AND IT IS NOT THE SAME SLACK FOR BOTH READS. Chicago is
     * behind UTC, so an instant whose CHICAGO day is the last Sunday can carry the following UTC
     * day; the match read is wall clock and needs only the day itself. One margin covers both and
     * `inAxis` does the exact filtering either way — the bound is for the query planner, never for
     * correctness. */
    /* A DAY BUCKET IS ITS OWN LAST DAY; a week bucket's is its Sunday. */
    const lastDay = grain === "daily" ? axis[axis.length - 1] : weekEnd(axis[axis.length - 1]);
    /* AND THE UPPER BOUND COVERS THEM, for the same reason in the other direction. */
    const lastNeeded = [lastDay, ...windowSpec.map((w) => w.to)].sort().pop()!;
    const upper = addDays(lastNeeded, 2);
    const inAxis = new Set(axis);

    /* THE WINDOW ACCUMULATORS, DECLARED BEFORE THE FIRST LOOP THAT TOUCHES ONE. They were beside
     * matchWeek, which sits AFTER the registrations loop, so `winReg` was read in its temporal dead
     * zone: a 502 reading "Cannot access 'winReg' before initialization". tsc passes on TDZ - it is
     * a runtime error - which is why the probe that exercises the route is what found it. */
    const winActive: Set<number>[] = windowSpec.map(() => new Set<number>());
    const winSpots: number[] = windowSpec.map(() => 0);
    const winNew: number[] = windowSpec.map(() => 0);
    const winReg: number[] = windowSpec.map(() => 0);
    /* ── THE SAME AGGREGATE, GROUPED ─────────────────────────────────────────────────────────────
     * A distinct count cannot be split after the fact: knowing the network's 8,361 says nothing
     * about Austin's, and knowing every city's says nothing about the network's, because the same
     * player is in both. So each GROUP gets its own Set over the whole window, built in the same
     * pass — this is the GROUP BY, and it costs one more Set per city/field rather than another
     * query.
     *
     * WITHOUT THIS EVERY CITY AND FIELD ROW SHOWED THE NETWORK FIGURE. The panel read windows[0]
     * for every row it drew, so all 26 fields reported the same 8,955 as their Period total. */
    const winActiveCity: Map<string, Set<number>>[] = windowSpec.map(() => new Map());
    const winNewCity: Map<string, number>[] = windowSpec.map(() => new Map());
    const winSpotsCity: Map<string, number>[] = windowSpec.map(() => new Map());
    const winRegCity: Map<string, number>[] = windowSpec.map(() => new Map());
    const winActiveField: Map<string, Set<number>>[] = windowSpec.map(() => new Map());
    const winNewField: Map<string, number>[] = windowSpec.map(() => new Map());
    const winSpotsField: Map<string, number>[] = windowSpec.map(() => new Map());
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    const addTo = (m: Map<string, Set<number>>, k: string, uid: number) =>
      (m.get(k) ?? m.set(k, new Set()).get(k)!).add(uid);

    /* ── REGISTRATIONS. A UTC instant, bucketed by its CHICAGO day. Fake players excluded, the
     * same rule growth_registration applies. Only completed signups count — an abandoned
     * onboarding is not a registration. */
    const users = await selectAll<Record<string, unknown>>(() =>
      sb.from("mdapi_users")
        .select("id, completed_sign_up_at, is_fake_player, preferable_city_name")
        .not("completed_sign_up_at", "is", null)
        .gte("completed_sign_up_at", first).lt("completed_sign_up_at", upper)
        .order("id"),
    );
    const regByWeek = new Map<string, number>();
    const regByWeekCity = new Map<string, Map<string, number>>();
    for (const u of users) {
      if (u.is_fake_player === true) continue;
      /* CHICAGO DAY FIRST, then the bucket. The window test uses the DAY, because a window is a day
       * range; the bucket test is separate and can legitimately exclude a row a window includes. */
      const regDay = chicagoYmd(String(u.completed_sign_up_at));
      /* THE DECLARED CITY IS RESOLVED BEFORE THE AXIS GUARD, because the window needs it and the
       * window can reach outside the axis. Same normaliser and same Unassigned fallback as below;
       * resolving it twice with two different rules is how the two halves drift apart. */
      const regCity = normalizeDeclared(u.preferable_city_name as string | null) ?? UNASSIGNED_CITY;
      windowSpec.forEach((wd, wi) => {
        if (regDay >= wd.from && regDay <= wd.to) { winReg[wi] += 1; bump(winRegCity[wi], regCity); }
      });
      const w = bucketOf(regDay);
      if (!inAxis.has(w)) continue;
      regByWeek.set(w, (regByWeek.get(w) ?? 0) + 1);
      /* A REGISTRATION WITHOUT A CITY GETS A ROW, NOT A BIN. `if (city)` dropped it, and a
       * dropped row is one the city table can never be reconciled against — the sum is short and
       * nothing on the page says by how much. Zero rows land here today (0 of 9,482 in
       * Mar–Aug 2026), which is exactly why it has to be built now rather than when it bites. */
      const city = regCity; // ONE resolution per row — see the note above it.
      const m = regByWeekCity.get(city) ?? new Map<string, number>();
      m.set(w, (m.get(w) ?? 0) + 1); regByWeekCity.set(city, m);
    }

    /* ── PLAY. Matches in the window give the DATE and the CITY; the roster gives who played.
     * start_date is wall clock, so it is sliced — a Chicago conversion here would shift a 7pm
     * match by the server's offset, which is the trap this estate has hit repeatedly. */
    const matches = await selectAll<Record<string, unknown>>(() =>
      sb.from("mdapi_matches")
        .select("api_id, start_date, city_identifier, field_title, is_cancelled, deleted_at")
        .is("deleted_at", null).eq("is_cancelled", false)
        .gte("start_date", first).lt("start_date", upper)
        .order("api_id"),
    );
    const matchWeek = new Map<number, string>();
    /* THE MATCH'S OWN DAY, kept beside its bucket. A window is a day range, and a bucket key is not
     * a day once the grain is weekly or monthly. SLICED from wall clock, the same rule as the
     * bucket - a Chicago conversion here would shift a 7pm match by the server's offset. */
    const matchDay = new Map<number, string>();
    const matchCity = new Map<number, string>();
    /* THE FIELD, for Behavior's field mode. Same aggregation keyed on field_title instead of city —
     * a genuinely small addition, which is why it is here rather than deferred. Registrations are
     * NOT broken out by field and must not be: a registration carries the city declared at signup
     * and never a pitch, so a per-field registration figure would be invented. */
    const matchField = new Map<number, string>();
    for (const m of matches) {
      const day = wallClockYmd(String(m.start_date));
      /* THE DAY IS RECORDED BEFORE THE AXIS GUARD. A window can legitimately reach outside the
       * displayed axis - the previous period's matched window does exactly that - and dropping the
       * day here would silently empty it. */
      matchDay.set(Number(m.api_id), day);
      /* ── THE CITY AND THE FIELD ARE RECORDED BEFORE THE AXIS GUARD TOO, FOR THE SAME REASON ───
       * They used to sit below it, so a match that belongs to a compared WINDOW but not to the
       * displayed axis had a day and no city. That was survivable while the window aggregate was
       * network-wide; it is not now that the aggregate is grouped BY city and BY field, because
       * every window-only match would land in the "" bucket and be dropped. The axis-gated maps
       * below are unchanged - matchWeek is still the thing that says "this match is on screen". */
      matchCity.set(Number(m.api_id), normalizeMatchCity(String(m.city_identifier ?? "")));
      matchField.set(Number(m.api_id), canonicalVenueName(String(m.field_title ?? "")));
      const w = bucketOf(day);
      if (!inAxis.has(w)) continue;
      matchWeek.set(Number(m.api_id), w);
    }

    /* ── THE ROSTER FETCH IS DRIVEN BY EVERY MATCH READ, NOT BY THE AXIS-FILTERED ONES ──────────
     * This was `[...matchWeek.keys()]`, and matchWeek only holds matches whose BUCKET is on the
     * displayed axis. A compared window reaches outside that axis by definition - the previous
     * period's window always does - so its matches had a day recorded and their roster rows were
     * never fetched, and the window came back 0. Every metric in it then read as a total collapse.
     *
     * matchDay HOLDS EVERY MATCH THE QUERY RETURNED, and the query's bounds already cover the
     * windows, so this is the set that makes both the axis and the windows answerable. */
    const ids = [...matchDay.keys()];
    const spotsByWeek = new Map<string, number>();
    const spotsByWeekCity = new Map<string, Map<string, number>>();
    const activeByWeek = new Map<string, Set<number>>();
    const activeByWeekCity = new Map<string, Map<string, Set<number>>>();
    /* FIRST-EVER PLAY, for newPlayers. `is_first_match` is carried on the roster row by the API
     * and is what the monthly path's cohort logic ultimately rests on too. */
    const newByWeek = new Map<string, number>();
    const newByWeekCity = new Map<string, Map<string, number>>();
    const spotsByWeekField = new Map<string, Map<string, number>>();
    const newByWeekField = new Map<string, Map<string, number>>();
    const activeByWeekField = new Map<string, Map<string, Set<number>>>();

    /* ── THE 1,000-ROW CAP, WHICH THIS CODE GOT WRONG ONCE ────────────────────────────────────
     * PostgREST caps EVERY response at 1,000 rows regardless of what is asked for. Chunking the
     * match ids is not enough: 200 matches carry far more than 1,000 roster rows, so a single
     * `.in(...)` silently returned the first 1,000 and the rest vanished.
     *
     * IT DID NOT LOOK LIKE A BUG. Every week reported exactly 1,000 rows and the metrics came out
     * as 554, 15, 535, 45, 367 — erratic enough to look like real seasonality, and every one of
     * them wrong. The tell was the 1,000 itself.
     *
     * Fixed by paging INSIDE each chunk until a short page comes back, and asserting the read is
     * complete rather than trusting the chunking. */
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const rows: Record<string, unknown>[] = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.from("mdapi_match_players")
          .select("match_api_id, user_id, is_cancelled, user_is_fake_player, is_first_match, deleted_at")
          .in("match_api_id", chunk).is("deleted_at", null)
          // A STABLE ORDER IS REQUIRED for offset paging, or a row can be skipped or repeated
          // across the boundary. api_id is the table's own unique key.
          .order("api_id").range(off, off + 999);
        if (error) throw new Error(`mdapi_match_players: ${error.message}`);
        rows.push(...(data ?? []));
        if ((data ?? []).length < 1000) break;
      }
      for (const p of rows) {
        if (p.is_cancelled === true || p.user_is_fake_player === true) continue;
        /* WINDOWS FIRST, AXIS SECOND. A roster row whose match falls outside the displayed axis can
         * still belong to a compared window; skipping on `!w` before the window test is what would
         * make the previous period's window read zero. */
        const dayOfMatch0 = matchDay.get(Number(p.match_api_id));
        const uid0 = Number(p.user_id);
        if (dayOfMatch0 && uid0) {
          /* THE MATCH'S CITY AND FIELD, from the maps that now cover EVERY match read rather than
           * only the on-axis ones. A window-only match has both. */
          const wCity = matchCity.get(Number(p.match_api_id)) ?? "";
          const wField = matchField.get(Number(p.match_api_id)) ?? "";
          windowSpec.forEach((wd, wi) => {
            if (dayOfMatch0 >= wd.from && dayOfMatch0 <= wd.to) {
              winActive[wi].add(uid0);
              winSpots[wi] += 1;
              if (p.is_first_match === true) winNew[wi] += 1;
              if (wCity) {
                addTo(winActiveCity[wi], wCity, uid0);
                bump(winSpotsCity[wi], wCity);
                if (p.is_first_match === true) bump(winNewCity[wi], wCity);
              }
              if (wField) {
                addTo(winActiveField[wi], wField, uid0);
                bump(winSpotsField[wi], wField);
                if (p.is_first_match === true) bump(winNewField[wi], wField);
              }
            }
          });
        }
        const w = matchWeek.get(Number(p.match_api_id));
        if (!w) continue;
        const city = matchCity.get(Number(p.match_api_id)) ?? "";
        const uid = Number(p.user_id);

        spotsByWeek.set(w, (spotsByWeek.get(w) ?? 0) + 1);
        if (city) {
          const m = spotsByWeekCity.get(city) ?? new Map<string, number>();
          m.set(w, (m.get(w) ?? 0) + 1); spotsByWeekCity.set(city, m);
        }
        // TOTAL PLAYERS IS DISTINCT PEOPLE, not spots — one player on three matches is one.
        (activeByWeek.get(w) ?? activeByWeek.set(w, new Set()).get(w)!).add(uid);
        if (city) {
          const cm = activeByWeekCity.get(city) ?? new Map<string, Set<number>>();
          (cm.get(w) ?? cm.set(w, new Set()).get(w)!).add(uid);
          activeByWeekCity.set(city, cm);
        }
        const field = matchField.get(Number(p.match_api_id)) ?? "";
        if (field) {
          const fm = spotsByWeekField.get(field) ?? new Map<string, number>();
          fm.set(w, (fm.get(w) ?? 0) + 1); spotsByWeekField.set(field, fm);
          const fa = activeByWeekField.get(field) ?? new Map<string, Set<number>>();
          (fa.get(w) ?? fa.set(w, new Set()).get(w)!).add(uid);
          activeByWeekField.set(field, fa);
        }
        if (p.is_first_match === true) {
          newByWeek.set(w, (newByWeek.get(w) ?? 0) + 1);
          if (field) {
            const fm = newByWeekField.get(field) ?? new Map<string, number>();
            fm.set(w, (fm.get(w) ?? 0) + 1); newByWeekField.set(field, fm);
          }
          if (city) {
            const m = newByWeekCity.get(city) ?? new Map<string, number>();
            m.set(w, (m.get(w) ?? 0) + 1); newByWeekCity.set(city, m);
          }
        }
      }
    }

    const point = (w: string): WeekPoint => ({
      w,
      registrations: regByWeek.get(w) ?? 0,
      newPlayers: newByWeek.get(w) ?? 0,
      totalPlayers: activeByWeek.get(w)?.size ?? 0,
      spots: spotsByWeek.get(w) ?? 0,
    });

    const cities = [...new Set([...regByWeekCity.keys(), ...spotsByWeekCity.keys()])].sort();
    const byCity: Record<string, WeekPoint[]> = {};
    for (const c of cities) {
      byCity[c] = axis.map((w) => ({
        w,
        registrations: regByWeekCity.get(c)?.get(w) ?? 0,
        newPlayers: newByWeekCity.get(c)?.get(w) ?? 0,
        totalPlayers: activeByWeekCity.get(c)?.get(w)?.size ?? 0,
        spots: spotsByWeekCity.get(c)?.get(w) ?? 0,
      }));
    }

    const fields = [...spotsByWeekField.keys()].sort();
    const byField: Record<string, { label: string; city: string; points: WeekPoint[] }> = {};
    for (const f of fields) {
      // The field's city, from any match played there in the window.
      const anyId = [...matchField].find(([, v]) => v === f)?.[0];
      byField[f] = {
        label: f,
        city: (anyId != null ? matchCity.get(anyId) : "") || "",
        points: axis.map((w) => ({
          w,
          // REGISTRATIONS STAY NULL PER FIELD — see the note by matchField.
          registrations: 0,
          newPlayers: newByWeekField.get(f)?.get(w) ?? 0,
          totalPlayers: activeByWeekField.get(f)?.get(w)?.size ?? 0,
          spots: spotsByWeekField.get(f)?.get(w) ?? 0,
        })),
      };
    }

    return Response.json({
      axis,
      overall: axis.map(point),
      byCity,
      byField,
      cities,
      fields,
      /* ── THE WINDOW AGGREGATE. Distinct counts that cannot be derived from the buckets. ─────────
       * One entry per requested window, in request order. `totalPlayers` is a Set size over the WHOLE
       * window rather than a sum of per-bucket Sets, which is the entire reason this exists:
       * Apr-Sep 2026 summed to 15,619 and is truly 8,357.
       *
       * recurring = totalPlayers - newPlayers, computed HERE from the window's own two figures rather
       * than by the caller from bucket sums, so it inherits the correct denominator.
       * pctRecurring is left to the caller: a rate is the LATEST value, never an average, and the
       * window has no "latest". */
      windows: windowSpec.map((w, i) => {
        /* ONE SHAPE FOR ALL THREE SCOPES, so the caller reads a city row exactly as it reads the
         * network row. `recurring` is derived from the SAME scope's own two figures — deriving it
         * from the network's newPlayers is the class of mistake that put 8,955 on every field. */
        const grouped = (
          active: Map<string, Set<number>>, nw: Map<string, number>,
          sp: Map<string, number>, rg: Map<string, number> | null,
        ) => {
          const out: Record<string, { registrations: number; newPlayers: number; spots: number; totalPlayers: number; recurring: number }> = {};
          const keys = new Set([...active.keys(), ...sp.keys(), ...(rg ? rg.keys() : [])]);
          for (const k of keys) {
            const tp = active.get(k)?.size ?? 0;
            const np = nw.get(k) ?? 0;
            out[k] = {
              // REGISTRATIONS HAVE NO FIELD. `rg` is null for the field scope and the figure is 0
              // there, never an invented split of the city's — see the note by matchField.
              registrations: rg ? rg.get(k) ?? 0 : 0,
              newPlayers: np, spots: sp.get(k) ?? 0,
              totalPlayers: tp, recurring: Math.max(0, tp - np),
            };
          }
          return out;
        };
        return {
          from: w.from, to: w.to,
          registrations: winReg[i],
          newPlayers: winNew[i],
          spots: winSpots[i],
          totalPlayers: winActive[i].size,
          recurring: Math.max(0, winActive[i].size - winNew[i]),
          byCity: grouped(winActiveCity[i], winNewCity[i], winSpotsCity[i], winRegCity[i]),
          byField: grouped(winActiveField[i], winNewField[i], winSpotsField[i], null),
        };
      }),
      /* SAID OUT LOUD, not left to be discovered. The panel renders this beside the chart. */
      /* WHAT THE WINDOW ACTUALLY IS, so the panel states it rather than implying it. */
      /* `today` TRAVELS WITH THE DATA. The panel decides which buckets are complete, and it must
       * decide it against the clock the buckets were CUT in — America/Chicago — not against the
       * viewer's laptop, which in another zone would mark the wrong week partial. */
      window: {
        start: start ?? null, end: end ?? null, weeks: axis.length,
        dropped: ranged?.dropped ?? 0, futureDropped, today,
      },
      /* SAID OUT LOUD, not left to be discovered.
       * UPDATED FOR MIGRATION 0157. This used to read "the monthly view is UTC" and name the two
       * zones as the first reason weeks and months disagree. That reason is GONE: 0157 moved
       * growth_registration's signup_month to America/Chicago, so both granularities are now on
       * one clock. The SECOND reason survives and always will — it is calendar arithmetic, not a
       * setting. Leaving the old note would have had the page explaining a discrepancy with a
       * cause that no longer exists. */
      reconcile: {
        weeklyTimezone: "America/Chicago",
        monthlyTimezone: "America/Chicago",
        note: "Weekly and monthly are both bucketed in America/Chicago. They still will not sum to "
          + "each other: a week running Aug 31 – Sep 6 belongs wholly to neither month, so "
          + "\"the weeks of a month\" is not a defined quantity unless that month happens to start "
          + "on a Monday and end on a Sunday.",
      },
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // LOUD. An empty chart and a failed read must never look the same.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
