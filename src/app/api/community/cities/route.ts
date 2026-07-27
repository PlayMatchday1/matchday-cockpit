// GET /api/community/cities — data for the Community admin tab: every city's
// link + active flag + 7-day post count, plus the global kill switch and the
// run heartbeat. Admin-only (service role behind is_admin).

import { authenticateAdmin } from "@/lib/adminAuth";
import {
  loadCityLinks,
  loadCommunitySettings,
  recentPostCountsByCity,
} from "@/lib/communityData";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const [links, counts, settings] = await Promise.all([
      loadCityLinks(auth.supabase),
      recentPostCountsByCity(auth.supabase),
      loadCommunitySettings(auth.supabase),
    ]);
    const cities = [...links.values()]
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .map((c) => ({
        city_code: c.city_code,
        display_name: c.display_name,
        whatsapp_url: c.whatsapp_url,
        active: c.active,
        posts_last_7d: counts[c.city_code] ?? 0,
      }));
    return Response.json({ cities, settings }, { status: 200 });
  } catch (err) {
    console.error("[community:cities] GET failed", err);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
}
