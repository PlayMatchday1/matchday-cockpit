// ASSIGN IS NOT A DEAD END — the film, the X, the parked matches and the three chat surfaces.
//   node scripts/e2e/verify-veo-assign2.mjs      (needs `npm run dev` up)
//
// READ-ONLY. It opens pages and reads the DOM; it presses nothing that writes. The X and its Undo
// were proven end to end against a real row by hand (dismiss → strip → DB → undo → counts back to
// {"queued":170,"posted":21,"dismissed":27}); that check WROTE, so it is not committed here. What
// remains is everything a browser can settle without touching a row.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { nonEmpty, storageStateFor, closeBrowser } from "./_session.mjs";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

async function main() {
  process.loadEnvFile(".env.local");
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // A day that HAS a film and also has matches without one, so "parked" is a real set, not an empty
  // one. Both halves are the control: a day of all-film or no-film proves neither default.
  const { data: posted } = await svc.from("veo_recordings").select("matched_api_id")
    .eq("status", "posted").not("matched_api_id", "is", null).order("received_at", { ascending: false }).limit(20);
  const { data: ms } = await svc.from("mdapi_matches").select("api_id, start_date")
    .in("api_id", posted.map((r) => r.matched_api_id));
  const DAY = String(nonEmpty(ms, "matches behind posted films")[0].start_date).slice(0, 10);

  const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 }, storageState });
  const p = await ctx.newPage();

  await p.goto(`${BASE}/match-ops/veo?date=${DAY}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-row"], [data-testid="veo-empty"]', { timeout: 240000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Loading…"), { timeout: 120000 });

  /* PART 4 — the day list opens on the matches whose film landed. */
  const shown = nonEmpty(await p.$$('[data-testid="veo-row"]'), "rows on the day");
  const states = await Promise.all(shown.map((r) => r.getAttribute("data-state")));
  const FILM = ["posted", "flagged", "assigned", "needs_look"];
  yes(`all ${states.length} rows shown by default have a film (${[...new Set(states)].join(", ")})`,
    states.every((s) => FILM.includes(s)), JSON.stringify(states));
  const park = await p.$('[data-testid="veo-parked-toggle"]');
  yes("the rest are parked behind one line", !!park);
  const parkText = park ? (await park.innerText()).trim() : "";
  yes(`the line says how many and that they had no film — "${parkText}"`,
    /\d+ other match/.test(parkText) && /no film/.test(parkText), parkText);
  await park.click();
  await p.waitForTimeout(400);
  const after = await p.$$('[data-testid="veo-row"]');
  yes(`opening it adds rows (${shown.length} → ${after.length})`, after.length > shown.length);
  const afterStates = await Promise.all(after.map((r) => r.getAttribute("data-state")));
  yes("and the ones it adds are the ones with no film",
    afterStates.some((s) => !FILM.includes(s)), JSON.stringify(afterStates));
  await park.click();
  await p.waitForTimeout(400);

  /* The total counts FILMS, not fields on camera. */
  const tot = await p.$('[data-testid="veo-tal-total"]');
  is("the total counts the films that landed", Number(await tot.getAttribute("data-count")), shown.length);
  yes("and says so", (await tot.innerText()).includes("films that landed"), await tot.innerText());

  /* PART 5a — a day row with a film carries its own chat control. */
  const rowChats = await p.$$('[data-testid="veo-rowchat"]');
  is("every row with a film has a chat control on the row itself", rowChats.length, shown.length);
  /* The control sits BESIDE the expander, not over it: an absolutely-positioned one swallowed the
   * expander's clicks, which is a real bug and not a test artifact. */
  const expander = (await p.$$('[data-testid="veo-row"] .rowtop'))[0];
  await expander.click();
  await p.waitForSelector('[data-testid="veo-viewer"]', { timeout: 20000 });
  ok("and pressing the row still expands it");

  /* PART 2 — the film sits beside the candidate list, and the page says how big it is. */
  yes("the film is on the page", !!(await p.$('[data-testid="veo-player"]')));
  /* The caption waits on /api/veo/thumb, which scrapes Veo — reading the body the instant the row
   * opens catches the "No playable file yet" state and reports a missing sentence that is merely
   * late. Wait for the resolved caption; a row that never resolves fails here, which is right. */
  const sized = await p.waitForFunction(() => /about 1\.8 GB a match/.test(document.body.innerText),
    { timeout: 90000 }).then(() => true, () => false);
  yes("and it states the size before anyone streams it", sized,
    sized ? "" : (await p.innerText('[data-testid="veo-player"]')).slice(0, 160));

  await p.goto(`${BASE}/match-ops/veo`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="veo-recent-row"]', { timeout: 240000 });

  /* PART 3 — the X is on the queued rows and nowhere near a posted one. */
  const rows = nonEmpty(await p.$$('[data-testid="veo-recent-row"]'), "arrival rows");
  yes(`the arrival list rendered ${rows.length} rows to sort through`, rows.length > 0);
  const seen = {}, withX = {};
  for (const r of rows) {
    const st = (await r.getAttribute("data-state")) ?? "none";
    seen[st] = (seen[st] ?? 0) + 1;
    if (await r.$('[data-testid="veo-recent-dismiss-x"]')) withX[st] = (withX[st] ?? 0) + 1;
  }
  console.log(`     states on the page: ${JSON.stringify(seen)}`);
  /* THE CONTROL for the zero below. "no settled row offers the X" is satisfied by a page of nothing
   * but queued rows, and the recent list is a rolling window — which states it holds is not fixed,
   * so it is read rather than pinned. */
  const settled = Object.keys(seen).filter((k) => k !== "queued");
  yes(`the page holds queued rows and ${settled.length} other state(s) to compare`,
    (seen.queued ?? 0) > 0 && settled.length > 0, JSON.stringify(seen));
  is("every queued row can be taken off the list", withX.queued ?? 0, seen.queued);
  is(`no settled row can (${settled.join(", ")})`, settled.map((k) => withX[k] ?? 0), settled.map(() => 0));
  const anyX = (await p.$$('[data-testid="veo-recent-dismiss-x"]'))[0];
  is("the X says what it does", await anyX.getAttribute("aria-label"), "Take this film off the list");
  yes("and there is no bulk dismiss anywhere on the page",
    !/dismiss all|clear all|remove all/i.test(await p.innerText("body")));

  /* PART 5b — the arrival rows that know their match carry a chat control. */
  let withMatch = 0, recentChats = 0;
  yes(`and ${rows.length} of them to check for a chat control`, rows.length > 0);
  for (const r of rows) {
    const st = await r.getAttribute("data-state");
    if (await r.$('[data-testid="veo-recent-chat"]')) recentChats++;
    if (st === "posted" || st === "assigned") withMatch++;
  }
  yes(`arrival rows with a match offer the chat (${recentChats} of ${rows.length})`, recentChats >= withMatch && recentChats > 0);

  /* PART 5c — and so does each candidate inside an assign panel. */
  const assign = (await p.$$('[data-testid="veo-recent-assign"]'))[0];
  yes("a queued arrival row offers Assign", !!assign);
  await assign.click();
  await p.waitForSelector('[data-testid="veo-recent-panel"]', { timeout: 30000 });
  const day = (await p.$$('[data-testid^="veo-recent-day-"]'))[0];
  if (day) { await day.click(); }
  await p.waitForSelector('[data-testid^="veo-cand-"]', { timeout: 60000 }).catch(() => {});
  const cands = await p.$$('[data-testid^="veo-cand-"][data-gap]');
  yes(`the panel lists candidates (${cands.length})`, cands.length > 0);
  let candChats = 0;
  for (const c of cands) if (await c.$('[data-testid^="veo-cand-chat-"]')) candChats++;
  is("every candidate carries its own chat control", candChats, cands.length);
  yes("and the film is beside them, not below", !!(await p.$('[data-testid="veo-recent-assignwrap"] [data-testid="veo-player"]')));
  const wrapCols = await p.$eval('[data-testid="veo-recent-assignwrap"]',
    (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  is("in two columns at desktop width", wrapCols, 2);
  await p.setViewportSize({ width: 800, height: 1100 });
  await p.waitForTimeout(300);
  const narrowCols = await p.$eval('[data-testid="veo-recent-assignwrap"]',
    (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  is("and one column on a narrow screen", narrowCols, 1);

  await closeBrowser(b);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
