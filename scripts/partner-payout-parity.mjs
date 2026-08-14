// "The three existing partners' figures must be byte-identical before and after this change."
//
// Run BEFORE applying migration 0123 to capture a baseline, then AFTER to compare:
//   node scripts/partner-payout-parity.mjs --capture     (writes the baseline)
//   node scripts/partner-payout-parity.mjs               (compares against it)
//
// It computes through the REAL code path (buildPartnerDashboardData → computeWeeklyPayments →
// periodOwed), not a reimplementation, so a change anywhere in that chain shows up here.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const BASELINE = new URL("./partner-payout-baseline.json", import.meta.url);
const CAPTURE = process.argv.includes("--capture");

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: partners, error } = await sb
  .from("partner_dashboards").select("slug, partner_name").eq("enabled", true).order("created_at");
if (error) { console.error("partner read failed:", error.message); process.exit(1); }

// Import the real derivation. tsx is required because it is TypeScript with "server-only" imports.
const { buildPartnerDashboardData } = await import("../src/lib/partnerDashboardData.ts");

const snapshot = {};
for (const p of partners) {
  const data = await buildPartnerDashboardData(sb, p.slug, new Date("2026-08-14T12:00:00Z"));
  if (!data) { snapshot[p.slug] = { error: "no data" }; continue; }
  const v = data.kind === "monthly" ? data.monthly : data.weekly;
  // Capture every FIGURE, not the whole render prop — copy changes are not payout changes.
  // GrainRow is what both views render. `payment` IS the money owed for the period; the rest are
  // the figures the partner reads next to it. Copy/labels are excluded — a wording change is not a
  // payout change.
  // The weekly view carries a PartnerGrains object; capture BOTH grains so a weekly partner is
  // covered as thoroughly as a monthly one. Getting this wrong once already made PAC Global look
  // like it had nothing to compare.
  const grains = data.kind === "monthly"
    ? (v.months ?? [])
    : [...(v.grains?.monthRows ?? []), ...(v.grains?.weekRows ?? [])];
  const rows = grains.map((g) => ({
    key: g.key, matches: g.matches, spots: g.spots, daily: g.daily, guests: g.guests,
    revenue: g.revenue, payment: g.payment, livePayment: g.livePayment, frozenPaid: g.frozenPaid,
    rentals: (g.rentals ?? []).map((r) => r.amount), state: g.state, diverged: g.diverged,
  }));
  snapshot[p.slug] = { partner: p.partner_name, kind: data.kind, rows };
}

if (CAPTURE) {
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2));
  const n = Object.values(snapshot).reduce((s, v) => s + (v.rows?.length ?? 0), 0);
  console.log(`BASELINE CAPTURED — ${Object.keys(snapshot).length} partners, ${n} payout periods.`);
  console.log("Apply migration 0123, then re-run WITHOUT --capture to prove nothing moved.");
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("No baseline. Run with --capture BEFORE applying migration 0123."); process.exit(1);
}
const before = JSON.parse(readFileSync(BASELINE, "utf8"));
let diffs = 0, checked = 0;
for (const slug of new Set([...Object.keys(before), ...Object.keys(snapshot)])) {
  const a = JSON.stringify(before[slug] ?? null), b = JSON.stringify(snapshot[slug] ?? null);
  checked += before[slug]?.rows?.length ?? 0;
  if (a !== b) {
    diffs++;
    console.log(`\n✗ ${slug} CHANGED`);
    const ra = before[slug]?.rows ?? [], rb = snapshot[slug]?.rows ?? [];
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
      if (JSON.stringify(ra[i]) !== JSON.stringify(rb[i])) console.log(`    period ${ra[i]?.period ?? rb[i]?.period}\n      before ${JSON.stringify(ra[i])}\n      after  ${JSON.stringify(rb[i])}`);
    }
  } else {
    console.log(`✓ ${slug} — ${before[slug]?.rows?.length ?? 0} periods identical`);
  }
}
console.log(`\n${diffs === 0 ? "PARITY HELD" : "PARITY BROKEN"} — ${checked} payout periods across ${Object.keys(before).length} partners.`);
process.exit(diffs === 0 ? 0 : 1);
