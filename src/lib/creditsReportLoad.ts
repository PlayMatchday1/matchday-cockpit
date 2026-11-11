// THE CREDITS REPORT, LOADED (Ryan, 2026-11-10). Server-only: reads our database, never the MatchDay API.
// Served by /api/admin/credits (Finance › Credits). The rules are lib/creditsReport and lib/staffCredits.
//
// CLOSED MONTHS ARE STORED (migration 0270, credit_months). A month is closed by the night run once it has been
// over for CLOSE_AFTER_DAYS, from the same rebuild the page used to run on every load (rebuildCredits), and the
// page then reads its row instead of rebuilding it. Only the months still open are rebuilt on load. A stored row
// is never rewritten: the figure a month closed on is the figure it keeps.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { creditEntries, type LogRowIn } from "./staffCredits";
import {
  centralDay, doubleCredits, excludedPlayer, memberCredits, monthlyCredits,
  type BookingIn, type CreditAllIn, type MatchIn, type MembershipIn, type MonthCredits, type MonthlyRow, type PlayerIn,
} from "./creditsReport";

/** The first month on the table. Staff credits are recorded from Aug 14, 2026. */
export const FIRST_MONTH = "2026-08";
/** A month closes this many days after it ends: the 3 AM pass has re-read every roster twice by then. */
export const CLOSE_AFTER_DAYS = 2;
const BOOKING_COLS = "api_id, match_api_id, user_id, user_email, user_is_fake_player, paid_status, total_amount, credit_amount, is_cancelled, canceled_at, created_at";
const MATCH_COLS = "api_id, name, city_name, start_date_utc, is_cancelled, is_free_member";

export const nextMonth = (ym: string) => { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A day before `fromDay` in UTC, so a Central day at the edge is not lost. */
const sinceUtc = (fromDay: string) => `${addDays(fromDay, -1)}T00:00:00Z`;
export const closable = (ym: string, today: string) => addDays(lastDay(ym), CLOSE_AFTER_DAYS) <= today;

async function playersById(sb: SupabaseClient, ids: Iterable<number>): Promise<Map<number, PlayerIn>> {
  const players = new Map<number, PlayerIn>();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 300) {
    const { data, error } = await sb.from("mdapi_users").select("id, email, first_name, last_name, preferable_city_name, is_fake_player").in("id", list.slice(i, i + 300));
    if (error) throw new Error(`mdapi_users: ${error.message}`);
    for (const u of (data ?? []) as PlayerIn[]) players.set(u.id, u);
  }
  return players;
}

/** Cancellation credits and credits used per month from `fromDay` to `toDay` (Central, inclusive), and staff credits
 *  per month. Reads only bookings that can fall in the range. */
export async function rebuildCredits(sb: SupabaseClient, fromDay: string, toDay: string):
  Promise<{ months: Map<string, MonthCredits>; staffByMonth: Map<string, number> }> {
  const since = sinceUtc(fromDay);
  // Active bookings on a cancelled match, PAID bookings a player cancelled, and PAID bookings that spent credit.
  const cancelledMatches = await selectAll<MatchIn>(() => sb.from("mdapi_matches").select(MATCH_COLS).eq("is_cancelled", true).gte("start_date_utc", since).order("api_id"));
  const onCancelled: BookingIn[] = [];
  const cmIds = cancelledMatches.map((m) => m.api_id);
  for (let i = 0; i < cmIds.length; i += 200) {
    onCancelled.push(...await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).in("match_api_id", cmIds.slice(i, i + 200)).eq("is_cancelled", false).order("api_id")));
  }
  const leftPaid = await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).eq("is_cancelled", true).eq("paid_status", "PAID").gte("canceled_at", since).order("api_id"));
  const spent = await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).eq("paid_status", "PAID").gt("credit_amount", 0).gte("created_at", since).order("api_id"));
  const bookings = new Map<number, BookingIn>();
  for (const b of [...onCancelled, ...leftPaid, ...spent]) bookings.set(b.api_id, b);

  const matches = new Map<number, MatchIn>(cancelledMatches.map((m) => [m.api_id, m]));
  const need = [...new Set([...bookings.values()].map((b) => b.match_api_id).filter((id) => !matches.has(id)))];
  for (let i = 0; i < need.length; i += 300) {
    const { data, error } = await sb.from("mdapi_matches").select(MATCH_COLS).in("api_id", need.slice(i, i + 300));
    if (error) throw new Error(`mdapi_matches: ${error.message}`);
    for (const m of (data ?? []) as MatchIn[]) matches.set(m.api_id, m);
  }

  // Staff credits: every credit change in change_log (a small table), exactly as the Staff tab reads it.
  const logRows = await selectAll<LogRowIn>(() => sb.from("change_log")
    .select("id, created_at, actor_email, actor_name, source, env, endpoint, outcome, changes")
    .like("endpoint", "/admin/players/%/profile").order("created_at").order("id"));
  const entries = creditEntries(logRows);

  const players = await playersById(sb, [
    ...[...bookings.values()].map((b) => b.user_id).filter((x): x is number => x != null),
    ...entries.map((e) => e.playerId).filter((x): x is number => x != null),
  ]);
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
  const months = new Map(monthlyCredits([...bookings.values()], matches, players, fromDay, toDay).map((r) => [r.month, r]));
  return { months, staffByMonth };
}

