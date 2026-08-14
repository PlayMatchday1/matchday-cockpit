import "server-only"; // no-op under --conditions=react-server
// Phase 29 Part A — the CITY MANAGER tier, grantable from the UI.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/city-scope-test.ts
//
// The thing this tier has always been one keystroke away from: city_identifier is free text with
// no database constraint (0120, deliberately), every scoped query does
// `.eq("city_identifier", …)`, so a near-miss scopes an account to NOTHING and renders identically
// in the grid. These assertions are mostly about refusing that.

import { readFileSync } from "node:fs";
import { CITY_SCOPES, CITY_IDENTIFIERS, resolveCityScope, cityNameFor, isUnknownScope } from "../src/lib/cityScope";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

console.log("\nTHE SCOPE LIST — the seven cities, pinned");
eq("the identifiers are exactly the seven mdapi_matches carries",
  [...CITY_IDENTIFIERS].sort(), ["ATL", "ATX", "DFW", "HOU", "OKC", "SATX", "STL"]);
eq("...paired with the display names Gameday Ops shows on its chips",
  CITY_SCOPES.map((c) => `${c.identifier}=${c.name}`),
  ["ATL=Atlanta", "ATX=Austin", "DFW=Dallas / Fort Worth", "HOU=Houston", "OKC=Oklahoma City", "SATX=San Antonio", "STL=St. Louis"]);
is("the list is sorted, so the dropdown is predictable",
  JSON.stringify(CITY_IDENTIFIERS) === JSON.stringify([...CITY_IDENTIFIERS].sort()), true);

console.log("\nEXACT MATCH ONLY — the near-misses that made this SQL-only");
is("a known identifier resolves", resolveCityScope("DFW")?.identifier, "DFW");
is("lower case is REFUSED, not corrected", resolveCityScope("dfw"), null);
is("a trailing space is REFUSED", resolveCityScope("DFW "), null);
is("a leading space is REFUSED", resolveCityScope(" DFW"), null);
is("the CITY NAME is not an identifier", resolveCityScope("Dallas / Fort Worth"), null);
is("a plausible-but-wrong abbreviation is REFUSED", resolveCityScope("DAL"), null);
is("empty is refused", resolveCityScope(""), null);
is("null is refused", resolveCityScope(null), null);
is("a non-string is refused", resolveCityScope(42), null);
is("an object cannot smuggle a value through", resolveCityScope({ identifier: "DFW" }), null);
is("resolving returns the CANONICAL row, so callers store the list's value not the input",
  resolveCityScope("ATX")!.identifier === "ATX" && resolveCityScope("ATX")!.name === "Austin", true);

console.log("\nAN UNKNOWN STORED SCOPE IS SHOWN AS BROKEN, not rendered as fine");
is("a value outside the list is flagged", isUnknownScope("DAL"), true);
is("...and has no display name to show", cityNameFor("DAL"), null);
is("a known value is not flagged", isUnknownScope("HOU"), false);
is("...and has its name", cityNameFor("HOU"), "Houston");
is("no scope at all is not 'unknown' — it is simply absent", isUnknownScope(null), false);

