/* FIELD COVER PHOTOS, driven in the REAL panels (local mode only): the Fields drawer (/match-ops/fields) and the
 * Gameday Ops match panel (/match-ops/gameday). Items 2, 3 (the remove dialog and a played match), 4 and 9.
 *
 *   node --env-file=.env.local scripts/_check_field_covers.mjs
 *
 * Needs: the backend on http://localhost:3010 (feature/field-covers, FRESH seed), this Clubhouse under
 * `next dev -p 3012` with MATCHDAY_LOCAL_API=1 and NEXT_PUBLIC_MATCHDAY_LOCAL_API=1 (.env.development.local).
 * WRITES ONLY TO THE LOCAL SEED: in local mode the Clubhouse refuses staging and production. Every write is read back
 * from the local API (and, for who uses a cover, the local database) directly, not through the Clubhouse.
 *
 * DERIVE, DO NOT PIN: match ids, dates and counts come from the API or the local DB at run time.
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

// ── the local API and database, for read-backs ──
const tok = (await (await fetch(`${API}/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'Password123!' }) })).json()).accessToken;
const api = async (p) => (await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${tok}` } })).json();
const covers = (f) => api(`/admin/fields/${f}/covers`);
const matchCover = (m) => api(`/admin/matches/${m}/cover`);
// WHO USES A COVER comes from the LOCAL database: GET /admin/matches leaves out past matches unless fromDate is sent,
// and an earlier version of this script read "0 past" off that list and passed on an empty set.
const db = (q) => execFileSync('/opt/homebrew/opt/postgresql@16/bin/psql', ['-d', 'matchday_covers_local', '-Atc', q], { encoding: 'utf8' }).trim();
if (db('select current_database()') !== 'matchday_covers_local') throw new Error('local database only');
const ids = (q) => db(q).split(/\s+/).filter(Boolean).map(Number);
const usersOf = (coverId) => ids(`select id from matches where cover_id = ${Number(coverId)}`);
const wallDate = (id) => db(`select to_char(start_date, 'YYYY-MM-DD') from matches where id = ${Number(id)}`);

const PARMER = Number(db("select id from fields where title = 'Parmer'"));
const before = await covers(PARMER);
const NIGHT = before.covers.find((c) => c.name === 'Night games');
const WINTER = before.covers.find((c) => c.name === 'Winter league');

// ── the browser, signed in as Ryan (the repo's own helper: a magic-link session, nothing written) ──
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport: { width: 1600, height: 1100 } })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const shot = (name, loc) => (loc ?? p).screenshot({ path: `${SHOTS}/${name}.png` });
const verdictOf = async (testid, prev = '') => {
  await p.waitForFunction(([t, pv]) => { const x = document.querySelector(`[data-testid="${t}"]`)?.textContent ?? ''; return x !== pv && /^(LANDED|FAILED|UNKNOWN|NOT APPLIED|Not saved)/.test(x); }, [testid, prev], { timeout: 60000 });
  return p.$eval(D(testid), (e) => e.textContent);
};

const openFieldDrawer = async (fieldId) => {
  await p.goto(`${BASE}/match-ops/fields?field=${fieldId}`, { waitUntil: 'domcontentloaded' });
  // PRESENCE FIRST: the drawer is open on this field and its COVER PHOTOS section has loaded the Default card.
  await p.waitForSelector(`${D('fv-drawer')}[aria-hidden="false"] ${D('fc-field-covers')}[data-field-id="${fieldId}"] ${D('fc-default')}`, { timeout: 60000 });
};
const openGamedayMatch = async (matchId) => {
  await p.goto(`${BASE}/match-ops/gameday`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(D('day-pick'), { timeout: 60000 });
  await p.fill(D('day-pick'), wallDate(matchId));
  // The board folds sections (FINISHED starts collapsed): open every collapsed one so the row exists.
  await p.waitForSelector('[data-testid^="gday-sec-"]', { timeout: 30000 });
  for (const sec of await p.$$('[data-testid^="gday-sec-"][aria-expanded="false"]')) await sec.click();
  await p.waitForSelector(`${D('gday-row')}[data-id="${matchId}"]`, { timeout: 30000 });
  await p.click(`${D('gday-row')}[data-id="${matchId}"]`);
  await p.waitForSelector(`${D('gday-panel')} ${D('fc-match-cover')}[data-match-id="${matchId}"] ${D('fc-match-current')}`, { timeout: 30000 });
};

// ── The real Fields drawer ──
await openFieldDrawer(PARMER);
ok('-', (await p.$$(D('fc-cover'))).length === before.covers.length, `Fields drawer (real page) shows the API's ${before.covers.length} extra covers`);
ok('-', (await p.$$(D('fv-cover'))).length === 0, 'the old "Cover image" control is folded into COVER PHOTOS (not shown twice)');
ok('-', (await p.$$(D('fv-venue-local'))).length === 1, 'Venue & cost says it is off in local mode (production finance rows)');
await shot('01-fields-drawer-cover-photos', p.locator(D('fc-field-covers')));

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
const rn = await verdictOf('fc-msg');
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
ok('2', /^image\//.test((await fetch(urlAfter)).headers.get('content-type') ?? ''), 'the replaced image serves as an image');
await p.waitForFunction((id) => document.querySelector(`[data-testid="fc-cover"][data-cover-id="${id}"] [data-testid="fc-cover-name"]`)?.textContent === 'Rooftop lights Friday', NEW.id);
await shot('05-fields-drawer-after-add-rename-replace', p.locator(D('fc-field-covers')));

// ── 4. In the REAL Gameday Ops panel: set a cover on one match, then apply it to others in the slot ──
const target = ids(`select id from matches where field_id = ${PARMER} and cover_id is null and is_cancelled = false and start_date_utc > (now() at time zone 'utc') and to_char(start_date,'Dy HH24:MI') = (select to_char(start_date,'Dy HH24:MI') from matches where cover_id = ${WINTER.id} limit 1) order by start_date_utc limit 1`)[0];
ok('4', !!target, `an upcoming Default match in the same slot as a Winter league match, to start from: ${target}`);
await openGamedayMatch(target);
ok('4', (await p.$eval(D('fc-match-cover-name'), (e) => e.textContent)) === 'Default', `Gameday Ops panel (real page) shows match ${target} on Default`);
ok('4', /LOCAL/.test(await p.$eval(D('gameday-env'), (e) => e.textContent)), 'the board says LOCAL, not PRODUCTION');
await p.click(D('fc-match-change'));
const opts = await p.$$eval(D('fc-match-option'), (els) => els.map((e) => e.dataset.coverId));
ok('4', opts.length === list.covers.length + 1 && opts[0] === 'default', `Change lists Default + this field's ${list.covers.length} covers`);
await p.click(`${D('fc-match-option')}[data-cover-id="${NEW.id}"]`);
await shot('06-gameday-panel-cover-options', p.locator(D('fc-match-cover')));
await p.click(D('fc-match-save'));
const sv = await verdictOf('fc-match-msg');
const t1 = await matchCover(target);
ok('4', sv.startsWith('LANDED') && t1.cover?.id === NEW.id, `set: ${sv} — API: match ${target} on "${t1.cover?.name}"`);
await p.waitForSelector(D('fc-apply'));
const offer = await p.$$eval(D('fc-apply-row'), (els) => els.map((e) => ({ id: Number(e.dataset.matchId), checked: e.checked, label: e.closest('label').textContent })));
const slot = t1.sameSlotUpcoming.filter((m) => m.cover?.id !== NEW.id);
const onDefault = slot.filter((m) => m.cover === null).map((m) => m.id).sort();
const onOther = slot.filter((m) => m.cover !== null);
// POSITIVE CONTROL: both cases exist in this run, or the two assertions below could pass on an empty set.
ok('4', onDefault.length > 0 && onOther.length > 0, `the offer has both cases: on Default ${onDefault.join(', ')}; on another cover ${onOther.map((m) => `${m.id} (${m.cover.name})`).join(', ')}`);
ok('4', JSON.stringify(offer.map((o) => o.id).sort()) === JSON.stringify(slot.map((m) => m.id).sort()), `the offer is exactly the API's same-slot upcoming matches: ${offer.map((o) => o.id).join(', ')}`);
ok('4', onDefault.every((id) => offer.find((o) => o.id === id)?.checked === true), `matches on Default start TICKED: ${onDefault.join(', ')}`);
ok('4', onOther.every((m) => { const o = offer.find((x) => x.id === m.id); return o?.checked === false && o.label.includes(`now ${m.cover.name}`); }),
  `matches already on another cover start UNTICKED and show it: ${onOther.map((m) => `${m.id} "now ${m.cover.name}"`).join(', ')}`);
await shot('07-gameday-apply-offer', p.locator(D('fc-match-cover')));
await p.click(D('fc-apply-go'));
const ap = await verdictOf('fc-match-msg', sv);
const backDefault = await Promise.all(onDefault.map((id) => matchCover(id)));
const backOther = await Promise.all(onOther.map((m) => matchCover(m.id)));
ok('4', ap.startsWith('LANDED') && backDefault.every((x) => x.cover?.id === NEW.id), `apply: ${ap} — API: ${backDefault.map((x) => `${x.matchId}→${x.cover?.name}`).join(', ')}`);
ok('4', backOther.every((x, i) => x.cover?.id === onOther[i].cover.id), `the unticked match kept its cover: ${backOther.map((x) => `${x.matchId}→${x.cover?.name}`).join(', ')}`);
await shot('08-gameday-applied', p.locator(D('fc-match-cover')));
await p.click(D('fc-match-manage'));
await p.waitForSelector(`${D('fv-drawer')}[aria-hidden="false"] ${D('fc-field-covers')}[data-field-id="${PARMER}"]`, { timeout: 60000 });
ok('4', new URL(p.url()).pathname === '/match-ops/fields', `"Manage covers on the field" lands on the Fields drawer for field ${PARMER}`);

// ── 3 in the browser. The remove dialog: the new cover (upcoming only), then Night games (upcoming + past) ──
const removeFlow = async (cover, shotName, doneShot) => {
  const usage = await api(`/admin/field-covers/${cover.id}/usage`);
  await openFieldDrawer(PARMER);
  await p.click(`${D('fc-cover')}[data-cover-id="${cover.id}"] ${D('fc-remove')}`);
  await p.waitForSelector(D('fc-remove-count'));
  const shown = await p.$eval(D('fc-remove-count'), (e) => ({ n: Number(e.dataset.count), past: Number(e.dataset.past), text: e.textContent.trim() }));
  ok('3', shown.n === usage.upcomingMatches && shown.past === usage.pastMatches,
    `remove "${cover.name}" asks: "${shown.text}" (API: ${usage.upcomingMatches} upcoming, ${usage.pastMatches} past)`);
  await shot(shotName, p.locator(`${D('fc-cover')}[data-cover-id="${cover.id}"]`));
  const users = usersOf(cover.id);
  await p.click(D('fc-remove-go'));
  const res = await verdictOf('fc-msg');
  const after = await Promise.all(users.map((id) => matchCover(id)));
  const upBack = after.filter((x) => new Date(x.startDateUtc) > new Date());
  const pastBack = after.filter((x) => new Date(x.startDateUtc) <= new Date());
  // POSITIVE CONTROL: the sets the next assertion runs over are exactly the sizes the dialog announced.
  ok('3', upBack.length === shown.n && pastBack.length === shown.past, `read-back covers the dialog's ${shown.n} upcoming and ${shown.past} past matches (got ${upBack.length} and ${pastBack.length})`);
  ok('3', res.startsWith('LANDED') && upBack.every((x) => x.cover === null) && pastBack.every((x) => x.cover?.id === cover.id && x.cover?.removed === true),
    `removed: "${res}" — API: ${upBack.length} upcoming on Default, ${pastBack.length} past still on it (marked removed)`);
  ok('3', !(await covers(PARMER)).covers.some((c) => c.id === cover.id), `"${cover.name}" gone from the field's list`);
  await shot(doneShot, p.locator(D('fc-field-covers')));
  return pastBack;
};
await removeFlow({ id: NEW.id, name: 'Rooftop lights Friday' }, '09-remove-confirm-new-cover', '10-removed-new-cover');
const pastNight = await removeFlow(NIGHT, '11-remove-confirm-night-games', '12-removed-night-games');

// A played match that kept the removed cover, in the real Gameday Ops panel (a past day on the board).
const past = pastNight[0];
await openGamedayMatch(past.matchId);
const sub = await p.$eval(D('fc-match-cover-sub'), (e) => e.textContent);
const img = await p.$eval(`${D('fc-match-current')} img`, (e) => e.getAttribute('src'));
ok('3', /Removed from the field/.test(sub) && img === NIGHT.url, `played match ${past.matchId} in Gameday Ops: "${sub}", image is Night games`);
await shot('13-gameday-played-match-keeps-removed-cover', p.locator(D('fc-match-cover')));
ok('-', (await p.$$(D('gday-chat-local'))).length === 1, 'the panel\'s Chat tab says it is off in local mode (seed ids are real chat ids)');
await shot('14-gameday-panel-full', p.locator(D('gday-panel')));

ok('-', errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
await b.close();
console.log(`\n${pass} PASS · ${fail} FAIL`);
process.exit(fail ? 1 : 0);
