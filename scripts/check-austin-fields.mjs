import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const { data: upload } = await sb.from("data_uploads").select("id").eq("is_current", true).order("created_at", { ascending: false }).limit(1).maybeSingle();

let rows = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from("match_registrations").select("city, field, match_start").eq("upload_id", upload.id).eq("city", "Austin").range(from, from + 999);
  if (!data || data.length === 0) break;
  rows.push(...data);
  if (data.length < 1000) break;
}

// Distinct field values in Austin.
const byField = new Map();
for (const r of rows) {
  const k = r.field ?? "(null)";
  if (!byField.has(k)) byField.set(k, new Set());
  byField.get(k).add(r.match_start.slice(0, 10));
}
console.log("Austin distinct field values + match-date count:");
for (const [field, dates] of [...byField.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  "${field}"  ${dates.size} distinct dates  (sample: ${[...dates].sort().slice(0, 3).join(", ")})`);
}

// Hattrick-ish field values.
const hattrickish = [...byField.entries()].filter(([f]) => /hattrick|hat/i.test(f));
console.log("\nHattrick-ish:", hattrickish.map(([f]) => f));

// Window check
const wStart = "2026-04-26", wEnd = "2026-05-02";
const inWindow = rows.filter((r) => r.match_start.slice(0, 10) >= wStart && r.match_start.slice(0, 10) <= wEnd);
const inWindowFields = new Map();
for (const r of inWindow) {
  inWindowFields.set(r.field, (inWindowFields.get(r.field) ?? 0) + 1);
}
console.log(`\nFields with rows in W-1 (${wStart} → ${wEnd}):`);
for (const [f, n] of [...inWindowFields.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${f}"  ${n} rows`);
}
