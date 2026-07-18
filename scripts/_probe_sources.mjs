import { sb } from "./_session_runner.mjs";
const { data } = await sb.from("fin_sync_log").select("source").limit(2000);
const s=[...new Set((data||[]).map(r=>r.source))].sort();
console.log(JSON.stringify(s,null,2));
