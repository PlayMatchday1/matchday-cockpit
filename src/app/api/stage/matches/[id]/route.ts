// Admin, STAGING-only match editor data + partial write. GET returns the match's
// editable field values, the identity, the fields list (for the Field select) and
// the roster (read-only this phase). PUT takes a PARTIAL { changes } body and
// forwards ONLY those keys through the host-guarded staging client.
//
// PUT /admin/matches/{id} is a proven PARTIAL update: it leaves omitted fields
// untouched. So the client sends exactly the fields the user changed — nothing
// it did not touch is sent, nothing it did not touch can be overwritten. The
// server independently allowlists the keys (EDITABLE) so a bad client can't push
// a non-editable field (startDate, scores, id, teams — team edits are a separate
// endpoint) even if it tried.

import { authenticateAdmin } from "@/lib/adminAuth";
import { stageGet, stageWrite, AmbiguousWriteError, WriteFailedError, StageHostGuardError, StageConfigError } from "@/lib/matchdayStageApi";
import { EDITABLE_KEYS } from "@/lib/matchEditModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Same allowlist the editor + tests use — one source (matchEditModel).
const EDITABLE = new Set<string>(EDITABLE_KEYS);
// PHASE 7: the date PAIR is writable but is NOT a general editable field (the
// full editor has no control for it). Only the drawer's date/time control sends
// it, always as a start+end pair (duration preserved). Allowed here in addition
// to EDITABLE so the full editor's field set stays unchanged.
const DATE_PAIR = new Set<string>(["startDate", "endDate"]);
const WRITABLE = new Set<string>([...EDITABLE, ...DATE_PAIR]);
// Read-only values the editor also needs (identity + roster shape).
const READONLY = ["id", "startDate", "endDate", "isCancelled", "teams"];

function pickMatch(m: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE) out[k] = m[k] ?? null;
  for (const k of READONLY) out[k] = m[k] ?? null;
  const field = (m.field ?? {}) as Record<string, unknown>;
  const city = (field.city ?? {}) as Record<string, unknown>;
  out.fieldTitle = (field.title as string | undefined)?.trim() ?? null;
  out.cityName = (city.name as string | undefined) ?? null;
  // Manager relation objects, passed through so the drawer can show a name and
  // flag a deleted/unresolved account WITHOUT ever blanking the stored id.
  out.manager = m.manager ?? null;
  out.secondManager = m.secondManager ?? null;
  return out;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });
  try {
    const [match, fields, players] = await Promise.all([
      stageGet<Record<string, unknown>>(`/admin/matches/${id}`),
      stageGet<unknown[]>(`/admin/fields`).catch(() => []),
      stageGet<unknown[]>(`/admin/matches/${id}/players`).catch(() => []),
    ]);
    const fieldList = (fields as Record<string, unknown>[]).map((f) => ({
      id: f.id as number, title: (f.title as string | undefined)?.trim() ?? `Field ${f.id}`,
      city: ((f.city as Record<string, unknown> | undefined)?.name as string | undefined) ?? null,
    }));
    return Response.json({ match: pickMatch(match), fields: fieldList, players: players ?? [] });
  } catch (e) {
    return errToResponse(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Match id must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { changes?: Record<string, unknown> } | null;
  const changes = body?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return Response.json({ error: "changes object required" }, { status: 400 });
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) return Response.json({ error: "no changes to apply" }, { status: 400 });
  const illegal = keys.filter((k) => !WRITABLE.has(k));
  if (illegal.length) return Response.json({ error: `not editable: ${illegal.join(", ")}` }, { status: 400 });
  // The date pair is all-or-nothing: a lone startDate can silently invert a match
  // against its untouched endDate. The drawer always sends both; enforce it here
  // too so no client can send half a move.
  const dateKeys = keys.filter((k) => DATE_PAIR.has(k));
  if (dateKeys.length === 1) return Response.json({ error: "startDate and endDate must be sent together (the pair preserves duration)" }, { status: 400 });

  try {
    // Partial write — send ONLY the changed keys. Omitted fields are untouched.
    await stageWrite("PUT", `/admin/matches/${id}`, changes);
    const after = await stageGet<Record<string, unknown>>(`/admin/matches/${id}`);
    return Response.json({ ok: true, match: pickMatch(after) });
  } catch (e) {
    return errToResponse(e);
  }
}

function errToResponse(e: unknown): Response {
  if (e instanceof StageHostGuardError) return Response.json({ error: `Host guard blocked the write: ${e.message}` }, { status: 500 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: `AMBIGUOUS: ${e.message}`, ambiguous: true }, { status: 502 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
