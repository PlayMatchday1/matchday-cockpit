// GET  /api/crm/auto-send/review — every shadow decision in the last 7 days, with what staff really sent.
// POST /api/crm/auto-send/review — { draft_id, verdict: "agree" | "disagree", chip?, note? }.
//
// Reads across threads, so a city-confined account is refused rather than filtered. The Disagree chips
// are the discard chips, and a Disagree needs one.
import { authenticateCrm } from "@/lib/crmAuth";
import { discardReasonText } from "@/lib/aiDraftModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 86400e3;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (auth.confinedCity) return Response.json({ error: "This review covers every city." }, { status: 403 });
  const { supabase } = auth;
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const r = await supabase.from("crm_ai_drafts")
    .select("id, thread_id, based_on_message_id, created_at, category, draft_text, reply_without_action, action, error, decision, decision_reason, sent_message_id, review_verdict, review_reason")
    .eq("decision_shadow", true).not("decision", "is", null).gte("created_at", since).order("created_at", { ascending: false }).limit(300);
  if (r.error) return Response.json({ error: "Couldn't read the decisions." }, { status: 500 });
  const rows = r.data ?? [];
  const threadIds = [...new Set(rows.map((d) => d.thread_id as string))];
  const inbound = rows.length ? await supabase.from("crm_messages").select("id, body").in("id", rows.map((d) => d.based_on_message_id as string)) : { data: [], error: null };
  const staff = threadIds.length
    ? await supabase.from("crm_messages").select("id, thread_id, body, sent_at").in("thread_id", threadIds).eq("direction", "outbound").not("sent_by_user_id", "is", null).gte("sent_at", since).order("sent_at", { ascending: true })
    : { data: [], error: null };
  if (inbound.error || staff.error) return Response.json({ error: "Couldn't read the messages." }, { status: 500 });
  const bodyOf = new Map((inbound.data ?? []).map((m) => [m.id as string, (m.body as string | null) ?? ""]));
  const out = rows.map((d) => {
    const replies = ((staff.data ?? []) as { id: string; thread_id: string; body: string | null; sent_at: string }[]).filter((m) => m.thread_id === d.thread_id);
    const sent = replies.find((m) => m.id === d.sent_message_id) ?? replies.find((m) => m.sent_at > (d.created_at as string));
    return {
      id: d.id, thread_id: d.thread_id, created_at: d.created_at, category: d.category, player_message: bodyOf.get(d.based_on_message_id as string) ?? "",
      draft: d.draft_text, action: d.action, error: d.error, decision: d.decision, reason: d.decision_reason, staff_sent: sent?.body ?? null,
      review_verdict: d.review_verdict, review_reason: d.review_reason,
    };
  });
  return Response.json({ rows: out }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (auth.confinedCity) return Response.json({ error: "This review covers every city." }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { draft_id?: unknown; verdict?: unknown; chip?: unknown; note?: unknown };
  const draftId = typeof b.draft_id === "string" ? b.draft_id : "";
  if (!draftId || (b.verdict !== "agree" && b.verdict !== "disagree")) return Response.json({ error: "draft_id and verdict required" }, { status: 400 });
  const reason = discardReasonText(b.chip, b.note);
  if (b.verdict === "disagree" && !reason) return Response.json({ error: "Pick a reason." }, { status: 400 });
  const u = await auth.supabase.from("crm_ai_drafts")
    .update({ review_verdict: b.verdict, review_reason: b.verdict === "disagree" ? reason : null, review_by_user_id: auth.appUserId, review_at: new Date().toISOString() })
    .eq("id", draftId).eq("decision_shadow", true).select("id");
  if (u.error) return Response.json({ error: "Couldn't save that." }, { status: 500 });
  if ((u.data ?? []).length !== 1) return Response.json({ error: "That isn't a shadow decision." }, { status: 404 });
  return Response.json({ ok: true });
}
