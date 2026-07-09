import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const anonKey = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)?.[1]?.trim();

const sbService = createClient(url, serviceKey);
const sbAnon = anonKey ? createClient(url, anonKey) : null;

console.log("=== Service-role: mdapi_users count + mdapi_subscriptions count ===");
const svcU = await sbService.from("mdapi_users").select("*", { count: "exact", head: true });
const svcS = await sbService.from("mdapi_subscriptions").select("*", { count: "exact", head: true });
console.log(`  mdapi_users:        count=${svcU.count}`);
console.log(`  mdapi_subscriptions: count=${svcS.count}`);

if (sbAnon) {
  console.log("\n=== Anon-key (no auth): mdapi_users count + mdapi_subscriptions count ===");
  const a1 = await sbAnon.from("mdapi_users").select("*", { count: "exact", head: true });
  const a2 = await sbAnon.from("mdapi_subscriptions").select("*", { count: "exact", head: true });
  console.log(`  mdapi_users:        count=${a1.count}  ${a1.error ? "ERROR:"+a1.error.message : ""}`);
  console.log(`  mdapi_subscriptions: count=${a2.count}  ${a2.error ? "ERROR:"+a2.error.message : ""}`);

  console.log("\n=== Anon-key: try to read 5 mdapi_users rows ===");
  const a3 = await sbAnon.from("mdapi_users").select("email, preferable_city_normalized").limit(5);
  if (a3.error) console.log(`  ERROR: ${a3.error.message}`);
  else console.log(`  Got ${a3.data?.length ?? 0} rows`);
}
