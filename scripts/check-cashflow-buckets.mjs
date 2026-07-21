import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Sum fin_expenses by month + category, for the Q2 months only.
const Q2 = ["Apr 2026", "May 2026", "Jun 2026"];
const { data: rows } = await sb
  .from("fin_expenses")
  .select("month, category, amount")
  .in("month", Q2);

const byMonthCat = new Map(); // "Apr 2026|Marketing" -> sum
for (const r of rows ?? []) {
  const k = `${r.month}|${r.category}`;
  byMonthCat.set(k, (byMonthCat.get(k) ?? 0) + Number(r.amount ?? 0));
}

const cats = [...new Set((rows ?? []).map((r) => r.category))].sort();

console.log("Per-category totals by month (fin_expenses only — Field Costs separate):\n");
const tbl = cats.map((c) => {
  const apr = byMonthCat.get(`Apr 2026|${c}`) ?? 0;
  const may = byMonthCat.get(`May 2026|${c}`) ?? 0;
  const jun = byMonthCat.get(`Jun 2026|${c}`) ?? 0;
  const aprMay = may - apr;
  const mayJun = jun - may;
  return {
    category: c,
    Apr: apr,
    May: may,
    Jun: jun,
    "Δ Apr→May": aprMay,
    "Δ May→Jun": mayJun,
    "AbsMax Δ":
      Math.max(Math.abs(aprMay), Math.abs(mayJun)),
  };
});
console.table(tbl);

console.log(
  "\nUnder current rule (|Δ| ≥ $500 → Movers):\n",
);
for (const pair of [
  ["Apr 2026", "May 2026", "Apr→May"],
  ["May 2026", "Jun 2026", "May→Jun"],
]) {
  const [from, to, label] = pair;
  console.log(`\n  ${label}:`);
  const movers = [];
  const staticRows = [];
  for (const c of cats) {
    const f = byMonthCat.get(`${from}|${c}`) ?? 0;
    const t = byMonthCat.get(`${to}|${c}`) ?? 0;
    const d = t - f;
    if (Math.abs(f) < 0.5 && Math.abs(t) < 0.5) continue;
    if (Math.abs(d) >= 500) movers.push({ category: c, delta: d });
    else staticRows.push({ category: c, delta: d });
  }
  console.log("    Movers:", movers.map((r) => `${r.category} (Δ$${Math.round(r.delta)})`).join(", ") || "(none)");
  console.log("    Static:", staticRows.map((r) => `${r.category} (Δ$${Math.round(r.delta)})`).join(", ") || "(none)");
}
