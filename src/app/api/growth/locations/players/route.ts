// GET /api/growth/locations/players — the Map tab's "Players in this area" table and its Klaviyo
// export. ADMIN ONLY: the Growth gate admits the page, is_admin admits the people on it. READ ONLY,
// Supabase only, never MatchDay.
//
// One row per placed player (player_area_seen: has_area, not internal — internal emails stay out,
// as on the map), with the keys of the bubbles they sit in (locationsMap.locatePlayers, the same
// buildCore the map's bubbles come from) and their contact details from mdapi_users.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { activeFields, locatePlayers } from "@/lib/locationsMap";
import { cityParam } from "@/lib/locationsMapSlice";
import { groupIntoUnits } from "@/lib/venueUnits";
import { loadLocationsInputs } from "@/lib/locationsInputs";
import { isScrubbed, toE164, type AreaPlayer } from "@/lib/areaPlayers";
import { isPaidActiveSub, type SubLike } from "@/lib/playerActivity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type UserRow = { id: number; email: string | null; first_name: string | null; last_name: string | null; phone_number: string | null };

/* WHO IS IN THE ANSWER (2026-10-27). Every row is built by the same locatePlayers over every placed
 * player, so a row reads the same whichever answer carries it; the scope only picks rows.
 *   GET            every placed player (the All cities table).
 *   GET ?city=<id> that city's in-market players, plus anyone whose bubble is within reach of one of its
 *                  venues (a field's "within N mi" list can cross a city line).
 *   POST { ids }   exactly these players: a selected test pin's, which can sit anywhere. */
export async function GET(req: Request) {
  return answer(req, { city: cityParam(req.url) });
}
export async function POST(req: Request) {
  let body: { ids?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "Body is not JSON." }, { status: 400 }); }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (ids.length > 5000) return Response.json({ error: "At most 5,000 ids." }, { status: 400 });
  return answer(req, { ids: new Set(ids) });
}

async function answer(req: Request, scope: { city?: number | null; ids?: Set<number> }) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin) return Response.json({ error: "Players in this area is admin only." }, { status: 403 });
  const sb = auth.supabase;

  try {
    const input = await loadLocationsInputs(sb);
    let places = locatePlayers(input);
    if (scope.ids) places = places.filter((p) => scope.ids!.has(p.playerId));
    else if (scope.city != null) {
      const c = scope.city;
      const units = new Set(groupIntoUnits(activeFields(input.fieldSnapshots, input.cities).fields, input.venueLinks).filter((u) => u.cityId === c).map((u) => u.id));
      places = places.filter((p) => (p.verdict === "in_market" && p.cityId === c) || Object.keys(p.fieldReach).some((f) => units.has(Number(f))));
    }
    const ids = places.map((p) => p.playerId);
    const users = new Map<number, UserRow>();
    /* MEMBER IS THE SHARED RULE (isPaidActiveSub), as on the single-player route beside this one —
     * not mdapi_users.is_member, which is true for any ACTIVE subscription, $0 comps included. */
    const paying = new Set<number>();
    // Chunks of 200 ids, four at a time (they were one at a time: 25 rounds for All cities).
    const chunks = Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) => ids.slice(i * 200, i * 200 + 200));
    for (let i = 0; i < chunks.length; i += 4) {
      await Promise.all(chunks.slice(i, i + 4).map(async (chunk) => {
        const [us, subs] = await Promise.all([
          selectAll<UserRow>(() => sb.from("mdapi_users")
            .select("id,email,first_name,last_name,phone_number").in("id", chunk).order("id")),
          selectAll<SubLike & { membership_id: number; user_id: number }>(() => sb.from("mdapi_subscriptions")
            .select("membership_id,user_id,status,price,member_email").eq("status", "ACTIVE").in("user_id", chunk).order("membership_id")),
        ]);
        for (const u of us) users.set(Number(u.id), u);
        for (const r of subs) if (isPaidActiveSub(r)) paying.add(Number(r.user_id));
      }));
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
