/* EVERY /api PATH A CONFINED PAGE CAN REACH, DERIVED FROM THE PAGES.
 *
 * WHY THIS EXISTS. city-confinement-test enumerates allowed and refused routes BY HAND, which is
 * the same hand that forgets one. Three have shipped refused-by-omission, each looking like a city
 * bug and none being one:
 *   /api/firebase-token   the chat LIST rendered, the message pane did not
 *   /api/match-managers   the page opened, the panel did not
 *   /api/veo/range        Master Schedule's Month view refused, Week fine (different route)
 * Every time, the page rendered and one call underneath it was refused, and the refusal reads
 * "This account is confined to one city. That page is outside it." — which names a city that was
 * never the problem. assertConfinedRoute compares a PATHNAME against an allowlist.
 *
 * SO THIS DERIVES THE LIST INSTEAD OF RESTATING IT. For every entry in CONFINED_RAIL_KEYS it
 * resolves the section's href to a page, walks that page's import tree inside src/, collects every
 * /api/... path the code mentions, and requires each to be either allowed by
 * isConfinedRouteAllowed or named in KNOWN_REFUSED with a reason. A route that is neither FAILS.
 *
 * WHAT IT CANNOT DO. It is a static walk: a path assembled from variables it will not see, and a
 * dynamic segment collapses to its prefix. Both are stated where they bite. It is a floor, not a
 * proof — but it is a floor that does not depend on anybody remembering.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { CONFINED_RAIL_KEYS, isConfinedRouteAllowed } from "../src/lib/cityConfinement";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));

/* ── ROUTES A CONFINED PAGE TOUCHES AND IS DELIBERATELY REFUSED ────────────────────────────────
 * Each needs a REASON, not just a name. Adding a line here is a decision to leave a control broken
 * for a confined operator, and the reason is where that decision is recorded. */
const KNOWN_REFUSED: Record<string, string> = {
  "/api/veo/resync":
    "Refresh. Builds a SERVICE-ROLE client and syncs the whole fleet for the week with NO city "
    + "scope, so a bounded account would trigger an unscoped shared-table write. Left refused on "
    + "purpose; both Week and Month now REPORT the failure instead of showing a refreshed time.",
  "/api/veo/intent":
    "The camera flag. Fleet configuration: a confined account reads its week and does not change "
    + "what the cameras cover. Left refused; the copy flow now says the flag did not carry rather "
    + "than reporting LANDED and losing it silently.",
  "/api/veo/slot-intent":
    "The RECURRING camera rule — every Tuesday at this field and time. Fleet configuration by the "
    + "same judgement as /api/veo/intent above, and more so: one write here marks matches across "
    + "every future week, including matches that do not exist yet. A bounded account reads its "
    + "week and does not decide what the fleet films. The CAMERA section simply does not render.",
  "/api/veo/reconcile":
    "The drift count between Clubhouse intent and the camera emoji in the MatchDay name. Reading "
    + "it is fleet-wide by construction — it walks every future match in every city — and pressing "
    + "what it offers renames matches players see. Refused for the same reason as the two above.",
  "/api/veo/codes": "The code table itself — fleet configuration, not a city's own data.",
  "/api/veo/cameras": "Camera inventory across every city.",
  "/api/schedule-master": "Writes the recurring slot template for every city, not one.",

  /* ── WHAT THIS CHECK SURFACED ON ITS FIRST RUN. None is the reported bug; all four are real, and
   * each is left refused with the reason rather than opened quietly or left unnamed. */
  "/api/manager-pay/week":
    "A NAV BADGE COUNTER (useManagerPayAttnCount), pulled in by shared chrome on every page. "
    + "Manager Pay is not in CONFINED_RAIL_KEYS, so this counts work on a rail a confined account "
    + "does not have. The badge simply does not render for them.",
  "/api/partner-dashboards/actionable":
    "The other nav badge counter (usePartnerDashboardsCount), same shape and same reason: Partner "
    + "Dashboards is outside the confined rail.",
  "/api/push/subscribe":
    "Push registration. It has NO city dimension at all — it is a per-user device subscription — "
    + "so refusing it is a side effect of the allowlist rather than a boundary decision, and a "
    + "confined operator cannot turn notifications on. Left refused pending Ryan; opening it is a "
    + "one-line change and nothing about it crosses a city.",
  "/api/push/unsubscribe": "The pair of the above, same reasoning.",
  "/api/promos/create":
    "Promo WRITES. A promo code is fleet-wide, not city-scoped, so a bounded account creating or "
    + "deleting one would be editing every city's discounts. The promos page is on the confined "
    + "rail deliberately as a READ.",
  "/api/promos/delete/": "See /api/promos/create.",
  "/api/promos/edit/": "See /api/promos/create.",
  "/api/promos/uses/": "See /api/promos/create — the uses list is a fleet-wide read on a fleet-wide code.",
  "/api/veo/":
    "The dynamic recording routes, /api/veo/[id] and /api/veo/[id]/flag — assign, dismiss, undo and "
    + "confirm. This is the walk collapsing a ${id} segment, and the real routes are writes on a "
    + "recording. Refused today, which is moot for Warsaw (no veo_codes row names a Warsaw field, "
    + "so no recording can arrive) but WOULD bite the next confined city that owns cameras. Named "
    + "rather than left to be discovered.",
};

/* Paths that are not routes this app guards: absolute URLs, and the two dynamic shapes the walk
 * cannot resolve. Stated rather than silently skipped. */
