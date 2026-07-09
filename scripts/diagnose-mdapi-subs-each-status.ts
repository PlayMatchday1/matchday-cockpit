// Earlier probe showed status=PAUSED returns rows all with
// row.status="CANCELED" — i.e., filter ignored, returns the CANCELED
// pile. But the actual sync is missing INCOMPLETE_EXPIRED rows that
// exist in the CSV. So the "ignored filter" doesn't return ALL
// non-actives — only some subset (CANCELED + PAST_DUE based on the
// user's verification).
//
// Re-test each non-ACTIVE status individually. For each:
//   - HTTP status
//   - Row count returned
//   - Distinct row.status values present
//
// Three possible behaviors per status:
//   A. Returns 0 rows / 4xx → status is a no-op for this city
//   B. Returns rows with row.status === <queried status> → filter
//      ACTUALLY WORKS for this status, add it to the sync
//   C. Returns rows with row.status === something-else (CANCELED) →
//      filter ignored, redundant with our existing CANCELED loop
//
// If we find any (B), add those statuses to the sync. If all are
// (A) or (C), the missing INCOMPLETE_EXPIRED rows don't come from
// /admin/subscriptions at all (would need a different endpoint).

import { readFileSync } from "node:fs";
import { getMatchdayApiClient, MatchdayApiError } from "../src/lib/matchdayApi";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
function readVar(name: string): string | undefined {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}
for (const v of ["MATCHDAY_API_EMAIL", "MATCHDAY_API_PASSWORD", "MATCHDAY_API_BASE_URL"]) {
  const val = readVar(v);
  if (val) process.env[v] = val;
}

type SubRow = { membershipId?: number; cityIdentifierAndMemberId?: string; status?: string };
type Page = { data?: SubRow[] };

async function probe(city: string, status: string): Promise<void> {
  const client = getMatchdayApiClient();
  console.log(`\n--- city=${city} status=${status} ---`);
  console.log(`GET /admin/subscriptions?cityIdentifier=${city}&status=${status}&sortColumn=id&sortDirection=desc&limit=10&page=1`);
  try {
    const res = await client.get<Page>("/admin/subscriptions", {
      cityIdentifier: city,
      status,
      sortColumn: "id",
      sortDirection: "desc",
      limit: 10,
      page: 1,
    });
    const rows = res?.data ?? [];
    console.log(`  HTTP 200`);
    console.log(`  rows returned: ${rows.length}`);
    if (rows.length === 0) {
      console.log(`  → empty (status either has no data, or filter is strictly empty for this city)`);
      return;
    }
    // Distinct row.status values
    const statusCounts = new Map<string, number>();
    for (const r of rows) {
      const s = String(r.status ?? "(null)");
      statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
    }
    const breakdown = [...statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}=${n}`)
      .join(", ");
    console.log(`  distinct row.status: ${breakdown}`);
    // Verdict
    const onlyMatchedQuery =
      statusCounts.size === 1 && statusCounts.has(status);
    const onlyOther = !statusCounts.has(status);
    if (onlyMatchedQuery) {
      console.log(`  → ✓ FILTER WORKS — all rows have row.status=${status}`);
    } else if (onlyOther) {
      console.log(`  → ✗ filter ignored — rows have a different status entirely`);
    } else {
      console.log(`  → ⚠ mixed — some rows match the query, others don't`);
    }
    // Sample first row to confirm
    const first = rows[0];
    console.log(`  sample: id=${first.membershipId} slug=${first.cityIdentifierAndMemberId} row.status=${JSON.stringify(first.status)}`);
  } catch (e) {
    if (e instanceof MatchdayApiError) {
      console.log(`  ✗ HTTP ${e.status} — ${e.message}`);
      if (e.body) console.log(`  body: ${JSON.stringify(e.body).slice(0, 300)}`);
    } else {
      console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main() {
  console.log("=== Per-status probe (city=ATX) ===");
  // The 6 non-ACTIVE-non-CANCELED-non-PAST_DUE statuses we haven't
  // exhaustively tested. PAST_DUE was confirmed populated already by
  // the verification (58 rows showed up via the CANCELED-loop dump).
  for (const status of [
    "INCOMPLETE_EXPIRED",
    "INCOMPLETE",
    "INACTIVE",
    "PAUSED",
    "UNPAID",
    "ADDED_FROM_ADMIN",
    // Re-test PAST_DUE explicitly — even though it appeared in the
    // CANCELED dump, querying it directly might also return real
    // rows (telling us if it's its own filter or part of the dump).
    "PAST_DUE",
  ]) {
    await probe("ATX", status);
  }

  // For any status that returns >0 rows, probe a second city to
  // sanity-check city scope (don't need to be exhaustive — just one
  // more data point).
  console.log("\n\n=== Spot-check HOU for INCOMPLETE_EXPIRED + INACTIVE ===");
  await probe("HOU", "INCOMPLETE_EXPIRED");
  await probe("HOU", "INACTIVE");
}

main().catch((e) => { console.error(e); process.exit(1); });
