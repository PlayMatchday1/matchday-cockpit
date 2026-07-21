import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const rd = (n)=>{const m=env.match(new RegExp(`^${n}=(.+)$`,"m"));return m?m[1].trim().replace(/^['"]|['"]$/g,""):null;};
const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"), {auth:{persistSession:false}});

const { count, error: ce } = await sb.from("schedule_master").select("*",{count:"exact",head:true});
console.log("schedule_master row count:", ce?("ERR "+ce.message):count);

const { data: smSample, error: se } = await sb.from("schedule_master").select("*").order("id",{ascending:false}).limit(1);
if(se) console.log("sm sample ERR", se.message); else console.log("schedule_master columns + latest row:\n", JSON.stringify(smSample?.[0], null, 2));

const { data: logSample, error: le } = await sb.from("fin_sync_log").select("*").order("id",{ascending:false}).limit(2);
if(le) console.log("fin_sync_log ERR", le.message); else console.log("\nfin_sync_log recent rows (schema):\n", JSON.stringify(logSample, null, 2));
