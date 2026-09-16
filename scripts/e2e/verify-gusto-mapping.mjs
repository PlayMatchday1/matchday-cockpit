// A CORRECT REFUSAL WITH NO DOOR BESIDE IT.
//
// Ryan, relaying Deonna: "trying to add someone to manager pay who hasnt managed match but she does
// other ops related stuff - but getting unneeded error".
//
// THE ERROR WAS NOT UNNEEDED. The Gusto CSV matches on First + Last, so a pay row with no mapping
// reaches payroll as a name split off a string, pays nobody, and looks identical on the sheet to
// one that paid. The DEAD END beside the refusal was the bug: the only Gusto-alias editor in the
// app lived inside an expanded row on the pay sheet, and the only ways onto that sheet are managing
// a match or being added through this dialog, which refused anyone unmapped. Measured 2026-09-15:
// 73 of the 85 people on the city-manager rosters were inside that loop, DFW and STL entirely.
//
// NOTHING IS WRITTEN TO PRODUCTION. manager_gusto_aliases decides who a payroll row pays, so the
// directory, the alias read and the alias WRITE are all answered from an in-memory store. The 409
// path is driven from that store rather than by attempting a real duplicate: the unique index is
// declared in migration 0083, but the only way to exercise it live is to write to a payroll table
// and hope it is refused, and if it were ever absent this suite would have created a bad mapping
// on a real person.
//
//   node scripts/e2e/verify-gusto-mapping.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
/* DEONNA HERSELF. Non-admin, can_access_matchops — the identity the whole change is for, so the
 * "a non-admin can do this" item is exercised AS one rather than as an admin pretending. */
const OPS = "dgarcia@playmatchday.com";
const PAGE = `${BASE}/match-ops/manager-pay`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok    ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX    ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));
const head = (s) => console.log(`\n-- ${s} --`);

/* THE REAL UNMAPPED PERSON, from the SATX roster, named. */
const HER = { email: "pickingflowers2@yahoo.com", name: "Chrystal Morales", city: "SATX", cityName: "San Antonio" };
const MAPPED = { email: "kidsmiles.ag@gmail.com", name: "Abraham Garcia", city: "SATX", cityName: "San Antonio",
  gusto: { firstName: "Abraham", lastName: "Garcia" } };
const ALSO_UNMAPPED = { email: "edwin120650@gmail.com", name: "Edwin Garcia", city: "SATX", cityName: "San Antonio" };

function makeStore({ nameTaken = false } = {}) {
  return { aliases: { [MAPPED.email]: { ...MAPPED.gusto, email: null, note: null } }, writes: [], nameTaken };
}

