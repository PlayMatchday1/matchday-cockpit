// Phase 1.6 — probe the two endpoints that determine whether the
// MatchDay API can fully replace fin_members + Stripe CSV uploads:
//
//   1. GET /admin/subscriptions/cities/{abbr} — does it surface
//      subscription status, activation date, cancellation date,
//      tier/price, Stripe subscription id?
//   2. GET /admin/players/{id} — does the per-player endpoint
//      return richer data than the list endpoint? (Specifically
//      subscription state.)
//
// Output is PII-safe: response bodies pass through the same
// shape() renderer that masks all values to <type> markers. City
// names + abbreviations are printed raw (public business data, not
// PII) so the operator knows which abbr was probed.

import { readFileSync } from "node:fs";
import {
  getMatchdayApiClient,
  MatchdayApiError,
} from "../src/lib/matchdayApi";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
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

async function safeProbe<T = unknown>(
  client: ReturnType<typeof getMatchdayApiClient>,
  path: string,
  query?: Record<string, string | number>,
): Promise<{ ok: true; data: T } | { ok: false; status?: number; reason: string }> {
  try {
    const data = await client.get<T>(path, query);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof MatchdayApiError) {
      return { ok: false, status: e.status, reason: e.message };
    }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const client = getMatchdayApiClient();

  // === Step A: enumerate cities to find the right abbr ===
  console.log("=== Step A: GET /admin/cities (to enumerate cityAbbr values) ===\n");
  const citiesResult = await safeProbe<unknown>(client, "/admin/cities");
  if (!citiesResult.ok) {
    console.log(`✗ ${citiesResult.reason}`);
    process.exit(1);
  }
  const cities = citiesResult.data;

  // Print the response shape first.
  console.log("Response shape:");
  console.log(JSON.stringify(shape(cities), null, 2));

  // Then extract & print abbr/name pairs raw — public business data,
  // safe to surface so we know what to probe.
  console.log("\nCity abbr/name pairs (public data):");
  const citiesArray = Array.isArray(cities)
    ? cities
    : Array.isArray((cities as Record<string, unknown>)?.data)
      ? ((cities as Record<string, unknown>).data as unknown[])
      : [];
  const cityAbbrs: string[] = [];
  for (const c of citiesArray) {
    if (c && typeof c === "object") {
      const co = c as Record<string, unknown>;
      const abbr = typeof co.abbr === "string" ? co.abbr : undefined;
      const name = typeof co.name === "string" ? co.name : undefined;
      if (abbr) {
        cityAbbrs.push(abbr);
        console.log(`  ${abbr.padEnd(8)} ${name ?? ""}`);
      }
    }
  }
  if (cityAbbrs.length === 0) {
    console.log("  (no city abbrs extracted — cities response shape unexpected)");
    process.exit(1);
  }

  // Pick a city likely to have subscribers. Prefer Austin if present;
  // fall back to whichever first city is returned.
  const preferred = ["ATX", "AUS", "AUSTIN", "Austin", "ATL"];
  let cityAbbr =
    cityAbbrs.find((a) => preferred.includes(a)) ?? cityAbbrs[0];
  console.log(`\nProbing subscriptions for cityAbbr = "${cityAbbr}"\n`);

  // === Step B: subscriptions per city ===
  console.log(
    `=== Step B: GET /admin/subscriptions/cities/${cityAbbr}?page=1&limit=1 ===\n`,
  );
  const subs = await safeProbe(client, `/admin/subscriptions/cities/${cityAbbr}`, {
    page: 1,
    limit: 1,
  });
  if (subs.ok) {
    console.log(JSON.stringify(shape(subs.data), null, 2));
  } else {
    console.log(`✗ HTTP ${subs.status ?? "?"} — ${subs.reason}`);
    // Try without query params (in case the endpoint doesn't take them).
    console.log(
      `\nRetrying without page/limit: GET /admin/subscriptions/cities/${cityAbbr}`,
    );
    const subs2 = await safeProbe(client, `/admin/subscriptions/cities/${cityAbbr}`);
    if (subs2.ok) {
      console.log(JSON.stringify(shape(subs2.data), null, 2));
    } else {
      console.log(`✗ HTTP ${subs2.status ?? "?"} — ${subs2.reason}`);
    }
  }

  // === Step C: per-player endpoint ===
  console.log("\n\n=== Step C: GET /admin/players/{id} for one player ===\n");
  const playersResult = await safeProbe<{
    data?: Array<{ id?: number | string }>;
  }>(client, "/admin/players", { page: 1, limit: 1 });
  if (!playersResult.ok) {
    console.log(`✗ players list failed: ${playersResult.reason}`);
    return;
  }
  const firstId = playersResult.data?.data?.[0]?.id;
  if (firstId === undefined) {
    console.log("✗ couldn't extract a player id from /admin/players response");
    return;
  }
  console.log(`Probing GET /admin/players/${firstId} (id from list endpoint)`);
  const single = await safeProbe(client, `/admin/players/${firstId}`);
  if (single.ok) {
    console.log(JSON.stringify(shape(single.data), null, 2));
  } else {
    console.log(`✗ HTTP ${single.status ?? "?"} — ${single.reason}`);
  }

  // === Step D: find an active member and probe their detail ===
  // The Step C player wasn't a member (userSubscriptions was empty)
  // so we don't see the subscription record shape. Find a member.
  console.log(
    "\n\n=== Step D: find an active member to surface userSubscriptions shape ===\n",
  );

  // Try a filter param first (common NestJS pattern). If the endpoint
  // ignores it we'll fall back to scanning.
  const filteredAttempt = await safeProbe<{
    data?: Array<{ id?: number; isMember?: boolean }>;
  }>(client, "/admin/players", { page: 1, limit: 5, isMember: "true" });
  let memberId: number | undefined;
  if (filteredAttempt.ok) {
    const candidates = filteredAttempt.data?.data ?? [];
    const hit = candidates.find((p) => p.isMember === true);
    if (hit?.id !== undefined) {
      memberId = Number(hit.id);
      console.log(
        `✓ filter ?isMember=true returned a member (id ${memberId})`,
      );
    } else if (candidates.length > 0) {
      console.log(
        "filter ?isMember=true returned rows but none with isMember=true — filter is likely ignored, scanning instead",
      );
    }
  }

  // Fallback: page through /admin/players looking for an active member.
  if (memberId === undefined) {
    console.log(
      "Scanning /admin/players for the first row with isMember=true...",
    );
    outer: for (let page = 1; page <= 20; page++) {
      const res = await safeProbe<{
        data?: Array<{ id?: number; isMember?: boolean }>;
        totalItems?: number;
      }>(client, "/admin/players", { page, limit: 100 });
      if (!res.ok) {
        console.log(`✗ scan page ${page} failed: ${res.reason}`);
        break;
      }
      const rows = res.data?.data ?? [];
      if (rows.length === 0) {
        console.log(`scan exhausted at page ${page}`);
        break;
      }
      for (const r of rows) {
        if (r.isMember === true && r.id !== undefined) {
          memberId = Number(r.id);
          console.log(`✓ found member at page ${page} (id ${memberId})`);
          break outer;
        }
      }
    }
  }

  if (memberId === undefined) {
    console.log(
      "✗ no member found in scan — can't show populated userSubscriptions shape",
    );
    return;
  }

  console.log(`\nProbing GET /admin/players/${memberId}`);
  const memberDetail = await safeProbe(client, `/admin/players/${memberId}`);
  if (!memberDetail.ok) {
    console.log(
      `✗ HTTP ${memberDetail.status ?? "?"} — ${memberDetail.reason}`,
    );
    return;
  }
  console.log(JSON.stringify(shape(memberDetail.data), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
