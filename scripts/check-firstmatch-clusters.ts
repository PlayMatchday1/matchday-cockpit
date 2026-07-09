// Read-only: compute firstmatch_repeat_clusters logic in JS against the
// backfilled firstmatch_ledger (mirrors the SQL view) to report what's
// already visible. No writes. Local diagnostic.
//   npx tsx scripts/check-firstmatch-clusters.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const readEnv = (n: string) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
};
const sb = createClient(readEnv("NEXT_PUBLIC_SUPABASE_URL")!, readEnv("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Row = {
  player_api_id: number;
  user_id: number;
  display_name: string | null;
  phone_hash: string | null;
  email_hash: string | null;
  claim_date: string;
  city_identifier: string | null;
  is_cancelled: boolean;
  is_unrecoverable: boolean;
};

async function main() {
  const all: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("firstmatch_ledger")
      .select(
        "player_api_id, user_id, display_name, phone_hash, email_hash, claim_date, city_identifier, is_cancelled, is_unrecoverable",
      )
      .range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }

  const cluster = (key: "phone_hash" | "email_hash") => {
    const byHash = new Map<string, Row[]>();
    for (const r of all) {
      const h = r[key];
      if (!h) continue;
      (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(r);
    }
    return [...byHash.entries()]
      .map(([h, rows]) => ({ h, rows, accounts: new Set(rows.map((r) => r.user_id)).size }))
      .filter((c) => c.accounts >= 2)
      .sort((a, b) => b.accounts - a.accounts);
  };

  const phone = cluster("phone_hash");
  const email = cluster("email_hash");

  console.log(`Ledger rows: ${all.length}  (unrecoverable: ${all.filter((r) => r.is_unrecoverable).length})`);
  console.log(`Repeat clusters — phone: ${phone.length}, email: ${email.length}\n`);

  const show = (label: string, clusters: ReturnType<typeof cluster>) => {
    for (const c of clusters) {
      console.log(`[${label}] ${c.accounts} accounts, ${c.rows.length} claims:`);
      for (const r of c.rows.sort((a, b) => a.claim_date.localeCompare(b.claim_date))) {
        const d = r.claim_date.slice(0, 10);
        const x = r.is_cancelled ? " (cancelled)" : "";
        console.log(`    ${d}  ${r.city_identifier ?? "?"}  ${r.display_name ?? "(no name)"}  [uid ${r.user_id}]${x}`);
      }
      console.log("");
    }
  };
  show("PHONE", phone);
  show("EMAIL", email);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
