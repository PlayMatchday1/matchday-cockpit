/* MATCH NAMES (src/lib/matchName.ts), Ryan 2026-11-06: the Atlanta One Touch matches were stored as
 * " One Touch" and every cancel failed on "The typed name doesn't match" — the route trimmed one side
 * and compared with === . The rule now: names are trimmed on every write, and the cancel check is
 * trimmed and case-insensitive. Pure, offline; every refusal has a presence control beside it.
 *
 * The three source assertions at the end are SOURCE GREPS BY DESIGN: the routes sit behind an HTTP
 * boundary the gate cannot cross, so what is asserted is the PAIRING (the cancel route compares through
 * sameMatchName and no bare === on the two names remains; each write route calls trimNameIn before it
 * sends). Do not modernise them into a grep for something else. */
import { readFileSync } from "node:fs";
import { sameMatchName, trimMatchName, trimNameIn } from "../src/lib/matchName";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

console.log("\nthe cancel comparison");
is("the bug: a leading space in the stored name is not a different match", sameMatchName("One Touch", " One Touch"), true);
is("trailing whitespace and a tab too", sameMatchName("One Touch\t ", "One Touch"), true);
is("case does not count", sameMatchName("one touch", "ONE TOUCH"), true);
is("presence control: a real rename is still refused", sameMatchName("One Touch", "One Touch Premier"), false);
is("interior spacing still counts", sameMatchName("One  Touch", "One Touch"), false);
is("an empty confirmation never matches a named match", sameMatchName("", "One Touch"), false);
is("null and undefined read as empty, so they match each other and nothing named", [sameMatchName(null, undefined), sameMatchName(null, "x")], [true, false]);

console.log("\nthe trim");
is("surrounding whitespace goes", trimMatchName("  One Touch \n"), "One Touch");
is("a non-string becomes a string, trimmed", trimMatchName(12), "12");
is("null is empty", trimMatchName(null), "");
{
  const body: Record<string, unknown> = { name: " One Touch", fieldId: 7 };
  const same = trimNameIn(body);
  is("trimNameIn trims the name in place and returns the same object", [same === body, body.name, body.fieldId], [true, "One Touch", 7]);
  const noName: Record<string, unknown> = { fieldId: 7 };
  trimNameIn(noName);
  is("a body without a name is untouched (no key is added)", Object.keys(noName), ["fieldId"]);
  const notString: Record<string, unknown> = { name: 5 };
  trimNameIn(notString);
  is("a non-string name is left for the route's own validation", notString.name, 5);
}

console.log("\nthe routes use it (source pairing, see header)");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const cancel = strip(readFileSync("src/app/api/matchday/[env]/matches/[id]/cancel/route.ts", "utf8"));
is("cancel: the typed name is compared through sameMatchName", /sameMatchName\(confirmName, view\.name\)/.test(cancel), true);
is("cancel: and no bare === / !== between the two names remains", /confirmName\s*[!=]==\s*view\.name|view\.name\s*[!=]==\s*confirmName/.test(cancel), false);
is("cancel: presence control — the file still holds the comparison site at all", /confirmName/.test(cancel) && /view\.name/.test(cancel), true);
for (const [label, path, before] of [
  ["create (and Copy match)", "src/app/api/matchday/[env]/matches/create/route.ts", /apiWrite<[^(]*\(env, "POST", "\/admin\/matches"/],
  ["edit PUT", "src/app/api/matchday/[env]/matches/[id]/route.ts", /apiWrite\(env, "PUT", `\/admin\/matches\/\$\{id\}`/],
  ["stage edit PUT", "src/app/api/stage/matches/[id]/route.ts", /apiWrite\("staging", "PUT", `\/admin\/matches\/\$\{id\}`/],
] as const) {
  const src = strip(readFileSync(path, "utf8"));
  const trimAt = src.search(/trimNameIn\((payload|changes)\)/);
  const writeAt = src.search(before);
  is(`${label}: trimNameIn runs, and before the write goes out`, [trimAt >= 0, writeAt >= 0, trimAt >= 0 && writeAt >= 0 && trimAt < writeAt], [true, true, true]);
}

console.log(`\nmatch-name: ${pass} passed, ${fail} failed`);
if (fail || pass === 0) process.exit(1);
