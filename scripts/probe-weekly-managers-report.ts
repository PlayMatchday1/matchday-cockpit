// Probe — GET /api/reports/weekly/managers on the MatchDay API.
// Read-only investigation. No DB writes, no commits intended.
// Run with: npx tsx scripts/probe-weekly-managers-report.ts
// Reads MATCHDAY_API_* from .env.local. Process.env only.

import { readFileSync } from "node:fs";

// Load .env.local manually — tsx doesn't auto-load Next env files.
const envText = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const API_EMAIL = process.env.MATCHDAY_API_EMAIL;
const API_PASSWORD = process.env.MATCHDAY_API_PASSWORD;
const API_BASE = process.env.MATCHDAY_API_BASE_URL;
if (!API_EMAIL || !API_PASSWORD || !API_BASE) {
  console.error("Missing MATCHDAY_API_* env vars.");
  process.exit(1);
}

async function signIn(): Promise<string> {
  const url = new URL("/auth/signin", API_BASE).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: API_EMAIL, password: API_PASSWORD }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Sign-in failed HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const token =
    (typeof json.accessToken === "string" && json.accessToken) ||
    (typeof json.access_token === "string" && json.access_token) ||
    (json.data &&
      typeof (json.data as Record<string, unknown>).accessToken === "string" &&
      ((json.data as Record<string, unknown>).accessToken as string)) ||
    null;
  if (!token) throw new Error("No accessToken in sign-in response");
  return token;
}

async function probe(
  token: string,
  qs: string,
  path: string = "/api/reports/weekly/managers",
  init?: RequestInit,
): Promise<{ status: number; body: unknown; bytes: number }> {
  const url = new URL(`${path}${qs}`, API_BASE);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 500);
  }
  return { status: res.status, body, bytes: text.length };
}

function topLevelKeys(body: unknown): string[] {
  if (Array.isArray(body)) return ["(array)"];
  if (body && typeof body === "object") return Object.keys(body as object);
  return [];
}

