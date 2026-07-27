// §2 One-click add + Undo. Turns one or more mdapi matches into ONE-OFF
// schedule_master rows (source='manual') — never recurring, never a MatchDay
// write. Idempotent on the partial UNIQUE(match_api_id) (23505 = no-op).
//
//   POST   { match_api_id }            → add one
//   POST   { match_api_ids: [...] }    → "Add all"
//   DELETE ?match_api_id=123           → Undo (guards source != 'template')
//
// Admin-only via authenticateCrm + required operator email (rejects the
// cron bearer) — the same pattern as the schedule_master CRUD route.

import { authenticateCrm } from "@/lib/crmAuth";
import { buildOneOffRow, loadVenueMaps, type OneOffMatch } from "@/lib/scheduleReconcileServer";

export const runtime = "nodejs";

const MATCH_SELECT =
  "api_id, field_id, field_title, start_date, max_player_count, city_identifier, city_name, raw";

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.email) return Response.json({ error: "Operator session required" }, { status: 403 });
  const { supabase } = auth;

  let body: { match_api_id?: unknown; match_api_ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const raw = Array.isArray(body.match_api_ids)
    ? body.match_api_ids
    : body.match_api_id != null
      ? [body.match_api_id]
      : [];
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) {
    return Response.json({ error: "match_api_id or match_api_ids required" }, { status: 400 });
  }

  const mRes = await supabase.from("mdapi_matches").select(MATCH_SELECT).in("api_id", ids).is("deleted_at", null);
  if (mRes.error) return Response.json({ error: mRes.error.message }, { status: 500 });
  const matches = (mRes.data ?? []) as OneOffMatch[];
  if (matches.length === 0) return Response.json({ error: "No matching mdapi matches" }, { status: 404 });

  const maps = await loadVenueMaps(supabase);

  let added = 0;
  let already = 0;
  const skipped: number[] = [];
  const addedRows: Array<{ id: string; match_api_id: number }> = [];
  for (const m of matches) {
    const row = buildOneOffRow(m, maps, "manual");
    if (!row) {
      skipped.push(m.api_id);
      continue;
    }
    const ins = await supabase.from("schedule_master").insert(row).select("id").maybeSingle();
    if (ins.error) {
      if (ins.error.code === "23505") already++;
      else return Response.json({ error: ins.error.message }, { status: 500 });
    } else {
      added++;
      if (ins.data?.id) addedRows.push({ id: ins.data.id as string, match_api_id: m.api_id });
    }
  }

  return Response.json({ ok: true, added, alreadyPresent: already, skipped, rows: addedRows }, { status: 200 });
}

export async function DELETE(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.email) return Response.json({ error: "Operator session required" }, { status: 403 });
  const { supabase } = auth;

  const apiId = Number(new URL(req.url).searchParams.get("match_api_id"));
  if (!Number.isInteger(apiId) || apiId <= 0) {
    return Response.json({ error: "match_api_id required" }, { status: 400 });
  }

  // Undo only ever removes an auto/one-click one-off. NEVER a template row —
  // even if some template row somehow carried this api_id, the guard protects
  // the recurring schedule.
  const del = await supabase
    .from("schedule_master")
    .delete()
    .eq("match_api_id", apiId)
    .neq("source", "template")
    .select("id");
  if (del.error) return Response.json({ error: del.error.message }, { status: 500 });

  return Response.json({ ok: true, deleted: del.data?.length ?? 0 }, { status: 200 });
}
