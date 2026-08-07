import "server-only"; // no-op under --conditions=react-server
// Determine whether PUT /admin/matches/{id} is a PARTIAL update or a FULL REPLACE
// of the writable set, by setting an observable field and then PUTting a body
// that omits it. Staging match 2470. Host-guarded, single-shot, full capture.
// Captures the true-original state first so restore is exact regardless of outcome.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-omission-test-2470.ts

import { stageSignInProbe, assertStagingHost } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch { /* env may already be present */ }

const BASE = process.env.MATCHDAY_STAGE_API_BASE_URL as string;
const ID = 2470;
const MARKER = "omission-test-marker";
const WRITABLE = [
  "name", "description", "teamHomeId", "teamAwayId", "teamHomeScore", "teamAwayScore",
  "type", "startDate", "endDate", "fieldId", "category", "minPlayerCount", "maxPlayerCount",
  "isFreeMember", "registrationPrice", "hasOrganizer", "managerIntro", "managerId",
  "secondManagerId", "guestCount", "autoCanceled", "autoCanceledMinutes", "maxTeamSize2Team",
  "maxTeamSize4Team", "isAutoBump", "additionalSpotPrice",
  "fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h",
  "teams",
];
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
const project = (m: Record<string, unknown>) => Object.fromEntries(WRITABLE.filter((k) => k in m).map((k) => [k, m[k]]));
const url = new URL(`/admin/matches/${ID}`, BASE).toString();
let TOKEN = "";

async function get(): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
// Single-shot, host-guarded PUT with FULL response capture. Never retried.
async function put(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  assertStagingHost(url);
  const r = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { ok: r.ok, status: r.status, text: await r.text() };
}
function diff(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: string[] = [];
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
    const nulled = a[k] != null && (b[k] === null || b[k] === undefined) ? "  ← NON-NULL → NULL" : "";
    out.push(`${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}${nulled}`);
  }
  return out;
}

async function main() {
  const probe = await stageSignInProbe();
  TOKEN = probe.token;

  // capture TRUE ORIGINAL for an exact restore no matter what happens
  const s0 = await get();
  line(`Original: name=${JSON.stringify(s0.name)} description=${JSON.stringify(s0.description)}`);

  // ── 1. observable field ──────────────────────────────────────────────────────
  hr(); line("STEP 1 — set description to the marker via full 32-field projection"); hr();
  const put1 = await put({ ...project(s0), description: MARKER });
  if (!put1.ok) { line(`SURPRISE — marker PUT rejected HTTP ${put1.status}: ${put1.text.slice(0, 300)}`); line("STOPPING."); return; }
  const s1 = await get();
  line(`description now: ${JSON.stringify(s1.description)}`);
  if (s1.description !== MARKER) { line("SURPRISE — marker did not take. STOPPING."); return; }
  line("marker set ✓");

  // ── 2. THE TEST — PUT only { name } ──────────────────────────────────────────
  line(); hr(); line('STEP 2 — PUT body = ONLY { "name": "Friendly match [minimal]" }'); hr();
  const minimal = { name: "Friendly match [minimal]" };
  line("request body: " + JSON.stringify(minimal));
  const put2 = await put(minimal);
  let verdict = "";
  if (put2.ok) {
    line(`ACCEPTED — HTTP ${put2.status}.`);
    const s2 = await get();
    line(`description after omitting it: ${JSON.stringify(s2.description)}`);
    if (s2.description === MARKER) verdict = "PARTIAL UPDATE — omitted fields are left untouched.";
    else verdict = `FULL REPLACE — omitting description ${s2.description === null ? "NULLED" : "reset"} it (now ${JSON.stringify(s2.description)}); the projection is mandatory.`;
  } else {
    line(`REJECTED — HTTP ${put2.status}. Exact response:`);
    line(put2.text);
    verdict = "REJECTED minimal body — the message above names the genuinely required fields (the minimum viable body).";
  }

  // ── 3. full diff vs step 1 ───────────────────────────────────────────────────
  line(); hr(); line("STEP 3 — full diff of current state vs step 1 (the marker state)"); hr();
  const s3 = await get();
  const d = diff(s1, s3);
  line(`fields that moved from step-1 state (${d.length}):`);
  for (const x of d) line("   • " + x);
  if (!d.length) line("   (nothing moved — consistent with a rejected minimal PUT)");

  // ── 4. restore to TRUE original (name + description) via full projection ──────
  line(); hr(); line("STEP 4 — restore to original (name + description) via full projection"); hr();
  const put4 = await put({ ...project(s0), name: s0.name, description: s0.description });
  if (!put4.ok) { line(`SURPRISE — restore rejected HTTP ${put4.status}: ${put4.text.slice(0, 300)}`); line("Match may be left modified — verify by hand."); return; }
  const s5 = await get();
  const back = diff(s0, s5).filter((x) => !/^updatedAt:/.test(x));
  line(back.length === 0 ? "restored to original (byte-identical except updatedAt) ✓" : `NOT fully restored — differs: ${JSON.stringify(back)}`);

  line(); hr(); line("VERDICT: " + verdict); hr();
}

main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
