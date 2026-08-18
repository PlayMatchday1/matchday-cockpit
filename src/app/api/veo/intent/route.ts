// GET  /api/veo/intent?matchApiId=N — read the CURRENT camera intent for one match, so a control
//      can reflect reality on open instead of assuming a default. Added when the Veo toggle moved
//      into the match panel: the week endpoint (/api/veo?week=) is the wrong shape for one match.
// POST /api/veo/intent { matchApiId, enabled } — toggle Clubhouse camera intent for
// a match. Writes veo_intent ONLY. set_by marks it a manual toggle, distinct from the emoji seed.
//
// THE 🎥 IS NO LONGER A MANUAL EDIT. This header used to say the emoji stays a hand edit in the
// MatchDay app and that Clubhouse never writes it. That changed: toggling the chip on Master
// Schedule now also writes the camera into the MatchDay match name, which players see.
//
// THAT WRITE IS NOT HERE, DELIBERATELY. It goes through the existing match write path
// (PUT /api/matchday/{env}/matches/{id}) so there is ONE match-name writer, with one host guard,
// one EDIT MATCHES gate and one recordWrite() into change_log. The order is flag first, name
// second — this route owns the source of truth, and a name write that fails leaves the flag
// flipped and the chip showing a derived unsynced state. See src/lib/veoNameSync.ts.
import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const matchApiId = Number(new URL(req.url).searchParams.get("matchApiId"));
  if (!Number.isInteger(matchApiId) || matchApiId <= 0) return Response.json({ error: "matchApiId required" }, { status: 400 });
  const { data, error } = await auth.supabase
    .from("veo_intent").select("enabled").eq("match_api_id", matchApiId).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  // No row = no intent recorded = off. Reported explicitly so the caller never has to guess.
  return Response.json({ matchApiId, enabled: data?.enabled === true, recorded: !!data }, { status: 200, headers: { "Cache-Control": "no-store" } });
}

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
