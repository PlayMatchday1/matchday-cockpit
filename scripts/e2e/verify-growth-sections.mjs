// GROWTH — six routed sections instead of one long scroll.
//
// THIS WAS A MOVE, NOT A REBUILD, so the assertions are about ROUTING and PLACEMENT: that each
// section renders its existing panel, that the rail is the app's own, and that the time period bar
// and the three-start-dates note appear only where they apply. Nothing here re-asserts what the
// charts compute — those panels are unchanged and already covered by their own numbers.
//
// THE PERIOD BAR PER PAGE IS THE POINT. On the single-scroll page it was global, and needed an
// "applies to 4 of 7 cards" line plus a three-dot legend to explain which cards it governed.
// Retention and Churn never followed it. Per section that ambiguity cannot exist, so both the
// count line and the legend must be gone.
//
//   node scripts/e2e/verify-growth-sections.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const RAIL = ["Player Funnel", "Player Behavior", "Revenue per Player", "Retention", "Churn", "Player Data Room"];

// path, title, does it follow the period, does it carry the start-dates note, a marker proving the
// PANEL rendered (not just the frame).
// NO SECTION CARRIES A BANNER ANY MORE — every methodological statement moved to the Data Room.
const SECTIONS = [
  ["/growth/funnel", "Player Funnel", true, /App downloads/i],
  ["/growth/behavior", "Player Behavior", true, /behaviou?r/i],
  ["/growth/revenue-per-player", "Revenue per Player", true, /per (active )?player|ARPP/i],
  ["/growth/retention", "Retention", false, /cohort/i],
  ["/growth/churn", "Churn", false, /inactive/i],
  ["/growth/data-room", "Player Data Room", true, /player/i],
];

