// GET /api/community/cities — data for the Community admin tab, now city →
// communities. Each city carries its communities (invite URL + active flag +
// 7-day post count + recent activity), plus, for multi-community cities, the
// full field list with each field's current community, and the set of
// unassigned fields (recent matches, no map row) that need attention.
// Admin-only (service role behind is_admin).

import { authenticateCapability } from "@/lib/capabilityAuth";
import {
  loadCityLinks,
  loadCommunitiesRaw,
  loadCommunitySettings,
  loadFieldMap,
  fieldInventoryByCity,
  matchCitiesLast30d,
  recentPostCountsByCommunity,
} from "@/lib/communityData";

export const runtime = "nodejs";
export const maxDuration = 20;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const [links, communities, fieldMap, postCounts, fieldInv, markets, settings] =
      await Promise.all([
        loadCityLinks(auth.supabase),
        loadCommunitiesRaw(auth.supabase),
        loadFieldMap(auth.supabase),
        recentPostCountsByCommunity(auth.supabase),
        fieldInventoryByCity(auth.supabase),
        matchCitiesLast30d(auth.supabase),
        loadCommunitySettings(auth.supabase),
      ]);

    const commByCity = new Map<string, typeof communities>();
    for (const c of communities) {
      const arr = commByCity.get(c.city_code);
      if (arr) arr.push(c);
      else commByCity.set(c.city_code, [c]);
    }

    const unassignedFields: {
      field_id: number;
      field_title: string | null;
      city_code: string;
      matches_30d: number;
    }[] = [];

    const cities = [...links.values()]
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .map((link) => {
        const comms = (commByCity.get(link.city_code) ?? []).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        const isMulti = comms.length >= 2;
        const fields = fieldInv.get(link.city_code) ?? [];

        // Per-community 30d activity: a field's matches count toward the
        // community it maps to; when the city has exactly one community, an
        // unmapped field falls back to it (mirrors the poster's rule).
        const commMatch30 = new Map<number, number>();
        for (const f of fields) {
          const mapped = fieldMap.get(f.field_id);
          const targetId =
            mapped != null ? mapped : comms.length === 1 ? comms[0].id : null;
          if (targetId != null) {
            commMatch30.set(targetId, (commMatch30.get(targetId) ?? 0) + f.matches_30d);
          } else if (isMulti && f.matches_30d > 0) {
            // Unassigned field in a multi-community city — surface it.
            unassignedFields.push({
              field_id: f.field_id,
              field_title: f.field_title,
              city_code: link.city_code,
              matches_30d: f.matches_30d,
            });
          }
        }

        return {
          city_code: link.city_code,
          display_name: link.display_name,
          is_multi: isMulti,
          // Posts under this city that predate the split (community_id null).
          null_posts_last_7d: postCounts.nullByCity[link.city_code] ?? 0,
          communities: comms.map((c) => {
            const activity30 = commMatch30.get(c.id) ?? 0;
            return {
              id: c.id,
              name: c.name,
              whatsapp_url: c.whatsapp_url,
              active: c.active,
              activated_at: c.activated_at,
              posts_last_7d: postCounts.byCommunity[c.id] ?? 0,
              matches_last_30d: activity30,
              // Live activity routed here but no URL → can never post.
              needs_url: activity30 > 0 && !c.whatsapp_url,
            };
          }),
          // Only multi-community cities expose the field editor.
          fields: isMulti
            ? fields.map((f) => ({
                field_id: f.field_id,
                field_title: f.field_title,
                matches_30d: f.matches_30d,
                matches_90d: f.matches_90d,
                community_id: fieldMap.get(f.field_id) ?? null,
              }))
            : [],
        };
      });

    // Markets with recent matches but no city row at all (unchanged behavior).
    const unconfigured = [...markets.entries()]
      .filter(([code]) => !links.has(code))
      .map(([code, m]) => ({
        city_code: code,
        display_name: m.displayName,
        matches_last_30d: m.count,
      }))
      .sort((a, b) => b.matches_last_30d - a.matches_last_30d);

    return Response.json(
      { cities, unassignedFields, unconfigured, settings },
      { status: 200 },
    );
  } catch (err) {
    console.error("[community:cities] GET failed", err);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
}
