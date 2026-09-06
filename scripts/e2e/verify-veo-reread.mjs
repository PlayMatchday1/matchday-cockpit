// ASSIGN IS NO LONGER A DEAD END — and re-reading a title still writes nothing.
//   node scripts/e2e/verify-veo-reread.mjs      (needs `npm run dev` up)
//
// Ryan: "nothing to assign when i click it". Every queued row opened onto "The title gave no date,
// so there is no day to offer matches from". The row was rendering the parse STORED when the film
// arrived; those rows arrived before the parser learned their shapes.
//
// THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT WRITES. Re-reading a title must not re-decide a
// recording: those films were posted into their chats by hand, and moving a stored row would put a
// second copy of a link in front of players. Every stored field is read before and after a render.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { nonEmpty } from "./_session.mjs";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

const SUBJECTS = [
  "PRUMC |SEP 3 | 7 :00pm is ready to watch!",
  "KESWICK |SEP 4 | 8 :00pm is ready to watch!",
  "SCISS | 30 ago | 8pm is ready to watch!",
];
/* NOT the untitled recording. "Untitled recording 2026-09-06_01-07-30" DOES carry a date — the
 * recording timestamp in Veo's own default filename — and today's parser reads it, so that row
 * opens straight onto Sep 6 rather than asking. The rows that genuinely have no date are the ones
 * with no date anywhere in the string: "Match - MatchDay STL", "Match - Blue". */
const NO_DATE_LIKE = "Match - %";

