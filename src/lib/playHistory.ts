// PLAY HISTORY BY FIELD, for the Locations page — SERVER-ONLY, Supabase only, never MatchDay.
//
// For a set of players: every VALID PLAY (playerActivity.isValidPlayRow on the roster row, on a
// match that is not cancelled and not soft-deleted in our mirror) that has STARTED (true instant,
// matchStartMs, at or before now), with the match's field. The field's name and position come from
// the match's own stored field (mdapi_matches.raw.field, as the map's field set does), so a field
// that has closed is still known. `closed` = not in the map's ACTIVE field set.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { matchStartMs } from "./matchTime";
import { isValidPlayRow, type PlayRowLike } from "./playerActivity";
import type { Play, PlayField } from "./wherePlayed";

const CHUNK = 200;
const chunks = <T,>(xs: T[], n = CHUNK) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export type PlayHistory = { playsByPlayer: Map<number, Play[]>; fields: Map<number, PlayField> };

export async function fetchPlayHistory(
  sb: SupabaseClient, playerIds: number[], activeFieldIds: Set<number>, now = new Date(),
): Promise<PlayHistory> {
  const ids = [...new Set(playerIds)];
  const rows: (PlayRowLike & { user_id: number | null; match_api_id: number | null })[] = [];
  for (const c of chunks(ids)) {
    rows.push(...await selectAll<PlayRowLike & { api_id: number; user_id: number | null; match_api_id: number | null }>(() =>
      sb.from("mdapi_match_players").select("api_id,user_id,match_api_id,is_cancelled,user_is_fake_player,user_type")
        .in("user_id", c).is("deleted_at", null).order("api_id")));
  }
  const valid = rows.filter((r) => r.user_id != null && r.match_api_id != null && isValidPlayRow(r));
  const matchIds = [...new Set(valid.map((r) => r.match_api_id as number))];
  type M = { api_id: number; field_id: number | null; field_title: string | null; start_date: string | null; start_date_utc: string | null;
    lat: unknown; lng: unknown; cityId: unknown };
  const matches = new Map<number, M>();
  for (const c of chunks(matchIds)) {
    const ms = await selectAll<M>(() => sb.from("mdapi_matches")
      .select("api_id,field_id,field_title,start_date,start_date_utc,lat:raw->field->lat,lng:raw->field->lng,cityId:raw->field->cityId")
      .in("api_id", c).eq("is_cancelled", false).is("deleted_at", null).order("api_id"));
    for (const m of ms) matches.set(m.api_id, m);
  }
  const nowMs = now.getTime();
  const playsByPlayer = new Map<number, Play[]>();
  const fields = new Map<number, PlayField>();
  // One play per player per match, whatever the roster holds (a re-booked row is still one match).
  const seen = new Set<string>();
  for (const r of valid) {
    const m = matches.get(r.match_api_id as number);
    if (!m || m.field_id == null) continue;
    const ms = matchStartMs(m.start_date_utc, m.start_date);
    if (ms == null || ms > nowMs) continue;
    const k = `${r.user_id}|${m.api_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // The match's LOCAL calendar day: the wall-clock start, sliced, never parsed.
    const list = playsByPlayer.get(r.user_id as number) ?? [];
    list.push({ fieldId: m.field_id, ms, day: (m.start_date ?? "").slice(0, 10) });
    playsByPlayer.set(r.user_id as number, list);
    if (!fields.has(m.field_id)) {
      const lat = typeof m.lat === "number" && Number.isFinite(m.lat) ? m.lat : null;
      const lng = typeof m.lng === "number" && Number.isFinite(m.lng) ? m.lng : null;
      fields.set(m.field_id, {
        id: m.field_id, title: m.field_title ?? `Field ${m.field_id}`,
        cityId: typeof m.cityId === "number" ? m.cityId : null,
        // A location that cannot be right (0,0 or out of range) is no location.
        lat: lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? lat : null,
        lng: lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? lng : null,
        closed: !activeFieldIds.has(m.field_id),
      });
    }
  }
  return { playsByPlayer, fields };
}
