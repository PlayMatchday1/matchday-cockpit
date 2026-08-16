// Phase 25 Part B — the CITY MANAGER's week. The only route on the city-manager gate.
//
// SCOPE IS SERVER-SIDE, ON THE READ AND ON THE WRITE. The city comes from the authenticated
// app_users row, never from a query param, and it is pushed INTO the mdapi_matches query
// (computeManagerPayForWeek's `city` option) so another city's payroll is never in the response
// body at all. Hiding rows in the UI is not scoping.
//
// GET  ?week=YYYY-MM-DD  → that week for THIS city only, plus the managers who can be assigned in
//                          it, plus whether the signed-in account could be matched to a manager.
// POST { matchId, managerId|null } → reassign ONE match's manager. Refuses a match in another city
//                          (403, by name), refuses a cancelled match, refuses a co-managed match.
//                          recordWrite'd, then re-read: LANDED / NOT APPLIED, never a bare 2xx.

import { randomUUID } from "node:crypto";
import { getArrivalInfo } from "@/lib/managerPayArrival";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCityManager, assertCityScope } from "@/lib/cityManagerAuth";
import { computeManagerPayForWeek, ISO_DATE_RX, weekdayUtc } from "@/lib/managerPayCompute";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ENV = "production" as const;

// The managers who can be assigned in this city. Derived from who has actually managed here over a
// trailing window of THIS CITY's matches — server-scoped by construction.
//
// STATED LIMITATION: this is the roster of people who have worked in the city, not the MatchDay
// city-manager directory (`GET /city-managers/users?cityId=`). That endpoint is keyed by a numeric
// cityId which app_users does not carry — we hold `city_identifier` ("DFW"), and no mapping table
// exists. Consequence: a manager who has never worked a match in this city cannot be picked yet.
async function cityManagerOptions(supabase: SupabaseClient, city: string, weekStart: string) {
  const from = new Date(`${weekStart}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 84); // 12 weeks back
  const { data } = await supabase
    .from("mdapi_matches")
    .select("manager_id, manager_email, manager_first_name, manager_last_name")
    .eq("city_identifier", city)
    .is("deleted_at", null)
    .gte("start_date", from.toISOString().slice(0, 10))
    .not("manager_id", "is", null);
  const seen = new Map<number, { id: number; name: string; email: string | null }>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const id = Number(r.manager_id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    const name = [r.manager_first_name, r.manager_last_name].filter(Boolean).join(" ").trim() || `Manager ${id}`;
    seen.set(id, { id, name, email: (r.manager_email as string | null) ?? null });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function GET(req: Request) {
  const auth = await authenticateCityManager(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  // A ?city= naming ANY other city is REFUSED, not quietly ignored — editing the param must not
  // read as "there is nothing here", it must read as "you may not ask that".
  const scope = assertCityScope(auth.cityIdentifier, url.searchParams.get("city"));
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });

  const week = (url.searchParams.get("week") ?? "").trim();
  if (!ISO_DATE_RX.test(week)) return Response.json({ error: "week must be YYYY-MM-DD" }, { status: 400 });
  if (weekdayUtc(week) !== 1) return Response.json({ error: "week must be a Monday" }, { status: 400 });

  try {
    const payload = await computeManagerPayForWeek(auth.supabase, week, { isAdmin: true, city: auth.cityIdentifier });
    const city = payload.cities.find((c) => c.cityIdentifier === auth.cityIdentifier) ?? null;
    const managers = await cityManagerOptions(auth.supabase, auth.cityIdentifier, week);

    // THE EMAIL-ONLY JOIN, MADE LOUD. Pay accumulates on lower(manager_email) and there is no id
    // fallback, so a manager whose MatchDay email differs from their Clubhouse login silently looks
    // like someone who worked nothing. Say so on the page instead.
    const mine = (city?.managers ?? []).find((m) => (m.managerEmail ?? "").toLowerCase() === auth.email.toLowerCase()) ?? null;
    const everWorkedHere = managers.some((m) => (m.email ?? "").toLowerCase() === auth.email.toLowerCase());

    // THE SAME PAY-RUN AND ARRIVAL THE ADMIN BAR SHOWS. Read-only here: a city manager sees when
    // the money runs and when it should land, and cannot move either — pay-arrival is admin-gated,
    // so the write is refused at the route regardless of what the page renders.
    const arrival = await getArrivalInfo(auth.supabase, week);

    return Response.json({
      weekStart: payload.weekStart, weekEnd: payload.weekEnd, payDate: payload.payDate,
      payRun: arrival.payRun,
      effectiveArrival: arrival.effectiveArrival,
      arrivalError: arrival.arrivalError,
      arrivalOverride: arrival.override,
      cityIdentifier: auth.cityIdentifier,
      city, managers,
      you: {
        email: auth.email,
        matched: !!mine,
        // Distinguishes "you worked nothing this week" (fine) from "we cannot match your login at
        // all" (a data problem the operator must be told about).
        unmatchedAccount: !mine && !everWorkedHere,
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateCityManager(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as { matchId?: number; managerId?: number | null; saveId?: string; source?: string } | null;
  const matchId = Number(body?.matchId);
  if (!Number.isFinite(matchId)) return Response.json({ error: "matchId required" }, { status: 400 });
  const managerId = body?.managerId === null || body?.managerId === undefined ? null : Number(body.managerId);
  if (managerId !== null && !Number.isFinite(managerId)) return Response.json({ error: "managerId must be a number or null" }, { status: 400 });

  // THE REFUSAL THAT MATTERS. Read the match's OWN city from our synced table and compare it to the
  // caller's scope. A city manager who edits the match id in the request is refused by name here,
  // BEFORE any MatchDay call — not merely absent from their UI.
  const { data: mrow, error: mErr } = await auth.supabase
    .from("mdapi_matches")
    .select("api_id, city_identifier, is_cancelled, manager_id, second_manager_id, name, field_title, start_date, max_player_count")
    .eq("api_id", matchId)
    .is("deleted_at", null)
    .maybeSingle();
  if (mErr) return Response.json({ error: mErr.message }, { status: 500 });
  if (!mrow) return Response.json({ error: "That match is not in your city." }, { status: 403 });
  const scope = assertCityScope(auth.cityIdentifier, (mrow.city_identifier as string | null) ?? null);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });

  // A cancelled match pays nobody, so assigning one is meaningless — refused on PAY grounds.
  if (mrow.is_cancelled === true) {
    return Response.json({ error: "This match was cancelled, so it pays nobody." }, { status: 409 });
  }
  // CO-MANAGED: two managers are paid and mdapi_matches carries no second_manager_email, so a
  // single dropdown cannot express which of the two is changing. Refuse rather than silently edit
  // half of a two-manager match — that is a payroll error with no visible cause.
  if (mrow.second_manager_id != null) {
    return Response.json({ error: "This match has two managers. Message MatchDay to change either one." }, { status: 409 });
  }

  const actor = {
    canEditMatches: false,          // a city manager holds NO edit-matches grant, and must not
    cityScope: auth.cityIdentifier, // the fourth authority: one field, one city
    email: auth.email,
    userId: auth.appUserId,
  };
  const before = (mrow.manager_id as number | null) ?? null;

  try {
    const { outcome, error, logged } = await recordWrite(
      {
        env: ENV, source: body?.source || "City manager · assign",
        actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(), matchId, matchName: (mrow.name as string | null) ?? null,
        method: "PUT", path: `/admin/matches/${matchId}`,
        body: { managerId },
        keys: [], label: (k) => k,
        changes: [{ key: "managerId", field: "Manager", before, after: managerId }],
        applied: (_b, a) => ((a.match as Record<string, unknown> | undefined)?.managerId ?? null) === managerId,
      },
      {
        readResource: async () => {
          const m = await apiGet<Record<string, unknown>>(ENV, `/admin/matches/${matchId}`).catch(() => ({} as Record<string, unknown>));
          return { match: m };
        },
        write: () => apiWrite(ENV, "PUT", `/admin/matches/${matchId}`, { managerId }, actor, "city"),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    // A 2xx IS NOT PROOF — re-read and classify from the match's own manager id.
    const after = await apiGet<Record<string, unknown>>(ENV, `/admin/matches/${matchId}`).catch(() => null);
    const landed = ((after?.managerId as number | null) ?? null) === managerId;
    return Response.json({
      ok: true, outcome, logRecorded: logged, landed,
      status: landed ? "LANDED" : "NOT APPLIED",
      matchId, managerId,
    });
  } catch (e) {
    return errToResponse(e);
  }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
