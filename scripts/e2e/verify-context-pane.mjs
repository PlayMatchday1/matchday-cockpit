// THE PLAYER CHATS CONTEXT PANE — what only a browser can answer.
//   node scripts/e2e/verify-context-pane.mjs      (needs `npm run dev` up)
//
// The summaries, the colour rationing and the search reasons are proven as pure functions in
// scripts/context-pane-test.ts. THIS asserts the things that live in the DOM and the network: that
// the pane and Player Lookup print the same numbers for the same real players, that a thread switch
// costs one request and not two, that section state survives a switch and a reload and is keyed on
// the operator, that the severe actions are absent, and that a search result never links a thread.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

const paneState = (p) => p.evaluate(() => ({
  head: Object.fromEntries([...document.querySelectorAll('[data-testid^="ctx-head-"]')]
    .map((e) => [e.dataset.testid.replace("ctx-head-", ""), e.firstElementChild.textContent.trim()])),
  summaries: Object.fromEntries([...document.querySelectorAll('[data-testid^="ctx-summary-"]')]
    .map((e) => [e.dataset.testid.replace("ctx-summary-", ""), { text: e.textContent.trim(), tone: e.dataset.tone }])),
  open: Object.fromEntries([...document.querySelectorAll('[data-testid^="ctx-section-"]')]
    .map((e) => [e.dataset.testid.replace("ctx-section-", ""), e.dataset.open === "1"])),
  name: document.querySelector('[data-testid="ctx-name"]')?.textContent?.trim() ?? null,
}));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  /* THREE REAL ACCOUNTS, DERIVED: a casual, a member, and a member with a cancelled subscription.
   * Each must have a chat thread, or there is no pane to compare. */
  /* OPEN threads only, most recent first. A closed thread is not in the default inbox view, so
   * ?threadId= lands on a page that never selects it and the pane never mounts — which is how the
   * first run of this suite timed out waiting for an element that was never going to appear. */
  const { data: threads } = await svc.from("crm_threads")
    .select("id, player_id, phone_number, last_message_at").not("player_id", "is", null)
    .eq("status", "open").order("last_message_at", { ascending: false }).limit(400);
  const ids = threads.map((t) => t.player_id);
  const { data: subs } = await svc.from("mdapi_subscriptions").select("user_id, status, canceled_at").in("user_id", ids);
  const memberIds = new Set(subs.filter((s) => s.status === "ACTIVE" && !s.canceled_at).map((s) => s.user_id));
  const cancelledIds = new Set(subs.filter((s) => s.canceled_at).map((s) => s.user_id));
  const subbed = new Set(subs.map((s) => s.user_id));
  const pick = (f) => threads.find((t) => f(t.player_id));
  const cases = [
    ["a casual", pick((id) => !subbed.has(id))],
    ["a member", pick((id) => memberIds.has(id))],
    ["a member who cancelled", pick((id) => cancelledIds.has(id))],
  ].filter(([, t]) => t);
  console.log(`     comparing ${cases.length} account kinds in the DOM: ${cases.map(([k, t]) => `${k} (player ${t.player_id})`).join(", ")}`);

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };
  const H = { Authorization: `Bearer ${vv.data.session.access_token}` };
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1050 }, storageState });
  const p = await ctx.newPage();

  /* THE THIRD KIND, WHEN NOBODY OF THAT KIND HAS AN OPEN THREAD. The DOM comparison needs a
   * conversation to open; the VALUES comparison does not — both routes take a player id. So every
   * kind is compared at the route level, and the DOM proves the pane renders what the route gives
   * it. Which kinds got which is printed rather than assumed. */
  const { data: allThreads } = await svc.from("crm_threads").select("id, player_id")
    .not("player_id", "is", null).order("last_message_at", { ascending: false }).limit(1200);
  const allIds = allThreads.map((t) => t.player_id);
  const { data: allSubs } = await svc.from("mdapi_subscriptions").select("user_id, status, canceled_at").in("user_id", allIds);
  const allMember = new Set(allSubs.filter((x) => x.status === "ACTIVE" && !x.canceled_at).map((x) => x.user_id));
  const allCancelled = new Set(allSubs.filter((x) => x.canceled_at).map((x) => x.user_id));
  const allSubbed = new Set(allSubs.map((x) => x.user_id));
  const kindsById = {
    casual: allThreads.find((t) => !allSubbed.has(t.player_id))?.player_id ?? null,
    member: allThreads.find((t) => allMember.has(t.player_id))?.player_id ?? null,
    cancelled: allThreads.find((t) => allCancelled.has(t.player_id))?.player_id ?? null,
  };
  console.log(`     comparing at the ROUTE level: ${JSON.stringify(kindsById)}`);
  for (const [kind, pid] of Object.entries(kindsById)) {
    if (pid == null) { bad(`a ${kind} account to compare`, "none found"); continue; }
    const lk = await (await fetch(`${BASE}/api/lookup/production?id=${pid}`, { headers: H, cache: "no-store" })).json();
    const th = allThreads.find((t) => t.player_id === pid);
    if (!th) { console.log(`     ${kind}: no thread, route comparison skipped`); continue; }
    const cx = await (await fetch(`${BASE}/api/crm/threads/${th.id}/context`, { headers: H, cache: "no-store" })).json();
    is(`${kind}: the context route's credits equal Player Lookup's`, cx.profile?.player?.credits, lk.player?.credits);
    is(`${kind}: …and its played count`, cx.profile?.player?.matchesPlayed, lk.player?.matchesPlayed);
    is(`${kind}: …and its membership`, cx.profile?.membership, lk.membership);
    is(`${kind}: …and its strikes`, cx.profile?.strikes?.activeCount, lk.strikes?.activeCount);
  }


  /* WAIT FOR THE PANE'S CONTENT, NOT FOR THE ABSENCE OF A SPINNER. "Loading player…" is gone
   * before the pane has mounted at all, so the first version of this helper returned on an empty
   * pane and every assertion after a reload read {}. */
  const settle = async () => {
    await p.waitForSelector('[data-testid="ctx-pane"]', { timeout: 240000 });
    await p.waitForSelector('[data-testid="ctx-summary-credits"], [data-testid="ctx-phone-unknown"], [data-testid="ctx-profile-missing"]', { timeout: 180000 });
    await p.waitForTimeout(400);
  };
  const openThread = async (id) => {
    await p.goto(`${BASE}/match-ops/player-chats?threadId=${id}`, { waitUntil: "domcontentloaded" });
    await settle();
  };

  // ---- 1. the pane prints what Player Lookup prints, on three real accounts ----
  for (const [kind, t] of cases) {
    await openThread(t.id);
    const st = await paneState(p);
    const lk = await (await fetch(`${BASE}/api/lookup/production?id=${t.player_id}`, { headers: H, cache: "no-store" })).json();
    const wantCredits = "$" + ((lk.player?.credits ?? 0) / 100).toFixed(2);
    console.log(`     ${kind}: pane ${JSON.stringify(st.head)} · lookup credits=${wantCredits} played=${lk.player?.matchesPlayed} strikes=${lk.strikes?.activeCount}/${lk.strikes?.limit}`);
    is(`${kind}: credits agree with Player Lookup`, st.head.credits, wantCredits);
    is(`${kind}: played agrees`, st.head.played, String(lk.player?.matchesPlayed ?? ""));
    is(`${kind}: strikes agree`, st.head.strikes, `${lk.strikes?.activeCount}/${lk.strikes?.limit}`);
    // 2. A casual's payments are match spots; a member's are subscription charges.
    const payRes = await (await fetch(`${BASE}/api/crm/threads/${t.id}/context`, { headers: H, cache: "no-store" })).json();
    const rows = payRes.payments?.ok ? payRes.payments.result.rows : null;
    if (rows?.length) {
      const memberish = rows.filter((r) => r.isMembership).length;
      console.log(`     ${kind}: ${rows.length} charges, ${memberish} of them membership`);
      if (kind === "a casual") is(`${kind}: no charge is a subscription charge`, memberish, 0);
      else yes(`${kind}: at least one charge is a subscription charge`, memberish > 0, `${memberish} of ${rows.length}`);
    } else {
      console.log(`     ${kind}: payments unavailable (${payRes.payments?.error ?? "no rows"}) — the spot/subscription split is NOT verified here`);
    }
    // 4. Red only where something is wrong.
    const reds = Object.entries(st.summaries).filter(([, v]) => v.tone === "red").map(([k]) => k);
    if (kind === "a casual") is(`${kind}: nothing on the pane is red`, reds, []);
    else console.log(`     ${kind}: red sections ${JSON.stringify(reds)}`);
    // 9. The severe actions are nowhere in the pane.
    const text = await p.$eval('[data-testid="ctx-pane"]', (e) => e.innerText);
    is(`${kind}: Suspend / Expel / Remove / Add appear nowhere in the pane`,
      ["Suspend", "Expel", "Remove from", "Add to a match"].filter((w) => text.includes(w)), []);
  }

  // ---- 3. every summary is derived: change nothing, reload, get the same answers ----
  const first = await paneState(p);
  await p.reload({ waitUntil: "domcontentloaded" });
  await settle();
  is("the summaries are stable across a reload (they are computed, not stored)", (await paneState(p)).summaries, first.summaries);

  // ---- 5. section state survives a thread switch and a reload, per operator ----
  await openThread(cases[0][1].id);
  await p.click('[data-testid="ctx-toggle-payments"]');
  await p.waitForTimeout(200);
  is("opening Payments opens it", (await paneState(p)).open.payments, true);
  await openThread(cases[1][1].id);
  is("…and it is still open on the NEXT conversation", (await paneState(p)).open.payments, true);
  await p.reload({ waitUntil: "domcontentloaded" });
  await settle();
  is("…and after a reload", (await paneState(p)).open.payments, true);
  const key = await p.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith("crm:pane:sections:")));
  console.log(`     storage keys: ${JSON.stringify(key)}`);
  yes("the preference is keyed on the operator", key.length === 1 && key[0] !== "crm:pane:sections:anon", JSON.stringify(key));
  // ANOTHER OPERATOR DOES NOT INHERIT IT: a different key means a different pane.
  const other = await p.evaluate((k) => { const id = k.replace("crm:pane:sections:", ""); return `crm:pane:sections:${id}x`; }, key[0]);
  is("…so a second operator reads a different key", await p.evaluate((k) => window.localStorage.getItem(k), other), null);
  await p.click('[data-testid="ctx-toggle-payments"]');   // leave it as we found it

  // ---- 6. one request per thread switch ----
  const seen = [];
  p.on("request", (r) => { if (/\/api\/(crm\/threads\/[^/]+\/context|lookup\/production\?id)/.test(r.url())) seen.push(r.url().replace(BASE, "")); });
  await openThread(cases[cases.length - 1][1].id);
  const contexts = seen.filter((u) => u.includes("/context"));
  const lookups = seen.filter((u) => u.includes("/api/lookup"));
  console.log(`     one switch fired: ${contexts.length} context, ${lookups.length} lookup`);
  is("the pane fetches NO separate /api/lookup for the profile", lookups, []);
  yes("…and only the context route, once per mount (React StrictMode double-invokes effects in dev)",
    contexts.length <= 2 && new Set(contexts).size === 1, JSON.stringify(contexts));

  // ---- 7. the breakpoint and the toggle ----
  const wide = await p.$eval('[data-testid="ctx-pane"]', (e) => Math.round(e.getBoundingClientRect().width));
  is("the pane is 392px wide", wide, 392);
  await p.setViewportSize({ width: 1259, height: 1000 });
  await p.waitForTimeout(300);
  const hidden = await p.$eval('[data-testid="ctx-pane"]', (e) => getComputedStyle(e).display);
  is("…and is hidden one pixel below the 1260 breakpoint", hidden, "none");
  await p.setViewportSize({ width: 1600, height: 1050 });
  await p.waitForTimeout(300);
  is("…and comes back above it", await p.$eval('[data-testid="ctx-pane"]', (e) => getComputedStyle(e).display), "flex");

  // ---- 8. the credit adjustment's guards, without spending anything ----
  await openThread(cases[0][1].id);
  await p.click('[data-testid="ctx-toggle-credits"]');
  await p.waitForSelector('[data-testid="ctx-credit"]', { timeout: 20000 });
  const applyDisabled = () => p.$eval('[data-testid="ctx-credit-apply"]', (e) => e.disabled);
  is("Apply starts disabled", await applyDisabled(), true);
  await p.fill('[data-testid="ctx-credit-amount"]', "25");
  await p.waitForTimeout(150);
  is("…still disabled with an amount but no reason", await applyDisabled(), true);
  /* THE REASON ERROR IS SUPPRESSED UNTIL THE FIELD HAS BEEN TOUCHED, deliberately: Player Lookup's
   * panel opened with "A reason is required" already in red and Apply greyed, which is what a
   * REFUSAL looks like, and it was reported as credits being broken. The hint in the placeholder
   * says it before you start. So the message is expected only after the field has been visited —
   * which is what this now checks, in both directions. */
  const errsBefore = await p.$$eval('[data-testid="ctx-credit-error"]', (els) => els.map((e) => e.textContent.trim()));
  is("no red on an untouched reason field — a refusal on arrival reads as broken", errsBefore, []);
  await p.click('[data-testid="ctx-credit-reason"]');
  await p.click('[data-testid="ctx-credit-amount"]');
  await p.waitForTimeout(150);
  const errs = await p.$$eval('[data-testid="ctx-credit-error"]', (els) => els.map((e) => e.textContent.trim()));
  yes("…and once you have been in it, it says a reason is required", errs.some((e) => /reason/i.test(e)), JSON.stringify(errs));
  await p.fill('[data-testid="ctx-credit-reason"]', "verification only, not applied");
  await p.waitForTimeout(150);
  is("…and becomes enabled once both are given", await applyDisabled(), false);
  const sentence = await p.$eval('[data-testid="ctx-credit-sentence"]', (e) => e.textContent.trim());
  console.log(`     consequence: ${JSON.stringify(sentence)}`);
  yes("…stating the consequence before the click", /\$/.test(sentence), sentence);
  await p.fill('[data-testid="ctx-credit-amount"]', "250");
  await p.waitForTimeout(150);
  is("$250 is refused — the cap is $200", await applyDisabled(), true);
  const capErr = await p.$$eval('[data-testid="ctx-credit-error"]', (els) => els.map((e) => e.textContent.trim()));
  yes("…and says so", capErr.some((e) => /200/.test(e)), JSON.stringify(capErr));
  await p.fill('[data-testid="ctx-credit-amount"]', "");
  await p.fill('[data-testid="ctx-credit-reason"]', "");
  await p.click('[data-testid="ctx-toggle-credits"]');

  // ---- 10 & 11. search finds four ways, says why, and links nothing ----
  const { data: someone } = await svc.from("mdapi_users").select("id, first_name, last_name, email, phone_number")
    .not("phone_number", "is", null).not("email", "is", null).eq("id", cases[0][1].player_id).maybeSingle();
  const before = await svc.from("crm_threads").select("player_id").eq("id", cases[0][1].id).single();
  const search = async (term) => {
    await p.fill('[data-testid="ctx-search-input"]', "");
    await p.fill('[data-testid="ctx-search-input"]', term);
    await p.waitForTimeout(1200);
    return p.evaluate(() => [...document.querySelectorAll('[data-testid^="ctx-search-result-"]')].map((e) => ({
      id: Number(e.dataset.testid.replace("ctx-search-result-", "")),
      reason: e.querySelector('[data-testid="ctx-search-reason"]')?.dataset.reason ?? null,
      label: e.querySelector('[data-testid="ctx-search-reason"]')?.textContent?.trim() ?? null,
    })));
  };
  const openSearch = await p.$('[data-testid="ctx-search-open"]');
  if (openSearch) await openSearch.click();
  await p.waitForSelector('[data-testid="ctx-search-input"]', { timeout: 20000 });
  for (const [what, term, wantReason] of [
    ["a full phone", someone.phone_number, "phone"],
    ["the last seven digits", String(someone.phone_number).slice(-7), "last7"],
    ["an email", someone.email, "email"],
    ["a name", `${someone.first_name} ${someone.last_name}`, "name"],
  ]) {
    const rows = await search(term);
    const mine = rows.find((r) => r.id === someone.id);
    console.log(`     ${what} → ${rows.length} result(s); ours: ${JSON.stringify(mine)}`);
    yes(`search finds the player by ${what}`, Boolean(mine), JSON.stringify(rows.slice(0, 3)));
    if (mine) is(`…and says it matched on ${wantReason}`, mine.reason, wantReason);
  }
  const note = await p.$eval('[data-testid="ctx-search-note"]', (e) => e.textContent.trim());
  yes("the pane says looking up is not linking", /does not link/i.test(note), note);
  const after = await svc.from("crm_threads").select("player_id").eq("id", cases[0][1].id).single();
  is("searching left crm_threads.player_id untouched", after.data.player_id, before.data.player_id);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