type ClosedRow = { month: string; match_cancel_cents: number; player_cancel_cents: number; staff_cents: number; used_cents: number; closed_at: string };

/** The night run: store every month from FIRST_MONTH that is over and not stored yet. Never rewrites a row. */
export async function closeCreditMonths(sb: SupabaseClient, now = new Date()): Promise<{ closed: string[] }> {
  const today = centralDay(now.toISOString());
  const have = await sb.from("credit_months").select("month");
  if (have.error) throw new Error(`credit_months: ${have.error.message}`);
  const stored = new Set(((have.data ?? []) as { month: string }[]).map((r) => r.month));
  const due: string[] = [];
  for (let ym = FIRST_MONTH; closable(ym, today); ym = nextMonth(ym)) if (!stored.has(ym)) due.push(ym);
  if (due.length === 0) return { closed: [] };
  const { months, staffByMonth } = await rebuildCredits(sb, `${due[0]}-01`, lastDay(due[due.length - 1]));
  const rows = due.map((ym) => ({
    month: ym,
    match_cancel_cents: months.get(ym)?.matchCancelCents ?? 0, player_cancel_cents: months.get(ym)?.playerCancelCents ?? 0,
    staff_cents: staffByMonth.get(ym) ?? 0, used_cents: months.get(ym)?.usedCents ?? 0,
  }));
  // ignoreDuplicates: a month stored by a run that overlapped this one keeps its first figure.
  const ins = await sb.from("credit_months").upsert(rows, { onConflict: "month", ignoreDuplicates: true });
  if (ins.error) throw new Error(`credit_months: ${ins.error.message}`);
  return { closed: due };
}

