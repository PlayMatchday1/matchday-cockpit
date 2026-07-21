import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function pageAll(builder) {
  const out = [];
  for (let from = 0;; from += 1000) {
    const { data, error } = await builder().range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// === Q1: All April field_titles by match count ===
const matches = await pageAll(() =>
  sb.from("mdapi_matches")
    .select("api_id, field_title, is_cancelled")
    .gte("start_date", "2026-04-01")
    .lt("start_date", "2026-05-01")
    .eq("is_cancelled", false)
    .order("api_id"),
);
const byField = new Map();
for (const m of matches) {
  const k = m.field_title ?? "(null)";
  byField.set(k, (byField.get(k) ?? 0) + 1);
}
console.log("=== Q1: April 2026 distinct field_title values (non-cancelled matches) ===");
console.log(`(${matches.length} matches total)\n`);
console.log("field_title                                                  match_count");
const sorted1 = [...byField.entries()].sort((a, b) => b[1] - a[1]);
for (const [field, count] of sorted1) {
  console.log(`${String(field).padEnd(58)}  ${String(count).padStart(11)}`);
}

// === Q2: All April fin_revenue venue/type rollup ===
const { data: rev } = await sb
  .from("fin_revenue")
  .select("venue, type, gross")
  .eq("month", "Apr 2026");
const agg2 = new Map();
for (const r of rev ?? []) {
  const k = `${r.venue ?? "(null)"}|${r.type ?? "(null)"}`;
  const v = agg2.get(k) ?? { venue: r.venue, type: r.type, total: 0 };
  v.total += Number(r.gross ?? 0);
  agg2.set(k, v);
}
console.log("\n\n=== Q2: fin_revenue (Apr 2026) by venue × type ===");
console.log("venue                                  type                     total");
const sorted2 = [...agg2.values()].sort((a, b) => b.total - a.total);
for (const r of sorted2) {
  console.log(`${String(r.venue ?? "").padEnd(38)}  ${String(r.type ?? "").padEnd(22)}  ${fmt(r.total).padStart(11)}`);
}

// === Q3a: Players by is_cancelled, where created_at in April (mirrors user's SQL literally) ===
const playersByCreated = await pageAll(() =>
  sb.from("mdapi_match_players")
    .select("api_id, is_cancelled, paid_status, user_type, promocode_id, match_api_id, created_at")
    .gte("created_at", "2026-04-01")
    .lt("created_at", "2026-05-01")
    .order("api_id"),
);
const byCancel = new Map();
for (const p of playersByCreated) {
  const k = String(!!p.is_cancelled);
  byCancel.set(k, (byCancel.get(k) ?? 0) + 1);
}
console.log("\n\n=== Q3a: mdapi_match_players grouped by is_cancelled (created_at in April) ===");
console.log(`(${playersByCreated.length} player rows total)\n`);
for (const [k, n] of byCancel) {
  console.log(`  is_cancelled=${k.padEnd(5)} → ${n} players`);
}

// === Q3b: Derived payment_type breakdown (more useful for the partner formula) ===
function derivePaymentType(p) {
  if (p.paid_status === "FREE") return "MEMBER";
  if (p.paid_status === "PAID" && p.promocode_id != null) return "PROMOCODE";
  if (p.paid_status === "PAID") return "DAILY PAID";
  return "WAITING / OTHER";
}
const byPaymentType = new Map();
for (const p of playersByCreated) {
  if (p.user_type !== "PLAYER") continue;
  if (p.is_cancelled) continue;
  const pt = derivePaymentType(p);
  byPaymentType.set(pt, (byPaymentType.get(pt) ?? 0) + 1);
}
console.log("\n=== Q3b: Active (PLAYER, not cancelled) by derived payment_type ===");
console.log("(Only DAILY PAID counts toward the new Field Ranking formula)\n");
const sorted3b = [...byPaymentType.entries()].sort((a, b) => b[1] - a[1]);
for (const [pt, n] of sorted3b) {
  console.log(`  ${pt.padEnd(18)} → ${n} players`);
}

// === Q3c: Same but filtered to April-match-start matches (closer to the partner-formula scope) ===
const aprilMatchIds = new Set(matches.map((m) => m.api_id));
let aprilMatchPlayers = [];
const allIds = [...aprilMatchIds];
// Paginate via api_id chunks since we're filtering by match_api_id which has many values.
for (let i = 0; i < allIds.length; i += 200) {
  const chunk = allIds.slice(i, i + 200);
  const got = await pageAll(() =>
    sb.from("mdapi_match_players")
      .select("api_id, is_cancelled, paid_status, user_type, promocode_id, match_api_id, user_email")
      .in("match_api_id", chunk)
      .order("api_id"),
  );
  aprilMatchPlayers.push(...got);
}
const STAFF = "matchday.com";
const byPt2 = new Map();
let dpRevSum = 0;
for (const p of aprilMatchPlayers) {
  if (p.user_type !== "PLAYER") continue;
  if (p.is_cancelled) continue;
  const pt = derivePaymentType(p);
  byPt2.set(pt, (byPt2.get(pt) ?? 0) + 1);
}
console.log("\n=== Q3c: Players assigned to non-cancelled April matches, by payment_type ===");
console.log(`(matches by start_date, not player created_at — the partner-formula scope)\n`);
for (const [pt, n] of [...byPt2.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pt.padEnd(18)} → ${n} players`);
}
