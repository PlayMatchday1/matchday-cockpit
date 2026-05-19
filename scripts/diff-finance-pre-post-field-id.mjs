// PR-E diff harness — Node + tsx implementation.
//
// Replaces scripts/diff-finance-pre-post-field-id.sql (kept in
// the repo as a historical artifact). The SQL approach can't
// replicate the TS-only CROSS_VENUE_ALIASES + INTERNAL_PREFIX_RULES
// in src/lib/venueNormalization.ts, so its "pre" snapshot under-
// attributed and produced an unusable diff. This harness instead
// calls into production `buildRankingRows` via `npx tsx` on both
// branches against the same immutable Supabase snapshot, so the
// "pre" and "post" numbers reflect what the page would actually
// render on each branch.
//
// ================================================================
// OPERATOR WORKFLOW
// ================================================================
//
// Run from the repo root.
//
//   1. From PR-E branch — capture the immutable input snapshot:
//        node scripts/diff-finance-pre-post-field-id.mjs snapshot
//
//   2. Copy the script outside the worktree so it survives checkout:
//        cp scripts/diff-finance-pre-post-field-id.mjs /tmp/pr-e-diff.mjs
//
//   3. Check out main and run "pre" against the snapshot:
//        git checkout main
//        node /tmp/pr-e-diff.mjs run pre
//
//   4. Check out PR-E and run "post":
//        git checkout feat/venue-field-id-migration-pre
//        node scripts/diff-finance-pre-post-field-id.mjs run post
//
//   5. Generate the report:
//        node scripts/diff-finance-pre-post-field-id.mjs diff
//
// The `run` phase writes .pr-e-cache/runner.ts from one of two
// embedded code strings (PRE variant uses main-branch
// buildMdapiMemberSpotIndex signature with `aliases`; POST variant
// uses PR-E's `venueFields`). It then invokes `npx tsx` against
// the runner so production code on whichever branch is checked out
// resolves @/lib/* via the project's tsconfig path alias.
//
// Outputs:
//   .pr-e-cache/inputs.json          immutable Supabase snapshot
//   .pr-e-cache/runner.ts            transient tsx runner (gitignored)
//   .pr-e-cache/pre.json             RankingRow[] from main
//   .pr-e-cache/post.json            RankingRow[] from PR-E
//   docs/pr-e-finance-diff-report.md final report
//
// Exit codes (diff phase):
//   0  no unexpected dollar movement (deltas under threshold or in expected list)
//   1  unexpected delta detected — refactor needs review before merge

import { createClient } from "@supabase/supabase-js";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";

// ================================================================
// Config
// ================================================================

const TARGET_MONTH = "Apr 2026";
const TARGET_MONTH_PREFIX = "2026-04";
const REGRESSION_THRESHOLD = 1.0; // $1 — anything tighter trips on rounding

// Expected ~$0 delta. Any non-zero delta on these three flags a
// data issue (not a code issue). Per PR-E investigation: all three
// either retired or launched after April, so April attribution
// should be $0 under both pre and post.
const EXPECTED_NEAR_ZERO_DELTA_VENUES = [
  {
    city: "Houston",
    venue: "Helix Park",
    reason:
      "Retired Feb 28 2026; no April matches expected. Non-zero April attribution implies either a late-arriving mdapi row or an incorrect fin_venue_fields link (field_id 793).",
  },
  {
    city: "Dallas",
    venue: "Crossbar Rowlett",
    reason:
      "Launched May 12 2026; no April activity expected. Non-zero April attribution implies a pre-launch booking that wasn't supposed to count or an incorrect fin_venue_fields link (field_id 1321).",
  },
  {
    city: "Houston",
    venue: "Hattrick T.",
    reason:
      "New Houston venue, placeholder cost suggests May launch. Non-zero April attribution implies misrouting under the OLD path (Houston 'The Hattrick T.' may have been resolving to Austin's Hattrick Leander via the 'The Hattrick' alias) or pre-launch test bookings.",
  },
];

