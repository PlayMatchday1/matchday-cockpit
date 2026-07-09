// Diagnostic — sync crashed at offset 9500 with "ON CONFLICT DO
// UPDATE command cannot affect row a second time", meaning a single
// 500-row upsert batch contained the same membership_id twice.
//
// Two hypotheses:
//   H1: Same membership returned across multiple status filters for
//       one city (e.g., a row appears in both ACTIVE and PAUSED).
//   H2: membership_id collides across cities in the full dataset
//       (the 193-row probe sample missed it).
//
// Strategy:
//   A. Fetch ATX page 1 (limit 100) for several statuses. Build a
//      map of membership_id → set-of-statuses-it-appeared-under.
//      Any id with >1 status = H1 confirmed.
//   B. Fetch CANCELED page 1 for ATX + HOU + SATX + DAL (whichever
//      cities we have). Build a map of membership_id → set-of-cities.
//      Any id with >1 city = H2 confirmed.
//   C. Bonus: also check ATX + ACTIVE only across pages 1-3 for any
//      same-status same-city duplicates (would be a third bug).

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

type SubRow = {
  membershipId?: number;
  userId?: number;
  cityIdentifierAndMemberId?: string;
  status?: string;
};
type Page = { data?: SubRow[] };

async function fetchOne(cityAbbr: string, status: string, page = 1, limit = 100): Promise<SubRow[]> {
  const client = getMatchdayApiClient();
  try {
    const res = await client.get<Page>("/admin/subscriptions", {
      cityIdentifier: cityAbbr,
      status,
      sortColumn: "id",
      sortDirection: "asc",
      limit,
      page,
    });
    return res?.data ?? [];
  } catch (e) {
    if (e instanceof MatchdayApiError) {
      console.log(`    ✗ ${cityAbbr}/${status} p${page} → HTTP ${e.status}`);
    } else {
      console.log(`    ✗ ${cityAbbr}/${status} p${page} → ${e instanceof Error ? e.message : String(e)}`);
    }
    return [];
  }
}

