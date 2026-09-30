/* DRIVES ALL THREE MEMBERSHIP WRITES AGAINST **STAGING**, through the real routes.
 *
 * It creates its OWN subscription with the add endpoint, then re-prices and ends THAT one. It
 * never touches production: every call carries env=staging, and the candidate is found on staging.
 */
try { process.loadEnvFile('.env.local'); } catch {}
import { sessionFor } from './e2e/_session.mjs';
const BASE = process.env.BASE || 'http://localhost:3001';
const KIND = process.env.KIND || 'free';
const s = await sessionFor('rmancuso@playmatchday.com');
const H = { Authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' };
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); c ? pass++ : fail++; };
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300) }; } };

const look = async (id) => {
  const r = await fetch(`${BASE}/api/lookup/staging?id=${id}`, { headers: H, cache: 'no-store' });
  return r.ok ? J(r) : null;
};

// ── FIND A STAGING PLAYER WITH NO LIVE MEMBERSHIP ────────────────────────────────────────────
let target = null;
for (const id of (process.env.IDS || '569,570,571,572,573,574,575,576,577,578,580,581,582,583,584').split(',')) {
  const p = await look(id.trim());
  const m = p?.membership ?? null;
  const st = String(m?.statusRaw ?? '').toUpperCase();
  const live = m && (st === 'ACTIVE' || st === 'ADDED_FROM_ADMIN');
  console.log(`  staging player ${id.trim()}: ${p ? (m ? `membership ${m.id} ${m.statusRaw}` : 'no membership') : 'not found'}`);
  if (p && !live) { target = { id: Number(id.trim()), name: p?.player?.name ?? `player ${id}`, had: m }; break; }
}
if (!target) { console.log('\nNo staging player without a live membership in the scanned range. Widen IDS=.'); process.exit(2); }
console.log(`\nUSING STAGING PLAYER ${target.id} (${target.name})\n`);

// ── 1. ADD (comp) ────────────────────────────────────────────────────────────────────────────
let r = await fetch(`${BASE}/api/matchday/staging/memberships/add`, {
  method: 'POST', headers: H, body: JSON.stringify({ playerId: target.id, kind: KIND, playerName: target.name }) });
let j = await J(r);
ok(r.ok, `ADD comp -> HTTP ${r.status} ${j.status ?? ''} ${j.error ?? ''}`);
ok(j.status === 'LANDED', `  applied predicate says LANDED (${j.status})`);
ok(String(j.membership?.statusRaw).toUpperCase() === (KIND === 'free' ? 'ACTIVE' : 'ADDED_FROM_ADMIN'),
  `  and the row reads the expected status (${j.membership?.statusRaw})`);
ok(KIND === 'free' ? !!j.membership?.stripeSubscriptionId : !j.membership?.stripeSubscriptionId,
  `  CONTROL: the Stripe id is ${KIND === 'free' ? 'present' : 'absent'} as the kind implies (${j.membership?.stripeSubscriptionId ?? 'none'})`);
const subId = j.membership?.id;
console.log(`  created subscription id ${subId}, amount ${j.membership?.price} cents\n`);

// ── 2. REFUSALS, WHICH ARE OURS AND NOT THE API'S ────────────────────────────────────────────
r = await fetch(`${BASE}/api/matchday/staging/memberships/${subId}/end`, {
  method: 'POST', headers: H, body: JSON.stringify({ playerId: target.id, reason: '   ' }) });
j = await J(r);
ok(r.status === 400 && /reason is required/i.test(j.error ?? ''), `whitespace is refused as a reason (HTTP ${r.status}: ${j.error})`);
// cancel-subscription-dto is @IsString() only, so the API itself would have taken "".

r = await fetch(`${BASE}/api/matchday/staging/memberships/${subId}/price`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ playerId: target.id, cents: -100 }) });
j = await J(r);
ok(r.status === 409 && /negative/i.test(j.error ?? ''), `a negative price is refused (HTTP ${r.status}: ${j.error})`);

r = await fetch(`${BASE}/api/matchday/staging/memberships/add`, {
  method: 'POST', headers: H, body: JSON.stringify({ playerId: target.id, kind: KIND }) });
j = await J(r);
ok(r.status === 409 && /already holds/i.test(j.error ?? ''), `a second add is refused while one is live (HTTP ${r.status})`);

