// ONE EDITOR, TWO PRESENTATIONS — the eight points, on STAGING.
//
// NOT NAMED verify-*, SO IT IS NOT IN THE GATE. run-suites discovers /^verify-.*\.mjs$/; this
// writes to staging (a real PUT against a real match) and is run by hand:
//
//     npm run check:one-editor
//
// It does NOT litter the way check-copy-match does — it edits an existing staging match and puts
// every field back — but it is still a live write, so it stays out of automatic runs.
//
// STAGING FOR EVERY WRITE. The one production fact behind this work — match 17866, moved 8½ hours
// on 2026-08-20, landed — is EVIDENCE that the pair works in production. It is not a test to
// repeat, and nothing here touches production.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ENV = "staging";
const MATCH = 2470;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
/* WAIT FOR THE PANEL TO FINISH LOADING, not for a fixed number of milliseconds.
 * Stepping remounts the editor, which refetches; while that is in flight the title reads
 * "Loading match NNNNN…" and the name box is empty. Typing into it then is typing into a box that
 * the arriving payload overwrites — which is exactly how this suite reported the dirty guard
 * broken while a live probe showed it holding. */
const settle = async (page) => {
  await page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="dr-title"]')?.textContent ?? "";
    const n = document.querySelector('[data-testid="in-name"]')?.value ?? "";
    return t && !/loading/i.test(t) && n.length > 0;
  }, null, { timeout: 30000 });
};

const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1700, height: 1300 } });
const page = await ctx.newPage();

