// ON DEMAND, READ ONLY: Match Ops › Offers, the Refresh button (2026-11-03). Opens the Offers page and nothing else.
// Run against the staging Clubhouse (npm run dev:offers-staging, port 3073):
//   node --env-file=.env.local scripts/e2e/check-offers-refresh.mjs
// Not a verify-* suite: the e2e lane runs against a server with no Offers config, where this page is a 404.
//
// THE BUG: a click reloaded the list, but a reload that brings back the same offers changes nothing on screen, and the
// button had an arrow cursor and no hover, so it read as not clickable. This checks the button looks live, that a click
// sends GET /api/offers, that it says Refreshing… while the read is held, and that the list and "Updated" redraw after.
import { chromium } from 'playwright';
import { storageStateFor } from './_session.mjs';

const BASE = process.env.OFFERS_BASE ?? 'http://localhost:3073';
if (!/^http:\/\/localhost:\d+$/.test(BASE)) { console.error('OFFERS_BASE must be http://localhost:<port>'); process.exit(1); }
let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`  ${ok ? 'ok' : 'XX'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`); };

const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const D = (t) => `[data-testid="${t}"]`;
try {
  await p.goto(`${BASE}/match-ops/offers`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // Presence first: the list rendered and the first read is stamped.
  await p.waitForSelector(D('offers-row'), { timeout: 120000 });
  await p.waitForFunction((s) => /^Updated /.test(document.querySelector(s)?.textContent ?? ''), D('offers-refreshed'), { timeout: 30000 });
  const first = await p.textContent(D('offers-refreshed'));
  const btn = p.locator(D('offers-refresh'));
  const look = await btn.evaluate((e) => ({ cursor: getComputedStyle(e).cursor, filter: getComputedStyle(e).filter, covered: (() => { const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !(t === e || e.contains(t)); })() }));
  await btn.hover(); await p.waitForTimeout(250);
  const hovered = await btn.evaluate((e) => getComputedStyle(e).filter);
  eq('the button looks live: pointer cursor, nothing on top of it, and a hover change', [look.cursor, look.covered, look.filter !== hovered], ['pointer', false, true]);

  // Hold the page read so the in-between state can be seen; count it.
  let hold = true, sent = 0; let answer = null;
  await p.waitForTimeout(1100); // a new stamp must differ by at least a second
  await p.route('**/api/offers', async (r) => { if (r.request().method() !== 'GET') return r.continue(); sent++; while (hold) await new Promise((x) => setTimeout(x, 100)); const res = await r.fetch(); answer = await res.json(); await r.fulfill({ response: res }); });
  await btn.click();
  await p.waitForFunction(() => document.querySelector('[data-testid="offers-refreshed"]')?.textContent === 'Refreshing…', null, { timeout: 10000 });
  eq('a click sends GET /api/offers, and while it runs the button is disabled and says Refreshing…', [sent, await btn.isDisabled(), await p.textContent(D('offers-refreshed'))], [1, true, 'Refreshing…']);
  hold = false;
  await p.waitForFunction((f) => { const t = document.querySelector('[data-testid="offers-refreshed"]')?.textContent ?? ''; return /^Updated /.test(t) && t !== f; }, first, { timeout: 30000 });
  const rows = await p.$$eval(D('offers-row'), (els) => els.map((e) => Number(e.getAttribute('data-id'))));
  eq('after: a newer Updated time, the button live again, and the list is the answer\'s campaigns', [await btn.isDisabled(), rows], [false, (answer?.campaigns ?? []).map((c) => c.id)]);
  eq('the answer held at least one offer (the control for the row comparison)', (answer?.campaigns ?? []).length > 0, true);
  eq('no page errors', errs, []);
} catch (e) {
  fail++; console.log(`  XX  harness: ${String(e.message).split('\n')[0]}`);
  await b.close(); process.exit(2);
}
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(pass === 0 || fail > 0 ? 1 : 0);
