// One-off: reconcile San Antonio May 2026 revenue between Cities card
// and Cash Flow. Pull fin_revenue ground truth by type, gross vs net,
// tagged vs untagged venue.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const readEnv = (n) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
};
const sb = createClient(
  readEnv("NEXT_PUBLIC_SUPABASE_URL"),
  readEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

const MONTH = "May 2026";

async function selectAll(factory) {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  while (true) {
    const { data, error } = await factory().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const rows = await selectAll(() =>
  sb
    .from("fin_revenue")
    .select("id, date, month, city, venue, type, gross, fees, net, source")
    .eq("month", MONTH)
    .eq("city", "San Antonio"),
);

console.log(`fin_revenue rows for San Antonio / ${MONTH}: ${rows.length}\n`);

const round = (n) => Math.round(n * 100) / 100;
function agg(rows) {
  const byType = {};
  for (const r of rows) {
    const t = r.type ?? "(null)";
    byType[t] ??= { count: 0, gross: 0, net: 0, fees: 0 };
    byType[t].count++;
    byType[t].gross += Number(r.gross) || 0;
    byType[t].net += Number(r.net) || 0;
    byType[t].fees += Number(r.fees) || 0;
  }
  return byType;
}

console.log("=== By type (gross / net / fees) ===");
const byType = agg(rows);
let totGross = 0,
  totNet = 0;
for (const [t, v] of Object.entries(byType)) {
  console.log(
    `  ${t.padEnd(12)} n=${String(v.count).padStart(4)}  gross=${round(v.gross).toString().padStart(10)}  net=${round(v.net).toString().padStart(10)}  fees=${round(v.fees).toString().padStart(8)}`,
  );
  totGross += v.gross;
  totNet += v.net;
}
console.log(
  `  ${"TOTAL".padEnd(12)} n=${String(rows.length).padStart(4)}  gross=${round(totGross).toString().padStart(10)}  net=${round(totNet).toString().padStart(10)}`,
);

console.log("\n=== DPP only: tagged vs untagged venue ===");
const dpp = rows.filter((r) => r.type === "DPP");
const tagged = dpp.filter((r) => r.venue);
const untagged = dpp.filter((r) => !r.venue);
const sum = (a, k) => round(a.reduce((s, r) => s + (Number(r[k]) || 0), 0));
console.log(
  `  DPP tagged   n=${tagged.length}  gross=${sum(tagged, "gross")}  net=${sum(tagged, "net")}`,
);
console.log(
  `  DPP untagged n=${untagged.length}  gross=${sum(untagged, "gross")}  net=${sum(untagged, "net")}`,
);

console.log("\n=== Private Rental rows (source/venue contains rental) ===");
const rentals = rows.filter((r) =>
  `${r.venue ?? ""} ${r.source ?? ""} ${r.type ?? ""}`
    .toLowerCase()
    .includes("rental"),
);
for (const r of rentals) {
  console.log(
    `  ${r.date} type=${r.type} venue=${r.venue} gross=${r.gross} net=${r.net} source=${r.source}`,
  );
}

console.log("\n=== Candidate reconciliations ===");
const m = (t) => byType[t] ?? { gross: 0, net: 0 };
console.log(
  `  fin_revenue ALL gross by city  = ${round(totGross)}   (Cash-Flow-style if it uses gross)`,
);
console.log(
  `  fin_revenue ALL net by city    = ${round(totNet)}     (Cash-Flow-style if it uses net)`,
);
console.log(`  Cities card reported           = 14692`);
console.log(`  Cash Flow reported             = 15045`);
console.log(`  gap                            = 353`);
