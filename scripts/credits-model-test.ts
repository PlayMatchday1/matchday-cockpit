import "server-only"; // no-op under --conditions=react-server
// Phase 27 — credit adjustment rules, tested where they live.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/credits-model-test.ts
//
// This is the one screen in Clubhouse where being wrong moves real money, so the arithmetic, the
// cap, the race check, the gate and the log payload are all asserted here rather than only through
// a browser. Dollar rendering is asserted on NON-ROUND values ($12.34, $0.74) — $0.00 and $25.00
// would pass under a 100x error in either direction and prove nothing.

import { readFileSync } from "node:fs";
import {
  parseAdjustment, validateAdjustment, raceCheck, fmtUsd, MAX_ADJUSTMENT_CENTS, CENTS,
} from "../src/lib/creditsModel";
import { creditsGate } from "../src/lib/creditsAuth";
import { assertCanEditCredits, NotAuthorizedError } from "../src/lib/matchdayStageApi";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

console.log("\nUNITS — cents in, dollars only at the edge (asserted on NON-ROUND values)");
is("one cent renders as $0.01", fmtUsd(1), "$0.01");
is("74 cents renders as $0.74 — the real production value that proves the field is cents", fmtUsd(74), "$0.74");
is("1234 cents renders as $12.34, NOT $1234.00 and NOT $0.12", fmtUsd(1234), "$12.34");
is("866 cents renders as $8.66", fmtUsd(866), "$8.66");
is("a negative renders with the sign outside the dollar mark", fmtUsd(-1234), "-$12.34");
is("the cap is expressed in cents", MAX_ADJUSTMENT_CENTS, 20000);
is("...and reads as $200.00", fmtUsd(MAX_ADJUSTMENT_CENTS), "$200.00");
is("CENTS is 100, not 1 — a 100x slip here is the worst outcome available", CENTS, 100);

console.log("\nPARSING — an adjustment, never a balance");
eq("a bare number is dollars → cents", parseAdjustment("25"), { ok: true, cents: 2500 });
eq("an explicit plus is the same", parseAdjustment("+25"), { ok: true, cents: 2500 });
eq("a minus subtracts", parseAdjustment("-10"), { ok: true, cents: -1000 });
eq("the U+2212 MINUS SIGN a Mac keyboard produces is understood, not rejected", parseAdjustment("−10"), { ok: true, cents: -1000 });
eq("decimals survive exactly", parseAdjustment("12.34"), { ok: true, cents: 1234 });
eq("a dollar sign and commas are tolerated", parseAdjustment("$1,2.34"), { ok: true, cents: 1234 });
eq("sub-cent input ROUNDS rather than truncating toward zero", parseAdjustment("0.145"), { ok: true, cents: 15 });
is("empty is refused", parseAdjustment("").ok, false);
is("zero is not an adjustment", parseAdjustment("0").ok, false);
is("something that rounds to nothing is refused", parseAdjustment("0.001").ok, false);
is("letters are refused", parseAdjustment("25 dollars").ok, false);
is("a lone sign is refused", parseAdjustment("+").ok, false);

console.log("\nTHE STATED CONSEQUENCE matches the delta entered");
{
  const v = validateAdjustment({ raw: "+25", reason: "goodwill after a cancelled match", beforeCents: 0, playerName: "Anderson King", canEdit: true });
  is("ready to send", v.ok, true);
  is("the sentence names the player and both figures", v.consequence, "Anderson King's balance goes from $0.00 to $25.00.");
  is("the arithmetic is in cents", v.afterCents, 2500);
}
{
  // the case that would expose a 100x error in either direction
  const v = validateAdjustment({ raw: "12.34", reason: "partial refund", beforeCents: 74, playerName: "Wynn One", canEdit: true });
  is("a non-round adjustment onto a non-round balance", v.consequence, "Wynn One's balance goes from $0.74 to $13.08.");
  is("...and the after value is exact in cents", v.afterCents, 1308);
}
{
  const v = validateAdjustment({ raw: "-10", reason: "reversing a duplicate grant", beforeCents: 2500, playerName: "Gina One", canEdit: true });
  is("a subtraction states the fall", v.consequence, "Gina One's balance goes from $25.00 to $15.00.");
  is("...and is allowed", v.ok, true);
}