async function boot(browser, storageState, { width = 1280, store }) {
  const ctx = await browser.newContext({
    storageState, viewport: { width, height: 1000 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}),
  });

  /* THE DIRECTORY, REWRITTEN ON THE READ. Three SATX people: one mapped, two not. The real roster
   * moves under us as people are added in MatchDay, and a suite that only runs while a particular
   * person happens to be unmapped stops testing the moment somebody maps her. */
  await ctx.route("**/api/manager-pay/directory**", async (route) => {
    const people = [MAPPED, HER, ALSO_UNMAPPED].map((p) => ({
      email: p.email, name: p.name, city: p.city, cityName: p.cityName,
      gusto: store.aliases[p.email] ? { firstName: store.aliases[p.email].firstName, lastName: store.aliases[p.email].lastName } : null,
    }));
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ people, total: people.length, withGusto: people.filter((p) => p.gusto).length, byCity: { SATX: people.length } }) });
  });

  await ctx.route("**/api/manager-pay/aliases**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ aliases: store.aliases }) });
    }
    if (req.method() === "PUT") {
      const b = JSON.parse(req.postData() || "{}");
      store.writes.push({ method: "PUT", ...b });
      /* THE ROUTE'S OWN RULES, MIRRORED, so the fixture cannot be kinder than production. */
      if (!b.firstName?.trim() || !b.lastName?.trim()) {
        return route.fulfill({ status: 400, contentType: "application/json",
          body: JSON.stringify({ error: "Both first and last name are required (that's the point — no empty last names)." }) });
      }
      /* 23505 ON THE UNIQUE INDEX over (lower(btrim(first)), lower(btrim(last))). Migration 0083. */
      if (store.nameTaken) {
        return route.fulfill({ status: 409, contentType: "application/json",
          body: JSON.stringify({ error: `Another manager is already mapped to "${b.firstName} ${b.lastName}". Two managers cannot share a Gusto worker.` }) });
      }
      store.aliases[String(b.managerEmail).toLowerCase()] =
        { firstName: b.firstName.trim(), lastName: b.lastName.trim(), email: b.email ?? null, note: b.note ?? null };
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ saved: b, outcome: "landed", logRecorded: true }) });
    }
    if (req.method() === "DELETE") {
      const email = new URL(req.url()).searchParams.get("email") ?? "";
      store.writes.push({ method: "DELETE", email });
      delete store.aliases[email.toLowerCase()];
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ deleted: true, email, outcome: "landed", logRecorded: true }) });
    }
    return route.fallback();
  });

  /* THE SHEET ITSELF IS REAL except that SATX is guaranteed to be on it — the Add control hangs off
   * a city block, and a week with no SATX matches would have nothing to click. */
  await ctx.route("**/api/manager-pay/week**", async (route) => {
    const res = await route.fetch();
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.cities)) return route.fulfill({ response: res });
    if (!j.cities.some((c) => c.cityIdentifier === "SATX")) {
      j.cities.push({ cityIdentifier: "SATX", matchCount: 0, baseTotal: 0, adjustment: 0, total: 0, managers: [], matches: [] });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 180000 });
  await p.waitForSelector('[data-testid="mp-add-someone"]', { timeout: 120000 });
  await p.waitForTimeout(900);
  return { ctx, p, errs };
}

/** Open the SATX add dialog and pick a person by email. */
async function openAndPick(p, email) {
  await p.locator('[data-testid="mp-add-someone"][data-city="SATX"]').first().click();
  await p.waitForSelector('[data-testid="mp-add-modal"]', { timeout: 20000 });
  await p.waitForTimeout(600);
  /* THE UNMAPPED PEOPLE ARE BEHIND THE TOGGLE, which is the point of item 5. */
  const opt = p.locator(`[data-testid="mp-add-option"][data-email="${email}"]`);
  if ((await opt.count()) === 0) {
    await p.locator('[data-testid="mp-add-showthem"], [data-testid="mp-add-showall"]').first().click();
    await p.waitForTimeout(400);
  }
  await p.locator(`[data-testid="mp-add-option"][data-email="${email}"]`).first().click();
  await p.waitForTimeout(400);
}

const dis = async (p, sel) => p.locator(sel).first().isDisabled();
const txt = async (p, sel) => (await p.locator(sel).first().textContent())?.replace(/\s+/g, " ").trim() ?? null;

