// WHAT COUNTS AS A PLAY, AND WHO IS ACTIVE — one definition, shared by the Cities Users lens
// (/api/cities/users-lens, where it was written) and the Locations page (2026-10-08).
//
// A VALID PLAY: a roster row that is not cancelled, is not a fake player, has user_type PLAYER, and
// belongs to a match that is not cancelled (and not soft-deleted in our mirror).
// ACTIVE (30 days): the player's LATEST valid play starts within the last 30 days, compared on the
// match's true instant (matchStartMs), never the wall-clock start_date. The latest play can be an
// upcoming booking — that is the Users lens behaviour, kept, not changed.
//
// KNOWN GAP, stated rather than fixed: a valid play does NOT exclude paid_status "WAITING" (a checkout
// that never settled; CLAUDE.md, rosterRowCounts). The Users lens never did, and this file reuses its
// definition rather than inventing a new one.
//
// MEMBER: an ACTIVE subscription with a price above zero (also the Users lens rule).

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { matchStartMs } from "./matchTime";
import { isPaidMemberSubscription } from "./membershipStats";

export const ACTIVE_DAYS = 30;
const DAY_MS = 86_400_000;

export type PlayRowLike = { is_cancelled: boolean | null; user_is_fake_player: boolean | null; user_type: string | null };
export function isValidPlayRow(p: PlayRowLike): boolean {
  return !p.is_cancelled && !p.user_is_fake_player && p.user_type === "PLAYER";
}

/* A PLAY ON THE LOCATIONS PAGE is a valid row that SETTLED: paid_status PAID or FREE (Ryan, 2026-10-29).
 * WAITING is a checkout that never settled (CLAUDE.md, the _count.players trap): 1,343 of 74,146 stored
 * map plays were a match where the player had only WAITING rows. Locations only; isValidPlayRow above
 * is the rest of Growth's rule and is unchanged. */
export type SettledPlayRowLike = PlayRowLike & { paid_status: string | null };
export function isSettledPlayRow(p: SettledPlayRowLike): boolean {
  return isValidPlayRow(p) && (p.paid_status === "PAID" || p.paid_status === "FREE");
}

/** Active = latest valid play's true start is at or after now − 30 days (future bookings count). */
export function isActiveByLastPlay(lastStartMs: number | null, now: Date): boolean {
  return lastStartMs != null && lastStartMs >= now.getTime() - ACTIVE_DAYS * DAY_MS;
}

/* A MEMBER, for the Users lens and Locations: status ACTIVE and the shared paying-member rule
 * (membershipStats.isPaidMemberSubscription: plan above $5, staff emails, INCOMPLETE). This was
 * `price > 0` with no email test, so staff read as members here and
 * not on the Membership page. member_email is REQUIRED so a caller cannot forget to select it. */
export type SubLike = { status: string | null; price: number | string | null; member_email: string | null };
export function isPaidActiveSub(s: SubLike): boolean {
  return s.status === "ACTIVE" && isPaidMemberSubscription(s);
}

/**
 * Every user id that is ACTIVE (30 days) right now. Reads only the matches that can make someone
 * active — start on or after now − 30 days, plus a day of slack for the wall-clock column, then
 * filtered on the TRUE instant — and their roster rows. Supabase only.
 */
/** `cityIdentifier` narrows to matches in one city (mdapi_matches.city_identifier), in the query —
 *  the Locations scope's "active Warsaw players". Omitted = every city, as before. */
export async function activePlayerIds(sb: SupabaseClient, now: Date, cityIdentifier?: string | null): Promise<Set<number>> {
  // start_date is wall clock with a Z it does not mean; it is used ONLY to narrow the fetch, with a
  // day of slack either way. The decision is made on matchStartMs below.
  const floor = new Date(now.getTime() - (ACTIVE_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const matches = await selectAll<{ api_id: number; start_date: string | null; start_date_utc: string | null }>(() => {
    const q = sb.from("mdapi_matches").select("api_id,start_date,start_date_utc")
      .gte("start_date", floor).eq("is_cancelled", false).is("deleted_at", null);
    return (cityIdentifier ? q.eq("city_identifier", cityIdentifier) : q).order("api_id");
  });
  const ids = matches.filter((m) => isActiveByLastPlay(matchStartMs(m.start_date_utc, m.start_date), now)).map((m) => m.api_id);

  const out = new Set<number>();
  const CHUNK = 200;
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  // A few chunks at a time: each is several 1,000-row pages of roster rows.
  for (let i = 0; i < chunks.length; i += 4) {
    const rows = await Promise.all(chunks.slice(i, i + 4).map((c) =>
      selectAll<PlayRowLike & { user_id: number | null }>(() =>
        sb.from("mdapi_match_players").select("api_id,user_id,is_cancelled,user_is_fake_player,user_type")
          .in("match_api_id", c).is("deleted_at", null).order("api_id"))));
    for (const r of rows.flat()) if (r.user_id != null && isValidPlayRow(r)) out.add(r.user_id);
  }
  return out;
}
