import "server-only"; // no-op under --conditions=react-server
// Phase 19 Step 3a corrective — the realtime TEST SEAM in src/lib/supabase.ts must NEVER reach a
// production client bundle. It captures every crm channel's handlers so a hermetic test can fire a
// synthetic row; in production that is a SPOOFING hole (any page script could arm
// window.__CRM_TEST_REALTIME__ and invoke a captured handler to fake an inbound message from any
// number). It is neutralised by wrapping the ENTIRE seam — capture AND the removeChannel/unsubscribe
// tracking added in Step 3a — in one `if (process.env.NODE_ENV !== "production" && …)` block that
// Next dead-code-eliminates from the production build.
//
// This suite is the PERMANENT guard so the next person who touches the seam cannot forget:
//   (A) STRUCTURAL (always, fast, build-independent): every occurrence of the seam identifier in
//       supabase.ts lives INSIDE that one NODE_ENV-guarded block. Catches the exact regression —
//       seam code escaping the guard, or the guard being removed — at the source, before any build.
//       Stronger than a blind grep, which can only run after a build and which in DEV legitimately
//       finds the seam (dev IS non-production).
//   (A2) GENERAL: the seam is one instance of a CLASS — app code trusting a page-settable global.
//       Scan ALL of src/ for any window.__* / globalThis.__* reference (read OR write; direct, via a
//       type cast, or via a `= window` alias) that is NOT protected by a NODE_ENV !== "production"
//       guard (a brace block OR an inline check on the same statement), and fail on each. Closes the
//       class by any name/file so a future seam can't slip in under a different identifier.
//   (B) ARTIFACT (ALWAYS — never a silent skip): build a fresh isolated PRODUCTION bundle (via
//       NEXT_DIST_DIR so it can't touch a running `next dev` .next), then grep its client chunks and
//       assert 0 occurrences. A build that FAILS fails this check (with the tail of the error) — it
//       never passes by skipping. Next rewrites tsconfig.json on build; a `finally` restores it so
//       that edit can never be committed. Adds ~15s to the node set (well under the 180s cap).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/seam-stripped-test.ts

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };

const SEAM_ID = "__CRM_TEST_REALTIME__";
const SEAM_FILE = "src/lib/supabase.ts";
const PROD_STATIC = ".next-seamcheck/static";

// Find the [start, end] byte range of the NODE_ENV-guarded seam block by brace-matching.
function guardBlock(src: string): { open: number; close: number } | null {
  // Anchor on the actual `if (` statement, not the identical string inside the file's header comment.
  const cond = src.indexOf('if (process.env.NODE_ENV !== "production"');
  if (cond === -1) return null;
  const open = src.indexOf("{", cond);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return { open, close: i }; }
  }
  return null;
}

// True iff every occurrence of `id` in `src` sits within [block.open, block.close].
function allInside(src: string, id: string, block: { open: number; close: number }): { count: number; allInside: boolean } {
  let idx = -1, count = 0, inside = true;
  while ((idx = src.indexOf(id, idx + 1)) !== -1) {
    count++;
    if (idx < block.open || idx > block.close) inside = false;
  }
  return { count, allInside: inside };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Blank comments in place (same length, newlines kept) so byte offsets — hence line numbers — still
// map to the raw file, while comment text can no longer match a pattern.
const blankComments = (s: string) =>
  s.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
   .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

// All `if (process.env.NODE_ENV !== "production" …) { … }` block ranges in a file.
function nodeEnvBlocks(src: string): Array<{ open: number; close: number }> {
  const blocks: Array<{ open: number; close: number }> = [];
  let from = 0, i: number;
  while ((i = src.indexOf('if (process.env.NODE_ENV !== "production"', from)) !== -1) {
    const open = src.indexOf("{", i);
    if (open === -1) break;
    let depth = 0, close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close === -1) break;
    blocks.push({ open, close });
    from = close + 1;
  }
  return blocks;
}

// The statement around `at`: back to the nearest ; { }, forward to the next ;.
function statementText(src: string, at: number): string {
  let s = at; while (s > 0 && !";{}".includes(src[s - 1])) s--;
  let e = at; while (e < src.length && src[e] !== ";") e++;
  return src.slice(s, e);
}
const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

// Byte offsets of every window.__*/globalThis.__* reference (read OR write; direct, cast, or via a
// `= window` / `= globalThis` alias) NOT protected by a NODE_ENV !== "production" guard — a brace
// block OR an inline check on the same statement.
function unguardedGlobalRefs(blanked: string): number[] {
  const blocks = nodeEnvBlocks(blanked);
  const aliases = new Set<string>();
  for (const m of blanked.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:window|globalThis)\b/g)) aliases.add(m[1]);
  const patterns = [/\b(?:window|globalThis)\b[^;]{0,300}?\.\s*(__\w+)/g];
  for (const a of aliases) patterns.push(new RegExp(`\\b${a}\\s*\\.\\s*(__\\w+)`, "g"));
  const seen = new Set<number>(); const out: number[] = [];
  for (const re of patterns) {
    for (const m of blanked.matchAll(re)) {
      const idx = m.index ?? -1;
      if (idx < 0 || seen.has(idx)) continue;
      seen.add(idx);
      const inBlock = blocks.some((b) => idx >= b.open && idx <= b.close);
      const inline = statementText(blanked, idx).includes("process.env.NODE_ENV");
      if (!inBlock && !inline) out.push(idx);
    }
  }
  return out;
}

