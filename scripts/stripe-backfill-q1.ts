// One-shot Stripe DPP backfill for Jan-Mar 2026. Calls
// syncStripeCharges + commitStripe directly from the lib (same code
// path /api/sync/stripe uses) with the service-role client.
//
// Usage:
//   npx tsx scripts/stripe-backfill-q1.ts --slice preflight   # Jan 1-7
//   npx tsx scripts/stripe-backfill-q1.ts --slice january
//   npx tsx scripts/stripe-backfill-q1.ts --slice february
//   npx tsx scripts/stripe-backfill-q1.ts --slice march
//   npx tsx scripts/stripe-backfill-q1.ts --slice verify     # coverage report only
//
// commitStripe does a date-range-replace (DELETE WHERE source='Stripe'
// AND date IN range, then INSERT) — so this is safe to re-run for the
// same slice (it'll cleanly replace), and it won't touch Apr/May rows
// because the requested date range never overlaps them.

import { readFileSync } from "node:fs";

// Load .env.local into process.env BEFORE any import of src/lib/*
// modules — src/lib/supabase.ts evaluates createClient() at module
// init and would throw "supabaseUrl is required" otherwise. The
// publishable-key fallback is needed because src/lib/supabase.ts
// reads NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY at init even though we
// won't use that module-level client (financeImport's commitStripe
// accepts an explicit client param).
const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
function readVar(name: string): string | undefined {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}
for (const v of [
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
]) {
  const val = readVar(v);
  if (val) process.env[v] = val;
}

