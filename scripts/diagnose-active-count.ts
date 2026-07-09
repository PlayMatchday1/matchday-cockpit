// Diagnostic: explain the gap between the live "Active Members" KPI
// (266) and the May 2026 snapshot's active_count (299).
//
// Background (from src/lib/membershipStats.ts:107-119):
//   - Live KPI uses isActiveMember = strict status === "ACTIVE"
//   - Snapshot uses isActiveAsOf = also counts CANCELED rows whose
//     explicit canceled_at puts them inside their final-cycle grace
//     window
// The "intentional discrepancy" comment claims typical gap 5-15,
// spike 30-40 on billing-batch days. We're seeing 33 — at the high
// end of that range, but worth verifying empirically.
//
// Read-only. No DB writes. No file writes. Output to stdout.
//
// Run: npx tsx scripts/diagnose-active-count.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  isActiveMember,
  isActiveAsOf,
  isPaidExternalMember,
  parseMemberDate,
  type MemberLike,
} from "../src/lib/membershipStats";
import { cityFromAbbr } from "../src/lib/cityMap";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
function readVar(name: string): string | undefined {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}

const supabaseUrl = readVar("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = readVar("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Mirror the FinMember+MemberLike shape that useFinanceData produces
// from mdapi_subscriptions. Fields needed for predicates: status,
// price_cents, email, activation_date, canceled_at, city.
type MdapiRow = {
  membership_id: number;
  city_member_slug: string | null;
  member_email: string | null;
  status: string | null;
  price: number | null;
  city_identifier: string | null;
  activation_date: string | null;
  canceled_at: string | null;
};

type EnrichedMember = MemberLike & {
  membership_id: number;
  slug: string | null;
};

async function fetchAllMdapiSubs(): Promise<MdapiRow[]> {
  const all: MdapiRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("mdapi_subscriptions")
      .select(
        "membership_id, city_member_slug, member_email, status, price, city_identifier, activation_date, canceled_at",
      )
      .order("membership_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as MdapiRow[]));
    if (data.length < PAGE) break;
  }
  return all;
}

// Replicate useFinanceData's loader-level shim: skip rows whose
// city_identifier doesn't map; convert price (dollars) → price_cents.
function toMember(r: MdapiRow): EnrichedMember | null {
  const city = cityFromAbbr(r.city_identifier ?? null);
  if (!city) return null;
  return {
    membership_id: r.membership_id,
    slug: r.city_member_slug,
    status: (r.status ?? "").toString(),
    price_cents: Math.round((r.price ?? 0) * 100),
    email: r.member_email ?? null,
    activation_date: r.activation_date ?? null,
    canceled_at: r.canceled_at ?? null,
    city,
  };
}

function divider(title: string) {
  console.log(`\n=== ${title} ===\n`);
}

function fmtMember(m: EnrichedMember): string {
  return `  id=${m.membership_id} slug=${m.slug ?? "?"} email=${m.email ?? "?"} status=${m.status} price=${(m.price_cents / 100).toFixed(2)} city=${m.city} activated=${m.activation_date ?? "?"} canceled=${m.canceled_at ?? "—"}`;
}

async function main() {
  console.log("Fetching mdapi_subscriptions (paginated)...");
  const raw = await fetchAllMdapiSubs();
  console.log(`Total raw rows: ${raw.length}`);

  // Drop unmapped-city rows first (matches useFinanceData behavior).
  const mapped: EnrichedMember[] = [];
  let droppedNoCity = 0;
  for (const r of raw) {
    const m = toMember(r);
    if (m) mapped.push(m);
    else droppedNoCity++;
  }
  console.log(
    `After cityFromAbbr filter: ${mapped.length} (dropped ${droppedNoCity} unmapped-city rows)`,
  );

  // === SECTION 1: LIVE COUNT ===
  divider("1. LIVE COUNT (isActiveMember — strict status=ACTIVE + paid)");
  const live = mapped.filter(isActiveMember);
  console.log(`Live count: ${live.length}`);
  console.log(
    `Filter: m.status === "ACTIVE" && m.price_cents > 0 && !INTERNAL_EMAIL && !status startsWith INCOMPLETE`,
  );

  // === SECTION 2: SNAPSHOT COUNT ===
  divider("2. SNAPSHOT COUNT (members_monthly_snapshots, May 2026)");
  const { data: mayRow, error: mayErr } = await supabase
    .from("members_monthly_snapshots")
    .select("*")
    .eq("month", "2026-05-01")
    .maybeSingle();
  if (mayErr) {
    console.log(`  query error: ${mayErr.message}`);
  } else if (!mayRow) {
    console.log(`  no row for month=2026-05-01`);
  } else {
    console.log(`  Stored row:`);
    console.log(JSON.stringify(mayRow, null, 2));
  }

  // === SECTION 3: RAW BREAKDOWN ===
  divider("3. RAW BREAKDOWN of mdapi_subscriptions");
  console.log(`Total rows in mdapi_subscriptions: ${raw.length}`);
  console.log(`Mapped (after cityFromAbbr filter): ${mapped.length}\n`);

  const byStatus = new Map<string, number>();
  for (const m of mapped) {
    const s = (m.status ?? "(null)").toUpperCase();
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }
  console.log(`By status:`);
  for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }

  console.log(`\nACTIVE-status rows breakdown:`);
  const actives = mapped.filter((m) => m.status?.toUpperCase() === "ACTIVE");
  console.log(`  total ACTIVE: ${actives.length}`);
  console.log(
    `  ACTIVE with price_cents > 0: ${actives.filter((m) => m.price_cents > 0).length}`,
  );
  console.log(
    `  ACTIVE with price_cents == 0: ${actives.filter((m) => m.price_cents === 0).length}`,
  );
  console.log(
    `  ACTIVE with price < 0 (shouldn't happen): ${actives.filter((m) => m.price_cents < 0).length}`,
  );
  console.log(
    `  ACTIVE failing isPaidExternalMember (internal email + INCOMPLETE*): ${actives.filter((m) => !isPaidExternalMember(m)).length}`,
  );
  console.log(
    `  ACTIVE with canceled_at IS NOT NULL (still ACTIVE but cancellation pending): ${actives.filter((m) => parseMemberDate(m.canceled_at) !== null).length}`,
  );

  console.log(`\nACTIVE-status rows by city:`);
  const byCity = new Map<string, number>();
  for (const m of actives) {
    byCity.set(m.city, (byCity.get(m.city) ?? 0) + 1);
  }
  for (const [c, n] of [...byCity].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n}`);
  }

  console.log(`\nCANCELED-status rows breakdown:`);
  const canceleds = mapped.filter((m) => m.status?.toUpperCase() === "CANCELED");
  console.log(`  total CANCELED: ${canceleds.length}`);
  console.log(
    `  CANCELED with canceled_at IS NOT NULL: ${canceleds.filter((m) => parseMemberDate(m.canceled_at) !== null).length}`,
  );
  console.log(
    `  CANCELED with canceled_at IS NULL (phantom): ${canceleds.filter((m) => parseMemberDate(m.canceled_at) === null).length}`,
  );

  // === SECTION 4: THE DIFF ===
  divider("4. THE DIFF (live set vs snapshot set, asOf=now)");
  const now = new Date();
  console.log(`asOf used: ${now.toISOString()}`);

  const liveSet = new Set(live.map((m) => m.membership_id));
  const snapSet = new Set(
    mapped.filter((m) => isActiveAsOf(m, now)).map((m) => m.membership_id),
  );
  console.log(`Live set size (isActiveMember): ${liveSet.size}`);
  console.log(`Snapshot set size (isActiveAsOf at now): ${snapSet.size}`);
  console.log(`Diff (snap - live) expected to match the 33-row gap.\n`);

  const onlyInSnap: EnrichedMember[] = [];
  const onlyInLive: EnrichedMember[] = [];
  for (const m of mapped) {
    const inLive = liveSet.has(m.membership_id);
    const inSnap = snapSet.has(m.membership_id);
    if (inSnap && !inLive) onlyInSnap.push(m);
    else if (inLive && !inSnap) onlyInLive.push(m);
  }

  console.log(
    `Members in SNAPSHOT but NOT LIVE (snap-extras, capped 50 of ${onlyInSnap.length}):`,
  );
  for (const m of onlyInSnap.slice(0, 50)) console.log(fmtMember(m));

  console.log(
    `\nMembers in LIVE but NOT SNAPSHOT (live-extras, capped 50 of ${onlyInLive.length}):`,
  );
  for (const m of onlyInLive.slice(0, 50)) console.log(fmtMember(m));

  // === SECTION 5: APRIL CROSS-CHECK ===
  divider("5. APRIL CROSS-CHECK (month=2026-04-01)");
  const { data: aprRow, error: aprErr } = await supabase
    .from("members_monthly_snapshots")
    .select("*")
    .eq("month", "2026-04-01")
    .maybeSingle();
  if (aprErr) {
    console.log(`  query error: ${aprErr.message}`);
  } else if (!aprRow) {
    console.log(`  no row for month=2026-04-01`);
  } else {
    console.log(`  Stored April row:`);
    console.log(JSON.stringify(aprRow, null, 2));
  }

  // Recompute isActiveAsOf at end-of-April to see what April should
  // have looked like with our current data.
  const endOfApril = new Date(2026, 3, 30); // April 30, 2026 local
  const aprilSet = new Set(
    mapped.filter((m) => isActiveAsOf(m, endOfApril)).map((m) => m.membership_id),
  );
  console.log(
    `\nRecomputed isActiveAsOf at ${endOfApril.toISOString()}: ${aprilSet.size}`,
  );
  console.log(
    `(Compare against snapshot's stored April active_count above.)`,
  );

  // April diff: who would be active at end-of-April but not currently
  // active live? That's the "rolled off in May" cohort.
  const liveLowerCase = new Set(live.map((m) => m.membership_id));
  const rolledOffInMay = mapped.filter(
    (m) => aprilSet.has(m.membership_id) && !liveLowerCase.has(m.membership_id),
  );
  console.log(
    `\nMembers active at end-of-April but NOT live now (rolled-off-in-May cohort, capped 50 of ${rolledOffInMay.length}):`,
  );
  for (const m of rolledOffInMay.slice(0, 50)) console.log(fmtMember(m));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