// ── (A) STRUCTURAL ─────────────────────────────────────────────────────────────────────────
// Analyse CODE only — a prose mention of the identifier in a comment is fine (comments never ship),
// so strip comments first. (Same approach as scripts/crm-characterize-test.ts.)
const noComments = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const SRC = noComments(readFileSync(SEAM_FILE, "utf8"));
const block = guardBlock(SRC);
block
  ? ok(`seam is wrapped in a process.env.NODE_ENV !== "production" guard (Next strips it from prod)`)
  : bad(`no NODE_ENV !== "production" guard found in ${SEAM_FILE}`);

if (block) {
  const r = allInside(SRC, SEAM_ID, block);
  r.count > 0
    ? ok(`the seam identifier ${SEAM_ID} is present in source (${r.count} occurrences)`)
    : bad(`${SEAM_ID} not found in source — did the identifier change? update this guard`);
  r.allInside
    ? ok(`ALL ${r.count} occurrences of ${SEAM_ID} are inside the production guard`)
    : bad(`a ${SEAM_ID} occurrence ESCAPED the production guard — it would ship to clients`);

  // The Step-3a tracking additions must also live inside the guard.
  const removeIn = (() => { const i = SRC.indexOf("supabase.removeChannel ="); return i > -1 && i > block.open && i < block.close; })();
  removeIn
    ? ok(`the removeChannel tracking wrap is inside the guard`)
    : bad(`the removeChannel tracking wrap is OUTSIDE the guard (or missing)`);
}

// teeth: a source where the seam escaped the guard MUST be rejected by the same logic.
{
  const broken = SRC + `\nconst leak = window.${SEAM_ID};\n`;
  const b = guardBlock(broken);
  const r = b ? allInside(broken, SEAM_ID, b) : { allInside: true };
  !r.allInside
    ? ok(`teeth: a ${SEAM_ID} reference outside the guard is correctly flagged`)
    : bad(`teeth: the structural check did NOT flag an escaped seam reference`);
}

// ── (A2) GENERAL: no ungated window.__/globalThis.__ reference anywhere in src/ ────────────────
{
  const files = walk("src").filter((f) => /\.tsx?$/.test(f));
  const findings: string[] = [];
  for (const f of files) {
    const blanked = blankComments(readFileSync(f, "utf8"));
    for (const idx of unguardedGlobalRefs(blanked)) {
      findings.push(`${f}:${lineOf(blanked, idx)}  ${blanked.slice(idx, idx + 70).replace(/\s+/g, " ").trim()}`);
    }
  }
  findings.length === 0
    ? ok(`(A2) no window.__/globalThis.__ reference in src/ escapes a NODE_ENV guard (${files.length} files scanned)`)
    : bad(`(A2) ${findings.length} ungated window-global reference(s) — each would ship to clients:\n      ${findings.join("\n      ")}`);
}

// teeth for (A2): block-guarded and inline-guarded refs pass; a bare one is flagged.
{
  const guardedBlock = `if (process.env.NODE_ENV !== "production") { const w = window as any; w.__X__ = 1; }`;
  const guardedInline = `const y = process.env.NODE_ENV !== "production" && (window as any).__Z__ === true;`;
  const leak = `(window as any).__EVIL__ = 1;`;
  const b = unguardedGlobalRefs(guardedBlock).length, il = unguardedGlobalRefs(guardedInline).length, lk = unguardedGlobalRefs(leak).length;
  (b === 0 && il === 0 && lk === 1)
    ? ok(`teeth: (A2) passes block- and inline-guarded window.__ refs, flags a bare one`)
    : bad(`teeth: (A2) guard/leak classification is wrong`, `block=${b} inline=${il} leak=${lk}`);
}

/* ── (B) ARTIFACT LIVES IN scripts/seam-artifact-check.ts NOW ─────────────────────────────────
 * It was 99s of a 128s fast set — 77% — for one `next build`, on every push. It is NOT deleted
 * and it is NOT weakened: .githooks/pre-push spawns it detached once the gate passes, it writes
 * .seam-artifact-result and raises a desktop notification if it fails. Vercel builds the same
 * commit and fails the deploy on the same error, so a broken build cannot reach players quietly.
 *
 * WHAT STAYS HERE IS THE HALF THAT CATCHES THE REGRESSION AT SOURCE — (A) every occurrence of the
 * seam identifier inside the one NODE_ENV-guarded block, and (A2) no unguarded window.__ /
 * globalThis.__ reference anywhere in src/. Those run in milliseconds and they fail on the commit
 * that introduces the leak rather than on the bundle that ships it. */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
