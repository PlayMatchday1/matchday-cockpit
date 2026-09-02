/* D4. A FILTERED ASSERTION WITHOUT AN EMPTINESS GUARD FAILS REVIEW.
 *
 * THE SHAPE. `is("no row overlaps", rows.filter(bad).map(id), [])` is GREEN when `rows` is empty —
 * when the page did not render, when the selector changed, when the field being filtered on is
 * undefined. All four are indistinguishable from a passing test, and one of them was green for a
 * round: `r.hasMin` was never set, and `undefined && x` is always false.
 *
 * MEASURED 2026-09-02, before the fix: 72 page-sourced assertion sites across the browser suites —
 * 38 explicitly guarded, 7 self-guarding (compared against a non-zero expectation, so an empty set
 * yields 0 and fails), and 27 VACUOUS. Those 27 now route through nonEmpty().
 *
 * This guard keeps the count at zero. It is deliberately narrow: it flags a filtered collection
 * compared against [] or 0, or iterated with assertions inside, where the collection came from the
 * PAGE (so it can genuinely be empty) and nothing nearby proves it is not. A loop over a literal
 * like [390, 768] can never be empty and is not a defect.
 */
import { readdirSync, readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const PAGE_COLL = /\b(rows|entries|prices|cells|els|chips|tiles|axis|legend|heads|series|cards|items|offered|badgeAudit|rowMatches|align|numeric|dashed|frows|appended|rosterPosts)\b/;


/* THE BODY OF A BROWSER CALLBACK, matched by paren depth rather than a character window. A window
 * overran the call and swept up Node code after it, which is how this guard reported two false
 * positives the first time it ran. */
function browserRanges(src: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of src.matchAll(/\.(evaluate|\$\$eval|\$eval|evaluateHandle)\(/g)) {
    let i = src.indexOf("(", m.index! + m[0].length - 1), depth = 0;
    for (let j = i; j < src.length && j < i + 20000; j++) {
      const c = src[j];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { out.push([i, j]); break; } }
    }
  }
  return out;
}
const inBrowserAt = (ranges: [number, number][], idx: number) => ranges.some(([a, b]) => idx > a && idx < b);

