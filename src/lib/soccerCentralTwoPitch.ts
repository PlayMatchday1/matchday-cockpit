// SOCCER CENTRAL — THE TWO-PITCH RULE. One venue's special case, and it reads like one.
//
// Soccer Central has TWO 9v9 pitches side by side. A tournament-size match occupies BOTH, so the
// venue charges twice: $180 rather than $90. Ryan's ruling, final.
//
// ── WHERE THE DOUBLING LIVES, AND WHERE IT MUST NOT ──────────────────────────────────────────
// Cost is rate × charged units. Double both and you get $360, which is the whole risk in this
// change. So:
//
//   · THE RATE carries the doubling. fin_venues 53 "Soccer Central Tournament" holds
//     per_match_rate = 180 AND cost_per_match = 180 — the price of occupying both pitches, once.
//     No expression multiplies anything to reach $180; every cost path multiplies that rate by a
//     charged unit count of ONE.
//   · THE CHARGED UNIT COUNT STAYS 1. chargedUnitCount (financeCosts) and venueMatchCount
//     (financeCosts) must never see this rule.
//   · THE MATCH COUNT IS 2, and only for counts and the denominators derived from them —
//     revenue/match, cost/match, and the match totals on Slate Review and Field Cost.
//
// ── THE BOUNDARY IS A CONSTANT, NOT A MEMORY ─────────────────────────────────────────────────
// resolveSoccerCentral routed on `capacity > 22`. Ryan recalled "i think we said 24", which is a
// remembered number and not a spec, so the boundary is NOT moved on it. 23 is behaviourally
// identical to the `> 22` that shipped.
//
// IT IS NOT A MOOT QUESTION. Measured over all 760 ran matches on fields 102/199/1354:
//     capacity   0 → 24 · 14 → 4 · 16 → 11 · 18 → 248 · 20 → 19 · 22 → 49
//     capacity  24 → 4  · 28 → 5 · 32 → 69 · 36 → 323 · 40 → 4
// FOUR MATCHES SIT AT CAPACITY 24 and none at 23, so a boundary of 23 and a boundary of 25
// disagree about exactly those four. They are listed in the report and flagged; nobody has ruled.
export const SOCC_TWO_PITCH_MIN_CAPACITY = 23;

/* THE FIELDS. An explicit named list, never a capacity or category test — a test is what would
 * quietly drag 1123 back in the first time someone renamed a field or changed a cap.
 *
 * 1123 "Soccer Central World Cup Tournament" IS EXCLUDED. It is a special-event field: all 33 of
 * its matches carry capacity 0, it keeps whatever treatment it has today, and it appears nowhere in
 * the Soccer Central line's cost, count or revenue.
 *
 * 1552 is NOT here either, and is not Soccer Central at all — it is "Tourney ATH Katy", 9 matches,
 * city HOU. The brief that asked for it to be mapped here was working from a wrong title. */
export const SOCC_TWO_PITCH_FIELD_IDS: readonly number[] = [102, 199, 1354];
export const SOCC_EXCLUDED_FIELD_IDS: readonly number[] = [1123];

export const isSoccerCentralTwoPitchField = (fieldId: number | null | undefined): boolean =>
  fieldId != null && SOCC_TWO_PITCH_FIELD_IDS.includes(Number(fieldId));

/** Does this match occupy both pitches? Capacity only — the field must already be one of ours. */
export const isTwoPitchCapacity = (maxPlayerCount: number | null | undefined): boolean =>
  maxPlayerCount != null && Number(maxPlayerCount) >= SOCC_TWO_PITCH_MIN_CAPACITY;

/** The full rule: a Soccer Central two-pitch match. */
export const isSoccerCentralTwoPitch = (fieldId: number | null | undefined, maxPlayerCount: number | null | undefined): boolean =>
  isSoccerCentralTwoPitchField(fieldId) && isTwoPitchCapacity(maxPlayerCount);

/* HOW MANY MATCHES IS IT. Two for a two-pitch match, one otherwise — counts and denominators only.
 * Never a cost multiplier. */
export const matchUnits = (fieldId: number | null | undefined, maxPlayerCount: number | null | undefined): number =>
  isSoccerCentralTwoPitch(fieldId, maxPlayerCount) ? 2 : 1;

/* THE EVENT DROP, NARROWED — NOT DELETED.
 *
 * `venueCategory(field_title) === "event"` discards 1,749 of 7,671 ran matches network-wide, across
 * 19 fields and every city. That guard is load-bearing for combines, showdowns, cup brackets and
 * "Special Events at …" rows, and none of that changes.
 *
 * What changes is 388 matches on field 199 "Tourney at Soccer Central", which the guard has been
 * dropping as events since it was written — so Ryan's ruling that tournaments are regular matches
 * had never reached this code, and those matches were invisible AND costless. A Soccer Central
 * match that meets the two-pitch rule is no longer dropped. Field 1123 keeps being dropped, because
 * it is not in SOCC_TWO_PITCH_FIELD_IDS. */
export const survivesEventDrop = (fieldId: number | null | undefined, maxPlayerCount: number | null | undefined): boolean =>
  isSoccerCentralTwoPitch(fieldId, maxPlayerCount);
