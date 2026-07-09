// Run matchPnL.ts's actual fetchWeekMatchPnL against the same week
// the UI shows. If this produces 4 spots / $27, the UI is correct
// per the deployed code and the gap is in MY filter understanding.
// If it produces 11 / $81 (matching my walkthrough script), then
// the UI has a different rendering bug.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fetchWeekMatchPnL } from "../src/lib/matchPnL";
import { mostRecentCompletedWeekMonday, sundayEndOf } from "../src/lib/weekWindow";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  const today = new Date();
  const weekStart = mostRecentCompletedWeekMonday(today);
  const weekEnd = sundayEndOf(weekStart);
  console.log(
    `Today: ${today.toISOString().slice(0, 10)} (local DOW=${today.getDay()})`,
  );
  console.log(
    `Week computed: ${weekStart.toISOString().slice(0, 10)} → ${weekEnd.toISOString().slice(0, 10)}\n`,
  );

  // Pull venues directly (matches what useFinanceData would load).
  const { data: venuesRaw, error: vErr } = await sb
    .from("fin_venues")
    .select("*")
    .order("id");
  if (vErr) throw new Error(vErr.message);
  type V = {
    id: number;
    venue_name: string;
    raw_venue_name?: string;
    city: string | null;
    cost_per_match?: number | string | null;
  } & Record<string, unknown>;
  const venues = (venuesRaw as V[]).map((v) => ({
    id: v.id,
    venue_name: String(v.venue_name),
    raw_venue_name: String(v.raw_venue_name ?? v.venue_name),
    city: v.city ?? "—",
    billing_type: "per_match" as const, // placeholder; unused by matchPnL
    hourly_rate: null,
    monthly_flat: null,
    per_match_rate: null,
    max_spots: null,
    dpp_price: null,
    member_price: null,
    cost_per_match:
      v.cost_per_match === null || v.cost_per_match === undefined
        ? null
        : Number(v.cost_per_match),
    notes: null,
    launch_date: null,
    is_active: true,
  }));

  // Show ATH Katy venue lookup
  const ath = venues.filter((v) => v.venue_name.toLowerCase().includes("katy"));
  console.log("=== Venues matching 'katy' ===");
  for (const v of ath) {
    console.log(
      `  id=${v.id}  venue_name="${v.venue_name}"  raw_venue_name="${v.raw_venue_name}"  city=${v.city}  cost_per_match=${v.cost_per_match}`,
    );
  }
  console.log();

  const result = await fetchWeekMatchPnL(sb, weekStart, weekEnd, venues);
  const rows = [...result.active, ...result.canceled];
  console.log(
    `Total Match P&L rows for week: ${rows.length} (active=${result.active.length}, canceled=${result.canceled.length})\n`,
  );

  // Filter to ATH Katy Wednesday rows.
  const ath_rows = rows.filter((r) => {
    const isAth =
      r.venueDisplayName.toLowerCase().includes("katy") ||
      r.venueRawName.toLowerCase().includes("katy");
    return isAth;
  });
  console.log(`=== Match P&L rows at venues containing 'katy' (${ath_rows.length}) ===`);
  for (const r of ath_rows) {
    console.log(
      `  ${r.matchStartIso}  ${r.dayLabel} ${r.timeLabel}  venue=${r.venueDisplayName} (id=${r.venueId})  spotsSold=${r.spotsSold}  gross=$${r.grossRevenue.toFixed(2)}  cost=${r.fieldCost}  net=${r.net}  status=${r.status}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
