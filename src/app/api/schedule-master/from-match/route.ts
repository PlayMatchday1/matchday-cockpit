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
import { matchLocalDateTime } from "@/lib/scheduleReconcile";

// True if the slot's canonical key (city, date, mdapi field id, local time) is
// already fully planned — i.e. there are at least as many live schedule_master
// rows as MatchDay matches at that key. Adding another would be a duplicate.
// Count-aware so a genuine second concurrent session can still be added.
async function alreadyFullyPlanned(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  row: { city: string; match_date: string; match_time: string; mdapi_field_id: number | null },
  fieldId: number,
): Promise<boolean> {
  // Live plan rows at the key (deleted_at IS NULL; fall back pre-migration).
  let planRes = await supabase.from("schedule_master").select("id")
    .eq("city", row.city).eq("match_date", row.match_date)
    .eq("mdapi_field_id", fieldId).eq("match_time", row.match_time).is("deleted_at", null);
  if (planRes.error && /deleted_at|column|42703/i.test(planRes.error.message || "")) {
    planRes = await supabase.from("schedule_master").select("id")
      .eq("city", row.city).eq("match_date", row.match_date)
      .eq("mdapi_field_id", fieldId).eq("match_time", row.match_time);
  }
  const planCount = (planRes.data ?? []).length;
  // MatchDay matches at the same field on that local date + time.
  const y = row.match_date;
  const prev = new Date(Date.parse(`${y}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${y}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const mdRes = await supabase.from("mdapi_matches").select("start_date")
    .eq("field_id", fieldId).is("deleted_at", null)
    .gte("start_date", `${prev}T00:00:00`).lte("start_date", `${next}T23:59:59`);
  let mdCount = 0;
  for (const x of (mdRes.data ?? []) as { start_date: string }[]) {
    const ldt = matchLocalDateTime(x.start_date);
    if (ldt && ldt.date === row.match_date && ldt.timeLabel === row.match_time) mdCount++;
  }
  return planCount >= mdCount;
}

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
  const refused: number[] = [];
  const addedRows: Array<{ id: string; match_api_id: number }> = [];
  for (const m of matches) {
    const row = buildOneOffRow(m, maps, "manual");
    if (!row) {
      skipped.push(m.api_id);
      continue;
    }
    // Duplicate guard (canonical key): refuse if this slot is already fully
    // planned. Makes it impossible to create a duplicate by pressing twice or
    // from a stale grid. Rows with no field id skip the guard (can't key).
    if (row.mdapi_field_id != null && (await alreadyFullyPlanned(supabase, row, row.mdapi_field_id))) {
      refused.push(m.api_id);
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

  return Response.json({ ok: true, added, alreadyPresent: already, skipped, refused, rows: addedRows }, { status: 200 });
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
