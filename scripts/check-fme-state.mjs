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

console.log("Probing fin_monthly_expenses on the REST API...\n");

const { data, error, count } = await sb
  .from("fin_monthly_expenses")
  .select("id", { count: "exact" })
  .limit(3);

console.log("error:", error);
console.log("count:", count);
console.log("data:", data);

// Also try a raw fetch to see the actual HTTP response
console.log("\nRaw HTTP probe:");
const res = await fetch(`${url}/rest/v1/fin_monthly_expenses?select=id&limit=1`, {
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  },
});
console.log("status:", res.status);
const body = await res.text();
console.log("body:", body.slice(0, 500));
