/* FIRST-MATCH COST PER FIRST-TIME PLAYER — what Acquisition's "Fully loaded cost per new player" adds
 * to Meta spend (Ryan, 2026-11-09). Server only, read only.
 *
 * For each person growth_player_profile says first played in the range, every participating row on
 * their first-match DAY (growth_participation: standing, settled, started bookings only; 0208/0268) is
 * read back for the promo it used and what it paid:
 *   FIRST-MATCH-AUTO                         free   valued at the match's registration_price, exactly
 *                                                   Free First Match's "Free spots given"
 *   a NEW_USERS 100% code, not a referral    code   registration_price − amount (pre-tax)
 *   a per-player referral code ("123ref")    ref    registration_price − amount
 * The code sets are Free First Match's own (freeFirstMatchBuild, THE CODES). Anything else (a member's
 * free spot, a field-launch code, a paid first match) adds nothing.
 *
 * Rows are fetched by account_id, never user_id (the view's user_id is an expression no index serves;
 * freeFirstMatchBuild step 4). */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { inChunks } from "./freeFirstMatchBuild";
import { FIRST_MATCH_AUTO_CODE, FIRST_MATCH_AUTO_PROD_ID, isReferralCode } from "./freeFirstMatchModel";

export type FirstMatchSpend = { kind: "free" | "code" | "ref"; cents: number };
type Row = Record<string, unknown>;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** person id → their first-match-day bookings that cost us something. */
export async function firstMatchSpend(sb: SupabaseClient, firsts: readonly { user_id: number; first_match_date: string }[]): Promise<Map<number, FirstMatchSpend[]>> {
  const out = new Map<number, FirstMatchSpend[]>();
  if (firsts.length === 0) return out;
  const firstDay = new Map(firsts.map((f) => [num(f.user_id), String(f.first_match_date).slice(0, 10)]));

  const promos = await selectAll<Row>(() =>
    sb.from("mdapi_promocodes").select("api_id, code, target_user_type, discount_type, discount_value")
      .or(`code.ilike.${FIRST_MATCH_AUTO_CODE},and(target_user_type.eq.NEW_USERS,discount_type.eq.PERCENT,discount_value.eq.100)`)
      .order("api_id"));
  const kindOf = new Map<number, FirstMatchSpend["kind"]>([[FIRST_MATCH_AUTO_PROD_ID, "free"]]);
  for (const p of promos) {
    const id = num(p.api_id), code = String(p.code ?? "");
    if (code.toUpperCase() === FIRST_MATCH_AUTO_CODE) kindOf.set(id, "free");
    else if (p.target_user_type === "NEW_USERS" && p.discount_type === "PERCENT" && num(p.discount_value) === 100) kindOf.set(id, isReferralCode(code) ? "ref" : "code");
  }

  // A person's accounts: their own id plus every deleted account growth_person_link maps onto them.
  const links = await selectAll<Row>(() => sb.from("growth_person_link").select("account_id, person_id").order("account_id"));
  const accounts = new Set<number>(firstDay.keys());
  for (const l of links) if (firstDay.has(num(l.person_id))) accounts.add(num(l.account_id));
  const part = (await inChunks(sb, "growth_participation", "player_api_id, user_id, match_api_id, match_date", "account_id", [...accounts], "player_api_id"))
    .filter((r) => firstDay.get(num(r.user_id)) === String(r.match_date));
  if (part.length === 0) return out;

  const books = new Map<number, { amount: number; promo: number | null }>();
  for (const r of await inChunks(sb, "mdapi_match_players", "api_id, amount, promocode_id", "api_id", part.map((p) => num(p.player_api_id)), "api_id", 500)) {
    books.set(num(r.api_id), { amount: num(r.amount), promo: r.promocode_id == null ? null : num(r.promocode_id) });
  }
  /* DOLLARS ONLY. Warsaw's prices are złoty (raw.currency "pln": 3900 is 39 PLN, read 2026-11-09), so a
   * match whose currency is not USD adds nothing rather than adding złoty as dollars. */
  const price = new Map<number, number>();
  for (const r of await inChunks(sb, "mdapi_matches", "api_id, registration_price, currency:raw->>currency", "api_id", [...new Set(part.map((p) => num(p.match_api_id)))], "api_id", 500)) {
    const cur = r.currency == null ? "usd" : String(r.currency).toLowerCase();
    if (cur === "usd") price.set(num(r.api_id), num(r.registration_price));
  }
  for (const p of part) {
    const b = books.get(num(p.player_api_id));
    const kind = b?.promo != null ? kindOf.get(b.promo) : undefined;
    const list = price.get(num(p.match_api_id));
    if (!b || !kind || list == null) continue;
    const cents = kind === "free" ? list : Math.max(0, list - b.amount);
    const uid = num(p.user_id);
    (out.get(uid) ?? out.set(uid, []).get(uid)!).push({ kind, cents });
  }
  return out;
}
