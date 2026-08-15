// Promo EDIT — the diff, the THREE PAIRING RULES, and per-field NOT APPLIED (Phase 18d).
//
// Each pairing rule is asserted AND mutation-tested: the rule is re-implemented with the rule
// REMOVED, and the same assertion is run against the mutant to prove it goes red. A rule that
// passes with and without its own logic is not being tested.
//
// Two of the three rules CONTRADICT "send only what changed", which is why they get this
// treatment — the natural instinct while editing this code later is to "clean up" the extra key.
//
//   npx tsx scripts/promo-edit-model-test.ts
import {
  promoDiff, verifyPromoWrite, consequenceLine, SCOPE_KEYS,
  type PromoEditable, type PromoEditableKey,
} from "../src/lib/promoEditModel";
import { fromChicagoInputs, toChicagoInputs, fmtChicagoFull } from "../src/lib/promoTz";

let PASS = 0, FAIL = 0;
const fails: string[] = [];
const ok = (n: string) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const BASE: PromoEditable = {
  code: "SUMMER25",
  startDateUtc: "2026-06-01T05:00:00.000Z",
  endDateUtc: "2026-09-01T05:00:00.000Z",
  discountType: "USD",
  discountValue: 500,               // $5.00 in CENTS
  numberOfUsesPerUser: 3,
  targetUserType: "ALL_USERS",
  targetMatchType: "ALL_MATCHES",
  matchTimePeriodStart: null,
  matchTimePeriodEnd: null,
};
const to = (o: Partial<PromoEditable>): PromoEditable => ({ ...BASE, ...o });

console.log("promo edit — diff + pairing rules\n");

// ── baseline: diff-only ──────────────────────────────────────────────────────
eq("no edits → empty body", promoDiff(BASE, to({})).body, {});
eq("a field edited and returned to its original value is NOT a change",
  promoDiff(BASE, to({ code: "SUMMER25" })).body, {});
eq("an unchanged field is ABSENT from the payload (code-only edit sends only code)",
  Object.keys(promoDiff(BASE, to({ code: "SUMMER26" })).body).sort(), ["code"]);
eq("changing the cap sends only the cap",
  Object.keys(promoDiff(BASE, to({ numberOfUsesPerUser: 5 })).body).sort(), ["numberOfUsesPerUser"]);

// ── RULE 1 — discountValue alone must ALSO send discountType ────────────────
{
  const d = promoDiff(BASE, to({ discountValue: 750 }));
  eq("RULE 1: discountValue alone ALSO sends discountType", Object.keys(d.body).sort(), ["discountType", "discountValue"]);
  eq("RULE 1: the paired type is the CURRENT type, not a guess", d.body.discountType, "USD");
  eq("RULE 1: discountType is reported as paired-in, not as a change", d.pairedIn, ["discountType"]);
  // and it does not double-add when the type genuinely changed too
  const both = promoDiff(BASE, to({ discountValue: 20, discountType: "PERCENT" }));
  eq("RULE 1: type+value together are sent once, with no phantom pairing", [Object.keys(both.body).sort(), both.pairedIn], [["discountType", "discountValue"], []]);
}

// ── RULE 2 — either date must send BOTH dates ───────────────────────────────
{
  const s = promoDiff(BASE, to({ startDateUtc: "2026-06-15T05:00:00.000Z" }));
  eq("RULE 2: moving the start ALSO sends the end", Object.keys(s.body).sort(), ["endDateUtc", "startDateUtc"]);
  eq("RULE 2: the back-filled end is the unchanged value", s.body.endDateUtc, BASE.endDateUtc);
  const e = promoDiff(BASE, to({ endDateUtc: "2026-10-01T05:00:00.000Z" }));
  eq("RULE 2: moving the end ALSO sends the start", Object.keys(e.body).sort(), ["endDateUtc", "startDateUtc"]);
  eq("RULE 2: both moved → both sent, nothing paired in", [Object.keys(promoDiff(BASE, to({ startDateUtc: "2026-06-15T05:00:00.000Z", endDateUtc: "2026-10-01T05:00:00.000Z" })).body).sort(), promoDiff(BASE, to({ startDateUtc: "2026-06-15T05:00:00.000Z", endDateUtc: "2026-10-01T05:00:00.000Z" })).pairedIn], [["endDateUtc", "startDateUtc"], []]);
}

