/* EVERY SCHEDULED PATH MUST ANSWER THE VERB VERCEL SENDS.
 *
 * Vercel cron jobs issue an HTTP GET (https://vercel.com/docs/cron-jobs#how-cron-jobs-work). A
 * route handler that exports only POST answers 405, every night, forever, and NOTHING SAYS SO:
 * the cron dashboard shows the job firing, the route never runs, no fin_sync_log row is written,
 * and a table simply stops filling up.
 *
 * THIS IS NOT HYPOTHETICAL. Read from the production invocation logs on 2026-09-18:
 *
 *   /api/sync/meta-ad-spend    10:00:39Z  GET -> 405   (and 09-17, 09-16)
 *   /api/sync/users-full       09:00:35Z  GET -> 405   (and 09-17, 09-16)
 *   /api/sync/wp-submissions   12:00:42Z  GET -> 405   (and 09-17, 09-16)
 *   /api/sync/cron             11:00:03Z  GET -> 200   (and 09-17, 09-16)
 *
 * meta-ad-spend had ONE fin_sync_log row in its entire life, triggered_by='manual', while
 * $4,392.97 of ad spend went unrecorded. The failure is silent in every direction: the only place
 * it was visible was a log nobody had reason to open.
 *
 * WHY A SUITE AND NOT A COMMENT. The three routes are fixed; the NEXT cron somebody adds is the
 * problem. This is a whole class of bug that costs nothing to close permanently, and it is pure —
 * it reads vercel.json and the route files off disk, no network, no clock.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/cron-verb-test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  XX  ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** Strip comments so a mention in prose can never be mistaken for an export. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Does this route source export a GET handler, in either of the two forms the estate uses? */
export function exportsGet(source: string): boolean {
  const code = strip(source);
  return /^\s*export\s+(async\s+)?function\s+GET\b/m.test(code)
      || /^\s*export\s+const\s+GET\s*=/m.test(code);
}

console.log("CRON VERB\n");

const cfg = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string; schedule: string }[] };
const crons = cfg.crons ?? [];

console.log("the schedule is real");
// POSITIVE CONTROL. Everything below iterates this list; an empty or unparsed one would make every
// assertion below pass by having nothing to check.
is("vercel.json declares cron jobs", crons.length > 0, true);
console.log(`     ${crons.length} scheduled: ${crons.map((c) => `${c.path} @ ${c.schedule}`).join(", ")}`);

console.log("\nthe detector has teeth");
/* CONTROLS FOR THE DETECTOR ITSELF, because every assertion in the next block is "this source
 * exports GET" and a detector that always returns true would pass all of them. */
is("a POST-only route is detected as MISSING GET",
  exportsGet("export async function POST(req: Request) { return new Response(); }"), false);
is("`export const GET = POST` counts", exportsGet("export async function POST(){}\nexport const GET = POST;"), true);
is("`export async function GET` counts", exportsGet("export async function GET(){}"), true);
is("`export function GET` counts", exportsGet("export function GET(){}"), true);
/* AND IT IS NOT FOOLED BY PROSE. The comment block at the top of every one of these routes talks
 * about GET at length — "READ-ONLY AGAINST META. Every Graph request is a GET" — so a naive
 * /GET/ test would call a POST-only route compliant. That is the exact shape of a guard that
 * reports green on the bug it exists to catch. */
is("a comment mentioning GET does NOT count",
  exportsGet("// Every Graph request is a GET; export const GET = POST would be wrong here\nexport async function POST(){}"), false);
is("…nor does a block comment", exportsGet("/* export const GET = POST */\nexport async function POST(){}"), false);

console.log("\nevery scheduled path resolves to a route file");
const resolved: { path: string; file: string; src: string }[] = [];
for (const c of crons) {
  // A cron path maps to src/app/<path>/route.ts in the App Router. A path with no file 404s
  // nightly, which is the same silent failure by a different route.
  const candidates = ["route.ts", "route.tsx", "route.js"].map((f) => join("src/app", c.path, f));
  const file = candidates.find((f) => existsSync(f));
  if (!file) { bad(`${c.path} resolves to a route file`, `none of ${candidates.join(", ")} exists`); continue; }
  ok(`${c.path} -> ${file}`);
  resolved.push({ path: c.path, file, src: readFileSync(file, "utf8") });
}
is("every scheduled path was resolved", resolved.length, crons.length);

console.log("\nevery scheduled route answers GET");
for (const r of resolved) {
  if (exportsGet(r.src)) ok(`${r.path} exports GET`);
  else bad(`${r.path} exports GET`, "VERCEL CRON SENDS GET — this path will answer 405 every night and nothing will say so");
}

console.log("\n…and still answers POST, so the manual path is unchanged");
for (const r of resolved) {
  const code = strip(r.src);
  const hasPost = /^\s*export\s+(async\s+)?function\s+POST\b/m.test(code) || /^\s*export\s+const\s+POST\s*=/m.test(code);
  if (hasPost) ok(`${r.path} exports POST`);
  else bad(`${r.path} exports POST`, "the GET alias must ADD an entry point, never replace one");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  XX  ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
