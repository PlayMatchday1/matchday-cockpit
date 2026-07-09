// Read-only audit of how the Stripe sync would categorize non-standard
// payment types for Apr 1-14, 2026. Does NOT write to fin_revenue.
// Mirrors the exact classification logic in
// src/lib/stripeSync.ts + src/lib/financeImport.ts (looksLikeMembership,
// isStrikeCharge) so the buckets reflect what production would do.

import Stripe from "stripe";
import { readFileSync } from "node:fs";

const envText = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const envVars = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) envVars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const stripeKey = envVars.STRIPE_SECRET_KEY;
if (!stripeKey) throw new Error("STRIPE_SECRET_KEY missing from .env.local");
const stripe = new Stripe(stripeKey);

// Inclusive Apr 1-14, 2026 in UTC (matches charge.created semantics)
const since = Math.floor(Date.UTC(2026, 3, 1) / 1000);            // Apr 1, 2026 00:00 UTC
const until = Math.floor(Date.UTC(2026, 3, 15) / 1000) - 1;       // Apr 14, 2026 23:59:59 UTC

// === Mirror of production classifiers ===
function isStrikeCharge(stripeType) {
  return stripeType !== null && stripeType.toLowerCase().includes("strike");
}
function looksLikeMembership(stripeType, description, cityIdentifier) {
  if (stripeType) {
    const t = stripeType.toLowerCase();
    if (/subscription|membership/.test(t)) return true;
    if (/match|dpp/.test(t)) return false;
  }
  if (!cityIdentifier) return true;
  if (description && /subscription|membership/i.test(description)) return true;
  return false;
}
function classify(meta, description) {
  const t = (typeof meta.type === "string" && meta.type.trim()) ? meta.type.trim() : null;
  const ci = (typeof meta.cityIdentifier === "string" && meta.cityIdentifier.trim()) ? meta.cityIdentifier.trim() : null;
  if (isStrikeCharge(t)) return "Strike";
  if (looksLikeMembership(t, description, ci)) return "Membership";
  return "DPP";
}

// === Pull all charges in window (no status filter — we want non-paid too) ===
const params = {
  created: { gte: since, lte: until },
  limit: 100,
};
const all = [];
for await (const c of stripe.charges.list(params)) {
  all.push(c);
}
console.log(`Fetched ${all.length} charges Apr 1-14 (UTC).\n`);

// === Buckets to count ===
function tagsFor(meta) {
  const tags = [];
  if (meta.captainDivisionId) tags.push("captain");
  if (meta.teamName || meta.teamId || meta.playerTeamId) tags.push("team");
  if (meta.guestUserMatchId) tags.push("guest_match");
  // "Special event" — no canonical metadata key per the user; flag explicitly-named ones
  if (typeof meta.type === "string" && /event/i.test(meta.type)) tags.push("special_event");
  return tags;
}

const samples = { captain: [], team: [], guest_match: [], special_event: [] };
const totals = {
  captain: { count: 0, gross: 0, buckets: new Map(), skipped: 0 },
  team: { count: 0, gross: 0, buckets: new Map(), skipped: 0 },
  guest_match: { count: 0, gross: 0, buckets: new Map(), skipped: 0 },
  special_event: { count: 0, gross: 0, buckets: new Map(), skipped: 0 },
};

let totalSkippedNonPaid = 0;
let totalSkippedNonUsd = 0;
let totalSucceededUsd = 0;
const skippedWithTags = [];

for (const c of all) {
  const meta = c.metadata ?? {};
  const tags = tagsFor(meta);
  const isSkippedNonPaid = c.status !== "succeeded";
  const isNonUsd = !isSkippedNonPaid && c.currency?.toLowerCase() !== "usd";
  if (isSkippedNonPaid) totalSkippedNonPaid++;
  else if (isNonUsd) totalSkippedNonUsd++;
  else totalSucceededUsd++;

  if (tags.length === 0) continue;

  const bucket = (isSkippedNonPaid || isNonUsd)
    ? `SKIPPED:${isSkippedNonPaid ? c.status : "non-usd"}`
    : classify(meta, c.description?.trim() ?? null);

  for (const tag of tags) {
    totals[tag].count++;
    if (isSkippedNonPaid || isNonUsd) totals[tag].skipped++;
    else totals[tag].gross += c.amount / 100;
    totals[tag].buckets.set(bucket, (totals[tag].buckets.get(bucket) ?? 0) + 1);
    if (samples[tag].length < 5) {
      samples[tag].push({
        id: c.id,
        date: new Date(c.created * 1000).toISOString().slice(0, 10),
        status: c.status,
        amount: c.amount / 100,
        currency: c.currency,
        bucket,
        type_meta: meta.type ?? null,
        cityIdentifier: meta.cityIdentifier ?? null,
        description: c.description ?? null,
        relevant_meta: Object.fromEntries(
          Object.entries(meta).filter(([k]) =>
            /captain|team|guest|division|event/i.test(k) ||
            k === "type" || k === "cityIdentifier" || k === "matchName"
          ),
        ),
      });
    }
  }

  if (isSkippedNonPaid && tags.length > 0) {
    skippedWithTags.push({ id: c.id, status: c.status, amount: c.amount / 100, tags, meta_type: meta.type ?? null });
  }
}

console.log(`Overall: succeeded+USD=${totalSucceededUsd}  skipped(non-paid)=${totalSkippedNonPaid}  skipped(non-USD)=${totalSkippedNonUsd}\n`);

for (const tag of ["captain", "team", "guest_match", "special_event"]) {
  const t = totals[tag];
  console.log(`\n=== ${tag.toUpperCase()} ===`);
  console.log(`  Count (incl. skipped): ${t.count}    Skipped: ${t.skipped}    Gross $ (succeeded USD only): $${t.gross.toFixed(2)}`);
  console.log(`  Current bucketing for the succeeded+USD ones:`);
  for (const [b, n] of [...t.buckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${b.padEnd(20)} ${n}`);
  }
  console.log(`  Samples (up to 5):`);
  for (const s of samples[tag]) {
    console.log(`    ${s.id} ${s.date} ${s.status} $${s.amount} ${s.currency} → bucket=${s.bucket}`);
    console.log(`        meta.type=${s.type_meta}  cityIdentifier=${s.cityIdentifier}`);
    console.log(`        description=${s.description}`);
    console.log(`        relevant_meta=${JSON.stringify(s.relevant_meta)}`);
  }
}

console.log(`\n=== Non-paid skipped charges with non-standard tags ===`);
console.log(`Total skipped non-paid with one of {captain, team, guest_match, special_event} tag: ${skippedWithTags.length}`);
for (const s of skippedWithTags.slice(0, 8)) {
  console.log(`  ${s.id} status=${s.status} $${s.amount} tags=[${s.tags.join(",")}] meta.type=${s.meta_type}`);
}
