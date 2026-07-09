// Phase 2.2 prep — probe GET /admin/subscriptions to determine the
// right sync strategy. Vitaly confirmed the endpoint exists and has
// no rate limits. We need to know:
//
//   1. Does omitting status / sending empty status return ALL
//      statuses, or does the endpoint require it?
//   2. Does it accept multi-value (status=ACTIVE,CANCELED)?
//   3. What's the response envelope shape — same { data, totalItems,
//      page, limit } as /admin/players, or different?
//   4. Are sortColumn/sortDirection optional?
//   5. What does a bogus city do — empty data or error?
//
// The answers determine: simple loop-over-cities (status optional),
// loop-over-cities-and-statuses (required), or middle ground
// (multi-value works).
//
// READ-ONLY. No writes. PII-safe via shape() renderer.

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
for (const v of [
  "MATCHDAY_API_EMAIL",
  "MATCHDAY_API_PASSWORD",
  "MATCHDAY_API_BASE_URL",
]) {
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

function summarize(label: string, data: unknown): void {
  // Pull whatever count fields we find; print them all so we can see
  // which envelope keys this endpoint uses (different endpoints have
  // surprised us before).
  const env = data as Envelope;
  const arr = Array.isArray(env?.data) ? env.data : null;
  const arrLen = arr ? arr.length : null;
  const totals: string[] = [];
  if (typeof env?.totalItems === "number") totals.push(`totalItems=${env.totalItems}`);
  if (typeof env?.total === "number") totals.push(`total=${env.total}`);
  if (typeof env?.count === "number") totals.push(`count=${env.count}`);
  if (typeof env?.page === "number") totals.push(`page=${env.page}`);
  if (typeof env?.limit === "number") totals.push(`limit=${env.limit}`);

  console.log(`✓ ${label}`);
  console.log(`  envelope counts: ${totals.length ? totals.join(", ") : "(none of the usual count fields present)"}`);
  console.log(`  data array length: ${arrLen ?? "(no .data array)"}`);
  if (arr && arr.length > 0) {
    console.log(`  sample row shape:`);
    console.log(
      JSON.stringify(shape(arr[0]), null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
  } else {
    console.log(`  full envelope shape:`);
    console.log(
      JSON.stringify(shape(data), null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
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
    summarize(label, data);
  } catch (e) {
    if (e instanceof MatchdayApiError) {
      console.log(`✗ HTTP ${e.status} — ${e.message}`);
      if (e.body) {
        console.log(`  body: ${JSON.stringify(e.body).slice(0, 300)}`);
      }
    } else {
      console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main() {
  const client = getMatchdayApiClient();

  console.log("=== Probe: GET /admin/subscriptions filter behavior ===\n");
  console.log("Using cityIdentifier=ATX for all status-filter probes.");
  console.log("Each probe uses limit=1 (we want shape + total count, not data).\n");

  // 1. status=ACTIVE — baseline
  await probe(client, "1. status=ACTIVE (baseline)", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    page: 1,
    limit: 1,
    status: "ACTIVE",
  });

  // 2. status= empty string. NOTE: the http client just String()s the
  // value, so passing "" produces "?status=" in the URL. Some servers
  // treat that as "filter not applied", others as "match empty status".
  await probe(client, "2. status= (empty string)", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    page: 1,
    limit: 1,
    status: "",
  });

  // 3. Omit status entirely
  await probe(client, "3. status param omitted", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    page: 1,
    limit: 1,
  });

  // 4. status=ACTIVE,CANCELED — comma-separated multi-value
  await probe(
    client,
    "4. status=ACTIVE,CANCELED (multi-value, comma)",
    "/admin/subscriptions",
    {
      cityIdentifier: "ATX",
      page: 1,
      limit: 1,
      status: "ACTIVE,CANCELED",
    },
  );

  // 5. status=CANCELED only
  await probe(client, "5. status=CANCELED", "/admin/subscriptions", {
    cityIdentifier: "ATX",
    page: 1,
    limit: 1,
    status: "CANCELED",
  });

  // 6. No sortColumn / sortDirection — already implicit in 1 & 3, but
  // let's also confirm the endpoint doesn't reject when neither
  // pagination nor sort is provided.
  await probe(
    client,
    "6. minimal — only cityIdentifier",
    "/admin/subscriptions",
    { cityIdentifier: "ATX" },
  );

  // 7. Bogus city
  await probe(client, "7. cityIdentifier=ZZZ (bogus)", "/admin/subscriptions", {
    cityIdentifier: "ZZZ",
    page: 1,
    limit: 1,
  });

  // 8. Try omitting cityIdentifier entirely — does it return all
  // cities, or require the param? If "all cities" works, sync goes
  // from N×8 calls to N total calls.
  await probe(
    client,
    "8. cityIdentifier omitted (all cities?)",
    "/admin/subscriptions",
    { page: 1, limit: 1 },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
