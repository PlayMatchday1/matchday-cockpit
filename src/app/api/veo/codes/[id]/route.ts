// Admin update / delete for a Veo code row. Admin-only (service role behind
// is_admin). PATCH supports either a full edit or a confirmed-only toggle.
//
//   PATCH  /api/veo/codes/[id]  { confirmed }                    — toggle only
//   PATCH  /api/veo/codes/[id]  { code, finVenueId, fieldIds, … } — full edit
//   DELETE /api/veo/codes/[id]

import { authenticateAdmin } from "@/lib/adminAuth";
import { validateVeoCodeInput } from "@/lib/veo";
import { invalidateVeoCodesCache, validateFieldOwnership } from "@/lib/veoCodes";

export const runtime = "nodejs";
export const maxDuration = 15;

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid request body." }, { status: 400 });

  const now = new Date().toISOString();

  // Confirmed-only toggle: exactly { confirmed: boolean }, no other fields.
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "confirmed" && typeof body.confirmed === "boolean") {
    const upd = await auth.supabase
      .from("veo_codes")
      .update({ confirmed: body.confirmed, updated_at: now })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (upd.error) {
      console.error("[veo:codes] toggle failed", upd.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
    if (!upd.data) return Response.json({ error: "Not found" }, { status: 404 });
    invalidateVeoCodesCache();
    console.log(`[veo:codes] ${id} confirmed=${body.confirmed} by=${auth.appUserId}`);
    return Response.json({ ok: true }, { status: 200 });
  }

  // Full edit.
  const v = validateVeoCodeInput(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  const ownErr = await validateFieldOwnership(auth.supabase, v.value.fin_venue_id, v.value.field_ids);
  if (ownErr) return Response.json({ error: ownErr }, { status: 400 });

  const upd = await auth.supabase
    .from("veo_codes")
    .update({ ...v.value, updated_at: now })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (upd.error) {
    if (upd.error.code === "23505") {
      return Response.json({ error: `Code "${v.value.code}" already exists.` }, { status: 409 });
    }
    console.error("[veo:codes] update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!upd.data) return Response.json({ error: "Not found" }, { status: 404 });

  invalidateVeoCodesCache();
  console.log(`[veo:codes] updated ${id} code=${v.value.code} by=${auth.appUserId}`);
  return Response.json({ ok: true }, { status: 200 });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  const del = await auth.supabase
    .from("veo_codes")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (del.error) {
    console.error("[veo:codes] delete failed", del.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!del.data) return Response.json({ error: "Not found" }, { status: 404 });

  invalidateVeoCodesCache();
  console.log(`[veo:codes] deleted ${id} by=${auth.appUserId}`);
  return Response.json({ ok: true }, { status: 200 });
}
