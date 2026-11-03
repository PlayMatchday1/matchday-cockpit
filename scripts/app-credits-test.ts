/* STAFF APP CREDITS: a change_log row to a credit history row (src/lib/appCredits.ts). Ryan,
 * 2026-11-02. Pure, asserted offline; every refusal has a presence control beside it. */
import { creditLogRow } from "../src/lib/appCredits";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const first = (e: string | null) => (e === "ryan@x.com" ? "Ryan" : null);
const row = (changes: unknown, actor_email: string | null = "ryan@x.com") => ({ created_at: "2026-10-22T15:00:00Z", changes, actor_email });
const added = [{ key: "creditAmount", before: 1200, after: 2200 }, { key: "delta", before: "—", after: "+1000 cents ($10.00)" }, { key: "reason", before: "—", after: "Match canceled" }];

console.log("\ncredit history from the change log");
is("an add reads as +1000 with its reason and first name", creditLogRow(row(added), first), { at: "2026-10-22T15:00:00Z", deltaCents: 1000, reason: "Match canceled", by: "Ryan" });
is("a removal reads negative", creditLogRow(row([{ key: "creditAmount", before: 2200, after: 1700 }]), first)?.deltaCents, -500);
is("a staff member with no name on file reads as no name, never an email", creditLogRow(row(added, "who@x.com"), first)?.by, null);
is("a profile change that did not touch credit is not a credit row", creditLogRow(row([{ key: "firstName", before: "A", after: "B" }]), first), null);
is("presence control: the same row with creditAmount is one", creditLogRow(row([{ key: "creditAmount", before: 0, after: 500 }]), first)?.deltaCents, 500);
is("an unchanged balance is not a row", creditLogRow(row([{ key: "creditAmount", before: 500, after: 500 }]), first), null);
is("an empty reason is no reason", creditLogRow(row([{ key: "creditAmount", before: 0, after: 500 }, { key: "reason", after: "  " }]), first)?.reason, null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