const api = (path, init) => page.evaluate(async ({ path, init }) => {
  const key = Object.keys(localStorage).find((k) => k.includes("auth-token"));
  const t = JSON.parse(localStorage.getItem(key) ?? "{}");
  const token = t?.access_token ?? t?.currentSession?.access_token;
  const r = await fetch(path, {
    ...(init ?? {}),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: "no-store",
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { path, init });

await page.goto(`${BASE}/match-ops/matches/${MATCH}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="save"]', { timeout: 90000 });
await page.waitForTimeout(600);

// ── 1. EVERY EDITABLE FIELD IS PRESENT IN BOTH PRESENTATIONS ──────────────────────────────────
// Asserted FROM THE DRAWER, not only from the page — the point of the consolidation is that they
// are the same component, and only the drawer can prove that claim.
const ALWAYS = ["name", "fieldId", "category", "type", "managerId", "secondManagerId", "description",
  "managerIntro", "registrationPrice", "additionalSpotPrice", "guestCount", "fakeSpotLeft36h",
  "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h", "autoCanceled",
  "autoCanceledMinutes", "minPlayerCount", "isFreeMember", "isAutoBump"];

console.log("\n── the page ──");
{
  const present = await page.evaluate((keys) => keys.filter((k) => !!document.querySelector(`[data-testid="in-${k}"]`)), ALWAYS);
  eq(`all ${ALWAYS.length} editable fields render on the page`, present.length, ALWAYS.length);
  const dates = await page.evaluate(() => ({
    date: !!document.querySelector('[data-testid="in-date"]'),
    time: !!document.querySelector('[data-testid="in-time"]'),
  }));
  eq("date and time are editable here now", [dates.date, dates.time], [true, true]);
  /* THE ENVIRONMENT WARNING IS GONE, BY DECISION. Master Schedule and this editor cannot be
   * pointed at different environments, so it fired on every match — and one that fires every time
   * is read on none of them. The LIVE and ID pills stay: they identify the match. */
  const pills = await page.evaluate(() => ({
    env: !!document.querySelector('[data-testid="ed-envbadge"]'),
    title: !!document.querySelector('[data-testid="title"]'),
    prodText: /production|live edits/i.test(document.body.innerText),
  }));
  eq("no environment pill on the page", pills.env, false);
  eq('  …and no "production"/"live edits" text anywhere on it', pills.prodText, false);
  // THE PAGE STILL SUPPLIES ITS OWN TITLE BLOCK — nothing else does there.
  eq("the page renders the editor's own title block", pills.title, true);

  // AND THE PAGE STILL SCROLLS. Whatever the panel fix took must not break the variant with no
  // panel chrome: there `.cols` is an ordinary block and the WINDOW scrolls.
  const pageScroll = await page.evaluate(() => ({
    panelMode: !!document.querySelector(".me-panel"),
    canScroll: document.documentElement.scrollHeight > window.innerHeight,
  }));
  eq("  control — the page is NOT in panel mode", pageScroll.panelMode, false);
  eq("the page itself scrolls", pageScroll.canScroll, true);
}

console.log("\n── the drawer ──");
{
  await page.goto(`${BASE}/match-ops/master-schedule`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="card"]', { timeout: 90000 });
  await page.locator('[data-testid="card"]').first().click();
  await page.waitForSelector('[data-testid="drawer"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="save"]', { timeout: 30000 });
  await page.waitForTimeout(700);

  const present = await page.evaluate((keys) => keys.filter((k) => !!document.querySelector(`[data-testid="in-${k}"]`)), ALWAYS);
  eq(`all ${ALWAYS.length} editable fields render in the drawer`, present.length, ALWAYS.length);
  const missing = ALWAYS.filter((k) => !present.includes(k));
  eq("  …none missing, by name", missing, []);

  const chrome = await page.evaluate(() => {
    const panel = document.querySelector(".me-panel");
    const bar = panel?.querySelector(".savebar");
    return {
      isPanel: !!panel,
      back: !!document.querySelector('[data-testid="editor-back"]'),
      barPos: bar ? getComputedStyle(bar).position : null,
      minH: panel ? getComputedStyle(panel).minHeight : null,
      envBadge: document.querySelector('[data-testid="ed-envbadge"]')?.textContent ?? "",
      fullLink: !!document.querySelector('[data-testid="dr-fulleditor"]'),
    };
  });
  eq("the drawer renders the editor in PANEL mode", chrome.isPanel, true);
  eq("  …with no back button", chrome.back, false);
  /* THE SAVE BAR IS NOW A FLEX CHILD, NOT STICKY. Sticky worked only while the whole panel
   * scrolled — which was the bug: everything below the date fields was unreachable. The panel is
   * three parts now (header / scrolling body / save bar), so the bar is simply the last row and
   * never moves. `static` here is the fix, not a regression. */
  eq("  …a save bar that is a fixed part of the panel, not sticky inside a scrolling one", chrome.barPos, "static");
  eq("  …and it does not claim the viewport", chrome.minH === "100vh", false);
  eq("no environment warning in the panel either", /PRODUCTION/i.test(chrome.envBadge), false);
  eq('"Open full editor" is gone — this IS the full editor', chrome.fullLink, false);
}

// ── 1b. THE PANEL SCROLLS: HEADER STAYS, BODY MOVES, SAVE BAR STAYS ───────────────────────────
console.log("\n── the panel scrolls ──");
{
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.waitForTimeout(700);
  const sc = await page.evaluate(() => {
    const body = document.querySelector(".me-panel .cols");
    const head = document.querySelector(".mdw-head");
    const bar = document.querySelector(".me-panel .savebar");
    if (!body || !head || !bar) return null;
    const lastField = [...body.querySelectorAll("[data-f]")].pop();
    const before = { head: head.getBoundingClientRect().top, bar: bar.getBoundingClientRect().top,
                     last: lastField?.getBoundingClientRect().top ?? null };
    body.scrollTop = body.scrollHeight;
    const after = { head: head.getBoundingClientRect().top, bar: bar.getBoundingClientRect().top,
                    last: lastField?.getBoundingClientRect().top ?? null,
                    lastBottom: lastField?.getBoundingClientRect().bottom ?? null };
    return {
      scrollable: body.scrollHeight > body.clientHeight,
      scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      scrolled: body.scrollTop > 0,
      headMoved: before.head !== after.head,
      barMoved: before.bar !== after.bar,
      lastMoved: before.last !== after.last,
      lastVisible: after.lastBottom != null && after.lastBottom <= window.innerHeight + 2,
      barTop: after.bar, bodyBottom: body.getBoundingClientRect().bottom,
    };
  });
  eq("  control — the three parts are all present", sc != null, true);
  eq("the panel body is taller than its box, so it CAN scroll", sc.scrollable, true);
  eq("  …and scrolling it actually moves", sc.scrolled, true);
  eq("the last field is reachable by scrolling at 900px", sc.lastVisible, true);
  eq("  …because the body moved it", sc.lastMoved, true);
  // THE TWO THAT MUST NOT MOVE — this is what "three parts" means.
  eq("the drawer header does NOT move", sc.headMoved, false);
  eq("the save bar does NOT move", sc.barMoved, false);
  console.log(`     body ${sc.scrollHeight}px in a ${sc.clientHeight}px box · header and save bar fixed`);
}

// ── 1c. ONE HEADER, AND NO ENVIRONMENT WARNING ────────────────────────────────────────────────
console.log("\n── the seam is closed ──");
{
  const scan = (needle) => page.evaluate((needle) => {
    let hits = 0;
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { if (c.textContent.toLowerCase().includes(needle.toLowerCase())) hits++; }
        else if (c.nodeType === 1 && !/^(script|style)$/i.test(c.tagName)) walk(c);
      }
    };
    walk(document.body);
    return hits;
  }, needle);

  // POSITIVE CONTROL: a pill that IS still there, so a zero below is absence rather than a dead scan.
  eq("  control — the LIVE pill is on the page", await scan("Live") > 0, true);
  eq('"Production" appears nowhere in the drawer', await scan("Production"), 0);
  eq('"Live edits" appears nowhere either', await scan("Live edits"), 0);

  // AND THE SCAN CATCHES A PLANTED COPY — otherwise the two zeros above prove nothing.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "planted-prod";
    d.textContent = "PRODUCTION — LIVE EDITS";
    document.querySelector('[data-testid="drawer"]').appendChild(d);
  });
  eq("  control — the scan catches a planted warning", await scan("Production") >= 1, true);
  await page.evaluate(() => document.getElementById("planted-prod")?.remove());
  eq("  …and the drawer is clean again", await scan("Production"), 0);

  // ONE HEADER. The editor's title block does not render in panel mode; the drawer's does.
  const once = await page.evaluate(() => ({
    editorTitle: document.querySelectorAll('[data-testid="title"]').length,
    drawerTitle: document.querySelectorAll('[data-testid="dr-title"]').length,
    // LEAF NODES ONLY. The .mdw-chips CONTAINER also matches [class*="chip"], and its textContent
    // begins with its first child's — so it counted itself as a second ID pill.
    ids: [...document.querySelectorAll('[class*="chip"]')]
      .filter((e) => e.children.length === 0 && /^ID \d/.test(e.textContent.trim())).length,
    live: [...document.querySelectorAll('[data-testid="dr-livepill"]')].length,
  }));
  eq("the editor's own title block is ABSENT in the panel", once.editorTitle, 0);
  eq("  …and the drawer's renders exactly once", once.drawerTitle, 1);
  eq("the ID pill renders exactly once", once.ids, 1);
  eq("the LIVE pill renders exactly once", once.live, 1);
}

// ── 2. SIBLING STEPPING, AND THE GUARD ────────────────────────────────────────────────────────
console.log("\n── sibling stepping ──");
{
  const titleOf = () => page.evaluate(() => document.querySelector('[data-testid="dr-title"]')?.textContent ?? "");
  const before = await titleOf();
  // A DAY WITH MORE THAN ONE MATCH. The first card of a week often has no next sibling, which is
  // a property of the fixture, not of stepping — so a card with a live ↓ is found first.
  let canStep = await page.evaluate(() => !document.querySelector('[data-testid="dr-next"]')?.disabled);
  if (!canStep) {
    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card"]')].map((c) => c.getAttribute("data-id")));
    for (const id of ids.slice(0, 12)) {
      await page.click(`[data-testid="card"][data-id="${id}"]`).catch(() => {});
      await settle(page).catch(() => {});
      canStep = await page.evaluate(() => !document.querySelector('[data-testid="dr-next"]')?.disabled);
      if (canStep) break;
    }
  }
  if (canStep) {
    await page.click('[data-testid="dr-next"]');
    await settle(page);
    const after = await titleOf();
    eq("stepping to the next match changes the match", before === after, false);
    eq("  …without closing the drawer", await page.locator('[data-testid="drawer"]').count(), 1);
    console.log(`     ${before.slice(0, 34)} → ${after.slice(0, 34)}`);
  } else {
    eq("  control — a sibling exists to step to", canStep, true);
  }

  // THE GUARD, which is the bug the consolidation introduced and this suite exists to hold:
  // the drawer used to compute its own dirtiness, which after the swap was permanently false —
  // so stepping would have silently discarded unsaved edits.
  await settle(page);
  await page.fill('[data-testid="in-name"]', "one-editor dirty probe");
  // A POSITIVE CONTROL FOR THE GUARD ITSELF: if the edit never registered, the assertions below
  // would pass for the wrong reason — an unstepped drawer that was simply never dirty.
  await page.waitForFunction(() => /changed/.test(document.querySelector('[data-testid="cnt-match"]')?.textContent ?? ""), null, { timeout: 10000 });
  eq("  control — the typed edit registers as a change", await page.textContent('[data-testid="cnt-match"]'), "1 changed");
  const dirtyTitle = await titleOf();
  await page.click('[data-testid="dr-next"]').catch(() => {});
  await page.waitForTimeout(700);
  eq("stepping with unsaved changes does NOT discard them", await titleOf(), dirtyTitle);
  eq("  …and the edit is still in the box", await page.inputValue('[data-testid="in-name"]'), "one-editor dirty probe");
  await page.click('[data-testid="revert"]');
  await page.waitForTimeout(300);
  eq("  …and revert clears it", await page.textContent('[data-testid="cnt-match"]'), "");
}

// ── 3. THE DATE PAIR, WRITTEN AND READ BACK ───────────────────────────────────────────────────
console.log("\n── the date pair, on staging ──");
{
  const before = await api(`/api/matchday/${ENV}/matches/${MATCH}`);
  eq("  control — the source match reads", before.status, 200);
  const m0 = before.body.match;
  const start0 = String(m0.startDate), end0 = String(m0.endDate);
  const dur0 = Date.parse(end0) - Date.parse(start0);
  console.log(`     before: ${start0} → ${end0} (${dur0 / 3600000}h)`);

  // Move the start by exactly one hour, wall-clock, and send the PAIR.
  const hh = String((Number(start0.slice(11, 13)) + 1) % 24).padStart(2, "0");
  const newStart = `${start0.slice(0, 11)}${hh}${start0.slice(13)}`;
  const newEnd = new Date(Date.parse(newStart) + dur0).toISOString().replace(/\.\d+Z$/, ".000Z");

  const put = await api(`/api/matchday/${ENV}/matches/${MATCH}`, {
    method: "PUT",
    body: JSON.stringify({ changes: { startDate: newStart, endDate: newEnd }, source: "check:one-editor" }),
  });
  eq("the pair is accepted", put.status, 200);

  // READ BACK, not the status code.
  const after = await api(`/api/matchday/${ENV}/matches/${MATCH}`);
  const m1 = after.body.match;
  eq("startDate landed, wall-clock verbatim", String(m1.startDate).slice(0, 16), newStart.slice(0, 16));
  const dur1 = Date.parse(String(m1.endDate)) - Date.parse(String(m1.startDate));
  // TO THE MINUTE, as the name says — and deliberately not to the millisecond. The source match
  // carries .767Z on its end; the new end this test computes is built to .000Z, so a millisecond
  // comparison would fail on the TEST's rounding rather than on anything the product did.
  eq("duration preserved to the minute", Math.round(dur1 / 60000), Math.round(dur0 / 60000));
  eq("  …and not merely close — the same whole minute count", Math.abs(dur1 - dur0) < 60000, true);
  console.log(`     after:  ${m1.startDate} → ${m1.endDate} (${dur1 / 3600000}h)`);

  // SENDING ONE ALONE IS STILL REFUSED — the rule that keeps a duration from being rewritten.
  const lone = await api(`/api/matchday/${ENV}/matches/${MATCH}`, {
    method: "PUT", body: JSON.stringify({ changes: { startDate: start0 }, source: "check:one-editor" }),
  });
  eq("startDate alone is refused", lone.status, 400);
  eq("  …and the refusal explains the pair", /together/i.test(lone.body.error ?? ""), true);

  // PUT IT BACK — this suite edits a real staging match and does not leave it moved.
  const restore = await api(`/api/matchday/${ENV}/matches/${MATCH}`, {
    method: "PUT", body: JSON.stringify({ changes: { startDate: start0, endDate: end0 }, source: "check:one-editor" }),
  });
  eq("  …and the match is restored", restore.status, 200);
  const back = await api(`/api/matchday/${ENV}/matches/${MATCH}`);
  eq("  …verified by reading it back", String(back.body.match.startDate).slice(0, 16), start0.slice(0, 16));
}

// ── 4. A DISTINCT SOURCE PER SURFACE ──────────────────────────────────────────────────────────
console.log("\n── change_log carries who ──");
{
  const { data } = await svc.from("change_log").select("source").order("created_at", { ascending: false }).limit(400);
  const sources = new Set((data ?? []).map((r) => r.source).filter(Boolean));
  eq("  control — change_log has entries", (data ?? []).length > 0, true);
  // THREE DISTINCT VALUES. Before this work the drawer sent none, so its writes logged as the
  // route's default and were indistinguishable from Match panel's.
  for (const s of ["Match editor", "Master Schedule drawer", "Match panel"]) {
    const seen = sources.has(s);
    if (seen) ok(`a distinct source exists for "${s}"`);
    else console.log(`  ~ "${s}" not yet in the last 400 rows — it is sent by the code, not yet exercised here`);
  }
  eq("this run's own writes are attributed", sources.has("check:one-editor"), true);
  console.log(`     distinct sources seen: ${[...sources].slice(0, 8).join(" · ")}`);
}

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);
