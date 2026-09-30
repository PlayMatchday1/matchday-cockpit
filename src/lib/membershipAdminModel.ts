/* MEMBERSHIP ADMIN — the decisions, kept out of the component and out of the routes so both read
 * the same rule and the gate can exercise every branch without a browser.
 *
 * ── THE FACTS THIS ENCODES, ALL READ OUT OF THE NEST SOURCE ──────────────────────────────────
 * See docs/matchday-api-facts.md, "SUBSCRIPTIONS — the four admin writes". In short:
 *   - Both adds block on `status in (ACTIVE, ADDED_FROM_ADMIN)`. A CANCELED row blocks NEITHER,
 *     so a closed membership can be reopened.
 *   - `unsubscribeForAdmin` matches `status != CANCELED`, so a player-cancelled row — which keeps
 *     status ACTIVE until its period runs out — is still endable.
 *   - `updateSubscriptionPrice` has NO status filter and NO deletedAt filter. It will reprice a
 *     CANCELED row and return true. That refusal is OURS to enforce; see `priceRefusal`.
 *   - A COMP (ADDED_FROM_ADMIN) has no Stripe subscription at all. A FREE membership ($0) has a
 *     real one. They are not two skins of one thing.
 */

/** The four states a membership can be in, as far as the controls are concerned. */
export type MemKind = "none" | "paid" | "free" | "comped" | "selfcancel" | "ended";

export type MemFacts = {
  id: number | null;
  statusRaw: string | null;
  stripeSubscriptionId: string | null;
  canceledAt: string | null;
  price: number | null;   // CENTS, as the API carries it
};

const up = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** ADDED_FROM_ADMIN is the comp. It is the one status that means "no Stripe object exists". */
export const isComp = (m: MemFacts | null): boolean => up(m?.statusRaw) === "ADDED_FROM_ADMIN";
export const isEnded = (m: MemFacts | null): boolean => up(m?.statusRaw) === "CANCELED";

/** What kind of membership is on screen. Order matters: ended first, then comp, then the $0 case. */
export function memKind(m: MemFacts | null): MemKind {
  if (!m || m.id == null) return "none";
  if (isEnded(m)) return "ended";
  if (isComp(m)) return "comped";
  // A PLAYER CANCELLATION KEEPS status ACTIVE. It is not an ended membership and is still endable.
  if (m.canceledAt) return "selfcancel";
  // A REAL STRIPE SUBSCRIPTION AT $0. Distinct from a comp: it renews, it can fail, it exists in
  // Stripe — it simply never charges. membershipStats excludes it from paid members on price_cents.
  if ((m.price ?? 0) <= 0) return "free";
  return "paid";
}

/** Which actions the API's own rules permit. Never a guess — see the header. */
export function actionsFor(m: MemFacts | null): { add: boolean; price: boolean; end: boolean; why: string | null } {
  const k = memKind(m);
  if (k === "none") return { add: true, price: false, end: false, why: "No membership on file." };
  // CANCELED blocks neither add endpoint, so a closed membership can be reopened. It cannot be
  // re-priced or re-ended: `unsubscribeForAdmin` filters it out, and repricing it is refused here
  // because the API would not refuse it itself.
  if (k === "ended") return { add: true, price: false, end: false, why: "This membership is closed." };
  return { add: false, price: true, end: true, why: null };
}

/* ── THE PRICE REFUSAL, WHICH IS ENTIRELY OURS ───────────────────────────────────────────────
 * `updateSubscriptionPrice` looks the row up by id alone. It will reprice a CANCELED or
 * soft-deleted membership and answer `true`, which would put a price change in the change log
 * against a membership nobody holds. The API will not stop that, so this does. */
export function priceRefusal(m: MemFacts | null, cents: number): string | null {
  if (!m || m.id == null) return "There is no membership to price.";
  if (isEnded(m)) return "This membership is closed. Re-open it before setting a price.";
  if (!Number.isInteger(cents)) return "The price must be a whole number of cents.";
  if (cents < 0) return "A price cannot be negative.";
  // A NO-OP IS REFUSED RATHER THAN SENT. The write is not idempotent and every send is a row in
  // the log; sending the number that is already there buys nothing and costs a false entry.
  if (m.price != null && cents === m.price) return "That is already the price.";
  return null;
}

/** END refuses an empty reason. `cancel-subscription-dto` is `@IsString()` only, so the API
 *  accepts "" — every guard on this is ours. Whitespace is not a reason. */
export function endRefusal(m: MemFacts | null, reason: string): string | null {
  if (!m || m.id == null) return "There is no membership to end.";
  if (isEnded(m)) return "This membership is already closed.";
  if (!reason.trim()) return "A reason is required — it is the only record of why this membership was ended.";
  return null;
}

/* ── WHAT THE TWO READS ESTABLISHED ──────────────────────────────────────────────────────────
 * Both admin write paths SWALLOW a Stripe failure and update the MatchDay row regardless:
 *
 *     const res = await this.stripeService.cancelSubscription(...);
 *     if (res instanceof Error) { /* TODO: handle cases if Stripe failed *​/ }
 *     await this.userSubscriptionsRepository.updateById(id, { …, status: CANCELED });
 *
 * So a row reading CANCELED does not mean the charge stopped. Reading the row proves one thing and
 * reading Stripe proves the other, and they are reported as TWO FACTS rather than one verdict.
 * `stripe: "absent"` is not a failure — a comp has no subscription to check, and saying "Stripe did
 * not move" about an object that does not exist would be a false alarm. */
export type WriteVerdict = {
  row: "moved" | "unchanged";
  stripe: "moved" | "unchanged" | "absent" | "unreadable";
  subscriptionId: string | null;
};

