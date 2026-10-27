// PLAY HISTORY, PRECOMPUTED (migration 0233), SERVER-ONLY, Supabase only, never MatchDay.
//
// The Locations map needs each placed player's plays (playHistory.ts). Reading them live took 19 s of a
// 25 s map load (2026-10-27: 71,886 plays, 3,462 players, 77 fields). refreshPlayStats() runs that SAME
// read once an hour, at the end of the hourly location sync, and stores per player and field: how many
// plays, the latest one's start (true instant, ms) and its local day. readPlayStats() turns the rows back
// into a PlayHistory the map code takes unchanged.
//
// WHY PER-FIELD TOTALS ARE ENOUGH: every consumer of playsByPlayer on the map reads a play's field, the
// LATEST ms / day, and how many there are: summarizePlays (matches, players, per-match distance to a
// field, latest day), activity (latest ms), locatePlayers (count, latest, favourite by count then
// recency), the test field impact (latest ms). A field's n plays are expanded to n copies at the latest
// ms and day, which leaves every one of those numbers identical. The single-player detail route
// (/api/growth/locations/player) lists real plays and still reads them live.
//
// FRESHNESS: a play counts once its match has started, as of the refresh (refreshed_at), so a match
// that started since the last refresh shows from the next one, within the hour.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { fetchPlayHistory, type PlayHistory } from "./playHistory";
import type { Play, PlayField } from "./wherePlayed";

/** [field id, plays, latest start (ms), latest start's local day]. */
export type StatCell = [number, number, number, string];

/** Plays -> per-field totals, fields in the order their first play came. NOT sorted: a favourite-field
 *  tie (same plays, same latest start) goes to the venue seen first, as it did on the live read
 *  (player 94908, PARMER Stadium vs LBJ Early College High School, 2026-10-27). */
export function aggregatePlays(plays: Play[]): StatCell[] {
  const by = new Map<number, StatCell>();
  for (const p of plays) {
    const c = by.get(p.fieldId);
    if (!c) by.set(p.fieldId, [p.fieldId, 1, p.ms, p.day]);
    else { c[1]++; if (p.ms > c[2]) { c[2] = p.ms; c[3] = p.day; } }
  }
  return [...by.values()];
}

/** Per-field totals -> plays: n copies at the latest start. See the header for why this is exact. */
export function expandPlays(cells: StatCell[]): Play[] {
  const out: Play[] = [];
  for (const [fieldId, n, ms, day] of cells) for (let i = 0; i < n; i++) out.push({ fieldId, ms, day });
  return out;
}

const BATCH = 500;

/** The hourly refresh: the map's players (has_area, not internal), their plays as of `now`, stored. */
export async function refreshPlayStats(sb: SupabaseClient, now = new Date()) {
  const t0 = Date.now();
  const stamp = now.toISOString();
  const players = await selectAll<{ player_id: number }>(() => sb.from("player_area_seen")
    .select("player_id").eq("has_area", true).eq("is_internal", false).order("player_id"));
  const history = await fetchPlayHistory(sb, players.map((p) => p.player_id), new Set(), now);
  const rows = [...history.playsByPlayer].filter(([, ps]) => ps.length > 0)
    .map(([player_id, ps]) => ({ player_id, plays: aggregatePlays(ps), refreshed_at: stamp }));
  // ord = the order the read first met each field, which the live read's field list kept (migration 0234).
  const fields = [...history.fields.values()].map((f, ord) => ({ field_id: f.id, ord, title: f.title, city_id: f.cityId, lat: f.lat, lng: f.lng, refreshed_at: stamp }));
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await sb.from("locations_play_stats").upsert(rows.slice(i, i + BATCH), { onConflict: "player_id" });
    if (error) throw new Error(`locations_play_stats upsert: ${error.message}`);
  }
  for (let i = 0; i < fields.length; i += BATCH) {
    const { error } = await sb.from("locations_played_fields").upsert(fields.slice(i, i + BATCH), { onConflict: "field_id" });
    if (error) throw new Error(`locations_played_fields upsert: ${error.message}`);
  }
  // Whatever this refresh did not rewrite is gone: a player with no plays left, a field nobody played at.
  const d1 = await sb.from("locations_play_stats").delete().lt("refreshed_at", stamp);
  if (d1.error) throw new Error(`locations_play_stats prune: ${d1.error.message}`);
  const d2 = await sb.from("locations_played_fields").delete().lt("refreshed_at", stamp);
  if (d2.error) throw new Error(`locations_played_fields prune: ${d2.error.message}`);
  return { ok: true as const, asOf: stamp, players: rows.length, plays: rows.reduce((s, r) => s + r.plays.reduce((t, c) => t + c[1], 0), 0), fields: fields.length, ms: Date.now() - t0 };
}

type StatRow = { player_id: number; plays: StatCell[]; refreshed_at: string };
/** lat / lng are numeric (0234): exactly the double that was written. */
type FieldRow = { field_id: number; ord: number | null; title: string; city_id: number | null; lat: number | string | null; lng: number | string | null };
export type PlayStatsRaw = { rows: StatRow[]; fieldRows: FieldRow[] };

/** Every stored row. Null when the table is missing (migration 0233 not run) or empty (no refresh
 *  yet): the caller then reads live, so the map never breaks for want of a refresh. */
export async function fetchPlayStatsRaw(sb: SupabaseClient): Promise<PlayStatsRaw | null> {
  try {
    const [rows, fieldRows] = await Promise.all([
      selectAll<StatRow>(() => sb.from("locations_play_stats").select("player_id,plays,refreshed_at").order("player_id")),
      selectAll<FieldRow>(() => sb.from("locations_played_fields").select("field_id,ord,title,city_id,lat,lng").order("field_id")),
    ]);
    // First-met order, as the live read kept it; a row without one (none after a refresh) goes last.
    fieldRows.sort((a, b) => (a.ord ?? Infinity) - (b.ord ?? Infinity) || Number(a.field_id) - Number(b.field_id));
    return rows.length ? { rows, fieldRows } : null;
  } catch { return null; }
}

/** The stored history for these players, as fetchPlayHistory would have returned it at `asOf`.
 *  `fields` = the fields THESE players played at (as fetchPlayHistory scopes it), `closed` against
 *  today's active set. */
export function historyFromStats({ rows, fieldRows }: PlayStatsRaw, playerIds: number[], activeFieldIds: Set<number>): PlayHistory & { asOf: string } {
  const want = new Set(playerIds);
  const playsByPlayer = new Map<number, Play[]>();
  const used = new Set<number>();
  let asOf = "";
  for (const r of rows) {
    if (r.refreshed_at > asOf) asOf = r.refreshed_at;
    const id = Number(r.player_id);
    if (!want.has(id)) continue;
    playsByPlayer.set(id, expandPlays(r.plays));
    for (const c of r.plays) used.add(c[0]);
  }
  const fields = new Map<number, PlayField>();
  for (const f of fieldRows) {
    const id = Number(f.field_id);
    if (!used.has(id)) continue;
    fields.set(id, { id, title: f.title, cityId: f.city_id == null ? null : Number(f.city_id),
      lat: f.lat == null ? null : Number(f.lat), lng: f.lng == null ? null : Number(f.lng), closed: !activeFieldIds.has(id) });
  }
  return { playsByPlayer, fields, asOf };
}