const REPO_ROOT = process.cwd();
const CACHE_DIR = resolve(REPO_ROOT, ".pr-e-cache");
const INPUTS_PATH = join(CACHE_DIR, "inputs.json");
const RUNNER_PATH = join(CACHE_DIR, "runner.ts");
const PRE_PATH = join(CACHE_DIR, "pre.json");
const POST_PATH = join(CACHE_DIR, "post.json");
const REPORT_PATH = resolve(REPO_ROOT, "docs/pr-e-finance-diff-report.md");

// ================================================================
// CLI parsing
// ================================================================

const argv = process.argv.slice(2);
const phase = argv[0];
const tag = argv[1];

function usage() {
  console.log(`Usage: node ${process.argv[1]} <phase> [tag]
  phase: snapshot | run | diff
  tag (for run): pre | post`);
}
if (!phase || !["snapshot", "run", "diff"].includes(phase)) {
  usage();
  process.exit(phase ? 1 : 0);
}
if (phase === "run" && !["pre", "post"].includes(tag ?? "")) {
  usage();
  process.exit(1);
}

mkdirSync(CACHE_DIR, { recursive: true });

function* chunked(arr, n) {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

// ================================================================
// Phase: snapshot
// ================================================================

if (phase === "snapshot") {
  const env = readFileSync(resolve(REPO_ROOT, ".env.local"), "utf8");
  // Vercel CLI's `vercel env pull` writes values quoted; raw-paste
  // setups write them bare. Strip surrounding quotes after capture
  // so both formats work. Throws a clear error if either value is
  // empty (placeholder .env.local from a fresh CLI pull).
  function readEnv(name) {
    const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
    if (!m) throw new Error(`${name} missing from .env.local`);
    const v = m[1].trim().replace(/^["']|["']$/g, "");
    if (!v) {
      throw new Error(
        `${name} is empty in .env.local — populate it (try \`vercel env pull .env.local\`) before running.`,
      );
    }
    return v;
  }
  const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(url, key);

  console.log("Snapshotting Finance inputs for", TARGET_MONTH, "…");

  async function pullAll(query, label) {
    const { data, error } = await query;
    if (error) {
      console.error(`  ${label} query failed:`, error.message);
      process.exit(1);
    }
    console.log(`  ${label}: ${(data ?? []).length} rows`);
    return data ?? [];
  }

  // Reference data — entire tables. Small ( < ~500 rows each).
  const venues = await pullAll(
    sb.from("fin_venues").select("*"),
    "fin_venues",
  );
  const venueAliases = await pullAll(
    sb.from("fin_venue_aliases").select("alias, canonical_venue"),
    "fin_venue_aliases",
  );
  const venueFields = await pullAll(
    sb
      .from("fin_venue_fields")
      .select("fin_venue_id, mdapi_field_id, field_title_at_link"),
    "fin_venue_fields",
  );
  const pricing = await pullAll(
    sb.from("fin_pricing").select("*"),
    "fin_pricing",
  );

  // Monthly fact tables — filter to target month.
  const revenue = await pullAll(
    sb.from("fin_revenue").select("*").eq("month", TARGET_MONTH),
    "fin_revenue (target month)",
  );
  const schedule = await pullAll(
    sb.from("fin_schedule").select("*").eq("month", TARGET_MONTH),
    "fin_schedule (target month)",
  );
  const overrides = await pullAll(
    sb
      .from("fin_venue_cost_overrides")
      .select("*")
      .eq("month", TARGET_MONTH),
    "fin_venue_cost_overrides (target month)",
  );

  // mdapi matches in the target month. Paginated.
  const matchRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("mdapi_matches")
      .select(
        "api_id, city_identifier, field_id, field_title, start_date, is_cancelled",
      )
      .gte("start_date", `${TARGET_MONTH_PREFIX}-01T00:00:00Z`)
      .lt("start_date", `${TARGET_MONTH_PREFIX}-31T23:59:59Z`)
      .order("api_id")
      .range(from, from + 999);
    if (error) {
      console.error("  mdapi_matches query failed:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    matchRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  mdapi_matches (target month): ${matchRows.length} rows`);

  // Joined players for those matches. Chunked .in().
  const matchApiIds = matchRows.map((m) => m.api_id);
  const playerRows = [];
  for (const chunk of chunked(matchApiIds, 200)) {
    const { data, error } = await sb
      .from("mdapi_match_players")
      .select(
        "api_id, match_api_id, user_id, user_email, user_type, paid_status, promocode_id, is_cancelled, canceled_at, amount, created_at, is_absent, user_is_fake_player",
      )
      .in("match_api_id", chunk);
    if (error) {
      console.error("  mdapi_match_players query failed:", error.message);
      process.exit(1);
    }
    if (data) playerRows.push(...data);
  }
  console.log(`  mdapi_match_players (target month): ${playerRows.length} rows`);

  // Promocode names for any promocode_id referenced in the player rows.
  const promoIds = [
    ...new Set(playerRows.map((p) => p.promocode_id).filter((x) => x != null)),
  ];
  const promocodes = [];
  for (const ids of chunked(promoIds, 200)) {
    const { data, error } = await sb
      .from("mdapi_promocodes")
      .select("api_id, code")
      .in("api_id", ids);
    if (error) {
      console.error("  mdapi_promocodes query failed:", error.message);
      process.exit(1);
    }
    if (data) promocodes.push(...data);
  }
  console.log(`  mdapi_promocodes (referenced): ${promocodes.length} rows`);

  const snapshot = {
    snapshot_at: new Date().toISOString(),
    target_month: TARGET_MONTH,
    venues,
    venue_aliases: venueAliases,
    venue_fields: venueFields,
    pricing,
    revenue,
    schedule,
    overrides,
    matches: matchRows,
    players: playerRows,
    promocodes,
  };
  writeFileSync(INPUTS_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`\n✓ Wrote ${INPUTS_PATH}`);
  console.log(`  snapshot timestamp: ${snapshot.snapshot_at}`);
  console.log("\nNext steps:");
  console.log("  cp scripts/diff-finance-pre-post-field-id.mjs /tmp/pr-e-diff.mjs");
  console.log("  git checkout main && node /tmp/pr-e-diff.mjs run pre");
  console.log("  git checkout feat/venue-field-id-migration-pre && node scripts/diff-finance-pre-post-field-id.mjs run post");
  console.log("  node scripts/diff-finance-pre-post-field-id.mjs diff");
}

// ================================================================
// Runner code — written to .pr-e-cache/runner.ts, invoked via tsx.
//
// Two variants: PRE runs against main-branch code (name-based
// buildMdapiMemberSpotIndex signature with `aliases`); POST runs
// against PR-E (id-based signature with `venueFields`). Both
// import buildRankingRows + buildMdapiMemberSpotIndex from
// @/lib/financeStats and toLegacyShape + JoinedMatchPlayerRow
// from @/lib/mdapiMatchesRead. The tsconfig path alias resolves
// to the current branch's src/ tree, so each variant exercises
// the code on whichever branch is checked out.
//
// Both runners reconstruct FinanceData + matchRegistrations from
// inputs.json, call buildRankingRows, then dump the result PLUS
// an augmented "${city}|${venue_name}" listing of every fin_venues
// row not in the rankings (filled with $0). The diff phase reads
// the augmented list so the L2161 zero-filter in production
// buildRankingRows doesn't hide expected-zero venues from the
// report.
// ================================================================

const RUNNER_BODY_SHARED = `
import { readFileSync, writeFileSync } from "node:fs";

function parseLocal(s: string | null): Date | null {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  return new Date(yr, mo - 1, dy, hr, mn);
}

const inputsPath = process.argv[2];
const outputPath = process.argv[3];
const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));

const venueAliases = new Map<string, string>();
for (const a of inputs.venue_aliases) {
  if (a.alias && a.canonical_venue) venueAliases.set(a.alias, a.canonical_venue);
}
const venueFields = new Map<number, number>();
for (const f of inputs.venue_fields) {
  venueFields.set(f.mdapi_field_id, f.fin_venue_id);
}

// Reconstruct JoinedMatchPlayerRow[] from raw player/match/promocode joins.
const matchById = new Map<number, any>(inputs.matches.map((m: any) => [m.api_id, m]));
const promoById = new Map<number, string>(
  inputs.promocodes.map((p: any) => [p.api_id, p.code]),
);
const CITY_FROM_ABBR: Record<string, string> = {
  ATX: "Austin", ATL: "Atlanta", HOU: "Houston", DFW: "Dallas",
  SATX: "San Antonio", STL: "St. Louis", OKC: "OKC", ELP: "El Paso",
};

const regs: any[] = [];
for (const p of inputs.players) {
  if (p.paid_status === "WAITING") continue;
  if (p.user_is_fake_player === true) continue;
  if (p.is_absent === true) continue;
  const m = matchById.get(p.match_api_id);
  if (!m) continue;
  const city = CITY_FROM_ABBR[m.city_identifier ?? ""];
  if (!city) continue;
  const matchStart = parseLocal(m.start_date);
  if (!matchStart) continue;
  let paymentType: string | null = null;
  if (p.paid_status === "FREE") paymentType = "MEMBER";
  else if (p.paid_status === "PAID") {
    paymentType = p.promocode_id != null ? "PROMOCODE" : "DAILY PAID";
  }
  regs.push({
    city,
    field: (m.field_title ?? "").trim(),
    matchStart,
    matchCanceled: !!m.is_cancelled,
    playerCanceledAt: parseLocal(p.canceled_at),
    paymentType,
    promocode: p.promocode_id != null
      ? (promoById.get(p.promocode_id) ?? String(p.promocode_id))
      : null,
    email: p.user_email?.toLowerCase() ?? null,
    matchApiId: m.api_id,
    fieldId: m.field_id ?? null,
    playerApiId: p.api_id,
    userId: p.user_id,
    matchPricePaid: (p.amount ?? 0) / 100,
    registrationAt: parseLocal(p.created_at),
    userType: p.user_type ?? null,
  });
}
`;

// PRE — main-branch signature: buildMdapiMemberSpotIndex(regs, venues, aliases).
// FinanceData on main has venueAliases but no venueFields.
const RUNNER_PRE_CODE = `// AUTO-GENERATED by scripts/diff-finance-pre-post-field-id.mjs — pre variant.
import {
  buildRankingRows,
  buildMdapiMemberSpotIndex,
} from "@/lib/financeStats";
import { toLegacyShape } from "@/lib/mdapiMatchesRead";
${RUNNER_BODY_SHARED}

const legacyRegs = regs.map((r) => toLegacyShape(r as any));
const mdapiMemberSpots = buildMdapiMemberSpotIndex(
  legacyRegs as any,
  inputs.venues,
  venueAliases,
);

const data = {
  venues: inputs.venues,
  venueAliases,
  revenue: inputs.revenue,
  schedule: inputs.schedule,
  overrides: inputs.overrides,
  expenses: [],
  managerPay: [],
  members: [],
  pricing: inputs.pricing ?? [],
  memberSpots: [],
  commentary: null,
  config: {},
  mdapiMemberSpots,
} as any;

const rankings = buildRankingRows(data, regs as any, ${JSON.stringify(TARGET_MONTH)} as any);

// Augment with $0 rows for every fin_venues entry not in rankings.
// Production's L2161 zero-filter drops venues where all three of
// (revenue, memberRev, cost) are zero. The diff phase needs to see
// them so expected-zero venues + new-venue cases are explicit.
const rankedKeys = new Set(rankings.map((r: any) => \`\${r.city}|\${r.venue}\`));
const augmented: any[] = [...rankings];
for (const v of inputs.venues) {
  const k = \`\${v.city}|\${v.venue_name}\`;
  if (rankedKeys.has(k)) continue;
  augmented.push({
    venue: v.venue_name,
    city: v.city,
    launchDate: v.launch_date ?? null,
    launchedMs: Number.POSITIVE_INFINITY,
    revenue: 0,
    totalRevenue: 0,
    memberRev: 0,
    cityMbrPct: 0,
    mbrMixPct: 0,
    dppMixPct: 0,
    cost: 0,
    matchCount: 0,
    billingType: v.billing_type ?? null,
    perMatchRate: v.per_match_rate ?? null,
    monthlyFlat: v.monthly_flat ?? null,
    netPL: 0,
    margin: 0,
  });
}
writeFileSync(outputPath, JSON.stringify(augmented, null, 2));
console.log("Wrote " + outputPath + " (" + augmented.length + " rows, " + rankings.length + " ranked + " + (augmented.length - rankings.length) + " augmented)");
`;

// POST — PR-E signature: buildMdapiMemberSpotIndex(regs, venues, venueFields).
// FinanceData on PR-E has both venueAliases AND venueFields.
const RUNNER_POST_CODE = `// AUTO-GENERATED by scripts/diff-finance-pre-post-field-id.mjs — post variant.
import {
  buildRankingRows,
  buildMdapiMemberSpotIndex,
} from "@/lib/financeStats";
import { toLegacyShape } from "@/lib/mdapiMatchesRead";
${RUNNER_BODY_SHARED}

const legacyRegs = regs.map((r) => toLegacyShape(r as any));
const mdapiMemberSpots = buildMdapiMemberSpotIndex(
  legacyRegs as any,
  inputs.venues,
  venueFields as any,
);

const data = {
  venues: inputs.venues,
  venueAliases,
  venueFields,
  revenue: inputs.revenue,
  schedule: inputs.schedule,
  overrides: inputs.overrides,
  expenses: [],
  managerPay: [],
  members: [],
  pricing: inputs.pricing ?? [],
  memberSpots: [],
  commentary: null,
  config: {},
  mdapiMemberSpots,
} as any;

const rankings = buildRankingRows(data, regs as any, ${JSON.stringify(TARGET_MONTH)} as any);

// Augment with $0 rows for fin_venues not in rankings. Same logic
// as the pre variant — see comment there.
const rankedKeys = new Set(rankings.map((r: any) => \`\${r.city}|\${r.venue}\`));
const augmented: any[] = [...rankings];
for (const v of inputs.venues) {
  const k = \`\${v.city}|\${v.venue_name}\`;
  if (rankedKeys.has(k)) continue;
  augmented.push({
    venue: v.venue_name,
    city: v.city,
    launchDate: v.launch_date ?? null,
    launchedMs: Number.POSITIVE_INFINITY,
    revenue: 0,
    totalRevenue: 0,
    memberRev: 0,
    cityMbrPct: 0,
    mbrMixPct: 0,
    dppMixPct: 0,
    cost: 0,
    matchCount: 0,
    billingType: v.billing_type ?? null,
    perMatchRate: v.per_match_rate ?? null,
    monthlyFlat: v.monthly_flat ?? null,
    netPL: 0,
    margin: 0,
  });
}
writeFileSync(outputPath, JSON.stringify(augmented, null, 2));
console.log("Wrote " + outputPath + " (" + augmented.length + " rows, " + rankings.length + " ranked + " + (augmented.length - rankings.length) + " augmented)");
`;

// ================================================================
// Phase: run
// ================================================================

if (phase === "run") {
  if (!existsSync(INPUTS_PATH)) {
    console.error(`Inputs snapshot missing at ${INPUTS_PATH}`);
    console.error(`Run "node ${process.argv[1]} snapshot" first.`);
    process.exit(1);
  }
  const code = tag === "pre" ? RUNNER_PRE_CODE : RUNNER_POST_CODE;
  writeFileSync(RUNNER_PATH, code);
  const outPath = tag === "pre" ? PRE_PATH : POST_PATH;
  console.log(`Running ${tag} variant via npx tsx…`);
  const r = spawnSync(
    "npx",
    ["tsx", RUNNER_PATH, INPUTS_PATH, outPath],
    { stdio: "inherit", cwd: REPO_ROOT },
  );
  if (r.status !== 0) {
    console.error(`tsx exited with status ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// ================================================================
// Phase: diff
// ================================================================

if (phase === "diff") {
  if (!existsSync(PRE_PATH) || !existsSync(POST_PATH)) {
    console.error("Missing pre.json or post.json — run both run phases first.");
    process.exit(1);
  }
  const inputs = JSON.parse(readFileSync(INPUTS_PATH, "utf8"));
  const pre = JSON.parse(readFileSync(PRE_PATH, "utf8"));
  const post = JSON.parse(readFileSync(POST_PATH, "utf8"));

  const keyOf = (r) => `${r.city}|${r.venue}`;
  const preByKey = new Map(pre.map((r) => [keyOf(r), r]));
  const postByKey = new Map(post.map((r) => [keyOf(r), r]));
  const allKeys = new Set([...preByKey.keys(), ...postByKey.keys()]);

  const zero = {
    revenue: 0,
    memberRev: 0,
    cost: 0,
    matchCount: 0,
    netPL: 0,
  };
  const expectedKeys = new Set(
    EXPECTED_NEAR_ZERO_DELTA_VENUES.map((v) => `${v.city}|${v.venue}`),
  );

  const venueRows = [];
  for (const key of [...allKeys].sort()) {
    const a = preByKey.get(key) ?? zero;
    const b = postByKey.get(key) ?? zero;
    const [city, venue] = key.split("|");
    venueRows.push({
      city,
      venue,
      preNetPL: a.netPL ?? 0,
      postNetPL: b.netPL ?? 0,
      delta: (b.netPL ?? 0) - (a.netPL ?? 0),
      preRev: a.revenue ?? 0,
      postRev: b.revenue ?? 0,
      preMemberRev: a.memberRev ?? 0,
      postMemberRev: b.memberRev ?? 0,
      preCost: a.cost ?? 0,
      postCost: b.cost ?? 0,
      expected: expectedKeys.has(key),
    });
  }

  // Per-city subtotals.
  const cityRows = new Map();
  for (const v of venueRows) {
    let c = cityRows.get(v.city);
    if (!c) {
      c = {
        city: v.city,
        preNetPL: 0,
        postNetPL: 0,
        delta: 0,
        venueCount: 0,
        affected: 0,
      };
      cityRows.set(v.city, c);
    }
    c.preNetPL += v.preNetPL;
    c.postNetPL += v.postNetPL;
    c.delta += v.delta;
    c.venueCount += 1;
    if (Math.abs(v.delta) >= REGRESSION_THRESHOLD) c.affected += 1;
  }

  const unexpected = venueRows.filter(
    (v) => Math.abs(v.delta) >= REGRESSION_THRESHOLD && !v.expected,
  );
  const expectedHits = venueRows.filter(
    (v) => v.expected && Math.abs(v.delta) >= REGRESSION_THRESHOLD,
  );

  const fmtMoney = (n) =>
    `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtMoneySigned = (n) =>
    n === 0
      ? "$0.00"
      : `${n > 0 ? "+" : "-"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const totalAbsDelta = venueRows.reduce((s, v) => s + Math.abs(v.delta), 0);
  const totalSignedDelta = venueRows.reduce((s, v) => s + v.delta, 0);
  const affectedCount = venueRows.filter(
    (v) => Math.abs(v.delta) >= REGRESSION_THRESHOLD,
  ).length;

  const lines = [];
  lines.push("# PR-E Finance diff report");
  lines.push("");
  lines.push(`**Target month:** ${TARGET_MONTH}`);
  lines.push(`**Snapshot timestamp:** ${inputs.snapshot_at}`);
  lines.push(`**Regression threshold:** $${REGRESSION_THRESHOLD.toFixed(2)} per venue`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Venues with delta ≥ $${REGRESSION_THRESHOLD.toFixed(2)}: **${affectedCount}**`);
  lines.push(`- Total signed dollar movement: **${fmtMoneySigned(totalSignedDelta)}**`);
  lines.push(`- Total absolute dollar movement: **${fmtMoney(totalAbsDelta)}**`);
  lines.push(`- Unexpected deltas (not in expected list): **${unexpected.length}**`);
  lines.push("");
  if (unexpected.length === 0 && expectedHits.length === 0) {
    lines.push("✅ No unexpected dollar movement — refactor safe to merge.");
  } else {
    lines.push("❌ Unexpected deltas detected — see sections below.");
  }
  lines.push("");

  lines.push("## Per-city subtotals");
  lines.push("");
  lines.push("| City | Pre Net P&L | Post Net P&L | Delta | Venues affected |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const c of [...cityRows.values()].sort((a, b) => a.city.localeCompare(b.city))) {
    lines.push(
      `| ${c.city} | ${fmtMoney(c.preNetPL)} | ${fmtMoney(c.postNetPL)} | ${fmtMoneySigned(c.delta)} | ${c.affected}/${c.venueCount} |`,
    );
  }
  lines.push("");

  lines.push("## Per-venue diff (deltas above threshold only)");
  lines.push("");
  lines.push(
    "| City | Venue | Pre Net | Post Net | Δ Net | Δ Rev | Δ Member | Δ Cost | Note |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  const movingRows = venueRows
    .filter((v) => Math.abs(v.delta) >= REGRESSION_THRESHOLD)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (movingRows.length === 0) {
    lines.push("| _no venues with non-zero delta_ | | | | | | | | |");
  } else {
    for (const v of movingRows) {
      const note = v.expected ? "✅ expected" : "❌ unexpected";
      const dRev = v.postRev - v.preRev;
      const dMem = v.postMemberRev - v.preMemberRev;
      const dCost = v.postCost - v.preCost;
      lines.push(
        `| ${v.city} | ${v.venue} | ${fmtMoney(v.preNetPL)} | ${fmtMoney(v.postNetPL)} | ${fmtMoneySigned(v.delta)} | ${fmtMoneySigned(dRev)} | ${fmtMoneySigned(dMem)} | ${fmtMoneySigned(dCost)} | ${note} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Expected near-zero venues (hardcoded watchlist)");
  lines.push("");
  for (const ex of EXPECTED_NEAR_ZERO_DELTA_VENUES) {
    const k = `${ex.city}|${ex.venue}`;
    const v = venueRows.find((x) => `${x.city}|${x.venue}` === k);
    const observed = v
      ? `pre ${fmtMoney(v.preNetPL)}, post ${fmtMoney(v.postNetPL)}, delta ${fmtMoneySigned(v.delta)}`
      : "not present in either snapshot";
    const triggered = v && Math.abs(v.delta) >= REGRESSION_THRESHOLD;
    lines.push(`### ${ex.city} · ${ex.venue}`);
    lines.push("");
    lines.push(`- **Status:** ${triggered ? "⚠️ delta above threshold" : "✅ within tolerance"}`);
    lines.push(`- **Observed:** ${observed}`);
    lines.push(`- **Why expected to be ~$0:** ${ex.reason}`);
    lines.push("");
  }

  if (unexpected.length > 0) {
    lines.push("## Regression — unexpected deltas");
    lines.push("");
    lines.push(
      "These venues moved more than the regression threshold and are NOT in the expected list. Each must be triaged before merging.",
    );
    lines.push("");
    for (const v of unexpected) {
      lines.push(
        `- **${v.city} · ${v.venue}**: pre ${fmtMoney(v.preNetPL)} → post ${fmtMoney(v.postNetPL)} (Δ ${fmtMoneySigned(v.delta)})`,
      );
    }
    lines.push("");
  }

  if (expectedHits.length > 0) {
    lines.push("## Expected venues that DID move (require triage)");
    lines.push("");
    lines.push(
      "These venues are in the expected-near-zero list but moved. Per the hardcoded rules, this is also a regression — they should not have April activity.",
    );
    lines.push("");
    for (const v of expectedHits) {
      const ex = EXPECTED_NEAR_ZERO_DELTA_VENUES.find(
        (e) => e.city === v.city && e.venue === v.venue,
      );
      lines.push(
        `- **${v.city} · ${v.venue}**: pre ${fmtMoney(v.preNetPL)} → post ${fmtMoney(v.postNetPL)} (Δ ${fmtMoneySigned(v.delta)}). ${ex?.reason ?? ""}`,
      );
    }
    lines.push("");
  }

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, lines.join("\n"));
  console.log(`Wrote ${REPORT_PATH}`);

  const failed = unexpected.length > 0 || expectedHits.length > 0;
  if (failed) {
    console.error(
      `\n✗ Diff failed: ${unexpected.length} unexpected, ${expectedHits.length} expected-near-zero venues moved.`,
    );
    process.exit(1);
  }
  console.log("\n✓ Diff clean — no unexpected dollar movement.");
}
