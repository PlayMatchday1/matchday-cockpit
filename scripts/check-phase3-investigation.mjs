// Phase 3 pre-build verification. Read-only.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const strip = (s) => s.trim().replace(/^["']|["']$/g, "");
const url = strip(env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]);
const serviceKey = strip(env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1]);
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// 1. Confirm manager_email on mdapi_matches.
console.log("=== 1. mdapi_matches columns we care about ===");
const r = await sb
  .from("mdapi_matches")
  .select(
    "api_id, field_title, start_date, city_identifier, city_name, manager_email, manager_first_name, manager_last_name, is_cancelled",
  )
  .limit(1);
if (r.error) {
  console.log("ERR", r.error.code, r.error.message);
} else if (r.data?.length) {
  console.log("All requested columns present:");
  for (const k of Object.keys(r.data[0])) {
    console.log(`  ${k}`);
  }
}

// 2. Spot-check the 5 numeric Firestore chat IDs.
console.log("\n=== 2. Firestore chat IDs vs mdapi_matches.api_id ===");
const ids = [14613, 14581, 14448, 14386, 14385];
const matches = await sb
  .from("mdapi_matches")
  .select(
    "api_id, field_title, start_date, city_identifier, manager_email, is_cancelled",
  )
  .in("api_id", ids);
if (matches.error) {
  console.log("ERR", matches.error.code, matches.error.message);
} else {
  console.log(`Returned ${matches.data?.length ?? 0} of ${ids.length} ids.`);
  for (const m of matches.data ?? []) {
    console.log(
      `  ${m.api_id}: ${m.city_identifier} · ${m.start_date} · ${m.field_title}${m.is_cancelled ? " · [CANCELLED]" : ""} · manager=${m.manager_email ?? "(none)"}`,
    );
  }
  const got = new Set((matches.data ?? []).map((m) => m.api_id));
  const missing = ids.filter((i) => !got.has(i));
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
}
