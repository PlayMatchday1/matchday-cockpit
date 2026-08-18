// THE MIRROR WRITE-THROUGH — only on LANDED, and only the read-back value.
//
// mdapi_matches is a read-only mirror of MatchDay refreshed by ONE daily cron
// (vercel.json "0 11 * * *"). Every Clubhouse screen reads names from it, so a name written
// through the match PUT was invisible in Clubhouse for up to ~24 hours. Measured on production:
// 6 of 6 landed Veo name writes were still absent from the mirror an hour later.
//
// The danger in fixing that is a mirror which claims a write landed when it did not, so this pins
// the two directions at source: LANDED refreshes the row; anything else must not touch it.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/veo-mirror-writethrough-test.ts
import { readFileSync } from "node:fs";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const src = readFileSync("src/app/api/matchday/[env]/matches/[id]/route.ts", "utf8");
// Comments describe intent; only code enforces it. Strip them before asserting on the source —
// this suite has been fooled by its own prose before.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

console.log("the mirror refresh is gated on LANDED:");
is("it is guarded by outcome === \"landed\"", /outcome === "landed"/.test(code), true);
is("…and only when `name` was one of the keys written", /keys\.includes\("name"\)/.test(code), true);
is("…it updates mdapi_matches", /from\("mdapi_matches"\)\s*\.update\(/.test(code), true);
is("…the value written is the READ-BACK, not the intended one", /const readBack = cached\.name/.test(code), true);
is("…scoped to the one match by api_id", /\.eq\("api_id", Number\(id\)\)/.test(code), true);
is("…and only the name column moves", /\.update\(\{ name: readBack \}\)/.test(code), true);
// The mirror must NEVER be refreshed from the request body — that is the value we hoped to send.
is("it never writes the request body's name to the mirror", /update\(\{ name: changes/.test(code), false);
// POSITIVE CONTROL: the same scan proves it can see an update to that table at all, so the `false`
// above is a real reading and not an empty file.
is("  control — the scan does see an mdapi_matches update in this file", /mdapi_matches/.test(code), true);
is("the refresh cannot fail the write (best-effort, like the logging)", /console\.warn\(`\[mirror\]/.test(code), true);

// THE MIRROR IS PRODUCTION-ONLY. mdapi_matches is fed by the production read client
// (mdapiMatchesSync.ts:311), so it holds PRODUCTION api_ids. A staging write carries a staging id
// into the same number space; refreshing on it would rewrite whichever production match shares
// that number. Caught before it shipped — the first draft of this write-through was not gated.
console.log("\nand it never fires for a non-production environment:");
is("gated on env === \"production\"", /env === "production" && outcome === "landed"/.test(code), true);
is("  …the env check comes BEFORE the update", code.indexOf('env === "production"') < code.indexOf('from("mdapi_matches")'), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
