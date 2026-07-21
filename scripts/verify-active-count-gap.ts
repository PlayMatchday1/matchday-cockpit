// Diagnose the 254 vs 753 active-count gap. Runs both predicates
// (current-state isActiveMember from the KPI card, and the new
// isActiveAsOf from the snapshot lib) against today's fin_members
// rows, then breaks the gap down by status × canceled_at-null so we
// can see whether the dry-run is over-counting.
//
// Read-only.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  isActiveAsOf,
  isActiveMember,
  parseMemberDate,
  type MemberLike,
} from "../src/lib/membershipStats";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  const members: MemberLike[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("fin_members")
      .select("status,price_cents,email,activation_date,canceled_at,city")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    members.push(...(data as MemberLike[]));
    if (data.length < 1000) break;
  }

  console.log(`Total fin_members rows: ${members.length}\n`);

  const now = new Date();
  const liveActive = members.filter(isActiveMember).length;
  const asOfActive = members.filter((m) => isActiveAsOf(m, now)).length;
  const gap = asOfActive - liveActive;

  console.log(`isActiveMember (KPI card live count): ${liveActive}`);
  console.log(`isActiveAsOf (dry-run, asOf=today):   ${asOfActive}`);
  console.log(`Gap:                                  ${gap}\n`);

  // Status distribution.
  const statusCounts = new Map<string, number>();
  for (const m of members) {
    const k = m.status?.toUpperCase() ?? "(null)";
    statusCounts.set(k, (statusCounts.get(k) ?? 0) + 1);
  }
  console.log("Total fin_members by status:");
  for (const [s, n] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(22)} ${n}`);
  }
  console.log();

  // Where the gap lives: members counted by isActiveAsOf but NOT by isActiveMember.
  const gapMembers = members.filter(
    (m) => isActiveAsOf(m, now) && !isActiveMember(m),
  );
  console.log(`Gap members (in dry-run, NOT in KPI): ${gapMembers.length}`);
  if (gapMembers.length > 0) {
    const gapByStatus = new Map<string, number>();
    const gapByCanceledNull = { withCanceledAt: 0, nullCanceledAt: 0 };
    for (const m of gapMembers) {
      const k = m.status?.toUpperCase() ?? "(null)";
      gapByStatus.set(k, (gapByStatus.get(k) ?? 0) + 1);
      if (m.canceled_at) gapByCanceledNull.withCanceledAt++;
      else gapByCanceledNull.nullCanceledAt++;
    }
    console.log("  Gap by status:");
    for (const [s, n] of [...gapByStatus.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${s.padEnd(22)} ${n}`);
    }
    console.log("  Gap by canceled_at null vs set:");
    console.log(`    canceled_at IS NULL: ${gapByCanceledNull.nullCanceledAt}`);
    console.log(`    canceled_at SET:     ${gapByCanceledNull.withCanceledAt}`);
  }
  console.log();

  // Sanity: opposite gap (in KPI but not in dry-run). Should be ~0 if
  // isActiveAsOf is strictly more permissive than isActiveMember.
  const reverseGap = members.filter(
    (m) => isActiveMember(m) && !isActiveAsOf(m, now),
  );
  console.log(`Reverse gap (in KPI, NOT in dry-run): ${reverseGap.length}`);
  if (reverseGap.length > 0 && reverseGap.length <= 10) {
    for (const m of reverseGap) {
      console.log(
        `  status=${m.status} activation=${m.activation_date} canceled=${m.canceled_at} email=${m.email?.slice(0, 30)}`,
      );
    }
  }
  console.log();

  // Sample of gap members, top 10 by status.
  if (gapMembers.length > 0) {
    console.log("Sample of 10 gap members (in dry-run, NOT in KPI):");
    for (const m of gapMembers.slice(0, 10)) {
      const c = parseMemberDate(m.canceled_at);
      console.log(
        `  status=${(m.status ?? "(null)").padEnd(20)} activation=${m.activation_date ?? "(null)"} canceled=${m.canceled_at ?? "(null)"} city=${m.city}`,
      );
      void c;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
