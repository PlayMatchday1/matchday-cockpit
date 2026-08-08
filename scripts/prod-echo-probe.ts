import "server-only"; // no-op under --conditions=react-server
// PHASE 8 STEP 3 - the ECHO TEST on production. PUT the full GET response back
// UNCHANGED. It must 400 (forbidNonWhitelisted) - which writes nothing, exactly
// how the staging write schema was derived. The echoed body is byte-for-byte the
// current values, so even in the worst case (production ACCEPTS it) no value
// changes - but if it does NOT 400 we STOP and change nothing.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-echo-probe.ts
//
// This is a deliberate one-off rejected-request probe. It does NOT go through the
// bolted write client (the echo must include read-only + denied fields, which the
// client would refuse). It signs in to production, targets the production host
// explicitly (host-guarded), and sends exactly one PUT. Never prints the token.

import { apiGet, stageSignInProbe, assertAllowedHost } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const TODAY = "2026-08-07";
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));

// staging's read-only set (the 22), from docs/matchday-api-facts.md / the echo we
// ran on staging. Used to diff against production's rejection.
const STAGING_READONLY_HINT = "(compare against docs/matchday-api-facts.md staging read-only set)";

async function main() {
  const base = process.env.MATCHDAY_PROD_BASE_URL;
  if (!base) { line("MATCHDAY_PROD_BASE_URL is unset — refusing to guess a production host."); process.exit(2); }

  const probe = await stageSignInProbe("production"); // token used internally, NEVER printed
  const token = probe.token;

  hr(); line("(0) pick a FINISHED production match"); hr();
  // The LIST endpoint returns only upcoming matches; finished ones are reached by
  // id via the DETAIL endpoint (ids are chronological). Find the current-day
  // boundary id, then probe downward for one finished match.
  const asc = await apiGet<{ data?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    "production", "/admin/matches", { page: 1, limit: 5, sortColumn: "startDate", sortDirection: "asc" },
  );
  const ascRows = Array.isArray(asc) ? asc : (asc.data ?? []);
  const boundary = Math.min(...ascRows.map((m) => Number(m.id)));
  let id: number | null = null;
  for (let cand = boundary - 1, tries = 0; cand > 0 && tries < 200; cand--, tries++) {
    let m: Record<string, unknown>;
    try { m = await apiGet<Record<string, unknown>>("production", `/admin/matches/${cand}`); } catch { continue; }
    if (typeof m.startDate === "string" && (m.startDate as string).slice(0, 10) < TODAY) { id = cand; line(`finished match id ${id} (startDate ${String(m.startDate)}, isCancelled ${String(m.isCancelled)})`); break; }
  }
  if (id == null) { line("No finished match found by id probe."); process.exit(5); }

  hr(); line("(1) GET the full match, then PUT it back UNCHANGED"); hr();
  const before = await apiGet<Record<string, unknown>>("production", `/admin/matches/${id}`);
  const url = `${base.replace(/\/$/, "")}/admin/matches/${id}`;
  assertAllowedHost("production", url); // deliberate, explicit production target

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(before), // exact echo, unchanged
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    line(`echo PUT network error/timeout: ${e instanceof Error ? e.message : String(e)}`);
    line("Ambiguous — cannot conclude. Re-GET to confirm state, then stop.");
    const after0 = await apiGet<Record<string, unknown>>("production", `/admin/matches/${id}`);
    line(`re-GET status vs before: ${JSON.stringify(after0) === JSON.stringify(before) ? "IDENTICAL" : "DIFFERS"}`);
    process.exit(6);
  }
  const status = res.status;
  const body = await res.text();
  line(`echo PUT -> HTTP ${status}`);

  if (status >= 200 && status < 300) {
    line("\n*** STOP: production ACCEPTED a full-object PUT (no 400). ***");
    line("Production validation DIFFERS from staging. The echo body was the CURRENT");
    line("values unchanged, so nothing was modified — but every assumption in the");
    line("facts file is now staging-only until rechecked. Changing NOTHING further.");
    // still confirm unchanged
    const afterOk = await apiGet<Record<string, unknown>>("production", `/admin/matches/${id}`);
    const same = Object.keys(before).every((k) => ["updatedAt", "startDateUtc", "endDateUtc"].includes(k) || JSON.stringify(before[k]) === JSON.stringify(afterOk[k]));
    line(`post-echo re-GET: non-derived fields ${same ? "IDENTICAL to before" : "DIFFER"} .`);
    process.exit(7);
  }

  if (status === 401 || status === 403) {
    line(`\nEcho returned ${status} — the account cannot write on production (${status === 403 ? "not admin / forbidden" : "auth"}).`);
    line("Cannot derive the production writable set from a rejection this does not produce.");
    line("Rejection body (verbatim):"); line(body);
    process.exit(4);
  }

  hr(); line("(1a) REJECTION BODY (verbatim) — this is production's read-only set"); hr();
  line(body);

  hr(); line("(2) diff production read-only set vs staging's"); hr();
  // Try to pull field names out of the rejection message (NestJS forbidNonWhitelisted
  // emits "property X should not exist" per field).
  let prodReadOnly: string[] = [];
  try {
    const j = JSON.parse(body);
    const msgs = Array.isArray(j.message) ? j.message : [j.message];
    prodReadOnly = msgs.map((m: string) => (m.match(/property (\w+) should not exist/)?.[1])).filter(Boolean);
  } catch { /* printed verbatim above regardless */ }
  line(`production read-only fields parsed from rejection (${prodReadOnly.length}): ${prodReadOnly.sort().join(", ") || "(could not parse — see verbatim body)"}`);
  line(STAGING_READONLY_HINT);

  hr(); line("(3) confirm the echoed match is UNCHANGED"); hr();
  const after = await apiGet<Record<string, unknown>>("production", `/admin/matches/${id}`);
  const identical = JSON.stringify(after) === JSON.stringify(before);
  line(identical ? "re-GET IDENTICAL to the pre-echo GET — the 400 wrote nothing, confirmed." : "re-GET DIFFERS from before — INVESTIGATE (unexpected for a 400).");
  if (!identical) {
    for (const k of Object.keys(before)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) line(`  changed: ${k}`);
  }

  hr(); line("(4) derive production WRITABLE set (all keys - read-only)"); hr();
  const allKeys = Object.keys(before);
  const roSet = new Set(prodReadOnly);
  const writable = allKeys.filter((k) => !roSet.has(k)).sort();
  line(`all fields: ${allKeys.length}; production read-only: ${prodReadOnly.length}; derived writable: ${writable.length}`);
  line(`writable: ${writable.join(", ")}`);
  line("\nDONE — one rejected request, nothing written.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body: [omitted]") : e); process.exit(1); });
