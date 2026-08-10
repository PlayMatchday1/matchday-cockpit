// Env-EXPLICIT MatchDay match editor data + partial write. The environment is in
// the PATH (/api/matchday/staging/... or /api/matchday/production/...) and passed
// to the guarded client per call — no default, no ambient switch. The drawer uses
// the production variant; the guarded client's host allowlist, deny-lists and
// production bolt still apply. Production PUT is a proven PARTIAL update (Phase 9),
// so the client sends only the changed keys.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, StageHostGuardError, StageConfigError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { EDITABLE_KEYS } from "@/lib/matchEditModel";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";

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
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
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
    let managers: { id: number; name: string }[] = [];
    if (cityId != null) {
      const raw = await apiGet<unknown>(env, `/city-managers/users`, { cityId: cityId as number }).catch(() => []);
      const arr = Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? []);
      managers = (arr as Record<string, unknown>[]).map((u) => ({
        id: u.id as number,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || `User ${u.id}`,
      }));
    }
    return Response.json({ match: pickMatch(match), fields: fieldList, players: players ?? [], managers });
  } catch (e) {
    return errToResponse(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { changes?: Record<string, unknown>; source?: string; saveId?: string } | null;
  const changes = body?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return Response.json({ error: "changes object required" }, { status: 400 });
  const keys = Object.keys(changes);
  if (keys.length === 0) return Response.json({ error: "no changes to apply" }, { status: 400 });
  const illegal = keys.filter((k) => !WRITABLE.has(k));
  if (illegal.length) return Response.json({ error: `not editable: ${illegal.join(", ")}` }, { status: 400 });
  const dateKeys = keys.filter((k) => DATE_PAIR.has(k));
  if (dateKeys.length === 1) return Response.json({ error: "startDate and endDate must be sent together (the pair preserves duration)" }, { status: 400 });

  // EDIT MATCHES check — before ANY MatchDay read or write, so a read-only user
  // produces zero network calls (the guarded client enforces the same, unbypassably).
  if (!auth.canEditMatches) {
    console.warn(`[edit-matches] 403: ${auth.email} attempted PUT /admin/matches/${id} without EDIT MATCHES`);
    return Response.json({ error: "You have read-only Match Ops access. EDIT MATCHES is required to change matches." }, { status: 403 });
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
    return Response.json({ ok: true, outcome, logRecorded: logged, match: pickMatch(cached) });
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
