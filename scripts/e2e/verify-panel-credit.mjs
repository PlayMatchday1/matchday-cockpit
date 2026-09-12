// CREDIT EVERYONE WHO PAID, IN THE MATCH PANEL.
//
// NO REAL MONEY MOVES HERE. The POST that credits is INTERCEPTED in every context — the request is
// recorded, the response is synthesised, and the route is never reached. The GET preview is a dry
// run by construction (the route's own header says so) and is the only credit-all request allowed
// through to production, in one place, clearly marked.
//
// WHY THIS SUITE EXISTS. The control shipped in 0b25b96 on /match-ops/matches/[id] and worked. That
// route is reached from exactly two places in the app (PlayerLookup and one Open match link on
// Veo); Gameday Ops — where the work happens — opens MatchPanel, which had ZERO references to the
// hook. A control that moves money was built, tested, deployed and effectively unreachable.
//
//   node scripts/e2e/verify-panel-credit.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const GAMEDAY = `${BASE}/match-ops/gameday`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} - ${d}`); console.log(`  XX  ${n} - ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* ── THE PREVIEW FIXTURE ───────────────────────────────────────────────────────────────────────
 * Shaped so every rule in the brief has something to assert against:
 *   · 13 paid by card, 2 of them ALSO spent wallet credit — paidWithCreditCount proves the inverted
 *     rule (credit_amount is credit SPENT; those rows are credited, never skipped);
 *   · four distinct skip reasons, so "grouped by reason" has more than one group;
 *   · notifyAvailable false, which is the live state until the wording is approved. */
const PLAN = {
  pay: Array.from({ length: 13 }, (_, i) => ({ userId: 40000 + i, cents: 1200 })),
  totalCents: 19200,
  paidWithCreditCount: 2,
  paidWithCreditCents: 2400,
  skips: [
    { reason: "member, paid nothing", count: 5, cents: 0 },
    { reason: "included, paid nothing", count: 1, cents: 0 },
    { reason: "payment never settled", count: 2, cents: 2400 },
    { reason: "already credited for this match", count: 1, cents: 1200 },
  ],
  overCap: false,
};
const PREVIEW = {
  matchId: 1, name: "Soccer Central Field 4", cancelled: false, plan: PLAN,
  alreadyCreditedCount: 1, refused: null, cancelCredited: null,
  notifyAvailable: false, caps: { maxRunCents: 200000, maxRunPlayers: 60 },
};
const CANCELLED = {
  ...PREVIEW, cancelled: true, plan: { ...PLAN, pay: [], totalCents: 0, skips: [] },
  refused: null, cancelCredited: { count: 36, totalCents: 43200 },
};
/* ── THE RUN FIXTURE ──────────────────────────────────────────────────────────────────────────
 * ONE OF EACH VERDICT. A run showing only LANDED proves nothing about the half-done shape that is
 * expected when retries are forbidden. */
const RESULT = {
  ran: 13, landed: 11, aborted: 1, failed: 1, refusedPlayers: 0, totalCreditedCents: 13200,
  results: [
    ...Array.from({ length: 11 }, (_, i) => ({ userId: 40000 + i, cents: 1200, verdict: "LANDED" })),
    { userId: 44812, cents: 0, verdict: "ABORTED", detail: "Balance moved mid-run" },
    { userId: 51220, cents: 0, verdict: "FAILED", detail: "HTTP 409" },
  ],
  skipped: PLAN.skips,
};

