// Follow-up: H1 showed status=anything-but-ACTIVE returns ids 1-100
// regardless. That suggests the status filter is ignored entirely for
// non-ACTIVE values. Need to confirm:
//
//   Q1: Does paginating a "broken" status (e.g., PAUSED p2, p3, ...)
//       return ids 101-200, 201-300 — i.e., "ignoring filter, just
//       paginating all memberships"? Or does it return the same 100
//       ids forever?
//
//   Q2: When the SAME row appears under multiple status queries (we
//       saw membership_id=1 returned under 8 non-ACTIVE filters),
//       does each return have the SAME `status` field on the row? Or
//       does the API echo back whatever was queried?
//
// Q1 determines whether one non-ACTIVE filter call gives us "all
// memberships ignoring status" (recovery is cheap) or whether we
// can't get past row 100 at all (recovery is hard).
//
// Q2 determines whether we can trust each row's status field as
// ground truth (recovery is clean) or whether the row's status field
// reflects the query (recovery is impossible without /admin/players).

import { readFileSync } from "node:fs";
import { getMatchdayApiClient, MatchdayApiError } from "../src/lib/matchdayApi";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
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

async function fetchPage(city: string, status: string, page: number): Promise<SubRow[]> {
  const client = getMatchdayApiClient();
  try {
    const res = await client.get<Page>("/admin/subscriptions", {
      cityIdentifier: city, status, sortColumn: "id", sortDirection: "asc",
      limit: 100, page,
    });
    return res?.data ?? [];
  } catch (e) {
    if (e instanceof MatchdayApiError) throw new Error(`HTTP ${e.status}`);
    throw e;
  }
}

function range(rows: SubRow[]): string {
  const ids = rows.map(r => r.membershipId).filter((x): x is number => typeof x === "number");
  if (ids.length === 0) return "(empty)";
  return `min=${Math.min(...ids)} max=${Math.max(...ids)} count=${ids.length}`;
}

async function main() {
  // ===== Q1: does pagination advance for the broken status? =====
  console.log("=== Q1: pagination of a broken filter (ATX/PAUSED p1-p5) ===\n");
  for (const page of [1, 2, 3, 4, 5]) {
    try {
      const rows = await fetchPage("ATX", "PAUSED", page);
      console.log(`  ATX/PAUSED p${page}: ${range(rows)}`);
      if (rows.length > 0) {
        const first = rows[0];
        const last = rows[rows.length - 1];
        console.log(`    first: id=${first.membershipId} slug=${first.cityIdentifierAndMemberId} row.status=${JSON.stringify(first.status)}`);
        console.log(`    last:  id=${last.membershipId} slug=${last.cityIdentifierAndMemberId} row.status=${JSON.stringify(last.status)}`);
      }
    } catch (e) {
      console.log(`  ATX/PAUSED p${page}: ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ===== Q2: does the row.status field reflect the query, or the truth? =====
  // Look up the same membership_id (id=1, slug ATX1) under multiple
  // status queries. If row.status field varies with the query → API
  // echoes the query (useless for us). If it's stable → row.status
  // is ground truth.
  console.log("\n\n=== Q2: row.status of membership_id=1 across different status queries ===\n");
  const queries = ["INACTIVE", "CANCELED", "PAUSED", "UNPAID", "PAST_DUE"];
  for (const q of queries) {
    try {
      const rows = await fetchPage("ATX", q, 1);
      const target = rows.find(r => r.membershipId === 1);
      if (target) {
        console.log(`  query status=${q.padEnd(20)} → row.status=${JSON.stringify(target.status)}`);
      } else {
        console.log(`  query status=${q.padEnd(20)} → membership_id=1 not in p1`);
      }
    } catch (e) {
      console.log(`  query status=${q.padEnd(20)} → ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ===== Q3: does ACTIVE behave correctly (only return real actives)? =====
  // Need to confirm that ACTIVE filter IS strict — that's the one
  // status we know works. If not, then nothing about the endpoint is
  // trustworthy and we'd have to fall back to /admin/players/{id}.
  console.log("\n\n=== Q3: are ACTIVE-query rows actually all status=ACTIVE? ===\n");
  for (const city of ["ATX", "HOU"]) {
    try {
      const rows = await fetchPage(city, "ACTIVE", 1);
      const statuses = new Map<string, number>();
      for (const r of rows) {
        const s = String(r.status ?? "(null)");
        statuses.set(s, (statuses.get(s) ?? 0) + 1);
      }
      const breakdown = [...statuses].map(([s, n]) => `${s}=${n}`).join(", ");
      console.log(`  ${city}/ACTIVE p1: row.status breakdown → ${breakdown}`);
    } catch (e) {
      console.log(`  ${city}/ACTIVE p1: ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
