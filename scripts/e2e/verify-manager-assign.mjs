// ASSIGN A MATCH MANAGER — driven in a browser, against the REAL match route.
//   node scripts/e2e/verify-manager-assign.mjs      (needs `npm run dev` up)
//
// IT SENDS NOTHING. Every assertion below stops at the confirmation; the write itself is exercised
// against STAGING by the probe recorded in managerAssign.ts, never from here and never against
// production. The last act of this suite is Cancel, and it asserts the panel went back to clean.
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
  const patch = (r) => ({ ...r, can_access_matchops: true, can_edit_matches: true });
  json = Array.isArray(json) ? json.map(patch) : (json && typeof json === "object" ? patch(json) : json);
  return route.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify(json) });
});

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  // A REAL UPCOMING MATCH THAT HAS A MANAGER, chosen from the mirror rather than hardcoded — a
  // pinned id dates the same way verify-pace-readout's day 25 did.
  const { data: rows, error } = await svc.from("mdapi_matches")
    .select("api_id,name,city_identifier,start_date,manager_id,is_cancelled,deleted_at")
    .not("manager_id", "is", null).is("deleted_at", null).eq("is_cancelled", false)
    .eq("city_identifier", "ATX").order("start_date", { ascending: false }).limit(5);
  if (error) { console.error(error.message); process.exit(1); }
  if (!rows?.length) { bad("a managed Austin match exists in the mirror to open"); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const target = rows[0];
  console.log(`  target: match ${target.api_id} — ${JSON.stringify(target.name)} (${target.city_identifier})`);

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1500 }, storageState });
  await grant(ctx);
  // A BELT-AND-BRACES BLOCK ON THE WRITE. Nothing in this suite clicks Confirm, and if a future
  // edit does, the PUT is refused here rather than reaching MatchDay.
  let putAttempts = 0;
  await ctx.route("**/api/matchday/**", (route) => {
    if (route.request().method() !== "GET") { putAttempts++; return route.abort(); }
    return route.continue();
  });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 240)); });
  p.on("requestfailed", (r) => console.log("  requestfailed:", r.method(), r.url().slice(0, 120)));
  await p.goto(`${BASE}/match-ops/match-panel/${target.api_id}`, { waitUntil: "domcontentloaded" });

  // PRESENCE FIRST: the select, populated, before anything is counted.
  /* GENEROUS ON THE FIRST WAIT, ON PURPOSE. Opening this panel is four live MatchDay round trips
   * (the match, the fields, the roster, and both manager lists), and the lane runs suites two at a
   * time — this suite passed alone and timed out at 30s inside the lane, which is a stopwatch
   * failure and not a finding. The runner allows 240s per suite; 120s here is still well inside it
   * and the suite finishes in ~35s when nothing is competing. */
  await p.waitForSelector('[data-testid="mp-mgr"]', { timeout: 120000 });
  await p.waitForFunction(() => document.querySelector('[data-testid="mp-mgr"]').options.length > 1, null, { timeout: 120000 });

  const opts = () => p.$eval('[data-testid="mp-mgr"]', (el) => [...el.options].map((o) => ({ v: o.value, t: o.text })));
  const cityOpts = await opts();
  is("the picker offers the no-manager option first", cityOpts[0].v, "none");
  ok(`the city roster offers ${cityOpts.length - 1} managers by default`);
  is("nobody is marked off-city while collapsed", cityOpts.filter((o) => /other city/.test(o.t)).length, 0);
  is("the selected option is a real option, not a browser fallback",
     await p.$eval('[data-testid="mp-mgr"]', (el) => el.selectedIndex >= 0 && el.value === String(el.options[el.selectedIndex].value)), true);
  const selectedText = await p.$eval('[data-testid="mp-mgr"]', (el) => el.options[el.selectedIndex].text);
  is("the attached manager is named, not shown as an id", /^id \d+$/.test(selectedText), false);

  // THE ESCAPE.
  const escape = p.locator('[data-testid="mp-mgr-allcities"]');
  is("the escape is visible", await escape.isVisible(), true);
  const escapeTxt = await escape.textContent();
  is("…and says how many it adds", /\(\d+\)/.test(escapeTxt), true);
  await escape.locator("input").check();
  await p.waitForFunction((n) => document.querySelector('[data-testid="mp-mgr"]').options.length > n, cityOpts.length);
  const allOpts = await opts();
  ok(`expanded, the picker offers ${allOpts.length - 1} managers`);
  is("expanding only ever adds people", allOpts.length > cityOpts.length, true);
  is("the people it adds are labelled off-city", allOpts.filter((o) => /other city/.test(o.t)).length, allOpts.length - cityOpts.length);
  is("the current selection survives expanding",
     await p.$eval('[data-testid="mp-mgr"]', (el) => el.options[el.selectedIndex].text), selectedText);

  // THE CONFIRMATION. Pick a DIFFERENT manager and press Save.
  const curVal = await p.inputValue('[data-testid="mp-mgr"]');
  const other = allOpts.find((o) => o.v !== "none" && o.v !== curVal);
  await p.selectOption('[data-testid="mp-mgr"]', other.v);
  await p.click('[data-testid="mp-save"]');
  await p.waitForSelector('[data-testid="mp-mgr-confirm"]', { timeout: 45000 });
  const cf = await p.textContent('[data-testid="mp-mgr-confirm"]');
  is("Save stops at a confirmation instead of writing", await p.locator('[data-testid="mp-mgr-confirm"]').isVisible(), true);
  is("the confirmation names the person being attached", cf.includes(other.t.replace(" · other city", "")), true);
  is("…and the person being replaced", cf.includes(selectedText.replace(" · other city", "")), true);
  is("…and the match", cf.includes(target.name ?? ""), true);
  is("…and an amount", /\$\d+/.test(cf), true);
  is("…and that it is never retried", /never retried/i.test(cf), true);
  // POSITIVE CONTROL for the id check: the pattern fires on a string that does carry a bare id.
  is("control — the bare-id pattern fires when an id is present", /\bid \d+/.test("Attach id 41207"), true);
  is("the confirmation never names a bare id", /\bid \d+/.test(cf), false);
  is("NOTHING was sent to MatchDay to reach this point", putAttempts, 0);

  await p.locator('[data-testid="mp-mgr-confirm"]').screenshot({ path: `${OUT}/mgr-confirm.png` });
  console.log(`  wrote ${OUT}/mgr-confirm.png`);

  // CANCEL SENDS NOTHING.
  await p.click('[data-testid="mp-mgr-cancel"]');
  await p.waitForSelector('[data-testid="mp-mgr-confirm"]', { state: "detached", timeout: 10000 });
  is("Cancel closes the confirmation", await p.locator('[data-testid="mp-mgr-confirm"]').count(), 0);
  is("Cancel sent nothing", putAttempts, 0);

  // DETACH IS OFFERED — proven on staging that null detaches, so the control is live, not decorative.
  await p.selectOption('[data-testid="mp-mgr"]', "none");
  await p.click('[data-testid="mp-save"]');
  await p.waitForSelector('[data-testid="mp-mgr-confirm"]', { timeout: 45000 });
  const dt = await p.textContent('[data-testid="mp-mgr-confirm"]');
  is("choosing no manager is a real, enabled option", await p.locator('[data-testid="mp-mgr"]').isDisabled(), false);
  is("the detach confirmation says the pay stops", /stops paying/i.test(dt), true);
  is("…and names who is being detached", dt.includes(selectedText.replace(" · other city", "")), true);
  await p.click('[data-testid="mp-mgr-cancel"]');
  is("still nothing sent", putAttempts, 0);

  await ctx.close(); await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
