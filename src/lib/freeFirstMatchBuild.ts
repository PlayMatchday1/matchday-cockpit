/* FREE FIRST MATCH — building the page's BASE from the mirror. Server only, read only.
 * Pulled out of the route so a script can run it with a service-role client and print what the page
 * shows against a direct count (docs/free-first-match/DISCOVERY.md, "Deploy check"). The route
 * (src/app/api/lifecycle/free-first-match/route.ts) adds the auth gate and a short warm cache; every
 * range and city is then `summarize(base, …)` (freeFirstMatchModel.ts), with no further reads.
 *
 * Rows are read from mdapi_match_players directly, not growth_participation: the counting rules
 * (own spot, PAID or FREE, not refunded) and the money (total_amount, refunded) and the leaves
 * (canceled_at) are all on the booking row, and the view drops left rows and carries no user_type. The
 * view's exclusions are applied here instead: fake bookings, WAITING, deleted rows, cancelled or
 * deleted matches, growth_internal_account, and a re-registered player's accounts as one person. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { addDays, chicagoYmd, chicagoToday, wallClockYmd } from "./weekBuckets";
import { normalizeMatchCity } from "./growthAnalytics";
import { canonicalVenueName } from "./venueResolver";
import {
  BASELINE_FROM, EXCLUDED_CITIES, FIRST_MATCH_AUTO_CODE, FIRST_MATCH_AUTO_PROD_ID, FREE_GROUPS, LAUNCH_DAY, REGULAR_DAYS,
  daysBetween, isPaidBooking, isReferralCode,
  type Base, type BaseMatch, type FirstTimer, type Group, type Leave, type Play, type Rating, type SubLite,
} from "./freeFirstMatchModel";

type Row = Record<string, unknown>;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const chunks = <T,>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const DAY_MS = 86400000;

type Sb = SupabaseClient;

/** `.in(col, ids)` in chunks, each chunk paged on its own stable key until a short page. A few chunks run
 *  at once (`parallel`); any read error fails the whole build rather than returning a short list. */
export async function inChunks(sb: Sb, table: string, cols: string, col: string, ids: number[], orderKey: string, size = 200, parallel = 1, filter?: (q: any) => any): Promise<Row[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const parts = chunks(ids, size);
  const out: Row[][] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= parts.length) return;
      const got: Row[] = [];
      for (let off = 0; ; off += 1000) {
        let q = sb.from(table).select(cols).in(col, parts[i]);
        if (filter) q = filter(q);
        const { data, error } = await q.order(orderKey).range(off, off + 999);
        if (error) throw new Error(`${table}: ${error.message}`);
        got.push(...((data ?? []) as unknown as Row[]));
        if ((data ?? []).length < 1000) break;
      }
      out[i] = got;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, parts.length)) }, worker));
  return out.flat();
}