const IGNORE = /^\/api\/(auth|health)\b/;

const SRC = resolve("src");
const seen = new Set<string>();
function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;                        // node_modules — not ours to walk
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}
/** Every /api path mentioned in a file, with dynamic tails truncated at the first ${. */
function apiPathsIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)) {
    let p = m[1];
    const dyn = p.indexOf("${");
    if (dyn >= 0) p = p.slice(0, dyn);
    /* THE TRAILING SLASH IS LOAD-BEARING and must NOT be stripped: "/api/matchday/" is a PREFIX
     * entry and matches, while "/api/matchday" matches nothing. Trimming it turned every allowed
     * prefix into a refusal. */
    p = p.split("?")[0];
    if (p.length > 4) out.add(p);
  }
  return [...out];
}
/* THE POLICY FILE IS NOT A CALLER. cityConfinement.ts contains the allowlist itself, so scanning it
 * reports every entry as a call site the page makes. It defines the rule; it does not fetch. */
const NOT_A_CALLER = /src\/lib\/cityConfinement\.ts$/;
function walk(file: string, acc: Map<string, string>) {
  const real = resolve(file);
  if (seen.has(real) || !existsSync(real)) return;
  if (NOT_A_CALLER.test(real)) { seen.add(real); return; }
  seen.add(real);
  const src = readFileSync(real, "utf8");
  for (const p of apiPathsIn(src)) if (!acc.has(p)) acc.set(p, real.replace(`${resolve(".")}/`, ""));
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    const t = resolveImport(m[1], real);
    if (t) walk(t, acc);
  }
}

console.log("\nevery /api path each confined page can reach");
/* THE SECTION TABLE IS PARSED, NOT IMPORTED. sections.tsx carries inline JSX icons and pulls the
 * whole client tree in with it (useAuth -> supabase, which needs env this process does not have).
 * A static read is also the right shape for a static walk. */
const SECTIONS_SRC = readFileSync("src/app/(internal)/match-ops/sections.tsx", "utf8");
const hrefOf = new Map<string, string>();
for (const m of SECTIONS_SRC.matchAll(/\{\s*key:\s*"([^"]+)"[^\n]*?href:\s*"([^"]+)"/g)) hrefOf.set(m[1], m[2]);
yes(`the section table parsed (${hrefOf.size} sections)`, hrefOf.size >= 10, `got ${hrefOf.size}`);
let checked = 0;
for (const key of CONFINED_RAIL_KEYS) {
  const href = hrefOf.get(key);
  if (!href) { bad(`${key}: resolves to a real section`, "not in MATCH_OPS_SECTIONS"); continue; }
  const dir = join(resolve("src/app/(internal)"), href);
  const page = ["page.tsx", "page.ts"].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!page) { bad(`${key}: has a page at ${href}`, `no page.tsx under ${dir}`); continue; }
  seen.clear();
  const acc = new Map<string, string>();
  walk(page, acc);
  const paths = [...acc.keys()].filter((p) => !IGNORE.test(p)).sort();
  const refused = paths.filter((p) => !isConfinedRouteAllowed(p));
  const undecided = refused.filter((p) => !(p in KNOWN_REFUSED));
  console.log(`\n  ${key.padEnd(14)} ${href.padEnd(30)} ${paths.length} api paths · ${refused.length} refused`);
  for (const p of refused) console.log(`      ${(p in KNOWN_REFUSED ? "refused, known" : "REFUSED, UNDECIDED").padEnd(18)} ${p}   (${acc.get(p)})`);
  checked++;
  yes(`${key}: every /api path it reaches is allowed or a recorded decision`, undecided.length === 0,
    undecided.length ? `no decision for ${JSON.stringify(undecided)} — allow it, or add it to KNOWN_REFUSED with a reason` : "");
}
yes(`all ${CONFINED_RAIL_KEYS.length} confined rail pages were walked`, checked === CONFINED_RAIL_KEYS.length);

/* THE CONTROL. The check is only worth anything if it FAILS when a route goes missing from the
 * allowlist — which is the exact defect it exists for. Simulated on the real allowlist. */
console.log("\ncontrol: the check notices a route removed from the allowlist");
{
  const src = readFileSync("src/lib/cityConfinement.ts", "utf8");
  yes("/api/veo/range is on the exact list", /^\s*"\/api\/veo\/range",$/m.test(src));
  /* WITHOUT IT, Master Schedule's Month view reaches a refused route with no recorded decision —
   * which is precisely what this test reports. Proven by asking the predicate about a path the
   * list does not contain, rather than by editing the file. */
  const notListed = "/api/veo/rangeX";
  yes("…and a path NOT on it is refused", !isConfinedRouteAllowed(notListed));
  yes("…so removing the entry would leave Month's route undecided",
    !KNOWN_REFUSED[notListed] && !isConfinedRouteAllowed(notListed));
}

/* AND THE PREFIX LIST STAYS SHUT. "/api/veo/" would open codes, cameras, intent and inbound. */
console.log("\nthe fix did not widen the prefix list");
for (const p of ["/api/veo/codes", "/api/veo/cameras", "/api/veo/intent", "/api/veo/inbound"])
  yes(`${p} is still refused`, !isConfinedRouteAllowed(p));
yes("…and /api/veo/ is not a prefix entry",
  !readFileSync("src/lib/cityConfinement.ts", "utf8").match(/CONFINED_ROUTE_PREFIXES[\s\S]*?\]/)?.[0].includes('"/api/veo/"'));

console.log(`\nconfined-routes: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
