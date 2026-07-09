// PK verification probe — before shipping the mdapi_subscriptions
// migration we need to know: is `membershipId` unique across cities,
// or does each city have its own counter that resets to 1?
//
// Strategy: fetch one page of ACTIVE memberships from 3 cities
// (ATX, HOU, SATX). Print:
//   - The numeric membershipIds (just the integers — not PII)
//   - The cityIdentifierAndMemberId slug structure
//   - The min/max/range per city
//   - Any cross-city overlap
//
// If membershipIds across cities are disjoint ranges (e.g.,
// ATX = 1..2000, HOU = 2001..3500) → globally unique, use as PK.
// If overlapping ranges → cityIdentifierAndMemberId is safer.

import { readFileSync } from "node:fs";
import { getMatchdayApiClient } from "../src/lib/matchdayApi";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
function readVar(name: string): string | undefined {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}
for (const v of ["MATCHDAY_API_EMAIL", "MATCHDAY_API_PASSWORD", "MATCHDAY_API_BASE_URL"]) {
  const val = readVar(v);
  if (val) process.env[v] = val;
}

type SubRow = {
  membershipId?: number;
  userId?: number;
  cityIdentifierAndMemberId?: string;
  status?: string;
};
type Page = { data?: SubRow[]; totalItems?: number; page?: number; limit?: number };

async function fetchCity(abbr: string): Promise<SubRow[]> {
  const client = getMatchdayApiClient();
  const res = await client.get<Page>("/admin/subscriptions", {
    cityIdentifier: abbr,
    status: "ACTIVE",
    sortColumn: "id",
    sortDirection: "asc", // asc so we see the lowest IDs from this city
    limit: 100,
    page: 1,
  });
  return res?.data ?? [];
}

function fmtRange(nums: number[]): string {
  if (nums.length === 0) return "(empty)";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return `min=${min} max=${max} count=${nums.length}`;
}

async function main() {
  const cities = ["ATX", "HOU", "SATX"];
  const byCity: Record<string, SubRow[]> = {};

  for (const c of cities) {
    process.stdout.write(`Fetching ${c}... `);
    try {
      byCity[c] = await fetchCity(c);
      console.log(`got ${byCity[c].length} rows`);
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
      byCity[c] = [];
    }
  }

  console.log("\n=== membershipId type check ===");
  for (const c of cities) {
    const sample = byCity[c]?.[0];
    if (!sample) {
      console.log(`  ${c}: (no rows)`);
      continue;
    }
    console.log(`  ${c}: typeof membershipId = ${typeof sample.membershipId}`);
    console.log(`        typeof userId       = ${typeof sample.userId}`);
    console.log(`        sample membershipId = ${sample.membershipId}`);
    console.log(`        sample userId       = ${sample.userId}`);
    console.log(`        sample slug         = ${JSON.stringify(sample.cityIdentifierAndMemberId)}`);
  }

  console.log("\n=== membershipId ranges per city (status=ACTIVE, asc, first 100) ===");
  const idSets: Record<string, Set<number>> = {};
  for (const c of cities) {
    const ids = byCity[c]
      .map((r) => r.membershipId)
      .filter((x): x is number => typeof x === "number");
    idSets[c] = new Set(ids);
    console.log(`  ${c}: ${fmtRange(ids)}`);
  }

  console.log("\n=== cross-city overlap check ===");
  // Pairwise intersection — if any two cities share a membershipId,
  // the field is NOT globally unique and we'd need cityIdentifierAndMemberId
  let anyCollision = false;
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      const a = cities[i];
      const b = cities[j];
      const overlap: number[] = [];
      for (const id of idSets[a]) if (idSets[b].has(id)) overlap.push(id);
      if (overlap.length > 0) {
        anyCollision = true;
        console.log(`  ⚠ ${a} ∩ ${b}: ${overlap.length} collision(s) — sample: ${overlap.slice(0, 5).join(", ")}`);
      } else {
        console.log(`  ✓ ${a} ∩ ${b}: 0 collisions`);
      }
    }
  }

  console.log("\n=== userId uniqueness within ACTIVE (sanity) ===");
  // If membershipId can recycle (canceled member rejoins → new
  // membership row with same userId, different membershipId), then
  // userId alone wouldn't be a PK either, but we already knew that.
  // Just confirm userId values look like integers and aren't all
  // weirdly identical.
  for (const c of cities) {
    const userIds = byCity[c].map((r) => r.userId).filter((x): x is number => typeof x === "number");
    const uniq = new Set(userIds);
    console.log(`  ${c}: userIds in this batch = ${userIds.length}, unique = ${uniq.size}`);
  }

  console.log("\n=== slug structure samples (first 5 per city) ===");
  for (const c of cities) {
    console.log(`  ${c}:`);
    for (const r of byCity[c].slice(0, 5)) {
      console.log(`    ${JSON.stringify(r.cityIdentifierAndMemberId)} (membershipId=${r.membershipId})`);
    }
  }

  console.log("\n=== verdict ===");
  if (anyCollision) {
    console.log("  ✗ membershipId collides across cities — must use cityIdentifierAndMemberId (text) as PK");
  } else {
    console.log("  ✓ no membershipId collisions in this sample → membershipId looks globally unique → safe as bigint PK");
    console.log("    NOTE: only checked first 100 ACTIVE per city. Compelling but not absolute proof.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
