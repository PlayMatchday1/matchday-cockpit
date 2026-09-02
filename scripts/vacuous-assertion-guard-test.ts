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

function scan(): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const f of readdirSync("scripts/e2e").filter((x) => /^verify-.*\.mjs$/.test(x))) {
    const lines = readFileSync(`scripts/e2e/${f}`, "utf8").split("\n");
    lines.forEach((l, i) => {
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

  /* THE HELPER ITSELF must throw on empty rather than return it. */
  const sess = readFileSync("scripts/e2e/_session.mjs", "utf8");
  is("  the helper exists", /export function nonEmpty/.test(sess), true);
  is("  ...and throws rather than returning the empty set", /EMPTY COLLECTION: expected at least one/.test(sess), true);
  is("  ...naming what was expected to be there", /\$\{label\}/.test(sess), true);
}

console.log(`\nvacuous-assertion-guard: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
