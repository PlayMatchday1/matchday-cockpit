// GET /api/growth/locations/player?id=<player id> — the Overview's expandable Recent activity row.
// READ ONLY, Supabase only, Growth's gate.
//
// ONLY A PLAYER ON THIS PAGE. The id must be a non-internal player with a location in
// player_area_seen; anything else is a 404. This is the detail behind a row the page already shows,
// not a general player lookup (Player Lookup is linked for that).
//
// Every rule comes from somewhere that already exists:
//   matches played / last match / active  src/lib/playerActivity.ts (the Users lens definition)
//   member                                an ACTIVE paid subscription (same file)
//   active fields                         src/lib/locationsData.ts + locationsMap.activeFields (the Map)
// Distances use the player's exact coordinates; the position sent back is rounded to ~1 km, as on
// the Map.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { matchStartMs } from "@/lib/matchTime";
import { activeFields, playFieldsWithVenues } from "@/lib/locationsMap";
import { groupIntoUnits, unitIdOf } from "@/lib/venueUnits";
import { fetchFieldSnapshots, fetchLatestCities, fetchVenueLinks } from "@/lib/locationsData";
import { milesBetween, placeName } from "@/lib/playerAreaModel";
import { isActiveByLastPlay, isPaidActiveSub, isValidPlayRow, type PlayRowLike } from "@/lib/playerActivity";
import { fetchPlayHistory } from "@/lib/playHistory";
import { summarizePlays } from "@/lib/wherePlayed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const DETAIL_REACHES = [5, 10, 15] as const;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id is required" }, { status: 400 });

  try {
    const area = await sb.from("player_area_seen")
      .select("player_id,first_seen_at,seeded,has_area,zip,lat,lng,area_label,state,area_source,is_internal,verdict")
      .eq("player_id", id).maybeSingle();
    if (area.error) throw new Error(area.error.message);
    if (!area.data || !area.data.has_area || area.data.is_internal) {
      return Response.json({ error: "Not a player on this page." }, { status: 404 });
    }
    const a = area.data;
    const now = new Date();

    const [user, plays, subs, snaps, latest] = await Promise.all([
      sb.from("mdapi_users").select("id,first_name,last_name,created_at,completed_sign_up_at").eq("id", id).maybeSingle(),
      selectAll<PlayRowLike & { api_id: number; match_api_id: number | null }>(() => sb.from("mdapi_match_players")
        .select("api_id,match_api_id,is_cancelled,user_is_fake_player,user_type").eq("user_id", id).is("deleted_at", null).order("api_id")),
      selectAll<{ membership_id: number; status: string | null; price: number | string | null }>(() => sb.from("mdapi_subscriptions")
        .select("membership_id,status,price").eq("user_id", id).order("membership_id")),
      fetchFieldSnapshots(sb, now),
      fetchLatestCities(sb),
    ]);
    if (user.error) throw new Error(user.error.message);

    // Matches: valid plays on non-cancelled, non-deleted matches. PLAYED = started at or before now.
    const matchIds = [...new Set(plays.filter(isValidPlayRow).map((p) => p.match_api_id).filter((x): x is number => x != null))];
    const matches = matchIds.length === 0 ? [] : await selectAll<{ api_id: number; start_date: string | null; start_date_utc: string | null }>(() =>
      sb.from("mdapi_matches").select("api_id,start_date,start_date_utc").in("api_id", matchIds)
        .eq("is_cancelled", false).is("deleted_at", null).order("api_id"));
    const starts = matches.map((m) => ({ ms: matchStartMs(m.start_date_utc, m.start_date), wall: m.start_date }))
      .filter((m): m is { ms: number; wall: string | null } => m.ms != null);
    const played = starts.filter((m) => m.ms <= now.getTime()).sort((x, y) => x.ms - y.ms);
    const lastAny = starts.reduce<number | null>((mx, m) => (mx == null || m.ms > mx ? m.ms : mx), null);
    // The last match DATE is the match's own local calendar day: the wall-clock start_date, SLICED,
    // never parsed (CLAUDE.md: match start dates are local wall clock despite the Z).
    const lastPlayedDay = played.length ? (played[played.length - 1].wall ?? "").slice(0, 10) || null : null;

    // Fields: the Map's active set, distances from the player's exact position.
    // VENUES, not field records (venueUnits.ts): nearest, within and the mini map count each place once.
    const venueLinks = await fetchVenueLinks(sb);
    const { fields: records } = activeFields(snaps, latest.cities);
    const fields = groupIntoUnits(records, venueLinks);
    const near: { id: number; title: string; lat: number; lng: number; mi: number }[] = [];
    let nearest: { id: number; title: string; mi: number } | null = null;
    if (a.lat != null && a.lng != null) {
      for (const f of fields) {
        const mi = milesBetween(a.lat, a.lng, f.lat, f.lng);
        if (!nearest || mi < nearest.mi) nearest = { id: f.id, title: f.title, mi };
        if (mi <= 15) near.push({ id: f.id, title: f.title, lat: f.lat, lng: f.lng, mi });
      }
    }
    near.sort((x, y) => x.mi - y.mi);
    const within = Object.fromEntries(DETAIL_REACHES.map((r) => [r, near.filter((f) => f.mi <= r).length])) as Record<5 | 10 | 15, number>;
    // The mini map shows the fields within 15 mi; if there are none, the nearest field — but only
    // within 50 mi. A player in Rye, NY is 760 mi from the nearest field, and fitting both would
    // zoom the map out to half the country; the text names that field instead.
    const nearestField = nearest ? fields.find((f) => f.id === nearest!.id)! : null;
    const mapFields = near.length ? near : nearestField && nearest!.mi <= 50 ? [{ ...nearestField, mi: nearest!.mi }] : [];

    // WHERE THEY PLAY: the same summary as a Map bubble, from this player's exact position.
    const history = await fetchPlayHistory(sb, [id], new Set(records.map((f) => f.id)), now);
    for (const f of history.fields.values()) {
      const c = f.cityId != null ? latest.cities.find((x) => x.id === f.cityId) : undefined;
      if (c && f.lat != null && f.lng != null && milesBetween(f.lat, f.lng, c.lat, c.lng) > c.radiusMiles) { f.lat = null; f.lng = null; }
    }
    const playFields = playFieldsWithVenues({ history, venueLinks });
    const wherePlays = summarizePlays([history.playsByPlayer.get(id) ?? []],
      a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null, new Map(playFields.map((f) => [f.id, f])), (fid) => unitIdOf(fid, venueLinks));

    const u = user.data;
    return Response.json({
      plays: wherePlays,
      playFields,
      id,
      name: u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null : null,
      signedUpAt: u?.completed_sign_up_at ?? u?.created_at ?? null,
      signupCompleted: !!u?.completed_sign_up_at,
      matchesPlayed: played.length,
      lastPlayedDay,
      active: isActiveByLastPlay(lastAny, now),
      member: subs.some(isPaidActiveSub),
      area: placeName(a.area_label, a.state),
      zip: a.zip,
      source: a.area_source,
      firstSeenAt: a.first_seen_at,
      seeded: a.seeded,
      position: a.lat != null && a.lng != null ? { lat: r2(a.lat), lng: r2(a.lng) } : null,
      nearest: nearest ? { id: nearest.id, title: nearest.title, mi: r1(nearest.mi) } : null,
      within,
      fields: mapFields.map((f) => ({ id: f.id, title: f.title, lat: f.lat, lng: f.lng, mi: r1(f.mi) })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
