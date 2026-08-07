// Admin, STAGING-only match read + rename. GET returns a match's identity + name;
// PUT renames it. The write goes through the guarded staging client
// (matchdayStageApi) so it physically cannot reach production, and the client may
// change ONLY the name: the server re-reads the match, projects it down to the
// writable field allowlist, and applies the new name itself — the browser never
// supplies the rest of the body.
//
// Why the projection: PUT /admin/matches/{id} is whitelist-validated
// (forbidNonWhitelisted) — echoing the full GET back 400s on ~22 read-only /
// relational fields (id, field, players, goals, updatedAt, …). We send exactly
// the fields the DTO accepts, with their current values, so nothing else moves.

import { authenticateAdmin } from "@/lib/adminAuth";
import { stageGet, stageWrite, AmbiguousWriteError, WriteFailedError, StageHostGuardError, StageConfigError } from "@/lib/matchdayStageApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The UpdateMatchDto whitelist — every field the PUT accepts, learned from the
// live 400. The server sends these (current values) + the new name; nothing else.
const WRITABLE_MATCH_FIELDS = [
  "name", "description", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore",
  "type", "startDate", "endDate", "fieldId", "category", "minPlayerCount", "maxPlayerCount",
  "isFreeMember", "registrationPrice", "hasOrganizer", "managerIntro", "managerId",
  "secondManagerId", "guestCount", "autoCanceled", "autoCanceledMinutes", "maxTeamSize2Team",
  "maxTeamSize4Team", "isAutoBump", "additionalSpotPrice",
  "fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h",
  "teams",
] as const;

function projectWritable(match: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WRITABLE_MATCH_FIELDS) if (k in match) out[k] = match[k];
  return out;
}

// The read-only identity we show the admin — enough to be sure it's the right match.
function identity(m: Record<string, unknown>) {
  const field = (m.field ?? {}) as Record<string, unknown>;
  const city = (field.city ?? {}) as Record<string, unknown>;
  return {
    id: m.id, name: m.name, startDate: m.startDate, type: m.type, category: m.category,
    isCancelled: m.isCancelled, fieldTitle: (field.title as string | undefined)?.trim() ?? null,
    cityName: (city.name as string | undefined) ?? null,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  try {
    const match = await stageGet<Record<string, unknown>>(`/admin/matches/${id}`);
    return Response.json({ match: identity(match) });
  } catch (e) {
    return errToResponse(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (name.length > 200) return Response.json({ error: "name too long" }, { status: 400 });

  try {
    // Read-modify-write: re-read, project to the writable allowlist, set only name.
    const current = await stageGet<Record<string, unknown>>(`/admin/matches/${id}`);
    const payload = { ...projectWritable(current), name };
    await stageWrite("PUT", `/admin/matches/${id}`, payload);
    const after = await stageGet<Record<string, unknown>>(`/admin/matches/${id}`);
    return Response.json({ ok: true, match: identity(after) });
  } catch (e) {
    return errToResponse(e);
  }
}

function errToResponse(e: unknown): Response {
  // Surface the guard / ambiguity distinctly so the operator knows the risk.
  if (e instanceof StageHostGuardError) return Response.json({ error: `Host guard blocked the write: ${e.message}` }, { status: 500 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: `AMBIGUOUS: ${e.message}`, ambiguous: true }, { status: 502 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
