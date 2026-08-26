// MATCH MANAGERS, driven in a browser at 1280 and 390 against the REAL route. On demand only —
// `node scripts/e2e/verify-match-managers.mjs`, or `npm run verify:e2e` with `npm run dev` up.
// Nothing is mocked except the app_users grant.
//
// IT ASSERTS, AND IT EXITS NON-ZERO. It shipped for one commit named shot-*.mjs, which
// run-suites --e2e does not discover (it globs verify-*.mjs) — a file that looks like coverage and
// executes never. Same failure family as a suite reporting zero assertions.
//
// PRESENCE BEFORE ABSENCE: every check below runs only after a real ROW has rendered, because a
// loading screen satisfies almost any absence assertion you can write. And each absence check
// carries a POSITIVE CONTROL in the same run — the pattern is proven to fire on text that does
// contain the thing before it is trusted to report zero.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.env.OUT || "/tmp";
const RE_CM = /city[\s-]?manager/i;
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const grantEdit = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const res = await route.fetch(); let json = await res.json().catch(() => null);
  const patch = (r) => ({ ...r, can_access_matchops: true });
  json = Array.isArray(json) ? json.map(patch) : (json && typeof json === "object" ? patch(json) : json);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(json) });
});
async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };
  const browser = await chromium.launch({ headless: true });
  for (const [w, h, tag] of [[1280, 1600, "1280"], [390, 1600, "390"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState, ...(w === 390 ? { isMobile: true, hasTouch: true } : {}) });
    await grantEdit(ctx);
    const p = await ctx.newPage();
    p.on("console", (m) => { if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 200)); });
    await p.goto(`${BASE}/match-ops/player-lookup`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="mm-toggle"]', { timeout: 20000 });
    await p.click('[data-testid="mm-toggle"]');
    // PRESENCE WAIT BEFORE ANYTHING IS READ: a row, not a timeout.
    await p.waitForSelector('[data-testid="mm-row"]', { timeout: 30000 });
    const counts = await p.textContent('[data-testid="mm-counts"]');
    const rows = await p.locator('[data-testid="mm-row"]').count();
    const chips = await p.locator('[data-testid="mm-city-chip"]').count();
    const body = await p.textContent('[data-testid="mm-panel"]');
    const banner = await p.textContent('[data-testid="mm-naming-banner"]');
    const addDis = await p.locator('[data-testid="mm-add"]').isDisabled();
    const rmDis = await p.locator('[data-testid="mm-remove"]').first().isDisabled();
    const leaks = (body.match(/privaterelay/gi) || []).length;
    /* THE RULE IS ABOUT WHAT THESE PEOPLE ARE CALLED, NOT ABOUT THE API'S URL. The endpoint is
     * literally /city-managers, and the disabled-controls reason now quotes it — "Retool adds with
     * POST /city-managers" — which is the API naming itself, exactly like the banner. So the
     * endpoint PATH is stripped before the check, and the control below proves the strip removed
     * something rather than silently matching nothing. */
    const withoutBanner = body.replace(banner, "");
    const pathHits = (withoutBanner.match(/\/city-managers/g) || []).length;
    const cmOutsideBanner = (withoutBanner.replace(/\/city-managers/g, " ").match(RE_CM) || []).length;
    const foot = await p.textContent('[data-testid="mm-foot"]');

    console.log(`  [${tag}] header="${counts.trim()}" rows=${rows} chips=${chips}`);
    is(`${tag}: the header carries BOTH counts`, /\d+\s*people\s*·\s*\d+\s*city assignments/.test(counts.replace(/\s+/g, " ")), true);
    is(`${tag}: one row per PERSON, not per assignment`, rows < chips, true);
    is(`${tag}: the header's people count IS the row count`, Number(counts.match(/(\d+)\s*people/)[1]), rows);
    is(`${tag}: the header's assignment count IS the chip count`, Number(counts.match(/(\d+)\s*city assignments/)[1]), chips);
    is(`${tag}: the footer reconciles the two`, /people/.test(foot) && /assignment/.test(foot), true);

    // POSITIVE CONTROL for the two zeros below — the same patterns, on text that has the thing.
    is(`${tag}: control — the city-manager pattern fires when the phrase is present`,
       RE_CM.test("not the city managers in Clubhouse permissions"), true);
    is(`${tag}: control — the relay pattern fires when a token is present`,
       /privaterelay/i.test("a1b2c3@privaterelay.appleid.com"), true);
    is(`${tag}: no relay token is rendered`, leaks, 0);
    is(`${tag}: control — the API's own path IS on screen (so the strip stripped something)`, pathHits > 0, true);
    is(`${tag}: nothing outside the banner CALLS these people "city managers"`, cmOutsideBanner, 0);
    is(`${tag}: the banner itself explains the API's word`, RE_CM.test(banner), true);
    is(`${tag}: at least one row is labelled as an Apple relay`, /Apple private relay · ID \d+/.test(body), true);

    // OFF BECAUSE CLUBHOUSE HAS NOT BUILT THEM. The API does support both — Retool's ADD CITY
    // MANAGER button posts to /city-managers and its DELETE button deletes from it, proven on
    // staging. The earlier wording here asserted the opposite and was wrong.
    is(`${tag}: ADD is disabled — Clubhouse has not built it`, addDis, true);
    is(`${tag}: REMOVE is disabled — Clubhouse has not built it`, rmDis, true);
    is(`${tag}: the reason is on screen, not only in a tooltip`, /Clubhouse has not built/i.test(body), true);
    is(`${tag}: the reason names the endpoints that DO exist`,
       /POST \/city-managers/.test(body) && /DELETE \/city-managers/.test(body), true);
    is(`${tag}: …and never claims the API cannot do it`, /no endpoint to add or remove/i.test(body), false);

    // THE CITY CHIPS FILTER, and the filter box narrows. Both proven against a live row count.
    const atx = p.locator('[data-testid="mm-cities"] button', { hasText: /^ATX/ });
    if (await atx.count()) {
      await atx.first().click();
      await p.waitForFunction((n) => document.querySelectorAll('[data-testid="mm-row"]').length < n, rows);
      const scoped = await p.locator('[data-testid="mm-row"]').count();
      is(`${tag}: the ATX chip narrows the roster`, scoped > 0 && scoped < rows, true);
      await p.locator('[data-testid="mm-cities"] button', { hasText: /^All/ }).first().click();
      await p.waitForFunction((n) => document.querySelectorAll('[data-testid="mm-row"]').length === n, rows);
      is(`${tag}: All restores every person`, await p.locator('[data-testid="mm-row"]').count(), rows);
    } else bad(`${tag}: an ATX city chip exists`);

    await p.locator('[data-testid="mm-filter"]').fill("zzzznobodyzzzz");
    await p.waitForFunction(() => document.querySelectorAll('[data-testid="mm-row"]').length === 0);
    is(`${tag}: a query nobody matches empties the list`, await p.locator('[data-testid="mm-row"]').count(), 0);
    await p.locator('[data-testid="mm-filter"]').fill("");
    await p.waitForFunction((n) => document.querySelectorAll('[data-testid="mm-row"]').length === n, rows);
    is(`${tag}: control — clearing the query restores every person`, await p.locator('[data-testid="mm-row"]').count(), rows);

    await p.locator('[data-testid="mm-panel"]').screenshot({ path: `${OUT}/mm-${tag}.png` });
    console.log(`  wrote ${OUT}/mm-${tag}.png`);
    await ctx.close();
  }
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