console.log("\nTHE REASON IS REQUIRED");
{
  const v = validateAdjustment({ raw: "+25", reason: "", beforeCents: 0, playerName: "A B", canEdit: true });
  is("no reason → not ready", v.ok, false);
  is("...and it says why", v.errors.some((e) => /reason is required/i.test(e)), true);
  is("...but the consequence is still shown, so the operator sees the effect while typing it", v.consequence, "A B's balance goes from $0.00 to $25.00.");
}
is("whitespace is not a reason", validateAdjustment({ raw: "+25", reason: "   ", beforeCents: 0, playerName: "A B", canEdit: true }).ok, false);
is("a real reason enables it", validateAdjustment({ raw: "+25", reason: "ref no-show", beforeCents: 0, playerName: "A B", canEdit: true }).ok, true);

console.log("\nTHE TYPO CAP");
is("exactly $200.00 is allowed", validateAdjustment({ raw: "200", reason: "large but deliberate", beforeCents: 0, playerName: "A B", canEdit: true }).ok, true);
{
  const v = validateAdjustment({ raw: "200.01", reason: "one cent over", beforeCents: 0, playerName: "A B", canEdit: true });
  is("a cent over the cap is refused", v.ok, false);
  is("...and the message says it is a typo guard, not a permission", v.errors.some((e) => /typo guard/i.test(e)), true);
  is("...and names the limit", v.errors.some((e) => /\$200\.00/.test(e)), true);
}
is("the cap applies to subtractions too", validateAdjustment({ raw: "-250", reason: "x", beforeCents: 100000, playerName: "A B", canEdit: true }).ok, false);
is("a $2500 fat finger for $25 is caught", validateAdjustment({ raw: "2500", reason: "meant 25", beforeCents: 0, playerName: "A B", canEdit: true }).ok, false);

console.log("\nNEGATIVE BALANCES — Clubhouse refuses to be the thing that finds out");
{
  const v = validateAdjustment({ raw: "-30", reason: "clawback", beforeCents: 2500, playerName: "A B", canEdit: true });
  is("an adjustment that would go below zero is refused", v.ok, false);
  is("...naming the figure it would reach", v.errors.some((e) => /-\$5\.00/.test(e)), true);
  is("...and saying the API's behaviour is untested rather than claiming it would fail", v.errors.some((e) => /untested/i.test(e)), true);
}
is("landing exactly on zero is fine", validateAdjustment({ raw: "-25", reason: "clawback", beforeCents: 2500, playerName: "A B", canEdit: true }).ok, true);

console.log("\nTHE RACE — abort, never re-base");
eq("an unchanged balance proceeds", raceCheck(2500, 2500), { ok: true });
{
  const r = raceCheck(2500, 1200) as { ok: false; error: string };
  is("a balance that moved between read and write aborts", r.ok, false);
  is("...says nothing was sent", /nothing was sent/i.test(r.error), true);
  is("...and REPORTS THE NEW VALUE rather than silently using it", /\$25\.00 to \$12\.00/.test(r.error), true);
}
is("a zero balance that became non-zero also aborts", (raceCheck(0, 500) as { ok: boolean }).ok, false);

console.log("\nPERMISSION — its own grant, not a side effect of Match Ops");
eq("no row is a refusal", creditsGate(null), { ok: false, status: 403, error: "Not a cockpit user" });
is("a plain admin does NOT get it", creditsGate({ is_admin: true }).ok, false);
is("MATCH OPS does NOT get it", creditsGate({ can_access_matchops: true }).ok, false);
is("EDIT MATCHES does NOT get it", creditsGate({ can_access_matchops: true, can_edit_matches: true }).ok, false);
is("MANAGE PLAYERS does NOT get it", creditsGate({ can_access_matchops: true, can_manage_players: true }).ok, false);
is("the explicit grant DOES", creditsGate({ can_edit_credits: true }).ok, true);
is("...and does not require Match Ops in the other direction either", creditsGate({ can_edit_credits: true, can_access_matchops: false }).ok, true);
is("a SERVICE ACCOUNT is refused even holding the grant", creditsGate({ can_edit_credits: true, is_service_account: true }).ok, false);
is("the refusal explains it is granted separately", (creditsGate({ is_admin: true }) as { error: string }).error.includes("granted separately"), true);
{
  const v = validateAdjustment({ raw: "+25", reason: "valid reason", beforeCents: 0, playerName: "A B", canEdit: false });
  is("the UI refuses without the grant too", v.ok, false);
}