const supabaseUrl = readVar("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = readVar("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// Dynamic imports + everything else wrapped in async IIFE so the
// CJS-output mode tsx uses tolerates the awaits. See comment block
// above for why we can't do the imports statically.
(async () => {
const { createClient } = await import("@supabase/supabase-js");
const { syncStripeCharges } = await import("../src/lib/stripeSync");
const { commitStripe } = await import("../src/lib/financeImport");

const sb = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SLICES: Record<string, { since: string; until: string; label: string }> = {
  preflight: { since: "2026-01-01", until: "2026-01-07", label: "Jan 1-7 pre-flight" },
  january:   { since: "2026-01-01", until: "2026-01-31", label: "January 2026" },
  february:  { since: "2026-02-01", until: "2026-02-28", label: "February 2026" },
  march:     { since: "2026-03-01", until: "2026-03-31", label: "March 2026" },
};

const sliceArg = process.argv.find((a) => a.startsWith("--slice="))?.slice(8) ??
  (process.argv.includes("--slice") ? process.argv[process.argv.indexOf("--slice") + 1] : null);

if (!sliceArg) {
  console.error("Pass --slice <preflight|january|february|march|verify>");
  process.exit(1);
}

async function snapshotAprMay(): Promise<{ aprStripe: number; maySstripe: number; aprRows: number; mayRows: number }> {
  const apr = await sb
    .from("fin_revenue")
    .select("gross")
    .eq("type", "DPP")
    .eq("source", "Stripe")
    .gte("date", "2026-04-01")
    .lte("date", "2026-04-30");
  const may = await sb
    .from("fin_revenue")
    .select("gross")
    .eq("type", "DPP")
    .eq("source", "Stripe")
    .gte("date", "2026-05-01")
    .lte("date", "2026-05-31");
  return {
    aprStripe: (apr.data ?? []).reduce((s, r) => s + (r.gross ?? 0), 0),
    maySstripe: (may.data ?? []).reduce((s, r) => s + (r.gross ?? 0), 0),
    aprRows: apr.data?.length ?? 0,
    mayRows: may.data?.length ?? 0,
  };
}

async function coverageReport(): Promise<void> {
  console.log("=== Coverage by month (type=DPP, source=Stripe) ===");
  const all = await sb
    .from("fin_revenue")
    .select("date, venue, gross")
    .eq("type", "DPP")
    .eq("source", "Stripe");
  const byMonth = new Map<string, { rows: number; gross: number; venues: Set<string>; dates: Set<string> }>();
  for (const r of all.data ?? []) {
    const m = (r.date as string).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { rows: 0, gross: 0, venues: new Set(), dates: new Set() });
    const o = byMonth.get(m)!;
    o.rows++;
    o.gross += (r.gross as number) ?? 0;
    o.venues.add(r.venue as string);
    o.dates.add(r.date as string);
  }
  for (const [m, o] of [...byMonth.entries()].sort()) {
    console.log(`  ${m}:  rows=${String(o.rows).padStart(4)}  $${Math.round(o.gross).toLocaleString().padStart(8)}  venues=${o.venues.size}  dates=${o.dates.size}`);
  }
}

async function runSlice(key: "preflight" | "january" | "february" | "march"): Promise<void> {
  const slice = SLICES[key];
  console.log(`\n=== ${slice.label} — Stripe backfill ===`);
  console.log(`  since=${slice.since}  until=${slice.until}`);

  const preApr = await snapshotAprMay();
  console.log(`  pre-snapshot: Apr Stripe DPP=$${Math.round(preApr.aprStripe).toLocaleString()} (${preApr.aprRows} rows) · May Stripe DPP=$${Math.round(preApr.maySstripe).toLocaleString()} (${preApr.mayRows} rows)`);

  const t0 = Date.now();
  const sync = await syncStripeCharges(sb, {
    since: new Date(slice.since + "T00:00:00Z"),
    until: new Date(slice.until + "T23:59:59Z"),
  });
  console.log(`  Stripe pull complete in ${Date.now() - t0}ms`);
  console.log(`    totalCharges=${sync.totalCharges}  paidRows=${sync.paidRows}  skipped non-paid=${sync.skippedNonPaid}  non-USD=${sync.skippedNonUsd}`);
  console.log(`    classified: membership=${sync.membershipPayments}  match=${sync.matchPayments}  strike=${sync.strikePayments}`);
  console.log(`    aggregated rows ready for commit: ${sync.rows.length}`);
  console.log(`    date range in pulled rows: ${sync.earliestDate} → ${sync.latestDate}`);
  if (sync.unmatchedEmails.length > 0) {
    console.log(`    unmatched member emails (${sync.unmatchedEmails.length}): ${sync.unmatchedEmails.slice(0, 5).join(", ")}${sync.unmatchedEmails.length > 5 ? "…" : ""}`);
  }
  if (sync.unmatchedCityCodes.length > 0) {
    console.log(`    unmatched city codes: ${sync.unmatchedCityCodes.join(", ")}`);
  }

  if (sync.rows.length === 0) {
    console.log(`  No rows to commit. Nothing to insert.`);
  } else if (sync.earliestDate && sync.latestDate) {
    const commit = await commitStripe(
      { rows: sync.rows, earliestDate: sync.earliestDate, latestDate: sync.latestDate },
      sb,
    );
    console.log(`  Commit: ${commit.count} rows inserted, ${commit.rowsReplaced ?? 0} replaced. ${commit.note ?? ""}`);
  }

  // Post-snapshot — confirm Apr/May unchanged.
  const postApr = await snapshotAprMay();
  const aprDelta = postApr.aprStripe - preApr.aprStripe;
  const mayDelta = postApr.maySstripe - preApr.maySstripe;
  console.log(`  post-snapshot drift check:`);
  console.log(`    Apr: $${Math.round(preApr.aprStripe).toLocaleString()} → $${Math.round(postApr.aprStripe).toLocaleString()} (Δ=${Math.round(aprDelta) === 0 ? "ZERO ✓" : "$" + Math.round(aprDelta).toLocaleString() + " ⚠️"})`);
  console.log(`    May: $${Math.round(preApr.maySstripe).toLocaleString()} → $${Math.round(postApr.maySstripe).toLocaleString()} (Δ=${Math.round(mayDelta) === 0 ? "ZERO ✓" : "$" + Math.round(mayDelta).toLocaleString() + " ⚠️"})`);

  // Slice-specific stats: pull the rows we just committed (filter by
  // the slice's date range) and report breakdown.
  const just = await sb
    .from("fin_revenue")
    .select("date, venue, gross")
    .eq("type", "DPP")
    .eq("source", "Stripe")
    .gte("date", slice.since)
    .lte("date", slice.until);
  const rows = just.data ?? [];
  const total = rows.reduce((s, r) => s + ((r.gross as number) ?? 0), 0);
  const venues = new Set(rows.map((r) => r.venue as string).filter(Boolean));
  const dates = new Set(rows.map((r) => r.date as string));
  console.log(`  in-DB after commit (${slice.since}..${slice.until}):`);
  console.log(`    rows=${rows.length}  $${Math.round(total).toLocaleString()}  venues=${venues.size}  dates=${dates.size}`);
}

async function main(): Promise<void> {
  if (sliceArg === "verify") {
    await coverageReport();
    return;
  }
  if (!(sliceArg in SLICES)) {
    console.error(`Unknown slice "${sliceArg}". Pick one of: ${Object.keys(SLICES).join(", ")}, verify`);
    process.exit(1);
  }
  await runSlice(sliceArg as "preflight" | "january" | "february" | "march");
}

await main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
})();
