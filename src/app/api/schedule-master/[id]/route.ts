// PATCH / DELETE /api/schedule-master/[id] — update or delete a
// single schedule_master row. Backs the edit modal on the
// /cities Master Schedule tab.
//
// Auth: admin via authenticateCrm. The cron-bearer path is
// rejected here for the same reason as POST — CRUD needs an
// attributable operator email for the audit log.

import { authenticateCrm } from "@/lib/crmAuth";
import {
  validateScheduleMasterPayload,
  writeScheduleMasterAudit,
  type ScheduleMasterRow,
} from "@/lib/scheduleMaster";

export const runtime = "nodejs";
export const maxDuration = 10;

const SELECT_COLS =
  "id, city, venue, detail, match_date, match_time, max_spots, mdapi_field_id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.email) {
    return Response.json(
      { error: "Operator session required" },
      { status: 403 },
    );
  }
  const { supabase, email } = auth;

  const { id } = await ctx.params;
  if (!id || !UUID_RE.test(id)) {
    return Response.json({ error: "id must be a uuid" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const v = validateScheduleMasterPayload(body, { isPartial: true });
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const patch = v.value;

  // Read the row before updating so we can write old_values into
  // the audit ledger. maybeSingle so a missing id maps to 404 cleanly.
  const existing = await supabase
    .from("schedule_master")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (existing.error) {
    console.error("[schedule-master:update] lookup failed", existing.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!existing.data) {
    return Response.json({ error: "Row not found" }, { status: 404 });
  }

  const upd = await supabase
    .from("schedule_master")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(SELECT_COLS)
    .single();
  if (upd.error || !upd.data) {
    console.error("[schedule-master:update] update failed", upd.error);
    return Response.json({ error: "Update failed" }, { status: 500 });
  }
  const row = upd.data as ScheduleMasterRow;

  await writeScheduleMasterAudit(supabase, {
    action: "update",
    userEmail: email,
    rowId: row.id,
    oldValues: existing.data as ScheduleMasterRow,
    newValues: row,
  });

  return Response.json({ row }, { status: 200 });
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.email) {
    return Response.json(
      { error: "Operator session required" },
      { status: 403 },
    );
  }
  const { supabase, email } = auth;

  const { id } = await ctx.params;
  if (!id || !UUID_RE.test(id)) {
    return Response.json({ error: "id must be a uuid" }, { status: 400 });
  }

  // Read first so we can record what was deleted in the audit log.
  // The row is also useful for the caller as a confirmation.
  const existing = await supabase
    .from("schedule_master")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (existing.error) {
    console.error("[schedule-master:delete] lookup failed", existing.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!existing.data) {
    return Response.json({ error: "Row not found" }, { status: 404 });
  }

  const del = await supabase.from("schedule_master").delete().eq("id", id);
  if (del.error) {
    console.error("[schedule-master:delete] delete failed", del.error);
    return Response.json({ error: "Delete failed" }, { status: 500 });
  }

  await writeScheduleMasterAudit(supabase, {
    action: "delete",
    userEmail: email,
    rowId: id,
    oldValues: existing.data as ScheduleMasterRow,
    newValues: null,
  });

  return Response.json({ deleted: true }, { status: 200 });
}
