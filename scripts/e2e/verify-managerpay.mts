// Verifies the Manager Pay additions:
//   Part 1 (no DB): the shared payload whitelist drops every sensitive field.
//   Part 2 (local server): the read endpoint vs. every write/trigger endpoint,
//           called with ONLY a token / no session — the exact status codes the
//           spec asks for. The valid-token 200 path runs only if the token table
//           exists AND has no live token (so it never clobbers a real link).
//
// Run: node --import tsx scripts/e2e/verify-managerpay.mts

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { toSharedPayload } from "../../src/lib/managerPaySharedPayload.ts";

// same hash the server uses (inlined to avoid the server-only import under tsx)
const hashShareToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

process.loadEnvFile(".env.local");
const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d: string) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

// last completed week's Monday (UTC), matching the page default
function lastCompletedMonday(): string {
  const t = new Date(); t.setUTCDate(t.getUTCDate());
  const iso = t.toISOString().slice(0, 10);
  const d = new Date(`${iso}T00:00:00Z`); const wd = d.getUTCDay();
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - (wd === 0 ? 6 : wd - 1) - 7);
  return monday.toISOString().slice(0, 10);
}
const WEEK = lastCompletedMonday();

console.log("PART 1 — shared payload whitelist (no field drift)");
{
  const full: any = {
    weekStart: "2026-08-03", weekEnd: "2026-08-09", payDate: "2026-08-11", computedAt: "2026-08-01T00:00:00Z", isAdmin: true,
    cities: [{
      cityIdentifier: "ATX", matchCount: 1, baseTotal: 20, adjustment: 5, total: 25,
      managers: [{ managerEmail: "SECRET_EMAIL@x.com", managerName: "Sam", managerId: 99, cityIdentifier: "ATX",
        matches: [{ matchId: 1, cityIdentifier: "ATX", fieldTitle: "F", startDate: "s", centralDate: "2026-08-04", centralWeekday: "Tue", centralTime: "6:00 PM", name: null, maxPlayerCount: 20, payAmount: 20, role: "primary", coManaged: false }],
        matchCount: 1, baseTotal: 20, adjustment: 5, adjustmentNotes: "SECRET_NOTE", adjustmentAt: "2026-08-01", total: 25 }],
      matches: [{ matchId: 1, cityIdentifier: "ATX", fieldTitle: "F", startDate: "s", centralDate: "2026-08-04", centralWeekday: "Tue", centralTime: "6:00 PM", name: null, maxPlayerCount: 20, playerCount: 10, registrationPrice: 5, isCancelled: false, primaryManagerName: "Sam", primaryManagerEmail: "SECRET_EMAIL@x.com", secondManagerName: null, secondManagerEmail: null, payPerManager: 20 }],
    }],
    network: { matchCount: 1, managerCount: 1, baseTotal: 20, adjustment: 5, total: 25 },
    attention: { count: 0, unassigned: 0, noEmail: 0, bareAdjustment: 0 },
  };
  const arrival: any = { payRun: "2026-08-11", estimatedArrival: "2026-08-17", arrivalError: null, override: null, effectiveArrival: "2026-08-17" };
  const shared = toSharedPayload(full, arrival);
  const blob = JSON.stringify(shared);
  const forbidden = ["SECRET_EMAIL", "SECRET_NOTE", "managerEmail", "primaryManagerEmail", "secondManagerEmail", "adjustmentNotes", "adjustmentAt", "registrationPrice", "isAdmin", "computedAt", "attention", "startDate"];
  const leaked = forbidden.filter((k) => blob.includes(k));
  leaked.length ? bad("no sensitive field leaks into shared payload", `leaked: ${leaked.join(", ")}`) : ok("no sensitive field leaks into shared payload");
  const top = Object.keys(shared).sort().join(", ");
  const wantTop = "arrivalOverride, cities, effectiveArrival, estimatedArrival, network, payDate, payRun, weekEnd, weekStart";
  top === wantTop ? ok(`top-level fields exactly: ${top}`) : bad("top-level field set", `got [${top}]`);
  console.log(`     city fields:    ${Object.keys(shared.cities[0]).join(", ")}`);
  console.log(`     manager fields: ${Object.keys(shared.cities[0].managers[0]).join(", ")}`);
  console.log(`     match fields:   ${Object.keys(shared.cities[0].matches[0]).join(", ")}`);
}

