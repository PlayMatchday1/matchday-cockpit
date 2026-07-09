// Audit PRUMC Sunday 6:00 PM, May 3, 2026. User says one member
// attended; Match P&L shows allocatedMemberRev = $0. Two possible
// causes: (1) fin_member_spots missing May 2026 rows (data gap),
// (2) the member's registration has payment_type other than
// "MEMBER" (categorization). Check both.
//
// Read-only.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

const ALLOWED_PAYMENT_TYPES = new Set(["DAILY PAID", "MEMBER"]);

// Same wall-clock parser the cockpit uses — slice the YYYY-MM-DDTHH:MM
// portion and interpret as local. Matches matchPnL.ts parseLocalTimestamp.
function parseWallClock(s: string): Date {
  const parts = s.slice(0, 16).split(/[- T:]/);
  const [y, m, d, h, n] = parts.map((p) => Number(p));
  return new Date(y, m - 1, d, h, n);
}

async function main() {
  // 1. Find current upload.
  const { data: upload } = await sb
    .from("data_uploads")
    .select("id, filename")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle<{ id: string; filename: string }>();
  if (!upload) {
    console.log("No current upload.");
    return;
  }
  console.log(`Current upload: ${upload.filename}\n`);

  // 2. Pull all PRUMC rows on May 3, 2026 (broad range — filter by
  // wall-clock in JS).
  const { data: regs, error } = await sb
    .from("match_registrations")
    .select("*")
    .eq("upload_id", upload.id)
    .gte("match_start", "2026-05-03T00:00:00")
    .lte("match_start", "2026-05-03T23:59:59")
    .ilike("field", "%prumc%");
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  if (!regs || regs.length === 0) {
    console.log("No PRUMC rows found on May 3.");
    return;
  }

  // Group by match_start, show distinct matches first.
  type Row = Record<string, unknown> & {
    field: string | null;
    match_start: string;
    match_canceled: boolean | null;
    player_canceled_at: string | null;
    payment_type: string | null;
    match_price_paid: number | string | null;
  };
  const all = regs as Row[];
  const byMs = new Map<string, Row[]>();
  for (const r of all) {
    const arr = byMs.get(r.match_start) ?? [];
    arr.push(r);
    byMs.set(r.match_start, arr);
  }
  console.log(`=== Distinct PRUMC matches on May 3, 2026 ===`);
  for (const [ms, arr] of [...byMs.entries()].sort()) {
    const d = parseWallClock(ms);
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    const hr = d.getHours();
    const mn = d.getMinutes();
    console.log(
      `  ${ms}  (${dow} ${hr % 12 === 0 ? 12 : hr % 12}:${String(mn).padStart(2, "0")} ${hr >= 12 ? "PM" : "AM"})  field="${arr[0].field}"  rows=${arr.length}`,
    );
  }
  console.log();

  // Filter to 6:00 PM wall-clock.
  const target = all.filter((r) => {
    const d = parseWallClock(r.match_start);
    return d.getHours() === 18 && d.getMinutes() === 0;
  });
  if (target.length === 0) {
    console.log("No PRUMC match at wall-clock 6:00 PM on May 3.");
    return;
  }
  console.log(`=== Target match rows (PRUMC Sun 6:00 PM, ${target.length} total) ===\n`);

  // 3. Print every row in full.
  for (let i = 0; i < target.length; i++) {
    const r = target[i];
    console.log(`--- Row ${i + 1} ---`);
    for (const k of Object.keys(r).sort()) {
      const v = r[k];
      const display = v === null ? "null" : String(v);
      console.log(`  ${k}: ${display}`);
    }
    console.log();
  }

  // 4. Walk through the matchPnL.ts filter chain.
  console.log("=== Filter walkthrough ===");
  console.log("Active filter chain (matchPnL.ts):");
  console.log("  !!field, !match_canceled, !player_canceled_at,");
  console.log(
    `  payment_type ∈ {${[...ALLOWED_PAYMENT_TYPES].join(", ")}}\n`,
  );

  let memberSpots = 0;
  let dpSpots = 0;
  let dpRev = 0;
  let other = 0;
  for (let i = 0; i < target.length; i++) {
    const r = target[i];
    const hasField = !!r.field;
    const matchCanceled = !!r.match_canceled;
    const playerCanceled = !!(
      r.player_canceled_at &&
      String(r.player_canceled_at).trim() !== ""
    );
    const paymentType = String(r.payment_type ?? "").toUpperCase();
    const allowed = ALLOWED_PAYMENT_TYPES.has(paymentType);
    const passes = hasField && !matchCanceled && !playerCanceled && allowed;
    const price = Number(r.match_price_paid ?? 0) || 0;
    const tag =
      passes && paymentType === "MEMBER"
        ? "→ counts as MEMBER spot"
        : passes && paymentType === "DAILY PAID"
          ? `→ counts as DPP spot ($${price})`
          : "→ EXCLUDED";
    console.log(
      `  Row ${i + 1}: payment_type="${r.payment_type ?? "(null)"}"  match_canceled=${matchCanceled}  player_canceled=${playerCanceled}  match_price_paid=${price}  ${tag}`,
    );
    if (passes) {
      if (paymentType === "MEMBER") memberSpots += 1;
      else if (paymentType === "DAILY PAID") {
        dpSpots += 1;
        dpRev += price;
      }
    } else {
      other += 1;
    }
  }
  console.log();
  console.log(
    `Summary: memberSpots=${memberSpots}  dpSpots=${dpSpots}  dpRev=$${dpRev.toFixed(2)}  excluded=${other}\n`,
  );

  // 5. fin_member_spots — Atlanta May 2026.
  const { data: msAtl, error: msErr } = await sb
    .from("fin_member_spots")
    .select("*")
    .eq("city", "Atlanta")
    .eq("month", "May 2026");
  if (msErr) {
    console.error("fin_member_spots query failed:", msErr.message);
  } else {
    console.log("=== fin_member_spots Atlanta May 2026 ===");
    if (!msAtl || msAtl.length === 0) {
      console.log(
        "  (zero rows) ← Atlanta May 2026 NOT in fin_member_spots yet",
      );
    } else {
      for (const m of msAtl)
        console.log(
          `  venue="${m.venue}"  member_spots=${m.member_spots}  dpp_spots=${m.dpp_spots}  other_spots=${m.other_spots}`,
        );
    }
    console.log();
  }

  // For comparison, Atlanta April 2026 (should have rows).
  const { data: msAtlApr } = await sb
    .from("fin_member_spots")
    .select("*")
    .eq("city", "Atlanta")
    .eq("month", "Apr 2026");
  console.log("=== fin_member_spots Atlanta Apr 2026 (comparison) ===");
  if (!msAtlApr || msAtlApr.length === 0) {
    console.log("  (zero rows)");
  } else {
    for (const m of msAtlApr)
      console.log(
        `  venue="${m.venue}"  member_spots=${m.member_spots}  dpp_spots=${m.dpp_spots}  other_spots=${m.other_spots}`,
      );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
