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

// ── (B) ARTIFACT — build fresh, then grep. NEVER a silent skip. ───────────────────────────────
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const TSCONFIG = "tsconfig.json";
const savedTsconfig = readFileSync(TSCONFIG, "utf8");
let buildOk = false, buildErr = "";
try {
  rmSync(join(".next-seamcheck", "static"), { recursive: true, force: true }); // grep only FRESH chunks
  execSync("npx next build", {
    // NODE_ENV=production so the seam is dead-code-eliminated; NEXT_DIST_DIR isolates the output;
    // NODE_OPTIONS cleared so run-suites' --conditions=react-server can't reach the app build.
    env: { ...process.env, NODE_ENV: "production", NEXT_DIST_DIR: ".next-seamcheck", NODE_OPTIONS: "" },
    stdio: "pipe",
    timeout: 150_000,
  });
  buildOk = true;
} catch (e) {
  const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
  buildErr = (err.stderr?.toString() || err.stdout?.toString() || err.message || String(e)).split("\n").filter(Boolean).slice(-6).join(" | ");
} finally {
  writeFileSync(TSCONFIG, savedTsconfig); // undo Next's tsconfig rewrite whether the build passed or failed
}

if (!buildOk) {
  bad(`ARTIFACT: isolated production build FAILED — cannot verify the seam is stripped`, buildErr);
} else if (existsSync(PROD_STATIC) && statSync(PROD_STATIC).isDirectory()) {
  let hits = 0;
  for (const f of walk(PROD_STATIC)) {
    try { hits += (readFileSync(f, "utf8").match(new RegExp(SEAM_ID, "g")) ?? []).length; } catch { /* binary/asset */ }
  }
  hits === 0
    ? ok(`ARTIFACT: 0 occurrences of ${SEAM_ID} in the freshly-built production client chunks`)
    : bad(`ARTIFACT: ${SEAM_ID} appears ${hits}× in the production client chunks — the seam SHIPPED`);
} else {
  bad(`ARTIFACT: build reported success but ${PROD_STATIC} is missing`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
