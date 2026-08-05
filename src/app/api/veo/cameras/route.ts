// POST /api/veo/cameras { city, cameras } — set a city's camera inventory. Edits
// veo_camera_count ONLY (never veo_codes, which the recordings pipeline reads).
// This is a real, persisting inventory change.
import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as { city?: unknown; cameras?: unknown };
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const cameras = Number(body.cameras);
  if (!city) return Response.json({ error: "city required" }, { status: 400 });
  if (!Number.isInteger(cameras) || cameras < 0) return Response.json({ error: "cameras must be a non-negative integer" }, { status: 400 });
  const { error } = await auth.supabase
    .from("veo_camera_count")
    .upsert({ city, cameras, updated_by: "clubhouse", updated_at: new Date().toISOString() }, { onConflict: "city" });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, city, cameras }, { status: 200 });
}
