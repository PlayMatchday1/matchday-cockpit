// Audit ATH Katy, Wednesday 9:15 PM, week of Apr 27 - May 3 2026.
// User reports the Match P&L tab shows "4 spots sold, $27 gross" for
// this match but the venue didn't actually sell 4 spots. Pull the
// raw match_registrations rows, then walk each row through the
// matchPnL.ts filter chain and reconcile with what the UI displays.
//
// Read-only.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

const ALLOWED_PAYMENT_TYPES = new Set(["DAILY PAID", "MEMBER"]);

async function main() {
  // Use the current upload — same upload_id Match P&L queries against.
  const { data: upload, error: upErr } = await sb
    .from("data_uploads")
    .select("id, filename, created_at")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; filename: string; created_at: string }>();
  if (upErr) {
    console.error("data_uploads query failed:", upErr.message);
    process.exit(1);
  }
  if (!upload) {
    console.log("No current upload — nothing to query.");
    return;
  }
  console.log(
    `Current upload: id=${upload.id} file=${upload.filename} created=${upload.created_at}\n`,
  );

  // Pull all ATH Katy rows in the week (case-insensitive field match).
  const { data: rows, error } = await sb
    .from("match_registrations")
    .select("*")
    .eq("upload_id", upload.id)
    .gte("match_start", "2026-04-27T00:00:00")
    .lte("match_start", "2026-05-03T23:59:59")
    .ilike("field", "%katy%")
    .order("match_start");
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log("No ATH Katy rows found in the week.");
    return;
  }

  // Filter to Wednesday-or-later 9 PM matches.
  type Row = Record<string, unknown> & {
    id: number | string;
    field: string | null;
    match_start: string;
    match_canceled: boolean | null;
    player_canceled_at: string | null;
    payment_type: string | null;
    match_price_paid: number | string | null;
  };
  const all = rows as Row[];

  // Group by (field, match_start) to find the specific Wed 9:15 PM match.
  console.log(`Total ATH Katy rows in week: ${all.length}\n`);

  // Wall-clock parse — matches matchPnL.ts parseLocalTimestamp.
  // Timestamps land in fin_revenue / match_registrations as
  // "2026-04-29T21:15:00+00:00"; the cockpit treats the HH:MM as
  // local wall-clock (9:15 PM Wed), NOT as a UTC moment converted
  // to the viewer's tz. So we slice & rebuild a local Date.
  function parseWallClock(s: string): Date {
    const parts = s.slice(0, 16).split(/[- T:]/);
    const [y, m, d, h, n] = parts.map((p) => Number(p));
    return new Date(y, m - 1, d, h, n);
  }

  // Show every distinct match_start in the week with its row count.
  const byMatchStart = new Map<string, Row[]>();
  for (const r of all) {
    const k = `${r.field}||${r.match_start}`;
    const arr = byMatchStart.get(k) ?? [];
    arr.push(r);
    byMatchStart.set(k, arr);
  }
  console.log("=== All distinct (field, match_start) at ATH Katy this week ===");
  console.log("(times shown as cockpit interprets them — wall-clock local)\n");
  const entries = [...byMatchStart.entries()].sort((a, b) => {
    const aD = a[1][0].match_start;
    const bD = b[1][0].match_start;
    return aD.localeCompare(bD);
  });
  for (const [, arr] of entries) {
    const ms = arr[0].match_start;
    const d = parseWallClock(ms);
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    const hr = d.getHours();
    const mn = d.getMinutes();
    const ampm = hr >= 12 ? "PM" : "AM";
    const h12 = hr % 12 === 0 ? 12 : hr % 12;
    console.log(
      `  ${ms}  (${dow} ${h12}:${String(mn).padStart(2, "0")} ${ampm})  field="${arr[0].field}"  rows=${arr.length}`,
    );
  }
  console.log();

  // Zero in on Wednesday 9:15 PM (wall-clock).
  const targetRows = all.filter((r) => {
    const d = parseWallClock(r.match_start);
    return d.getDay() === 3 && d.getHours() === 21 && d.getMinutes() === 15;
  });
  if (targetRows.length === 0) {
    console.log("No Wednesday 9 PM rows found. Above list is the full week.");
    return;
  }

  console.log(
    `=== Rows matching Wed 9 PM at ATH Katy (target match): ${targetRows.length} ===\n`,
  );

  // Print full row details for each.
  for (let i = 0; i < targetRows.length; i++) {
    const r = targetRows[i];
    console.log(`--- Row ${i + 1} ---`);
    for (const k of Object.keys(r).sort()) {
      const v = r[k];
      const display =
        v === null
          ? "null"
          : typeof v === "string" && v.length > 80
            ? `${v.slice(0, 77)}...`
            : String(v);
      console.log(`  ${k}: ${display}`);
    }
    console.log();
  }

  // Walk each row through the matchPnL.ts filter chain.
  console.log("=== Filter walkthrough (matches matchPnL.ts logic) ===\n");
  console.log("Filter chain:");
  console.log("  1. !!field             — must have a field");
  console.log("  2. !match_canceled     — match itself must not be canceled");
  console.log(
    '  3. !player_canceled_at — player must not have canceled their spot',
  );
  console.log(
    `  4. payment_type ∈ {${[...ALLOWED_PAYMENT_TYPES].join(", ")}} — explicit allow-list\n`,
  );

  let passCount = 0;
  let dpRev = 0;
  let memberSpots = 0;
  let dpSpots = 0;
  for (let i = 0; i < targetRows.length; i++) {
    const r = targetRows[i];
    const hasField = !!r.field;
    const matchCanceled = !!r.match_canceled;
    const playerCanceled = !!(
      r.player_canceled_at &&
      String(r.player_canceled_at).trim() !== ""
    );
    const paymentTypeRaw = r.payment_type ?? "";
    const paymentType = String(paymentTypeRaw).toUpperCase();
    const allowed = ALLOWED_PAYMENT_TYPES.has(paymentType);
    const passes = hasField && !matchCanceled && !playerCanceled && allowed;
    const price = Number(r.match_price_paid ?? 0) || 0;
    console.log(
      `Row ${i + 1}:  field=${hasField ? "✓" : "✗"}  match_canceled=${
        matchCanceled ? "TRUE (excluded)" : "false"
      }  player_canceled=${
        playerCanceled ? "TRUE (excluded)" : "false"
      }  payment_type="${paymentTypeRaw}" allowed=${allowed ? "✓" : "✗"}  price=${price}  → ${passes ? "PASSES (counts as 1 spot)" : "EXCLUDED"}`,
    );
    if (passes) {
      passCount += 1;
      if (paymentType === "DAILY PAID") {
        dpRev += price;
        dpSpots += 1;
      } else if (paymentType === "MEMBER") {
        memberSpots += 1;
      }
    }
  }
  console.log();
  console.log("=== Reconciliation with Match P&L UI ===");
  console.log(`  Spots sold (rows passing filter):       ${passCount}`);
  console.log(`    DPP spots:                            ${dpSpots}`);
  console.log(`    Member spots:                         ${memberSpots}`);
  console.log(
    `  Gross revenue (sum match_price_paid passing): $${dpRev.toFixed(2)}`,
  );
  console.log(`  UI showed:                              4 spots, $27`);
  console.log();
  if (passCount === 4) {
    console.log("→ Spots Sold matches the UI exactly.");
  } else {
    console.log(
      `→ Spots Sold MISMATCH: filter pass count ${passCount} ≠ UI count 4.`,
    );
  }
  if (Math.abs(dpRev - 27) < 0.01) {
    console.log("→ Gross revenue matches the UI exactly.");
  } else {
    console.log(
      `→ Gross revenue MISMATCH: filtered DPP sum $${dpRev.toFixed(2)} ≠ UI $27.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