const STORED = "id, email_subject, status, queue_reason, parsed_code, parsed_match_date, parsed_time_minutes, matched_api_id, updated_at";

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  const snap = async () => {
    const { data } = await svc.from("veo_recordings").select(STORED).in("email_subject", SUBJECTS).order("received_at");
    const { count } = await svc.from("veo_recordings").select("id", { count: "exact", head: true }).eq("status", "queued");
    return { rows: data, queued: count };
  };
  const before = await snap();
  console.log(`     queued before: ${before.queued}`);
  for (const r of before.rows) console.log(`       ${String(r.queue_reason).padEnd(20)} date=${JSON.stringify(r.parsed_match_date)}  ${r.email_subject.slice(0, 42)}`);

  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1200 },
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(vv.data.session) }] }] } });
  const p = await ctx.newPage();
  // NOTHING POSTS EXCEPT A CONFIRMED CLICK — proven by refusing every write at the wire.
  const writes = [];
  await p.route("**/api/veo/**", (route) => {
    const m = route.request().method();
    if (m !== "GET") { writes.push(`${m} ${route.request().url().replace(BASE, "")}`); return route.abort(); }
    return route.fallback();
  });

  await p.goto(`${BASE}/match-ops/veo`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-recent-row"]', { timeout: 240000 });
  await p.waitForTimeout(1500);

  const rowFor = async (subject) => {
    const id = before.rows.find((r) => r.email_subject === subject)?.id;
    return { id, sel: `[data-recording-id="${id}"]` };
  };

  // ---- 1 & 2: the read, and the history kept beside it ----
  for (const subject of SUBJECTS) {
    const { sel } = await rowFor(subject);
    const el = await p.$(sel);
    if (!el) { bad(`the row for "${subject.slice(0, 30)}" is on the page`, "not in the first 30 arrivals"); continue; }
    const read = await p.evaluate((s) => {
      const e = document.querySelector(s);
      return {
        reread: e.querySelector('[data-testid="veo-recent-reread"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        was: e.querySelector('[data-testid="veo-recent-was"]')?.textContent?.trim() ?? null,
        wasStruck: getComputedStyle(e.querySelector('[data-testid="veo-recent-was"]') ?? document.body).textDecorationLine,
        assign: Boolean(e.querySelector('[data-testid="veo-recent-assign"]')),
      };
    }, sel);
    console.log(`     ${subject.slice(0, 34)}\n        reads: ${read.reread}`);
    yes(`"${subject.slice(0, 22)}" now shows a read date`, Boolean(read.reread) && /reads now as/.test(read.reread), JSON.stringify(read));
    yes("…and keeps its stored reason as history", read.was === "unparseable_subject", JSON.stringify(read.was));
    yes("…struck through, not overwritten", /line-through/.test(read.wasStruck), read.wasStruck);
    yes("…and offers Assign", read.assign);
  }

  // ---- 3: Assign opens straight onto that day ----
  {
    const { sel } = await rowFor(SUBJECTS[0]);
    await p.click(`${sel} [data-testid="veo-recent-assign"]`);
    await p.waitForSelector('[data-testid="veo-recent-panel"]', { timeout: 30000 });
    await p.waitForSelector('[data-testid="veo-rest"] [data-gap], [data-testid="veo-recent-picker"]', { timeout: 60000 });
    const opened = await p.evaluate(() => ({
      picker: Boolean(document.querySelector('[data-testid="veo-recent-picker"]')),
      cands: document.querySelectorAll('[data-testid^="veo-cand-"][data-gap]').length,
      gaps: [...document.querySelectorAll('[data-testid^="veo-cand-"][data-gap]')].map((e) => e.dataset.gap),
      uncoded: document.querySelectorAll('[data-testid="veo-cand-uncoded"]').length,
    }));
    console.log(`     PRUMC assign: ${JSON.stringify(opened)}`);
    is("Assign opens straight onto the day, with no picker", opened.picker, false);
    yes(`…offering ${opened.cands} camera matches`, opened.cands > 0, JSON.stringify(opened));
    await p.click(`${sel} [data-testid="veo-recent-assign"]`);
  }

  // ---- 4: no date at all → the picker ----
  {
    const { data: dateless } = await svc.from("veo_recordings").select(STORED)
      .eq("status", "queued").like("email_subject", NO_DATE_LIKE).order("received_at", { ascending: false }).limit(20);
    let id = null, sel = null;
    for (const r of nonEmpty(dateless, "queued rows with no date in the title")) {
      if (await p.$(`[data-recording-id="${r.id}"]`)) { id = r.id; sel = `[data-recording-id="${r.id}"]`; console.log(`     dateless row: "${r.email_subject.slice(0, 34)}"`); break; }
    }
    if (!id) { console.log("     (no dateless row on this page — picker not checked)"); }
    else {
      await p.click(`${sel} [data-testid="veo-recent-assign"]`);
      await p.waitForSelector('[data-testid="veo-recent-picker"]', { timeout: 30000 });
      const days = await p.$$eval('[data-testid="veo-recent-picker"] button', (els) => els.map((e) => e.textContent.trim()));
      console.log(`     untitled row offers: ${JSON.stringify(days)}`);
      yes("a row with no readable date gets a day picker", days.length >= 3, JSON.stringify(days));
      await p.click(`[data-testid="veo-recent-picker"] button`);
      await p.waitForSelector('[data-testid^="veo-cand-"][data-gap]', { timeout: 60000 });
      const after = await p.evaluate(() => ({
        cands: document.querySelectorAll('[data-testid^="veo-cand-"][data-gap]').length,
        gaps: [...document.querySelectorAll('[data-testid^="veo-cand-"][data-gap]')].map((e) => e.dataset.gap),
        nogap: document.querySelectorAll(".nogap").length,
      }));
      console.log(`     after picking a day: ${JSON.stringify(after)}`);
      yes("…and picking one lists that day's camera matches", after.cands > 0, JSON.stringify(after));
      /* AND THIS ROW IS THE NO-TIME CASE. "Match - MatchDay STL" carries neither a date nor a time,
       * so every candidate's distance is unknowable. It says so rather than claiming "0 min". */
      is("no candidate claims a zero gap when the title has no time", after.gaps.filter((g) => /^0 /.test(g)), []);
      is("…every one says the title has no time", after.nogap, after.cands);
      await p.click(`${sel} [data-testid="veo-recent-assign"]`);
    }
  }

  /* ITEM 5 IS COVERED IN THE PICKER BLOCK ABOVE, and the first attempt at it here was wrong: it
   * chose a row by its STORED parsed_time_minutes, and KESWICK's is null while the RE-READ gives it
   * 8:00 PM — so it was asserting "no time" against a row that has one. The rows with genuinely no
   * time are the ones with no date either, which is the dateless row already under test. */

  // ---- 7: the twins ----
  {
    const twinRows = await p.$$eval('[data-testid="veo-recent-twin"]', (els) => els.map((e) => e.textContent.trim()));
    console.log(`     twin notices on rows: ${JSON.stringify(twinRows)}`);
    yes("identical titles warn each other on the row", twinRows.length >= 2, JSON.stringify(twinRows));
    const { sel } = await rowFor(SUBJECTS[0]);
    await p.click(`${sel} [data-testid="veo-recent-assign"]`);
    await p.waitForSelector('[data-testid="veo-recent-twin-warn"]', { timeout: 30000 });
    ok("…and again when Assign opens");
    await p.waitForSelector('[data-testid^="veo-cand-"][data-gap]', { timeout: 60000 });
    await p.click('[data-testid^="veo-cand-"][data-gap] button');
    await p.waitForSelector('[data-testid="veo-confirm"]', { timeout: 30000 });
    const onConfirm = await p.$eval('[data-testid="veo-confirm-twin"]', (e) => e.textContent.trim()).catch(() => null);
    console.log(`     confirm warning: ${JSON.stringify(onConfirm)}`);
    yes("…and once more on the confirm", Boolean(onConfirm), "absent");
    // NOT BLOCKED: the button is live.
    is("the post button is enabled despite the warning", await p.$eval('[data-testid="veo-confirm-post"]', (e) => e.disabled), false);
    await p.click('[data-testid="veo-confirm"] button');   // Cancel
  }

  // ---- 8 & 10: nothing was written ----
  await p.waitForTimeout(1000);
  const after = await snap();
  console.log(`     queued after: ${after.queued}   ·  non-GET requests the page attempted: ${JSON.stringify(writes)}`);
  is("no stored field on those rows changed", after.rows, before.rows);
  is("the queued count is unchanged", after.queued, before.queued);
  is("the page attempted no write at all while rendering and browsing", writes, []);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("  XX  suite crashed:", e?.message ?? e); process.exit(2); });
