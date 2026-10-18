/* FIELD COVER PHOTOS, driven in the browser (local mode only). Items 2, 4, 9 and the remove dialog.
 *
 *   node --env-file=.env.local scripts/_check_field_covers.mjs
 *
 * Needs: the backend on http://localhost:3010 (feature/field-covers, fresh seed), this Clubhouse under `next dev
 * -p 3012` with MATCHDAY_LOCAL_API=1. WRITES ONLY TO THE LOCAL SEED (the Clubhouse refuses anything else in local
 * mode). Every write is read back from the local API directly, not through the Clubhouse. Screenshots go to SHOTS.
 *
 * DERIVE, DO NOT PIN: match ids and counts come from the API at run time, never from the seed's ids.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();

const BASE = 'http://localhost:3012';
const API = 'http://localhost:3010';
if (new URL(API).host !== 'localhost:3010' || new URL(BASE).host !== 'localhost:3012') throw new Error('local only');
const SHOTS = process.env.SHOTS ?? '/tmp';
const IMG_SQUARE = process.env.IMG_SQUARE, IMG_TALL = process.env.IMG_TALL;

let pass = 0, fail = 0;
const ok = (item, c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  [${item}] ${m}`); c ? pass++ : fail++; };
const D = (t) => `[data-testid="${t}"]`;

// ── the local API, for read-backs ──
const tok = (await (await fetch(`${API}/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'Password123!' }) })).json()).accessToken;
const api = async (p) => (await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${tok}` } })).json();
const covers = (f) => api(`/admin/fields/${f}/covers`);
// WHO USES A COVER comes from the LOCAL database: GET /admin/matches leaves out every past match unless fromDate is
// sent, and an earlier run of this script read "0 past" off that list and passed on an empty set.
const db = (q) => execFileSync('/opt/homebrew/opt/postgresql@16/bin/psql', ['-d', 'matchday_covers_local', '-Atc', q], { encoding: 'utf8' }).trim();
if (db('select current_database()') !== 'matchday_covers_local') throw new Error('local database only');
const usersOf = (coverId) => db(`select id from matches where cover_id = ${Number(coverId)}`).split(/\s+/).filter(Boolean).map(Number);
const matchCover = (m) => api(`/admin/matches/${m}/cover`);
const fieldsList = await api('/admin/fields?limit=50');
const PARMER = (Array.isArray(fieldsList) ? fieldsList : fieldsList.data).find((f) => f.title === 'Parmer').id;
const before = await covers(PARMER);
const NIGHT = before.covers.find((c) => c.name === 'Night games');

// ── the browser, signed in as Ryan (the repo's own helper: a magic-link session, nothing written) ──
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport: { width: 1500, height: 1100 } })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const shot = (name, loc) => (loc ?? p).screenshot({ path: `${SHOTS}/${name}.png` });

await p.goto(`${BASE}/match-ops/field-covers?field=${PARMER}`, { waitUntil: 'domcontentloaded' });
// PRESENCE FIRST: the section, its Default card and the seeded covers, before any absence or count is read.
await p.waitForSelector(`${D('fc-field-covers')}[data-field-id="${PARMER}"] ${D('fc-default')}`, { timeout: 60000 });
await p.waitForSelector(`${D('fc-cover')}[data-cover-id="${NIGHT.id}"]`, { timeout: 20000 });
ok('-', (await p.$$(D('fc-cover'))).length === before.covers.length, `field panel shows the API's ${before.covers.length} extra covers`);
await shot('01-field-panel');

// ── 9. Crop previews: the Default shows all four shapes ──
const previewCheck = async (expectKeys, label) => {
  await p.waitForSelector(D('fc-previews'));
  await p.waitForFunction(() => document.querySelector('[data-testid="fc-safe-guide"]'));
  const shapes = await p.$$eval(D('fc-shape'), (els) => els.map((e) => {
    const f = e.querySelector('.fc-frame').getBoundingClientRect();
    return { key: e.dataset.shape, w: f.width, h: f.height, bg: getComputedStyle(e.querySelector('.fc-frame')).backgroundImage };
  }));
  const want = { card: 358 / 214.5, header: 4 / 3, partners: 0.55 / 0.34, share: 1200 / 630 };
  ok('9', JSON.stringify(shapes.map((s) => s.key)) === JSON.stringify(expectKeys), `${label}: shapes ${shapes.map((s) => s.key).join(', ')}`);
  for (const s of shapes) ok('9', s.w > 50 && Math.abs(s.w / s.h - want[s.key]) < 0.02 && s.bg.startsWith('url("blob:'),
    `${label}: ${s.key} frame ${s.w.toFixed(0)}×${s.h.toFixed(0)} (ratio ${(s.w / s.h).toFixed(3)}, want ${want[s.key].toFixed(3)}), image set`);
  const g = await p.$eval(D('fc-safe-guide'), (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, text: e.textContent }; });
  ok('9', g.w > 10 && g.h > 10 && /Keep text in the center/.test(g.text), `${label}: "keep text in the center" guide drawn (${g.w.toFixed(0)}×${g.h.toFixed(0)})`);
};
await p.click(D('fc-default-replace'));
await p.setInputFiles(D('fc-file'), IMG_TALL);
await previewCheck(['card', 'header', 'partners', 'share'], 'Default, tall image');
await shot('02-default-replace-previews', p.locator('.fc-modal'));
await p.click(D('fc-upload-save'));
await p.waitForSelector(D('fc-upload-verdict'), { timeout: 60000 });
const dv = await p.$eval(D('fc-upload-verdict'), (e) => e.dataset.verdict);
const afterDefault = await covers(PARMER);
ok('2', dv === 'LANDED' && afterDefault.default.url !== before.default.url, `Default replaced: ${dv}; API Default url changed`);
await p.click(D('fc-upload-done'));

// ── 2. Add, rename, replace, remove, each read back from the API ──
await p.click(D('fc-add'));
await p.fill(D('fc-name'), 'Rooftop lights');
await p.setInputFiles(D('fc-file'), IMG_SQUARE);
await previewCheck(['card', 'header', 'share'], 'extra cover, square image (no Field Partners card)');
await shot('03-add-cover-previews', p.locator('.fc-modal'));
await p.click(D('fc-upload-save'));
await p.waitForSelector(D('fc-upload-verdict'), { timeout: 60000 });
const av = await p.$eval(D('fc-upload-verdict'), (e) => ({ v: e.dataset.verdict, t: e.textContent }));
await shot('04-add-cover-landed', p.locator('.fc-modal'));
await p.click(D('fc-upload-done'));
let list = await covers(PARMER);
const NEW = list.covers.find((c) => c.name === 'Rooftop lights');
ok('2', av.v === 'LANDED' && !!NEW, `add: ${av.t} — API lists "Rooftop lights" as cover ${NEW?.id}`);

await p.waitForSelector(`${D('fc-cover')}[data-cover-id="${NEW.id}"]`);
await p.click(`${D('fc-cover')}[data-cover-id="${NEW.id}"] ${D('fc-rename')}`);
await p.fill(D('fc-rename-input'), 'Rooftop lights Friday');
await p.click(D('fc-rename-save'));
await p.waitForFunction(() => /LANDED|FAILED|UNKNOWN|NOT APPLIED|Not saved/.test(document.querySelector('[data-testid="fc-msg"]')?.textContent ?? ''));
const rn = await p.$eval(D('fc-msg'), (e) => e.textContent);
list = await covers(PARMER);
ok('2', rn.startsWith('LANDED') && list.covers.find((c) => c.id === NEW.id)?.name === 'Rooftop lights Friday', `rename: ${rn} — API name "${list.covers.find((c) => c.id === NEW.id)?.name}"`);

const urlBefore = list.covers.find((c) => c.id === NEW.id).url;
await p.click(`${D('fc-cover')}[data-cover-id="${NEW.id}"] ${D('fc-replace')}`);
await p.setInputFiles(D('fc-file'), IMG_TALL);
await p.waitForSelector(D('fc-previews'));
await p.click(D('fc-upload-save'));
await p.waitForSelector(D('fc-upload-verdict'), { timeout: 60000 });
const rv = await p.$eval(D('fc-upload-verdict'), (e) => ({ v: e.dataset.verdict, t: e.textContent }));
await p.click(D('fc-upload-done'));
list = await covers(PARMER);
const urlAfter = list.covers.find((c) => c.id === NEW.id).url;
ok('2', rv.v === 'LANDED' && urlAfter !== urlBefore, `replace: ${rv.t} — API url changed`);
const imgOk = (await fetch(urlAfter)).headers.get('content-type');
ok('2', /^image\//.test(imgOk ?? ''), `replaced image serves as ${imgOk}`);
await p.waitForFunction((id) => document.querySelector(`[data-testid="fc-cover"][data-cover-id="${id}"] [data-testid="fc-cover-name"]`)?.textContent === 'Rooftop lights Friday', NEW.id);
await shot('05-field-panel-after-add-rename-replace');

// ── 4. Set a cover on one match, then apply it to the others in the slot ──
const rows = (await api(`/admin/matches?limit=200`)).data.filter((m) => m.fieldId === PARMER && !m.isCancelled && new Date(m.startDateUtc) > new Date());
const tue = rows.filter((m) => m.name === 'Tuesday 7v7' && !m.coverId).sort((a, c) => new Date(a.startDateUtc) - new Date(c.startDateUtc));
const target = tue[0];
ok('4', !!target, `an upcoming Default Tuesday at Parmer to start from: match ${target?.id}`);
await p.click(D('fcl-refresh'));
await p.click(`${D('fcl-match')}[data-match-id="${target.id}"]`);
await p.waitForSelector(`${D('fc-match-cover')}[data-match-id="${target.id}"] ${D('fc-match-current')}`);
ok('4', (await p.$eval(D('fc-match-cover-name'), (e) => e.textContent)) === 'Default', 'match panel shows Default before');
await p.click(D('fc-match-change'));
const opts = await p.$$eval(D('fc-match-option'), (els) => els.map((e) => e.textContent));
ok('4', opts.length === list.covers.length + 1 && /^Default/.test(opts[0]), `Change lists Default + this field's ${list.covers.length} covers: ${opts.map((o) => o.split('Cover for')[0].split("The field's")[0]).join(' | ')}`);
await p.click(`${D('fc-match-option')}[data-cover-id="${NEW.id}"]`);
await shot('06-match-cover-options', p.locator(D('fcl-match-panel')));
await p.click(D('fc-match-save'));
await p.waitForFunction(() => /LANDED|FAILED|UNKNOWN|NOT APPLIED|Not saved/.test(document.querySelector('[data-testid="fc-match-msg"]')?.textContent ?? ''));
const sv = await p.$eval(D('fc-match-msg'), (e) => e.textContent);
const t1 = await matchCover(target.id);
ok('4', sv.startsWith('LANDED') && t1.cover?.id === NEW.id, `set: ${sv} — API: match ${target.id} on "${t1.cover?.name}"`);
await p.waitForSelector(D('fc-apply'));
const offer = await p.$$eval(D('fc-apply-row'), (els) => els.map((e) => ({ id: Number(e.dataset.matchId), checked: e.checked })));
const expectIds = t1.sameSlotUpcoming.filter((m) => m.cover?.id !== NEW.id).map((m) => m.id).sort();
ok('4', JSON.stringify(offer.map((o) => o.id).sort()) === JSON.stringify(expectIds) && offer.every((o) => o.checked) && offer.length > 0,
  `apply offer = the API's same-slot upcoming matches ${expectIds.join(', ')}, all ticked`);
await shot('07-apply-to-other-matches', p.locator(D('fcl-match-panel')));
await p.click(D('fc-apply-go'));
await p.waitForFunction((prev) => { const t = document.querySelector('[data-testid="fc-match-msg"]')?.textContent ?? ''; return t !== prev && /^(LANDED|FAILED|UNKNOWN|NOT APPLIED|Not saved)/.test(t); }, sv, { timeout: 30000 });
const ap = await p.$eval(D('fc-match-msg'), (e) => e.textContent);
const backs = await Promise.all(expectIds.map((id) => matchCover(id)));
ok('4', ap.startsWith('LANDED') && backs.every((x) => x.cover?.id === NEW.id), `apply: ${ap} — API: ${backs.map((x) => `${x.matchId}→${x.cover?.name}`).join(', ')}`);
await shot('08-applied', p.locator(D('fcl-match-panel')));

// ── 3 in the browser. The remove dialog: the new cover (upcoming only), then Night games (upcoming + past) ──
const removeFlow = async (cover, shotName, doneShot) => {
  const usage = await api(`/admin/field-covers/${cover.id}/usage`);
  await p.click(D('fcl-refresh'));
  await p.waitForSelector(`${D('fc-cover')}[data-cover-id="${cover.id}"] ${D('fc-remove')}`);
  await p.click(`${D('fc-cover')}[data-cover-id="${cover.id}"] ${D('fc-remove')}`);
  await p.waitForSelector(D('fc-remove-count'));
  const shown = await p.$eval(D('fc-remove-count'), (e) => ({ n: Number(e.dataset.count), past: Number(e.dataset.past), text: e.textContent.trim() }));
  ok('3', shown.n === usage.upcomingMatches && shown.past === usage.pastMatches,
    `remove "${cover.name}" asks: "${shown.text}" (API: ${usage.upcomingMatches} upcoming, ${usage.pastMatches} past)`);
  await shot(shotName, p.locator(`${D('fc-cover')}[data-cover-id="${cover.id}"]`));
  const users = usersOf(cover.id);
  await p.click(D('fc-remove-go'));
  await p.waitForFunction(() => /^(LANDED|FAILED|UNKNOWN|NOT APPLIED|Not saved)/.test(document.querySelector('[data-testid="fc-msg"]')?.textContent ?? ''), null, { timeout: 30000 });
  const res = await p.$eval(D('fc-msg'), (e) => e.textContent);
  const after = await Promise.all(users.map((id) => matchCover(id)));
  const upBack = after.filter((x) => new Date(x.startDateUtc) > new Date());
  const pastBack = after.filter((x) => new Date(x.startDateUtc) <= new Date());
  // POSITIVE CONTROL: the sets the next assertion runs over are exactly the sizes the dialog announced.
  ok('3', upBack.length === shown.n && pastBack.length === shown.past, `read-back covers the dialog's ${shown.n} upcoming and ${shown.past} past matches (got ${upBack.length} and ${pastBack.length})`);
  ok('3', res.startsWith('LANDED') && upBack.every((x) => x.cover === null) && pastBack.every((x) => x.cover?.id === cover.id && x.cover?.removed === true),
    `removed: "${res}" — API: ${upBack.length} upcoming on Default, ${pastBack.length} past still on it (marked removed)`);
  ok('3', !(await covers(PARMER)).covers.some((c) => c.id === cover.id), `"${cover.name}" gone from the field's list`);
  await shot(doneShot);
  return pastBack;
};
await removeFlow({ id: NEW.id, name: 'Rooftop lights Friday' }, '09-remove-confirm-new-cover', '10-removed-new-cover');
// The match panel beside it (still on match ${target.id}) reloads: its cover was just removed, so it reads Default.
await p.waitForFunction((id) => document.querySelector(`[data-testid="fc-match-cover"][data-match-id="${id}"] [data-testid="fc-match-cover-name"]`)?.textContent === 'Default', target.id, { timeout: 15000 }).catch(() => {});
const panelName = await p.$eval(`${D('fc-match-cover')}[data-match-id="${target.id}"] ${D('fc-match-cover-name')}`, (e) => e.textContent);
ok('3', panelName === 'Default' && (await matchCover(target.id)).cover === null, `match panel for ${target.id} reloads to "${panelName}" after its cover is removed (API agrees)`);
const pastNight = await removeFlow(NIGHT, '11-remove-confirm-night-games', '12-removed-night-games');

// A played match that kept the removed cover, as the match panel shows it.
await p.click(D('fcl-refresh'));
const past = pastNight[0];
await p.click(`${D('fcl-match')}[data-match-id="${past.matchId}"]`);
await p.waitForSelector(`${D('fc-match-cover')}[data-match-id="${past.matchId}"] ${D('fc-match-cover-sub')}`);
const sub = await p.$eval(D('fc-match-cover-sub'), (e) => e.textContent);
const img = await p.$eval(`${D('fc-match-current')} img`, (e) => e.getAttribute('src'));
ok('3', /Removed from the field/.test(sub) && img === NIGHT.url, `past match ${past.matchId} panel: "${sub}", image is Night games`);
await shot('13-past-match-keeps-removed-cover', p.locator(D('fcl-match-panel')));

ok('-', errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
await b.close();
console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