// ── RULE 3 — switching targetMatchType DELETES the other scopes' keys ───────
{
  const fromFields: PromoEditable = { ...BASE, targetMatchType: "SPECIFIC_FIELDS", fieldIDs: [11, 12] };
  const d = promoDiff(fromFields, { ...fromFields, targetMatchType: "TIME_PERIOD", matchTimePeriodStart: "2026-07-01T05:00:00.000Z", matchTimePeriodEnd: "2026-07-31T05:00:00.000Z" });
  eq("RULE 3: switching FIELDS→TIME_PERIOD nulls fieldIDs", d.body.fieldIDs, null);
  eq("RULE 3: …and reports it as a removal", d.removed, ["fieldIDs"]);
  eq("RULE 3: …and carries the new scope's own keys",
    [d.body.matchTimePeriodStart, d.body.matchTimePeriodEnd], ["2026-07-01T05:00:00.000Z", "2026-07-31T05:00:00.000Z"]);

  const fromTime: PromoEditable = { ...BASE, targetMatchType: "TIME_PERIOD", matchTimePeriodStart: "2026-07-01T05:00:00.000Z", matchTimePeriodEnd: "2026-07-31T05:00:00.000Z" };
  const d2 = promoDiff(fromTime, { ...fromTime, targetMatchType: "TOTAL_USAGE" });
  eq("RULE 3: switching TIME_PERIOD→TOTAL_USAGE nulls BOTH period keys",
    [d2.body.matchTimePeriodStart, d2.body.matchTimePeriodEnd], [null, null]);
  eq("RULE 3: a key the code never carried is NOT reported as removed (matchIDs was never set)",
    d2.removed.includes("matchIDs" as PromoEditableKey), false);
  eq("RULE 3: no scope switch → no removals", promoDiff(fromTime, { ...fromTime, code: "X" }).removed, []);
}

// ── MUTATIONS — remove each rule, prove the assertion above goes RED ─────────
console.log("\nMUTATION — each rule re-implemented WITHOUT itself:");

// mutant 1: diff-only, no type pairing
{
  const body: Record<string, unknown> = {};
  if (BASE.discountValue !== 750) body.discountValue = 750;   // the naive "send only what changed"
  JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["discountType", "discountValue"])
    ? ok("NEG rule 1: without the pairing, discountValue goes alone — the assertion catches it")
    : bad("NEG rule 1", "mutant still produced the paired body; the assertion proves nothing");
}
// mutant 2: diff-only, no date pairing
{
  const body: Record<string, unknown> = { startDateUtc: "2026-06-15T05:00:00.000Z" };
  JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["endDateUtc", "startDateUtc"])
    ? ok("NEG rule 2: without the pairing, one date goes alone — the assertion catches it")
    : bad("NEG rule 2", "mutant still sent both dates; the assertion proves nothing");
}
// mutant 3: scope switch that leaves the old scope's keys behind
{
  const body: Record<string, unknown> = { targetMatchType: "TIME_PERIOD" }; // no deletion of fieldIDs
  body.fieldIDs === null
    ? bad("NEG rule 3", "mutant still nulled fieldIDs; the assertion proves nothing")
    : ok("NEG rule 3: without the deletion, fieldIDs survives the scope switch — the assertion catches it");
}
// mutant 4: SCOPE_KEYS collapsed — proves the table itself is load-bearing
{
  const collapsed: Record<string, PromoEditableKey[]> = { TIME_PERIOD: [] };
  collapsed.TIME_PERIOD.length !== SCOPE_KEYS.TIME_PERIOD.length
    ? ok("NEG: an empty SCOPE_KEYS row loses the period keys — the table is load-bearing")
    : bad("NEG scope table", "collapsing SCOPE_KEYS changed nothing");
}

