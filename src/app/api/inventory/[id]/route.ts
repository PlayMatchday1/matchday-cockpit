// Admin-only mutations on a single inventory_submissions row.
//   PATCH  /api/inventory/[id] — correct a submission (name/city/counts/…)
//   DELETE /api/inventory/[id] — delete this (latest) report
//
// inventory_submissions has no authenticated UPDATE/DELETE policy — anon
// is fully locked out and only an authenticated SELECT exists. These
// routes gate on app_users.is_admin (authenticateAdmin) and then mutate
// with the service_role key, so the table's lockdown is never broadened.
//
// Deleting the latest row needs no special "fall back" logic: the row is
// gone, the dashboard refetches, and dedupeLatest naturally surfaces the
// manager's prior report — or drops the card if none remains.

import { authenticateAdmin } from "@/lib/adminAuth";
import {
  validateInventorySubmission,
  type InventorySubmissionInput,
} from "@/lib/inventory";

export const runtime = "nodejs";
export const maxDuration = 10;

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) {
    return Response.json({ error: "Invalid submission id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as InventorySubmissionInput | null;
  if (!body) return Response.json({ error: "Invalid request body." }, { status: 400 });

  // Same validation as the public form: name required, city in the 8,
  // counts 0–999 ints, needs length-capped.
  const result = validateInventorySubmission(body);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });

  const upd = await auth.supabase
    .from("inventory_submissions")
    .update(result.value)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (upd.error) {
    console.error("[inventory:edit] update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!upd.data) {
    return Response.json({ error: "Submission not found" }, { status: 404 });
  }

  console.log(`[inventory:edit] id=${id} by=${auth.appUserId}`);
  return Response.json({ ok: true }, { status: 200 });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) {
    return Response.json({ error: "Invalid submission id" }, { status: 400 });
  }

  const del = await auth.supabase
    .from("inventory_submissions")
    .delete()
    .eq("id", id)
    .select("id");
  if (del.error) {
    console.error("[inventory:delete] delete failed", del.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  console.log(
    `[inventory:delete] id=${id} removed=${del.data?.length ?? 0} by=${auth.appUserId}`,
  );
  return Response.json({ ok: true, removed: del.data?.length ?? 0 }, { status: 200 });
}
