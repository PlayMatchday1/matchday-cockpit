import "server-only"; // no-op under --conditions=react-server
// Phase 18 — the WALL-CLOCK trap guard. MatchDay startDate/endDate are wall-clock strings
// mislabelled "…Z"; calling `new Date()` on them re-shifts to the viewer's timezone and
// renders a WRONG clock (docs/matchday-api-facts.md, rule at the top). This bit twice: the
// drawer got it right (wallDate/wallTime), the editor did not. A lint-style source scan
// that FAILS if `new Date(...)` is ever called on a match's startDate/endDate — same shape
// as write-routes-logged-test.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/walltime-guard-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };

// Files where a `new Date(... startDate ...)` is a DIFFERENT type, not a MatchDay wall-clock
// string — allowlisted with the reason so a real new offender still fails.
const ALLOW: { file: string; why: string }[] = [
  { file: "src/lib/reviewsDerive.ts", why: "r.startDate is a Date object (reviews), not a wall-clock string" },
  { file: "src/lib/useFinanceData.ts", why: "finance date-range startDate (plain ISO date), not a match wall-clock" },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

// `new Date(` ... `\b(startDate|endDate)\b` on the same statement. Word boundaries exclude
// startDateUtc / endDateUtc (true instants — new Date on those is CORRECT), startDateIso, and
// snake_case start_date (a DB column). A negative lookahead also drops explicit *Utc/*Iso.
const RE = /new Date\([^;\n]*?\b(startDate|endDate)(?!Utc|Iso)\b/;

const files = walk("src");
ok(`scanned ${files.length} .ts/.tsx files under src`);

const offenders: string[] = [];
for (const f of files) {
  const rel = f.replace(/\\/g, "/");
  if (ALLOW.some((a) => rel.includes(a.file))) continue; // allowlisted
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => { if (RE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`); });
}

offenders.length === 0
  ? ok("no `new Date(...)` on a match startDate/endDate wall-clock string (outside the allowlist)")
  : bad(`WALL-CLOCK TRAP: ${offenders.length} `+"`new Date()` on startDate/endDate", "\n    " + offenders.join("\n    "));

// The allowlist must not rot: every allowlisted file must still exist AND still contain a
// matching `new Date(...)` — otherwise the entry is stale and should be removed.
for (const a of ALLOW) {
  const hit = files.some((f) => f.replace(/\\/g, "/").includes(a.file) && readFileSync(f, "utf8").split("\n").some((l) => RE.test(l)));
  hit ? ok(`allowlist still needed: ${a.file}`) : bad(`stale allowlist entry (no matching new Date left): ${a.file}`);
}

console.log(`\nwalltime-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
