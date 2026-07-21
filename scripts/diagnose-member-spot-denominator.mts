// Diagnostic: corrected per-city member-spot denominator for the Match
// P&L benchmark month.
//
// Reproduces the real read path (fetchLegacyMatchRegistrations +
// buildMdapiMemberSpotIndex) over the FULL benchmark month, then varies
// only the subscription-linkage strategy so the four candidate bugs can
// be attributed independently:
//
//   A  ACTIVE-only subs, email linkage   ← what ships today
//   B  ALL statuses,   email linkage     ← isolates the status filter
//   C  ALL statuses,   user_id linkage   ← isolates the join key
//
// Numerator is fin_revenue type='Membership' for the same city+month,
// matching cityMembershipRevenueFor.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  fetchLegacyMatchRegistrations,
  type LegacyMatchRegRow,
} from "../src/lib/mdapiMatchesRead";
import { buildMdapiMemberSpotIndex } from "../src/lib/financeStats";
import { mostRecentCompletedMonth } from "../src/lib/quarters";
import { selectAll } from "../src/lib/supabasePagination";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const rd = (n: string) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
};
const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

// Benchmark month = most recent completed calendar month, same as matchPnL.ts.
const bench = mostRecentCompletedMonth();
const now = new Date();
const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const last = new Date(now.getFullYear(), now.getMonth(), 0);
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const FROM = ymd(first);
const TO = ymd(last);
console.log(`benchmark month: ${bench.key}   full-month window: ${FROM} → ${TO}\n`);

type Sub = {
  membership_id: number;
  user_id: number | null;
  member_email: string | null;
  status: string | null;
  activation_date: string | null;
  canceled_at: string | null;
};

const subs = await selectAll<Sub>(() =>
  sb
    .from("mdapi_subscriptions")
    .select("membership_id, user_id, member_email, status, activation_date, canceled_at")
    .order("membership_id"),
);

const vnRows = await selectAll<Record<string, unknown>>(() =>
  sb.from("fin_venues").select("*").order("id"),
);
const venues = vnRows.map((r) => ({
  id: r.id as number,
  venue_name: String(r.venue_name ?? "").trim(),
  raw_venue_name: String(r.venue_name ?? "").trim(),
  city: String(r.city ?? "").trim(),
  cost_per_match: r.cost_per_match == null ? null : Number(r.cost_per_match),
}));
const vfRows = await selectAll<Record<string, unknown>>(() =>
  sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id").order("mdapi_field_id"),
);
const venueFields = new Map<number, number>();
for (const f of vfRows) venueFields.set(Number(f.mdapi_field_id), Number(f.fin_venue_id));

// Two start stamps per match:
//   start_date     — local wall-clock carrying a spurious +00:00 suffix
//   start_date_utc — the true instant
// mdapi_subscriptions activation_date/canceled_at are genuine UTC, so
// membership-window checks must compare against start_date_utc. The
// shipping code passes start_date, which runs 4–5h early per city DST
// offset and drops members who activated during that gap.
const matches = await selectAll<{
  api_id: number;
  start_date: string;
  start_date_utc: string | null;
}>(() =>
  sb
    .from("mdapi_matches")
    .select("api_id, start_date, start_date_utc")
    .gte("start_date", `${FROM}T00:00:00`)
    .lte("start_date", `${TO}T23:59:59`)
    .order("api_id"),
);
const startByMatch = new Map(matches.map((m) => [m.api_id, m.start_date]));
const startUtcByMatch = new Map(
  matches.map((m) => [m.api_id, m.start_date_utc ?? m.start_date]),
);

// Base fetch: pass an empty map so every FREE row comes back as
// FREE_NON_MEMBER and we reclassify below. All other pipeline filters
// (WAITING, fake players, is_absent, unknown city) already applied.
const regs: LegacyMatchRegRow[] = await fetchLegacyMatchRegistrations(
  sb,
  { fromDate: FROM, toDate: TO },
  new Map(),
);
console.log(`registrations in window (post fake/absent/WAITING filters): ${regs.length}`);

const isFreeRow = (r: LegacyMatchRegRow) =>
  (r.payment_type ?? "").toUpperCase() === "FREE_NON_MEMBER" ||
  (r.payment_type ?? "").toUpperCase() === "MEMBER";

// Window-based membership: activated at/before the match AND not yet
// canceled at match time. Status is deliberately ignored — a member who
// played in June and canceled in July is CANCELED today but was a
// member at match time.
function coversMatch(s: Sub, matchMs: number): boolean {
  if (!s.activation_date) return false;
  const act = Date.parse(s.activation_date);
  if (!Number.isFinite(act) || act > matchMs) return false;
  if (s.canceled_at) {
    const can = Date.parse(s.canceled_at);
    if (Number.isFinite(can) && can <= matchMs) return false;
  }
  return true;
}

