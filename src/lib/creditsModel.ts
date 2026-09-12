// Phase 27 — the credit ADJUSTMENT model. Pure, because this is the one screen in Clubhouse where
// being wrong moves real money into or out of a real person's account.
//
// ── WHAT PART 0 PROVED, and what this file is built on ──────────────────────────────────────────
//
// UNITS: `creditAmount` is CENTS. Proven on production, not assumed: of 31 non-zero balances in a
// 1,200-player scan, 22 are NOT multiples of 100 (74, 99, 399, 866, 974). Read as dollars those
// would be $74.00 / $866.00 balances on 22 of 31 accounts; read as cents they are $0.74 / $8.66
// change left over from a match — and Retool renders `creditAmount / 100` as USD and writes back
// `parseInt(value * 100)`. Everything below therefore holds CENTS and converts only at the edge.
//
// ENDPOINT: PUT /admin/players/{id}/profile with body { creditAmount: <cents> }. ABSOLUTE SET, not
// a delta — Retool pre-fills its stepper with the current balance and posts the whole new value.
//
// ── WHY THIS TAKES A DELTA ANYWAY ───────────────────────────────────────────────────────────────
// The API sets an absolute value, but the OPERATOR enters an adjustment ("+25", "-10") and this
// computes current + delta. A stepper pre-filled with someone's balance means a single mis-key
// silently REPLACES their money with a different number, and nothing on screen would look wrong:
// "60" is a plausible balance and a plausible typo. An adjustment cannot fail that way — the worst
// a mis-key does is move the wrong amount, which the stated before/after shows you before you
// commit, and which the change_log records.

export const CENTS = 100;

// THE TYPO CAP. Not a security control — a route re-check would be the security control, and the
// grant is the authority. This stops a fat finger turning $25 into $2500. Two deliberate
// adjustments are always possible, and are logged twice, which is the honest way to move more.
export const MAX_ADJUSTMENT_CENTS = 200 * CENTS;

export const fmtUsd = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / CENTS).toFixed(2)}`;

// Parse what was typed into CENTS. Accepts "+25", "-10", "25", "12.34", "$12.34", "−10" (the
// U+2212 MINUS SIGN, which is what a Mac keyboard and a copy-paste from a spreadsheet produce —
// treating it as junk would reject a perfectly clear instruction).
export function parseAdjustment(raw: string): { ok: true; cents: number } | { ok: false; error: string } {
  const t = String(raw ?? "").trim().replace(/−/g, "-").replace(/[$,\s]/g, "");
  if (t === "" || t === "+" || t === "-") return { ok: false, error: "Enter an amount to add or subtract." };
  if (!/^[+-]?\d*\.?\d*$/.test(t)) return { ok: false, error: "Amounts are numbers only — for example +25 or -10.50." };
  if (!Number.isFinite(Number(t))) return { ok: false, error: "Amounts are numbers only — for example +25 or -10.50." };
  // DOLLARS IN, CENTS OUT — computed FROM THE DIGITS, never by multiplying a float. `0.145 * 100`
  // is 14.499999999999998 in IEEE-754, so Math.round would hand back 14c for an input that plainly
  // means 15c. On a money field that is not a rounding preference, it is a wrong answer.
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m) return { ok: false, error: "Amounts are numbers only — for example +25 or -10.50." };
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] === "" ? 0 : Number(m[2]);
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = sign * (whole * CENTS + Number(frac.slice(0, 2)));
  if (Number(frac[2]) >= 5) cents += sign;   // half-up on the third decimal, in the sign's direction
  if (cents === 0) return { ok: false, error: "That rounds to nothing — the smallest adjustment is one cent." };
  return { ok: true, cents };
}

export type Validation = {
  ok: boolean;
  deltaCents: number | null;
  beforeCents: number;
  afterCents: number | null;
  consequence: string | null;   // stated BEFORE the click
  errors: string[];             // every reason it is not ready, not just the first
};

// Everything the button needs to know, in one place, so the sentence shown to the operator and the
// number that would be sent are computed from the SAME arithmetic. If they were computed
// separately, the screen could promise one figure and send another.
// Exported so the panel can tell this apart from the other errors by identity rather than by
// matching its prose. It is the only error that fires on an UNTOUCHED form — the amount error is
// already guarded on a non-empty input above — so it is the only one the panel has to hold back.
// SHORTENED 2026-09-10, value and behaviour unchanged: still required, still compared by identity
// rather than by prose. It used to add "— it is written to the change log with the amount."
export const REASON_REQUIRED = "A reason is required";

export function validateAdjustment(input: { raw: string; reason: string; beforeCents: number; playerName: string; canEdit: boolean }): Validation {
  const errors: string[] = [];
  const parsed = parseAdjustment(input.raw);
  const delta = parsed.ok ? parsed.cents : null;
  if (!parsed.ok && String(input.raw ?? "").trim() !== "") errors.push(parsed.error);

  // A REASON IS MANDATORY. Money that moves with no recorded reason is unauditable, and this is
  // the one place in Clubhouse where that matters most. The button does not enable without it.
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) errors.push(REASON_REQUIRED);

  if (delta != null && Math.abs(delta) > MAX_ADJUSTMENT_CENTS) {
    errors.push(
      `${fmtUsd(Math.abs(delta))} is over the ${fmtUsd(MAX_ADJUSTMENT_CENTS)} limit for a single adjustment. ` +
      `This is a typo guard, not a permission: if you mean it, do it in two steps and both will be logged.`);
  }
  if (!input.canEdit) errors.push("You do not hold EDIT CREDITS. This is granted separately from Match Ops.");

  const after = delta == null ? null : input.beforeCents + delta;
  // NEGATIVE BALANCES: UNKNOWN whether the API rejects one — 0 of 1,200 production accounts holds a
  // negative balance, and the only way to learn more would be to write one, which is not a probe
  // anyone should run against a real person. So Clubhouse refuses to be the thing that finds out.
  if (after != null && after < 0) {
    errors.push(`That would take the balance to ${fmtUsd(after)}. Clubhouse does not send a negative balance — whether the API would accept one is untested, and this is not the place to find out.`);
  }

  const consequence = delta == null || after == null ? null
    : `${input.playerName}'s balance goes from ${fmtUsd(input.beforeCents)} to ${fmtUsd(after)}.`;

  return {
    ok: errors.length === 0 && delta != null,
    deltaCents: delta, beforeCents: input.beforeCents, afterCents: after, consequence, errors,
  };
}

