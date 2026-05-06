import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const matches = [];
for (let from=0;;from+=1000) {
  const { data } = await sb.from("mdapi_matches").select("api_id, start_date, is_cancelled").ilike("field_title","%Hattrick%").order("api_id").range(from,from+999);
  if (!data||!data.length) break;
  matches.push(...data);
  if (data.length<1000) break;
}
const okMatches = matches.filter(m=>!m.is_cancelled && String(m.start_date).slice(0,10)>="2026-03-31");
const ids = okMatches.map(m=>m.api_id);
const players = [];
for (let i=0;i<ids.length;i+=200) {
  const chunk = ids.slice(i,i+200);
  for (let from=0;;from+=1000) {
    const { data } = await sb.from("mdapi_match_players").select("api_id, user_email, is_absent, user_is_fake_player, canceled_at, paid_status").in("match_api_id",chunk).order("api_id").range(from,from+999);
    if (!data||!data.length) break;
    players.push(...data);
    if (data.length<1000) break;
  }
}

// Mirror dashboard's full filter chain (post-Mar-31, no match-cancel,
// no WAITING, no canceled_at, no staff matchday.com)
const isStaff = e => !!e && e.toLowerCase().includes("matchday.com");
const active = players.filter(p =>
  p.paid_status !== "WAITING" &&
  (!p.canceled_at || String(p.canceled_at).trim() === "") &&
  !isStaff(p.user_email)
);
console.log(`active (post-everything-except-fake-absent): ${active.length}`);
const abs = active.filter(p=>p.is_absent===true);
const fake = active.filter(p=>p.user_is_fake_player===true);
const both = active.filter(p=>p.is_absent===true && p.user_is_fake_player===true);
console.log(`is_absent=true:                          ${abs.length}`);
console.log(`user_is_fake_player=true:                ${fake.length}`);
console.log(`BOTH (overlap):                          ${both.length}`);
console.log(`union (rows new filter drops):           ${abs.length + fake.length - both.length}`);
console.log(`active after dropping fake+absent:       ${active.length - (abs.length + fake.length - both.length)}`);

// Sample emails of fake players
console.log("\nSample fake-player emails (first 6):");
for (const p of fake.slice(0,6)) console.log(`  ${p.user_email}  is_absent=${p.is_absent}`);
