// Round 2 — the first probe got 500s on every "valid" combo and 400s
// on the invalid ones. The 400s leaked the status enum:
//   ACTIVE, INACTIVE, CANCELED, INCOMPLETE, INCOMPLETE_EXPIRED,
//   PAST_DUE, PAUSED, UNPAID, ADDED_FROM_ADMIN
// (9 statuses — more than we'd guessed.)
//
// The 500s suggest we're missing a required param. Two hypotheses:
//   (a) sortColumn / sortDirection are required, not optional
//   (b) limit=1 is too small (server-side bug?) — try limit=100 to
//       match Vitaly's example exactly
//   (c) The path-based form /admin/subscriptions/cities/{abbr} is
//       what works; the query-string form is new and broken
//
// Test all three. Also re-fetch the city list to confirm we're using
// the right abbr (ATX has been stable, but worth a sanity check).

import { readFileSync } from "node:fs";
import {
  getMatchdayApiClient,
  MatchdayApiError,
} from "../src/lib/matchdayApi";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
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

type Envelope = {
  data?: unknown[];
  totalItems?: number;
  total?: number;
  count?: number;
  page?: number;
  limit?: number;
};

function summarize(data: unknown): void {
  const env = data as Envelope;
  const arr = Array.isArray(env?.data) ? env.data : null;
  const totals: string[] = [];
  if (typeof env?.totalItems === "number") totals.push(`totalItems=${env.totalItems}`);
  if (typeof env?.total === "number") totals.push(`total=${env.total}`);
  if (typeof env?.count === "number") totals.push(`count=${env.count}`);
  if (typeof env?.page === "number") totals.push(`page=${env.page}`);
  if (typeof env?.limit === "number") totals.push(`limit=${env.limit}`);
  console.log(`  envelope counts: ${totals.length ? totals.join(", ") : "(none)"}`);
  console.log(`  data array length: ${arr ? arr.length : "(no .data array)"}`);
  if (arr && arr.length > 0) {
    console.log(`  sample row shape:`);
    console.log(JSON.stringify(shape(arr[0]), null, 2).split("\n").map((l) => "    " + l).join("\n"));
  } else {
    console.log(`  full envelope shape:`);
    console.log(JSON.stringify(shape(data), null, 2).split("\n").map((l) => "    " + l).join("\n"));
  }
}

async function probe(
  client: ReturnType<typeof getMatchdayApiClient>,
  label: string,
  path: string,
  query?: Record<string, string | number>,
): Promise<void> {
  console.log(`\n--- ${label} ---`);
  console.log(
    `GET ${path}${query ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : ""}`,
  );
  try {
    const data = await client.get(path, query);
    console.log(`✓ 200 OK`);
    summarize(data);
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
  const client = getMatchdayApiClient();

  console.log("=== Round 2: probe variants ===\n");

  // A. Vitaly's example, exactly — limit=100 (not 1)
  await probe(client, "A. Vitaly's example exactly: limit=100, status=ACTIVE", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    limit: 100,
    page: 1,
    status: "ACTIVE",
  });

  // B. Add sortColumn/sortDirection — common NestJS list pattern
  await probe(client, "B. + sortColumn=createdAt sortDirection=DESC", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    limit: 100,
    page: 1,
    status: "ACTIVE",
    sortColumn: "createdAt",
    sortDirection: "DESC",
  });

  // C. Try lower-case status — some validators are case-sensitive
  await probe(client, "C. status=active (lowercase)", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    limit: 100,
    page: 1,
    status: "active",
  });

  // D. The other status values (since we can't get past the 500 with
  // ACTIVE, maybe ATX legitimately has zero rows in some less-common
  // status and one of those queries succeeds — would tell us the 500
  // is about empty result handling, not a missing param).
  for (const s of ["INACTIVE", "INCOMPLETE", "PAST_DUE", "PAUSED", "ADDED_FROM_ADMIN"]) {
    await probe(client, `D. status=${s}`, "/admin/subscriptions", {
      cityIdentifier: "ATX",
      limit: 100,
      page: 1,
      status: s,
    });
  }

  // E. The path-based form we know worked in earlier probes
  await probe(client, "E. PATH form: /admin/subscriptions/cities/ATX", "/admin/subscriptions/cities/ATX", {
    page: 1,
    limit: 1,
  });

  // F. Path form + status filter
  await probe(client, "F. PATH form + ?status=ACTIVE", "/admin/subscriptions/cities/ATX", {
    page: 1,
    limit: 100,
    status: "ACTIVE",
  });

  // G. Try a different city in case ATX has dirty data triggering the 500
  await probe(client, "G. cityIdentifier=DAL status=ACTIVE", "/admin/subscriptions", {
    cityIdentifier: "DAL",
    limit: 100,
    page: 1,
    status: "ACTIVE",
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
