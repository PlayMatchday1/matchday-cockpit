// Promo model + timezone unit tests (Phase 18b). Pins the rules the screen depends on:
// state derivation, CAP/LEFT (the three cap shapes, never negative), and the TRUE-UTC ⇄
// America/Chicago conversion — including the two worked defaults, which use DIFFERENT DST
// offsets (proof the code is DST-aware, not a fixed −06:00).
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/promo-model-test.ts
import {
  promoState, promoBucket, discountLabel, capLabel, leftLabel, leftTone, usageLine, UNCAPPED,
  nameList, createSummary, type PromoRow,
} from "../src/lib/promoModel";
import {
  chicagoWallToUtcIso, utcIsoToChicagoWall, nextQuarterHourUtcIso, endOfYearUtcIso, chicagoYearOf,
  toChicagoInputs, fromChicagoInputs, fmtChicagoFull,
} from "../src/lib/promoTz";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const ok = (name: string, cond: boolean, d = "") => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} — ${d}`)); };

const NOW = "2026-08-10T13:35:00.000Z"; // Aug 10 2026, 08:35 Chicago (CDT, −05:00)
const row = (o: Partial<PromoRow>): PromoRow => ({
  id: 1, code: "X", startDateUtc: "2026-01-01T00:00:00.000Z", endDateUtc: "2026-12-31T00:00:00.000Z",
  discountType: "PERCENT", discountValue: 50, targetUserType: "ALL_USERS", numberOfUsesPerUser: 1,
  targetMatchType: "ALL_MATCHES", matchTimePeriodStart: null, matchTimePeriodEnd: null,
  createdAt: "2025-12-01T00:00:00.000Z", deletedAt: null, ...o,
});

console.log("STATE (deleted wins; else scheduled/expired/active):");
eq("active: start past, end future", promoState(row({ startDateUtc: "2026-08-01T00:00:00.000Z", endDateUtc: "2026-09-01T00:00:00.000Z" }), NOW), "active");
eq("scheduled: start in the future", promoState(row({ startDateUtc: "2026-09-01T00:00:00.000Z", endDateUtc: "2026-10-01T00:00:00.000Z" }), NOW), "scheduled");
eq("expired: end in the past", promoState(row({ startDateUtc: "2026-01-01T00:00:00.000Z", endDateUtc: "2026-03-01T00:00:00.000Z" }), NOW), "expired");
eq("deleted WINS over a future window", promoState(row({ startDateUtc: "2026-09-01T00:00:00.000Z", endDateUtc: "2026-10-01T00:00:00.000Z", deletedAt: "2026-08-02T00:00:00.000Z" }), NOW), "deleted");
eq("bucket LIVE = end >= now (deleted-future stays LIVE)", promoBucket(row({ endDateUtc: "2026-09-01T00:00:00.000Z", deletedAt: "2026-08-01T00:00:00.000Z" }), NOW), "live");
eq("bucket PAST = end < now", promoBucket(row({ endDateUtc: "2026-03-01T00:00:00.000Z" }), NOW), "past");

console.log("DISCOUNT + CAP:");
eq("percent label", discountLabel(row({ discountType: "PERCENT", discountValue: 25 })), "25%");
eq("usd label (cents → dollars)", discountLabel(row({ discountType: "USD", discountValue: 500 })), "$5.00");
eq("cap: a number", capLabel(row({ numberOfUsesPerUser: 5 })), "5");
eq("cap: 10000 sentinel prints 'no cap', never the number", capLabel(row({ numberOfUsesPerUser: UNCAPPED })), "no cap");

console.log("LEFT (the three branches; never negative):");
eq("TOTAL_USAGE: cap − redeemed", leftLabel(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 5 }), 2), "3");
// 18c item 4 — over-redemption is SURFACED as "over by N", not clamped to 0 (it's a real finding).
eq("TOTAL_USAGE over cap: 'over by N', not clamped to 0", leftLabel(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 1 }), 1288), "over by 1,287");
eq("non-TOTAL cap: 'per user'", leftLabel(row({ targetMatchType: "ALL_MATCHES", numberOfUsesPerUser: 1 }), 1288), "per user");
eq("no-cap sentinel: '—'", leftLabel(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: UNCAPPED }), 500), "—");
eq("leftTone over-redeemed = 'over'", leftTone(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 3 }), 7), "over");
eq("leftTone exactly spent = 'spent'", leftTone(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 5 }), 5), "spent");
eq("leftTone with room = 'normal'", leftTone(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 5 }), 2), "normal");
// no LEFT branch may ever contain a "-" (a minus sign); "over by N" satisfies this
{ const samples = [leftLabel(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 1 }), 1288), leftLabel(row({ targetMatchType: "ALL_MATCHES", numberOfUsesPerUser: 1 }), 1288), leftLabel(row({ numberOfUsesPerUser: UNCAPPED }), 9)];
  ok("no LEFT value contains a minus sign", samples.every((s) => !s.includes("-")), JSON.stringify(samples)); }

console.log("USAGE LINE (one-liner, all three shapes):");
eq("TOTAL_USAGE line", usageLine(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 5 }), 4), "4 redeemed · 1 left of 5");
eq("TOTAL_USAGE over-cap line surfaces the overage", usageLine(row({ targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 3 }), 7), "7 redeemed · 4 OVER the total cap of 3");
eq("per-user line", usageLine(row({ targetMatchType: "ALL_MATCHES", numberOfUsesPerUser: 1 }), 1288), "1,288 redeemed · cap 1 per user");
eq("no-cap line", usageLine(row({ numberOfUsesPerUser: UNCAPPED }), 235), "235 redeemed · no cap");

console.log("DUPLICATE VERDICT (18c item 1 — never call a taken code free):");
// "MA" (id 2547) is a REAL two-char code. ?code=MA has totalItems=94, but the API's DEFAULT page
// is 20 rows and the literal "MA" is NOT among them (it sorts elsewhere in the substring set). A
// page-scan-only check finds no exact match in those 20 and would report FREE — for a code that
// is taken. This is THE failure the three-way verdict prevents. Named "MA" on purpose: a generic
// "duplicate detected" test passes today and would have passed while this bug was live.
import { dupeVerdict } from "../src/lib/promoModel";
eq("'MA': exact absent from the fetched page BUT more matches exist → inconclusive (never free)",
   dupeVerdict([{ code: "matchday801" }, { code: "matchday1694" }], 94, "MA"), "inconclusive");
eq("'MA': exact IS in the fetched set → taken", dupeVerdict([{ code: "MA" }, { code: "matchday801" }], 94, "MA"), "taken");
eq("'MA' case-insensitive: 'ma' among rows → taken", dupeVerdict([{ code: "ma" }], 94, "MA"), "taken");
eq("complete set fetched, no exact → free", dupeVerdict([{ code: "summerfun" }], 1, "summer"), "free");

console.log("TIMEZONE — TRUE UTC ⇄ America/Chicago, DST-aware:");
// The two worked defaults from the prompt, verbatim:
eq("wall 2026-08-10 08:45 Chicago (CDT −05:00) → 13:45Z", chicagoWallToUtcIso({ y: 2026, mo: 8, d: 10, h: 8, mi: 45 }), "2026-08-10T13:45:00.000Z");
eq("wall 2026-12-31 23:59 Chicago (CST −06:00) → 2027-01-01 05:59Z", chicagoWallToUtcIso({ y: 2026, mo: 12, d: 31, h: 23, mi: 59 }), "2027-01-01T05:59:00.000Z");
eq("nextQuarterHour from 08:35 Chicago → 13:45Z", nextQuarterHourUtcIso(Date.parse(NOW)), "2026-08-10T13:45:00.000Z");
eq("endOfYear 2026 → 2027-01-01 05:59Z", endOfYearUtcIso(2026), "2027-01-01T05:59:00.000Z");
// the two defaults use DIFFERENT offsets — proof it is NOT a fixed −06:00
{ const aug = Date.parse("2026-08-10T13:45:00.000Z") - Date.parse(fromChicagoInputs("2026-08-10", "08:45")); // 0
  const augOff = (Date.parse("2026-08-10T13:45:00.000Z") - Date.UTC(2026, 7, 10, 8, 45)) / 3600000; // 5
  const decOff = (Date.parse("2027-01-01T05:59:00.000Z") - Date.UTC(2026, 11, 31, 23, 59)) / 3600000; // 6
  ok(`Aug offset is +5h, Dec offset is +6h (different) — DST-aware`, augOff === 5 && decOff === 6 && aug === 0, `aug=${augOff} dec=${decOff}`); }
eq("chicagoYearOf(now) is 2026", chicagoYearOf(Date.parse(NOW)), 2026);
// round-trip: wall → UTC → wall is identity
{ const w = { y: 2026, mo: 7, d: 4, h: 19, mi: 30 }; const back = utcIsoToChicagoWall(chicagoWallToUtcIso(w)); eq("round-trip wall↔utc↔wall", back, w); }
// input helpers round-trip
{ const iso = "2026-08-10T13:45:00.000Z"; const { date, time } = toChicagoInputs(iso); eq("toChicagoInputs(13:45Z) = 08:45 Aug10", { date, time }, { date: "2026-08-10", time: "08:45" }); eq("fromChicagoInputs round-trips", fromChicagoInputs(date, time), iso); }
ok("fmtChicagoFull renders August in Central", /Aug 10, 2026 8:45 AM/.test(fmtChicagoFull("2026-08-10T13:45:00.000Z")), fmtChicagoFull("2026-08-10T13:45:00.000Z"));

console.log("SCOPE SUMMARY (Phase 20 D):");
{ eq("nameList: <=3 joined with 'and'", nameList(["Ana", "Bo"]), "Ana and Bo");
  eq("nameList: >3 → first three + '+N more'", nameList(["A", "B", "C", "D", "E"]), "A, B, C +2 more");
  const base = { code: "SUMMER26", discountType: "PERCENT" as const, value: 25, uses: 1, startLabel: "Aug 10 4:30 PM", endLabel: "Dec 31 11:59 PM", tzName: "America/Chicago (Central)" };
  eq("summary TIME_PERIOD names BOTH windows",
    /gives 25% off matches kicking off between Sep 1 and Sep 30 to anyone, once each, redeemable from Aug 10 4:30 PM to Dec 31 11:59 PM/.test(
      createSummary({ ...base, who: "ALL_USERS", which: "TIME_PERIOD", matchPeriod: { start: "Sep 1", end: "Sep 30" } })), true);
  eq("summary SPECIFIC_USERS names the players",
    /to Ana and Bo,/.test(createSummary({ ...base, who: "SPECIFIC_USERS", which: "ALL_MATCHES", userNames: ["Ana", "Bo"] })), true);
  eq("summary SPECIFIC_MATCHES states the count",
    /gives 25% off on 3 selected matches to/.test(createSummary({ ...base, who: "ALL_USERS", which: "SPECIFIC_MATCHES", matchCount: 3 })), true);
  eq("summary ALL_MATCHES keeps 'off on any match'",
    /gives 25% off on any match to anyone/.test(createSummary({ ...base, who: "ALL_USERS", which: "ALL_MATCHES" })), true); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
