// PUT /api/community/field-map — assign a field to a community (or unassign
// with community_id null). Admin-only. field_id is the PRIMARY KEY of
// community_field_map, so an upsert re-points an existing field; the DB
// guarantees a field maps to at most one community.
//
// Body: { field_id: number, community_id: number | null }
//   community_id number → upsert the assignment
//   community_id null   → delete the row (field becomes unassigned)

import { authenticateAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as
    | { field_id?: unknown; community_id?: unknown }
    | null;
  if (!body) return Response.json({ error: "Invalid request body." }, { status: 400 });

  const fieldId = Number(body.field_id);
  if (!Number.isInteger(fieldId) || fieldId <= 0) {
    return Response.json({ error: "Invalid field_id" }, { status: 400 });
  }

  // Unassign.
  if (body.community_id == null) {
    const del = await auth.supabase.from("community_field_map").delete().eq("field_id", fieldId);
    if (del.error) {
      console.error("[community:field-map] delete failed", del.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
    return Response.json({ ok: true, field_id: fieldId, community_id: null });
  }

  const communityId = Number(body.community_id);
  if (!Number.isInteger(communityId) || communityId <= 0) {
    return Response.json({ error: "Invalid community_id" }, { status: 400 });
  }
  // The community must exist (FK would catch it, but a clean 400 is nicer).
  const c = await auth.supabase
    .from("city_communities")
    .select("id")
    .eq("id", communityId)
    .maybeSingle();
  if (c.error) return Response.json({ error: "DB error" }, { status: 500 });
  if (!c.data) return Response.json({ error: "Unknown community" }, { status: 404 });

  const up = await auth.supabase.from("community_field_map").upsert(
    {
      field_id: fieldId,
      community_id: communityId,
      updated_at: new Date().toISOString(),
      updated_by: auth.appUserId,
    },
    { onConflict: "field_id" },
  );
  if (up.error) {
    console.error("[community:field-map] upsert failed", up.error);
    return Response.json({ error: `upsert failed: ${up.error.message}` }, { status: 500 });
  }
  console.log(`[community:field-map] field ${fieldId} → community ${communityId} by ${auth.appUserId}`);
  return Response.json({ ok: true, field_id: fieldId, community_id: communityId });
}
