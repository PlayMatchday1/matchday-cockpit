// Phase 31 Part 0 — READ-ONLY. Does a per-REDEMPTION record exist, and does it survive
// account deletion? No promo endpoint is called with a body: a probe on a live 100%-off
// code is free matches leaving the building.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/probe-promo-redemptions.ts
import { readFileSync } from "node:fs";
for (const l of readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { createClient } from "@supabase/supabase-js";
import { apiGet } from "../src/lib/matchdayStageApi";

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // ── Q1(b): do user-match rows record WHICH code was used? ──
  const { count: total } = await sb.from("mdapi_match_players").select("*", { count: "exact", head: true });
  const { count: withPromo } = await sb.from("mdapi_match_players").select("*", { count: "exact", head: true }).not("promocode_id", "is", null);
  console.log(`mdapi_match_players: ${total} rows, ${withPromo} carry a promocode_id`);

  const { data: sample } = await sb.from("mdapi_match_players")
    .select("api_id,match_api_id,user_id,user_email,user_first_name,user_last_name,user_phone_number,promocode_id,amount,paid_status,is_cancelled,created_at")
    .not("promocode_id", "is", null).limit(3);
  console.log("\nQ2 — fields available on a redemption row:");
  if (sample?.length) for (const [k, v] of Object.entries(sample[0])) {
    const has = v !== null && v !== "";
    console.log(`   ${k.padEnd(20)} ${has ? "PRESENT" : "null"}${/email|phone|name/.test(k) && has ? "  (PII)" : ""}`);
  }

  // ── Q4: TOMBALL 21494 ──
  const { data: tb } = await sb.from("mdapi_match_players")
    .select("user_id,user_email,match_api_id,created_at,amount,is_cancelled")
    .eq("promocode_id", 21494);
  console.log(`\nQ4 — TOMBALL (21494): ${tb?.length ?? 0} redemption rows in mdapi_match_players`);
  if (tb?.length) {
    const users = new Map<string, number>();
    for (const r of tb) users.set(String(r.user_id), (users.get(String(r.user_id)) ?? 0) + 1);
    console.log(`   DISTINCT accounts: ${users.size}`);
    console.log(`   uses per account : ${[...users.values()].sort((a, b) => b - a).join(", ")}`);
    console.log(`   max per account  : ${Math.max(...users.values())}  (cap is 2)`);
  }
  // the promo's own aggregate, for comparison
  try {
    const d = await apiGet<Record<string, unknown>>("production", "/admin/promocodes/21494");
    console.log(`   API detail: code=${d.code} usageCount=${d.usageCount} cap=${d.numberOfUsesPerUser} type=${d.discountType} value=${d.discountValue} target=${d.targetMatchType}`);
  } catch (e) { console.log("   API detail failed:", e instanceof Error ? e.message : String(e)); }

  // ── Q3: DOES A REDEMPTION SURVIVE ACCOUNT DELETION? ──
  const { data: promoRows } = await sb.from("mdapi_match_players").select("user_id").not("promocode_id", "is", null).limit(20000);
  const ids = [...new Set((promoRows ?? []).map((r) => r.user_id).filter(Boolean))];
  console.log(`\nQ3 — ${ids.length} distinct accounts appear in promo redemptions`);
  const resolved = new Set<number>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb.from("mdapi_users").select("api_id").in("api_id", ids.slice(i, i + 500));
    for (const u of data ?? []) resolved.add(u.api_id as number);
  }
  const orphans = ids.filter((id) => !resolved.has(id as number));
  console.log(`   resolve in mdapi_users: ${resolved.size}`);
  console.log(`   ORPHANED (redemption exists, account does NOT): ${orphans.length}`);
  if (orphans.length) console.log(`   e.g. user_ids ${orphans.slice(0, 8).join(", ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
