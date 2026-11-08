/* FREE FIRST MATCH — building the page's payload from the mirror. Server only, read only.
 * Pulled out of the route so a script can run it with a service-role client and print what the page
 * will show against a direct count (docs/free-first-match/DISCOVERY.md, "Deploy check"). The route
 * (src/app/api/lifecycle/free-first-match/route.ts) adds the auth gate and a short warm cache. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { addDays, chicagoYmd, chicagoToday, wallClockYmd } from "./weekBuckets";
import { normalizeMatchCity } from "./growthAnalytics";
import { canonicalVenueName } from "./venueResolver";
import {
  BEFORE_FROM, BEFORE_SIGNUP_DAYS, BEFORE_TO, FIRST_MATCH_AUTO_CODE, FIRST_MATCH_AUTO_PROD_ID, LAUNCH_DAY, MAX_WINDOW,
  PROPOSAL_LOOKBACK_DAYS, daysBetween, isPaidBooking, isReferralCode,
  type FieldRate, type Group, type MatchRow, type Payload, type Person, type Signup, type SubLite,
} from "./freeFirstMatchModel";

type Row = Record<string, unknown>;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const chunks = <T,>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

type Sb = SupabaseClient;

/** `.in(col, ids)` in chunks, each chunk paged on its own stable key until a short page. */
async function inChunks(sb: Sb, table: string, cols: string, col: string, ids: number[], orderKey: string, size = 200): Promise<Row[]> {
  const out: Row[] = [];
  for (const chunk of chunks(ids, size)) {
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from(table).select(cols).in(col, chunk).order(orderKey).range(off, off + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...((data ?? []) as unknown as Row[]));
      if ((data ?? []).length < 1000) break;
    }
  }
  return out;
}