export async function loadCreditsReport(sb: SupabaseClient) {
  const today = centralDay(new Date().toISOString());

  // ── CLOSED MONTHS ───────────────────────────────────────────────────────────────────────
  const closedRead = await sb.from("credit_months").select("month, match_cancel_cents, player_cancel_cents, staff_cents, used_cents, closed_at").order("month");
  /* A failed read rebuilds everything, which is slow but right, and the page says so. */
  const closedError = closedRead.error ? `Couldn't read the closed months, so every month was rebuilt: ${closedRead.error.message}` : null;
  const closed = new Map(((closedRead.data ?? []) as ClosedRow[]).map((r) => [r.month, r]));
  let firstOpen = FIRST_MONTH;
  while (closed.has(firstOpen) && firstOpen < today.slice(0, 7)) firstOpen = nextMonth(firstOpen);
  const open = await rebuildCredits(sb, `${firstOpen}-01`, today);

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
  const rows: (MonthlyRow & { matchCancelCents: number; playerCancelCents: number; closedAt: string | null })[] = [];
  for (let ym = FIRST_MONTH; ym <= today.slice(0, 7); ym = nextMonth(ym)) {
    const k = ym >= firstOpen ? null : closed.get(ym) ?? null;
    const matchCancelCents = Number(k ? k.match_cancel_cents : open.months.get(ym)?.matchCancelCents ?? 0);
    const playerCancelCents = Number(k ? k.player_cancel_cents : open.months.get(ym)?.playerCancelCents ?? 0);
    const staffCents = Number(k ? k.staff_cents : open.staffByMonth.get(ym) ?? 0);
    const usedCents = Number(k ? k.used_cents : open.months.get(ym)?.usedCents ?? 0);
    const current = ym === today.slice(0, 7);
    const endSnap = current ? null : nightOn.get(`${nextMonth(ym)}-01`) ?? null;
    const balance = current ? latest : endSnap;
    const cancellationCents = matchCancelCents + playerCancelCents;
    rows.push({
      month: ym, partialThrough: current ? today : null, matchCancelCents, playerCancelCents,
      cancellationCents, staffCents, totalIssuedCents: cancellationCents + staffCents, usedCents,
      monthEndCents: balance ? Number(balance.outstanding_cents) : null,
      // The night snapshot on the 1st is the balance at the end of the month before; any other is as of its day.
      balanceAsOf: !balance ? null : current ? balance.day : lastDay(ym),
      closedAt: k?.closed_at ?? null,
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

  // Credits given to members: only matches not free for members can carry one (creditsReport.memberCredits).
  const paidMatches = await selectAll<MatchIn>(() => sb.from("mdapi_matches").select(MATCH_COLS).eq("is_free_member", false).gte("start_date_utc", sinceUtc(`${FIRST_MONTH}-01`)).order("api_id"));
  const pmMap = new Map(paidMatches.map((m) => [m.api_id, m]));
  const pmBookings: BookingIn[] = [];
  const pmIds = paidMatches.map((m) => m.api_id);
  for (let i = 0; i < pmIds.length; i += 200) pmBookings.push(...await selectAll<BookingIn>(() => sb.from("mdapi_match_players").select(BOOKING_COLS).in("match_api_id", pmIds.slice(i, i + 200)).order("api_id")));
  const pmUserIds = [...new Set(pmBookings.map((b) => b.user_id).filter((x): x is number => x != null))];
  const pmPlayers = await playersById(sb, pmUserIds);
  const memberships = new Map<number, MembershipIn[]>();
  for (let i = 0; i < pmUserIds.length; i += 300) {
    const { data, error } = await sb.from("mdapi_subscriptions").select("membership_id, user_id, activation_date, canceled_at").in("user_id", pmUserIds.slice(i, i + 300));
    if (error) throw new Error(`mdapi_subscriptions: ${error.message}`);
    const subs = (data ?? []) as { membership_id: number; user_id: number; activation_date: string | null; canceled_at: string | null }[];
    const ends = new Map<number, { stripe_canceled_at: string | null; stripe_ended_at: string | null }>();
    const mids = subs.map((x) => x.membership_id);
    if (mids.length) {
      const e = await sb.from("mdapi_subscription_stripe_end").select("membership_id, stripe_canceled_at, stripe_ended_at").in("membership_id", mids);
      if (e.error) throw new Error(`mdapi_subscription_stripe_end: ${e.error.message}`);
      for (const r of (e.data ?? []) as { membership_id: number; stripe_canceled_at: string | null; stripe_ended_at: string | null }[]) ends.set(r.membership_id, r);
    }
    for (const x of subs) {
      const list = memberships.get(x.user_id) ?? [];
      list.push({ user_id: x.user_id, activation_date: x.activation_date, ends: [x.canceled_at, ends.get(x.membership_id)?.stripe_canceled_at ?? null, ends.get(x.membership_id)?.stripe_ended_at ?? null] });
      memberships.set(x.user_id, list);
    }
  }
  const toMembers = memberCredits(pmBookings, pmMap, pmPlayers, memberships, `${FIRST_MONTH}-01`, today).map((c) => ({
    ...c, playerName: [pmPlayers.get(c.userId)?.first_name, pmPlayers.get(c.userId)?.last_name].filter(Boolean).join(" ").trim(),
  }));

  const sync = await sb.from("fin_sync_log").select("completed_at").eq("source", "mdapi-matches").is("error_message", null).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1).maybeSingle();

  return {
    today, rows, latestSnapshot: latest, snapshotsFrom: snapRows[0]?.day ?? null, snapshotError, closedError,
    rebuiltFrom: firstOpen,
    negatives, doubles, creditAllMatches: caMatchIds.length, memberCredits: toMembers,
    matchesSyncedAt: sync.data?.completed_at ?? null,
  };
}
export type CreditsReport = Awaited<ReturnType<typeof loadCreditsReport>>;

export type MonthFigures = { match_cancel_cents: number; player_cancel_cents: number; staff_cents: number; used_cents: number };
const FIGURE_KEYS = ["match_cancel_cents", "player_cancel_cents", "staff_cents", "used_cents"] as const;
const FIGURE_LABEL: Record<(typeof FIGURE_KEYS)[number], string> = {
  match_cancel_cents: "Credits from matches we cancelled", player_cancel_cents: "Credits from players cancelling 24h+ ahead",
  staff_cents: "Staff credits", used_cents: "Credits used",
};

/** REBUILD ONE STORED MONTH (Ryan, 2026-11-10): the only thing that overwrites a credit_months row. Admins only, from
 *  Monthly. Reruns the same rebuild, overwrites the row, reads it back, and logs who did it with the before and after
 *  figures in change_log. A month that is not stored, or not over, is refused: the night run stores it first. */
export async function rebuildStoredMonth(sb: SupabaseClient, month: string, actor: { email: string; name: string }, now = new Date()):
  Promise<{ ok: true; before: MonthFigures; after: MonthFigures; logged: boolean; logError?: string } | { ok: false; status: number; error: string }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, status: 400, error: "month must be YYYY-MM" };
  const prev = await sb.from("credit_months").select("match_cancel_cents, player_cancel_cents, staff_cents, used_cents").eq("month", month).maybeSingle();
  if (prev.error) return { ok: false, status: 500, error: `credit_months: ${prev.error.message}` };
  if (!prev.data) return { ok: false, status: 409, error: `${month} isn't stored yet, so there is nothing to rebuild. The night run stores a month two days after it ends.` };
  const before = Object.fromEntries(FIGURE_KEYS.map((k) => [k, Number((prev.data as MonthFigures)[k])])) as MonthFigures;

  const { months, staffByMonth } = await rebuildCredits(sb, `${month}-01`, lastDay(month));
  const after: MonthFigures = {
    match_cancel_cents: months.get(month)?.matchCancelCents ?? 0, player_cancel_cents: months.get(month)?.playerCancelCents ?? 0,
    staff_cents: staffByMonth.get(month) ?? 0, used_cents: months.get(month)?.usedCents ?? 0,
  };
  const up = await sb.from("credit_months").update({ ...after, closed_at: now.toISOString() }).eq("month", month);
  if (up.error) return { ok: false, status: 500, error: `credit_months: ${up.error.message}` };
  // A write that returned no error has not necessarily landed: read the row back.
  const back = await sb.from("credit_months").select("match_cancel_cents, player_cancel_cents, staff_cents, used_cents").eq("month", month).maybeSingle();
  const landed = !back.error && !!back.data && FIGURE_KEYS.every((k) => Number((back.data as MonthFigures)[k]) === after[k]);

  const log = await sb.from("change_log").insert({
    save_id: crypto.randomUUID(), created_at: now.toISOString(), actor_name: actor.name, actor_email: actor.email,
    source: "Finance › Credits · Rebuild month", env: "production", match_id: null, match_name: null,
    method: "POST", endpoint: "/api/admin/credits/rebuild", request_body: { month },
    outcome: landed ? "landed" : back.error ? "unknown" : "failed", server_said: null,
    changes: [
      ...FIGURE_KEYS.map((k) => ({ key: k, field: FIGURE_LABEL[k], before: before[k], after: after[k] })),
      { key: "total_issued_cents", field: "Total issued", before: before.match_cancel_cents + before.player_cancel_cents + before.staff_cents, after: after.match_cancel_cents + after.player_cancel_cents + after.staff_cents },
    ],
  });
  if (!landed) return { ok: false, status: 500, error: back.error ? `Rebuilt, but the row couldn't be read back: ${back.error.message}` : "The row read back doesn't hold the rebuilt figures." };
  return log.error ? { ok: true, before, after, logged: false, logError: log.error.message } : { ok: true, before, after, logged: true };
}
