// One-shot data fix for Westlake (fin_venues.id=49).
//
// Background: Westlake was added today via the new Add Venue dialog.
// While the operator was editing its details on the Q3 planning view,
// the refetchFinanceData stale-cache bug (fixed in this same PR) hid
// every successful inline UPDATE behind a UI that kept rendering
// pre-edit state. Net result: per_match_rate stayed null and
// dpp_price / member_price weren't reached.
//
// Target state per the operator's spec:
//   billing_type   = per_match     (already correct in DB)
//   per_match_rate = 135           (currently null)
//   cost_per_match = 135           (already correct)
//   dpp_price      = 12
//   member_price   = 72
//
// Also: confirm zero rows in fin_venue_cost_overrides for venue_id=49
// (Westlake was just created — there shouldn't be any) and DELETE any
// that exist.
//
// All changes are written through logChange so the audit trail tells
// the same story as if they'd happened through the UI.
//
// Default: DRY-RUN. Pass --apply to actually write.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const VENUE_ID = 49;
const CHANGED_BY = "westlake-data-fix-script";

// Logs through fin_change_log directly (same payload shape the app's
// logChange helper uses).
async function audit(action, before, after) {
  const { error } = await sb.from("fin_change_log").insert({
    table_name: "fin_venues",
    row_id: VENUE_ID,
    action,
    changed_by: CHANGED_BY,
    before_json: before,
    after_json: after,
    note: "Westlake data fix (refetch-stale-cache recovery)",
  });
  if (error) throw new Error(`Audit log write failed: ${error.message}`);
}

async function auditOverride(action, rowId, before, after) {
  const { error } = await sb.from("fin_change_log").insert({
    table_name: "fin_venue_cost_overrides",
    row_id: rowId,
    action,
    changed_by: CHANGED_BY,
    before_json: before,
    after_json: after,
    note: "Westlake data fix — clearing orphaned override row",
  });
  if (error) throw new Error(`Audit log write failed: ${error.message}`);
}

// 1. Read current Westlake row.
const { data: current, error: rErr } = await sb
  .from("fin_venues")
  .select("id, venue_name, city, billing_type, per_match_rate, cost_per_match, dpp_price, member_price")
  .eq("id", VENUE_ID)
  .single();
if (rErr) {
  console.error("Failed to read Westlake row:", rErr);
  process.exit(1);
}
console.log("=== Westlake (id=49) current row ===");
console.log(JSON.stringify(current, null, 2));

if (current.venue_name !== "Westlake" || current.city !== "Austin") {
  console.error(
    "SAFETY HALT — fin_venues.id=49 is not the Westlake (Austin) row we expected.",
  );
  console.error(
    `  Got venue_name=${JSON.stringify(current.venue_name)} city=${JSON.stringify(current.city)}`,
  );
  process.exit(1);
}

// 2. Build the diff. Only patch fields that differ from target.
const target = {
  per_match_rate: 135,
  cost_per_match: 135,
  dpp_price: 12,
  member_price: 72,
};
const patch = {};
const before = {};
const after = {};
for (const [k, v] of Object.entries(target)) {
  if (current[k] !== v) {
    patch[k] = v;
    before[k] = current[k];
    after[k] = v;
  }
}
console.log("\n=== Diff vs. target ===");
if (Object.keys(patch).length === 0) {
  console.log("  no changes — Westlake row already matches target");
} else {
  for (const k of Object.keys(patch)) {
    console.log(`  ${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
  }
}

// 3. Check for any cost-override rows on this venue.
const { data: overrides, error: oErr } = await sb
  .from("fin_venue_cost_overrides")
  .select("id, month, override_amount, reason, created_at, created_by")
  .eq("venue_id", VENUE_ID);
if (oErr) {
  console.error("Failed to read overrides:", oErr);
  process.exit(1);
}
console.log("\n=== fin_venue_cost_overrides for venue_id=49 ===");
if (overrides.length === 0) {
  console.log("  none — clean");
} else {
  console.log(`  found ${overrides.length} row(s) — will DELETE these:`);
  for (const o of overrides) console.log("   ", JSON.stringify(o));
}

if (!APPLY) {
  console.log("\nDRY RUN COMPLETE. Re-run with --apply to write.");
  process.exit(0);
}

// 4. Apply.
console.log("\nAPPLY MODE — writing now…");
if (Object.keys(patch).length > 0) {
  // Snapshot the whole row (matches the app's logChange `before` shape)
  // for the audit entry.
  const beforeFull = { ...current };
  const { data: updated, error: uErr } = await sb
    .from("fin_venues")
    .update(patch)
    .eq("id", VENUE_ID)
    .select()
    .single();
  if (uErr) {
    console.error("Westlake UPDATE failed:", uErr);
    process.exit(1);
  }
  await audit("update", beforeFull, updated);
  console.log("  fin_venues UPDATE applied + audited.");
} else {
  console.log("  fin_venues: nothing to update.");
}

for (const o of overrides) {
  await auditOverride("delete", o.id, o, null);
  const { error: dErr } = await sb
    .from("fin_venue_cost_overrides")
    .delete()
    .eq("id", o.id);
  if (dErr) {
    console.error(`Override DELETE failed for id=${o.id}:`, dErr);
    process.exit(1);
  }
  console.log(`  override id=${o.id} (${o.month}) deleted + audited.`);
}

console.log("\nWestlake data fix complete.");
