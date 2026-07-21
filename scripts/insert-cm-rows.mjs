import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Step A — confirm the migration ran (table is gone).
console.log("=== A. Verify fin_monthly_expenses is dropped ===");
const probe = await fetch(
  `${url}/rest/v1/fin_monthly_expenses?select=id&limit=1`,
  { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
);
if (probe.status === 404) {
  console.log(`  ✓ Table is gone (HTTP 404 / PGRST205).`);
} else {
  console.log(`  ⚠ Unexpected status ${probe.status} — STOP.`);
  console.log(`  body: ${await probe.text()}`);
  process.exit(1);
}

// Step B — bulk insert.
const rowsToInsert = [
  // [vendor, city, date, amount, notes]
  ["Anton", "El Paso", "2026-04-11", 500.0, "April CM payment"],
  ["Anton", "El Paso", "2026-05-11", 317.0, "El Paso paused — partial payment"],
  ["Abraham", "San Antonio", "2026-04-15", 500.0, "April CM payment"],
  ["Abraham", "San Antonio", "2026-05-15", 500.0, "May CM payment"],
  ["Abraham", "San Antonio", "2026-06-15", 500.0, "June CM payment"],
  ["Gabe", "Austin", "2026-04-15", 500.0, "April CM payment"],
  ["Gabe", "Austin", "2026-05-15", 500.0, "May CM payment"],
  ["Gabe", "Austin", "2026-06-15", 500.0, "June CM payment"],
  ["Chris", "Dallas", "2026-04-15", 800.0, "April CM payment"],
  ["Chris", "Dallas", "2026-05-15", 800.0, "May CM payment"],
  ["Chris", "Dallas", "2026-06-15", 800.0, "June CM payment"],
  ["Rodrigo", "OKC", "2026-04-01", 500.0, "April CM payment"],
  ["Rodrigo", "OKC", "2026-05-01", 500.0, "May CM payment"],
  ["Rodrigo", "OKC", "2026-06-01", 500.0, "June CM payment"],
  ["Yarra", "Houston", "2026-04-05", 500.0, "April CM payment"],
  ["Yarra", "Houston", "2026-05-05", 500.0, "May CM payment"],
  ["Yarra", "Houston", "2026-06-05", 500.0, "June CM payment"],
  ["Willfried", "St. Louis", "2026-04-05", 500.0, "April CM payment"],
  ["Willfried", "St. Louis", "2026-05-05", 500.0, "May CM payment"],
  ["Willfried", "St. Louis", "2026-06-05", 500.0, "June CM payment"],
];

const MONTH_LABEL = {
  "04": "Apr",
  "05": "May",
  "06": "Jun",
};

const payload = rowsToInsert.map(([vendor, city, date, amount, notes]) => {
  const [year, mo] = date.split("-");
  const month = `${MONTH_LABEL[mo]} ${year}`;
  return {
    date,
    month,
    city,
    category: "City Manager",
    vendor,
    amount,
    notes,
    manual_entry: true,
  };
});

console.log(`\n=== B. Insert ${payload.length} rows (single call, atomic) ===`);
const { data: inserted, error: insErr } = await sb
  .from("fin_expenses")
  .insert(payload)
  .select();

if (insErr) {
  console.error("  INSERT FAILED:", insErr);
  process.exit(1);
}
console.log(`  ✓ ${inserted.length} rows inserted`);
console.log(
  `  ID range: ${Math.min(...inserted.map((r) => r.id))} … ${Math.max(...inserted.map((r) => r.id))}`,
);

// Step C — verify count + per-month totals.
console.log(
  "\n=== C. Verify in database (category=City Manager, 2026-04-01 to 2026-06-30) ===",
);
const { data: cmRows } = await sb
  .from("fin_expenses")
  .select("date, month, city, vendor, amount, notes")
  .eq("category", "City Manager")
  .gte("date", "2026-04-01")
  .lte("date", "2026-06-30")
  .order("date");

console.log(`  rows returned: ${cmRows?.length ?? 0} (expected 20)`);

const totalsByMonth = new Map();
for (const r of cmRows ?? []) {
  totalsByMonth.set(
    r.month,
    (totalsByMonth.get(r.month) ?? 0) + Number(r.amount),
  );
}

const expected = {
  "Apr 2026": 3800,
  "May 2026": 3617,
  "Jun 2026": 3500,
};

console.log("\n  Per-month totals:");
console.table(
  Object.keys(expected).map((m) => {
    const got = totalsByMonth.get(m) ?? 0;
    const exp = expected[m];
    return {
      month: m,
      expected: `$${exp.toLocaleString()}`,
      actual: `$${got.toLocaleString()}`,
      match: got === exp ? "✓" : "✗",
    };
  }),
);

const q2Total = [...totalsByMonth.values()].reduce((s, n) => s + n, 0);
console.log(
  `\n  Q2 total: $${q2Total.toLocaleString()} (expected $10,917) ${q2Total === 10917 ? "✓" : "✗"}`,
);

console.log("\n  Per-vendor breakdown:");
const byVendor = new Map();
for (const r of cmRows ?? []) {
  const e = byVendor.get(r.vendor) ?? { count: 0, total: 0 };
  e.count += 1;
  e.total += Number(r.amount);
  byVendor.set(r.vendor, e);
}
console.table(
  [...byVendor.entries()].map(([vendor, e]) => ({
    vendor,
    rows: e.count,
    total: `$${e.total.toLocaleString()}`,
  })),
);