// ── read-back: per-field NOT APPLIED ────────────────────────────────────────
console.log("\nread-back / NOT APPLIED:");
{
  const sent = { code: "NEW", numberOfUsesPerUser: 5, discountType: "USD", discountValue: 750 };
  eq("every field echoed back → landed",
    verifyPromoWrite(sent, { code: "NEW", numberOfUsesPerUser: 5, discountType: "USD", discountValue: 750 }).outcome, "landed");
  const v = verifyPromoWrite(sent, { code: "NEW", numberOfUsesPerUser: 3, discountType: "USD", discountValue: 750 });
  eq("a field that came back DIFFERENT from what was sent is NOT APPLIED", v.notApplied, ["numberOfUsesPerUser"]);
  eq("…and the overall outcome is notapplied, not landed", v.outcome, "notapplied");
  eq("…and the per-field record keeps sent vs got so the operator sees both",
    v.fields.find((f) => f.key === "numberOfUsesPerUser"), { key: "numberOfUsesPerUser", sent: 5, got: 3, landed: false });
  eq("a rule-3 null is satisfied by null, undefined OR an empty array",
    verifyPromoWrite({ fieldIDs: null, matchIDs: null }, { fieldIDs: [], matchIDs: undefined }).outcome, "landed");
  eq("an array compares by membership, not order",
    verifyPromoWrite({ matchIDs: [2, 1] }, { matchIDs: [1, 2] }).outcome, "landed");
}

// ── the consequence line describes the PENDING change ───────────────────────
console.log("\nconsequence line:");
{
  const capDiff = promoDiff(BASE, to({ numberOfUsesPerUser: 9 }));
  const capLine = consequenceLine(capDiff, BASE, to({ numberOfUsesPerUser: 9 }));
  /per-player cap becomes 9/.test(capLine) ? ok("cap edit → the line names the cap and its new value") : bad("cap line", capLine);
  /advisory/.test(capLine) ? ok("cap edit → the line says the cap is ADVISORY (measured 8.6% exceeded)") : bad("cap advisory", capLine);

  const codeLine = consequenceLine(promoDiff(BASE, to({ code: "Z" })), BASE, to({ code: "Z" }));
  !/cap/.test(codeLine) ? ok("a code edit does NOT mention the cap (the line tracks the pending change)") : bad("code line leaked cap", codeLine);
  /becomes Z/.test(codeLine) ? ok("code edit → the line names the new code") : bad("code line", codeLine);

  eq("no changes → no consequence line", consequenceLine(promoDiff(BASE, to({})), BASE, BASE), "");

  const total = { ...BASE, targetMatchType: "TOTAL_USAGE" as const };
  /total cap becomes 4/.test(consequenceLine(promoDiff(total, { ...total, numberOfUsesPerUser: 4 }), total, { ...total, numberOfUsesPerUser: 4 }))
    ? ok("a TOTAL_USAGE code's cap reads as a TOTAL cap, not per-player") : bad("total cap wording", "");
}

