// POST /api/crm/threads/[id]/auto-send/cancel — stop the hold on this thread. Anyone with chats access
// in scope may stop a send. Only a row still `holding` moves: one already sending can't be called back.
import { authenticateCrm } from "@/lib/crmAuth";
import { assertThreadInScope } from "@/lib/crmScope";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { id: threadId } = await ctx.params;
  const scope = await assertThreadInScope(auth, threadId);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  const r = await auth.supabase.from("crm_ai_drafts")
    .update({ hold_status: "cancelled", hold_note: `Cancelled by ${auth.email ?? "staff"}.`, hold_cancelled_by_user_id: auth.appUserId })
    .eq("thread_id", threadId).eq("hold_status", "holding").select("id");
  if (r.error) return Response.json({ error: "Couldn't cancel." }, { status: 500 });
  if ((r.data ?? []).length === 0) return Response.json({ cancelled: false, error: "It had already gone, or was already cancelled." }, { status: 409 });
  return Response.json({ cancelled: true });
}
