// Env-EXPLICIT MatchDay match editor data + partial write. The environment is in
// the PATH (/api/matchday/staging/... or /api/matchday/production/...) and passed
// to the guarded client per call — no default, no ambient switch. The drawer uses
// the production variant; the guarded client's host allowlist, deny-lists and
// production bolt still apply. Production PUT is a proven PARTIAL update (Phase 9),
// so the client sends only the changed keys.

import { randomUUID } from "node:crypto";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { authenticateMatchOpsRead, assertMatchInScope } from "@/lib/matchOpsAuth"; // GET is a Match Ops READ (Part D round 2); PUT stays admin + EDIT MATCHES
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, StageHostGuardError, StageConfigError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { EDITABLE_KEYS } from "@/lib/matchEditModel";
import { realOccupancyFromRoster, rosterRowCounts, type RosterRow } from "@/lib/gamedayModel";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
// The refusal wording lives with the rule (matchEditAccess.ts) so the panel and this route cannot
// say different things about the same denial. The GATE below is unchanged.
import { NO_EDIT_MATCHES } from "@/lib/matchEditAccess";
import { refreshMatchMirror, tombstoneMatchMirror } from "@/lib/mirrorWriteThrough";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const EDITABLE = new Set<string>(EDITABLE_KEYS);
const DATE_PAIR = new Set<string>(["startDate", "endDate"]);
const WRITE_ONLY = new Set<string>(["teamNumbers"]); // accepted on write, absent from GET
const WRITABLE = new Set<string>([...EDITABLE, ...DATE_PAIR, ...WRITE_ONLY]);
const READONLY = ["id", "startDate", "endDate", "isCancelled", "teams"];

function isEnv(x: string): x is MatchdayEnv { return x === "staging" || x === "production"; }

