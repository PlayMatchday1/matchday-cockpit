// REMOVING A STRIKE — the arithmetic, and the rule for when the control is live.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/strike-removal-test.ts
//
// WHY THIS IS A SUITE AND NOT A BROWSER LOOK. Two numbers on this screen are easy to get wrong in a
// way that looks right: the control's weight and the confirm's promise. activeStrikes is the
// SERVER's SUM of penaltyPoints, so a NO SHOW worth 2 and a LATE worth 1 do not move it by the same
// amount, and a confirm derived from a ROW COUNT is correct for the LATE and wrong for the NO SHOW.
// Worse, a member above the threshold can lose a point and still be suspended — a confirm that
// promised a lift there is a lie an operator acts on. None of that is visible by looking at a page
// with one strike on it.
//
// The shapes here are real, from /admin/players/{id} on 2026-09-17:
//   staging 569    activeStrikes 3, logs 614 (1pt LATE) and 613 (2pt NO_SHOW), expiredAt 2026-09-21
//   production 74253  activeStrikes 2, four logs, TWO of them penaltyPoint 0 (CANCEL_W_IN_SOME_HOURS)
import { strikeControl, removalEffect, strikeRemovalApplied, STRIKE_LIMIT } from "../src/lib/playerLookupModel";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? (pass++, console.log(`  ✓ ${n}`))
    : (fail++, console.log(`  ✗ ${n}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
const ok = (n: string, c: boolean) => c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`));

const NOW = Date.parse("2026-09-17T12:00:00Z");
const OPEN = "2026-09-21T08:18:27.266Z";   // staging 569's window, still open at NOW
const SHUT = "2026-09-01T00:00:00.000Z";   // the same record, after it lapses
const log = (o: Partial<{ id: number | null; penaltyPoint: number; active: boolean }> = {}) =>
  ({ id: 614, penaltyPoint: 1, active: true, ...o });

console.log("\nTHE CONTROL — three states, and the label IS the state:");
eq("a live 1-point strike offers Remove 1",
  strikeControl(log(), OPEN, NOW).label, "Remove 1");
ok("  and it is enabled", strikeControl(log(), OPEN, NOW).enabled);
eq("a live 2-point strike says Remove 2, not Remove",
  strikeControl(log({ penaltyPoint: 2 }), OPEN, NOW).label, "Remove 2");

// A ZERO-POINT LOG IS REAL. Production 74253 carries two: a cancellation early enough to be
// recorded and not charged. Removing one would move nothing, so the control says why rather than
// vanishing — a row with no button beside rows that have one reads as a broken page.
eq("a zero-point strike reads No penalty",
  strikeControl(log({ penaltyPoint: 0 }), OPEN, NOW).label, "No penalty");
ok("  and is disabled", !strikeControl(log({ penaltyPoint: 0 }), OPEN, NOW).enabled);
ok("  and never renders Remove 0 or Expired 0",
  !/\b0\b/.test(strikeControl(log({ penaltyPoint: 0 }), OPEN, NOW).label));

// Retool's rule is penaltyPoint > 0 && expiredAt in the future. `active` is the third term because
// it is the per-LOG field this API actually returns; the expiry is on the parent strike record.
eq("an inactive log is Expired, with its weight",
  strikeControl(log({ penaltyPoint: 2, active: false }), OPEN, NOW).label, "Expired 2");
ok("  and is disabled", !strikeControl(log({ active: false }), OPEN, NOW).enabled);
eq("a log whose STRIKE RECORD has lapsed is Expired even though the log says active",
  strikeControl(log({ penaltyPoint: 2 }), SHUT, NOW).label, "Expired 2");
ok("  and is disabled", !strikeControl(log({ penaltyPoint: 2 }), SHUT, NOW).enabled);
ok("a null expiredAt is treated as no open window", !strikeControl(log(), null, NOW).enabled);

// THE ID IS WHAT NAMES THE STRIKE TO THE API. Before this change playerProfile dropped it and the
// panel keyed rows by array index, so nothing on screen could say which strike was meant.
ok("a log with no id cannot be removed", !strikeControl(log({ id: null }), OPEN, NOW).enabled);

console.log("\nTHE CONFIRM — the weight leads, and it comes from POINTS not rows:");
// staging 569 exactly: 3 points, not suspended.
eq("removing the 1-point LATE promises 1 point and 2 of 4",
  removalEffect(3, 1, false).sentence, "Removes 1 strike point. They go to 2 of 4.");
eq("removing the 2-point NO SHOW promises 2 points and 1 of 4",
  removalEffect(3, 2, false).sentence, "Removes 2 strike points. They go to 1 of 4.");
ok("  the two move the total by different amounts, which a row count could not express",
  removalEffect(3, 1, false).after !== removalEffect(3, 2, false).after);
eq("one point is singular", removalEffect(3, 1, false).weight, "Removes 1 strike point.");
eq("two points are plural", removalEffect(3, 2, false).weight, "Removes 2 strike points.");

console.log("\nTHE SUSPENSION — lifts, held, or neither:");
eq("at the threshold, removing a point lifts the suspension",
  removalEffect(4, 1, true).sentence,
  "Removes 1 strike point. They go to 3 of 4, and the suspension lifts.");
eq("  and it is classified as a lift", removalEffect(4, 1, true).outcome, "lifts");

/* OVER THE THRESHOLD IS THE ONE THAT MATTERS. activeStrikes can exceed the limit — the panel
 * already renders a pip-over chip for it. Five minus one is four, which is still the threshold and
 * still a suspension. A confirm that promised a lift here would be acted on. */
eq("above the threshold, removing one point does NOT lift it",
  removalEffect(5, 1, true).sentence,
  "Removes 1 strike point. They go to 4 of 4, and stay suspended, because 4 is still the threshold.");
eq("  and it is classified as held", removalEffect(5, 1, true).outcome, "held");
eq("but removing a 2-point strike from 5 does lift it", removalEffect(5, 2, true).outcome, "lifts");
ok("  CONTROL: the two differ only in the strike's own weight",
  removalEffect(5, 1, true).outcome !== removalEffect(5, 2, true).outcome);
eq("an unsuspended member gets neither sentence",
  removalEffect(2, 1, false).outcome, "plain");

console.log("\nEDGES:");
eq("the total never goes below zero", removalEffect(1, 2, false).after, 0);
eq("a non-finite penalty is treated as zero rather than NaN", removalEffect(3, NaN, false).after, 3);
eq("STRIKE_LIMIT is the 4 the copy quotes", STRIKE_LIMIT, 4);

console.log("\nDID IT LAND — the two shapes a removal actually leaves behind:");
// Measured on staging 569: the row survives with penaltyPoint 0 and active still true.
ok("a log left in place with zero points counts as applied",
  strikeRemovalApplied({ present: true, points: 0 }));
// And when the last points go, the whole strike record vanishes, so the log is not there at all.
ok("a log gone from the record counts as applied",
  strikeRemovalApplied({ present: false, points: null }));
ok("CONTROL: a log still carrying its points is NOT applied",
  !strikeRemovalApplied({ present: true, points: 1 }));
ok("  nor a 2-point one", !strikeRemovalApplied({ present: true, points: 2 }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
