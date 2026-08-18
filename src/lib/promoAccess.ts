// WHO MAY READ PROMO CODES — a PURE decision, so the client gate and the server gate are one
// definition rather than two that agree until they don't.
//
// WHY THIS FILE EXISTS. The promo READS were opened to Match Ops in Phase 23 Part D — /api/promos
// list, detail, check, fields and matches all moved onto matchOpsReadGate. The client was not moved
// with them: the screen stayed gated on canManagePromos, the WRITE flag. Exactly one account in the
// estate holds that flag, so fifteen people — five of them admins — were shown "You do not hold
// MANAGE PROMOS" for a list the server would have handed over. A refusal on a screen the API grants
// is worse than a missing feature: it tells the operator something false about their own access.
//
// IT MUST TRACK matchOpsReadGate (matchOpsAuth.ts:26-45), CLAUSE FOR CLAUSE — same three checks in
// the same order. matchops-auth-test asserts the agreement across every flag shape, which is the
// only thing stopping the two from drifting apart again.
//
// This module imports NOTHING. useAuth cannot be loaded outside a browser (it constructs the
// Supabase client at module scope), and a decision that can only be exercised in a browser is a
// decision that will not be exercised.

export type PromoAccessRow = {
  is_admin?: boolean | null;
  can_access_matchops?: boolean | null;
  is_city_manager?: boolean | null;
  is_service_account?: boolean | null;
};

export function canReadPromos(row: PromoAccessRow | null | undefined): boolean {
  if (!row) return false;
  // A machine account must never read player-adjacent data, whatever its row happens to carry.
  if (row.is_service_account === true) return false;
  // isCityManagerConfined (adminAuth.ts:46). The tier is scoped to /city, and can_access_matchops
  // sitting true on their row is the leak that check closes — never a grant.
  if (row.is_city_manager === true && row.is_admin !== true) return false;
  // is_admin is not REQUIRED, but it is SUFFICIENT — the same shape the server uses.
  return row.is_admin === true || row.can_access_matchops === true;
}