export async function buildFreeFirstMatch(sb: SupabaseClient): Promise<Payload> {
  const today = chicagoToday();

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

  // ── 2. THE FREE CLAIMS: every booking under the auto code, then the ones that stand ────────
  const autoRows = await inChunks(sb, "mdapi_match_players", "api_id, user_id, match_api_id", "promocode_id", [...autoIds], "api_id", 50);
  const autoApiIds = autoRows.map((r) => num(r.api_id));
  const autoPart = await inChunks(sb, "growth_participation", "player_api_id, user_id, match_api_id, match_date, account_id", "player_api_id", autoApiIds, "player_api_id", 500);

  // ── 3. THE BEFORE COHORT: first match Aug 7 … Nov 4 ───────────────────────────────────────
  const profile = await selectAll<Row>(() =>
    sb.from("growth_player_profile").select("user_id, first_match_date")
      .gte("first_match_date", BEFORE_FROM).lte("first_match_date", BEFORE_TO).order("user_id"));

  const personIds = new Set<number>();
  for (const r of autoPart) personIds.add(num(r.user_id));
  for (const r of profile) personIds.add(num(r.user_id));
  const ids = [...personIds];

  // ── 4. EVERY PARTICIPATING ROW OF EVERY PERSON IN A COHORT ────────────────────────────────
  // FILTERED ON account_id, NOT user_id. The view's user_id is COALESCE(link.person_id, p.user_id),
  // an expression no index serves: a `.in("user_id", …)` scans every roster row and times out
  // (measured 2026-11-05). account_id is the raw p.user_id and rides its index. A person's accounts
  // are their own id plus every deleted account growth_person_link maps onto them.
  const links = await selectAll<Row>(() => sb.from("growth_person_link").select("account_id, person_id").order("account_id"));
  const accountsOf = new Map<number, number[]>();
  for (const id of ids) accountsOf.set(id, [id]);
  for (const l of links) { const pid = num(l.person_id); if (accountsOf.has(pid)) accountsOf.get(pid)!.push(num(l.account_id)); }
  const cohortAccounts = [...new Set([...accountsOf.values()].flat())];
  type Part = { api: number; user: number; match: number; day: string; city: string; field: number | null; account: number };
  const part: Part[] = (await inChunks(sb, "growth_participation", "player_api_id, user_id, match_api_id, match_date, city_identifier, field_id, account_id", "account_id", cohortAccounts, "player_api_id"))
    .map((r) => ({ api: num(r.player_api_id), user: num(r.user_id), match: num(r.match_api_id), day: String(r.match_date), city: String(r.city_identifier ?? ""), field: r.field_id == null ? null : num(r.field_id), account: num(r.account_id) }));
  const byPerson = new Map<number, Part[]>();
  for (const p of part) (byPerson.get(p.user) ?? byPerson.set(p.user, []).get(p.user)!).push(p);

  // ── 5. WHAT THE VIEW DOES NOT CARRY: the booking's type, amount and promo ─────────────────
  type Book = { userType: string | null; amountCents: number; promocodeId: number | null };
  const books = new Map<number, Book>();
  for (const r of await inChunks(sb, "mdapi_match_players", "api_id, user_type, amount, promocode_id", "api_id", part.map((p) => p.api), "api_id", 500)) {
    books.set(num(r.api_id), { userType: r.user_type == null ? null : String(r.user_type), amountCents: num(r.amount), promocodeId: r.promocode_id == null ? null : num(r.promocode_id) });
  }

  // ── 6. THE MATCHES: the cohort's, plus every live match from launch for the card and the log ─
  type M = { id: number; wall: string; day: string; city: string; field: string; price: number; freeMember: boolean; booked: number; cap: number | null; ffe: boolean | null };
  // ffe: firstMatchFreeEnabled lives only in raw (docs/matchday-api-facts.md, FREE FIRST MATCH).
  const matchCols = "api_id, start_date, city_identifier, field_title, registration_price, is_free_member, max_player_count, player_count, is_cancelled, deleted_at, ffe:raw->firstMatchFreeEnabled";
  const toM = (r: Row): M => ({
    id: num(r.api_id), wall: String(r.start_date ?? "").slice(0, 16), day: wallClockYmd(String(r.start_date ?? "")),
    city: String(r.city_identifier ?? ""), field: canonicalVenueName(String(r.field_title ?? "")) || String(r.field_title ?? ""),
    price: num(r.registration_price), freeMember: r.is_free_member === true, booked: num(r.player_count),
    cap: r.max_player_count == null ? null : num(r.max_player_count),
    ffe: typeof r.ffe === "boolean" ? r.ffe : null,
  });
  const matches = new Map<number, M>();
  const cohortMatchIds = [...new Set(part.map((p) => p.match))];
  for (const r of await inChunks(sb, "mdapi_matches", matchCols, "api_id", cohortMatchIds, "api_id", 500)) matches.set(num(r.api_id), toM(r));
  const live = await selectAll<Row>(() =>
    sb.from("mdapi_matches").select(matchCols).is("deleted_at", null).eq("is_cancelled", false)
      .gte("start_date", `${LAUNCH_DAY}T00:00:00`).order("api_id"));
  for (const r of live) matches.set(num(r.api_id), toM(r));

  // ── 7. MEMBERSHIPS, by every account id a person has carried ──────────────────────────────
  const accountIds = [...new Set([...ids, ...part.map((p) => p.account)])];
  const subsByAccount = new Map<number, SubLite[]>();
  for (const r of await inChunks(sb, "mdapi_subscriptions", "membership_id, user_id, activation_date, canceled_at", "user_id", accountIds, "membership_id")) {
    const uid = num(r.user_id);
    (subsByAccount.get(uid) ?? subsByAccount.set(uid, []).get(uid)!).push({
      activationDay: r.activation_date ? chicagoYmd(String(r.activation_date)) : null,
      canceledDay: r.canceled_at ? chicagoYmd(String(r.canceled_at)) : null,
    });
  }
  const subsOf = (person: number, parts: Part[]): SubLite[] => {
    const accs = new Set<number>([person, ...parts.map((p) => p.account)]);
    const out: SubLite[] = [];
    for (const a of accs) out.push(...(subsByAccount.get(a) ?? []));
    return out;
  };

  // ── 8. NAMES, from the users mirror: a deleted account reads "Deleted Account" ────────────
  const names = new Map<number, string>();
  for (const r of await inChunks(sb, "mdapi_users", "id, first_name, last_name", "id", ids, "id")) {
    names.set(num(r.id), `${String(r.first_name ?? "").trim()} ${String(r.last_name ?? "").trim()}`.trim() || `Player ${num(r.id)}`);
  }

  // ── 9. ONE PERSON PER COHORT MEMBER ───────────────────────────────────────────────────────
  const autoByPerson = new Map<number, Part>();
  for (const r of autoPart) {
    const uid = num(r.user_id);
    const cand: Part = { api: num(r.player_api_id), user: uid, match: num(r.match_api_id), day: String(r.match_date), city: "", field: null, account: num(r.account_id) };
    const prev = autoByPerson.get(uid);
    if (!prev || cand.day < prev.day || (cand.day === prev.day && cand.api < prev.api)) autoByPerson.set(uid, cand);
  }

  const people: Person[] = [];
  for (const uid of ids) {
    const parts = (byPerson.get(uid) ?? []).slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.api - b.api));
    if (parts.length === 0) continue;
    const subs = subsOf(uid, parts);
    const paidOf = (p: Part): boolean => {
      const b = books.get(p.api), m = matches.get(p.match);
      return !!b && !!m && isPaidBooking(b, { isFreeMember: m.freeMember, day: m.day }, subs);
    };

    // The anchor: the free claim for the free group, else the earliest participating row.
    const auto = autoByPerson.get(uid);
    const anchor = auto ? (parts.find((p) => p.api === auto.api) ?? parts[0]) : parts[0];
    const ab = books.get(anchor.api);
    let group: Group | null = null;
    if (auto) group = "free";
    else if (ab?.promocodeId != null && refIds.has(ab.promocodeId)) group = "ref";
    else if (ab?.promocodeId != null && codeIds.has(ab.promocodeId)) group = "code";
    else if (ab?.promocodeId == null && paidOf(anchor)) group = "paid";
    if (!group) continue;
    if (group !== "free" && (anchor.day < BEFORE_FROM || anchor.day > BEFORE_TO)) continue;

    const am = matches.get(anchor.match);
    // Follow-ups: the person's OTHER matches, own spot only, from the anchor day on.
    const seen = new Set<number>([anchor.match]);
    const paidDays: string[] = [];
    for (const p of parts) {
      if (seen.has(p.match) || p.day < anchor.day) continue;
      seen.add(p.match);
      if (paidOf(p)) paidDays.push(p.day);
    }
    paidDays.sort();
    const paidOffsets = paidDays.slice(0, 2).map((d) => daysBetween(anchor.day, d));

    people.push({
      id: uid, name: names.get(uid) ?? `Player ${uid}`, group, anchor: anchor.day, matchId: anchor.match,
      city: am?.city || anchor.city, cityName: normalizeMatchCity(am?.city || anchor.city), field: am?.field ?? "",
      spotCents: am?.price ?? 0, paidOffsets, bookFill: null,
    });
  }

  // ── 10. REAL FILL WHEN EACH FREE SPOT WAS BOOKED (for the proposal) ───────────────────────
  // Rows that count (rosterRowCounts' rule: PAID or FREE, not cancelled) created before the free
  // booking and not cancelled by then. Fake fills are left out: a real player displaces them, so they
  // never stand between a paying player and a spot. paid_status is the row's status NOW, so a row
  // still WAITING at the time but settled later counts as it ended.
  const freeBooking = new Map<number, number>(); // person -> booking api id
  for (const [uid, a] of autoByPerson) freeBooking.set(uid, a.api);
  const freeMatchIds = [...new Set(people.filter((p) => p.group === "free").map((p) => p.matchId))];
  const rosterRows = await inChunks(sb, "mdapi_match_players", "api_id, match_api_id, paid_status, is_cancelled, canceled_at, created_at, user_is_fake_player", "match_api_id", freeMatchIds, "api_id", 100);
  const rowsByMatch = new Map<number, Row[]>();
  for (const r of rosterRows) { const m = num(r.match_api_id); (rowsByMatch.get(m) ?? rowsByMatch.set(m, []).get(m)!).push(r); }
  for (const p of people) {
    if (p.group !== "free") continue;
    const api = freeBooking.get(p.id), rows = rowsByMatch.get(p.matchId) ?? [], cap = matches.get(p.matchId)?.cap ?? null;
    const mine = rows.find((r) => num(r.api_id) === api);
    if (!mine || !cap) continue;
    const at = String(mine.created_at);
    const before = rows.filter((r) => num(r.api_id) !== api && r.user_is_fake_player !== true && String(r.created_at) < at
      && (r.paid_status === "PAID" || r.paid_status === "FREE")
      && (r.is_cancelled !== true || (r.canceled_at != null && String(r.canceled_at) > at))).length;
    p.bookFill = before / cap;
  }

  // ── 11. SIGN-UPS, by Chicago day, with the person's first match day ───────────────────────
  // From far enough back for the 30-day "before" cohort (launch - 30 - 1 - 27). completed_sign_up_at
  // is TRUE UTC, read as its Chicago day; first_match_date is a wall-clock day. A person who had
  // played before this sign-up (a re-registration) is not a new player and is left out.
  const signupFrom = addDays(LAUNCH_DAY, -(MAX_WINDOW + BEFORE_SIGNUP_DAYS + 1));
  const regRows = await selectAll<Row>(() =>
    sb.from("growth_registration").select("user_id, account_id, completed_sign_up_at")
      .eq("completed", true).gte("completed_sign_up_at", `${addDays(signupFrom, -1)}T00:00:00Z`).order("account_id"));
  const regPersons = [...new Set(regRows.map((r) => num(r.user_id)))];
  const firstOf = new Map<number, string | null>();
  for (const r of await inChunks(sb, "growth_player_profile", "user_id, first_match_date", "user_id", regPersons, "user_id", 300)) {
    firstOf.set(num(r.user_id), r.first_match_date == null ? null : String(r.first_match_date));
  }
  const signups: Signup[] = [];
  for (const r of regRows) {
    const day = chicagoYmd(String(r.completed_sign_up_at));
    if (day < signupFrom) continue;
    const first = firstOf.get(num(r.user_id)) ?? null;
    if (first != null && first < day) continue;
    signups.push({ day, first });
  }

  // ── 12. FIELD SELL-OUT RATES over the 4 weeks to yesterday (wall-clock days) ──────────────
  const rateFrom = addDays(today, -PROPOSAL_LOOKBACK_DAYS);
  const recent = await selectAll<Row>(() =>
    sb.from("mdapi_matches").select(matchCols).is("deleted_at", null).eq("is_cancelled", false)
      .gte("start_date", `${rateFrom}T00:00:00`).lt("start_date", `${today}T00:00:00`).order("api_id"));
  const rateMap = new Map<string, FieldRate>();
  for (const m of recent.map(toM)) {
    if (m.day < rateFrom || m.day >= today) continue;
    const k = `${m.city}|${m.field}`;
    const e = rateMap.get(k) ?? rateMap.set(k, { city: m.city, field: m.field, matches: 0, soldOut: 0 }).get(k)!;
    e.matches++;
    if (m.cap != null && m.cap > 0 && m.booked >= m.cap) e.soldOut++;
  }

  // ── 13. THE MATCH LIST, with the free claimants anchored on each ──────────────────────────
  const freeOn = new Map<number, { id: number; name: string }[]>();
  for (const p of people) if (p.group === "free") (freeOn.get(p.matchId) ?? freeOn.set(p.matchId, []).get(p.matchId)!).push({ id: p.id, name: p.name });
  const matchRows: MatchRow[] = live.map(toM).map((m) => ({
    id: m.id, day: m.day, wall: m.wall, city: m.city, cityName: normalizeMatchCity(m.city), field: m.field,
    booked: m.booked, cap: m.cap, priceCents: m.price, ffe: m.ffe, freePlayers: freeOn.get(m.id) ?? [],
  }));

  const newest = await sb.from("mdapi_match_players").select("synced_at").order("api_id", { ascending: false }).limit(1);
  if (newest.error) throw new Error(`mdapi_match_players: ${newest.error.message}`);

  return {
    generatedAt: new Date().toISOString(), today, mirrorSyncedAt: (newest.data?.[0]?.synced_at as string | undefined) ?? null,
    autoPromoIds: [...autoIds], autoBookingsStanding: autoPart.length,
    people, signups, matches: matchRows, fieldRates: [...rateMap.values()],
  };
}
