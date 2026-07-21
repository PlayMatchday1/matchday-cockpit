// Read-only: mirror the UI's cluster + promo logic to confirm which
// clusters are "Free promo used" vs "Full-price repeats". Local diagnostic.
//   npx tsx scripts/check-firstmatch-promo-clusters.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const readEnv = (n: string) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
};
const sb = createClient(readEnv("NEXT_PUBLIC_SUPABASE_URL")!, readEnv("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function selectAll<T>(table: string, cols: string, eq?: [string, unknown]): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).order("api_id" in {} ? "api_id" : "player_api_id", { ascending: true });
    // order column differs per table; fall back without order on error
    let res = await (eq ? q.eq(eq[0], eq[1]) : q).range(from, from + 999);
    if (res.error) {
      // retry without order
      let q2 = sb.from(table).select(cols);
      res = await (eq ? q2.eq(eq[0], eq[1]) : q2).range(from, from + 999);
      if (res.error) throw res.error;
    }
    const rows = (res.data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main() {
  const ledger = await selectAll<any>("firstmatch_ledger", "player_api_id, user_id, display_name, phone_hash, email_hash, claim_date, city_identifier");
  const players = await selectAll<any>("mdapi_match_players", "api_id, promocode_id", ["is_first_match", true]);
  const promoByPlayer = new Map<number, number | null>(players.map((p) => [p.api_id, p.promocode_id]));

  const cat = await sb.from("mdapi_promocodes").select("api_id").ilike("code", "firstmatch");
  const catalog = new Set<number>((cat.data ?? []).map((r: any) => r.api_id));

  const distinct = [...new Set([...promoByPlayer.values()].filter((x): x is number => x != null))];
  const codeById = new Map<number, string>();
  for (let i = 0; i < distinct.length; i += 300) {
    const { data } = await sb.from("mdapi_promocodes").select("api_id, code").in("api_id", distinct.slice(i, i + 300));
    for (const r of (data ?? []) as any[]) codeById.set(r.api_id, r.code);
  }

  const cluster = (key: "phone_hash" | "email_hash") => {
    const by = new Map<string, any[]>();
    for (const r of ledger) {
      const h = r[key];
      if (!h) continue;
      (by.get(h) ?? by.set(h, []).get(h)!).push(r);
    }
    return [...by.values()].filter((rows) => new Set(rows.map((r) => r.user_id)).size >= 2);
  };

  const all = [
    ...cluster("phone_hash").map((rows) => ({ type: "phone", rows })),
    ...cluster("email_hash").map((rows) => ({ type: "email", rows })),
  ];

  let free = 0;
  console.log(`Total clusters: ${all.length} (catalog firstmatch ids: ${[...catalog].join(",")})\n`);
  for (const c of all) {
    const usedFree = c.rows.some((r) => {
      const pid = promoByPlayer.get(r.player_api_id);
      return pid != null && catalog.has(pid);
    });
    if (usedFree) free++;
    console.log(`[${c.type}] ${usedFree ? "FREE PROMO USED" : "full-price repeats"}:`);
    for (const r of c.rows.sort((a, b) => a.claim_date.localeCompare(b.claim_date))) {
      const pid = promoByPlayer.get(r.player_api_id);
      const code = pid != null ? (codeById.get(pid) ?? `#${pid}`) : "—";
      console.log(`    ${r.claim_date.slice(0, 10)} ${r.city_identifier ?? "?"} ${r.display_name ?? "(no name)"}  promo: ${code}`);
    }
    console.log("");
  }
  console.log(`Summary: ${free} free-promo clusters, ${all.length - free} full-price.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