const READ = () => {
  const R = (e) => { const b = e.getBoundingClientRect();
    return { t: +b.top.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1),
             w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const cs = (e) => getComputedStyle(e);
  const q = (s) => document.querySelector(s);
  const card = q('[data-testid="creditall-card"]');
  const danger = q('[data-testid="mp-danger"]');
  /* THE RECTS, COMPUTED ONCE AND NAMED. The first version of this compared `card.b <= danger.t`
   * with card and danger still being DOM ELEMENTS — both undefined, so the comparison was
   * `undefined <= NaN`, which is false, and the suite reported the card was not above the danger
   * zone while its own printed rects showed 4134.7 against 4148.7. A geometry assertion that reads
   * a property the element does not have fails on correct layout. */
  const cardR = card ? R(card) : null;
  const dangerR = danger ? R(danger) : null;
  const vw = document.documentElement.clientWidth;
  const btn = (sel) => { const e = q(sel); return e ? { text: e.textContent.trim(), disabled: !!e.disabled,
    title: e.getAttribute("title"), bg: cs(e).backgroundColor, fg: cs(e).color, ...R(e) } : null; };
  return {
    vw, hscroll: document.documentElement.scrollWidth > vw + 1,
    panelW: (() => { const pn = card?.closest(".gpanel, .mp-wrap"); return pn ? +pn.getBoundingClientRect().width.toFixed(1) : null; })(),
    card: cardR ? { ...cardR, bg: cs(card).backgroundColor, border: cs(card).borderLeftColor } : null,
    danger: dangerR ? { ...dangerR, bg: cs(danger).backgroundColor } : null,
    /* ABOVE IT AND OUTSIDE IT — both claims, because either alone is satisfiable while the other
       is false: a card nested inside the danger zone is also "above" its bottom edge. */
    outside: card && danger ? !danger.contains(card) : null,
    above: cardR && dangerR ? cardR.b <= dangerR.t + 0.5 : null,
    domBefore: card && danger ? (card.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : null,
    stakes: q('[data-testid="creditall-stakes"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
    open: btn('[data-testid="creditall-btn"]'),
    yesBtn: btn('[data-testid="creditall-yes"]'),
    noBtn: btn('[data-testid="creditall-no"]'),
    cancelOpen: btn('[data-testid="mp-cancel-open"]'),
    refused: q('[data-testid="creditall-refused"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
    nogate: q('[data-testid="creditall-nogate"]')?.textContent.trim() ?? null,
    confirm: q('[data-testid="creditall-confirm"]') != null,
    /* NOTHING TYPED. Any text input inside the card would be the thing the Cancel card removed. */
    typed: card ? card.querySelectorAll('input[type="text"], input:not([type]), textarea').length : null,
    breakdown: [...document.querySelectorAll('[data-testid="creditall-breakdown"] .mp-bdr')].map((r) => ({
      pay: r.dataset.pay, reason: r.dataset.reason ?? null,
      n: r.querySelector(".n")?.textContent.trim() ?? "",
      why: r.querySelector(".why")?.textContent.trim() ?? "",
      amt: r.querySelector(".amt")?.textContent.trim() ?? "",
      clipped: [...r.querySelectorAll("span")].some((x) => x.scrollWidth > x.clientWidth + 1),
      bg: cs(r).backgroundColor,
    })),
    wallet: q('[data-testid="creditall-wallet"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
    notify: (() => { const e = q('[data-testid="creditall-notify"]');
      return e ? { checked: e.checked, disabled: e.disabled,
        sub: e.closest("label")?.querySelector("small")?.textContent.trim() ?? null } : null; })(),
    results: [...document.querySelectorAll('[data-testid="creditall-result"]')].map((li) => ({
      v: li.dataset.v, chip: li.querySelector(".v")?.textContent.trim() ?? null,
      colour: cs(li.querySelector(".v")).color,
      text: li.textContent.replace(/\s+/g, " ").trim(),
    })),
    summary: q('[data-testid="creditall-summary"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
    again: q('[data-testid="creditall-again"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
    /* THE CANCEL CARD, so item 13 can prove it is untouched. */
    cancelCard: {
      danger: document.querySelectorAll('[data-testid="mp-danger"]').length,
      open: document.querySelectorAll('[data-testid="mp-cancel-open"]').length,
      stakes: q('[data-testid="mp-cancel-stakes"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
      line: q('[data-testid="mp-cancel-line"]')?.textContent.replace(/\s+/g, " ").trim() ?? null,
      confirm: document.querySelectorAll('[data-testid="mp-cancel-confirm"]').length,
      abort: document.querySelectorAll('[data-testid="mp-cancel-abort"]').length,
      doBtn: document.querySelectorAll('[data-testid="mp-cancel-do"]').length,
    },
    /* EVERY CONTROL IN THE CARD, for the 44px and overlap checks. */
    controls: card ? [...card.querySelectorAll("button")].map((e) => ({
      t: e.dataset.testid ?? e.textContent.trim().slice(0, 20), ...R(e) })) : [],
    spill: card ? [...card.querySelectorAll("*")].map((e) => { const b = e.getBoundingClientRect();
      return b.width > 0 && b.right > vw + 0.5 ? [String(e.className).slice(0, 24), +b.right.toFixed(1)] : null;
    }).filter(Boolean) : [],
  };
};

/** Opens the panel on a real match from Gameday Ops — the path Ryan actually uses. */
async function openPanel(browser, storageState, width, opts = {}) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: opts.height ?? 1200 },
    ...(width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  const posts = [];
  const gets = [];
  /* THE POST IS NEVER LET THROUGH. This is the one that moves money. */
  await ctx.route("**/credit-all", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      posts.push(JSON.parse(req.postData() ?? "{}"));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.result ?? RESULT) });
    }
    gets.push(req.url());
    if (opts.preview === "live") return route.fallback();     // the dry run, deliberately real
    if (opts.previewStatus) {
      return route.fulfill({ status: opts.previewStatus, contentType: "application/json",
        body: JSON.stringify({ error: opts.previewError ?? "Crediting players needs EDIT CREDITS." }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.preview ?? PREVIEW) });
  });
  /* ── MAKING THE MATCH CANCELLED, WITHOUT CANCELLING ONE ─────────────────────────────────────
   * The card reads `isCancelled` off the MATCH payload, not off the credit preview, so a preview
   * fixture alone cannot reach the refusal branch. The real payload is fetched and ONE FIELD is
   * flipped on the way through — no write, and every other field is whatever production said. */
  if (opts.matchCancelled) {
    await ctx.route("**/api/matchday/*/matches/*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || /\/(credit-all|cancel|fakes|roster)$/.test(url.pathname)) return route.fallback();
      const res = await route.fetch();
      const j = await res.json().catch(() => null);
      /* THE FLAG LIVES ON j.match, NOT AT THE TOP LEVEL. The panel does
       * `const m = j.match as MatchData; setOrig(m)`, so patching the envelope changed nothing and
       * the refusal branch never rendered — the suite reported UNKNOWN on a correct card. */
      if (!j || typeof j !== "object" || typeof j.match !== "object" || j.match == null) {
        return route.fulfill({ response: res });
      }
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ...j, match: { ...j.match, isCancelled: true } }) });
    });
  }
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(GAMEDAY, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="gday-row"]', { timeout: 180000 });
  await p.click('[data-testid="gday-row"] [data-testid="gday-name"]');
  await p.waitForSelector('[data-testid="creditall-card"]', { timeout: 120000 });
  await p.waitForTimeout(900);
  return { ctx, p, posts, gets, errs };
}

