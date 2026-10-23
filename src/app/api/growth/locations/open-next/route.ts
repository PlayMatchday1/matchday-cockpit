// GET /api/growth/locations/open-next?reach=10 — the Overview's "Where to open next" table.
// READ ONLY, Supabase only, Growth's gate. The method is src/lib/locationsInsights.ts (openNextForCity),
// the read and its cache src/lib/locationsLoaders.ts (loadOpenNext), shared with the Poland tab.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { loadOpenNext, OPEN_NEXT_REACHES } from "@/lib/locationsLoaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const reach = Number(new URL(req.url).searchParams.get("reach") ?? 10);
  if (!OPEN_NEXT_REACHES.has(reach)) return Response.json({ error: "reach must be 3, 5, 10 or 15" }, { status: 400 });
  try {
    return Response.json(await loadOpenNext(auth.supabase, reach), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
