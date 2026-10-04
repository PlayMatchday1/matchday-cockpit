// HOW MANY TIMES A PROMO CODE WAS REDEEMED — ONE RULE for every number on the promo screens
// (Ryan, 2026-10-04): the list's REDEEMED column, the drawer's top tiles and summary line, and the
// USES tiles and list underneath. MatchDay's own usageCount is NOT used anywhere: it matched no set
// of bookings (SIETEFC2026 / 22287: usageCount 12, 28 rows, 16 standing, 6 played).
//
// A REDEMPTION IS A BOOKING THAT STANDS: a mdapi_match_players row carrying promocode_id that is not
// cancelled, not refunded, not an unsettled checkout (paidStatus WAITING) — gamedayModel's
// rosterRowCounts(), the predicate _count.players is proven against — and not soft-deleted in our
// mirror (deleted_at, the mirror-only condition in docs/matchday-api-facts.md).
//
// THE HEADLINE IS PLAYED: a standing booking on a match that was not cancelled and whose kickoff has
// passed. Standing bookings on a match later cancelled, and on a match still to come, are counted
// separately and shown under the headline. Kickoff is mdapi_matches.start_date, which is LOCAL WALL
// CLOCK despite its Z — compared as text against Chicago's wall clock now, never through new Date().
//
// VALUE is each played match's list price (registration_price, cents) — a 100%-off code's bookings
// carry amount 0, so summing what was paid measured nothing (the old "$12.00" was one abandoned
// checkout). Distinct users and uses per player are over the played bookings too.

import type { SupabaseClient } from "@supabase/supabase-js";
import { rosterRowCounts } from "./gamedayModel";
import { wallClockPartsInZone } from "./businessHours";
import { UNCAPPED } from "./promoModel";

export type UseKind = "played" | "cancelled-match" | "upcoming";

export type MirrorUse = {
  api_id: number; promocode_id: number; match_api_id: number | null; user_id: number | null;
  paid_status: string | null; is_cancelled: boolean | null; canceled_at: string | null;
  refunded: boolean | null; deleted_at: string | null;
};
export type MirrorMatch = { api_id: number; start_date: string | null; is_cancelled: boolean | null; registration_price: number | null };