function pickMatch(m: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE) out[k] = m[k] ?? null;
  for (const k of READONLY) out[k] = m[k] ?? null;
  const field = (m.field ?? {}) as Record<string, unknown>;
  const city = (field.city ?? {}) as Record<string, unknown>;
  out.fieldTitle = (field.title as string | undefined)?.trim() ?? null;
  out.cityName = (city.name as string | undefined) ?? null;
  out.cityId = (city.id as number | undefined) ?? null;
  out.manager = m.manager ?? null;
  out.secondManager = m.secondManager ?? null;
  // Authoritative occupancy — the API's own count of who is IN the match (real + fake),
  // the same number gameday/the drawer use. NOT players.length (which includes cancelled
  // user-match rows and reads as over-capacity). Editor headlines this against the cap.
  out.occupancy = (m._count as Record<string, unknown> | undefined)?.players ?? null;
  return out;
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;

  // THE BOUNDARY ON THE ID ITSELF — filtering a list is not authorisation. See assertMatchInScope.
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  try {
    const [match, fields, players] = await Promise.all([
      apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`),
      apiGet<unknown[]>(env, `/admin/fields`).catch(() => []),
      apiGet<unknown[]>(env, `/admin/matches/${id}/players`).catch(() => []),
    ]);
    const fieldList = (fields as Record<string, unknown>[]).map((f) => ({
      id: f.id as number, title: (f.title as string | undefined)?.trim() ?? `Field ${f.id}`,
      city: ((f.city as Record<string, unknown> | undefined)?.name as string | undefined) ?? null,
    }));
    // The match's city managers (for the manager dropdown). GET /city-managers/users
    // — NO /admin prefix, but still Bearer-authenticated. Only id + name are passed
    // to the client (no email/phone).
    const cityId = ((match.field as Record<string, unknown> | undefined)?.city as Record<string, unknown> | undefined)?.id;
    const toOptions = (raw: unknown) => {
      const arr = Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? []);
      return (arr as Record<string, unknown>[]).map((u) => ({
        id: u.id as number,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || `User ${u.id}`,
      }));
    };
    /* TWO LISTS, AND THE SECOND ONE IS THE ESCAPE. The city list is the default — a typical Austin
     * fixture offers 28 of the 87. The full roster is fetched alongside it so "show all cities"
     * is instant and so the CURRENT manager always has a name even when they have since come off
     * this city's roster. A manager covering a one-off outside their listed cities is real;
     * silently hiding them turns a real assignment into an impossible one.
     *
     * Same endpoint, no cityId. Only id + name cross to the client — never email or phone. */
    const [managers, managersAllCities] = await Promise.all([
      cityId != null
        ? apiGet<unknown>(env, `/city-managers/users`, { cityId: cityId as number }).then(toOptions).catch(() => [])
        : Promise.resolve([] as { id: number; name: string }[]),
      apiGet<unknown>(env, `/city-managers/users`).then(toOptions).catch(() => []),
    ]);
    const picked = pickMatch(match);
    // REAL active players (excl fakes AND cancelled) for the fakeSpotLeft ceiling math. Derived from
    // the ROSTER because the detail _count has only { players } — no fakePlayers (proven on prod).
    picked.realOccupancy = realOccupancyFromRoster(Number(picked.occupancy) || 0, (players ?? []) as RosterRow[]);
    return Response.json({ match: picked, fields: fieldList, players: players ?? [], managers, managersAllCities });
  } catch (e) {
    return errToResponse(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;

  // THE SAME BOUNDARY ON THE WRITE PATH. A confined account must not act on a match it was never
  // shown — and the list it was shown is a post-fetch filter, not a permission.
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { changes?: Record<string, unknown>; source?: string; saveId?: string } | null;
  const changes = body?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return Response.json({ error: "changes object required" }, { status: 400 });
  const keys = Object.keys(changes);
  if (keys.length === 0) return Response.json({ error: "no changes to apply" }, { status: 400 });
  const illegal = keys.filter((k) => !WRITABLE.has(k));
  if (illegal.length) return Response.json({ error: `not editable: ${illegal.join(", ")}` }, { status: 400 });
  /* ── A LONE startDate IS REFUSED. A LONE endDate IS NOT. ─────────────────────────────────────
   * This was "the pair is all-or-nothing", carried from Phase 7 with no measurement behind it,
   * and it REFUSED A LEGITIMATE SAVE: an end-time edit changes the length and nothing else, so the
   * diff is `{ endDate }` and the diff IS the body. Editing production 18292's end time hit
   * "startDate and endDate must be sent together".
   *
   * MEASURED on staging 2026-08-31, one throwaway match, two writes:
   *   lone endDate   -> start 18:00 unchanged, end 19:00 -> 20:00. Landed, startDate untouched.
   *                     (matchWhen.ts already recorded the same on staging 2560.)
   *   lone startDate -> start 18:00 -> 16:00 and the END STAYED at 20:00. The duration went from
   *                     two hours to four, silently. The server does NOT carry the end with it.
   *
   * So the guard was right about one half and wrong about the other. A lone startDate is a silent
   * duration change and stays refused; a lone endDate is exactly what the control produces.
   *
   * AND IT IS NOT PADDED. Sending an unchanged startDate alongside would make the body stop being
   * the diff, which is the rule this guard was breaking in the first place. */
  const dateKeys = keys.filter((k) => DATE_PAIR.has(k));
  if (dateKeys.length === 1 && dateKeys[0] === "startDate") {
    return Response.json({
      error: "A start-time change must send endDate too — measured: the server leaves the end where it is, so the duration would change silently.",
    }, { status: 400 });
  }

  // EDIT MATCHES check — before ANY MatchDay read or write, so a read-only user
  // produces zero network calls (the guarded client enforces the same, unbypassably).
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted PUT /admin/matches/${id} without EDIT MATCHES`);
    return Response.json({ error: NO_EDIT_MATCHES }, { status: 403 });
  }
  const actor = { canEditMatches: auth.canEditMatches, email: auth.email, userId: auth.appUserId };

  try {
    // Every match write goes through the SHARED log hook (Phase 16): read the match
    // before, write, read after, classify, record ONE entry. Three round trips, one
    // cached so a name lookup does not add a fourth. Logging is best-effort and never
    // throws over the write.
    let cached = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`); // before + name
    let reads = 0;
    const { outcome, error, logged } = await recordWrite(
      {
        env, source: body?.source || "Match editor", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(), matchId: Number(id), matchName: (cached.name as string) ?? null,
        method: "PUT", path: `/admin/matches/${id}`, body: changes, keys, label: (k) => k,
      },
      {
        readResource: async () => { if (reads++ === 0) return cached; cached = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`); return cached; },
        write: () => apiWrite(env, "PUT", `/admin/matches/${id}`, changes, actor),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    // WRITE THROUGH TO THE MIRROR. Extracted to mirrorWriteThrough.ts when manager assignment
    // needed the same thing — one implementation, one set of rules (production only, LANDED only,
    // the read-back value, best-effort). `cached` is recordWrite's own after-read.
    const mirror = await refreshMatchMirror(auth.supabase, env, Number(id), keys, cached, outcome);

    /* THE WRITE-THROUGH'S RESULT IS REPORTED, NOT SWALLOWED. It stays best-effort — the MatchDay
     * write already landed and a mirror hiccup must never be reported as a failed edit — but the
     * caller is told, because the alternative is the operator seeing a stale row and no reason.
     * `reason` distinguishes the three cases that are NOT failures: staging (the mirror holds
     * production ids), a non-landed outcome, and an edit that touched only unmirrored fields. */
    return Response.json({
      ok: true, outcome, logRecorded: logged, match: pickMatch(cached),
      mirrored: mirror.refreshed, mirrorReason: mirror.reason ?? null,
    });
  } catch (e) {
    return errToResponse(e);
  }
}