type Variant = {
  label: string;
  activeOnly: boolean;
  key: "email" | "user_id";
  utc?: boolean;
};
const VARIANTS: Variant[] = [
  { label: "A ships today (ACTIVE-only, email)", activeOnly: true, key: "email" },
  { label: "B all statuses, email", activeOnly: false, key: "email" },
  { label: "C all statuses, user_id", activeOnly: false, key: "user_id" },
  {
    label: "D all statuses, user_id, true UTC instant (corrected)",
    activeOnly: false,
    key: "user_id",
    utc: true,
  },
];

function subIndex(v: Variant): Map<string, Sub[]> {
  const map = new Map<string, Sub[]>();
  for (const s of subs) {
    if (v.activeOnly && s.status !== "ACTIVE") continue;
    const k =
      v.key === "email" ? (s.member_email ?? "").toLowerCase().trim() : String(s.user_id ?? "");
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(s);
    map.set(k, list);
  }
  return map;
}

// "Today" baseline: the quarter-bounds window actually loaded by
// useFinanceData (quarter start − 14d), which clips the benchmark month
// to its final two weeks. Same classifier as variant A.
const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
const truncFrom = ymd(new Date(qStart.getTime() - 14 * 86400_000));
console.log(`shipping window starts: ${truncFrom} (clips ${bench.key})`);
const regsTrunc: LegacyMatchRegRow[] = await fetchLegacyMatchRegistrations(
  sb,
  { fromDate: truncFrom, toDate: TO },
  new Map(),
);

const results = new Map<string, Map<string, number>>(); // variant → city → member spots
const freeRowStats = { total: 0 };
for (const r of regs) if (isFreeRow(r)) freeRowStats.total += 1;

for (const v of [{ label: "TODAY", activeOnly: true, key: "email" } as Variant, ...VARIANTS]) {
  const idx = subIndex(v);
  const source = v.label === "TODAY" ? regsTrunc : regs;
  const reclassified = source.map((r) => {
    if (!isFreeRow(r)) return r;
    const rawStart = v.utc
      ? startUtcByMatch.get(r.match_api_id)
      : startByMatch.get(r.match_api_id);
    const matchMs = rawStart ? Date.parse(rawStart) : NaN;
    const k = v.key === "email" ? (r.email ?? "").toLowerCase().trim() : String(r.user_id ?? "");
    const list = k ? idx.get(k) : undefined;
    const isMember =
      !!list && Number.isFinite(matchMs) && list.some((s) => coversMatch(s, matchMs));
    return { ...r, payment_type: isMember ? "MEMBER" : "FREE_NON_MEMBER" };
  });
  const index = buildMdapiMemberSpotIndex(reclassified, venues, venueFields);
  const byCity = new Map<string, number>();
  for (const [key, counts] of index.byCityMonth) {
    const [city, month] = key.split("|");
    if (month !== bench.key) continue;
    byCity.set(city, counts.member);
  }
  results.set(v.label, byCity);
}

// Numerator: fin_revenue Membership net for the benchmark month.
const revRows = await selectAll<Record<string, unknown>>(() =>
  sb.from("fin_revenue").select("city, month, type, net").order("id"),
);
const memberRevByCity = new Map<string, number>();
for (const r of revRows) {
  if (String(r.type ?? "").trim() !== "Membership") continue;
  if (String(r.month ?? "").trim() !== bench.key) continue;
  const city = String(r.city ?? "").trim();
  memberRevByCity.set(city, (memberRevByCity.get(city) ?? 0) + Number(r.net ?? 0));
}

const cities = [
  ...new Set([...memberRevByCity.keys(), ...[...results.values()].flatMap((m) => [...m.keys()])]),
].sort();

const usd = (n: number) => `$${n.toFixed(2)}`;
const rate = (rev: number, spots: number) => (spots > 0 ? usd(rev / spots) : "—");

console.log(`\nfree-classified rows in window: ${freeRowStats.total}\n`);
const cols = ["NOW", "A", "B", "C", "D"];
console.log(
  ["city", "memberRev", ...cols.flatMap((c) => [`${c} sp`, `${c} $/sp`])]
    .map((h, i) => (i === 0 ? h.padEnd(22) : h.padStart(10)))
    .join(""),
);
for (const city of cities) {
  const rev = memberRevByCity.get(city) ?? 0;
  const counts = [
    results.get("TODAY")!.get(city) ?? 0,
    ...VARIANTS.map((v) => results.get(v.label)!.get(city) ?? 0),
  ];
  console.log(
    [
      city.padEnd(22),
      usd(rev).padStart(10),
      ...counts.flatMap((n) => [String(n).padStart(10), rate(rev, n).padStart(10)]),
    ].join(""),
  );
}
