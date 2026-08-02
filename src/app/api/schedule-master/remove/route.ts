// POST /api/schedule-master/remove — remove one or more schedule_master rows
// (the "Remove from Clubhouse" / bulk "Remove N Clubhouse-only slots" action on
// the Master Schedule reconciliation view).
//
// This is a CLUBHOUSE write only — it never touches mdapi_*. It only removes
// schedule_master rows; the caller is responsible for passing ids that are
// Clubhouse-only in the displayed week/city.
//
// Auth: admin only (app_users.is_admin), via authenticateCrm — explicitly
// gated, not relaxed. Chats-only users are rejected.
//
// Soft-delete preferring: sets deleted_at (migration 0091). If that column does
// not exist yet, falls back to a hard delete so the affordance works before the
// migration is applied. Audited either way.

import { authenticateCrm } from "@/lib/crmAuth";
import { writeScheduleMasterAudit, type ScheduleMasterRow } from "@/lib/scheduleMaster";

export const runtime = "nodejs";
export const maxDuration = 15;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT_COLS = "id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id";

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.email) return Response.json({ error: "Operator session required" }, { status: 403 });
  // Admin-only — do not relax. (authenticateCrm.ok also passes chats-only users.)
  if (!auth.isAdmin) return Response.json({ error: "Admin access required" }, { status: 403 });
  const { supabase, email } = auth;

  let body: { ids?: unknown };
  try { body = (await req.json()) as { ids?: unknown }; } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : [];
  if (ids.length === 0) return Response.json({ error: "ids must be a non-empty array of uuids" }, { status: 400 });

  // Read the rows first (audit + confirmation of what existed).
  const existing = await supabase.from("schedule_master").select(SELECT_COLS).in("id", ids);
  if (existing.error) return Response.json({ error: "DB error" }, { status: 500 });
  const rows = (existing.data ?? []) as ScheduleMasterRow[];
  if (rows.length === 0) return Response.json({ removed: 0, mode: "none" }, { status: 200 });
  const foundIds = rows.map((r) => r.id as unknown as string);

  // Prefer soft delete (0091). Fall back to hard delete if the column is absent.
  let mode: "soft" | "hard" = "soft";
  const soft = await supabase.from("schedule_master").update({ deleted_at: new Date().toISOString() }).in("id", foundIds);
  if (soft.error) {
    const msg = (soft.error.message || "").toLowerCase();
    const columnMissing = msg.includes("deleted_at") || soft.error.code === "42703" || msg.includes("column");
    if (!columnMissing) return Response.json({ error: "Remove failed" }, { status: 500 });
    mode = "hard";
    const hard = await supabase.from("schedule_master").delete().in("id", foundIds);
    if (hard.error) return Response.json({ error: "Remove failed" }, { status: 500 });
  }

  for (const r of rows) {
    await writeScheduleMasterAudit(supabase, { action: "delete", userEmail: email, rowId: r.id as unknown as string, oldValues: r, newValues: null });
  }
  return Response.json({ removed: foundIds.length, mode }, { status: 200 });
}