console.log("\nTHE ROUTE enforces every rule, not just the button");
{
  const src = readFileSync("src/app/api/admin/users/city-manager/route.ts", "utf8");
  is("it is admin-gated", /authenticateAdmin\(req\)/.test(src), true);
  is("the city is validated through the ALLOWLIST, server-side", /resolveCityScope\(/.test(src), true);
  is("...and the CANONICAL value is stored, never the raw input", /nextCity = scope\.identifier/.test(src), true);
  is("ADMIN + CITY MANAGER is refused at the ROUTE with a 409", /nextIsCm && t\.is_admin[\s\S]*?status: 409/.test(src), true);
  is("...and the refusal explains WHY, rather than just saying no", /mutually exclusive/i.test(src), true);
  is("turning the tier off NULLS the city", /if \(!nextIsCm\) \{\s*nextCity = null;/.test(src), true);
  is("service accounts are refused", /is_service_account[\s\S]{0,160}status: 403/.test(src), true);
  is("the change goes through recordWrite into change_log", /recordWrite\(/.test(src), true);
  is("...logging BOTH columns", /keys: \["is_city_manager", "city_identifier"\]/.test(src), true);
  is("...and identifying the target by ID only — no email, no name, in the log payload",
    /path: `\/app_users\/\$\{body\.userId\}`/.test(src), true);
  is("the row is RE-READ after the write, so the grid shows what the 0120 trigger actually did",
    /Re-read AFTER the write/.test(src), true);
}

console.log("\nTHE INVITE ALLOWLIST stays an allowlist");
{
  const src = readFileSync("src/app/api/admin/users/invite/route.ts", "utf8");
  is("is_city_manager is named explicitly", /"is_city_manager",/.test(src), true);
  is("city_identifier is declared on the flags type", /city_identifier\?: string \| null;/.test(src), true);
  is("...and is NOT swept in by a loosened loop — it is picked separately",
    /type BoolPermissionKey = Exclude<keyof PermissionFlags, "city_identifier">/.test(src), true);
  is("the invite path validates the city through the same allowlist", /resolveCityScope\(src\.city_identifier\)/.test(src), true);
  is("an invite carrying admin + city manager drops the tier", /out\.is_city_manager && out\.is_admin/.test(src), true);
  is("...and no tier means no scope", /if \(!out\.is_city_manager\) out\.city_identifier = null;/.test(src), true);
  // The allowlist must not have become a passthrough.
  is("no arbitrary column can be written — the key list is still finite",
    /const PERMISSION_KEYS: BoolPermissionKey\[\] = \[/.test(src), true);
  is("...and it did not grow a spread or a dynamic key", /\.\.\.src|Object\.keys\(src\)/.test(src.slice(src.indexOf("function pickPermissions"), src.indexOf("export async function POST"))), false);
}

console.log("\nTHE GRID shows the tier AND the scope, with a dropdown");
{
  const src = readFileSync("src/components/AdminUsersView.tsx", "utf8");
  is("there is a CITY MANAGER column", /"City Manager", "City"/.test(src), true);
  is("the city control is a SELECT, never a text input",
    /<select[\s\S]*?data-testid="city-select"/.test(src) && /<option/.test(src) && !/type="text"[\s\S]{0,200}city/i.test(src), true);
  is("...whose options come from the shared scope list", /CITY_SCOPES\.map\(\(c\) => \(\s*<option/.test(src.replace(/\s+/g, " ").replace(/ /g, " ")) || /CITY_SCOPES\.map/.test(src), true);
  is("the tier toggle is disabled for admins", /disabled=\{!!u\.is_admin \|\| !!u\.is_service_account\}/.test(src), true);
  is("...and says why on screen", /Admins can&rsquo;t be City Managers/.test(src), true);
  is("a stored value outside the list is surfaced as broken", /data-testid="city-unknown"/.test(src), true);
  is("the grid writes through the guarded route, not a direct table update",
    /fetch\("\/api\/admin\/users\/city-manager"/.test(src), true);
  is("...and renders the server's re-read, not the optimistic value",
    /const row = json\.user[\s\S]{0,260}city_identifier: row\.city_identifier/.test(src), true);
}

console.log("\nTHE UI PATH AND THE SQL PATH PRODUCE THE SAME ROW SHAPE");
{
  // Both write exactly these two columns and nothing else; both store a canonical identifier.
  const route = readFileSync("src/app/api/admin/users/city-manager/route.ts", "utf8");
  const sql = readFileSync("supabase/migrations/0120_city_manager.sql", "utf8");
  const routeUpdate = route.slice(route.indexOf(".update("), route.indexOf(".update(") + 140);
  is("the route updates is_city_manager + city_identifier and nothing else",
    /is_city_manager: nextIsCm, city_identifier: nextCity/.test(routeUpdate), true);
  is("the migration's documented SQL grant sets the same two columns",
    /set is_city_manager = true, city_identifier = 'ATX'/.test(sql), true);
  is("the migration's constraint still requires a scope when the tier is on",
    /is_city_manager = false or \(city_identifier is not null/.test(sql), true);
  is("...and its trigger still nulls the scope when the tier goes off",
    /NEW\.city_identifier := null;/.test(sql), true);
  is("the E2E service account is blocked at the DATABASE, keyed on email (0116/0120)",
    /is_service_account/.test(sql), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
