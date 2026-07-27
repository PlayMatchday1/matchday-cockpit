// GET /api/community/cities — data for the Community admin tab: every city's
// link + active flag + 7-day post count, plus the global kill switch and the
// run heartbeat. Admin-only (service role behind is_admin).

import { authenticateAdmin } from "@/lib/adminAuth";
import {
  loadCityLinks,
  loadCommunitySettings,
  matchCitiesLast30d,
  recentPostCountsByCity,
} from "@/lib/communityData";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const [links, counts, settings, markets] = await Promise.all([
      loadCityLinks(auth.supabase),
      recentPostCountsByCity(auth.supabase),
      loadCommunitySettings(auth.supabase),
      matchCitiesLast30d(auth.supabase),
    ]);
    const cities = [...links.values()]
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .map((c) => {
        const matches30d = markets.get(c.city_code)?.count ?? 0;
        return {
          city_code: c.city_code,
          display_name: c.display_name,
          whatsapp_url: c.whatsapp_url,
          active: c.active,
          activated_at: c.activated_at,
          posts_last_7d: counts[c.city_code] ?? 0,
          matches_last_30d: matches30d,
          // A live market with matches but no url can never post — flag it.
          needs_setup: matches30d > 0 && !c.whatsapp_url,
        };
      });
    // New markets: recent matches but NO city row at all (e.g. a code added to
    // normalizeCityName but never seeded). These won't appear in the table.
    const unconfigured = [...markets.entries()]
      .filter(([code]) => !links.has(code))
      .map(([code, m]) => ({
        city_code: code,
        display_name: m.displayName,
        matches_last_30d: m.count,
      }))
      .sort((a, b) => b.matches_last_30d - a.matches_last_30d);

    return Response.json({ cities, unconfigured, settings }, { status: 200 });
  } catch (err) {
    console.error("[community:cities] GET failed", err);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
}
