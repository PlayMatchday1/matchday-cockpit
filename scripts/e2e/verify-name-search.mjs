// PLAYER LOOKUP · NAME SEARCH — driven in a browser against the REAL route and live data.
//   node scripts/e2e/verify-name-search.mjs      (needs `npm run dev` up)
//
// READ-ONLY. Search is a GET; nothing here writes anything.
//
// THE LIVE HALF OF player-lookup-search-test. That suite pins the rules against a fixture; this one
// proves they hold against production, where the bug actually was: Anderson King (id 395, email
// kinga11592@gmail.com) was invisible to "anderson" for the life of the feature because ?email=
// matches email and phone and NOT name — while the comment above it said, in writing, that it
// matched name too, "confirmed live".
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

const rows = (p) => p.locator('.res[data-pid]');

async function search(p, term) {
  /* THE SETTLE-WAIT HAS TO EXCLUDE THE EMPTY STATE, not just "searching…".
   *
   * The first version waited for the header to stop saying "searching…". Clearing the box first
   * sets kind=empty, which renders the header as "" — and "" is not "searching…", so the wait
   * returned INSTANTLY, before the request had even been debounced. It then read "" as the answer.
   * Same family as an absence assertion satisfied by a loading screen: the state you are waiting to
   * leave is not the only state that isn't the one you are waiting for. */
  await p.fill("#pl-q", "");
  await p.waitForFunction(() => (document.querySelector('[data-testid="res-count"]')?.textContent || "") === "", null, { timeout: 60000 });
  await p.fill("#pl-q", term);
  await p.waitForFunction(() => {
    const t = document.querySelector('[data-testid="res-count"]')?.textContent || "";
    return t !== "" && !/searching/i.test(t);
  }, null, { timeout: 60000 });
  return (await p.textContent('[data-testid="res-count"]')).trim();
}

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  /* THE SUBJECT IS DERIVED, NOT PINNED. A hardcoded name dates the same way verify-pace-readout's
   * day 25 did. Ask the mirror for someone whose NAME contains a term their EMAIL does not — the
   * exact shape of the bug — and drive the page with whatever it returns. */
  const { data: cands, error } = await svc.from("mdapi_users")
    .select("id,first_name,last_name,email")
    .ilike("first_name", "%anderson%").not("email", "ilike", "%anderson%")
    .order("id").limit(5);
  if (error) { bad("the mirror can be queried for a name-only account", error.message); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  is("control — a name-only account exists to test with", (cands ?? []).length > 0, true);
  const subject = cands[0];
  console.log(`  subject: id ${subject.id} — ${subject.first_name} ${subject.last_name} <${subject.email}>`);
  is("control — the subject's email really does NOT contain the term", /anderson/i.test(subject.email ?? ""), false);
  is("control — the subject's NAME really does", /anderson/i.test(`${subject.first_name} ${subject.last_name}`), true);

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, storageState });
  await grant(ctx);
  let writes = 0;
  await ctx.route("**/api/lookup/**", (r) => { if (r.request().method() !== "GET") writes++; return r.continue(); });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/match-ops/player-lookup`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#pl-q", { timeout: 120000 });

  // ── 1. THE NAME-ONLY MATCH, LIVE ────────────────────────────────────────────────────────────
  const h1 = await search(p, "anderson");
  await p.waitForSelector(`.res[data-pid="${subject.id}"]`, { timeout: 60000 });
  ok(`"anderson" finds ${subject.first_name} ${subject.last_name} — whose email does not contain it`);
  const shown = await rows(p).count();
  is("…among a real list of results", shown > 1, true);
  // AND THE ROW IS LIVE DETAIL, not a mirror row: the email on screen came back from the API.
  const rowEmail = (await p.locator(`.res[data-pid="${subject.id}"] .c-email`).textContent()).trim();
  is("the row shows the player's real email, read live from the API", rowEmail, subject.email);

  // ── 2. THE HEADER IS A TOTAL, NOT THE PAGE SIZE ─────────────────────────────────────────────
  console.log(`  header for "anderson": ${JSON.stringify(h1)}`);
  is('the header never reads "N matches" where N is the row count on a capped page',
     /^\d+ match/.test(h1) && Number(h1.match(/^(\d+)/)?.[1]) === shown && shown >= 25, false);
  const m = h1.match(/of (\d+)$/) || h1.match(/^(\d+) match/);
  is("the header carries a number", !!m, true);
  const headerTotal = Number(m[1]);
  // THE NUMBER MUST BE THE TRUE TOTAL. Asked of the mirror independently, the same way the route
  // counts it — if these disagree the header is inventing again.
  const { count: trueTotal } = await svc.from("mdapi_users").select("*", { count: "exact", head: true })
    .or("first_name.ilike.%anderson%,last_name.ilike.%anderson%");
  is("the header's number IS the true total, not the page size", headerTotal, trueTotal);
  is("…and the true total is not the page size", trueTotal === 25, false);

  // ── 3. A TWO-WORD QUERY ─────────────────────────────────────────────────────────────────────
  const two = `${subject.first_name} ${subject.last_name}`.trim();
  if (subject.last_name) {
    const h2 = await search(p, two);
    await p.waitForSelector(`.res[data-pid="${subject.id}"]`, { timeout: 60000 });
    ok(`"${two}" finds them — a two-word query used to return zero, always`);
    console.log(`  header for "${two}": ${JSON.stringify(h2)}`);
    is("…and the list is narrower than the one-word search", await rows(p).count() <= shown, true);
    const rev = `${subject.last_name} ${subject.first_name}`.trim();
    await search(p, rev);
    await p.waitForSelector(`.res[data-pid="${subject.id}"]`, { timeout: 60000 });
    ok(`"${rev}" finds them too — word order does not matter`);
    // NEGATIVE, WITH ITS CONTROL: a second word nobody has must find nobody, and the same search
    // without it must find someone — otherwise the zero proves nothing.
    await search(p, `${subject.first_name} zzzznobodyzzzz`);
    is("a wrong second word finds nobody", await rows(p).count(), 0);
    await search(p, subject.first_name);
    is("control — the same first word alone still finds people", await rows(p).count() > 0, true);
  } else ok("subject has no last name — two-word case covered by the fixture suite");

  // ── 4. THERE IS A WAY TO REACH THE REST ─────────────────────────────────────────────────────
  const hBig = await search(p, "garcia");
  const pager = p.locator('[data-testid="res-pager"]');
  is("a term with more than one page shows a pager", await pager.isVisible(), true);
  console.log(`  header for "garcia": ${JSON.stringify(hBig)}`);
  is("Previous is disabled on page 1", await p.locator('[data-testid="res-prev"]').isDisabled(), true);
  const firstIds = await rows(p).evaluateAll((els) => els.map((e) => e.dataset.pid));
  await p.click('[data-testid="res-next"]');
  await p.waitForFunction((old) => {
    const el = document.querySelector('[data-testid="res-count"]');
    return el && !/searching/i.test(el.textContent || "") && el.textContent.trim() !== old;
  }, hBig, { timeout: 60000 });
  const h2page = (await p.textContent('[data-testid="res-count"]')).trim();
  console.log(`  page 2 header: ${JSON.stringify(h2page)}`);
  is("page 2 counts on from page 1", /^Showing 26–/.test(h2page), true);
  const secondIds = await rows(p).evaluateAll((els) => els.map((e) => e.dataset.pid));
  is("page 2 is different people", firstIds.filter((i) => secondIds.includes(i)).length, 0);
  is("control — both pages actually have rows", firstIds.length > 0 && secondIds.length > 0, true);
  is("Previous is enabled on page 2", await p.locator('[data-testid="res-prev"]').isDisabled(), false);
  // A NEW TERM RESTARTS AT PAGE 1 — otherwise a short term shows an empty page 2.
  await search(p, "anderson");
  is("a new term goes back to page 1", await rows(p).count() > 0, true);

  // ── 5. THE STALENESS WINDOW IS ON SCREEN, ON THE PATH THAT HAS ONE ──────────────────────────
  is("a name search says its finding comes from the mirror", await p.locator('[data-testid="res-mirror-note"]').isVisible(), true);
  const note = await p.textContent('[data-testid="res-mirror-note"]');
  is("…and warns that a very new player may not be findable by name yet", /may not be findable by name/i.test(note), true);
  is("…and says the other three routes still work", /phone, email or ID/i.test(note), true);
  await search(p, "395");
  is("an ID search does NOT claim a mirror window — it goes straight to the API",
     await p.locator('[data-testid="res-mirror-note"]').count(), 0);

  is("nothing was written", writes, 0);
  await p.screenshot({ path: `${OUT}/name-search.png`, fullPage: false });
  await ctx.close(); await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