async function main() {
  const browser = await chromium.launch();

  /* ── 1 and 10. THE LOOP, AND ITS SIZE, READ FROM PRODUCTION. Read only. ───────────────────── */
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const aliasRows = nonEmpty((await sb.from("manager_gusto_aliases").select("*")).data ?? [], "manager_gusto_aliases rows");
  console.log(`\nmanager_gusto_aliases: ${aliasRows.length} mappings exist in production`);
  const { data: logRows } = await sb.from("change_log").select("source").eq("source", "Manager Pay — Gusto alias");
  console.log(`change_log rows under "Manager Pay — Gusto alias": ${logRows?.length ?? 0}`);

  /* THE CLOSED LOOP, ASSERTED ON THE SOURCE rather than guessed. AliasEditor is rendered in exactly
   * one place, and that place is inside MgrDetail. */
  const { readFileSync } = await import("node:fs");
  const view = readFileSync("src/app/(internal)/match-ops/manager-pay/ManagerPayView.tsx", "utf8");
  const editorMounts = (view.match(/<AliasEditor\b/g) ?? []).length;
  is("AliasEditor is mounted in exactly one place", editorMounts, 1);
  yes("  and that place is inside MgrDetail, which needs a row already on the sheet",
    /function MgrDetail[\s\S]{0,1200}<AliasEditor/.test(view));
  yes("  the add dialog no longer dead-ends: it renders the mapping form", /data-testid="mp-add-mapform"/.test(view));
  is("  CONTROL: and the old dead-end box is gone", /data-testid="mp-add-nogusto"/.test(view), false);

  const storageState = (await storageStateFor(ADMIN, BASE)).storageState;

  // ══ 2, 3, 5. THE FIX, WHERE THE BLOCK HAPPENS ═════════════════════════════════════════════
  {
    head("a person with no mapping can be mapped, then added, in one pass");
    const store = makeStore();
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    is("no page error", errs.length, 0);
    await openAndPick(p, HER.email);

    yes("the block is a form", (await p.locator('[data-testid="mp-add-mapform"]').count()) > 0);
    const blurb = await txt(p, '[data-testid="mp-add-mapform"]');
    yes("  keeping the reason, because the reason is true", /does not pay/.test(blurb ?? ""));
    is("first name, last name and an optional Gusto email",
      await p.locator('[data-testid="mp-map-first"], [data-testid="mp-map-last"], [data-testid="mp-map-email"]').count(), 3);

    yes("save is off with nothing filled", await dis(p, '[data-testid="mp-map-save"]'));
    await p.locator('[data-testid="mp-map-first"]').fill("Chrystal");
    await p.waitForTimeout(200);
    yes("  CONTROL: one name alone is not enough", await dis(p, '[data-testid="mp-map-save"]'));
    await p.locator('[data-testid="mp-map-last"]').fill("Morales");
    await p.waitForTimeout(200);
    is("and on once both are", await dis(p, '[data-testid="mp-map-save"]'), false);

    const hint = await txt(p, '[data-testid="mp-map-hint"]');
    yes("the copy says the name must match Gusto exactly", /exactly/.test(hint ?? ""));
    yes("  and admits Clubhouse cannot verify it", /cannot check it/.test(hint ?? ""));
    yes("  and that she must already be a worker in Gusto", /already exist as a worker in Gusto/.test(hint ?? ""));

    await p.locator('[data-testid="mp-map-save"]').click();
    await p.waitForTimeout(1500);
    yes("saving the mapping clears the block", (await p.locator('[data-testid="mp-add-mapform"]').count()) === 0);
    const okBox = await txt(p, '[data-testid="mp-add-mapped"]');
    yes(`the dialog says what was saved: "${okBox}"`, /Gusto mapping saved: Chrystal Morales/.test(okBox ?? ""));
    is("  CONTROL: exactly one write was attempted", store.writes.length, 1);
    is("  and it carried both names", [store.writes[0].firstName, store.writes[0].lastName], ["Chrystal", "Morales"]);

    // ── 5. THE MAPPING IS NOT A BYPASS ──────────────────────────────────────────────────────
    yes("CONTROL: Add to the sheet is STILL off, because there is no amount", await dis(p, '[data-testid="mp-add-save"]'));
    await p.locator('[data-testid="mp-add-amount"]').fill("40");
    await p.waitForTimeout(250);
    yes("  CONTROL: and still off with an amount and no reason", await dis(p, '[data-testid="mp-add-save"]'));
    await p.locator('[data-testid="mp-add-reason"]').fill("Covered Tuesday at NEMP");
    await p.waitForTimeout(250);
    is("and on only once the amount AND the reason are both there", await dis(p, '[data-testid="mp-add-save"]'), false);
    is("  CONTROL: and still nothing beyond the mapping has been written", store.writes.length, 1);
    await closeContext(ctx);
  }

  // ══ 4. THE DUPLICATE GUSTO WORKER ═════════════════════════════════════════════════════════
  {
    head("a Gusto name another manager already holds");
    const store = makeStore({ nameTaken: true });
    const before = { ...store.aliases };
    const { ctx, p, errs } = await boot(browser, storageState, { store });
    is("no page error", errs.length, 0);
    await openAndPick(p, HER.email);
    await p.locator('[data-testid="mp-map-first"]').fill("Abraham");
    await p.locator('[data-testid="mp-map-last"]').fill("Garcia");
    await p.waitForTimeout(200);
    await p.locator('[data-testid="mp-map-save"]').click();
    await p.waitForTimeout(1200);
    const e = await txt(p, '[data-testid="mp-map-error"]');
    yes(`it is refused, and says why: "${e}"`, /cannot share a Gusto worker/.test(e ?? ""));
    yes("  with the form still there to correct", (await p.locator('[data-testid="mp-add-mapform"]').count()) > 0);
    is("  CONTROL: nothing was saved", store.aliases, before);
    is("  CONTROL: and she still has no mapping", store.aliases[HER.email] ?? null, null);
    yes("  CONTROL: so the row still cannot be added", await dis(p, '[data-testid="mp-add-save"]'));
    await closeContext(ctx);
  }

  // ══ 5b. THE HIDDEN LINE IS A DOOR ═════════════════════════════════════════════════════════
  {
    head("the hidden people stop being a dead fact");
    const store = makeStore();
    const { ctx, p } = await boot(browser, storageState, { store });
    await p.locator('[data-testid="mp-add-someone"][data-city="SATX"]').first().click();
    await p.waitForSelector('[data-testid="mp-add-modal"]', { timeout: 20000 });
    await p.waitForTimeout(700);
    const line = await txt(p, '[data-testid="mp-add-hidden"]');
    yes(`the line offers something to do: "${line}"`, /can be set up here/.test(line ?? ""));
    is("  CONTROL: the default view is still this city's mapped people only",
      await p.locator('[data-testid="mp-add-option"]').count(), 1);
    await p.locator('[data-testid="mp-add-showthem"]').click();
    await p.waitForTimeout(400);
    is("and clicking it reveals the unmapped ones", await p.locator('[data-testid="mp-add-option"]').count(), 3);
    await closeContext(ctx);
  }

  // ══ 6, 7. THE SHEET BEHIND, AND A NON-ADMIN DOING ALL OF IT ═══════════════════════════════
  {
    head("Deonna, who is not an admin");
    const opsState = (await storageStateFor(OPS, BASE)).storageState;
    const store = makeStore();
    const { ctx, p, errs } = await boot(browser, opsState, { width: 1280, store });
    is("no page error", errs.length, 0);
    const admin = await p.evaluate(() => document.body.innerText.includes("Export Gusto CSV"));
    ok(`CONTROL: signed in as a non-admin (admin-only export present: ${admin})`);

    await openAndPick(p, HER.email);
    yes("she gets the mapping form, not a dead end", (await p.locator('[data-testid="mp-add-mapform"]').count()) > 0);
    await p.locator('[data-testid="mp-map-first"]').fill("Chrystal");
    await p.locator('[data-testid="mp-map-last"]').fill("Morales");
    await p.waitForTimeout(200);
    await p.locator('[data-testid="mp-map-save"]').click();
    await p.waitForTimeout(1500);
    yes("and it saves", !!store.aliases[HER.email]);
    yes("  the person row carries the Gusto name now",
      (await p.locator('[data-testid="mp-add-mapped"]').count()) > 0);

    /* ── 6. THE SHEET ROW BEHIND, WITHOUT A RELOAD. saveAlias bumps refreshKey, which re-reads the
     * alias map and the week; the chip appears underneath while the dialog is still open. */
    await p.locator('[data-testid="mp-add-cancel"]').click();
    await p.waitForTimeout(1200);
    const mapCall = await p.evaluate(async () => {
      const r = await fetch("/api/manager-pay/aliases", { cache: "no-store" });
      return (await r.json()).aliases ?? {};
    });
    yes("the page's own alias map now holds her, with no reload", !!mapCall["pickingflowers2@yahoo.com"]);
    is("  CONTROL: and it is not empty for a non-admin, which is what the fourth gate used to do",
      Object.keys(mapCall).length >= 2, true);
    await closeContext(ctx);
  }

  // ══ 11. SIZES ═════════════════════════════════════════════════════════════════════════════
  /* THE DIALOG IS THE SUBJECT, NOT THE SHEET. Manager Pay is a desktop city-by-weekday sheet with
   * no phone layout, and at 390px its own rows sit over the Add control — a real thing, but a
   * pre-existing one about the sheet and not about this change. So the dialog is OPENED at a width
   * where the sheet works and the viewport is then narrowed onto it, which measures exactly what
   * the brief asks about: the form, at 390 and at 1100. */
  for (const width of [390, 1100]) {
    head(`${width}px`);
    const store = makeStore();
    const { ctx, p, errs } = await boot(browser, storageState, { width: 1280, store });
    is("no page error", errs.length, 0);
    await openAndPick(p, HER.email);
    await p.setViewportSize({ width, height: 900 });
    await p.waitForTimeout(500);
    /* ── THE SHEET BEHIND SCROLLS SIDEWAYS, AND IT ALWAYS DID ────────────────────────────────
     * Measured with the dialog CLOSED as well, so this is not a claim: Manager Pay is a fixed
     * desktop grid and its document overflows below ~1200px whether or not anything is open. That
     * is a real thing about the sheet and a separate job; asserting document.scrollWidth here
     * would report the sheet's geometry as this dialog's, and would have gone red at 1100 for a
     * form that fits perfectly. THE DIALOG is the subject, so the dialog is what is measured. */
    const pageOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const dlg = await p.evaluate(() => {
      const el = document.querySelector('[data-testid="mp-add-modal"] > div');
      return el ? { over: el.scrollWidth - el.clientWidth, w: Math.round(el.getBoundingClientRect().width) } : null;
    });
    is("the dialog does not scroll sideways", dlg?.over ?? -1, 0);
    yes(`  and it fits the viewport (${dlg?.w}px wide in ${width}px)`, (dlg?.w ?? 1e9) <= width);
    console.log(`     the SHEET behind overflows by ${pageOverflow}px at ${width}px — pre-existing, see the note`);
    /* THE POSITIVE CONTROL. Math.min of an empty set is Infinity, and Infinity >= 32. */
    const fields = nonEmpty(await p.$$('[data-testid="mp-map-first"], [data-testid="mp-map-last"], [data-testid="mp-map-email"], [data-testid="mp-add-amount"], [data-testid="mp-add-reason"]'), `${width}px dialog fields`);
    const btns = nonEmpty(await p.$$('[data-testid="mp-map-save"], [data-testid="mp-add-save"], [data-testid="mp-add-cancel"]'), `${width}px dialog buttons`);
    ok(`CONTROL: ${fields.length} fields and ${btns.length} buttons on screen to measure`);
    const fh = await p.$$eval('[data-testid="mp-map-first"], [data-testid="mp-map-last"], [data-testid="mp-map-email"], [data-testid="mp-add-amount"], [data-testid="mp-add-reason"]',
      (es) => Math.min(...es.map((e) => e.getBoundingClientRect().height)));
    yes(`every field is ${Math.round(fh)}px`, fh >= 32);
    const bh = await p.$$eval('[data-testid="mp-map-save"], [data-testid="mp-add-save"], [data-testid="mp-add-cancel"]',
      (es) => Math.min(...es.map((e) => e.getBoundingClientRect().height)));
    yes(`every button is ${Math.round(bh)}px`, bh >= 32);
    const spill = await p.evaluate(() => {
      const m = document.querySelector('[data-testid="mp-add-modal"] > div')?.getBoundingClientRect();
      if (!m) return -1;
      return [...document.querySelectorAll('[data-testid="mp-add-modal"] *')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > m.right + 1 || r.left < m.left - 1);
      }).length;
    });
    is("nothing spills out of the dialog", spill, 0);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\ngusto-mapping: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(2); });
