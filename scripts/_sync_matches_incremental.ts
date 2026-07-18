import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { syncMdapiMatches, defaultIncrementalWindow } from "../src/lib/mdapiMatchesSync";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const readVar = (n: string): string | undefined => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
};

async function main() {
  for (const v of ["MATCHDAY_API_EMAIL", "MATCHDAY_API_PASSWORD", "MATCHDAY_API_BASE_URL"]) {
    const val = readVar(v);
    if (val) process.env[v] = val;
  }
  const url = readVar("NEXT_PUBLIC_SUPABASE_URL")!;
  const key = readVar("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const win = defaultIncrementalWindow();
  console.log("SYNC START window=", JSON.stringify(win), "as", process.env.MATCHDAY_API_EMAIL);
  const r = await syncMdapiMatches(supabase, win);
  console.log("SYNC DONE", JSON.stringify({
    matchesFetched: r.matchesFetched, matchesUpserted: r.matchesUpserted,
    playersFetched: r.playersFetched, playersUpserted: r.playersUpserted,
    rowsSoftDeleted: r.rowsSoftDeleted, apiCalls: r.apiCalls,
    durationSec: Math.round(r.durationMs / 1000), perMatchErrors: Object.keys(r.perMatchErrors).length,
  }));
}
main().catch((e) => { console.log("SYNC FAILED:", e instanceof Error ? e.message : String(e)); process.exit(1); });
