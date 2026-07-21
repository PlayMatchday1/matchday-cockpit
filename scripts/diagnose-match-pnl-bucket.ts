// Inline-replicate matchPnL.ts fetch + filter + bucket and trace
// what happens to the 17 ATH Katy Wed 9:15 PM rows.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  mostRecentCompletedWeekMonday,
  sundayEndOf,
} from "../src/lib/weekWindow";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

const ALLOWED_PAYMENT_TYPES = new Set(["DAILY PAID", "MEMBER"]);

async function main() {
  const { data: upload } = await sb
    .from("data_uploads")
    .select("id")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!upload) throw new Error("no current upload");

  const today = new Date();
  const weekStart = mostRecentCompletedWeekMonday(today);
  const weekEnd = sundayEndOf(weekStart);
  const isoStart = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}T00:00:00`;
  const isoEnd = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}T23:59:59`;
  console.log(`Range: ${isoStart} → ${isoEnd}\n`);

  type RegRow = {
    field: string | null;
    match_start: string;
    match_canceled: boolean;
    player_canceled_at: string | null;
    payment_type: string | null;
    match_price_paid: number | null;
  };
  const regs: RegRow[] = [];
  let pages = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("match_registrations")
      .select(
        "field, match_start, match_canceled, player_canceled_at, payment_type, match_price_paid",
      )
      .eq("upload_id", upload.id)
      .gte("match_start", isoStart)
      .lte("match_start", isoEnd)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    pages++;
    if (!data || data.length === 0) break;
    regs.push(...(data as RegRow[]));
    if (data.length < 1000) break;
  }
  console.log(`Total rows fetched: ${regs.length} (${pages} page(s))\n`);

  // ATH Katy Wed 9:15 PM rows in the fetched set.
  const targetField = "ATH Katy";
  const targetMatchStart = "2026-04-29T21:15:00+00:00";
  const target = regs.filter(
    (r) => r.field === targetField && r.match_start === targetMatchStart,
  );
  console.log(
    `=== Rows matching field="${targetField}" + match_start="${targetMatchStart}" ===`,
  );
  console.log(`Found in matchPnL fetch: ${target.length}\n`);

  // Apply the matchPnL filter.
  const eligible = target.filter(
    (r) =>
      !!r.field &&
      !r.match_canceled &&
      !(r.player_canceled_at && r.player_canceled_at.trim() !== "") &&
      ALLOWED_PAYMENT_TYPES.has((r.payment_type ?? "").toUpperCase()),
  );
  console.log(`Passing filter: ${eligible.length}`);
  let dpRev = 0;
  let memberCount = 0;
  for (const r of eligible) {
    if ((r.payment_type ?? "").toUpperCase() === "DAILY PAID") {
      dpRev += Number(r.match_price_paid ?? 0) || 0;
    } else {
      memberCount++;
    }
  }
  console.log(`Aggregated: spotsSold=${eligible.length}, gross=$${dpRev.toFixed(2)}\n`);

  // Now show pagination behavior — how many ATH Katy rows came in
  // each page, to see if 17 rows split across page boundaries.
  console.log("=== Pagination diagnostic ===");
  // Re-fetch with explicit page-by-page tracking to see boundaries.
  pages = 0;
  let totalInThis = 0;
  let athKatyTotal = 0;
  let athKatyTargetTotal = 0;
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("match_registrations")
      .select(
        "field, match_start, match_canceled, player_canceled_at, payment_type, match_price_paid",
      )
      .eq("upload_id", upload.id)
      .gte("match_start", isoStart)
      .lte("match_start", isoEnd)
      .range(from, from + 999);
    pages++;
    const len = data?.length ?? 0;
    totalInThis += len;
    if (data) {
      const ath = data.filter((r) => r.field === targetField);
      const athTarget = ath.filter((r) => r.match_start === targetMatchStart);
      athKatyTotal += ath.length;
      athKatyTargetTotal += athTarget.length;
      console.log(
        `  page ${pages} (range ${from}-${from + 999}): ${len} rows total, ${ath.length} ATH Katy any, ${athTarget.length} ATH Katy Wed 9:15 PM`,
      );
    }
    if (!data || data.length === 0) break;
    if (data.length < 1000) break;
  }
  console.log(
    `\nTotals across pages: ${totalInThis} all, ${athKatyTotal} ATH Katy any, ${athKatyTargetTotal} ATH Katy Wed 9:15 PM`,
  );

  // Compare against the unbounded ilike fetch.
  const { data: ilikeRows } = await sb
    .from("match_registrations")
    .select(
      "field, match_start, match_canceled, player_canceled_at, payment_type, match_price_paid",
    )
    .eq("upload_id", upload.id)
    .gte("match_start", isoStart)
    .lte("match_start", isoEnd)
    .ilike("field", "%katy%");
  const ilikeAthTarget = (ilikeRows ?? []).filter(
    (r) => r.field === targetField && r.match_start === targetMatchStart,
  );
  console.log(
    `\nFor comparison — single .ilike('field','%katy%') query: ${ilikeRows?.length ?? 0} rows, ATH Katy Wed 9:15 = ${ilikeAthTarget.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