function scan(): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const f of readdirSync("scripts/e2e").filter((x) => /^verify-.*\.mjs$/.test(x))) {
    const src = readFileSync(`scripts/e2e/${f}`, "utf8");
    const ranges = browserRanges(src);
    const offsets: number[] = []; { let o = 0; for (const ln of src.split("\n")) { offsets.push(o); o += ln.length + 1; } }
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      /* A .filter() INSIDE A BROWSER CALLBACK cannot carry nonEmpty — it is a Node import. Its
       * guard belongs on the value the callback RETURNS, in Node scope, and that is where this
       * scanner should look for it. Skipped here rather than reported as unguardable.
       *
       * DETECTED BY DOM-ONLY APIs, NOT BY PAREN DEPTH. A paren matcher is defeated by regex
       * literals — /rgba?\(([^)]+)\)/ has a ")" inside a character class, which closes the count
       * early and ends the range in the wrong place. getAttribute, getComputedStyle and friends
       * exist only in the page, so their presence on a line is unambiguous. */
      if (/\.(evaluate|\$\$eval|\$eval|evaluateHandle)\(/.test(l)) return;
      if (/getAttribute\(|getComputedStyle\(|querySelector|innerText|getBoundingClientRect\(|\bdocument\./.test(l)) return;
      if (inBrowserAt(ranges, offsets[i])) return;
      const fm = l.match(/([\w.]+)\.filter\(/);
      const om = l.match(/^\s*for \(const \w+ of ([\w.]+)\)/);
      const coll = fm?.[1] ?? om?.[1];
      if (!coll || !PAGE_COLL.test(coll) || /\.(delete|from)\(/.test(l)) return;
      if (/nonEmpty\(/.test(l)) return;                       // already guarded at the use site
      const ctx = (lines[i - 1] ?? "") + l + (lines[i + 1] ?? "");
      const asserted = /^\s*(is|yes|eq|near)\(/.test(lines[i - 1] ?? "") || /\b(is|eq|near)\(/.test(l)
        || (!!om && /\b(is|yes|eq|near)\(/.test(lines.slice(i, i + 22).join("\n")));
      if (!asserted) return;
      const cmpEmpty = /,\s*\[\]\s*\)/.test(ctx) || /\.length\s*,\s*0\s*\)/.test(ctx) || /,\s*0\s*\)/.test(ctx);
      const root = coll.split(".")[0];
      const before = lines.slice(Math.max(0, i - 24), i).join("\n");
      const guarded = new RegExp(`${root}[\\w.]*\\.length\\s*(>|>=|,)`).test(before)
        || /CONTROL[^\n]*(there (are|is)|really|non-empty|to check|to sum|to order|to collide|to have been|actually|were)/i.test(before);
      if (guarded || (!cmpEmpty && !om)) return;
      out.push({ file: f, line: i + 1, text: l.trim().slice(0, 90) });
    });
  }
  return out;
}

console.log("\nNO BROWSER ASSERTION MAY PASS ON AN EMPTY COLLECTION");
{
  const hits = scan();
  if (hits.length) for (const h of hits) console.log(`      ${h.file}:${h.line}  ${h.text}`);
  is("every filtered assertion is guarded against an empty collection", hits.length, 0);

  /* CONTROL: THE SCANNER MUST BE ABLE TO FIND ONE. Run it over a synthetic file in the same shape
   * and prove it flags it — a scan that reports zero because it cannot see anything is exactly the
   * failure mode this guard exists to prevent. */
  const probe = [
    'import { nonEmpty } from "./_session.mjs";',
    'const rows = await page.evaluate(READ);',
    'is("no row overlaps", rows.filter((r) => r.bad).map((r) => r.id), []);',
  ].join("\n");
  const lines = probe.split("\n");
  const l = lines[2];
  const coll = l.match(/([\w.]+)\.filter\(/)?.[1] ?? "";
  const wouldFlag = PAGE_COLL.test(coll) && /,\s*\[\]\s*\)/.test(l) && !/nonEmpty\(/.test(l);
  is("  CONTROL: the scanner flags an unguarded filtered assertion", wouldFlag, true);
  const guardedLine = l.replace("rows.filter(", 'nonEmpty(rows, "rows").filter(');
  is("  CONTROL: ...and stops flagging it once guarded", /nonEmpty\(/.test(guardedLine), true);

  /* AND IT MUST NOT BE CALLED INSIDE A BROWSER CALLBACK. nonEmpty is a Node import; page.evaluate
   * and $$eval serialize their callback and run it in the page, where the identifier does not
   * exist. My own sweep put it there in two suites and they threw ReferenceError on the next run —
   * a guard that breaks the suite it guards is worse than the hole it was closing. */
  const inBrowser: string[] = [];
  for (const f of readdirSync("scripts/e2e").filter((x) => /^verify-.*\.mjs$/.test(x))) {
    const src = readFileSync(`scripts/e2e/${f}`, "utf8");
    for (const [a, b] of browserRanges(src)) {
      const body = src.slice(a, b);
      if (/\bnonEmpty\(/.test(body)) inBrowser.push(`${f}: ${body.split("\n")[0].trim().slice(0, 60)}`);
    }
  }
  if (inBrowser.length) for (const h of inBrowser) console.log(`      ${h}`);
  is("  nonEmpty is never called inside a browser callback", inBrowser.length, 0);

  /* THE HELPER ITSELF must throw on empty rather than return it. */
  const sess = readFileSync("scripts/e2e/_session.mjs", "utf8");
  is("  the helper exists", /export function nonEmpty/.test(sess), true);
  is("  ...and throws rather than returning the empty set", /EMPTY COLLECTION: expected at least one/.test(sess), true);
  is("  ...naming what was expected to be there", /\$\{label\}/.test(sess), true);
}

console.log(`\nvacuous-assertion-guard: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
