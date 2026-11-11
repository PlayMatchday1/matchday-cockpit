// THE CREDITS REPORT, LOADED (Ryan, 2026-11-10). Server-only: reads our database, never the MatchDay API.
// Served by /api/admin/credits (Finance › Credits). The rules are lib/creditsReport and lib/staffCredits.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { creditEntries, type LogRowIn } from "./staffCredits";
import {
  centralDay, doubleCredits, excludedPlayer, monthlyCredits,
  type BookingIn, type CreditAllIn, type MatchIn, type MonthlyRow, type PlayerIn,
} from "./creditsReport";


/** The first month on the table. Staff credits are recorded from Aug 14, 2026. */
const FIRST_MONTH = "2026-08";
const BOOKING_COLS = "api_id, match_api_id, user_id, user_email, user_is_fake_player, paid_status, total_amount, credit_amount, is_cancelled, canceled_at, created_at";
const MATCH_COLS = "api_id, name, city_name, start_date_utc, is_cancelled";
// A day either side of the first month, so a Central day at the edge is not lost to UTC.
const SINCE_UTC = "2026-07-31T00:00:00Z";

const nextMonth = (ym: string) => { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };

export async function loadCreditsReport(sb: SupabaseClient) {
  const today = centralDay(new Date().toISOString());

  // ── BOOKINGS THAT CAN CARRY A CREDIT ────────────────────────────────────────────────────
  // Active bookings on a cancelled match, PAID bookings a player cancelled, and PAID bookings that spent credit.
  const cancelledMatches = await selectAll<MatchIn>(() => sb.from("mdapi_matches").select(MATCH_COLS).eq("is_cancelled", true).gte("start_date_utc", SINCE_UTC).order("api_id"));
  const onCancelled: BookingIn[] = [];
  const cmIds = cancelledMatches.map((m) => m.api_id);
  for (let i = 0; i < cmIds.length; i += 200) {
    onCancelled.push(...await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).in("match_api_id", cmIds.slice(i, i + 200)).eq("is_cancelled", false).order("api_id")));
  }
  const leftPaid = await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).eq("is_cancelled", true).eq("paid_status", "PAID").gte("canceled_at", SINCE_UTC).order("api_id"));
  const spent = await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).eq("paid_status", "PAID").gt("credit_amount", 0).gte("created_at", SINCE_UTC).order("api_id"));
  const bookings = new Map<number, BookingIn>();
  for (const b of [...onCancelled, ...leftPaid, ...spent]) bookings.set(b.api_id, b);

  const matches = new Map<number, MatchIn>(cancelledMatches.map((m) => [m.api_id, m]));
  const need = [...new Set([...bookings.values()].map((b) => b.match_api_id).filter((id) => !matches.has(id)))];
  for (let i = 0; i < need.length; i += 300) {
    const { data, error } = await sb.from("mdapi_matches").select(MATCH_COLS).in("api_id", need.slice(i, i + 300));
    if (error) throw new Error(`mdapi_matches: ${error.message}`);
    for (const m of (data ?? []) as MatchIn[]) matches.set(m.api_id, m);
  }

  // ── STAFF CREDITS ───────────────────────────────────────────────────────────────────────
  const logRows = await selectAll<LogRowIn>(() => sb.from("change_log")
    .select("id, created_at, actor_email, actor_name, source, env, endpoint, outcome, changes")
    .like("endpoint", "/admin/players/%/profile").order("created_at").order("id"));
  const entries = creditEntries(logRows);

  const userIds = new Set<number>();
  for (const b of bookings.values()) if (b.user_id != null) userIds.add(b.user_id);
  for (const e of entries) if (e.playerId != null) userIds.add(e.playerId);
  const players = new Map<number, PlayerIn>();
  const ids = [...userIds];
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await sb.from("mdapi_users").select("id, email, first_name, last_name, preferable_city_name, is_fake_player").in("id", ids.slice(i, i + 300));
    if (error) throw new Error(`mdapi_users: ${error.message}`);
    for (const u of (data ?? []) as PlayerIn[]) players.set(u.id, u);
  }
  /* THE STAFF TAB'S TAG RULE, word for word (api/admin/staff-credits): a fake player or an @matchday. /
   * @playmatchday. address is a test account, else a Warsaw player is Warsaw. The report leaves both out. */
  const staffTagged = (id: number | null) => {
    const u = id == null ? undefined : players.get(id);
    if (!u) return false;
    return !!u.is_fake_player || /@matchday\.|@playmatchday\./i.test(String(u.email ?? "")) || u.preferable_city_name === "Warsaw";
  };
  const staffByMonth = new Map<string, number>();
  for (const e of entries) {
    if (!e.counted || e.amountCents === 0 || staffTagged(e.playerId)) continue;
    staffByMonth.set(e.month, (staffByMonth.get(e.month) ?? 0) + e.amountCents);
  }

  // ── SNAPSHOTS ───────────────────────────────────────────────────────────────────────────
  const snaps = await sb.from("credit_balance_snapshots").select("day, taken_at, triggered_by, outstanding_cents, players_with_balance, negative_count, negative_cents, mirror_oldest_synced_at, player_pass_finished_at").order("day");
  /* A failed read is SAID on the page, never shown as "no snapshot yet": a blank month-end that is really an
   * error would read as a fact. */
  const snapshotError = snaps.error ? `Couldn't read the balance snapshots: ${snaps.error.message}` : null;
  type Snap = { day: string; taken_at: string; triggered_by: string; outstanding_cents: number; players_with_balance: number; negative_count: number; negative_cents: number; mirror_oldest_synced_at: string | null; player_pass_finished_at: string | null };
  const snapRows = (snaps.data ?? []) as Snap[];
  const nightOn = new Map(snapRows.filter((s) => s.triggered_by === "cron").map((s) => [s.day, s]));
  const latest = snapRows.at(-1) ?? null;

  // ── THE TABLE ───────────────────────────────────────────────────────────────────────────
  const credits = new Map(monthlyCredits([...bookings.values()], matches, players, `${FIRST_MONTH}-01`, today).map((r) => [r.month, r]));
  const rows: (MonthlyRow & { matchCancelCents: number; playerCancelCents: number; monthEndDay: string | null })[] = [];
  for (let ym = FIRST_MONTH; ym <= today.slice(0, 7); ym = nextMonth(ym)) {
    const c = credits.get(ym);
    const cancellationCents = (c?.matchCancelCents ?? 0) + (c?.playerCancelCents ?? 0);
    const staffCents = staffByMonth.get(ym) ?? 0;
    const current = ym === today.slice(0, 7);
    const endSnap = current ? null : nightOn.get(`${nextMonth(ym)}-01`) ?? null;
    rows.push({
      month: ym, partialThrough: current ? today : null,
      matchCancelCents: c?.matchCancelCents ?? 0, playerCancelCents: c?.playerCancelCents ?? 0,
      cancellationCents, staffCents, totalIssuedCents: cancellationCents + staffCents, usedCents: c?.usedCents ?? 0,
      monthEndCents: endSnap ? Number(endSnap.outstanding_cents) : null, monthEndDay: endSnap?.day ?? null,
    });
  }

  // ── FLAGS ───────────────────────────────────────────────────────────────────────────────
  const negRows = await selectAll<PlayerIn & { bal: unknown; synced_at: string | null }>(() => sb.from("mdapi_users")
    .select("id, email, first_name, last_name, preferable_city_name, is_fake_player, synced_at, bal:raw->creditAmount")
    .lt("raw->creditAmount", 0).order("id"));
  const negatives = negRows.filter((u) => !excludedPlayer(u)).map((u) => ({
    id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim(), city: u.preferable_city_name, cents: Number(u.bal), syncedAt: u.synced_at,
  })).sort((a, b) => a.cents - b.cents);

  const creditAll = (await selectAll<CreditAllIn & { env: string; outcome: string }>(() => sb.from("change_log")
    .select("match_id, endpoint, changes, created_at, env, outcome").like("source", "%credit everyone%").order("created_at")))
    .filter((r) => r.env === "production" && r.outcome === "landed");
  const caMatchIds = [...new Set(creditAll.map((r) => r.match_id).filter((x): x is number => x != null))];
  const caMatches = new Map<number, MatchIn>();
  const caBookings: BookingIn[] = [];
  if (caMatchIds.length) {
    const { data, error } = await sb.from("mdapi_matches").select(MATCH_COLS).in("api_id", caMatchIds);
    if (error) throw new Error(`mdapi_matches: ${error.message}`);
    for (const m of (data ?? []) as MatchIn[]) caMatches.set(m.api_id, m);
    const cancelledIds = [...caMatches.values()].filter((m) => m.is_cancelled).map((m) => m.api_id);
    if (cancelledIds.length) caBookings.push(...await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).in("match_api_id", cancelledIds).order("api_id")));
  }
  const doubles = doubleCredits(creditAll, caMatches, caBookings);

  const sync = await sb.from("fin_sync_log").select("completed_at").eq("source", "mdapi-matches").is("error_message", null).order("completed_at", { ascending: false }).limit(1).maybeSingle();

  return {
    today, rows, latestSnapshot: latest, snapshotsFrom: snapRows[0]?.day ?? null, snapshotError,
    negatives, doubles, creditAllMatches: caMatchIds.length,
    matchesSyncedAt: sync.data?.completed_at ?? null,
  };
}
export type CreditsReport = Awaited<ReturnType<typeof loadCreditsReport>>;