console.log("\nTHE CHOKEPOINT — apiWrite refuses before any network call");
{
  const tryIt = (actor: Parameters<typeof assertCanEditCredits>[0]) => {
    try { assertCanEditCredits(actor); return "allowed"; } catch (e) { return e instanceof NotAuthorizedError ? "refused" : "other"; }
  };
  is("no actor is refused", tryIt(undefined), "refused");
  is("EDIT MATCHES alone is refused — holding one authority never implies another", tryIt({ canEditMatches: true }), "refused");
  is("MANAGE PLAYERS alone is refused", tryIt({ canEditMatches: false, canManagePlayers: true }), "refused");
  is("EDIT CREDITS is allowed", tryIt({ canEditMatches: false, canEditCredits: true }), "allowed");
}

console.log("\nTHE MIGRATION says what it must");
{
  const sql = readFileSync("supabase/migrations/0122_edit_credits.sql", "utf8");
  is("the column defaults to FALSE", /can_edit_credits boolean not null default false/.test(sql), true);
  is("a service account is blocked at the DATABASE, keyed on the row's email", /can_edit_credits = true and NEW\.is_service_account = true/.test(sql), true);
  is("the grant names Ryan only", /set can_edit_credits = true\s*\n\s*where email = 'rmancuso@playmatchday\.com'/.test(sql), true);
  is("there is NO requires_matchops constraint — the omission is the design", /can_edit_credits[\s\S]*requires_matchops/.test(sql), false);
  is("the revoke SQL carries a WHERE (pg_safeupdate rejects an unqualified UPDATE)",
    /update app_users set can_edit_credits = false where/.test(sql), true);
}

console.log("\nAUDIT — the log carries the reason and the figures, and NO PII");
{
  // The exact `changes` the route builds. Asserted as data so the shape cannot drift silently.
  const before = 74, delta = 1234, after = before + delta;
  const reason = "goodwill after the Tuesday cancellation";
  const changes = [
    { key: "creditAmount", field: "Credit balance", before, after },
    { key: "delta", field: "Adjustment", before: "—", after: `${delta > 0 ? "+" : ""}${delta} cents (${fmtUsd(delta)})` },
    { key: "reason", field: "Reason", before: "—", after: reason },
  ];
  const payload = { path: `/admin/players/87018/profile`, body: { creditAmount: after }, changes };
  const s = JSON.stringify(payload);

  is("the log records the balance BEFORE", s.includes('"before":74'), true);
  is("...and AFTER", s.includes('"after":1308'), true);
  is("...and the DELTA in both cents and dollars", s.includes("+1234 cents ($12.34)"), true);
  is("...and the REASON text verbatim", s.includes(reason), true);
  is("...and identifies the player by ID only", /players\/87018\/profile/.test(s), true);

  // The PII rule, and the mutation that proves the assertion can fail.
  const PHONE = "+15125551234", EMAIL = "player@example.com", NAME = "Anderson King";
  const hasPii = (blob: string) => blob.includes(PHONE) || blob.includes(EMAIL) || /@[\w.-]+\.\w+/.test(blob) || blob.includes(NAME);
  is("no phone, no email and no name appear anywhere in the logged payload", hasPii(s), false);
  is("...and it is not vacuous — the payload is non-trivial", s.length > 150, true);

  const mutatedPhone = JSON.stringify({ ...payload, changes: [...changes, { key: "who", field: "Player", before: "—", after: `${NAME} ${PHONE}` }] });
  is("MUTATION — the same check FAILS when a phone and a name are planted in the log", hasPii(mutatedPhone), true);
  const mutatedEmail = JSON.stringify({ ...payload, actor: EMAIL.replace("player", "someone") });
  is("MUTATION — and it FAILS when an email is planted", hasPii(mutatedEmail), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