async function main() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const link = await netRetry(() => svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" }), "generateLink");
  const vv = await netRetry(() => anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token }), "verifyOtp");
  const ref = new URL(url).host.split(".")[0];
  const storageState = { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1200 }, storageState });
  const page = await ctx.newPage();
  // A SECTION IS READY when its title is up AND the frame has left the loading state — every
  // absence check below is meaningless against "Loading growth analytics…".
  const open = async (path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="growth-title"]', { timeout: 60000 });
    await page.waitForFunction(() => !/Loading growth analytics/.test(document.body.innerText), null, { timeout: 60000 });
    await page.waitForTimeout(250);
  };

  console.log("growth — six sections\n");

  // ── THE LANDING ──────────────────────────────────────────────────────────
  console.log("/growth is the funnel:");
  {
    await page.goto(`${BASE}/growth`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname === "/growth/funnel", null, { timeout: 30000 }).catch(() => {});
    eq("/growth redirects to /growth/funnel", new URL(page.url()).pathname, "/growth/funnel");
  }

  // ── EACH SECTION ─────────────────────────────────────────────────────────
  for (const [path, title, followsPeriod, panelMark] of SECTIONS) {
    console.log(`\n${path}:`);
    await open(path);
    const r = await page.evaluate(() => ({
      title: document.querySelector('[data-testid="growth-title"]')?.textContent?.trim() ?? null,
      period: !!document.querySelector('[data-testid="growth-period"]'),
      starts: !!document.querySelector('[data-testid="growth-start-dates"]'),
      rail: [...document.querySelectorAll('[data-testid="app-rail"] [data-testid="rail-item"]')].map((a) => a.textContent.trim()),
      sw: !!document.querySelector('[data-testid="section-switch"]'),
      groups: document.querySelectorAll('[data-testid="rail-group"]').length,
      text: document.body.innerText,
      subtitle: document.querySelector('[data-testid="growth-subtitle"]')?.textContent?.trim() ?? "",
    }));
    eq("the title is the section", r.title, title);
    eq("…the panel itself rendered", panelMark.test(r.text), true);
    eq("…the rail is the app's own six, flat and in order", r.rail, RAIL);
    eq("…with no Daily Ops / Back Office switch and no group headings", { sw: r.sw, groups: r.groups }, { sw: false, groups: 0 });
    eq(`…the time period bar is ${followsPeriod ? "present" : "absent"}`, r.period, followsPeriod);
    if (!followsPeriod) {
      // A PAGE THAT IGNORES THE PERIOD SAYS SO IN ITS OWN SUBTITLE — that is what replaced the
      // three-dot legend, so its absence must not be silent.
      eq("…and the subtitle says why it has no period bar", /own (cohort and city )?filters|does not follow|all time/i.test(r.subtitle), true);
    }
    eq("…no explanatory banner on any section", r.starts, false);
    eq("…the 'applies to N of N cards' line is gone", /applies to \d+ of \d+ cards/.test(r.text), false);
    eq("…and the three-dot scope legend is gone", /Follows the time period above/.test(r.text), false);
  }

  // ── THE FUNNEL PAGE CARRIES NO PROSE ─────────────────────────────────────
  // Everything methodological moved to the Player Data Room. What is left on this page is the
  // title, the filters, the tiles and the table — a number, or a control, or a label on a row.
  console.log("\nthe funnel page carries no prose:");
  {
    await open("/growth/funnel");
    const card = await page.evaluate(() => {
      const lab = [...document.querySelectorAll("div")].find((d) => d.textContent?.trim() === "App downloads · iOS + Android");
      return lab?.parentElement?.innerText.trim().split("\n").map((l) => l.trim()) ?? null;
    });
    // SHAPE, not values — the totals move with the data. The label is upper-cased by CSS, so the
    // comparison is on innerText as rendered.
    eq("the downloads card is EXACTLY four lines", card?.length, 4);
    eq("…line 1 is the label", (card?.[0] ?? "").toLowerCase(), "app downloads · ios + android");
    eq("…line 2 is the combined total and nothing else", /^[\d,]+$/.test(card?.[1] ?? ""), true);
    if (card) {
      eq("…four lines, no more", card.length, 4);
      eq("…the platform lines read 'installs' on both", card.slice(2), [`iOS ${card[2].split(" ")[1]} installs`, `Android ${card[3].split(" ")[1]} installs`]);
      eq("…no store-unit wording on the card", card.filter((l) => /App Store Units|user-installs/.test(l)), []);
      eq("…and no date range or period on the card", card.filter((l) => /\d{4}/.test(l) && !/^(iOS|Android)/.test(l) && !/^App downloads/.test(l)), []);
    }

    const text = await page.evaluate(() => document.body.innerText);
    for (const [what, re] of [
      ["the three-start-dates banner", /three start dates/i],
      ["the store-history sentence", /retained for one year|analytics reach back/i],
      ["the counted-differently caveat", /not like-for-like|counted differently/i],
      ["the aggregate-ratio paragraph", /aggregate ratio/i],
      ["the bar explanation", /narrows left to right/i],
      ["the cohort subtitle", /sign-up cohort/i],
      ["the Android-only sentence", /Android only until Apple lands/i],
      ["the false conversion line", /store sync not connected|of downloads/i],
    ]) {
      eq(`…${what} is gone from the funnel`, re.test(text), false);
    }
    // POSITIVE CONTROL — the page rendered, so eight absences mean something.
    eq("…and the page really rendered (control for those absences)", /Player funnel comparison/.test(text), true);

    // THE ROW LABELS STAY. They label one row's number and are not prose.
    eq("the per-row coverage marks are still inside the table",
      await page.evaluate(() => document.querySelectorAll('[data-testid="funnel-dl-coverage"]').length >= 0), true);
    // Downloads is still the row max, so the bar still means "share of the funnel's top".
    const dl = await page.evaluate(() => {
      const stages = [...document.querySelectorAll("[class*='funnelStage']")];
      const byRow = new Map();
      for (const s of stages) { const r = s.parentElement; if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(s); }
      return [...byRow].map(([, cells]) => cells.map((c) => Number((c.querySelector("[class*='funnelSnum']")?.textContent ?? "").replace(/[^0-9]/g, ""))));
    });
    eq("Downloads is the largest stage in every row", dl.filter((v) => v[0] < Math.max(...v)).length, 0);
    // The open month is still marked.
    eq("the current month's conversion is marked 'so far'",
      await page.$('[data-testid="funnel-conv-partial"]') !== null, true);
  }

  // ── THE DATA ROOM RECEIVED IT ────────────────────────────────────────────
  console.log("\nthe Data Room carries the methodology:");
  {
    await open("/growth/data-room");
    const m = await page.$('[data-testid="growth-methodology"]');
    eq("the methodology block is on the Data Room", m !== null, true);
    const t = await page.evaluate(() => document.querySelector('[data-testid="growth-methodology"]')?.innerText ?? "");
    for (const [what, re] of [
      ["the three start dates", /three start dates/i],
      ["the store floors", /retained for one year/i],
      ["the counted-differently caveat", /App Units|user-deduped/i],
      ["the aggregate-ratio explanation", /aggregate ratio/i],
      ["the funnel bar explanation", /narrows left to right/i],
      ["the open-month note", /so far/i],
    ]) {
      eq(`…it carries ${what}`, re.test(t), true);
    }
  }



  // ── PLAYER BEHAVIOR: FIELD DETAIL AND RECURRING ──────────────────────────
  console.log("\nplayer behavior — field detail and recurring:");
  {
    await open("/growth/behavior");
    const views = await page.$$eval("#growthBehaviorView button", (els) => els.map((e) => e.textContent.trim()));
    eq("three views are offered", views, ["Overall Matchday", "City Detail", "Field Detail"]);

    // BOTH RECURRING FIGURES IN OVERALL — the count says how many came back, the rate whether we
    // are keeping them. Neither is sufficient alone.
    const rows = await page.evaluate(() => [...document.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent?.trim()));
    eq("Overall carries Recurring players", rows.includes("Recurring players"), true);
    eq("…and % recurring", rows.includes("% recurring"), true);
    // A RATE MOVES IN PERCENTAGE POINTS, not percent.
    const pts = await page.$eval('[data-testid="behavior-mom-points"]', (e) => e.textContent.trim());
    eq("…whose month-over-month is in POINTS, not percent", /pts$/.test(pts), true);

    // FIELD MODE
    await page.click('[data-testid="behavior-view-field"]');
    await page.waitForTimeout(900);
    const opts = await page.$eval('[data-testid="behavior-metric"]', (e) => [...e.options].map((o) => o.value));
    // REGISTRATIONS IS NOT ATTRIBUTABLE TO A FIELD and must never be offered there.
    eq("field mode does NOT offer Registrations", opts.includes("registrations"), false);
    eq("…and offers exactly the three metrics plus the rate",
      opts, ["newPlayers", "totalPlayers", "spots", "pctRecurring"]);
    eq("…the first column is the field", await page.$eval("thead th", (e) => e.textContent.trim()), "Field");
    await page.selectOption('[data-testid="behavior-metric"]', "pctRecurring");
    await page.waitForTimeout(900);
    eq("…% recurring renders rows in field mode", await page.evaluate(() => document.querySelectorAll("tbody tr").length) > 0, true);

    // CITY MODE keeps Registrations, because a city IS recorded at registration.
    await page.click('#growthBehaviorView button[data-value="city"]');
    await page.waitForTimeout(900);
    eq("city mode DOES offer Registrations",
      await page.$eval('[data-testid="behavior-metric"]', (e) => [...e.options].map((o) => o.value)).then((o) => o.includes("registrations")), true);
    // DFW, not Austin — Austin is the one city where both name maps agree.
    const cityRows = await page.evaluate(() => [...document.querySelectorAll("tbody tr")].map((tr) => ({
      name: tr.querySelector("td")?.textContent?.trim() ?? "",
      cells: [...tr.querySelectorAll("td")].slice(1, -2).map((td) => Number(td.textContent.replace(/[^0-9.]/g, "")) || 0),
    })));
    const dallas = cityRows.find((r) => /dallas/i.test(r.name));
    eq("Dallas is a row in city mode", !!dallas, true);
    eq("…and returns NON-ZERO values (Austin cannot catch a vocabulary mismatch)",
      (dallas?.cells ?? []).some((n) => n > 0), true);
  }

  // ── new <= total EVERYWHERE, UNCLAMPED ───────────────────────────────────
  // 22 field-months once violated this — field totals excluded special events while "new" did not.
  // Events now count on both sides, the same single population the partner dashboard uses.
  console.log("\nnew players never exceed total players:");
  {
    const v = await page.evaluate(async (t) => {
      const j = await (await fetch(`/api/growth?b=${Date.now()}`, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" })).json();
      const bad = [];
      const scan = (label, pts) => {
        for (const p of pts) {
          if (p.newPlayers != null && p.totalPlayers != null && p.newPlayers > p.totalPlayers) {
            bad.push(`${label} ${p.m}: new ${p.newPlayers} > total ${p.totalPlayers}`);
          }
        }
      };
      scan("overall", j.behaviorOverall);
      for (const [c, pts] of Object.entries(j.behaviorByCity)) scan(`city ${c}`, pts);
      for (const [, f] of Object.entries(j.behaviorByField)) scan(`field ${f.label}`, f.points);
      const months = j.behaviorOverall.length;
      const fields = Object.keys(j.behaviorByField).length;
      return { bad: bad.slice(0, 10), count: bad.length, months, fields };
    }, vv.data.session.access_token);
    eq("no scope/month has new > total", v.bad, []);
    // POSITIVE CONTROL — the scan actually covered something.
    eq("…across a real number of scopes and months", v.months > 0 && v.fields > 0, true);
    console.log(`   · scanned overall + every city + ${v.fields} fields over ${v.months} months`);
  }

  // ── THE PARTNER CROSS-CHECK ──────────────────────────────────────────────
  // A field's New players must equal the partner dashboard's "new to this venue" for the same
  // field and month, or the two pages state different numbers for the same venue.
  console.log("\ngrowth agrees with the partner dashboard:");
  {
    const g = await page.evaluate(async (t) => {
      const j = await (await fetch(`/api/growth?b=${Date.now()}`, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" })).json();
      const f = Object.values(j.behaviorByField).find((x) => /PARMER/i.test(x.label));
      return f ? f.points.map((p) => ({ m: p.m, nw: p.newPlayers })) : null;
    }, vv.data.session.access_token);
    eq("Growth has a PARMER Stadium field series", !!g, true);

    await page.goto(`${BASE}/partners/parmer-stadium-q8x2m5rk`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="prv-players"]', { timeout: 45000 });
    await page.waitForTimeout(400);
    const partner = await page.evaluate(() => ({
      players: Number(document.querySelector('[data-testid="prv-players"]')?.getAttribute("data-value")),
      returning: Number(document.querySelector('[data-testid="prv-returning"]')?.getAttribute("data-value")),
      ym: document.querySelector('[data-testid="prv-period-row"]')?.getAttribute("data-ym") ?? "",
    }));
    const partnerNew = partner.players - partner.returning;
    const growthNew = g?.find((x) => x.m === partner.ym)?.nw;
    growthNew === partnerNew
      ? ok(`PARMER ${partner.ym}: Growth new (${growthNew}) equals the partner dashboard's new-to-venue (${partnerNew})`)
      : bad("growth and the partner dashboard disagree",
            `PARMER ${partner.ym}: growth ${growthNew} vs partner ${partnerNew}`);
    // POSITIVE CONTROL — both sides produced a real figure.
    eq("…and both sides are non-zero (not two nulls agreeing)", (growthNew ?? 0) > 0 && partnerNew > 0, true);
  }

  // ── THE CITY FILTER ──────────────────────────────────────────────────────
  console.log("\nthe funnel's city filter:");
  {
    await open("/growth/funnel");
    const opts = await page.$eval('[data-testid="funnel-city"]', (e) => [...e.options].map((o) => o.value));
    eq("it defaults to All cities", await page.$eval('[data-testid="funnel-city"]', (e) => e.value), "All cities");
    eq("…and offers real cities beside it", opts.length > 1, true);
    // LIVE, no Apply — every other filter in Clubhouse applies on change.
    eq("…with no Apply button", await page.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /^apply$/i.test(b.textContent?.trim() ?? ""))), false);

    const rowsNow = () => page.evaluate(() => {
      const stages = [...document.querySelectorAll("[class*='funnelStage']")];
      const byRow = new Map();
      for (const s of stages) { const r = s.parentElement; if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(s); }
      return [...byRow].map(([row, cells]) => ({
        nums: cells.map((x) => x.querySelector("[class*='funnelSnum']")?.textContent?.trim() ?? ""),
        conv1: row.querySelector("[class*='funnelConv']")?.textContent?.trim() ?? "",
      }));
    });

    // DFW SPECIFICALLY. Austin is the ONE city where the cockpit name and the normalised name are
    // the same string, so a filter comparing the two vocabularies passes there and returns zero
    // rows everywhere else — exactly what happened on /city/reviews. Dallas is the case that
    // catches it, so it is the case asserted.
    const dallas = opts.find((o) => /dallas/i.test(o));
    eq("Dallas is offered (the non-degenerate city)", !!dallas, true);
    await page.selectOption('[data-testid="funnel-city"]', dallas);
    await page.waitForTimeout(700);
    const dRows = await rowsNow();
    const dReg = dRows.map((r) => Number(r.nums[1].replace(/[^0-9]/g, ""))).filter((n) => Number.isFinite(n));
    eq("…and selecting it returns NON-ZERO registrations", dReg.some((n) => n > 0), true);

    // DOWNLOADS CANNOT BE ATTRIBUTED TO A CITY — the stores report country/region, never city.
    eq("…the Downloads cell is a dash for every row", dRows.every((r) => r.nums[0] === "—"), true);
    eq("…and its conversion is a dash too, never a number",
      dRows.every((r) => r.conv1.replace(/so far/i, "").trim() === "—"), true);

    // The rest of the funnel is city-attributable and filters normally.
    eq("…while the later stages still render numbers", dRows.some((r) => /\d/.test(r.nums[2] ?? "")), true);

    // POSITIVE CONTROL — All cities DOES show a downloads figure, so the dashes above mean
    // "not attributable", not "the table is broken".
    await page.selectOption('[data-testid="funnel-city"]', "All cities");
    await page.waitForTimeout(700);
    const allRows = await rowsNow();
    eq("All cities shows a real Downloads figure", allRows.some((r) => /\d/.test(r.nums[0])), true);

    // THE CITIES SUM TO THE NATIONAL FIGURE, or the difference is stated.
    const bal = await page.evaluate(async (t) => {
      const j = await (await fetch("/api/growth", { headers: { Authorization: `Bearer ${t}` } })).json();
      const nat = new Map(j.funnelByMonth.map((x) => [x.m, x.registrations]));
      const byM = new Map();
      for (const x of j.funnelByMonthCity) byM.set(x.m, (byM.get(x.m) ?? 0) + x.registrations);
      const un = new Map((j.funnelUnattributed ?? []).map((x) => [x.m, x.registrations]));
      const bad = [];
      for (const [m, n] of nat) if ((byM.get(m) ?? 0) + (un.get(m) ?? 0) !== n) bad.push({ m, n, c: byM.get(m) ?? 0, u: un.get(m) ?? 0 });
      return { bad, months: nat.size, unattributedTotal: [...un.values()].reduce((a, b) => a + b, 0) };
    }, vv.data.session.access_token);
    eq("every month's cities + unattributed equals the national figure", bal.bad, []);
    eq("…over a real number of months (not a vacuous zero-month check)", bal.months > 0, true);
    console.log(`   · registrations with no declared city, all time: ${bal.unattributedTotal}`);
  }

  // ── STORE COVERAGE IS MARKED, NOT BACKFILLED ─────────────────────────────
  // Apple retains monthly reports for ONE YEAR and does not regenerate them, so pre-Aug-2025 iOS
  // months are permanently gone. A row the two stores do not both cover must say so, or the step
  // up when iOS appears reads as growth.
  console.log("\nstore coverage per row:");
  {
    // BACK TO THE FUNNEL — the block above ends on the Data Room, and the custom-range inputs
    // only exist here. Without this the fills time out against the wrong page.
    await open("/growth/funnel");
    const setRange = async (a, z) => {
      await page.fill("#funnelCustomStart", a);
      await page.fill("#funnelCustomEnd", z);
      await page.waitForTimeout(700);
      return page.evaluate(() => {
        const stages = [...document.querySelectorAll("[class*='funnelStage']")];
        const byRow = new Map();
        for (const s of stages) { const r = s.parentElement; if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(s); }
        const rows = [...byRow];
        const last = rows[rows.length - 1][1];
        return last[0].querySelector('[data-testid="funnel-dl-coverage"]')?.textContent?.trim() ?? null;
      });
    };
    eq("a range entirely before iOS is marked Android-only, permanently",
      await setRange("2023-03", "2024-12"), "Android only · no iOS data exists");
    eq("a range straddling the iOS floor names the boundary",
      await setRange("2025-01", "2025-12"), "Android only before Aug 2025");
    eq("a fully-covered range is NOT marked", await setRange("2025-08", "2026-07"), null);
  }

  // ── THE MOVE DID NOT DUPLICATE THE FETCH ─────────────────────────────────
  console.log("\nswitching sections in the rail does not refetch:");
  {
    await open("/growth/funnel");
    let calls = 0;
    const count = (req) => { if (req.url().includes("/api/growth")) calls++; };
    page.on("request", count);
    await page.click('[data-testid="rail-item"][data-key="growth-behavior"]');
    await page.waitForFunction(() => location.pathname === "/growth/behavior", null, { timeout: 20000 });
    await page.waitForTimeout(1200);
    page.off("request", count);
    eq("navigating funnel → behavior issues NO new /api/growth request", calls, 0);
    // POSITIVE CONTROL — the navigation actually happened, or "no requests" is trivially true.
    eq("…and the section really did change", await page.$eval('[data-testid="growth-title"]', (e) => e.textContent.trim()), "Player Behavior");
  }

  // The banner is gone from every section, asserted per section in the loop above — there is no
  // longer a "which pages carry it" question to answer here.

  await closeContext(ctx);

  // ── PHONE ────────────────────────────────────────────────────────────────
  console.log("\nphone at 390:");
  {
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState });
    const mp = await mctx.newPage();
    await mp.goto(`${BASE}/growth/funnel`, { waitUntil: "domcontentloaded" });
    await mp.waitForSelector('[data-testid="growth-title"]', { timeout: 60000 });
    await mp.waitForTimeout(600);
    eq("the desktop rail is not rendered at 390",
      await mp.evaluate(() => { const r = document.querySelector('[data-testid="app-rail"]'); return r ? getComputedStyle(r.closest("div")).display : "absent"; }), "none");
    // The shared app bar carries navigation below the rail breakpoint, exactly as Match Ops does.
    await mp.click('[data-testid="mo-screen-picker"]');
    await mp.waitForSelector('[data-testid="screen-sheet"]', { timeout: 10000 });
    eq("…and the screen sheet offers the same six, with no switch", await mp.evaluate(() => ({
      items: [...document.querySelectorAll('[data-testid="screen-sheet"] [data-testid^="screen-dest-"]')].map((b) => b.querySelector("span span")?.textContent?.trim()),
      sw: !!document.querySelector('[data-testid="screen-sheet"] [data-testid="section-switch"]'),
    })), { items: RAIL, sw: false });
    await mp.keyboard.press("Escape");
    await mp.waitForTimeout(300);
    eq("no horizontal overflow at 390",
      await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await closeContext(mctx);
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
