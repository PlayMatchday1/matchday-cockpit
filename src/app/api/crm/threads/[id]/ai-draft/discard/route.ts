// POST /api/crm/threads/[id]/ai-draft/discard — staff threw the draft away.
//
// Body: { draft_id: string, chip?: "Too long" | "Wrong answer" | "Missing info" | "Wrong tone", note?: string }
//
// Records outcome = discarded on a draft that is still pending and belongs to this thread. That
// record, beside sent_unchanged and sent_edited, is how we will judge when auto-send is safe.
// Auth: authenticateCrm (can_access_chats or is_admin), same as the draft route.

import { authenticateCrm } from "@/lib/crmAuth";
import { recordDraftDiscarded } from "@/lib/aiDraftOutcome";
import { discardReasonText } from "@/lib/aiDraftModel";

export const runtime = "nodejs";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id: threadId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { draft_id?: unknown; chip?: unknown; note?: unknown };
  const draftId = typeof body.draft_id === "string" ? body.draft_id : "";
  if (!threadId || !draftId) return Response.json({ error: "thread id and draft_id required" }, { status: 400 });
  try {
    const recorded = await recordDraftDiscarded(auth.supabase, { draftId, threadId, userId: auth.appUserId, reason: discardReasonText(body.chip, body.note) });
    return Response.json({ recorded }, { status: 200 });
  } catch (e) {
    console.error("[ai-draft] discard failed", e instanceof Error ? e.message : e);
    return Response.json({ error: "Couldn't record the discard." }, { status: 500 });
  }
}
