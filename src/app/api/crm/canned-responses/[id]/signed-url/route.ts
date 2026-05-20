// GET /api/crm/canned-responses/[id]/signed-url — mint a 1-hour
// signed URL for the template's image_path. Used by the Composer
// picker the moment the operator selects an image template; the
// client fetches the bytes, builds a File, and routes them through
// the existing onFileSelected entry point.
//
// Returns 404 when the row has no image (text-only template).
// Auth: dual-mode bearer via src/lib/crmAuth (admin-only).

import { authenticateCrm } from "@/lib/crmAuth";
import { getSignedCannedResponseUrl } from "@/lib/crmCannedResponses";

export const runtime = "nodejs";
export const maxDuration = 10;

const TTL_S = 3600; // 1 hour per spec

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const { id } = await ctx.params;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const res = await supabase
    .from("crm_canned_responses")
    .select("image_path")
    .eq("id", id)
    .maybeSingle();
  if (res.error) {
    console.error("[crm:canned-responses.signed-url] lookup failed", res.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!res.data) return Response.json({ error: "Not found" }, { status: 404 });
  const imagePath = (res.data.image_path as string | null) ?? null;
  if (!imagePath) {
    return Response.json(
      { error: "Template has no image" },
      { status: 404 },
    );
  }

  const url = await getSignedCannedResponseUrl(supabase, imagePath, TTL_S);
  if (!url) {
    return Response.json(
      { error: "Failed to sign URL" },
      { status: 500 },
    );
  }
  return Response.json({ url, ttl_seconds: TTL_S }, { status: 200 });
}
