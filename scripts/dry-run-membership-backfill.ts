// Membership-snapshot backfill. Reads fin_members + match_registrations
// from Supabase, then for each month from the earliest activation_date
// through the current month computes the snapshot using
// computeMonthlySnapshot from src/lib (same code the live refresh
// runs).
//
// Default: dry-run, prints a table, NO writes.
// With --apply: upserts each computed snapshot to members_monthly_snapshots.
//
// Auth: prefers SUPABASE_SERVICE_ROLE_KEY for --apply (bypasses RLS).
// Falls back to publishable key. If publishable can't write, you'll
// see a clear error below.
//
// Run dry-run:  npx tsx scripts/dry-run-membership-backfill.ts
// Run apply:    npx tsx scripts/dry-run-membership-backfill.ts --apply

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  computeMonthlySnapshot,
  parseMemberDate,
  type AttendanceRow,
  type MemberLike,
} from "../src/lib/membershipStats";
import { CITIES } from "../src/lib/types";

const APPLY = process.argv.includes("--apply");

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const publishableKey = env
  .match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1]
  .trim();
const serviceRoleMatch = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/);
const serviceKey = serviceRoleMatch ? serviceRoleMatch[1].trim() : null;

// Read with publishable key (anon RLS is fine for SELECT). Write
// with service role if available — that bypasses RLS, which a
// Node script's anonymous session can't otherwise satisfy on
// members_monthly_snapshots.
const sb = createClient(url, publishableKey);
const writeClient =
  APPLY && serviceKey ? createClient(url, serviceKey) : sb;

// Pull all members. Match the column set membershipStats predicates need.
async function fetchAllMembers(): Promise<MemberLike[]> {
  const out: MemberLike[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("fin_members")
      .select("status,price_cents,email,activation_date,canceled_at,city")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as MemberLike[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function fetchAllAttendance(): Promise<AttendanceRow[]> {
  const out: AttendanceRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("match_registrations")
      .select("match_start,payment_type,email")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as AttendanceRow[]));
    if (data.length < 1000) break;
  }
  return out;
}

function endOfMonth(year: number, monthZeroIdx: number): Date {
  // Day 0 of next month = last day of this month.
  return new Date(year, monthZeroIdx + 1, 0);
}

function ymdLabel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

async function main() {
console.log(
  APPLY
    ? `Mode: APPLY (will upsert to members_monthly_snapshots) — auth: ${serviceKey ? "service role" : "publishable (may fail on RLS)"}`
    : "Mode: dry-run (no writes)",
);
console.log("");

const members = await fetchAllMembers();
const attendance = await fetchAllAttendance();

console.log(`Loaded ${members.length} members, ${attendance.length} attendance rows.\n`);

// Determine month range: from earliest activation_date through current month.
let earliest: Date | null = null;
for (const m of members) {
  const d = parseMemberDate(m.activation_date);
  if (d && (!earliest || d < earliest)) earliest = d;
}
if (!earliest) {
  console.log("No member activation dates found. Nothing to backfill.");
  process.exit(0);
}
const now = new Date();
const startYear = earliest.getFullYear();
const startMonth = earliest.getMonth();
const endYear = now.getFullYear();
const endMonth = now.getMonth();

console.log(
  `Backfill range: ${monthIso(new Date(startYear, startMonth, 1))} → ${monthIso(now)} (current month uses today as asOf)\n`,
);

// Header row
const fmtN = (n: number) => String(n).padStart(6);
console.log(
  "month       | active | new | cancl | churn | by-city (active)",
);
console.log(
  "------------|--------|-----|-------|-------|--------------------------------",
);

let y = startYear;
let m = startMonth;
let prevActive: number | null = null;
let written = 0;
let writeError: string | null = null;

while (y < endYear || (y === endYear && m <= endMonth)) {
  const isCurrentBucket = y === endYear && m === endMonth;
  const asOf = isCurrentBucket ? now : endOfMonth(y, m);

  const snap = computeMonthlySnapshot(members, attendance, CITIES, asOf);

  // Build the per-city active summary, omitting zero-active cities for
  // brevity. Sorted by active desc.
  const cityPairs = Object.entries(snap.by_city)
    .map(([city, v]) => [city, v.active] as const)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const citySummary = cityPairs.map(([c, v]) => `${c.slice(0, 3)}:${v}`).join(" ");

  const delta =
    prevActive === null
      ? ""
      : ` (${snap.active_count - prevActive >= 0 ? "+" : ""}${snap.active_count - prevActive})`;
  console.log(
    `${snap.month}  | ${fmtN(snap.active_count)}${delta.padEnd(6)} | ${fmtN(snap.new_count).trim().padStart(3)} | ${fmtN(snap.cancelled_count).trim().padStart(5)} | ${fmtN(snap.churning_count).trim().padStart(5)} | ${citySummary}` +
      (isCurrentBucket ? `  [asOf=${ymdLabel(asOf)} (current/in-progress)]` : ""),
  );
  prevActive = snap.active_count;

  if (APPLY && !writeError) {
    const { error } = await writeClient
      .from("members_monthly_snapshots")
      .upsert(snap, { onConflict: "month" });
    if (error) {
      writeError = error.message;
    } else {
      written++;
    }
  }

  m++;
  if (m > 11) {
    m = 0;
    y++;
  }
}

if (APPLY) {
  if (writeError) {
    console.log(`\n❌ Upsert failed after ${written} writes: ${writeError}`);
    if (!serviceKey) {
      console.log(
        "\nThe publishable key likely can't satisfy RLS on members_monthly_snapshots.",
      );
      console.log(
        "Add SUPABASE_SERVICE_ROLE_KEY to .env.local (copy from Vercel → Project Settings → Environment Variables) and re-run with --apply.",
      );
    }
    process.exit(1);
  }
  console.log(`\n✅ Wrote ${written} snapshots to members_monthly_snapshots.`);
} else {
  console.log("\nDone. No writes performed. Re-run with --apply to write.");
}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
