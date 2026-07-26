// Admin actions on a queued Veo review item.
//
//   POST   /api/veo/[id]  { apiId }  — assign to a match: post the link into
//                                      that match's thread and mark posted.
//   DELETE /api/veo/[id]             — dismiss (junk / handled by hand).
//
// Auth: authenticateCrm (admin OR can_access_chats) AND an operator identity —
// the human who resolves the item is credited in match_chat_audit_log, same as
// the /match-chats reply route. Anon and non-admin/non-chats callers are
// rejected before any mutation.

import { authenticateCrm } from "@/lib/crmAuth";
import { postVeoLinkToMatch } from "@/lib/veoPost";

export const runtime = "nodejs";
export const maxDuration = 20;

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    return Response.json({ error: "Operator identity required" }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { apiId?: unknown } | null;
  const apiId = typeof body?.apiId === "number" ? body.apiId : Number(body?.apiId);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    return Response.json({ error: "apiId (positive integer) required" }, { status: 400 });
  }

  // Load the review item. Must exist and not already be posted (posting twice
  // would double-post the link).
  const rowRes = await supabase
    .from("veo_recordings")
    .select("id, recording_id, video_url, status")
    .eq("id", id)
    .maybeSingle();
  if (rowRes.error) {
    console.error("[veo:assign] load failed", rowRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!rowRes.data) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (rowRes.data.status === "posted") {
    return Response.json({ error: "Already posted" }, { status: 409 });
  }

  // Guard against a typo'd chat id: the target match must exist and be live.
  const matchRes = await supabase
    .from("mdapi_matches")
    .select("api_id")
    .eq("api_id", apiId)
    .is("deleted_at", null)
    .maybeSingle();
  if (matchRes.error) {
    console.error("[veo:assign] match lookup failed", matchRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!matchRes.data) {
    return Response.json({ error: "No such match" }, { status: 400 });
  }

  let posted;
  try {
    // Idempotent two-message post (copy line + bare URL). Safe to retry: a
    // re-assign of a post_failed item re-posts only what's missing.
    posted = await postVeoLinkToMatch({
      supabase,
      recordingId: rowRes.data.recording_id as string,
      apiId,
      videoUrl: rowRes.data.video_url as string,
      sentByUserId: appUserId,
    });
  } catch (err) {
    console.error(`[veo:assign] post failed item=${id} match=${apiId}`, err);
    return Response.json({ error: "Post failed" }, { status: 502 });
  }

  const now = new Date().toISOString();
  await supabase
    .from("veo_recordings")
    .update({
      status: "posted",
      queue_reason: null,
      matched_api_id: apiId,
      candidate_api_ids: null,
      firestore_message_id: posted.urlMessageId,
      posted_by_user_id: appUserId,
      posted_at: now,
      updated_at: now,
    })
    .eq("id", id);

  console.log(`[veo:assign] item=${id} → match=${apiId} by=${appUserId} msg=${posted.urlMessageId}`);
  return Response.json({ ok: true, matched_api_id: apiId }, { status: 200 });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    return Response.json({ error: "Operator identity required" }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id || !UUID_RX.test(id)) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  const upd = await supabase
    .from("veo_recordings")
    .update({
      status: "dismissed",
      queue_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .neq("status", "posted") // never silently un-post an already-posted item
    .select("id")
    .maybeSingle();
  if (upd.error) {
    console.error("[veo:dismiss] failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!upd.data) {
    return Response.json({ error: "Not found or already posted" }, { status: 404 });
  }
  console.log(`[veo:dismiss] item=${id} by=${appUserId}`);
  return Response.json({ ok: true }, { status: 200 });
}