(async () => {
  console.log("=== Probe — GET /api/reports/weekly/managers ===\n");
  const token = await signIn();
  console.log("auth: ✓ signed in");

  // Tries — common shapes Heroku dashboards use. Stop early once we
  // find a 200 with payload.
  // POST attempts — maybe the endpoint takes a JSON body instead.
  console.log("\n=== POST attempts ===");
  for (const body of [
    {},
    { startDate: "2026-05-04", endDate: "2026-05-10" },
    { dateFrom: "2026-05-04", dateTo: "2026-05-10" },
    { week: "2026-W19" },
    { from: "2026-05-04", to: "2026-05-10" },
  ]) {
    const r = await probe(token, "", "/api/reports/weekly/managers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(
      `  POST body=${JSON.stringify(body)}: HTTP ${r.status}, ${
        typeof r.body === "object"
          ? JSON.stringify(r.body).slice(0, 200)
          : String(r.body).slice(0, 200)
      }`,
    );
  }

  // Sibling endpoints — maybe the singular /api/reports exists with
  // a "type" param, or there's a manager-listing variant the dashboard
  // hits before the weekly report.
  console.log("\n=== Sibling endpoint discovery ===");
  for (const path of [
    "/api/reports/weekly",
    "/api/reports",
    "/api/reports/managers",
    "/api/reports/weekly/manager",
    "/api/reports/managers/weekly",
  ]) {
    const r = await probe(token, "", path);
    console.log(
      `  GET ${path}: HTTP ${r.status}, ${
        typeof r.body === "object"
          ? JSON.stringify(r.body).slice(0, 200)
          : String(r.body).slice(0, 200)
      }`,
    );
  }

  // OPTIONS preflight — sometimes leaks Allow + cache headers that
  // hint at the schema (especially Allowed-Methods and any custom
  // headers the API expects).
  console.log("\n=== OPTIONS + HEAD probes ===");
  {
    const r = await fetch(
      new URL("/api/reports/weekly/managers", API_BASE).toString(),
      { method: "OPTIONS", headers: { Authorization: `Bearer ${token}` } },
    );
    console.log(`  OPTIONS: HTTP ${r.status}`);
    console.log("  headers:");
    r.headers.forEach((v, k) => {
      if (
        k.toLowerCase().startsWith("access-control-") ||
        k.toLowerCase() === "allow"
      ) {
        console.log(`    ${k}: ${v}`);
      }
    });
  }
  {
    const r = await fetch(
      new URL("/api/reports/weekly/managers", API_BASE).toString(),
      { method: "HEAD", headers: { Authorization: `Bearer ${token}` } },
    );
    console.log(`  HEAD: HTTP ${r.status}`);
  }

  const tries = [
    { label: "start_date/end_date (snake)", qs: "?start_date=2026-05-04&end_date=2026-05-10" },
    { label: "groupBy", qs: "?groupBy=city" },
    { label: "payPeriod", qs: "?payPeriod=2026-05-04" },
    { label: "pay_period", qs: "?pay_period=2026-05-04" },
    { label: "weekly", qs: "?weekly=true" },
    { label: "roleId", qs: "?roleId=manager" },
    { label: "weekStartDate/weekEndDate", qs: "?weekStartDate=2026-05-04&weekEndDate=2026-05-10" },
    { label: "fromTimestamp/toTimestamp", qs: "?fromTimestamp=2026-05-04&toTimestamp=2026-05-10" },
    { label: "since/until", qs: "?since=2026-05-04&until=2026-05-10" },
    { label: "page/limit (pagination)", qs: "?page=1&limit=10" },
    { label: "offset/limit", qs: "?offset=0&limit=10" },
    { label: "managerId", qs: "?managerId=1" },
    { label: "city (raw name)", qs: "?city=Austin" },
    { label: "cityName", qs: "?cityName=Austin" },
    { label: "currentWeek (boolean)", qs: "?currentWeek=true" },
    { label: "period", qs: "?period=2026-W19" },
    { label: "periodStart/periodEnd", qs: "?periodStart=2026-05-04&periodEnd=2026-05-10" },
    { label: "reportDate", qs: "?reportDate=2026-05-04" },
    { label: "weekOf", qs: "?weekOf=2026-05-04" },
    { label: "isoWeek", qs: "?isoWeek=2026-W19" },
    { label: "interval/range", qs: "?interval=week" },
  ];

  let firstOk: { label: string; body: unknown } | null = null;
  for (const t of tries) {
    console.log(`\n--- ${t.label} (qs="${t.qs}") ---`);
    const r = await probe(token, t.qs);
    console.log(`  HTTP ${r.status}, body bytes: ${r.bytes}`);
    console.log(`  top-level keys: ${topLevelKeys(r.body).join(", ")}`);
    if (r.status >= 200 && r.status < 300) {
      // Print first 800 chars of pretty JSON
      console.log("  body sample:");
      const pretty = JSON.stringify(r.body, null, 2);
      console.log(
        pretty.length > 1500 ? pretty.slice(0, 1500) + "\n  ...(truncated)" : pretty,
      );
      if (!firstOk) firstOk = { label: t.label, body: r.body };
    } else {
      // Show error body for failed tries
      const pretty = JSON.stringify(r.body, null, 2);
      console.log(
        `  error body: ${pretty.length > 500 ? pretty.slice(0, 500) + "..." : pretty}`,
      );
    }
  }

  if (!firstOk) {
    console.log("\n✗ No try returned 2xx. Endpoint may need different shape.");
    return;
  }

  // Drill into the working response — probe field shape.
  console.log(`\n=== Field shape analysis (using "${firstOk.label}") ===`);
  const body = firstOk.body;

  // Identify list location
  let records: unknown[] = [];
  let recordsPath = "(unknown)";
  if (Array.isArray(body)) {
    records = body;
    recordsPath = "(top-level array)";
  } else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const k of ["data", "records", "managers", "results", "items", "rows"]) {
      if (Array.isArray(obj[k])) {
        records = obj[k] as unknown[];
        recordsPath = `body.${k}`;
        break;
      }
    }
    // City-grouped shape: maybe an object keyed by city, each city has an array
    if (records.length === 0) {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
          records = v;
          recordsPath = `body.${k} (first array found)`;
          break;
        }
      }
    }
  }
  console.log(`  records location: ${recordsPath}`);
  console.log(`  record count: ${records.length}`);

  if (records.length > 0) {
    const first = records[0] as Record<string, unknown>;
    console.log(`  field names on record[0]: ${Object.keys(first).join(", ")}`);
    console.log("\n  first 3 records:");
    for (let i = 0; i < Math.min(3, records.length); i++) {
      console.log(`\n  [${i}]`);
      console.log(JSON.stringify(records[i], null, 2));
    }

    // Specific field-presence check
    console.log("\n  field presence (across all records):");
    const allKeys = new Set<string>();
    for (const r of records) {
      if (r && typeof r === "object") {
        for (const k of Object.keys(r)) allKeys.add(k);
      }
    }
    const interesting = [
      "manager",
      "managerEmail",
      "manager_email",
      "email",
      "firstName",
      "lastName",
      "name",
      "city",
      "totalMatches",
      "matchCount",
      "weighted",
      "weeklyPayout",
      "weekly_payout",
      "additionalPay",
      "additional_pay",
      "totalWeeklyPay",
      "total_weekly_pay",
      "totalPay",
    ];
    for (const k of interesting) {
      console.log(`    ${k}: ${allKeys.has(k) ? "✓" : "✗"}`);
    }
    console.log(`  ALL keys observed: ${[...allKeys].sort().join(", ")}`);
  }

  // City-grouping check (if response is grouped, the response shape would
  // have city as keys or as a per-record field).
  console.log("\n=== Cross-check: primary-manager match counts for week May 4–10 ===");
  console.log(
    "  (compare against SQL-derived: Drea=10, garrett=9, Moncho Perez=7,",
  );
  console.log("   ale=5, Troy=4, marisol smi...)");
  if (records.length > 0) {
    const cmp = records
      .map((r) => r as Record<string, unknown>)
      .map((r) => ({
        // Try multiple naming conventions
        name:
          (typeof r.manager === "string" && r.manager) ||
          (r.firstName && r.lastName
            ? `${r.firstName} ${r.lastName}`
            : null) ||
          (typeof r.name === "string" && r.name) ||
          "(unknown)",
        email:
          (typeof r.managerEmail === "string" && r.managerEmail) ||
          (typeof r.manager_email === "string" && r.manager_email) ||
          (typeof r.email === "string" && r.email) ||
          null,
        matches:
          (typeof r.totalMatches === "number" && r.totalMatches) ||
          (typeof r.matchCount === "number" && r.matchCount) ||
          (typeof r.matches === "number" && r.matches) ||
          null,
        city: typeof r.city === "string" ? r.city : null,
        weighted:
          (typeof r.weighted === "number" && r.weighted) ||
          (typeof r.weightedScore === "number" && r.weightedScore) ||
          null,
        weekly:
          (typeof r.weeklyPayout === "number" && r.weeklyPayout) ||
          (typeof r.weekly_payout === "number" && r.weekly_payout) ||
          null,
        additional:
          (typeof r.additionalPay === "number" && r.additionalPay) ||
          (typeof r.additional_pay === "number" && r.additional_pay) ||
          null,
        total:
          (typeof r.totalWeeklyPay === "number" && r.totalWeeklyPay) ||
          (typeof r.total_weekly_pay === "number" && r.total_weekly_pay) ||
          (typeof r.totalPay === "number" && r.totalPay) ||
          null,
      }))
      .sort((a, b) => (b.matches ?? 0) - (a.matches ?? 0))
      .slice(0, 12);
    console.log(`\n  top-12 by match count:`);
    console.table(cmp);
  }
})().catch((e) => {
  console.error("Probe failed:", e);
  process.exit(1);
});