export async function buildFreeFirstMatch(sb: SupabaseClient): Promise<Base> {
  const today = chicagoToday();
  const nowMs = Date.now();
  // How far back the bookings are read: the longest "before" window (as many days before launch as the
  // range since launch can have), and the regulars' prior window before that.
  const sinceLaunch = Math.max(1, daysBetween(LAUNCH_DAY, today));
  let rowsFrom = addDays(LAUNCH_DAY, -Math.max(sinceLaunch, REGULAR_DAYS) * 2 - 1);
  if (rowsFrom < "2026-08-07") rowsFrom = "2026-08-07";
  const matchesFrom = rowsFrom < BASELINE_FROM ? rowsFrom : BASELINE_FROM;

  // ── 1. THE CODES ──────────────────────────────────────────────────────────────────────────
  const promos = await selectAll<Row>(() =>
    sb.from("mdapi_promocodes").select("api_id, code, target_user_type, discount_type, discount_value")
      .or(`code.ilike.${FIRST_MATCH_AUTO_CODE},and(target_user_type.eq.NEW_USERS,discount_type.eq.PERCENT,discount_value.eq.100)`)
      .order("api_id"));
  const autoIds = new Set<number>([FIRST_MATCH_AUTO_PROD_ID]);
  const refIds = new Set<number>();
  const codeIds = new Set<number>();
  for (const p of promos) {
    const id = num(p.api_id), code = String(p.code ?? "");
    if (code.toUpperCase() === FIRST_MATCH_AUTO_CODE) { autoIds.add(id); continue; }
    if (p.target_user_type !== "NEW_USERS" || p.discount_type !== "PERCENT" || num(p.discount_value) !== 100) continue;
    (isReferralCode(code) ? refIds : codeIds).add(id);
  }

  // ── 2. EACH FIELD'S MAX PLAYER SPOTS (Field Ops). A read error FAILS the build: an empty map would
  // quietly mark every field "no max set".
  const fieldMaxById = new Map<number, number>();
  {
    const [links, venues] = await Promise.all([
      sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
      sb.from("fin_venues").select("id, max_players"),
    ]);
    if (links.error) throw new Error(`fin_venue_fields: ${links.error.message}`);
    if (venues.error) throw new Error(`fin_venues: ${venues.error.message}`);
    const maxByVenue = new Map<number, number>();
    for (const v of (venues.data ?? []) as { id: number; max_players: number | null }[]) if (v.max_players != null && Number(v.max_players) > 0) maxByVenue.set(v.id, Number(v.max_players));
    for (const l of (links.data ?? []) as { fin_venue_id: number; mdapi_field_id: number | null }[]) {
      const n = maxByVenue.get(l.fin_venue_id);
      if (n != null && l.mdapi_field_id != null) fieldMaxById.set(Number(l.mdapi_field_id), n);
    }
  }

  // ── 3. THE MATCHES: every live match from the baseline on, upcoming included ─────────────────
  const matchCols = "api_id, start_date, city_identifier, field_id, field_title, registration_price, is_free_member, max_player_count, player_count, ffe:raw->firstMatchFreeEnabled, currency:raw->>currency, start_utc:raw->>startDateUtc";
  const matchRows = await selectAll<Row>(() =>
    sb.from("mdapi_matches").select(matchCols).is("deleted_at", null).eq("is_cancelled", false)
      .gte("start_date", `${matchesFrom}T00:00:00`).order("api_id"));
  const matches = new Map<number, BaseMatch & { freeMember: boolean }>();
  for (const r of matchRows) {
    const start = String(r.start_date ?? "");
    const startMs = Date.parse(String(r.start_utc ?? ""));
    if (!start || !Number.isFinite(startMs)) continue; // no true-UTC kickoff: cannot say whether it has started
    const city = String(r.city_identifier ?? "");
    const fieldName = canonicalVenueName(String(r.field_title ?? "")) || String(r.field_title ?? "") || "Unknown field";
    const fieldId = r.field_id == null ? null : num(r.field_id);
    matches.set(num(r.api_id), {
      id: num(r.api_id), day: wallClockYmd(start), wall: start.slice(0, 16), startMs, city,
      fieldKey: `${city}|${fieldName}`, fieldName,
      booked: num(r.player_count), cap: r.max_player_count == null ? null : num(r.max_player_count),
      fieldMax: fieldId == null ? null : fieldMaxById.get(fieldId) ?? null,
      // DOLLARS ONLY: Warsaw is złoty. A match with no currency in raw is read as dollars.
      priceCents: r.currency == null || String(r.currency).toLowerCase() === "usd" ? num(r.registration_price) : null,
      ffe: typeof r.ffe === "boolean" ? r.ffe : null,
      freeMember: r.is_free_member === true,
    });
  }

  // ── 4. EVERY BOOKING ROW ON THE STARTED MATCHES from rowsFrom on (fake rows and WAITING out at the read) ──
  const rowMatchIds = [...matches.values()].filter((m) => m.day >= rowsFrom && m.startMs <= nowMs).map((m) => m.id);
  const raw = await inChunks(sb, "mdapi_match_players",
    "api_id, match_api_id, user_id, user_type, paid_status, amount, total_amount, refunded, is_cancelled, canceled_at, promocode_id, created_at",
    "match_api_id", rowMatchIds, "api_id", 100, 4,
    (q) => q.is("deleted_at", null).not("user_is_fake_player", "is", true).neq("paid_status", "WAITING"));

  // ── 5. WHO IS OUT: internal accounts (fake, @matchday.com, staff) and ZZ test names. ADMIN-type
  // accounts are NOT filtered: the users mirror carries no account type (raw has no `type`, read
  // 2026-11-21), so the backend's 2 admin accounts without a staff email cannot be seen from here. ──
  const excluded = new Set<number>();
  for (const r of await selectAll<Row>(() => sb.from("growth_internal_account").select("user_id").order("user_id"))) excluded.add(num(r.user_id));
  for (const r of await selectAll<Row>(() => sb.from("mdapi_users").select("id").or("first_name.ilike.zz*,last_name.ilike.zz*").order("id"))) excluded.add(num(r.id));

  // A person's accounts as one person (growth_person_link: a deleted account mapped onto its successor).
  const personOf = new Map<number, number>();
  for (const l of await selectAll<Row>(() => sb.from("growth_person_link").select("account_id, person_id").order("account_id"))) personOf.set(num(l.account_id), num(l.person_id));
  const person = (account: number) => personOf.get(account) ?? account;

  type B = {
    api: number; match: BaseMatch & { freeMember: boolean }; account: number; person: number; userType: string; paidStatus: string;
    amount: number; total: number; refunded: boolean; leftMs: number | null; promo: number | null; createdMs: number;
  };
  const rows: B[] = [];
  for (const r of raw) {
    const m = matches.get(num(r.match_api_id));
    if (!m || r.user_id == null) continue;
    const account = num(r.user_id);
    if (excluded.has(account)) continue;
    const left = r.canceled_at != null || r.is_cancelled === true;
    rows.push({
      api: num(r.api_id), match: m, account, person: person(account), userType: String(r.user_type ?? ""), paidStatus: String(r.paid_status ?? ""),
      amount: num(r.amount), total: num(r.total_amount), refunded: r.refunded === true,
      leftMs: left ? (r.canceled_at ? Date.parse(String(r.canceled_at)) : NaN) : null,
      promo: r.promocode_id == null ? null : num(r.promocode_id), createdMs: Date.parse(String(r.created_at ?? "")),
    });
  }
  const started = (b: B) => b.match.startMs <= nowMs;
  /** A played match: own spot, PAID or FREE, not left, not refunded, on a live match that has started. */
  const played = (b: B) => b.userType === "PLAYER" && (b.paidStatus === "PAID" || b.paidStatus === "FREE") && b.leftMs == null && !b.refunded && started(b);
  /** Card dollars actually kept: a PAID booking on a started dollar match, refunded counts as nothing. */
  const netCents = (b: B) => (b.paidStatus === "PAID" && started(b) && b.match.priceCents != null && !b.refunded ? b.total : 0);

  const byPerson = new Map<number, B[]>();
  for (const b of rows) (byPerson.get(b.person) ?? byPerson.set(b.person, []).get(b.person)!).push(b);

  // ── 6. HISTORY BEFORE THE ROWS: growth_player_profile's first match day, for everyone seen ──────
  const profileFirst = new Map<number, string>();
  for (const r of await inChunks(sb, "growth_player_profile", "user_id, first_match_date", "user_id", [...byPerson.keys()], "user_id", 300, 4)) {
    if (r.first_match_date != null) profileFirst.set(num(r.user_id), String(r.first_match_date));
  }
  /** The person's first played day: their own first played row here, or earlier history (profile). */
  const firstPlay = new Map<number, string>();
  for (const [pid, bs] of byPerson) {
    let first: string | null = null;
    for (const b of bs) if (played(b) && (first == null || b.match.day < first)) first = b.match.day;
    const prof = profileFirst.get(pid);
    if (prof != null && prof < rowsFrom && (first == null || prof < first)) first = prof;
    if (first != null) firstPlay.set(pid, first);
  }

  // ── 7. MEMBERSHIPS, for the paid rule, by every account a first-timer has carried ─────────────
  const ftAccounts = new Set<number>();
  for (const [pid, bs] of byPerson) {
    const f = firstPlay.get(pid);
    if (f == null || f < rowsFrom) continue;
    for (const b of bs) ftAccounts.add(b.account);
  }
  const subsByAccount = new Map<number, SubLite[]>();
  for (const r of await inChunks(sb, "mdapi_subscriptions", "membership_id, user_id, activation_date, canceled_at", "user_id", [...ftAccounts], "membership_id", 200, 4)) {
    const uid = num(r.user_id);
    (subsByAccount.get(uid) ?? subsByAccount.set(uid, []).get(uid)!).push({
      activationDay: r.activation_date ? chicagoYmd(String(r.activation_date)) : null,
      canceledDay: r.canceled_at ? chicagoYmd(String(r.canceled_at)) : null,
    });
  }

  // ── 8. FIRST-TIMERS ─────────────────────────────────────────────────────────────────────────
  const people: FirstTimer[] = [];
  for (const [pid, bs] of byPerson) {
    const first = firstPlay.get(pid);
    if (first == null || first < rowsFrom) continue;
    const own = bs.filter(played).sort((a, b) => (a.match.wall < b.match.wall ? -1 : a.match.wall > b.match.wall ? 1 : a.api - b.api));
    const anchor = own[0];
    if (!anchor || anchor.match.day !== first) continue; // earlier history in the profile: not a first-timer
    const subs: SubLite[] = [];
    for (const a of new Set(bs.map((b) => b.account))) subs.push(...(subsByAccount.get(a) ?? []));
    const paidOf = (b: B) => isPaidBooking({ userType: b.userType, amountCents: b.amount, promocodeId: b.promo }, { isFreeMember: b.match.freeMember, day: b.match.day }, subs);
    let group: Group = "other";
    if (anchor.promo != null && autoIds.has(anchor.promo)) group = "free";
    else if (anchor.promo != null && refIds.has(anchor.promo)) group = "ref";
    else if (anchor.promo != null && codeIds.has(anchor.promo)) group = "code";
    else if (anchor.promo == null && paidOf(anchor)) group = "paid";
    const m = anchor.match;
    const seen = new Set<number>([m.id]);
    const paidDays: number[] = [];
    for (const b of own) {
      if (seen.has(b.match.id) || b.match.day < m.day) continue;
      seen.add(b.match.id);
      if (paidOf(b)) paidDays.push(daysBetween(m.day, b.match.day));
    }
    paidDays.sort((a, b) => a - b);
    let firstCents = 0;
    const spend: [number, number][] = [];
    for (const b of bs) {
      const c = netCents(b);
      if (c <= 0) continue;
      if (b.match.id === m.id) firstCents += c;
      else if (b.match.day >= m.day) spend.push([daysBetween(m.day, b.match.day), c]);
    }
    people.push({
      id: pid, day: m.day, matchId: m.id, city: m.city, fieldKey: m.fieldKey, group,
      spotCents: FREE_GROUPS.has(group) && anchor.amount === 0 && m.priceCents != null ? m.priceCents : 0,
      paidDays, firstCents, spend,
    });
  }

  // ── 9. LEAVES: own spots left before kickoff; late = within 24 hours; refilled = a real booking after ──
  const byMatch = new Map<number, B[]>();
  for (const b of rows) (byMatch.get(b.match.id) ?? byMatch.set(b.match.id, []).get(b.match.id)!).push(b);
  const leaves: Leave[] = [];
  for (const b of rows) {
    if (b.userType !== "PLAYER" || b.leftMs == null || !Number.isFinite(b.leftMs)) continue;
    const m = b.match;
    if (b.leftMs >= m.startMs) continue;
    const fp = firstPlay.get(b.person);
    const leftAt = b.leftMs;
    leaves.push({
      matchId: m.id, day: m.day, city: m.city,
      late: m.startMs - leftAt < DAY_MS,
      firstTimer: fp == null || fp >= m.day,
      refilled: (byMatch.get(m.id) ?? []).some((o) => o.api !== b.api && o.createdMs > leftAt && o.createdMs < m.startMs && (o.paidStatus === "PAID" || o.paidStatus === "FREE")),
    });
  }

  // ── 10. PLAYS (regular players coming back) ───────────────────────────────────────────────────
  const plays: Play[] = rows.filter(played).map((b) => ({ person: b.person, day: b.match.day, city: b.match.city }));

  // ── 11. RATINGS: a review is a roster row with a rating (mdapi_reviews.api_id = the booking's api_id) ──
  const ownById = new Map<number, B>();
  for (const b of rows) if (played(b)) ownById.set(b.api, b);
  const reviews = await selectAll<Row>(() =>
    sb.from("mdapi_reviews").select("api_id, star_rating").gte("start_date", `${rowsFrom}T00:00:00`).not("star_rating", "is", null).order("api_id"));
  const ratings: Rating[] = [];
  for (const r of reviews) {
    const b = ownById.get(num(r.api_id));
    if (!b) continue;
    const fp = firstPlay.get(b.person);
    ratings.push({ day: b.match.day, city: b.match.city, stars: num(r.star_rating), returning: fp != null && fp < b.match.day, matchId: b.match.id });
  }

  const cityCodes = [...new Set([...matches.values()].map((m) => m.city))].filter((c) => c && !EXCLUDED_CITIES.has(c));
  const cities = cityCodes.map((code) => ({ code, name: normalizeMatchCity(code) })).sort((a, b) => a.name.localeCompare(b.name));

  const newest = await sb.from("mdapi_match_players").select("synced_at").order("api_id", { ascending: false }).limit(1);
  if (newest.error) throw new Error(`mdapi_match_players: ${newest.error.message}`);

  return {
    generatedAt: new Date().toISOString(), today, nowMs, mirrorSyncedAt: (newest.data?.[0]?.synced_at as string | undefined) ?? null,
    cities, people, leaves, ratings, plays,
    matches: [...matches.values()].map(({ freeMember: _f, ...m }) => { void _f; return m; }),
  };
}
