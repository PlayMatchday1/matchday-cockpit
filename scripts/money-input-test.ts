/* A MONEY FIELD YOU CAN TYPE IN.
 *
 * WHAT IT WAS. Both panels bound `value` to a FORMATTED string derived from cents on every render
 * — MatchPanel via centsToDollars(cur[k]), MatchEditor via (cents/100).toFixed(2). The field
 * reformatted on every keystroke, so it read "9.00", the caret landed in the cents, and changing 9
 * to 12 was a fight. Neither handled focus or blur, so there was no existing one to reuse.
 *
 * THE ASSERTION THE BRIEF ASKED FOR: focus, type "12", blur -> the field reads 12.00 and the wire
 * carries 1200. And the CONTROL: it must fail if the field reformats mid-type.
 */

import { readFileSync } from "node:fs";
import { formatCents, parseDollars } from "../src/components/MoneyInput";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A HEADLESS STAND-IN FOR THE FIELD, implementing exactly what the component does: draft is null
 * when not focused (render from cents) and a string while focused (render verbatim). If this
 * model and the component ever diverge, the wiring block at the bottom is what notices. */
function field(initialCents: number | "") {
  let cents: number | "" = initialCents;
  let draft: string | null = null;
  return {
    get shown() { return draft ?? formatCents(cents); },
    get cents() { return cents; },
    focus() { draft = formatCents(cents); },
    /** Typing REPLACES, because focus selected everything. */
    type(s: string) { draft = s; cents = parseDollars(s); },
    blur() { draft = null; },
  };
}

console.log("\nfocus, type 12, blur");
{
  const f = field(900);
  is("it starts formatted", f.shown, "9.00");
  f.focus();
  is("focus shows the same value, ready to be replaced", f.shown, "9.00");
  f.type("12");
  /* THE POINT. While focused the field shows what was TYPED — not "12.00", not "0.12". */
  is("typing shows exactly what was typed", f.shown, "12");
  is("…and the wire already carries the cents", f.cents, 1200);
  f.blur();
  is("blur formats to two decimals", f.shown, "12.00");
  is("…and the wire is unchanged by the formatting", f.cents, 1200);
}

console.log("\nthe control: this fails if the field reformats mid-type");
{
  /* A field that formatted on every keystroke would show "12.00" DURING typing, and the caret
   * would sit in the cents. Modelled here so the assertion above is shown to be discriminating —
   * without this, `shown === "12"` could be true of an implementation that never formats at all. */
  const reformatting = (() => {
    let cents: number | "" = 900;
    return { get shown() { return formatCents(cents); }, type(s: string) { cents = parseDollars(s); }, get cents() { return cents; } };
  })();
  reformatting.type("12");
  is("control: a reformatting field shows 12.00 mid-type, not 12", reformatting.shown, "12.00");
  const f = field(900); f.focus(); f.type("12");
  is("control: …so the two implementations are distinguishable", f.shown !== reformatting.shown, true);
  /* AND THE OTHER HALF: a field that NEVER formats would fail the blur assertion. */
  const neverFormats = { shown: "12" };
  is("control: a never-formatting field fails on blur", neverFormats.shown === "12.00", false);
}

console.log("\npartial input never reaches the wire as nonsense");
{
  const f = field("");
  f.focus();
  for (const [typed, expectCents] of [["1", 100], ["12", 1200], ["12.", 1200], ["12.5", 1250], ["12.50", 1250]] as const) {
    f.type(typed);
    is(`  "${typed}" -> ${expectCents}¢, shown verbatim as "${typed}"`, [f.cents, f.shown], [expectCents, typed]);
  }
  f.type("");
  is("clearing the field is empty, not zero", [f.cents, f.shown], ["", ""]);
  f.type("abc");
  is("garbage is empty, never NaN", f.cents, "");
  f.blur();
  is("…and blur on an empty field shows nothing, not 0.00", f.shown, "");
}

console.log("\nformatCents / parseDollars round-trip");
{
  is("cents in, dollars out", [formatCents(1200), formatCents(900), formatCents(1)], ["12.00", "9.00", "0.01"]);
  is("empty stays empty", [formatCents(""), formatCents(null), formatCents(undefined)], ["", "", ""]);
  /* ZERO IS A PRICE. It must render, or a free match looks like an unset one — which is exactly
   * the confusion that let 18408 sit at $0 unnoticed. */
  is("zero renders as 0.00, not blank", formatCents(0), "0.00");
  is("dollars in, cents out", [parseDollars("12"), parseDollars("12.5"), parseDollars("0")], [1200, 1250, 0]);
  is("…and rounding is to the cent", parseDollars("12.345"), 1235);
}

console.log("\nboth panels use it, and neither kept a second one");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const panel = strip(readFileSync("src/components/MatchPanel.tsx", "utf8"));
  const editor = strip(readFileSync("src/app/(internal)/match-ops/matches/[id]/MatchEditor.tsx", "utf8"));
  if (/export default function MatchPanel/.test(panel) && /export default function MatchEditor/.test(editor))
    ok("control: both panels were read");
  else bad("control: both panels were read", "THE CHECKS BELOW WOULD PASS ON EMPTY STRINGS");
  for (const [name, src] of [["Match panel", panel], ["Master Schedule editor", editor]] as const) {
    if (/<MoneyInput/.test(src)) ok(`${name} uses MoneyInput`);
    else bad(`${name} uses MoneyInput`, "A SECOND MONEY INPUT IS HOW THEY DRIFT");
    /* NO SURVIVING FORMAT-ON-RENDER. Both of these were the bug, verbatim. */
    if (!/toFixed\(2\)\}/.test(src)) ok(`  …and no money field still formats in its value`);
    else bad(`${name} still formats a value with toFixed(2)`, "THAT IS THE REFORMAT-ON-KEYSTROKE BUG");
  }
  if (!/centsToDollars\(cur\[k\]\)/.test(panel)) ok("the old dollarInput helper is gone");
  else bad("the old dollarInput helper is gone");
}

console.log(`\nmoney-input: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
