import "server-only";
// THE STAFF APP'S LIVE READS. Every function here calls the MatchDay API in the request that needs
// it, through the guarded client. No mdapi_* mirror is read anywhere in this file.
//
// Clubhouse-owned tables are read where the app needs them: match_checkin_marks (marks are stored
// only here) and fin_venues / fin_venue_fields (the field's own capacity, via the board's helper).

import { type SupabaseClient } from "@supabase/supabase-js";
import { apiGet, type MatchdayEnv } from "./matchdayStageApi";
import { trimMatch, type Raw } from "./gamedayApiShape";
import { rosterRowCounts, rosterRowIsFake, type RosterRow } from "./gamedayModel";
import { perTeamCapacity } from "./checkinModel";
import { checkinOpen, mapLimit, summarizeCheckin, type CheckinSummary, type Mark } from "./appModel";

export const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const PAGE_LIMIT = 100;
const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Every match on one wall-clock day, every city, paged to the end. Same call the board makes. */
export async function fetchDayLive(env: MatchdayEnv, date: string): Promise<Raw[]> {
  const out: Raw[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await apiGet<{ data?: Raw[]; totalItems?: number }>(env, `/admin/matches`, {
      fromDate: date, toDate: date, page, limit: PAGE_LIMIT, sortColumn: "startDate", sortDirection: "asc",
    });
    const rows = Array.isArray(res) ? (res as Raw[]) : (res.data ?? []);
    out.push(...rows);
    const total = Array.isArray(res) ? rows.length : (res.totalItems ?? rows.length);
    if (rows.length < PAGE_LIMIT || out.length >= total) break;
  }
  return out;
}

type PlayerRaw = RosterRow & {
  id?: number; userId?: number; team?: number; playerNumber?: number; userType?: string | null;
  user?: { firstName?: string; lastName?: string; isFakePlayer?: boolean; phoneNumber?: string | null };
};

export async function fetchPlayersLive(env: MatchdayEnv, matchId: number | string): Promise<PlayerRaw[]> {
  const r = await apiGet<PlayerRaw[] | { data?: PlayerRaw[] }>(env, `/admin/matches/${matchId}/players`);
  return Array.isArray(r) ? r : (r.data ?? []);
}

/** The players a roster lists and _count.players counts: not cancelled, not refunded, not WAITING. */
export const countedPlayers = (rows: PlayerRaw[]) => rows.filter((p) => rosterRowCounts(p));
const realIds = (rows: PlayerRaw[]) => countedPlayers(rows).filter((p) => !rosterRowIsFake(p)).map((p) => Number(p.userId));

/**
 * MARKS ARE PRODUCTION-ONLY. match_checkin_marks is keyed on match_id alone, and the check-in route
 * that writes it only ever writes production ids. Staging ids share the number space, so reading
 * marks for a staging match would return a production match's marks. Staging gets none.
 */
export async function fetchMarks(sb: SupabaseClient, env: MatchdayEnv, matchIds: number[]): Promise<Map<number, Mark[]> | null> {
  if (env !== "production" || matchIds.length === 0) return env === "production" ? new Map() : null;
  const { data, error } = await sb.from("match_checkin_marks")
    .select("match_id,player_id,status,marked_at").in("match_id", matchIds);
  if (error) throw new Error(`check-in marks could not be read: ${error.message}`);
  const out = new Map<number, Mark[]>();
  for (const r of data ?? []) {
    const id = Number(r.match_id);
    out.set(id, [...(out.get(id) ?? []), { player_id: Number(r.player_id), status: String(r.status), marked_at: (r.marked_at as string) ?? null }]);
  }
  return out;
}

export type AppTodayRow = ReturnType<typeof todayRow>;

export function todayRow(m: ReturnType<typeof trimMatch> & { venueMaxPlayers?: number | null }, checkin: CheckinSummary | null) {
  const teamCount = m.teams.length;
  const players = m._count.players ?? 0, fakes = m._count.fakePlayers ?? 0;
  return {
    id: m.id, name: m.name,
    startDate: m.startDate, startDateUtc: m.startDateUtc, endDateUtc: m.endDateUtc,
    cityName: m.field.city.name, tzAbbr: m.field.city.timeZone.abbr, fieldTitle: m.field.title,
    teamCount,
    perTeam: perTeamCapacity({ teamCount, maxTeamSize2Team: m.maxTeamSize2Team, maxTeamSize4Team: m.maxTeamSize4Team, maxPlayerCount: m.maxPlayerCount }),
    booked: Math.max(0, players - fakes), fakes,
    capacity: m.maxPlayerCount == null || m.maxPlayerCount === 0 ? null : m.maxPlayerCount,
    isCancelled: m.isCancelled,
    manager: m.manager ? [m.manager.firstName, m.manager.lastName].filter(Boolean).join(" ").trim() || null : null,
    checkin,
  };
}

/**
 * Check-in summaries for the matches whose check-in is open, ONE live roster read each, at most six
 * in flight. Matches not yet open, and cancelled ones, cost nothing. A roster read that fails leaves
 * that match's summary null rather than failing the list.
 */
export async function summariesLive(
  env: MatchdayEnv, sb: SupabaseClient, matches: { id: number; startDateUtc: string; isCancelled: boolean }[], nowMs: number,
): Promise<Map<number, CheckinSummary | null>> {
  const open = matches.filter((m) => !m.isCancelled && checkinOpen(Date.parse(m.startDateUtc), nowMs));
  const out = new Map<number, CheckinSummary | null>();
  const marks = await fetchMarks(sb, env, open.map((m) => m.id));
  if (!marks) return out; // staging: no marks exist, so no summary is honest
  await mapLimit(open, 6, async (m) => {
    try {
      const ids = realIds(await fetchPlayersLive(env, m.id));
      out.set(m.id, summarizeCheckin(ids, marks.get(m.id) ?? [], Date.parse(m.startDateUtc)));
    } catch { out.set(m.id, null); }
  });
  return out;
}

/** The roster as the app shows it. Phone is display-only, as on the desktop panel. */
export function rosterOut(rows: PlayerRaw[], marks: Mark[] | null) {
  const byPlayer = new Map((marks ?? []).map((k) => [Number(k.player_id), k]));
  return countedPlayers(rows).map((p) => {
    const mk = byPlayer.get(Number(p.userId));
    return {
      userMatchId: num(p.id), playerId: num(p.userId),
      name: [p.user?.firstName, p.user?.lastName].filter(Boolean).join(" ").trim() || `Player ${p.userId}`,
      team: num(p.team), bib: num(p.playerNumber),
      userType: typeof p.userType === "string" ? p.userType : null,
      fake: rosterRowIsFake(p),
      phone: typeof p.user?.phoneNumber === "string" && p.user.phoneNumber.trim() !== "" ? p.user.phoneNumber : null,
      checkin: mk ? { status: mk.status, markedAt: mk.marked_at } : null,
    };
  });
}