/* ── DELETE A CANCELLED MATCH ─────────────────────────────────────────────────────────────────
 *
 * Ryan: "in retool we have this removed cancelled match for deleting matches so they dont show as
 * cancelled. For instance we dont have the reservation or something changed. We dont want it
 * counting as a cancelled match because it confuses the data."
 *
 * WHAT RETOOL DOES, read out of retool-export-prod.json rather than guessed: a DELETE against
 * /admin/matches/{selectedRow.id} with requireConfirmation FALSE. One click, no confirm, no roster
 * check. It relies entirely on the operator having used "Remove Player From Match" first.
 *
 * THIS ROUTE CHECKS INSTEAD OF RELYING. Four refusals before any upstream call, in this order:
 *
 *   1. EDIT MATCHES, the same capability the PUT above uses. Not a new grant.
 *   2. The match is in the caller's city. assertMatchInScope, same as the PUT: filtering a list is
 *      not authorisation and a confined account must not act on an id it was never shown.
 *   3. The match is CANCELLED. A live match can never be deleted here. The panel renders no control
 *      at all on one, and this refuses it anyway, because a UI check is not a rule.
 *   4. The match has NO PLAYERS ATTACHED, counted from the live roster and refused WITH the count.
 *      A cancelled match can still carry a roster, and deleting one destroys a player's record of a
 *      match they were refunded for.
 *
 * THE UPSTREAM DELETE IS HARD. Proven on staging 2609 before this was written: after DELETE the
 * match is gone from /admin/matches (45 rows to 44) and a by-id read 404s. That matters because
 * mdapiMatchesSync's mapMatchToRow sets deleted_at: null on EVERY upsert, deliberately, so a match
 * that came back upstream would clear our tombstone. It cannot come back, so it cannot.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCapability(req, "editMatches");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;

  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, id);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });

  try {
    /* READ THE MATCH FIRST, and refuse on what it says rather than on what the caller claims. */
    const match = await apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`);
    if (match?.isCancelled !== true) {
      return Response.json({
        error: "This match is not cancelled. Only a cancelled match can be deleted, and cancelling is a different act with its own confirmation.",
      }, { status: 409 });
    }

    /* THE ROSTER, COUNTED. rosterRowCounts is the one predicate for "this row occupies a spot" and
     * is used here rather than _count.players so the refusal can name a number the operator can go
     * and act on. */
    const roster = await apiGet<RosterRow[]>(env, `/admin/matches/${id}/players`).catch(() => [] as RosterRow[]);
    const attached = (Array.isArray(roster) ? roster : []).filter(rosterRowCounts).length;
    if (attached > 0) {
      return Response.json({
        error: `${attached} player${attached === 1 ? " is" : "s are"} still attached to this match. Deleting it would destroy their record of a match they were refunded for. Remove them from the match first.`,
        players: attached,
      }, { status: 409 });
    }

    const field = (match.field ?? {}) as Record<string, unknown>;
    const label = `${(field.title as string) ?? "unknown field"} · ${String(match.startDate ?? "").slice(0, 16)}`;
    const readBack = async (): Promise<Record<string, unknown>> => {
      /* THE VERDICT IS A 404. A destroyed match is not "a match with a flag"; the only honest
       * read-back is that the upstream record has stopped existing. */
      try { await apiGet(env, `/admin/matches/${id}`); return { present: true }; }
      catch { return { present: false }; }
    };

    const { outcome, error, logged } = await recordWrite(
      {
        env, source: "Master Schedule · delete cancelled match",
        actorName: auth.email, actorEmail: auth.email,
        saveId: randomUUID(), matchId: Number(id), matchName: (match.name as string) ?? null,
        method: "DELETE", path: `/admin/matches/${id}`,
        body: { id: Number(id) }, keys: [], label: (k) => k,
        applied: (_b, a) => a.present === false,
        changes: [
          { key: "deleted", field: "Match deleted in MatchDay", before: label, after: "— (destroyed, cannot be restored)" },
          { key: "was_cancelled", field: "Was cancelled", before: true, after: "— (row gone)" },
          { key: "players", field: "Players attached at delete", before: 0, after: 0 },
        ],
      },
      {
        readResource: readBack,
        write: async () => apiWrite(
          env, "DELETE", `/admin/matches/${id}`, undefined,
          { canEditMatches: true, email: auth.email },
          "edit",
          /* THE ONE UNLOCKED CALL SITE IN THE CODEBASE. scripts/write-routes-logged-test.ts asserts
           * there is exactly one and that it is this file. */
          "delete-match",
        ),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );

    if (error) return errToResponse(error);
    if (outcome !== "landed") {
      return Response.json({ error: `The delete did not confirm (${outcome}). Nothing was retried.`, outcome }, { status: 502 });
    }

    /* THE MIRROR, IN THE SAME OPERATION. Without this the grid and every count that reads
     * mdapi_matches keep showing the match until a sync pass, and the number moving is the whole
     * point of the feature. Production only: the mirror holds production ids. */
    const mirror = await tombstoneMatchMirror(auth.supabase, env, Number(id));

    return Response.json({
      ok: true, outcome, logRecorded: logged,
      tombstoned: mirror.tombstoned, mirrorReason: mirror.reason ?? null,
      deleted: Number(id),
    });
  } catch (e) {
    return errToResponse(e);
  }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: `Production writes are bolted: ${e.message}` }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: `Host guard blocked the write: ${e.message}` }, { status: 500 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: `AMBIGUOUS: ${e.message}`, ambiguous: true }, { status: 502 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
