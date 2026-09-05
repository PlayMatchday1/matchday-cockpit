import "server-only"; // no-op under --conditions=react-server
/* THE DOCKED CHAT'S CANNED LINES, AND THE ONE THING THEY MUST NEVER DO.
 *
 * A snippet lands in the operator's draft, one keystroke from a player. So a line that STATES A
 * FACT about the account is only allowed to exist when that fact is loaded and true. The two
 * failures worth a suite are both silent on screen:
 *
 *   - a membership sentence offered on a thread with no membership (there is nothing to contradict
 *     it, so it reads as authoritative), and
 *   - a cancellation sentence offered on a membership that was never cancelled.
 *
 * Both pass a screenshot, because the panel looks correct either way — the sentence is only wrong
 * against data the screenshot does not contain.
 *
 * Also pins the timezone split. canceledAt is a TRUE instant and prints in Central; currentPeriodEnd
 * is a period boundary (…T04:59:59Z) and prints as the boundary date the API and Stripe both name.
 * 35.1% of real cancellation timestamps disagree by a day between the two zones.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/dock-account-test.ts
 */
import { readFileSync } from "node:fs";
import {
  accountFromProfile, billingLine, dockSnippets, cancelDay, periodDay, stillRunning,
  type DockAccount,
} from "../src/lib/dockAccount";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean) => (c ? ok(n) : bad(n));
const no = (n: string, c: boolean) => (!c ? ok(n) : bad(n));
const mentionsMembership = (lines: string[]) =>
  lines.some((l) => /membership|cancelled|charged|renews/i.test(l));

// ── fixtures: the real production shape, from /admin/players/{id}.userSubscriptions ──
// Mark Trejo (player 72409): status ACTIVE, cancelled 2026-08-09, paid through 2026-10-01.
const CANCELLED_PROFILE = {
  player: { id: 72409, name: "Mark Trejo", city: "Austin", level: 3, credits: 0, matchesPlayed: 4, upcoming: 0 },
  strikes: { activeCount: 0, limit: 4 },
  membership: { status: "ACTIVE", canceledAt: "2026-08-09T01:06:52.168Z", renews: "2026-10-01T04:59:59.000Z", price: 6650, number: "sub_x", since: null, city: "ATX" },
};
const ACTIVE_PROFILE = {
  player: { id: 1, name: "Plain Active", city: "Austin", level: null, credits: 1250, matchesPlayed: 11, upcoming: 2 },
  strikes: { activeCount: 1, limit: 4 },
  membership: { status: "ACTIVE", canceledAt: null, renews: "2026-10-01T04:59:59.000Z", price: 6650, number: "sub_y", since: null, city: "ATX" },
};
const NO_MEMBERSHIP_PROFILE = {
  player: { id: 2, name: "Pay Per Match", city: "Houston", level: 2, credits: 0, matchesPlayed: 3, upcoming: 1 },
  strikes: { activeCount: 0, limit: 4 },
  membership: null,
};
const NOW = Date.parse("2026-09-04T12:00:00Z"); // inside Mark Trejo's paid period

console.log("— accountFromProfile: the numbers the strip shows —");
const cancelled = accountFromProfile(CANCELLED_PROFILE) as DockAccount;
const active = accountFromProfile(ACTIVE_PROFILE) as DockAccount;
const nomem = accountFromProfile(NO_MEMBERSHIP_PROFILE) as DockAccount;
eq("played / upcoming / credits / strikes come straight off the lookup payload",
  [cancelled.played, cancelled.upcoming, cancelled.credits, `${cancelled.strikes}/${cancelled.strikeLimit}`],
  [4, 0, 0, "0/4"]);
eq("a profile with no membership carries membership: null", cancelled.membership !== null && nomem.membership, null);
eq("a junk payload is null, not a player of zeroes", accountFromProfile({ nope: 1 }), null);
eq("a missing strike limit falls back to 4, never 0 (0/0 reads as suspended)",
  (accountFromProfile({ player: { id: 9 }, strikes: {} }) as DockAccount).strikeLimit, 4);

console.log("\n— the timezone split, which is the difference between Aug 8 and Aug 9 —");
eq("canceledAt prints in Central: 2026-08-09T01:06Z is Aug 8 at the pitch", cancelDay("2026-08-09T01:06:52.168Z"), "Aug 8");
eq("currentPeriodEnd prints as the boundary the API names", periodDay("2026-10-01T04:59:59.000Z"), "Oct 1");
// The case that decides which billing month a cancellation fell in.
eq("2026-09-01T02:08Z is Aug 31 in Central — the previous billing month", cancelDay("2026-09-01T02:08:06.234Z"), "Aug 31");
yes("a cancelled membership inside its paid period is still running", stillRunning(cancelled.membership, NOW));
no("and is not still running once the period has passed", stillRunning(cancelled.membership, Date.parse("2026-11-01T00:00:00Z")));

console.log("\n— billingLine —");
eq("cancelled + still paid says both dates and the amount",
  billingLine(cancelled, NOW), "Cancelled Aug 8, runs to Oct 1 · $66.50");
eq("a plain active membership says when it renews", billingLine(active, NOW), "Renews Oct 1 · $66.50");
eq("no membership, no line", billingLine(nomem, NOW), null);
eq("no account loaded, no line", billingLine(null, NOW), null);

