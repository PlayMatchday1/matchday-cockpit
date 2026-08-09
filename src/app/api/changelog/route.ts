// Change Log — read the recorded writes, and resolve an open question. GET returns the
// raw rows (the screen groups them by save into entries); POST records a human's finding
// on a save. Resolving fires NO write to MatchDay and never changes the recorded outcome
// — it only stamps who checked and when. Admin-gated; reads via the service-role client.

import { authenticateAdmin } from "@/lib/adminAuth";
import { supabaseLogStore } from "@/lib/changeLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const rows = await supabaseLogStore().list(500);
    return Response.json({ rows });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e), rows: [] }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { saveId?: string; verdict?: string } | null;
  if (!body?.saveId || (body.verdict !== "yes" && body.verdict !== "no")) {
    return Response.json({ error: "saveId and verdict ('yes'|'no') required" }, { status: 400 });
  }
  try {
    await supabaseLogStore().resolve(body.saveId, body.verdict, auth.email, new Date().toISOString());
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
