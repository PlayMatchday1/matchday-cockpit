// POST /api/veo/intent { matchApiId, enabled } — toggle Clubhouse camera intent for
// a match. Writes veo_intent only; NEVER the MatchDay API (the 🎥 emoji stays a
// manual edit there). set_by marks it a manual toggle, distinct from the emoji seed.
import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as { matchApiId?: unknown; enabled?: unknown };
  const matchApiId = Number(body.matchApiId);
  if (!Number.isInteger(matchApiId) || matchApiId <= 0) return Response.json({ error: "matchApiId required" }, { status: 400 });
  const enabled = body.enabled === true;
  const { error } = await auth.supabase
    .from("veo_intent")
    .upsert({ match_api_id: matchApiId, enabled, set_by: "clubhouse", set_at: new Date().toISOString() }, { onConflict: "match_api_id" });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, matchApiId, enabled }, { status: 200 });
}