// ── THE RACE ────────────────────────────────────────────────────────────────────────────────────
// The endpoint is an ABSOLUTE SET, so if the player spends between the read the screen was drawn
// from and the write, sending `screenBalance + delta` silently CLOBBERS the spend. The route
// re-reads immediately before writing and calls this; a mismatch ABORTS. It does not re-base the
// delta onto the new figure and carry on — the operator decided on a number they were shown, and
// the honest response is to tell them what changed, not to quietly act on different facts.
export function raceCheck(expectedBeforeCents: number, freshBeforeCents: number): { ok: true } | { ok: false; error: string } {
  if (expectedBeforeCents === freshBeforeCents) return { ok: true };
  return {
    ok: false,
    error: `Aborted — nothing was sent. The balance changed from ${fmtUsd(expectedBeforeCents)} to ${fmtUsd(freshBeforeCents)} ` +
      `between the screen loading and this click. Re-enter the adjustment against the new figure if you still want it.`,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CREDIT EVERYONE WHO PAID — the plan for a whole match, pure.
//
// Ryan: "in the match editors need a button that credits everyone in the match. Sometimes the
// manager doesnt show up ... This would 1 button action for all players in the match."
//
// THE WEATHER CASE IS NOT THIS. Cancelling a match already credits every signed-up player and texts
// them (a server-side effect of PATCH /admin/matches/{id}/cancel — see the facts doc), and
// Clubhouse already fires it from the Cancel card. This is the OTHER case: the match happened, the
// manager did not, the record stands, and everyone should have their money back as credit. The two
// must never run on the same match, which is why the route refuses a cancelled one outright.
//
// ── WHAT EACH PLAYER GETS: RULE C, THE CARD CHARGE PLUS THE CREDIT THEY SPENT ──────────────────
// Measured across three live matches (18519 / 19068 / 18952), the three candidate rules give
// $757.50 / $855.00 / $840.00 (pre-tax price), $773.77 / $814.36 / $882.75 (card charge) and
// $816.54 / $917.16 / $907.40 (card charge + wallet credit spent). Ryan chose the third, and the
// reason is not generosity: a player who paid ENTIRELY from their wallet has a totalAmount of 0, so
// the card-charge rule refunds them nothing for a match they turned up to. That row exists — match
// 18503 carries paid $8.00 / credit $8.00. Rule C is everything they gave up.
//
// ── credit_amount IS CREDIT SPENT, NOT CREDIT RECEIVED ─────────────────────────────────────────
// The facts doc's own identity settles it: total_amount = round((amount − credit_amount) × (1 +
// city rate)), fitting 93.1% of production rows — it comes off the price BEFORE tax. So a roster
// row showing "$12.00 credit" is somebody who paid with their wallet, and they are owed a refund
// like everyone else. An earlier draft skipped exactly those rows, which would have denied a refund
// to the players who had already spent their balance down. They are credited, and the confirm says
// so on its own line.
//
// MEASURED: of 413 payable rows sampled since June, 26 carry no totalAmount — and every one of them
// paid by credit, so Rule C never returns zero for somebody who actually paid.
export const MAX_RUN_CENTS = 2000 * CENTS;   // approved: roughly twice the largest live roster's payout
export const MAX_RUN_PLAYERS = 60;           // approved: a typo guard, not a policy

/** A roster row as /admin/matches/{id}/players returns it — only the fields the money rule reads. */
export type MoneyRosterRow = {
  id?: number | string | null;
  userId?: number | null;
  amount?: number | null;
  totalAmount?: number | null;
  creditAmount?: number | null;
  paidStatus?: string | null;
  isCancelled?: boolean | null;
  canceledAt?: string | null;
  refunded?: boolean | null;
  isFakePlayer?: boolean | null;
  userType?: string | null;
  user?: { id?: number | null; isFakePlayer?: boolean | null } | null;
};

const cents = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** RULE C, in one place: the card charge plus any wallet credit they spent on this spot. */
export const creditOwedCents = (r: MoneyRosterRow): number =>
  Math.max(0, cents(r.totalAmount) + cents(r.creditAmount));

export const rosterUserId = (r: MoneyRosterRow): number | null => {
  const id = r.userId ?? r.user?.id ?? null;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* THE SKIP REASONS, and each is a different fact about a person rather than a catch-all. They are
 * GROUPED on the confirm — four or five lines, never a roster — because a count alone cannot tell
 * you the six members were excluded, and that is the number somebody has to be able to check. */
export type SkipReason =
  | "holds no spot"
  | "payment never settled"
  | "member, paid nothing"
  | "included, paid nothing"
  | "already credited for this match"
  | "no charge recorded";

export type CreditTarget = { userId: number; rowId: string | null; cents: number; paidWithCreditCents: number };
export type CreditSkip = { reason: SkipReason; count: number; cents: number };
export type CreditPlan = {
  pay: CreditTarget[];
  skips: CreditSkip[];
  totalCents: number;
  paidWithCreditCount: number;
  paidWithCreditCents: number;
  /** Non-null when the run exceeds a cap; the route refuses and the UI states it. */
  overCap: string | null;
};

export function planCreditRun(
  rows: MoneyRosterRow[],
  opts: { alreadyCreditedUserIds?: Iterable<number> } = {},
): CreditPlan {
  const already = new Set<number>(opts.alreadyCreditedUserIds ?? []);
  const pay: CreditTarget[] = [];
  const skipped: SkipReason[] = [];
  const skipCents = new Map<SkipReason, number>();
  const note = (reason: SkipReason, c: number) => { skipped.push(reason); skipCents.set(reason, (skipCents.get(reason) ?? 0) + c); };

  for (const r of rows ?? []) {
    const owed = creditOwedCents(r);
    const uid = rosterUserId(r);
    const fake = r.isFakePlayer === true || r.user?.isFakePlayer === true;
    const cancelled = r.isCancelled === true || r.canceledAt != null;
    // A ROW HOLDING NO SPOT WAS NEVER CHARGED FOR ONE — a fake, or a cancelled sign-up.
    if (fake || cancelled) { note("holds no spot", owed); continue; }
    // WAITING NEVER SETTLED. A retried checkout leaves one row per attempt; paying them out would
    // refund money that never arrived. Same predicate the occupancy numbers use.
    if (r.paidStatus === "WAITING") { note("payment never settled", owed); continue; }
    if (uid == null) { note("holds no spot", owed); continue; }
    // PAID NOTHING, OWED NOTHING. Crediting a member who paid $0 is a gift, not a refund.
    if (cents(r.amount) === 0 && owed === 0) {
      note(String(r.userType ?? "").toUpperCase() === "GUEST" ? "included, paid nothing" : "member, paid nothing", 0);
      continue;
    }
    // OUR OWN LEDGER SAYS WE ALREADY DID THIS ONE. See the route header for what that can and
    // cannot see.
    if (already.has(uid)) { note("already credited for this match", owed); continue; }
    // Paid something, but no charge and no wallet credit recorded against it. Not guessed at: it is
    // skipped and stated, so somebody can look rather than be quietly short-changed.
    if (owed === 0) { note("no charge recorded", 0); continue; }
    pay.push({ userId: uid, rowId: r.id == null ? null : String(r.id), cents: owed, paidWithCreditCents: cents(r.creditAmount) });
  }

  const order: SkipReason[] = ["already credited for this match", "payment never settled", "member, paid nothing", "included, paid nothing", "holds no spot", "no charge recorded"];
  const skips = order
    .map((reason) => ({ reason, count: skipped.filter((s) => s === reason).length, cents: skipCents.get(reason) ?? 0 }))
    .filter((s) => s.count > 0);

  const totalCents = pay.reduce((s, t) => s + t.cents, 0);
  const withCredit = pay.filter((t) => t.paidWithCreditCents > 0);
  const overCap = totalCents > MAX_RUN_CENTS
    ? `That run totals ${fmtUsd(totalCents)}, over the ${fmtUsd(MAX_RUN_CENTS)} ceiling for one run.`
    : pay.length > MAX_RUN_PLAYERS
      ? `That run covers ${pay.length} players, over the ${MAX_RUN_PLAYERS}-player ceiling for one run.`
      : null;

  return {
    pay, skips, totalCents,
    paidWithCreditCount: withCredit.length,
    paidWithCreditCents: withCredit.reduce((s, t) => s + t.paidWithCreditCents, 0),
    overCap,
  };
}
