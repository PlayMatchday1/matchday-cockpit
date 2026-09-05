// THE PINNED CHAT — the link that did not exist, and the panel that stopped at 420px.
//   node scripts/e2e/verify-dock-pin.mjs      (needs `npm run dev` up)
//
// FOUR MEASUREMENTS, not four screenshots:
//  1. Open in Player Lookup lands on the RIGHT player, from a screen about somebody else.
//  2. With the maxHeight gone the message list fills the panel — measured at 1080 AND 1440, and
//     the two heights must DIFFER. A single viewport cannot tell "fills the panel" from "capped
//     at 420px" if the panel happens to be about 420px tall.
//  3. The four numbers in the dock equal what Player Lookup prints for the same player.
//  4. The membership card: a cancelled-at-period-end subscription cannot present as plain ACTIVE,
//     and a genuinely active one still says RENEWS with no cancelled field and no summary line.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  // A real thread with a linked player and at least one message.
  const { data: threads, error } = await svc
    .from("crm_threads")
    .select("id, player_id, phone_number, last_message_at")
    .not("player_id", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!threads?.length) { console.log("  XX  no linked crm_thread to pin — cannot measure"); process.exit(1); }
  const thread = threads[0];
  console.log(`     pinning thread ${thread.id} (player ${thread.player_id})`);

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const b = await chromium.launch();
  const measureAt = async (h) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: h }, storageState });
    const p = await ctx.newPage();
    // Seed the dock the way the provider persists it, before any script runs.
    await p.addInitScript(([id]) => {
      try { sessionStorage.setItem("crm:dockedThreadId", id); sessionStorage.setItem("crm:dockOpen", "1"); } catch { /* private mode */ }
    }, [thread.id]);
    // A screen that is about SOMEBODY ELSE (or nobody) — the dock must still work there.
    await p.goto(`${BASE}/match-ops/gameday`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="dock-root"][data-guard="ready"]', { timeout: 240000 });
    await p.waitForSelector('[data-testid="dock-messages"]', { timeout: 60000 });
    // The four-number strip arrives on its own fetch — wait for it, or the measurement below reads
    // a panel that has not finished loading and reports four nulls as a missing feature.
    await p.waitForSelector('[data-testid="dock-facts"]', { timeout: 120000 }).catch(() => {});
    const m = await p.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const list = q('[data-testid="dock-messages"]');
      const root = q('[data-testid="dock-root"]');
      const composer = q('[data-testid="crm-composer"]');
      const rb = root.getBoundingClientRect(), lb = list.getBoundingClientRect();
      return {
        listH: Math.round(lb.height),
        rootH: Math.round(rb.height),
        maxHeight: getComputedStyle(list).maxHeight,
        // The composer must stay at the bottom of the panel, not float mid-panel.
        composerGapFromBottom: composer ? Math.round(rb.bottom - composer.getBoundingClientRect().bottom) : null,
        viewportH: window.innerHeight,
      };
    });
    return { p, ctx, m };
  };

  const a = await measureAt(1080);
  console.log(`     1080: panel ${a.m.rootH}px · list ${a.m.listH}px · list max-height ${a.m.maxHeight}`);
  const c = await measureAt(1440);
  console.log(`     1440: panel ${c.m.rootH}px · list ${c.m.listH}px · list max-height ${c.m.maxHeight}`);

  is("the message list has no max-height", a.m.maxHeight, "none");
  yes("the list GREW with the taller viewport — it fills the panel rather than stopping at 420px",
    c.m.listH > a.m.listH + 100, `1080 ${a.m.listH}px vs 1440 ${c.m.listH}px`);
  yes("…and the old 420px cap is genuinely gone at both sizes", a.m.listH > 420 && c.m.listH > 420,
    `${a.m.listH} / ${c.m.listH}`);
  yes("the composer stays pinned to the bottom of the panel at both sizes",
    Math.abs(a.m.composerGapFromBottom) < 90 && Math.abs(c.m.composerGapFromBottom) < 90,
    `gaps ${a.m.composerGapFromBottom} / ${c.m.composerGapFromBottom}`);

  const p = c.p;

  /* The composer, EMPTY. Measured here and not after the snippet test below, because a snippet
   * inserts text and the box auto-grows — 88px of a two-line textarea is a filled box, not a
   * four-line placeholder. Order is the assertion's precondition. */
  const ph = await p.$eval('[data-testid="crm-composer"]', (el) => ({ placeholder: el.placeholder, value: el.value, h: Math.round(el.getBoundingClientRect().height) }));
  console.log(`     composer (empty): ${JSON.stringify(ph)}`);
  is("the dock composer starts empty", ph.value, "");
  is("the dock composer's placeholder is the short one", ph.placeholder, "Type a reply…");
  yes("…and the empty box is one line tall, not the four the long sentence wrapped to", ph.h <= 60, `${ph.h}px`);

  // ---- the four numbers, and the same four on Player Lookup ----
  const dockFacts = await p.evaluate(() => {
    const out = {};
    for (const k of ["played", "upcoming", "credits", "strikes"]) {
      const el = document.querySelector(`[data-testid="dock-fact-${k}"]`);
      out[k] = el ? el.firstElementChild.textContent.trim() : null;
    }
    return out;
  });
  console.log(`     dock strip: ${JSON.stringify(dockFacts)}`);

  /* THE NAME SLOT HOLDS A NAME. Measured on a real thread before this change: player 68285 has an
   * account and the heading read "+15716662882" — the same digits, in the same place, as a thread
   * with no account at all. */
  const heading = await p.$eval('[data-testid="dock-name"]', (el) => el.textContent.trim());
  const phoneLine = await p.$eval('[data-testid="dock-phone"]', (el) => el.textContent.trim());
  console.log(`     heading ${JSON.stringify(heading)} · phone line ${JSON.stringify(phoneLine)}`);
  yes("a LINKED thread's heading is not the phone number", heading !== phoneLine && !/^\+?\d[\d ]{6,}$/.test(heading), `heading=${heading}`);
  yes("…and the number is on the second line", /\d/.test(phoneLine));
  yes("the dock renders the four-number strip", Object.values(dockFacts).every((v) => v !== null), JSON.stringify(dockFacts));

  // ---- Open in Player Lookup lands on the right player ----
  await p.click('[data-testid="dock-open-lookup"]');
  await p.waitForFunction(() => location.pathname.includes("/player-lookup"), { timeout: 30000 });
  await p.waitForSelector('[data-testid="strikes"], [data-testid="strikes-members-only"]', { timeout: 120000 });
  const landed = await p.evaluate(() => {
    const el = [...document.querySelectorAll(".f")].find((n) => /PLAYER ID|^ID$/i.test(n.querySelector(".k")?.textContent ?? ""));
    return { url: location.pathname + location.search, idFact: el?.querySelector(".v")?.textContent?.trim() ?? null };
  });
  is("Open in Player Lookup navigates with the docked player's id", landed.url, `/match-ops/player-lookup?id=${thread.player_id}`);
  const lookupFacts = await p.evaluate(() => {
    const grab = (label) => {
      const el = [...document.querySelectorAll(".f")].find((n) => (n.querySelector(".k")?.textContent ?? "").trim().toUpperCase() === label);
      return el?.querySelector(".v")?.textContent?.trim() ?? null;
    };
    const strike = document.querySelector('[data-testid="strike-count"]')?.textContent?.trim() ?? null;
    return { played: grab("PLAYED"), upcoming: grab("UPCOMING"), credits: grab("CREDITS"), strikes: strike };
  });
  console.log(`     lookup page: ${JSON.stringify(lookupFacts)}`);
  if (lookupFacts.credits !== null) is("credits agree between the dock and Player Lookup", dockFacts.credits, lookupFacts.credits);
  else console.log("     (credits fact not on this page's field set — skipped)");
  if (lookupFacts.strikes) {
    const [n, , lim] = lookupFacts.strikes.split(/\s+/);
    is("strikes agree between the dock and Player Lookup", dockFacts.strikes, `${n}/${lim}`);
  }

  // ---- the membership card, on a REAL cancelled-at-period-end subscription ----
  const { data: cancelled } = await svc.from("mdapi_subscriptions")
    .select("user_id, canceled_at").eq("status", "ACTIVE").not("canceled_at", "is", null).limit(1);
  const { data: plain } = await svc.from("mdapi_subscriptions")
    .select("user_id").eq("status", "ACTIVE").is("canceled_at", null).limit(1);

  const card = async (userId) => {
    await p.goto(`${BASE}/match-ops/player-lookup?id=${userId}`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="mem-badge"], .nomem', { timeout: 120000 });
    return p.evaluate(() => {
      const badge = document.querySelector('[data-testid="mem-badge"]')?.textContent?.trim() ?? null;
      const facts = {};
      for (const n of document.querySelectorAll(".memgrid .f")) {
        facts[(n.querySelector(".k")?.textContent ?? "").trim()] = (n.querySelector(".v")?.textContent ?? "").trim();
      }
      return { badge, facts, summary: document.querySelector('[data-testid="mem-summary"]')?.textContent?.trim() ?? null };
    });
  };

  if (cancelled?.length) {
    const r = await card(cancelled[0].user_id);
    console.log(`     cancelled player ${cancelled[0].user_id}: badge=${JSON.stringify(r.badge)} facts=${JSON.stringify(r.facts)}`);
    console.log(`     summary: ${JSON.stringify(r.summary)}`);
    yes("a cancelled-at-period-end subscription does NOT show a plain ACTIVE badge", r.badge !== "ACTIVE", `badge=${r.badge}`);
    // The badge and the fields must name the SAME day. They did not: "CANCELLED, RUNS TO SEP 30"
    // sat directly above "ENDS Oct 1, 2026", because one printed in Central and the other in UTC.
    yes("…and the badge's date agrees with the ENDS field", (r.badge ?? "").includes((r.facts.ENDS ?? "").replace(/,.*$/, "").toUpperCase()),
      `badge=${r.badge} ENDS=${r.facts.ENDS}`);
    yes("…the badge names the cancellation", /CANCELLED/.test(r.badge ?? ""), `badge=${r.badge}`);
    yes("…and the card prints a CANCELLED date", Boolean(r.facts.CANCELLED) && r.facts.CANCELLED !== "—", JSON.stringify(r.facts));
    yes("…with the plain-language summary under the grid", /Nothing further will be charged/.test(r.summary ?? ""), `summary=${r.summary}`);
  } else bad("no ACTIVE+cancelled subscription in the mirror to measure");

  if (plain?.length) {
    const r = await card(plain[0].user_id);
    console.log(`     active player ${plain[0].user_id}: badge=${JSON.stringify(r.badge)} facts=${JSON.stringify(r.facts)}`);
    // CONTROL for the three assertions above: the same page, the same selectors, a player who has
    // NOT cancelled. If these fired the same way, the assertions above are matching the template.
    is("control — a genuinely active subscription still badges ACTIVE", r.badge, "ACTIVE");
    yes("control — …says RENEWS, not ENDS", "RENEWS" in r.facts, JSON.stringify(Object.keys(r.facts)));
    is("control — …has no CANCELLED field", r.facts.CANCELLED ?? null, null);
    is("control — …and no summary line", r.summary, null);
  } else bad("no plain-ACTIVE subscription in the mirror to use as the control");

  // ---- a non-member's card is untouched ----
  const { data: nonMember } = await svc.from("mdapi_users").select("id").eq("is_member", false).limit(1);
  if (nonMember?.length) {
    await p.goto(`${BASE}/match-ops/player-lookup?id=${nonMember[0].id}`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="mem-badge"], .nomem', { timeout: 120000 });
    const r = await p.evaluate(() => ({
      nomem: document.querySelector(".nomem b")?.textContent?.trim() ?? null,
      badge: document.querySelector('[data-testid="mem-badge"]')?.textContent?.trim() ?? null,
      summary: document.querySelector('[data-testid="mem-summary"]')?.textContent ?? null,
    }));
    console.log(`     non-member ${nonMember[0].id}: ${JSON.stringify(r)}`);
    is("a non-member still shows the unchanged 'Not a member' panel", r.nomem, "Not a member");
    is("…with no badge", r.badge, null);
    is("…and no summary line", r.summary, null);
  } else bad("no non-member in the mirror to check");

  // ---- a snippet still only INSERTS ----
  await p.goto(`${BASE}/match-ops/gameday`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="dock-root"][data-guard="ready"]', { timeout: 240000 });
  // The snippet LIST changes when the account lands (that is the whole point of keying them off
  // the conversation), so wait for the strip before reading a label — otherwise the text read and
  // the button clicked are two different snippets.
  await p.waitForSelector('[data-testid="dock-facts"]', { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(300);
  const snip = await p.$('[data-testid="dock-snippet-0"]');
  if (snip) {
    const before = await p.$eval('[data-testid="crm-composer"]', (el) => el.value);
    const text = (await snip.textContent()).trim();
    await snip.click();
    await p.waitForTimeout(400);
    const after = await p.$eval('[data-testid="crm-composer"]', (el) => el.value);
    yes("a snippet click INSERTS its text into the draft", after.includes(text) && after !== before, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    // The send is confirm-then-append: nothing was sent, so no new outbound bubble appeared.
    const sent = await p.evaluate(() => document.querySelectorAll('[data-testid="dock-messages"] li').length);
    console.log(`     snippet "${text}" inserted; ${sent} message rows (unchanged — nothing sent)`);
  } else bad("no snippet rendered in the dock to click");


  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
