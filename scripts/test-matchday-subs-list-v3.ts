// Round 3 — round 2 leaked sortDirection validation: must be lowercase
// `asc`/`desc`, not `ASC`/`DESC`. Try the corrected combo. Also try
// dropping page/limit defaults entirely. Also: could the endpoint be
// gated on a specific user role that our admin login doesn't have?
// (We can't probe role gating directly, but a 401/403 vs 500
// distinction would tell us.)

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

function shape(value: unknown): unknown {
  if (value === null) return "<null>";
  if (Array.isArray(value)) {
    if (value.length === 0) return ["<empty array>"];
    return [`<Array(${value.length})>`, shape(value[0])];
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = shape(obj[k]);
    return out;
  }
  return `<${typeof value}>`;
}

async function probe(label: string, path: string, query?: Record<string, string | number>) {
  const client = getMatchdayApiClient();
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${path}${query ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : ""}`);
  try {
    const data = await client.get(path, query);
    console.log("✓ 200 OK");
    const env = data as { data?: unknown[]; totalItems?: number; total?: number; count?: number; page?: number; limit?: number };
    const totals: string[] = [];
    if (typeof env?.totalItems === "number") totals.push(`totalItems=${env.totalItems}`);
    if (typeof env?.total === "number") totals.push(`total=${env.total}`);
    if (typeof env?.count === "number") totals.push(`count=${env.count}`);
    if (typeof env?.page === "number") totals.push(`page=${env.page}`);
    if (typeof env?.limit === "number") totals.push(`limit=${env.limit}`);
    console.log(`  envelope counts: ${totals.length ? totals.join(", ") : "(none)"}`);
    const arr = Array.isArray(env?.data) ? env.data : null;
    console.log(`  data array length: ${arr ? arr.length : "(no .data array)"}`);
    if (arr && arr.length > 0) {
      console.log(`  sample row shape:`);
      console.log(JSON.stringify(shape(arr[0]), null, 2).split("\n").map((l) => "    " + l).join("\n"));
    } else {
      console.log(`  full envelope shape:`);
      console.log(JSON.stringify(shape(data), null, 2).split("\n").map((l) => "    " + l).join("\n"));
    }
  } catch (e) {
    if (e instanceof MatchdayApiError) {
      console.log(`✗ HTTP ${e.status} — ${e.message}`);
      if (e.body) console.log(`  body: ${JSON.stringify(e.body).slice(0, 400)}`);
    } else {
      console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main() {
  console.log("=== Round 3: sortDirection corrected to lowercase ===");

  // The big one — corrected sort case
  await probe("A. ACTIVE + sortColumn=createdAt sortDirection=desc", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    limit: 100,
    page: 1,
    status: "ACTIVE",
    sortColumn: "createdAt",
    sortDirection: "desc",
  });

  // Try without sortColumn — maybe sortDirection is required even
  // without it, with a default column
  await probe("B. ACTIVE + sortDirection=desc only (no sortColumn)", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    limit: 100,
    page: 1,
    status: "ACTIVE",
    sortDirection: "desc",
  });

  // Try sortColumn=id — maybe the validator doesn't accept createdAt
  await probe("C. ACTIVE + sortColumn=id sortDirection=desc", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    limit: 100,
    page: 1,
    status: "ACTIVE",
    sortColumn: "id",
    sortDirection: "desc",
  });

  // Check that the same auth gets us through other admin endpoints
  // — rules out "our user lost access" as the cause of the 500s
  await probe("D. SANITY: /admin/players still works", "/admin/players", {
    page: 1,
    limit: 1,
  });

  await probe("E. SANITY: /admin/cities still works", "/admin/cities");
}

main().catch((e) => { console.error(e); process.exit(1); });