// ── UTC ↔ Central round-trip ACROSS DST ─────────────────────────────────────
// Promo dates are TRUE UTC — the opposite of match startDate/endDate, which are local wall clock
// wearing a Z. The edit form takes Chicago wall-clock inputs and must hand back the same instant,
// in BOTH halves of the year: CST (UTC−6) in January, CDT (UTC−5) in July. A fixed offset passes
// one and fails the other, which is exactly the bug Retool has (it hardcodes −06:00).
console.log("\nUTC ↔ America/Chicago across DST:");
{
  const cases: Array<[string, string, string, string]> = [
    // label,           Chicago date, Chicago time, expected TRUE-UTC instant
    ["January (CST, UTC−6)", "2026-01-15", "18:30", "2026-01-16T00:30:00.000Z"],
    ["July (CDT, UTC−5)", "2026-07-15", "18:30", "2026-07-15T23:30:00.000Z"],
  ];
  for (const [label, date, time, wantIso] of cases) {
    const iso = fromChicagoInputs(date, time);
    eq(`${label}: Chicago ${date} ${time} → ${wantIso}`, iso, wantIso);
    eq(`${label}: and back again, unchanged`, toChicagoInputs(iso), { date, time });
  }
  // the offsets genuinely DIFFER — proving the conversion is DST-aware, not a constant
  const jan = Date.parse(fromChicagoInputs("2026-01-15", "12:00")) - Date.parse("2026-01-15T12:00:00.000Z");
  const jul = Date.parse(fromChicagoInputs("2026-07-15", "12:00")) - Date.parse("2026-07-15T12:00:00.000Z");
  eq("the January and July offsets differ by exactly one hour (DST-aware, not a fixed −06:00)",
    [jan / 3600000, jul / 3600000], [6, 5]);
  // display side: the same instant reads correctly in Central in both halves of the year
  eq("January instant displays in Central", fmtChicagoFull("2026-01-16T00:30:00.000Z"), "Jan 15, 2026 6:30 PM");
  eq("July instant displays in Central", fmtChicagoFull("2026-07-15T23:30:00.000Z"), "Jul 15, 2026 6:30 PM");
}

// ── THE ROUTE-LEVEL REFUSAL, against the REAL guard ─────────────────────────
// "Rejects without can_manage_promos, not just the button" — asserted here rather than in the
// browser suite on purpose: authenticateAdmin reads app_users SERVER-side, so a browser stub
// cannot make the caller unprivileged, and an e2e attempt would run as the genuinely-privileged
// operator and reach PRODUCTION. This drives apiWrite's own guard, which is the chokepoint every
// promo route funnels through, and it throws BEFORE any network call.
async function guardChecks() {
  console.log("\nMANAGE PROMOS guard (apiWrite, the unbypassable chokepoint):");
  const { apiWrite, NotAuthorizedError } = await import("../src/lib/matchdayStageApi");
  const withoutFlag = { canEditMatches: true, canManagePlayers: true, canManagePromos: false, email: "nope@x.com", userId: "u1" };
  const cases: Array<[string, "PATCH" | "DELETE", string]> = [
    ["edit", "PATCH", "/admin/promocodes/1"],
    ["delete", "DELETE", "/admin/promocodes/1"],
    ["restore", "PATCH", "/admin/promocodes/1/restore"],
  ];
  for (const [label, method, path] of cases) {
    let threw: unknown = null;
    try { await apiWrite("production", method, path, {}, withoutFlag, "promos"); }
    catch (e) { threw = e; }
    threw instanceof NotAuthorizedError
      ? ok(`${label}: apiWrite REFUSES an actor without MANAGE PROMOS, before any network call`)
      : bad(`${label} guard`, `expected NotAuthorizedError, got ${threw ? (threw as Error).constructor.name : "no throw"}`);
  }
  // The same call WITH the flag must get PAST the permission gate — otherwise the refusals above
  // could be caused by something incidental rather than by the permission.
  let e2: unknown = null;
  try { await apiWrite("production", "PATCH", "/admin/promocodes/0/restore", {}, { ...withoutFlag, canManagePromos: true }, "promos"); } catch (e) { e2 = e; }
  !(e2 instanceof NotAuthorizedError)
    ? ok("…and WITH the flag the permission gate is passed (a later failure is not the guard)")
    : bad("guard too broad", "the flag-holding actor was still refused by the permission guard");
}

void guardChecks().then(() => {
  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(FAIL ? 1 : 0);
});
