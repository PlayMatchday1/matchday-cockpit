// Verify 0030_crm_phase_1.sql has been applied.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const strip = (s) => s.trim().replace(/^["']|["']$/g, "");
const url = strip(env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]);
const serviceKey = strip(env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1]);
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// 1. New columns on crm_threads?
const colsCheck = await sb
  .from("crm_threads")
  .select("assigned_to_user_id, assigned_at")
  .limit(1);
console.log(
  "1. crm_threads new columns:",
  colsCheck.error
    ? `✗ missing — ${colsCheck.error.code} ${colsCheck.error.message}`
    : "✓ present",
);

// 2. crm_assignment_log table?
const tblCheck = await sb.from("crm_assignment_log").select("id").limit(1);
console.log(
  "2. crm_assignment_log table:",
  tblCheck.error
    ? `✗ missing — ${tblCheck.error.code} ${tblCheck.error.message}`
    : "✓ exists",
);