async function main() {
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // ══ 1 / 2 / 4 / 5 / 6 / 8 / 13: THE CARD, AT DESKTOP WIDTH ══════════════════════════════════
  {
    const { ctx, p, posts, errs } = await openPanel(browser, storageState, 1500);
    let d = await p.evaluate(READ);
    console.log("\n-- the card, idle --");
    yes("  the credit card renders in MatchPanel", d.card != null);
    yes("  CONTROL: ...and so does the danger zone", d.danger != null);
    // 1. ABOVE IT AND OUTSIDE IT.
    is("  it is OUTSIDE the danger zone", d.outside, true);
    console.log(`     card ${JSON.stringify(d.card)}`);
    console.log(`     danger ${JSON.stringify(d.danger)}`);
    is("  ...and above it geometrically", d.above, true);
    is("  ...and before it in DOM order", d.domBefore, true);
    // 2. DIFFERENT SURFACE, DIFFERENT BUTTON, DIFFERENT VERB.
    console.log(`     credit card ${d.card.bg} · danger ${d.danger.bg}`);
    console.log(`     credit button ${d.open.bg} · cancel button ${d.cancelOpen.bg}`);
    is("  the card background differs from the danger zone", d.card.bg === d.danger.bg, false);
    is("  the button colour differs from the cancel's", d.open.bg === d.cancelOpen.bg, false);
    // CONTROL: the verbs do not cross.
    is("  the credit verb contains no \"cancel\"", /cancel/i.test(d.open.text), false);
    is("  CONTROL: the cancel verb contains no \"credit\"", /credit/i.test(d.cancelOpen.text), false);
    yes(`  ...and the credit verb is the credit one ("${d.open.text}")`, /credit/i.test(d.open.text));
    is("  no page error", errs, []);

    // 4 / 5 / 6 / 8. THE CONFIRM.
    await p.click('[data-testid="creditall-btn"]');
    await p.waitForSelector('[data-testid="creditall-confirm"]', { timeout: 20000 });
    await p.waitForTimeout(400);
    d = await p.evaluate(READ);
    console.log("\n-- the confirm --");
    is("  the stakes are the count and the money", d.stakes, "Credit 13 players $192.00?");
    is("  two buttons, and nothing typed", [d.yesBtn != null, d.noBtn != null, d.typed], [true, true, 0]);
    is("  Yes carries the count", d.yesBtn.text, "Yes, credit 13");
    is("  ...and No is just No", d.noBtn.text, "No");
    // 5. THE GROUPED BREAKDOWN, EVERY SKIP REASON PRESENT.
    const bd = nonEmpty(d.breakdown, "breakdown rows");
    console.log(`     ${bd.length} breakdown rows: ${bd.map((r) => `${r.n}/${r.why}/${r.amt}`).join("  |  ")}`);
    is("  every skip reason is present",
      bd.filter((r) => r.reason).map((r) => r.reason).sort(), PLAN.skips.map((s) => s.reason).sort());
    is("  ...grouped, never one line per player", bd.length, 2 + PLAN.skips.length);
    // 6. THE INVERTED RULE, ASSERTED DIRECTLY.
    yes(`  a row carrying credit_amount is CREDITED, not skipped ("${d.wallet}")`,
      d.wallet != null && /refunded, not skipped/.test(d.wallet) && /2 of those paid with wallet credit/.test(d.wallet));
    const walletRow = bd.find((r) => /paid with wallet credit/.test(r.n));
    is("  ...and it sits among the rows that get PAID, not the skips", walletRow?.pay, "1");
    is("  ...carrying its own money", walletRow?.amt, "$24.00");
    is("  CONTROL: the skips are marked as not-paid", bd.filter((r) => r.reason).map((r) => r.pay), ["0", "0", "0", "0"]);
    // 8. NOTIFY.
    is("  notify is unticked by default", d.notify.checked, false);
    console.log(`     notify disabled=${d.notify.disabled} · "${d.notify.sub}"`);
    yes("  ...and its line says cancelling sends its own text", /Cancelling sends its own text; this does not/.test(d.notify.sub ?? ""));

    // 13. THE CANCEL CARD IS UNCHANGED.
    console.log("\n-- the cancel card is untouched --");
    is("  the danger zone and its open button are still there", [d.cancelCard.danger, d.cancelCard.open], [1, 1]);
    await p.click('[data-testid="mp-cancel-open"]');
    await p.waitForSelector('[data-testid="mp-cancel-confirm"]', { timeout: 30000 });
    await p.waitForTimeout(500);
    const c = await p.evaluate(READ);
    is("  its preview still opens", c.cancelCard.confirm, 1);
    is("  ...with both its buttons", [c.cancelCard.abort, c.cancelCard.doBtn], [1, 1]);
    yes(`  ...and the pinned sentence is intact ("${String(c.cancelCard.stakes).slice(0, 46)}…")`,
      (c.cancelCard.stakes ?? "").length > 10);
    yes("  ...and its own paragraph still says CREDIT, not refund",
      /will be credited/.test(c.cancelCard.line ?? "") && /CREDIT/.test(c.cancelCard.line ?? ""));
    is("  NOTHING WAS POSTED anywhere in this block", posts.length, 0);
    await closeContext(ctx);
  }

  // ══ 9 / 10: THE RUN, AGAINST AN INTERCEPTED POST ════════════════════════════════════════════
  {
    const { ctx, p, posts } = await openPanel(browser, storageState, 1500);
    await p.click('[data-testid="creditall-btn"]');
    await p.waitForSelector('[data-testid="creditall-confirm"]', { timeout: 20000 });
    await p.click('[data-testid="creditall-yes"]');
    await p.waitForSelector('[data-testid="creditall-results"]', { timeout: 30000 });
    await p.waitForTimeout(600);
    const d = await p.evaluate(READ);
    console.log("\n-- the run (POST intercepted, no money moved) --");
    is("  exactly one POST, never a retry", posts.length, 1);
    is("  ...carrying only notify", Object.keys(posts[0]), ["notify"]);
    is("  ...and notify was false", posts[0].notify, false);
    // 9. PER-PLAYER VERDICTS, THREE DISTINCT COLOURS.
    const rs = nonEmpty(d.results, "verdict rows");
    is("  one row per player in the run", rs.length, RESULT.results.length);
    const seen = [...new Set(rs.map((r) => r.v))].sort();
    is("  all three verdicts appear", seen, ["ABORTED", "FAILED", "LANDED"]);
    is("  ...and the chips are not translated", [...new Set(rs.map((r) => r.chip))].sort(), seen);
    const col = (v) => rs.find((r) => r.v === v).colour;
    console.log(`     LANDED ${col("LANDED")} · ABORTED ${col("ABORTED")} · FAILED ${col("FAILED")}`);
    is("  all three colours are distinct", new Set([col("LANDED"), col("ABORTED"), col("FAILED")]).size, 3);
    /* PLAYER ID ONLY — no name, no phone, no email. One of the five rules. */
    yes("  the rows name the player by ID only",
      rs.every((r) => /player \d+/.test(r.text)) && !rs.some((r) => /@|\+\d{7}/.test(r.text)));
    is("  the summary counts them", d.summary, "11 credited $132.00 · 1 aborted · 1 failed");
    // 10. A SECOND RUN CREDITS ONLY WHAT DID NOT LAND.
    console.log(`     ${d.again}`);
    yes("  a second run credits only what did not land, with the count (2)",
      /only the 2 that did not land/.test(d.again ?? "") && /change_log/.test(d.again ?? ""));
    await closeContext(ctx);
  }

  // ══ 7: A CANCELLED MATCH — REFUSED, NOT WARNED ABOUT ════════════════════════════════════════
  {
    const { ctx, p, posts } = await openPanel(browser, storageState, 1500,
      { preview: CANCELLED, matchCancelled: true });
    await p.waitForTimeout(2500);   // the card asks once on its own when the match is cancelled
    const d = await p.evaluate(READ);
    console.log("\n-- a cancelled match --");
    /* THE FIXTURE CANNOT MAKE THE MATCH CANCELLED — the panel reads that from the match payload —
     * so the preview's own `cancelled` flag is what drives this, which is the route's answer and
     * the one that matters. If the card asked and the flag came back, the refusal must show. */
    if (d.refused == null) {
      bad("  UNKNOWN: the card did not ask for a preview on this match",
        "it only asks unprompted when the match payload says cancelled; this one is live, so item 7 is asserted on the fixture path below");
    } else {
      is("  no button at all", d.open, null);
      yes(`  ...and the refusal names what the cancel already did ("${String(d.refused).slice(0, 70)}…")`,
        /already credited all 36 players \$432\.00/.test(d.refused) && /texted them/.test(d.refused));
      // CONTROL: refused, not warned. A warning would leave the button live beside it.
      is("  CONTROL: it reads as refused, not as a warning beside a live button",
        [d.open, d.yesBtn, d.confirm], [null, null, false]);
    }
    is("  nothing was posted", posts.length, 0);
    await closeContext(ctx);
  }

  // ══ 11: NO EDIT CREDITS — DISABLED WITH THE REASON, AND REFUSED SERVER-SIDE ═════════════════
  {
    /* THE SERVER HALF IS THE REAL ONE. The preview is answered 403 the way the route answers a
     * caller without the grant; the card must say so rather than retrying. The CLIENT half (a
     * disabled button) is asserted on the source, because this account HAS the grant and a browser
     * cannot un-grant it. */
    const { ctx, p, posts } = await openPanel(browser, storageState, 1500,
      { previewStatus: 403, previewError: "Crediting players needs EDIT CREDITS." });
    await p.click('[data-testid="creditall-btn"]');
    await p.waitForTimeout(2500);
    const d = await p.evaluate(READ);
    console.log("\n-- refused server-side --");
    const err = await p.evaluate(() => document.querySelector('[data-testid="creditall-error"]')?.textContent.trim() ?? null);
    yes(`  a 403 on the preview is surfaced, not retried ("${err}")`, /EDIT CREDITS/i.test(err ?? ""));
    is("  ...and no confirm opened", d.confirm, false);
    is("  ...and nothing was posted", posts.length, 0);
    // CONTROL: cancelling is a separate right and still works.
    await p.click('[data-testid="mp-cancel-open"]');
    await p.waitForSelector('[data-testid="mp-cancel-confirm"]', { timeout: 30000 });
    const c = await p.evaluate(READ);
    is("  CONTROL: cancelling is a separate right and still opens", c.cancelCard.confirm, 1);
    await closeContext(ctx);
  }

  // ══ 12: 390px AND 560px, EVERY STATE ════════════════════════════════════════════════════════
  for (const w of [390, 560]) {
    const { ctx, p } = await openPanel(browser, storageState, w, { height: 1400 });
    for (const state of ["idle", "confirm", "done"]) {
      if (state === "confirm") {
        await p.click('[data-testid="creditall-btn"]');
        await p.waitForSelector('[data-testid="creditall-confirm"]', { timeout: 20000 });
      }
      if (state === "done") {
        await p.click('[data-testid="creditall-yes"]');
        await p.waitForSelector('[data-testid="creditall-results"]', { timeout: 30000 });
      }
      await p.waitForTimeout(500);
      const d = await p.evaluate(READ);
      const tag = `  ${w}/${state}:`;
      is(`${tag} no horizontal scroll`, d.hscroll, false);
      is(`${tag} nothing spills right`, d.spill, []);
      /* THE PANEL IS FULL-WIDTH ON A PHONE and the card fills its column. NOT "card width ==
       * viewport": the card carries 16px margins inside .mp-body's own 14px padding, so 331 of 390
       * is correct and the first version of this asserted a number the layout never intended. What
       * matters is that it lines up with the card BELOW it. */
      if (w === 390) {
        yes(`${tag} the panel is full-width (${d.panelW} of ${d.vw})`, d.panelW >= d.vw - 1);
        is(`${tag} ...and the card is exactly as wide as the danger zone`, d.card.w, d.danger.w);
        is(`${tag} ...and shares its left edge`, d.card.l, d.danger.l);
      }
      const ctl = nonEmpty(d.controls, `controls @${w}/${state}`);
      is(`${tag} every button clears 44px`, ctl.filter((c) => c.h < 43.5).map((c) => [c.t, c.h]), []);
      if (state === "confirm") {
        /* YES AND NO MUST NOT OVERLAP. They wrap on a narrow panel rather than shrinking. */
        const y = d.yesBtn, n = d.noBtn;
        const overlap = y.r > n.l + 0.5 && n.r > y.l + 0.5 && y.b > n.t + 0.5 && n.b > y.t + 0.5;
        is(`${tag} Yes and No do not overlap`, overlap, false);
        yes(`${tag} ...and Yes is at least 44px (${y.h})`, y.h >= 43.5);
        is(`${tag} no breakdown line is truncated`, d.breakdown.filter((r) => r.clipped).map((r) => r.n), []);
      }
      if (state === "done") is(`${tag} all verdict rows render`, d.results.length, RESULT.results.length);
    }
    await closeContext(ctx);
  }

  // ══ 3 / 11: ONE IMPLEMENTATION, AND THE GATES ═══════════════════════════════════════════════
  {
    console.log("\n-- one implementation --");
    const { execSync } = await import("node:child_process");
    const diff = (f) => execSync(`git diff --stat HEAD -- ${JSON.stringify(f)}`, { encoding: "utf8" }).trim();
    for (const f of ["src/lib/useCreditEveryone.ts",
      "src/app/api/matchday/[env]/matches/[id]/credit-all/route.ts",
      "src/lib/useCancelMatch.ts"]) {
      is(`  ${f.split("/").pop()} is byte-identical to HEAD`, diff(f), "");
    }
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("src/components/MatchPanel.tsx", "utf8");
    const route = readFileSync("src/app/api/matchday/[env]/matches/[id]/credit-all/route.ts", "utf8");
    /* THE PANEL MOUNTS THE HOOK AND DOES NOT REIMPLEMENT ANY OF IT. */
    yes("  the panel mounts useCreditEveryone", /useCreditEveryone\(\{/.test(panel));
    is("  ...and posts to credit-all nowhere itself", /credit-all/.test(panel), false);
    is("  ...and computes no plan of its own", /paidWithCreditCents\s*=/.test(panel), false);
    // 11, CLIENT HALF: the button is disabled with the reason.
    yes("  the button is disabled without EDIT CREDITS, with the reason",
      /disabled=\{creditAll\.busy \|\| !canCredit\}/.test(panel)
      && /Crediting players needs EDIT CREDITS\./.test(panel));
    yes("  ...and the gate is the editor's, verbatim",
      /can\(appUser as never, "editCredits", appUser\?\.email\)/.test(panel));
    // 11, SERVER HALF: its own gate, and cancel is a different right.
    yes("  the route is on the credits gate, not an admin one", !/authenticateAdmin\b/.test(route));
    yes("  ...and matchops-auth pins it there",
      /credit-all\/route\.ts/.test(readFileSync("scripts/matchops-auth-test.ts", "utf8")));
    /* THE FIVE RULES, on the route that carries them. */
    for (const [name, pat] of [["one attempt and no retry", /never a retry|no retry|ONE ATTEMPT/i],
      ["recordWrite", /recordWrite/], ["the race re-check", /race|re-?check/i]]) {
      yes(`  the route still carries ${name}`, pat.test(route));
    }
  }

  await closeBrowser(browser);
  console.log(`\npanel-credit: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}
main().catch((e) => fatal(e));
