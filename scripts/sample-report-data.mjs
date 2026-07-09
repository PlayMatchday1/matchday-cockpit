import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const cities = ["Austin", "Atlanta", "San Antonio"];

for (const city of cities) {
  console.log(`\n=== ${city} ===`);
  for (const month of ["Mar 2026", "Apr 2026"]) {
    const { data: rev } = await sb
      .from("fin_revenue")
      .select("gross, net")
      .eq("city", city)
      .eq("month", month);
    const gross = (rev ?? []).reduce((s, r) => s + Number(r.gross || 0), 0);
    const net = (rev ?? []).reduce((s, r) => s + Number(r.net || 0), 0);
    console.log(
      `  ${month}: gross=$${gross.toFixed(2)}  net=$${net.toFixed(2)}  rows=${(rev ?? []).length}`,
    );
  }

  // Reviews for April 2026 (using start_date YYYY-MM range)
  const { data: rv } = await sb
    .from("mdapi_reviews")
    .select("manager_first_name, star_rating, start_date")
    .eq("city", city)
    .gte("start_date", "2026-04-01")
    .lt("start_date", "2026-05-01");
  if (!rv || rv.length === 0) {
    console.log("  reviews Apr 2026: 0");
    continue;
  }
  const cityAvg =
    rv.reduce((s, r) => s + Number(r.star_rating || 0), 0) / rv.length;
  console.log(
    `  reviews Apr 2026: count=${rv.length}, cityAvg=${cityAvg.toFixed(2)}`,
  );
  const byMgr = new Map();
  for (const r of rv) {
    const n = r.manager_first_name?.trim() || null;
    if (!n) continue;
    const e = byMgr.get(n) ?? { count: 0, sum: 0 };
    e.count += 1;
    e.sum += Number(r.star_rating || 0);
    byMgr.set(n, e);
  }
  const top = [...byMgr.entries()]
    .map(([name, e]) => ({ name, count: e.count, avg: e.sum / e.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  console.table(top);
}
