// CITY P&L — the row is a running calculation, and it has to actually calculate.
//
// The rebuild's whole claim is that a reader can check any cell against its neighbours:
//
//     DPP + Member = TOTAL REV  −  Field cost  =  Field net  −  Overhead  =  Net P&L
//
// So the assertions are arithmetic, read off the RENDERED cells rather than recomputed from the
// library — a table that computes correctly and prints the wrong column has still lied. Every
// figure below is parsed back out of the DOM.
//
// FIELD NET CHANGED MEANING in this rebuild (Total rev − Field cost, was DPP − Field cost), which
// is exactly the kind of change that silently stops chaining. The chain assertions are what pin
// it, on every row and on the footer.
//
// ALIGNMENT IS THE ORIGINAL COMPLAINT and it is asserted geometrically: every column's cells must
// share ONE right edge across the header, every body row, the pitch rows and the footer. A fixed
// colgroup makes that true; anything that reintroduces content sizing breaks it here first.
//
//   node scripts/e2e/verify-citypnl.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { netRetry, installHarnessGuard, fatal, closeContext, closeBrowser } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const PATH = "/admin/finance/cities";

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const near = (n, got, want, tol) =>
  (got != null && want != null && Math.abs(got - want) <= tol ? ok(n) : bad(n, `got ${got} want ${want} ±${tol}`));

