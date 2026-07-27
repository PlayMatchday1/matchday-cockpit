// PATCH /api/community/settings — flip the global kill switch (posting_enabled)
// that gates ALL community posting. Admin-only.

import { authenticateAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function PATCH(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => null)) as { posting_enabled?: unknown } | null;
  if (!body || typeof body.posting_enabled !== "boolean") {
    return Response.json({ error: "posting_enabled (boolean) required" }, { status: 400 });
  }

  const upd = await auth.supabase
    .from("community_settings")
    .update({ posting_enabled: body.posting_enabled, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("id")
    .maybeSingle();
  if (upd.error) {
    console.error("[community:settings] update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  console.log(`[community:settings] posting_enabled=${body.posting_enabled} by ${auth.appUserId}`);
  return Response.json({ ok: true }, { status: 200 });
}