async function main() {
  // ===== H1: same id across statuses within one city =====
  console.log("=== H1: same membership_id across statuses (ATX) ===\n");
  const statusList = [
    "ACTIVE",
    "INACTIVE",
    "CANCELED",
    "INCOMPLETE",
    "INCOMPLETE_EXPIRED",
    "PAST_DUE",
    "PAUSED",
    "UNPAID",
    "ADDED_FROM_ADMIN",
  ];

  // Map of membership_id → list of statuses it was seen under.
  // Also track the slug to spot-check if the duplicates share other
  // identifying fields (suggesting they really are the same row).
  const idToStatuses = new Map<number, { statuses: Set<string>; slug?: string }>();
  for (const s of statusList) {
    const rows = await fetchOne("ATX", s);
    console.log(`  ATX/${s.padEnd(20)} → ${rows.length} rows`);
    for (const r of rows) {
      if (typeof r.membershipId !== "number") continue;
      const existing = idToStatuses.get(r.membershipId);
      if (existing) {
        existing.statuses.add(s);
      } else {
        idToStatuses.set(r.membershipId, {
          statuses: new Set([s]),
          slug: r.cityIdentifierAndMemberId,
        });
      }
    }
  }

  let h1Hits = 0;
  const h1Examples: Array<{ id: number; statuses: string[]; slug?: string }> = [];
  for (const [id, info] of idToStatuses) {
    if (info.statuses.size > 1) {
      h1Hits++;
      if (h1Examples.length < 10) {
        h1Examples.push({ id, statuses: [...info.statuses], slug: info.slug });
      }
    }
  }

  console.log(
    `\n  Total unique membership_ids seen in ATX (across all 9 statuses, p1 only): ${idToStatuses.size}`,
  );
  console.log(`  Membership_ids appearing in >1 status: ${h1Hits}`);
  if (h1Hits > 0) {
    console.log(`\n  Examples (first 10):`);
    for (const e of h1Examples) {
      console.log(
        `    membership_id=${e.id} slug=${e.slug ?? "?"} statuses=[${e.statuses.join(", ")}]`,
      );
    }
  }

  // ===== H2: same id across cities (CANCELED only — biggest pile) =====
  console.log("\n\n=== H2: same membership_id across cities (status=CANCELED) ===\n");
  const cities = ["ATX", "HOU", "SATX", "DAL"];

  // Map of membership_id → list of cities it was seen in.
  const idToCities = new Map<number, { cities: Set<string>; slugs: Set<string> }>();
  for (const c of cities) {
    // First TWO pages of CANCELED for each — bigger sample than 100
    for (const page of [1, 2]) {
      const rows = await fetchOne(c, "CANCELED", page);
      console.log(`  ${c}/CANCELED p${page} → ${rows.length} rows`);
      for (const r of rows) {
        if (typeof r.membershipId !== "number") continue;
        const existing = idToCities.get(r.membershipId);
        if (existing) {
          existing.cities.add(c);
          if (r.cityIdentifierAndMemberId) existing.slugs.add(r.cityIdentifierAndMemberId);
        } else {
          idToCities.set(r.membershipId, {
            cities: new Set([c]),
            slugs: new Set(r.cityIdentifierAndMemberId ? [r.cityIdentifierAndMemberId] : []),
          });
        }
      }
    }
  }

  let h2Hits = 0;
  const h2Examples: Array<{ id: number; cities: string[]; slugs: string[] }> = [];
  for (const [id, info] of idToCities) {
    if (info.cities.size > 1) {
      h2Hits++;
      if (h2Examples.length < 10) {
        h2Examples.push({ id, cities: [...info.cities], slugs: [...info.slugs] });
      }
    }
  }

  console.log(
    `\n  Total unique membership_ids seen across ${cities.length} cities × 2 pages of CANCELED: ${idToCities.size}`,
  );
  console.log(`  Membership_ids appearing in >1 city: ${h2Hits}`);
  if (h2Hits > 0) {
    console.log(`\n  Examples (first 10):`);
    for (const e of h2Examples) {
      console.log(
        `    membership_id=${e.id} cities=[${e.cities.join(", ")}] slugs=[${e.slugs.join(", ")}]`,
      );
    }
  }

  // ===== H3 (sanity): same-status same-city dupes within paginated stream =====
  console.log("\n\n=== H3 (sanity): same-status same-city duplicates across pages (ATX/ACTIVE p1-3) ===\n");
  const seenInPaginatedStream = new Map<number, number>(); // id → count
  for (const page of [1, 2, 3]) {
    const rows = await fetchOne("ATX", "ACTIVE", page);
    console.log(`  ATX/ACTIVE p${page} → ${rows.length} rows`);
    for (const r of rows) {
      if (typeof r.membershipId !== "number") continue;
      seenInPaginatedStream.set(
        r.membershipId,
        (seenInPaginatedStream.get(r.membershipId) ?? 0) + 1,
      );
    }
  }
  let h3Hits = 0;
  const h3Examples: number[] = [];
  for (const [id, count] of seenInPaginatedStream) {
    if (count > 1) {
      h3Hits++;
      if (h3Examples.length < 5) h3Examples.push(id);
    }
  }
  console.log(
    `\n  Unique ids: ${seenInPaginatedStream.size}, ids seen >1 time: ${h3Hits}`,
  );
  if (h3Hits > 0) {
    console.log(`  Examples: ${h3Examples.join(", ")}`);
  }

  // ===== Verdict =====
  console.log("\n\n=== Verdict ===");
  if (h1Hits > 0 && h2Hits > 0) {
    console.log("  Both H1 AND H2 are true. Status filter is leaky AND cross-city ids collide.");
    console.log("  → switch PK to city_member_slug + dedupe on slug at sync time");
  } else if (h1Hits > 0) {
    console.log("  H1 confirmed. Status filter is not strict — same membership appears under multiple statuses.");
    console.log("  → keep membership_id as PK, dedupe at sync time (last-write-wins by status)");
  } else if (h2Hits > 0) {
    console.log("  H2 confirmed. membership_id collides across cities in the wider dataset.");
    console.log("  → switch PK to city_member_slug (text) OR compound (city_identifier, membership_id)");
  } else if (h3Hits > 0) {
    console.log("  Neither H1 nor H2 — but pagination has duplicates within a single status. Pagination is unstable.");
    console.log("  → dedupe at sync time, possibly add sortColumn that's truly unique");
  } else {
    console.log("  No duplicates found in this sample. The 9500+ inflation must come from a wider dataset.");
    console.log("  → re-probe with broader coverage");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
