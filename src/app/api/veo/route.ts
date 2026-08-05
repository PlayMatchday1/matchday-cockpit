// GET /api/veo — the current Veo coverage week: matches (emoji-stripped) joined to
// veo_intent + veo_camera_count, with veo_codes as read-only reference. Clubhouse-
// gated (authenticateCrm); reads mdapi read-only, never writes to MatchDay.
import { authenticateCrm } from "@/lib/crmAuth";
import { fetchVeoWeek } from "@/lib/veoSchedule";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    // Optional ?week=YYYY-MM-DD selects the week to show (any date within it).
    // Parsed into a LOCAL date (not UTC) so it lands in the intended week
    // regardless of server timezone; invalid/absent → the current week.
    const raw = new URL(req.url).searchParams.get("week");
    const m = raw?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const weekRef = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
    const week = await fetchVeoWeek(auth.supabase, new Date(), weekRef);
    return Response.json(week, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/veo] failed", e);
    return Response.json({ error: "Failed to load Veo week" }, { status: 500 });
  }
}
