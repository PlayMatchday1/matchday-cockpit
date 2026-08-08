import "server-only"; // no-op under --conditions=react-server
// PHASE 10 PART 1 - the DRAWER's first production write, end to end. The write
// goes through the drawer's exact path: POST /api/matchday/production/matches/{id}
// with { changes: { name } } to the running dev server (route -> guarded client ->
// production). Verified with a raw 54-field before/after via apiGet. Single key,
// restored. Requires the dev server running and the bolt OFF.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-p10-drawer-write.ts
import { apiGet } from "../src/lib/matchdayStageApi";
import { createClient } from "@supabase/supabase-js";
try { process.loadEnvFile(".env.local"); } catch {}

const ID = 17256;
const BASE = process.env.BASE || "http://localhost:3000";
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));
const raw = () => apiGet<Record<string, unknown>>("production", `/admin/matches/${ID}`);
const DERIVED = new Set(["updatedAt", "startDateUtc", "endDateUtc", "_count", "starRating", "starRatingCount"]);

async function adminToken(): Promise<string> {
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const link = await svc.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
  const vv = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.data!.properties!.hashed_token });
  return vv.data.session!.access_token;
}
async function drawerPut(token: string, changes: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/matchday/production/matches/${ID}`, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  const token = await adminToken();
  hr(); line("(1) raw GET BEFORE (54 fields)"); hr();
  const BEFORE = await raw();
  line(`field count: ${Object.keys(BEFORE).length}; name: ${JSON.stringify(BEFORE.name)}`);
  const body = { name: `${String(BEFORE.name ?? "")} [p10]` };

  hr(); line("(2) DRAWER PATH: PUT /api/matchday/production/matches/17256"); hr();
  line(`request body (drawer sends): { "changes": ${JSON.stringify(body)} }`);
  const put = await drawerPut(token, body);
  line(`route responded HTTP ${put.status}`);
  if (put.status !== 200) { line(`route error: ${JSON.stringify(put.json).slice(0, 200)}`); line("STOP."); process.exit(2); }

  const AFTER = await raw();
  hr(); line("(3) diff ALL 54 fields BEFORE vs AFTER"); hr();
  const keys = [...new Set([...Object.keys(BEFORE), ...Object.keys(AFTER)])].sort();
  const diffs: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(BEFORE[k]) === JSON.stringify(AFTER[k])) continue;
    diffs.push(k);
    const nested = (v: unknown) => v !== null && typeof v === "object";
    const shown = nested(BEFORE[k]) || nested(AFTER[k]) || /email|phone|name/i.test(k) && k !== "name"
      ? "[changed - hidden]" : `${JSON.stringify(BEFORE[k])} -> ${JSON.stringify(AFTER[k])}`;
    line(`- ${k} [${DERIVED.has(k) ? "server-derived" : "?"}]: ${shown}`);
  }
  const unexpected = diffs.filter((k) => k !== "name" && !DERIVED.has(k));
  line(`\nchanged: ${diffs.join(", ")}`);
  if (unexpected.length) { line(`*** STOP: unexpected ${unexpected.join(", ")} — not restoring.`); process.exit(3); }
  if (!diffs.includes("name")) { line("*** name did not change — STOP."); process.exit(4); }

  hr(); line("(4) restore via the drawer path, confirm all 54 == BEFORE except server-derived"); hr();
  const back = await drawerPut(token, { name: BEFORE.name });
  line(`restore responded HTTP ${back.status}`);
  const FINAL = await raw();
  const stillOff = keys.filter((k) => !DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
  line(stillOff.length === 0
    ? `RESTORED: all ${keys.length} fields match BEFORE except server-derived. name is ${JSON.stringify(FINAL.name)}.`
    : `*** NOT restored: ${stillOff.join(", ")}`);
  line("\nDONE. Bolt stays ON (Phase 10 leaves production writable).");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body:[omitted]") : e); process.exit(1); });
