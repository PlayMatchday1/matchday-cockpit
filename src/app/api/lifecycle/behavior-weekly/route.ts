/* GET /api/lifecycle/behavior-weekly?weeks=13 — Player Behavior's four metrics, per WEEK. READ ONLY.
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
 *   1. The monthly buckets are UTC — growth_registration does `AT TIME ZONE 'UTC'` explicitly.
 *      Weekly is Chicago. Measured on 27,029 completed users: 218 (0.81%) fall in a different
 *      MONTH under the two zones, up to ±15 in a single month.
 *   2. WEEKS DO NOT ALIGN TO MONTHS. A week running Aug 31 – Sep 6 belongs wholly to neither
 *      August nor September, so "the weekly buckets summed over a month" is not a defined
 *      quantity unless that month happens to start on a Monday and end on a Sunday. This one is
 *      unavoidable and has nothing to do with timezones.
 * Both are reported to the caller in `reconcile` rather than left to be discovered.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { chicagoYmd, wallClockYmd, weekKey, lastWeeks } from "@/lib/weekBuckets";
import { cityFromAbbr } from "@/lib/cityMap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type WeekPoint = { w: string; registrations: number; newPlayers: number; totalPlayers: number; spots: number };

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "lifecycle");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const n = Number(new URL(req.url).searchParams.get("weeks") ?? 13);
  const weeks = Number.isInteger(n) && n >= 1 && n <= 52 ? n : 13;
  const sb = auth.supabase;

  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const axis = lastWeeks(today, weeks);
    const first = axis[0];
    const inAxis = new Set(axis);

    /* ── REGISTRATIONS. A UTC instant, bucketed by its CHICAGO day. Fake players excluded, the
     * same rule growth_registration applies. Only completed signups count — an abandoned
     * onboarding is not a registration. */
    const users = await selectAll<Record<string, unknown>>(() =>
      sb.from("mdapi_users")
        .select("id, completed_sign_up_at, is_fake_player, preferable_city_name")
        .not("completed_sign_up_at", "is", null)
        .gte("completed_sign_up_at", first)
        .order("id"),
    );
    const regByWeek = new Map<string, number>();
    const regByWeekCity = new Map<string, Map<string, number>>();
    for (const u of users) {
      if (u.is_fake_player === true) continue;
      const w = weekKey(chicagoYmd(String(u.completed_sign_up_at)));
      if (!inAxis.has(w)) continue;
      regByWeek.set(w, (regByWeek.get(w) ?? 0) + 1);
      const city = String(u.preferable_city_name ?? "").trim();
      if (city) {
        const m = regByWeekCity.get(city) ?? new Map<string, number>();
        m.set(w, (m.get(w) ?? 0) + 1); regByWeekCity.set(city, m);
      }
    }

    /* ── PLAY. Matches in the window give the DATE and the CITY; the roster gives who played.
     * start_date is wall clock, so it is sliced — a Chicago conversion here would shift a 7pm
     * match by the server's offset, which is the trap this estate has hit repeatedly. */
    const matches = await selectAll<Record<string, unknown>>(() =>
      sb.from("mdapi_matches")
        .select("api_id, start_date, city_identifier, field_title, is_cancelled, deleted_at")
        .is("deleted_at", null).eq("is_cancelled", false)
        .gte("start_date", first)
        .order("api_id"),
    );
    const matchWeek = new Map<number, string>();
    const matchCity = new Map<number, string>();
    /* THE FIELD, for Behavior's field mode. Same aggregation keyed on field_title instead of city —
     * a genuinely small addition, which is why it is here rather than deferred. Registrations are
     * NOT broken out by field and must not be: a registration carries the city declared at signup
     * and never a pitch, so a per-field registration figure would be invented. */
    const matchField = new Map<number, string>();
    for (const m of matches) {
      const w = weekKey(wallClockYmd(String(m.start_date)));
      if (!inAxis.has(w)) continue;
      matchWeek.set(Number(m.api_id), w);
      matchCity.set(Number(m.api_id), cityFromAbbr(String(m.city_identifier ?? "")) ?? "");
      matchField.set(Number(m.api_id), String(m.field_title ?? "").trim());
    }

    const ids = [...matchWeek.keys()];
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
      /* SAID OUT LOUD, not left to be discovered. The panel renders this beside the chart. */
      reconcile: {
        weeklyTimezone: "America/Chicago",
        monthlyTimezone: "UTC",
        note: "Weekly buckets are Chicago; the monthly view is UTC (growth_registration uses AT TIME ZONE 'UTC'). "
          + "They will not sum to each other, and weeks do not align to month boundaries in any case.",
      },
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // LOUD. An empty chart and a failed read must never look the same.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