// ── 3. PRICE ─────────────────────────────────────────────────────────────────────────────────
r = await fetch(`${BASE}/api/matchday/staging/memberships/${subId}/price`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ playerId: target.id, cents: 1234, playerName: target.name }) });
j = await J(r);
/* ── LEFT FAILING ON PURPOSE, WITH THE REFUSAL NAMED ────────────────────────────────────────
 * STAGING REFUSES THIS and the refusal is real, not ours:
 *   HTTP 400 "This customer has no attached payment source or default payment method."
 * The free add creates a Stripe customer with no card, and updatePriceForSubscription calls
 * stripe.subscriptions.update, which Stripe rejects for a customer with no payment source. So a
 * subscription this script is allowed to create cannot then be re-priced on staging.
 * The alternative — re-pricing somebody else's live staging subscription and putting it back — is
 * the "edit the live world and promise to restore it" pattern this repo forbids, so it was not done.
 * PRICE is therefore VERIFIED as far as our own refusals and the outbound call, and UNVERIFIED for
 * a successful round trip. */
ok(r.ok, `PRICE -> HTTP ${r.status} ${j.status ?? ''} ${(j.error ?? '').slice(0, 120)}`);
ok(j.status === 'LANDED', `  applied says LANDED (${j.status})`);
ok(j.membership?.price === 1234, `  and the row carries 1234 cents (${j.membership?.price})`);
ok(['absent','moved','unchanged','unreadable'].includes(j.verdict?.stripe), `  Stripe read reported: ${j.verdict?.stripe}`);
console.log(`  message: ${j.message}\n`);

r = await fetch(`${BASE}/api/matchday/staging/memberships/${subId}/price`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ playerId: target.id, cents: 1234 }) });
j = await J(r);
ok(r.status === 409 && /already the price/i.test(j.error ?? ''), `  a no-op re-price is refused rather than sent (HTTP ${r.status})`);

// ── 4. END ───────────────────────────────────────────────────────────────────────────────────
r = await fetch(`${BASE}/api/matchday/staging/memberships/${subId}/end`, {
  method: 'POST', headers: H, body: JSON.stringify({ playerId: target.id, reason: 'Clubhouse staging verification', playerName: target.name }) });
j = await J(r);
ok(r.ok, `END -> HTTP ${r.status} ${j.status ?? ''} ${j.error ?? ''}`);
ok(j.status === 'LANDED', `  applied says LANDED (${j.status})`);
/* THE ROW IS GONE, NOT CANCELED, AND THAT IS THE ESTABLISHED BEHAVIOUR. users.repository.ts
 * includes userSubscriptions with `status in [ACTIVE] AND currentPeriodEnd >= now`, so a cancelled
 * row drops out of GET /admin/players/{id} entirely. Asserting CANCELED here would be asserting a
 * shape this API never returns; presence-then-absence is what the route's `applied` reads. */
ok(j.membership == null, `  and the row has dropped out of the player payload, which is what ending looks like here (${JSON.stringify(j.membership)})`);
ok(['absent','moved','unchanged','unreadable'].includes(j.verdict?.stripe), `  Stripe read reported: ${j.verdict?.stripe}`);
ok(!/nothing further will be charged/i.test(j.message ?? ''), '  CONTROL: the message does not claim a charge stopped');
console.log(`  message: ${j.message}\n`);

// ── 5. A CLOSED ROW CANNOT BE RE-PRICED — the API would allow it; we do not ───────────────────
r = await fetch(`${BASE}/api/matchday/staging/memberships/${subId}/price`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ playerId: target.id, cents: 999 }) });
j = await J(r);
/* REFUSED EITHER WAY, and on this API it is a 404 rather than a 409: the cancelled row is no longer
 * in the payload, so the route cannot find it to call it closed. Both are refusals and both stop
 * the write — updateSubscriptionPrice has no status filter and would have answered `true`. */
ok((r.status === 404 || r.status === 409) && !/^2/.test(String(r.status)),
  `an ended membership cannot be re-priced (HTTP ${r.status}: ${j.error})`);

r = await fetch(`${BASE}/api/matchday/staging/memberships/add`, {
  method: 'POST', headers: H, body: JSON.stringify({ playerId: target.id, kind: KIND }) });
j = await J(r);
ok(r.ok, `  CONTROL: a closed membership CAN be reopened — CANCELED blocks neither add (HTTP ${r.status})`);
if (j.membership?.id) {
  await fetch(`${BASE}/api/matchday/staging/memberships/${j.membership.id}/end`, {
    method: 'POST', headers: H, body: JSON.stringify({ playerId: target.id, reason: 'Clubhouse staging verification cleanup' }) });
  console.log(`  cleaned up reopened subscription ${j.membership.id}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
