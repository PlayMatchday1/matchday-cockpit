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
  /* COMMENTS ARE STRIPPED BEFORE THE SCAN — and the line numbering survives, because each comment
   * is blanked in place rather than removed.
   *
   * WHY: this guard flagged a COMMENT in copyMatch.ts whose whole purpose was to warn the next
   * reader against `new Date(m.startDate)`. A guard that fires on the sentence explaining the trap
   * teaches people to delete the explanation, which is the opposite of what it is for. A comment
   * cannot re-shift a date; only code can.
   *
   * IT CANNOT WEAKEN THE GUARD. Blanking comments strictly removes false positives — no executable
   * statement lives inside a comment, so nothing real can hide there. The control below proves the
   * scan still fires on the same pattern in live code. */
  const src = readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
  const lines = src.split("\n");
  lines.forEach((line, i) => { if (RE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`); });
}

/* CONTROL: the scan still catches the pattern in LIVE code. Without this, stripping comments could
 * quietly turn the whole guard into a no-op and every run would report a clean estate. */
RE.test("  const d = new Date(m.startDate);")
  ? ok("control: the scan still fires on `new Date(m.startDate)` in real code")
  : bad("control: the wall-clock scan still works", "STRIPPING COMMENTS HAS DISABLED THE GUARD");
RE.test("  const d = new Date(match.endDate).toISOString();")
  ? ok("control: …and on endDate")
  : bad("control: the scan fires on endDate");
RE.test("  const d = new Date(m.startDateUtc);")
  ? bad("control: *Utc must NOT be flagged", "IT IS A TRUE INSTANT AND new Date ON IT IS CORRECT")
  : ok("control: startDateUtc is correctly NOT flagged");

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