/** One sentence per outcome. NOTHING HERE CLAIMS A CHARGE STOPPED ON THE STRENGTH OF A ROW READ. */
export function verdictSentence(v: WriteVerdict, action: "end" | "price"): string {
  const what = action === "end" ? "ended" : "re-priced";
  if (v.row === "unchanged") {
    return `The membership was not ${what}. MatchDay reported success but the record did not change, so nothing was applied.`;
  }
  if (v.stripe === "absent") {
    return action === "end"
      ? "Ended at MatchDay. There was no Stripe subscription behind it, so there was nothing to cancel and nothing was being charged."
      : "Re-priced at MatchDay. There is no Stripe subscription behind this membership, so no charge changed.";
  }
  if (v.stripe === "moved") {
    return action === "end"
      ? `Ended at MatchDay, and Stripe subscription ${v.subscriptionId} is cancelled. Billing has stopped.`
      : `Re-priced at MatchDay, and Stripe subscription ${v.subscriptionId} now carries the new amount.`;
  }
  if (v.stripe === "unchanged") {
    // THE SWALLOWED ERROR, NAMED AT THE MOMENT IT HAPPENS, with the id someone needs to fix it.
    return action === "end"
      ? `MatchDay shows this ended, but Stripe subscription ${v.subscriptionId} is still live. MatchDay swallows a Stripe failure and marks the row anyway. THE PLAYER IS STILL BEING CHARGED — cancel ${v.subscriptionId} in Stripe.`
      : `MatchDay shows the new price, but Stripe subscription ${v.subscriptionId} still carries the old one. MatchDay swallows a Stripe failure and updates the row anyway. THE PLAYER IS STILL BEING CHARGED THE OLD AMOUNT — fix ${v.subscriptionId} in Stripe.`;
  }
  return `Applied at MatchDay. Stripe could not be read, so whether billing changed is unconfirmed — check subscription ${v.subscriptionId} in Stripe.`;
}

/** The change-log line for the Stripe half, so the log carries both facts and not just ours. */
export function verdictLogValue(v: WriteVerdict): string {
  if (v.stripe === "absent") return "no Stripe subscription (comp)";
  if (v.stripe === "moved") return `Stripe ${v.subscriptionId} confirmed`;
  if (v.stripe === "unchanged") return `Stripe ${v.subscriptionId} UNCHANGED — swallowed failure, still billing`;
  return `Stripe ${v.subscriptionId} unreadable`;
}

/* ── DOLLARS ON SCREEN, CENTS ON THE WIRE ────────────────────────────────────────────────────
 * Retool's field is a bare number multiplied by 100 on send, so an operator typing 4900 meaning
 * $49 sends $4,900 and nothing contradicts them. The dialog takes DOLLARS and shows the cents it
 * will send; this is the conversion both halves use. */
export function centsFromDollars(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  if (!/^\d*(\.\d{0,2})?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export const dollarsFromCents = (cents: number | null | undefined): string =>
  cents == null ? "" : (cents / 100).toFixed(2);

/* ── THE COMP IS DISABLED, AND IT IS NOT A STYLE CHOICE ──────────────────────────────────────
 * MEASURED ON STAGING 2026-09-30, on player 570. `subscribeSpecificUser` created the row — the API
 * proves it by answering USER_ALREADY_SUBSCRIBED to every later add — and the row is then invisible
 * to EVERY read endpoint we have:
 *
 *   GET /admin/players/{id}   userSubscriptions: []      (users.repository.ts include:
 *                                 where status in [ACTIVE] AND currentPeriodEnd >= now.
 *                                 A comp is ADDED_FROM_ADMIN with no period end: it fails BOTH.)
 *   GET /admin/subscriptions  0 rows under every status, and 0 when filtered by the member's email.
 *
 * So a comp cannot be displayed, cannot be confirmed, cannot be re-priced and CANNOT BE ENDED —
 * ending is keyed on the numeric id, which nothing will tell us. The row this verification created
 * on staging 570 is still there and cannot be removed through any endpoint.
 *
 * A BUTTON THAT WRITES AN UNREMOVABLE INVISIBLE ROW IS WORSE THAN ONE THAT DOES NOTHING, so it is
 * disabled and says why. The free add is unaffected: it writes ACTIVE with a period end, passes
 * both terms of the filter, and was verified end to end on staging 571.
 *
 * TO RE-ENABLE: widen that include to carry ADDED_FROM_ADMIN (and drop or relax the
 * currentPeriodEnd term, which also hides cancelled and lapsed rows). Nothing here needs to change
 * but this constant. */
export const COMP_DISABLED_REASON =
  "A comped membership cannot be managed from here. MatchDay creates the row but returns it from no "
  + "endpoint, so it could not be shown, re-priced or ended afterwards — only blocked from being "
  + "added again. Use the free $0 subscription, which behaves normally.";
export const COMP_ADD_ENABLED = false;

/** The two add kinds, named by what they DO rather than by their endpoint suffix. */
export type AddKind = "comp" | "free";
export const addPathFor = (userId: number, kind: AddKind): string =>
  kind === "free" ? `/admin/subscriptions/users/${userId}/free` : `/admin/subscriptions/users/${userId}`;

/** Did the add land? Both endpoints return `true`, which proves nothing — read the row back. */
export function addApplied(after: MemFacts | null, kind: AddKind): boolean {
  if (!after || after.id == null) return false;
  const s = up(after.statusRaw);
  return kind === "comp" ? s === "ADDED_FROM_ADMIN" : s === "ACTIVE";
}
