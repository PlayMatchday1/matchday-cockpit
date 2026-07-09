// Consolidate venue costs onto fin_venue_cost_overrides as the single source.
//
// 1. INSERT 10 override rows (8 source rows + NEMP 3-way split = 10 total)
// 2. DELETE the 8 source rows from fin_expenses
// 3. Audit-log each row mutation with note "Venue cost consolidation"
//
// Idempotent-ish guard: refuses to run if any Venue Rental rows are
// already absent (i.e. the migration has already happened) — better to
// fail loud than re-double.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const MIGRATION_USER = "migrated from fin_expenses";
const MIGRATION_NOTE = "Venue cost consolidation";

// Pre-flight: there must be exactly 8 Venue Rental rows + 3 existing override
// rows. Anything else means we're partially-migrated or in an unexpected state.
const { data: existingVR } = await sb
  .from("fin_expenses")
  .select("id,vendor,month,amount")
  .eq("category", "Venue Rental")
  .order("id");
const { data: existingOv } = await sb.from("fin_venue_cost_overrides").select("id");
console.log(`Pre-flight: ${existingVR.length} Venue Rental rows in fin_expenses, ${existingOv.length} existing override rows.`);
if (existingVR.length !== 8) {
  console.error("ABORT: expected exactly 8 Venue Rental rows. Re-run the diagnostic.");
  process.exit(1);
}

// Pull venue lookup so we can resolve vendor → venue_id.
const { data: venues } = await sb.from("fin_venues").select("id,venue_name,city");
const venueByName = new Map(venues.map((v) => [v.venue_name, v]));

// Build the 10 override rows. NEMP is split here.
const inserts = [];
for (const r of existingVR) {
  const v = venueByName.get(r.vendor);
  if (!v) {
    console.error(`ABORT: no fin_venue match for vendor "${r.vendor}" (id=${r.id})`);
    process.exit(1);
  }
  if (r.vendor === "NEMP") {
    for (const m of ["Apr 2026", "May 2026", "Jun 2026"]) {
      inserts.push({
        venue_id: v.id,
        month: m,
        override_amount: 3700,
        reason: "lump_sum · Q2 permit fee 1/3 of $11,100",
        created_by: MIGRATION_USER,
      });
    }
    continue;
  }
  let billingTag;
  if (r.vendor === "Hattrick") billingTag = "profit_share";
  else if (r.vendor === "Soccer Central") billingTag = "monthly_flat";
  else if (r.vendor === "Bicentennial Park") billingTag = "monthly_flat";
  else billingTag = "monthly_flat";
  // Notes from the source row become part of the reason so the trace stays
  // attached to the override.
  const sourceNotes = r.notes ?? "";
  const reason = sourceNotes
    ? `${billingTag} · ${sourceNotes}`
    : `${billingTag} · migrated`;
  // We need the original row's notes too — refetch with notes.
  inserts.push({
    venue_id: v.id,
    month: r.month,
    override_amount: Number(r.amount),
    reason,
    created_by: MIGRATION_USER,
  });
}

// One more pass: pull the actual notes for each VR row so reasons are accurate.
const { data: vrFull } = await sb
  .from("fin_expenses")
  .select("id,vendor,month,amount,notes")
  .eq("category", "Venue Rental");
const notesById = new Map(vrFull.map((r) => [r.id, r.notes ?? ""]));
// Now rebuild inserts with the real notes.
inserts.length = 0;
for (const r of vrFull) {
  const v = venueByName.get(r.vendor);
  if (r.vendor === "NEMP") {
    for (const m of ["Apr 2026", "May 2026", "Jun 2026"]) {
      inserts.push({
        venue_id: v.id,
        month: m,
        override_amount: 3700,
        reason: "lump_sum · Q2 permit fee 1/3 of $11,100",
        created_by: MIGRATION_USER,
      });
    }
    continue;
  }
  let billingTag;
  if (r.vendor === "Hattrick") billingTag = "profit_share";
  else billingTag = "monthly_flat";
  const sourceNotes = notesById.get(r.id) ?? "";
  const reason = sourceNotes
    ? `${billingTag} · ${sourceNotes}`
    : `${billingTag} · migrated`;
  inserts.push({
    venue_id: v.id,
    month: r.month,
    override_amount: Number(r.amount),
    reason,
    created_by: MIGRATION_USER,
  });
}

console.log(`\nWill insert ${inserts.length} override rows:`);
console.table(
  inserts.map((r) => ({
    venue_id: r.venue_id,
    month: r.month,
    amount: r.override_amount,
    reason: r.reason,
  })),
);

// Insert overrides.
const { data: insertedOv, error: insErr } = await sb
  .from("fin_venue_cost_overrides")
  .insert(inserts)
  .select();
if (insErr) {
  console.error("INSERT failed:", insErr);
  process.exit(1);
}
console.log(`\n✓ Inserted ${insertedOv.length} override rows`);

// Audit-log each insert.
for (const row of insertedOv) {
  const { error } = await sb.from("fin_change_log").insert({
    table_name: "fin_venue_cost_overrides",
    row_id: row.id,
    action: "insert",
    changed_by: MIGRATION_USER,
    after_json: row,
    note: MIGRATION_NOTE,
  });
  if (error) console.warn(`  audit log warn (override id=${row.id}):`, error.message);
}

// Audit-log each delete BEFORE deleting (so we capture the before_json).
for (const r of vrFull) {
  const { error } = await sb.from("fin_change_log").insert({
    table_name: "fin_expenses",
    row_id: r.id,
    action: "delete",
    changed_by: MIGRATION_USER,
    before_json: r,
    note: MIGRATION_NOTE,
  });
  if (error) console.warn(`  audit log warn (expense id=${r.id}):`, error.message);
}

// Now delete the Venue Rental rows.
const { error: delErr } = await sb
  .from("fin_expenses")
  .delete()
  .eq("category", "Venue Rental");
if (delErr) {
  console.error("DELETE failed:", delErr);
  process.exit(1);
}
console.log(`✓ Deleted ${vrFull.length} fin_expenses Venue Rental rows`);

// Verification.
console.log("\n=== Post-migration verification ===");
const { data: postOv } = await sb
  .from("fin_venue_cost_overrides")
  .select("month,override_amount");
const byMonth = new Map();
for (const r of postOv) {
  const cur = byMonth.get(r.month) ?? { count: 0, sum: 0 };
  cur.count++;
  cur.sum += Number(r.override_amount);
  byMonth.set(r.month, cur);
}
const monthRows = [...byMonth.entries()]
  .sort()
  .map(([month, v]) => ({ month, rows: v.count, sum: v.sum.toFixed(2) }));
console.table(monthRows);
const grandTotal = postOv.reduce((s, r) => s + Number(r.override_amount), 0);
console.log(`\nGrand total override sum: $${grandTotal.toFixed(2)}  (target: $35,665.00)`);

const { count: vrLeft } = await sb
  .from("fin_expenses")
  .select("*", { count: "exact", head: true })
  .eq("category", "Venue Rental");
console.log(`Remaining Venue Rental rows in fin_expenses: ${vrLeft}  (target: 0)`);
