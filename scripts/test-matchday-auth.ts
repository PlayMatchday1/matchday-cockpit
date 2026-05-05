// Smoke test for the MatchDay API auth helper.
// Verifies that:
//   1. Credentials in .env.local are picked up
//   2. POST /auth/signin succeeds and returns an access token
//   3. A simple authenticated GET against /admin/players works
//   4. We can describe the response shape — without printing any
//      actual values (so the operator can paste output here without
//      leaking player PII)
//
// Run: npx tsx scripts/test-matchday-auth.ts

import { readFileSync } from "node:fs";
import { getMatchdayApiClient, MatchdayApiAuthError, MatchdayApiError } from "../src/lib/matchdayApi";

// Read .env.local and mirror MATCHDAY_API_* vars into process.env so
// the lib (which reads from process.env at call time) sees them.
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
if (!process.env.MATCHDAY_API_EMAIL || !process.env.MATCHDAY_API_PASSWORD) {
  console.error(
    "Missing MATCHDAY_API_EMAIL or MATCHDAY_API_PASSWORD in .env.local. Add them and re-run.",
  );
  process.exit(1);
}

// Replace every value in a response with a type marker, preserving
// only structure (keys, array lengths). Strings, numbers, booleans
// all collapse to their type — no actual values get printed. This
// is the safety guarantee for sharing the smoke-test output.
function shape(value: unknown): unknown {
  if (value === null) return "<null>";
  if (Array.isArray(value)) {
    if (value.length === 0) return ["<empty array>"];
    return [`<Array(${value.length})>`, shape(value[0])];
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = shape(obj[k]);
    }
    return out;
  }
  return `<${typeof value}>`;
}

async function main() {
  console.log("=== MatchDay API smoke test ===");
  console.log(
    `base URL: ${process.env.MATCHDAY_API_BASE_URL ?? "https://playmatchday.herokuapp.com (default)"}`,
  );
  console.log(`account:  ${process.env.MATCHDAY_API_EMAIL}`);
  console.log("");

  const client = getMatchdayApiClient();

  console.log("Calling GET /admin/players?page=1&limit=1 ...");
  let response: unknown;
  try {
    response = await client.get("/admin/players", { page: 1, limit: 1 });
  } catch (e) {
    if (e instanceof MatchdayApiAuthError) {
      console.error(`\nAUTH FAILED: ${e.message}`);
      process.exit(1);
    }
    if (e instanceof MatchdayApiError) {
      console.error(
        `\nREQUEST FAILED (HTTP ${e.status}): ${e.message}`,
      );
      // Print just the keys of the error body, not values, in case
      // the body contains anything sensitive.
      if (e.body && typeof e.body === "object") {
        console.error(
          `  error body keys: ${Object.keys(e.body as Record<string, unknown>).join(", ")}`,
        );
      }
      process.exit(1);
    }
    throw e;
  }

  console.log("✓ Authenticated and request succeeded\n");

  console.log("=== Response shape (no actual values) ===");
  console.log(JSON.stringify(shape(response), null, 2));
  console.log("");
  console.log("→ Safe to copy/paste this output. Strings/numbers/bools");
  console.log("  are replaced with <type> markers; only keys + array");
  console.log("  lengths are visible.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