/** Chicago's wall clock now, "YYYY-MM-DDTHH:MM" — the same shape as a start_date's first 16 chars. */
export function chicagoWallNow(now: Date = new Date()): string {
  const p = wallClockPartsInZone(now.getTime());
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

export const stands = (r: MirrorUse): boolean =>
  r.deleted_at == null && rosterRowCounts({
    isCancelled: r.is_cancelled === true, canceledAt: r.canceled_at, refunded: r.refunded === true, paidStatus: r.paid_status,
  });

/** What a booking is, or null when it does not stand. A booking whose match is not in our copy is
 *  "upcoming" only if it has no kickoff to compare — it cannot be called played without one. */
export function useKind(r: MirrorUse, m: MirrorMatch | undefined, wallNow: string): UseKind | null {
  if (!stands(r)) return null;
  if (m?.is_cancelled === true) return "cancelled-match";
  const kick = m?.start_date ? String(m.start_date).slice(0, 16) : null;
  return kick != null && kick <= wallNow ? "played" : "upcoming";
}

export type RedemptionStats = {
  /** THE headline: standing bookings on played matches. */
  played: number;
  cancelledMatch: number;
  upcoming: number;
  /** Over the played bookings. */
  distinctUsers: number;
  usesPerUser: number;
  /** The heaviest player's played uses — what a per-person cap is read against. */
  mostUsed: number;
  /** Played matches' list price, in cents. */
  worthCents: number;
};
export const EMPTY_STATS: RedemptionStats = { played: 0, cancelledMatch: 0, upcoming: 0, distinctUsers: 0, usesPerUser: 0, mostUsed: 0, worthCents: 0 };

export function redemptionStats(rows: MirrorUse[], matches: Map<number, MirrorMatch>, wallNow: string): RedemptionStats {
  const s = { ...EMPTY_STATS };
  const perUser = new Map<string, number>();
  for (const r of rows) {
    const m = r.match_api_id != null ? matches.get(r.match_api_id) : undefined;
    const k = useKind(r, m, wallNow);
    if (k === "cancelled-match") s.cancelledMatch++;
    else if (k === "upcoming") s.upcoming++;
    else if (k === "played") {
      s.played++;
      s.worthCents += Number(m?.registration_price ?? 0) || 0;
      // one person = one id, deleted or not (promoUsesModel.keyOf); no id falls back to the row
      const u = r.user_id != null ? `p${r.user_id}` : `r${r.api_id}`;
      perUser.set(u, (perUser.get(u) ?? 0) + 1);
    }
  }
  s.distinctUsers = perUser.size;
  s.usesPerUser = perUser.size ? s.played / perUser.size : 0;
  s.mostUsed = Math.max(0, ...perUser.values());
  return s;
}

const USE_COLS = "api_id, promocode_id, match_api_id, user_id, paid_status, is_cancelled, canceled_at, refunded, deleted_at";

/** Our copy's bookings for these codes and their matches. READ ONLY. Keyset-paged on api_id (the
 *  mirror is paged by keyset, never offset-without-order — docs/matchday-api-facts.md). */
export async function loadRedemptions(sb: SupabaseClient, promoIds: number[]): Promise<{ rows: MirrorUse[]; matches: Map<number, MirrorMatch> }> {
  const rows: MirrorUse[] = [];
  for (let i = 0; i < promoIds.length; i += 200) {
    const ids = promoIds.slice(i, i + 200);
    let last = 0;
    for (;;) {
      const { data, error } = await sb.from("mdapi_match_players").select(USE_COLS)
        .in("promocode_id", ids).gt("api_id", last).order("api_id").limit(1000);
      if (error) throw new Error(`mdapi_match_players: ${error.message}`);
      const page = (data ?? []) as MirrorUse[];
      rows.push(...page);
      if (page.length < 1000) break;
      last = page[page.length - 1].api_id;
    }
  }
  const matchIds = [...new Set(rows.map((r) => r.match_api_id).filter((x): x is number => x != null))];
  const matches = new Map<number, MirrorMatch>();
  for (let i = 0; i < matchIds.length; i += 500) {
    const { data, error } = await sb.from("mdapi_matches").select("api_id, start_date, is_cancelled, registration_price").in("api_id", matchIds.slice(i, i + 500));
    if (error) throw new Error(`mdapi_matches: ${error.message}`);
    for (const m of (data ?? []) as MirrorMatch[]) matches.set(m.api_id, m);
  }
  return { rows, matches };
}

/** Stats for each code asked for (a code with no booking gets EMPTY_STATS, a real zero). */
export async function statsFor(sb: SupabaseClient, promoIds: number[], now: Date = new Date()): Promise<Map<number, RedemptionStats>> {
  const { rows, matches } = await loadRedemptions(sb, promoIds);
  const wallNow = chicagoWallNow(now);
  const by = new Map<number, MirrorUse[]>();
  for (const r of rows) by.set(r.promocode_id, [...(by.get(r.promocode_id) ?? []), r]);
  return new Map(promoIds.map((id) => [id, by.has(id) ? redemptionStats(by.get(id)!, matches, wallNow) : { ...EMPTY_STATS }]));
}

/** LEFT. A per-person cap shows the heaviest player against it ("2 of 10 (most used)"); a total cap
 *  is cap − played ("over by N" past it, lib/promoModel.leftLabel); no cap is "—". */
export function leftFromStats(p: { numberOfUsesPerUser: number; targetMatchType: string }, s: RedemptionStats):
  { label: string; tone: "normal" | "spent" | "over" } {
  if (p.numberOfUsesPerUser >= UNCAPPED) return { label: "—", tone: "normal" };
  const cap = p.numberOfUsesPerUser;
  if (p.targetMatchType === "TOTAL_USAGE") {
    const left = cap - s.played;
    return { label: left < 0 ? `over by ${(-left).toLocaleString()}` : left.toLocaleString(), tone: left < 0 ? "over" : left === 0 ? "spent" : "normal" };
  }
  return { label: `${s.mostUsed.toLocaleString()} of ${cap.toLocaleString()} (most used)`, tone: s.mostUsed > cap ? "over" : s.mostUsed === cap ? "spent" : "normal" };
}

/** "10 more on cancelled matches · 2 on upcoming matches" — the standing bookings that are not the
 *  headline. Null when there are none. */
export function notPlayedLine(s: RedemptionStats): string | null {
  const parts: string[] = [];
  if (s.cancelledMatch) parts.push(`${s.cancelledMatch.toLocaleString()} more on cancelled matches`);
  if (s.upcoming) parts.push(`${s.upcoming.toLocaleString()} on upcoming matches`);
  return parts.length ? parts.join(" · ") : null;
}
