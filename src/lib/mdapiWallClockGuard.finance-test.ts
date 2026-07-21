// Repo guard for the mdapi wall-clock/UTC bug class.
//
// mdapi_matches.start_date is venue-LOCAL wall-clock stamped with a fake
// "+00:00". mdapi_matches.start_date_utc is the true instant. Comparing the
// former against a genuine-UTC value (now, users.created_at,
// mdapi_subscriptions.activation_date, …) runs 4–5h early — the venue's DST
// offset — and has now shipped three separate times:
//
//   1. Match Reviews future-filter        (fixed in 3334c78)
//   2. Match P&L subscription window      (fixed in the benchmark-denominator work)
//   3. CRM thread context: match status,  (fixed alongside this guard)
//      upcoming-matches filter, played-this-year count
//
// Fixing symptoms one at a time clearly was not working, so this test pins
// the ENTIRE surface. Any file that parses or SQL-filters `start_date`
// must be on the allowlist below with a reason. A new occurrence fails
// here and forces a decision at review time rather than in production.
//
// If this test fails on your change, you have three options:
//   a) use start_date_utc — correct whenever you compare against an instant;
//   b) use lib/matchTime.ts helpers, which encode the right pairing;
//   c) add your file below WITH a reason, if it is genuinely the benign
//      calendar-window case (see WHY_BENIGN).
//
// Run: npx tsx --test src/lib/mdapiWallClockGuard.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The benign case: `start_date` bounded by a CALENDAR DATE window
// ("2026-06-01T00:00:00Z" … "2026-06-30T23:59:59Z"). A match belongs to the
// venue-local calendar day it is played on, so wall-clock-vs-calendar-
// boundary is the CORRECT pairing — switching these to start_date_utc would
// introduce an off-by-a-day at month/quarter edges, not fix anything.
const WHY_BENIGN = "calendar-window bound (wall-clock vs calendar date is the correct pairing)";

const ALLOWLIST: Record<string, string> = {
  "src/app/api/cities/users-lens/route.ts":
    "wall-clock Date retained deliberately for local day/week/month bucketing; all instant arithmetic (active30d/60d, funnel speed) goes through startUtcMs",
  "src/app/api/crm/threads/[id]/context/route.ts":
    "YEAR_START/END bounds only — 'played this year' means the local calendar year. The already-happened check uses start_date_utc.",
  "src/app/api/schedule-master/discrepancies/route.ts": WHY_BENIGN,
  "src/lib/managerPayCompute.ts":
    WHY_BENIGN + "; the past-start check correctly uses start_date_utc",
  "src/lib/matchPnL.ts": WHY_BENIGN,
  "src/lib/mdapiMatchesRead.ts": WHY_BENIGN + " (opts.fromDate/toDate are YYYY-MM-DD)",
  "src/lib/mdapiMatchesSync.ts": WHY_BENIGN,
  "src/lib/useFinanceData.ts": WHY_BENIGN,
};

// `new Date(...start_date)` / `Date.parse(...start_date)` — parsing the
// wall-clock column into an instant.
const RX_PARSE = /(?:new Date\(|Date\.parse\()[^)]*\bstart_date\b(?!_utc)/;
// PostgREST range filter on the wall-clock column.
const RX_SQL = /\.(?:gte|lte|gt|lt)\(\s*"start_date"/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      sourceFiles(p, out);
    } else if (
      (p.endsWith(".ts") || p.endsWith(".tsx")) &&
      !p.includes(".test.") &&
      !p.includes("finance-test")
    ) {
      out.push(p);
    }
  }
  return out;
}

// Strip comment-only lines so prose about the bug class (lib/matchTime.ts is
// mostly prose about exactly this) never trips the guard.
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function offenders(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles("src")) {
    const lines = readFileSync(file, "utf8").split("\n");
    const bad: string[] = [];
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      if (RX_PARSE.test(line) || RX_SQL.test(line)) {
        bad.push(`${i + 1}: ${line.trim()}`);
      }
    });
    if (bad.length > 0) found.set(file, bad);
  }
  return found;
}

test("every start_date parse / SQL filter is on the reviewed allowlist", () => {
  const found = offenders();
  const unexpected = [...found.keys()].filter((f) => !(f in ALLOWLIST));

  assert.deepEqual(
    unexpected,
    [],
    unexpected.length === 0
      ? ""
      : `\n\nNew mdapi wall-clock usage detected in:\n${unexpected
          .map((f) => `  ${f}\n${found.get(f)!.map((l) => `      ${l}`).join("\n")}`)
          .join("\n")}\n\n` +
          `start_date is venue-local wall-clock with a FAKE +00:00 offset.\n` +
          `Comparing it against a real instant (now, created_at, activation_date)\n` +
          `runs 4-5h early. Use start_date_utc, or lib/matchTime.ts helpers.\n` +
          `If this is the benign calendar-window case, add the file to\n` +
          `ALLOWLIST in ${"src/lib/mdapiWallClockGuard.finance-test.ts"} with a reason.\n`,
  );
});

test("allowlist has no stale entries", () => {
  // A file that no longer touches start_date should drop off the list, so
  // the allowlist can't quietly grow into a rubber stamp.
  const found = offenders();
  const stale = Object.keys(ALLOWLIST).filter((f) => !found.has(f));
  assert.deepEqual(
    stale,
    [],
    `Allowlist entries no longer needed (remove them): ${stale.join(", ")}`,
  );
});

test("every allowlist entry carries a reason", () => {
  for (const [file, reason] of Object.entries(ALLOWLIST)) {
    assert.ok(
      reason && reason.trim().length > 20,
      `${file} needs a substantive reason explaining why its start_date use is safe`,
    );
  }
});

// ---------------------------------------------------------------
// Point checks on the three sites this class has actually bitten.
// ---------------------------------------------------------------

test("CRM context route compares instants against start_date_utc", () => {
  const src = readFileSync("src/app/api/crm/threads/[id]/context/route.ts", "utf8");
  assert.ok(
    !/\.(gt|lt)\(\s*"start_date"\s*,\s*nowIso/.test(src),
    "start_date must never be filtered against nowIso — that is the 4-5h-early bug",
  );
  assert.ok(
    /\.gt\(\s*"start_date_utc"\s*,\s*nowIso/.test(src),
    "upcoming-match filter must use start_date_utc",
  );
  assert.ok(
    /\.lt\(\s*"start_date_utc"\s*,\s*nowIso/.test(src),
    "played-this-year cutoff must use start_date_utc",
  );
  assert.ok(
    /isPastMatch\(/.test(src),
    "match status must derive from isPastMatch, not an inline Date.parse",
  );
});

test("users-lens measures recency and funnel speed on true instants", () => {
  const src = readFileSync("src/app/api/cities/users-lens/route.ts", "utf8");
  assert.ok(
    /startUtcMs/.test(src) && /start_date_utc/.test(src),
    "users-lens must carry the true instant alongside the wall-clock date",
  );
  assert.ok(
    !/firstMatchAt!\.getTime\(\)\s*-\s*.*completedAt/.test(src),
    "signup→first-match duration must not subtract a UTC instant from a wall-clock one",
  );
});

test("matchTime is the single home for these comparisons", () => {
  const src = readFileSync("src/lib/matchTime.ts", "utf8");
  for (const fn of ["matchStartMs", "isPastMatch", "msFromInstantToMatch", "matchLocalDate"]) {
    assert.ok(
      new RegExp(`export function ${fn}\\b`).test(src),
      `lib/matchTime.ts must export ${fn}`,
    );
  }
});
