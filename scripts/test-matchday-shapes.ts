// Phase 1.5 — probe the MatchDay API for subscription, match, and
// review endpoints to inform Phase 2 schema design.
//
// Two passes:
//   1. Try common OpenAPI / Swagger spec paths to enumerate every
//      /admin/* endpoint the API exposes (with HTTP methods). No
//      auth on the first attempt — many NestJS apps serve the spec
//      publicly. Falls back to authed fetch if needed.
//   2. Probe a handful of likely subscription/match/review paths
//      with limit=1 and print response shapes via the same value-
//      masking renderer used in test-matchday-auth.ts. Errors are
//      caught per-endpoint so a 404 on one doesn't kill the run.
//
// Output is PII-safe: every value in real responses is collapsed
// to <type> markers. OpenAPI spec content is treated as public
// documentation and printed as-is (paths + methods only).

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
const baseUrl =
  process.env.MATCHDAY_API_BASE_URL ?? "https://playmatchday.herokuapp.com";

// PII-safe: replace every value with a type marker, preserving
// only structure (keys + array lengths).
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

// === Pass 1: OpenAPI / Swagger spec ===

async function tryFetchOpenApi(): Promise<unknown | null> {
  // NestJS apps typically serve the spec JSON at /api-docs-json (when
  // Swagger UI is at /api-docs), or at /api when SwaggerModule is
  // mounted at the root. Try common paths.
  const candidates = [
    "/api-docs-json",
    "/api-json",
    "/api/docs-json",
    "/api/json",
    "/swagger.json",
    "/swagger/json",
    "/docs-json",
  ];
  for (const path of candidates) {
    try {
      const res = await fetch(`${baseUrl}${path}`);
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) continue;
      const json = (await res.json()) as Record<string, unknown>;
      if (json && typeof json === "object" && "paths" in json) {
        console.log(`✓ Found OpenAPI spec at ${baseUrl}${path}\n`);
        return json;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function listAdminPaths(spec: unknown): void {
  if (!spec || typeof spec !== "object") return;
  const paths = (spec as Record<string, unknown>)["paths"];
  if (!paths || typeof paths !== "object") {
    console.log("(spec has no `paths` key)");
    return;
  }
  const adminPaths = Object.keys(paths as Record<string, unknown>)
    .filter((p) => p.startsWith("/admin"))
    .sort();
  if (adminPaths.length === 0) {
    console.log("(no /admin/* paths in spec)");
    return;
  }
  console.log(`/admin/* endpoints (${adminPaths.length}):`);
  for (const p of adminPaths) {
    const ops = (paths as Record<string, unknown>)[p] as Record<
      string,
      unknown
    >;
    const methods = Object.keys(ops)
      .filter((k) => ["get", "post", "put", "patch", "delete"].includes(k))
      .map((k) => k.toUpperCase())
      .sort()
      .join(",");
    // Pull short summary if present.
    let summary = "";
    for (const m of Object.keys(ops)) {
      const op = ops[m] as Record<string, unknown>;
      if (op && typeof op === "object" && typeof op.summary === "string") {
        summary = op.summary;
        break;
      }
    }
    console.log(
      `  ${methods.padEnd(15)} ${p}${summary ? `   — ${summary}` : ""}`,
    );
  }
}

// === Pass 2: probe candidate endpoints ===

type Probe = {
  label: string;
  path: string;
  query?: Record<string, string | number>;
};

const PROBES: Probe[] = [
  // Subscriptions / memberships
  {
    label: "subscriptions",
    path: "/admin/subscriptions",
    query: { page: 1, limit: 1 },
  },
  {
    label: "memberships (alt)",
    path: "/admin/memberships",
    query: { page: 1, limit: 1 },
  },
  // Matches
  { label: "matches", path: "/admin/matches", query: { page: 1, limit: 1 } },
  // Reviews — three plausible paths
  { label: "reviews", path: "/admin/reviews", query: { page: 1, limit: 1 } },
  {
    label: "matches/reviews",
    path: "/admin/matches/reviews",
    query: { page: 1, limit: 1 },
  },
  {
    label: "match-reviews",
    path: "/admin/match-reviews",
    query: { page: 1, limit: 1 },
  },
];

async function probe(p: Probe) {
  const client = getMatchdayApiClient();
  const qs = p.query
    ? "?" +
      new URLSearchParams(
        Object.entries(p.query).map(([k, v]) => [k, String(v)]),
      ).toString()
    : "";
  console.log(`\n--- ${p.label}: GET ${p.path}${qs} ---`);
  try {
    const res = await client.get(p.path, p.query);
    console.log(JSON.stringify(shape(res), null, 2));
  } catch (e) {
    if (e instanceof MatchdayApiError) {
      console.log(`✗ HTTP ${e.status}`);
      if (e.body && typeof e.body === "object") {
        const body = e.body as Record<string, unknown>;
        const keys = Object.keys(body);
        if (keys.length > 0) {
          console.log(`  body keys: ${keys.join(", ")}`);
          // Print error message if present (typically not PII).
          if (typeof body.message === "string") {
            console.log(`  message: ${body.message}`);
          } else if (Array.isArray(body.message)) {
            console.log(`  message: [array of ${body.message.length}]`);
          }
        }
      }
    } else {
      console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main() {
  console.log("=== Pass 1: OpenAPI spec discovery ===\n");
  const spec = await tryFetchOpenApi();
  if (spec) {
    listAdminPaths(spec);
  } else {
    console.log("(no OpenAPI spec found at common paths — skipping)");
  }

  console.log("\n\n=== Pass 2: probe candidate endpoints ===");
  for (const p of PROBES) {
    await probe(p);
  }

  console.log("\n=== Done ===");
  console.log(
    "Probe responses use the PII-safe shape() renderer — values are <type> markers.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
