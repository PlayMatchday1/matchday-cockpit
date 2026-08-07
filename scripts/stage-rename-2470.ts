import "server-only"; // no-op under --conditions=react-server
// Phase 0 live run against staging match 2470 (fixed id — no auto-select).
// Echoes EVERY field the GET returns on the PUT, to learn the real shape and
// whether the score fields are genuinely required. Single-shot writes, host-
// guarded (physically staging-only), credentials redacted on any rejection.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-rename-2470.ts

import { stageSignInProbe, assertStagingHost } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch { /* env may already be present */ }

const BASE = process.env.MATCHDAY_STAGE_API_BASE_URL as string;
const ID = 2470;
const ORIGINAL = "Friendly match";
const RENAMED = "Friendly match [rename-test]";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));

let TOKEN = "";
async function getMatch(): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const url = new URL(`/admin/matches/${ID}`, BASE).toString();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, json, text };
}
// Single-shot, host-guarded PUT with full capture. NO retry, ever.
async function putMatch(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  const url = new URL(`/admin/matches/${ID}`, BASE).toString();
  assertStagingHost(url); // physically staging-only
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
function printRedactedRequest(body: Record<string, unknown>) {
  line(`PUT ${new URL(`/admin/matches/${ID}`, BASE).toString()}`);
  line(`Authorization: Bearer «redacted»`);
  line(`Content-Type: application/json`);
  line("Body:");
  line(JSON.stringify(body, null, 2));
}
function diff(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: string[] = [];
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
  return out;
}

async function main() {
  // ── 1. SIGN IN ──────────────────────────────────────────────────────────────
  hr(); line("STEP 1 — staging sign-in"); hr();
  const probe = await stageSignInProbe();
  TOKEN = probe.token;
  line(`Authenticates: YES`);
  line(`token.exp: ${probe.expMs ? new Date(probe.expMs).toISOString() : "(no exp claim)"}`);
  line(`Token lifetime: ${probe.minutesToExpiry != null ? probe.minutesToExpiry.toFixed(1) + " minutes from now" : "unknown"}`);

  // ── 2. GET verbatim ──────────────────────────────────────────────────────────
  line(); hr(); line("STEP 2 — GET /admin/matches/2470 (full verbatim)"); hr();
  const g2 = await getMatch();
  line(`HTTP ${g2.status}`);
  if (!g2.json) { line("Non-JSON / not found body:"); line(g2.text.slice(0, 1000)); throw new Error("GET 2470 did not return JSON — cannot continue."); }
  line(JSON.stringify(g2.json, null, 2));

  // ── 3. PUT: echo every field, change only the name ───────────────────────────
  line(); hr(); line("STEP 3 — PUT (echo every field returned, name → rename-test)"); hr();
  const body = { ...g2.json, name: RENAMED };
  printRedactedRequest(body);
  let put3: { ok: boolean; status: number; text: string };
  try {
    put3 = await putMatch(body);
  } catch (e) {
    line(); line(`NETWORK/TIMEOUT on PUT — NOT retried. ${(e as Error).name}: ${(e as Error).message}`);
    line("The write may or may not have landed; verify by hand. Stopping.");
    return;
  }
  if (!put3.ok) {
    line(); line(`REJECTED — HTTP ${put3.status}. NOT retried.`);
    line("Exact response body:");
    line(put3.text);
    line();
    line("→ The rejection shape above tells us whether the score fields are genuinely");
    line("  required. Nothing was changed; no restore needed. Stopping (as instructed).");
    return;
  }
  line(); line(`PUT accepted — HTTP ${put3.status}. Response:`);
  line(put3.text.slice(0, 1000));

  // pause so Retool can be refreshed and watched
  line(); line("… pausing 2s (refresh Retool now) …");
  await sleep(2000);

  // ── 4. GET again, confirm + full diff ────────────────────────────────────────
  line(); hr(); line("STEP 4 — GET again, diff vs step 2"); hr();
  const g4 = await getMatch();
  if (!g4.json) throw new Error("GET after rename returned non-JSON.");
  line(`name: ${JSON.stringify(g4.json.name)} (expected ${JSON.stringify(RENAMED)}) → ${g4.json.name === RENAMED ? "CHANGED ✓" : "MISMATCH ✗"}`);
  const moved4 = diff(g2.json, g4.json);
  line(`Fields that moved (${moved4.length}):`);
  for (const m of moved4) {
    const key = m.split(":")[0];
    const tag = key === "name" ? "  (intended)" : key === "updatedAt" || key === "updated_at" ? "  (expected — write bumps it)" : "  ← UNEXPECTED, FINDING";
    line("  • " + m + tag);
  }

  // ── 5. PUT restore ───────────────────────────────────────────────────────────
  line(); hr(); line("STEP 5 — PUT restore original name"); hr();
  const restore = { ...g4.json, name: ORIGINAL };
  let put5: { ok: boolean; status: number; text: string };
  try {
    put5 = await putMatch(restore);
  } catch (e) {
    line(`NETWORK/TIMEOUT on restore — NOT retried. ${(e as Error).message}`);
    line("Match may be left renamed; verify by hand. Stopping.");
    return;
  }
  if (!put5.ok) { line(`Restore REJECTED — HTTP ${put5.status}. NOT retried. Body:`); line(put5.text); line("Match may be left renamed; verify by hand."); return; }
  line(`Restore accepted — HTTP ${put5.status}.`);

  // ── 6. GET third time, confirm == step 2 field by field ──────────────────────
  line(); hr(); line("STEP 6 — GET final, confirm == step 2 field by field"); hr();
  const g6 = await getMatch();
  if (!g6.json) throw new Error("Final GET returned non-JSON.");
  const moved6 = diff(g2.json, g6.json);
  const nonTime = moved6.filter((m) => !/^(updatedAt|updated_at):/.test(m));
  if (nonTime.length === 0) {
    line(`Restored cleanly: identical to step 2 across every field${moved6.length ? " except updatedAt (expected — two writes bumped it)" : ""}.`);
    for (const m of moved6) line("  • " + m + "  (expected)");
  } else {
    line(`NOT fully restored — ${nonTime.length} field(s) differ from step 2:`);
    for (const m of moved6) line("  • " + m);
  }
  line(); line("DONE.");
}

main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
