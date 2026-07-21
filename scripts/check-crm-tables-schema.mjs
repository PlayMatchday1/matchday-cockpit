// Inspect existing crm_threads / crm_messages columns + types.
// (Tables already exist per investigation — need shape before writing migration.)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const strip = (s) => s.trim().replace(/^["']|["']$/g, "");
const url = strip(env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]);
const serviceKey = strip(env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1]);
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// Use a known-empty SELECT with explicit columns: PostgREST will list missing
// ones in the error. We instead probe via information_schema using RPC… but
// no such RPC exists. Use a dummy insert with PostgREST returning=representation
// is too destructive. So: try-select each likely column individually.

for (const table of ["crm_threads", "crm_messages"]) {
  console.log(`\n=== ${table} ===`);
  // First try "*" to see what's there. PostgREST returns empty array, so we
  // need to attempt insert-with-violation to surface columns. Easier path:
  // call a select with a non-existent column and parse the hint.
  const probe = await sb.from(table).select("__doesnotexist__").limit(1);
  console.log("probe error:", probe.error?.code, probe.error?.message, probe.error?.hint);

  // Now try common likely columns one at a time.
  const candidates = table === "crm_threads"
    ? ["id", "player_id", "phone_number", "phone", "last_message_at", "last_message_preview", "created_at", "assigned_to", "status"]
    : ["id", "thread_id", "direction", "body", "sent_at", "sent_by_user_id", "telnyx_message_id", "segment_count", "created_at"];
  const present = [];
  const absent = [];
  for (const c of candidates) {
    const r = await sb.from(table).select(c).limit(1);
    if (r.error) absent.push(`${c} [${r.error.code}]`);
    else present.push(c);
  }
  console.log("present:", present.join(", "));
  console.log("absent:", absent.join(", "));
}