// "−$1,611" / "$0" / "—" → number | null. The minus is U+2212, not a hyphen.
const money = (t) => {
  if (t == null) return null;
  const s = String(t).trim();
  if (!/\d/.test(s)) return null;
  const neg = /^[−-]/.test(s);
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};
const pct = (t) => {
  if (t == null || !/\d/.test(t)) return null;
  const neg = /^[−-]/.test(t.trim());
  const n = parseFloat(t.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

const HEAD = ["City", "DPP rev", "Member rev", "Total rev", "Field cost", "Field net", "Overhead", "Net P&L", "Margin"];
// column index → meaning
const C = { CITY: 0, DPP: 1, MEMB: 2, TOTAL: 3, COST: 4, FNET: 5, OH: 6, NET: 7, MAR: 8 };

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
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1300 }, storageState });
  const page = await ctx.newPage();

  // BOTH LAYOUTS ARE ALWAYS RENDERED — the table and the phone cards are both in the DOM, and CSS
  // decides which is painted. So the ready signal is width-appropriate, and every query below that
  // could match either one filters on ACTUAL visibility rather than on presence.
  const open = async (width = 1560) => {
    await page.goto(`${BASE}${PATH}`, { waitUntil: "domcontentloaded" });
    const sel = width < 900 ? '[data-testid="citypnl-card"]' : '[data-testid="citypnl-row"]';
    await page.waitForSelector(sel, { timeout: 180000 });
    await page.waitForTimeout(300);
  };

  console.log("city p&l — the row is a running calculation\n");
  await open(1560);

  // ── STRUCTURE ────────────────────────────────────────────────────────────
  console.log("the columns:");
  {
    const head = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="citypnl-table"] thead th')].map((h) => h.textContent.trim()));
    eq("the nine columns, in order", head, HEAD);
    const t = await page.evaluate(() => document.body.innerText);
    eq("COST GAP appears nowhere", /cost gap/i.test(t), false);
  }

  // ── THE CHAIN, ON EVERY ROW ──────────────────────────────────────────────
  console.log("\nevery row chains:");
  const readRows = () => page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((tr) => [...tr.querySelectorAll("td")].map((c) => c.textContent.trim())),
    '[data-testid="citypnl-row"]');

  const rows = await readRows();
  eq("there are city rows to check", rows.length > 0, true);
  for (const r of rows) {
    const name = r[C.CITY].replace(/[▸▾]/g, "").replace(/^\d+/, "").trim();
    const dpp = money(r[C.DPP]), memb = money(r[C.MEMB]), total = money(r[C.TOTAL]);
    const cost = money(r[C.COST]), fnet = money(r[C.FNET]), oh = money(r[C.OH]), net = money(r[C.NET]);
    near(`${name}: total = dpp + member`, total, dpp + memb, 2);
    // cost and overhead render NEGATIVE, so the chain adds them.
    near(`${name}: field net = total − field cost`, fnet, total + cost, 2);
    near(`${name}: net = field net − overhead`, net, fnet + oh, 2);
    near(`${name}: margin = net ÷ total`, pct(r[C.MAR]), total ? (net / total) * 100 : 0, 1.2);
  }

  // ── THE FOOTER IS THE SUM OF ITS COLUMN ──────────────────────────────────
  console.log("\nthe footer sums each column:");
  {
    const tot = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="citypnl-total-row"] td')].map((c) => c.textContent.trim()));
    for (const [idx, label] of [[C.DPP, "DPP rev"], [C.MEMB, "Member rev"], [C.TOTAL, "Total rev"],
                                [C.COST, "Field cost"], [C.FNET, "Field net"], [C.OH, "Overhead"], [C.NET, "Net P&L"]]) {
      const sum = rows.reduce((a, r) => a + (money(r[idx]) ?? 0), 0);
      near(`…${label}`, money(tot[idx]), sum, 2.5);
    }
    // And the footer chains too.
    const total = money(tot[C.TOTAL]), cost = money(tot[C.COST]), fnet = money(tot[C.FNET]);
    const oh = money(tot[C.OH]), net = money(tot[C.NET]);
    near("…and the footer itself chains", net, total + cost + oh, 2.5);
    near("…its margin is net ÷ total", pct(tot[C.MAR]), (net / total) * 100, 1.2);
    near("…its field net is total − field cost", fnet, total + cost, 2.5);
  }

  // ── COLOUR BY SIGN ───────────────────────────────────────────────────────
  console.log("\nNet P&L has one colour per sign:");
  {
    const marks = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('[data-testid="citypnl-net"], [data-testid="citypnl-total-net"]')]
        .filter((c) => c.getBoundingClientRect().width > 0);
      return cells.map((c) => ({ text: c.textContent.trim(), colour: getComputedStyle(c).color }));
    });
    const pos = [...new Set(marks.filter((m) => !/^−/.test(m.text)).map((m) => m.colour))];
    const neg = [...new Set(marks.filter((m) => /^−/.test(m.text)).map((m) => m.colour))];
    eq("positives share exactly one colour", pos.length, 1);
    eq("negatives share exactly one colour", neg.length, 1);
    eq("…and the two differ", pos[0] !== neg[0], true);
    // POSITIVE CONTROL: both signs must actually be present, or "one colour" is vacuous.
    eq("both signs are on screen", pos.length === 1 && neg.length === 1, true);
  }

  // ── ALIGNMENT: ONE RIGHT EDGE PER COLUMN ─────────────────────────────────
  // The original complaint, asserted geometrically rather than by eye.
  console.log("\nevery column shares one right edge:");
  {
    const edges = await page.evaluate(() => {
      const tbl = document.querySelector('[data-testid="citypnl-table"]');
      const trs = [tbl.querySelector("thead tr"), ...tbl.querySelectorAll("tbody tr"), tbl.querySelector("tfoot tr")];
      const byCol = {};
      for (const tr of trs) {
        if (!tr) continue;
        const cells = [...tr.children];
        // Skip the full-width spanning rows (sub-headings, overhead, notes) — they have no columns.
        if (cells.length !== 9) continue;
        cells.forEach((c, i) => {
          (byCol[i] ??= []).push(Math.round(c.getBoundingClientRect().right));
        });
      }
      return byCol;
    });
    const drift = Object.entries(edges)
      .map(([i, xs]) => ({ i: Number(i), spread: Math.max(...xs) - Math.min(...xs), n: xs.length }))
      .filter((d) => d.spread > 1);
    eq("no column's right edge drifts more than 1px", drift, []);
    eq("…measured across header, body and footer", Object.values(edges)[0].length >= 3, true);
  }

  console.log("\nnumeric cells use tabular numerals:");
  {
    const bad = await page.evaluate(() => {
      const tbl = document.querySelector('[data-testid="citypnl-table"]');
      const cells = [...tbl.querySelectorAll("tbody td, tfoot td")]
        .filter((c) => /\d/.test(c.textContent) && c.cellIndex > 0);
      return cells.filter((c) => {
        const st = getComputedStyle(c);
        return !/tabular-nums/.test(st.fontVariantNumeric) && !/tnum/.test(st.fontFeatureSettings);
      }).length;
    });
    eq("every numeric cell is tabular", bad, 0);
  }

  // ── THE EXPANDED CITY ────────────────────────────────────────────────────
  console.log("\nthe pitches sit in the same nine columns:");
  {
    await page.locator('[data-testid="citypnl-row"]').first().click();
    await page.waitForSelector('[data-testid="citypnl-pitch-row"]', { timeout: 30000 });
    const city = rows[0];
    const pitches = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="citypnl-pitch-row"]')].map((tr) => [...tr.querySelectorAll("td")].map((c) => c.textContent.trim())));
    eq("the pitch rows have nine cells each", [...new Set(pitches.map((p) => p.length))], [9]);

    // Pitch DPP and field cost must reconcile to the city EXACTLY — it is the same money re-cut.
    const pDpp = pitches.reduce((a, p) => a + (money(p[C.DPP]) ?? 0), 0);
    const pCost = pitches.reduce((a, p) => a + (money(p[C.COST]) ?? 0), 0);
    near("pitch DPP sums to the city", pDpp, money(city[C.DPP]), 1);
    near("pitch field cost sums to the city", pCost, money(city[C.COST]), 1);
    // Member revenue is ALLOCATED by spots, so it lands within a rounding dollar or two.
    const pMemb = pitches.reduce((a, p) => a + (money(p[C.MEMB]) ?? 0), 0);
    near("pitch member rev sums to the city within $2 (allocation rounding)", pMemb, money(city[C.MEMB]), 2);

    eq("every pitch row marks member rev as allocated",
      pitches.every((p) => !/\d/.test(p[C.MEMB]) || /alloc/i.test(p[C.MEMB])), true);
    // A pitch has no overhead, net or margin — those are city facts.
    eq("pitches show dashes for overhead, net and margin",
      pitches.every((p) => p[C.OH] === "—" && p[C.NET] === "—" && p[C.MAR] === "—"), true);
    // Each pitch chains on the columns it does have.
    for (const p of pitches) {
      const nm = p[C.CITY].split("\n")[0].slice(0, 22);
      const d = money(p[C.DPP]), m = money(p[C.MEMB]) ?? 0, t = money(p[C.TOTAL]);
      near(`  ${nm}: total = dpp + member`, t, d + m, 2);
      if (money(p[C.COST]) != null) near(`  ${nm}: field net = total − cost`, money(p[C.FNET]), t + money(p[C.COST]), 2);
    }
    eq("the 'Measured' reconciliation row is gone", (await page.evaluate(() => document.body.innerText)).includes("Measured"), false);
  }

  console.log("\nthe overhead makeup sums to the city:");
  {
    const oh = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="citypnl-oh-item"]')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.textContent.trim()));
    eq("it lists at least one component", oh.length > 0, true);
    const amounts = oh.map((t) => money((t.match(/\$[\d,]+/) ?? [])[0]));
    const shares = oh.map((t) => pct((t.match(/(\d+)%/) ?? [])[0]));
    const cityOh = Math.abs(money(rows[0][C.OH]));
    near("the components sum to the city's overhead", amounts.reduce((a, b) => a + b, 0), cityOh, 2);
    near("…and the shares sum to 100%", shares.reduce((a, b) => a + b, 0), 100, 2);
  }

  // ── MONTH AND BASIS ARE TWO CONTROLS ─────────────────────────────────────
  console.log("\nmonth and basis are separate controls:");
  {
    const c = await page.evaluate(() => {
      const sel = document.querySelector('select[aria-label="Cost basis"]');
      const seg = document.querySelector('[role="group"][aria-label="Month"]');
      return {
        basis: sel ? [...sel.options].map((o) => o.textContent.trim()) : null,
        month: seg ? [...seg.querySelectorAll("button")].map((b) => b.textContent.trim()) : null,
      };
    });
    eq("basis offers the four combinations", c.basis,
      ["Per-match · Realized", "Per-match · Full month", "As billed · Realized", "As billed · Full month"]);
    eq("the month does not appear inside the basis control",
      (c.basis ?? []).some((o) => /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Q[1-4]/.test(o)), false);
    eq("month is its own segmented control", (c.month ?? []).length >= 4, true);
  }

  // ── NOTHING CLIPPED, EITHER WIDTH ────────────────────────────────────────
  for (const w of [1560, 390]) {
    console.log(`\nlayout at ${w}px:`);
    await page.setViewportSize({ width: w, height: w === 390 ? 900 : 1300 });
    await open(w);
    const r = await page.evaluate(() => {
      const seen = (e) => e && e.getBoundingClientRect().width > 0 && e.offsetParent !== null;
      // Scoped to THIS component: the app's global header is not what this suite is reviewing.
      const card = document.querySelector('[data-testid="citypnl-table"]')?.closest("div[class]")?.parentElement
        ?? document.body;
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        tableVisible: [...document.querySelectorAll('[data-testid="citypnl-table"]')].some(seen),
        cardsVisible: [...document.querySelectorAll('[data-testid="citypnl-card"]')].some(seen),
        small: [...new Set([...card.querySelectorAll("button:not([disabled]), select")]
          .filter((b) => { const x = b.getBoundingClientRect(); return x.width > 0 && x.height > 0 && Math.min(x.width, x.height) < 36; })
          .map((b) => b.textContent.trim().slice(0, 20)))],
      };
    });
    eq(`${w}: the page does not scroll sideways`, r.overflow, false);
    eq(`${w}: every enabled control clears 36px`, r.small, []);
    if (w === 1560) {
      eq("1560: the nine-column table is what renders", [r.tableVisible, r.cardsVisible], [true, false]);
    } else {
      // MOBILE IS A DIFFERENT LAYOUT: the chain becomes a card per city, and the wide table is
      // not merely scrolled off — it is not painted at all.
      eq("390: the card layout is what renders", [r.tableVisible, r.cardsVisible], [false, true]);
      const chain = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="citypnl-card"]')][0]?.innerText ?? "");
      eq("390: the card carries the whole chain",
        ["DPP rev", "Member rev", "Total rev", "Field cost", "Field net", "Overhead", "Net P&L"]
          .every((l) => chain.includes(l)), true);
    }
  }

  console.log(`\n================ RESULT ================\nAssertions: ${PASS} passed, ${FAIL} failed`);
  if (fails.length) fails.forEach((f) => console.log("   FAILED: " + f));
  await closeContext(ctx);
  await closeBrowser(browser);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch(fatal);
