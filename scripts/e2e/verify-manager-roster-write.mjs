// ADD AND REMOVE A MATCH MANAGER — driven in a browser, both controls, both confirmations.
//   node scripts/e2e/verify-manager-roster-write.mjs      (needs `npm run dev` up)
//
// IT NEVER WRITES. Every POST and DELETE to /api/match-managers is INTERCEPTED AND ABORTED, and
// the count of attempts is asserted at ZERO at every step that has not pressed Confirm. The writes
// themselves were proven against STAGING — POST took /city-managers from 19 rows to 20 and DELETE
// took it back to 19, each verified by reading the list back and the state restored. Production is
// never exercised from here.
//
// WHAT IT IS FOR. Two of these assertions have been WRONG in this repo, in opposite directions:
// "REMOVE is disabled because the API has no endpoint" (false — I grepped for an invented function
// name instead of tracing Retool's button), then "disabled because Clubhouse has not built it"
// (true at the time, false now). A control's enabled state is a claim about the API, and it is
// worth a test that fails when the claim rots.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.env.OUT || "/tmp";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const grant = (ctx) => ctx.route("**/rest/v1/app_users*", async (route) => {
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 }, storageState });
  await grant(ctx);

  // THE INTERCEPTOR. Reads pass through; every write is counted and aborted before it leaves.
  const writes = [];
  await ctx.route("**/api/match-managers**", (route) => {
    const m = route.request().method();
    if (m === "GET") return route.continue();
    writes.push({ method: m, url: route.request().url(), body: route.request().postData() });
    return route.abort();
  });

  const p = await ctx.newPage();
  await p.goto(`${BASE}/match-ops/player-lookup`, { waitUntil: "domcontentloaded" });

  // ── THE PANEL: REMOVE ───────────────────────────────────────────────────────────────────────
  await p.waitForSelector('[data-testid="mm-toggle"]', { timeout: 120000 });
  await p.click('[data-testid="mm-toggle"]');
  await p.waitForSelector('[data-testid="mm-row"]', { timeout: 120000 });   // presence before anything

  const rm = p.locator('[data-testid="mm-remove"]').first();
  is("panel: REMOVE is enabled", await rm.isDisabled(), false);
  const rmCity = await rm.getAttribute("data-city");
  const rowName = await p.locator('[data-testid="mm-row"]').first().locator("b").first().textContent();
  await rm.click();
  await p.waitForSelector('[data-testid="mm-confirm"]', { timeout: 45000 });
  const cf = await p.textContent('[data-testid="mm-confirm"]');
  is("panel: Remove stops at a confirmation instead of writing", writes.length, 0);
  is("panel: the confirmation names the person", cf.includes(rowName.trim()), true);
  is("panel: …and the city", cf.includes(rmCity), true);
  is("panel: …and the consequence", /stop being assignable/i.test(cf), true);
  is("panel: …and that it is never retried", /never retried/i.test(cf), true);
  await p.locator('[data-testid="mm-confirm"]').screenshot({ path: `${OUT}/mmw-remove.png` });
  await p.click('[data-testid="mm-confirm-cancel"]');
  await p.waitForSelector('[data-testid="mm-confirm"]', { state: "detached", timeout: 45000 });
  is("panel: Cancel sends nothing", writes.length, 0);

  // ── THE PANEL: ADD SENDS YOU TO PLAYER LOOKUP'S SEARCH, NOT TO A SECOND BOX ──────────────────
  is("panel: ADD is enabled", await p.locator('[data-testid="mm-add"]').isDisabled(), false);
  const before = await p.locator('[data-testid="mm-panel"] input').count();
  await p.click('[data-testid="mm-add"]');
  await p.waitForSelector('[data-testid="mm-add-hint"]', { timeout: 45000 });
  is("panel: Add opens no second search box", await p.locator('[data-testid="mm-panel"] input').count(), before);
  is("panel: the page's own search takes focus", await p.evaluate(() => document.activeElement?.id), "pl-q");
  const hint = await p.textContent('[data-testid="mm-add-hint"]');
  is("panel: the hint names all four ways to search", /phone, email, name or ID/i.test(hint), true);
  is("panel: …and says why Retool's email-only box cannot find everyone", /relay/i.test(hint), true);
  is("panel: still nothing sent", writes.length, 0);

  // ── THE CARD ON A PLAYER, FOUND BY ID — THE HANDLE A RELAY PERSON ACTUALLY HAS ───────────────
  // Chosen from the live roster rather than pinned: a hardcoded id dates.
  const relayRow = p.locator('[data-testid="mm-row"]', { has: p.locator('text=/Apple private relay/') }).first();
  const relayLabel = await relayRow.locator('[data-testid="mm-email"]').textContent();
  const relayId = relayLabel.match(/ID (\d+)/)[1];
  ok(`found a relay-address manager to search by ID: ${relayId}`);
  await p.fill("#pl-q", relayId);
  // The search returns a result row; opening the profile is a click, exactly as an operator does it.
  await p.waitForSelector(`.res[data-pid="${relayId}"]`, { timeout: 120000 });
  await p.click(`.res[data-pid="${relayId}"]`);
  await p.waitForSelector('[data-testid="mmr-card"]', { timeout: 120000 });
  is("card: searching by ID reaches a player Retool's email-only modal cannot find", await p.locator('[data-testid="mmr-card"]').isVisible(), true);
  is("card: it carries no search box of its own", await p.locator('[data-testid="mmr-card"] input').count(), 0);

  /* PRESENCE BEFORE COUNTING. The card renders its frame immediately and fills in after the
     roster fetch resolves, so counting chips straight away counts a card that has not loaded —
     the same trap as an absence assertion against a loading screen, in its counting form. Wait
     for the card to have DECIDED: either it shows cities, or it says there are none. */
  await p.waitForFunction(() =>
    document.querySelector('[data-testid="mmr-held"]') || document.querySelector('[data-testid="mmr-none"]'),
    null, { timeout: 120000 });
  const held = await p.locator('[data-testid="mmr-held"]').count();
  is("card: the cities they already hold are shown", held > 0, true);
  is("card: REMOVE on the card is enabled", await p.locator('[data-testid="mmr-remove"]').first().isDisabled(), false);

  // ADD — the city picker is keyed on the numeric id from GET /cities.
  const opts = await p.$eval('[data-testid="mmr-city"]', (el) => [...el.options].map((o) => ({ v: o.value, t: o.text })));
  is("card: the city picker offers real numeric ids", opts.slice(1).every((o) => /^\d+$/.test(o.v)), true);
  const heldLabels = (await p.locator('[data-testid="mmr-held"]').allTextContents()).map((t) => t.replace("×", "").trim());
  is("card: …and never a city they are already on", opts.slice(1).some((o) => heldLabels.includes(o.t)), false);
  // POSITIVE CONTROL for that zero: the held labels are real and the picker is not simply empty.
  is("card: control — there ARE held cities and there ARE offerable ones", heldLabels.length > 0 && opts.length > 1, true);
  await p.selectOption('[data-testid="mmr-city"]', opts[1].v);
  is("card: ADD is enabled once a city is chosen", await p.locator('[data-testid="mmr-add"]').isDisabled(), false);
  await p.click('[data-testid="mmr-add"]');
  await p.waitForSelector('[data-testid="mmr-confirm"]', { timeout: 45000 });
  const acf = await p.textContent('[data-testid="mmr-confirm"]');
  is("card: Add stops at a confirmation instead of writing", writes.length, 0);
  is("card: the confirmation names the city", acf.includes(opts[1].t), true);
  is("card: …and the consequence — they become payable", /Manager Pay pays them/i.test(acf), true);
  is("card: …and that it is never retried", /never retried/i.test(acf), true);
  await p.locator('[data-testid="mmr-confirm"]').screenshot({ path: `${OUT}/mmw-add.png` });
  await p.click('[data-testid="mmr-cancel"]');
  await p.waitForSelector('[data-testid="mmr-confirm"]', { state: "detached", timeout: 45000 });
  is("card: Cancel sends nothing", writes.length, 0);

  // ── AND ONLY CONFIRM SENDS. Proven by letting one through the interceptor's counter and
  //    aborting it, so the SHAPE of the request is asserted without any of it reaching MatchDay.
  await p.click('[data-testid="mmr-add"]');
  await p.waitForSelector('[data-testid="mmr-confirm"]', { timeout: 45000 });
  await p.click('[data-testid="mmr-go"]');
  await p.waitForFunction(() => document.querySelector('[data-testid="mmr-result"]'), null, { timeout: 45000 });
  is("card: Confirm sends exactly one request", writes.length, 1);
  is("card: …and it is a POST", writes[0].method, "POST");
  is("card: …carrying only userId and cityId", Object.keys(JSON.parse(writes[0].body)).sort(), ["cityId", "userId"]);
  is("card: …with the id the search found", JSON.parse(writes[0].body).userId, Number(relayId));
  is("card: …and the numeric city id from GET /cities", JSON.parse(writes[0].body).cityId, Number(opts[1].v));
  const res = await p.textContent('[data-testid="mmr-result"]');
  const verdict = await p.getAttribute('[data-testid="mmr-result"]', "data-verdict");
  is("card: a blocked request reports UNKNOWN, never a cheerful success", verdict, "UNKNOWN");
  is("card: …and tells the operator to look before acting", /look before acting/i.test(res), true);
  is("card: …and never invites a retry", /try again|retry/i.test(res), false);
  is("card: nothing was retried", writes.length, 1);

  await ctx.close(); await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