console.log("\n— dockSnippets: a line that states a fact needs the fact —");
const sCancelled = dockSnippets(cancelled);
const sActive = dockSnippets(active);
const sNomem = dockSnippets(nomem);
const sNull = dockSnippets(null);
yes("a cancelled membership offers a line naming the cancellation",
  sCancelled.some((l) => /cancelled on Aug 8/.test(l)) && sCancelled.some((l) => /runs to Oct 1/.test(l)));
yes("and a line saying nothing further will be charged", sCancelled.includes("Nothing further will be charged."));
no("a plain active membership offers NO cancellation line", sActive.some((l) => /cancelled/i.test(l)));
yes("it offers its renewal date instead", sActive.some((l) => /renews on Oct 1/.test(l)));
no("a thread with NO membership mentions a membership at all", mentionsMembership(sNomem));
no("and neither does a thread whose account never loaded", mentionsMembership(sNull));
yes("both still get the line that states nothing", sNomem.includes("I'm looking at your account now.") && sNull.includes("I'm looking at your account now."));
yes("a credit balance is offered only when there is one",
  sActive.some((l) => /\$12\.50 in credits/.test(l)) && !sCancelled.some((l) => /credits/.test(l)));
eq("no send permission ⇒ no snippets at all", dockSnippets(cancelled, { canSend: false }), []);

// POSITIVE CONTROL for the two absence assertions above: the same matcher finds a membership
// sentence where one genuinely exists. Without this, a dockSnippets() that returned [] for
// everything would pass every "does not mention" check on this page.
yes("control: the matcher DOES fire on the cancelled thread's lines", mentionsMembership(sCancelled));

console.log("\n— the source contracts the dock must keep —");
/* COMMENTS ARE NOT CODE, AND BOTH OF THE ASSERTIONS BELOW FIRED ON ONE. The comment explaining
 * why the maxHeight is gone contains the word "maxHeight", and the comment explaining that Resend
 * carries no Idempotency-Key contains "Idempotency-Key". Read the source with comments stripped —
 * an absence assertion over a file that documents what it does not do is otherwise unfalsifiable. */
const noComments = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const DOCK = readFileSync("src/components/crm/CrmDock.tsx", "utf8");
const DOCK_C = noComments(DOCK);
// The mismatch send label is the whole guard against replying to the wrong person. Byte for byte.
/`Send to \$\{name\}, not \$\{dockSubject\?\.label \?\? "them"\}`/.test(DOCK)
  ? ok("the mismatch send label is unchanged, byte for byte")
  : bad("the mismatch send label changed");
/You're working on <strong>\{dockSubject\?\.label \?\? "another player"\}<\/strong>/.test(DOCK)
  ? ok("Banner B's wording is unchanged")
  : bad("Banner B's wording changed");
!/maxHeight/.test(DOCK_C) ? ok("no maxHeight on the message list — flex-1 fills the panel") : bad("maxHeight is back on the dock");
/PLAYER_LOOKUP_PATH/.test(DOCK) && /dock-open-lookup/.test(DOCK)
  ? ok("the dock has a route into Player Lookup")
  : bad("no Player Lookup route in the dock");
// The control must be absent, not disabled, when there is nobody to open.
/\{!unlinked && \(\s*<button[\s\S]{0,200}dock-open-lookup/.test(DOCK)
  ? ok("Open in Player Lookup is absent (not disabled) on an unlinked thread")
  : bad("Open in Player Lookup is not gated on the thread being linked");
// A snippet inserts, never sends.
/const insertSnippet = \(text: string\) => \{[\s\S]{0,200}setDraft\(/.test(DOCK) && !/insertSnippet[\s\S]{0,120}submit/.test(DOCK)
  ? ok("a snippet still only inserts into the draft")
  : bad("a snippet may now send");
// One resend attempt, no Idempotency-Key.
/if \(resendingId\) return;/.test(DOCK_C) && !/Idempotency-Key/.test(DOCK_C)
  ? ok("Resend is still one click, one attempt, no Idempotency-Key")
  : bad("Resend's single-attempt guard changed");
// No send right ⇒ no composer at all.
/canSendMessages \? \(\s*<Composer/.test(DOCK) ? ok("no send permission still means NO composer, not a disabled one") : bad("the composer is no longer gated on canSendMessages");
// CONTROL for the two absence checks above: the stripper must not have emptied the file, and the
// words it looks for must still be findable where they really appear (in the comments it removed).
/maxHeight/.test(DOCK) && /Idempotency-Key/.test(DOCK) && DOCK_C.length > DOCK.length * 0.5
  ? ok("control: both words exist in the raw file and the stripper kept the code")
  : bad("control failed — the absence assertions above may be passing on an empty string");

const LOOKUP = readFileSync("src/components/PlayerLookup.tsx", "utf8");
/data-testid="mem-badge"/.test(LOOKUP) && /m\.canceledAt \|\| st\.includes\("cancel"\)/.test(LOOKUP)
  ? ok("the membership badge is computed from the CANCELLATION, not from status alone")
  : bad("the membership badge still reads status alone");
/<Fact k="CANCELLED" v=\{fmtDateCT\(m\.canceledAt\)\} \/>/.test(LOOKUP)
  ? ok("the card prints a CANCELLED date, in Central")
  : bad("the cancelled date is still missing from the card");
/URLSearchParams\(window\.location\.search\)\.get\("id"\)/.test(LOOKUP)
  ? ok("Player Lookup opens ?id=<n> directly (what the dock link needs)")
  : bad("Player Lookup has no ?id= entry point");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