console.log("\nPART 2 — endpoint status codes (token / no session)");
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return res.status;
};
const expect = (name: string, got: number, wants: number[]) => wants.includes(got) ? ok(`${name} → ${got}`) : bad(name, `got ${got}, want ${wants.join("/")}`);

// wrong/rotated token → 404 (never 403)
expect("READ  /shared  wrong token", await call("GET", `/api/manager-pay/shared?token=deadbeefdeadbeef&week=${WEEK}`), [404]);
// write / trigger endpoints reject a session-less (token-only) caller
expect("WRITE /pay-arrival  PUT   (no session)", await call("PUT", `/api/manager-pay/pay-arrival`, { weekStart: WEEK, arrivalDate: WEEK, reason: "x" }), [401, 403]);
expect("WRITE /pay-arrival  DELETE(no session)", await call("DELETE", `/api/manager-pay/pay-arrival?week=${WEEK}`), [401, 403]);
expect("WRITE /adjustments  POST  (no session)", await call("POST", `/api/manager-pay/adjustments`, { managerEmail: "a@b.com", weekStart: WEEK, amount: 5, notes: "x" }), [401, 403]);
expect("GUSTO /aliases      GET   (no session)", await call("GET", `/api/manager-pay/aliases`), [401, 403]);
expect("GUSTO /aliases      PUT   (no session)", await call("PUT", `/api/manager-pay/aliases`, { managerEmail: "a@b.com", firstName: "A", lastName: "B", note: null }), [401, 403]);
expect("SHARE /share-token  GET   (no session)", await call("GET", `/api/manager-pay/share-token`), [401, 403]);
expect("SHARE /share-token  POST  (no session)", await call("POST", `/api/manager-pay/share-token`), [401, 403]);
// the admin week route no longer answers anonymous callers
expect("WEEK  /week         GET   (no session)", await call("GET", `/api/manager-pay/week?week=${WEEK}`), [401]);

// valid-token 200 path — only if the token table exists and is empty (never clobber a live link)
const svc = createClient(SB_URL, SVC, { auth: { persistSession: false } });
const tokRow = await svc.from("manager_pay_share_token").select("id").maybeSingle();
if (tokRow.error) {
  console.log(`  ⓘ 200 read path SKIPPED — manager_pay_share_token absent (apply 0112 first): ${tokRow.error.message.slice(0, 60)}`);
} else if (tokRow.data) {
  console.log("  ⓘ 200 read path SKIPPED — a live token exists; not clobbering it. Rotate + test manually.");
} else {
  const plain = "verify-" + hashShareToken(String(process.pid)).slice(0, 24);
  await svc.from("manager_pay_share_token").upsert({ id: 1, token_hash: hashShareToken(plain), rotated_at: new Date().toISOString() });
  const good = await fetch(`${BASE}/api/manager-pay/shared?token=${plain}&week=${WEEK}`);
  expect("READ  /shared  VALID token", good.status, [200]);
  if (good.status === 200) {
    const j = await good.json();
    const keys = Object.keys(j).sort().join(", ");
    keys.includes("cities") && keys.includes("estimatedArrival") && !JSON.stringify(j).includes("managerEmail")
      ? ok("valid-token payload has cities + arrival, no emails") : bad("valid-token payload shape", keys);
  }
  await svc.from("manager_pay_share_token").delete().eq("id", 1); // restore to empty
}

console.log(`\n================ RESULT ================\nPassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);
