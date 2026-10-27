// GET /api/growth/locations/players — the Map tab's "Players in this area" table and its Klaviyo
// export. ADMIN ONLY: the Growth gate admits the page, is_admin admits the people on it. READ ONLY,
// Supabase only, never MatchDay.
//
// One row per placed player (player_area_seen: has_area, not internal — internal emails stay out,
// as on the map), with the keys of the bubbles they sit in (locationsMap.locatePlayers, the same
// buildCore the map's bubbles come from) and their contact details from mdapi_users.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { locatePlayers } from "@/lib/locationsMap";
import { loadLocationsInputs } from "@/lib/locationsInputs";
import { isScrubbed, toE164, type AreaPlayer } from "@/lib/areaPlayers";
import { isPaidActiveSub, type SubLike } from "@/lib/playerActivity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type UserRow = { id: number; email: string | null; first_name: string | null; last_name: string | null; phone_number: string | null };

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin) return Response.json({ error: "Players in this area is admin only." }, { status: 403 });
  const sb = auth.supabase;

  try {
    const input = await loadLocationsInputs(sb);
    const places = locatePlayers(input);
    const ids = places.map((p) => p.playerId);
    const users = new Map<number, UserRow>();
    /* MEMBER IS THE SHARED RULE (isPaidActiveSub), as on the single-player route beside this one —
     * not mdapi_users.is_member, which is true for any ACTIVE subscription, $0 comps included. */
    const paying = new Set<number>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const [us, subs] = await Promise.all([
        selectAll<UserRow>(() => sb.from("mdapi_users")
          .select("id,email,first_name,last_name,phone_number").in("id", chunk).order("id")),
        selectAll<SubLike & { membership_id: number; user_id: number }>(() => sb.from("mdapi_subscriptions")
          .select("membership_id,user_id,status,price,member_email").eq("status", "ACTIVE").in("user_id", chunk).order("membership_id")),
      ]);
      for (const u of us) users.set(Number(u.id), u);
      for (const r of subs) if (isPaidActiveSub(r)) paying.add(Number(r.user_id));
    }
    const cityName = new Map(input.cities.map((c) => [c.id, c.name]));
    const rows: AreaPlayer[] = places.map((p) => {
      const u = users.get(p.playerId);
      const scrubbed = isScrubbed(u?.first_name ?? null, u?.last_name ?? null);
      const phone = scrubbed ? null : u?.phone_number ?? null;
      return {
        id: p.playerId,
        firstName: u?.first_name?.trim() || null, lastName: u?.last_name?.trim() || null,
        email: scrubbed ? null : u?.email ?? null, phone, phoneE164: toE164(phone),
        area: p.area, zip: p.zip,
        city: p.cityId != null ? cityName.get(p.cityId) ?? null : (p.label ? p.label.split(",")[0].trim() : null),
        state: p.state, verdict: p.verdict, cityId: p.cityId,
        lastPlayed: p.lastDay, activity: p.activity, matches: p.matches, favouriteField: p.favouriteTitle,
        member: paying.has(p.playerId), keys: p.keys, fieldReach: p.fieldReach, fieldMi: p.fieldMi, fromZip: p.fromZip,
      };
    });
    return Response.json({ players: rows, missingUsers: places.length - places.filter((p) => users.has(p.playerId)).length },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
