import "server-only"; // no-op under --conditions=react-server
// PHASE 8 STEP 2 - READ production (never write). Confirm the account authenticates
// AND is admin, GET a finished match, diff its field set against staging, run the
// four fact checks against production data, and report price/capacity/duration
// ranges across several finished matches.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-read-diff.ts
//
// Reads only. Never prints names / emails / phones / credentials.

import { apiGet, stageSignInProbe, StageAuthError, WriteFailedError } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const TODAY = "2026-08-07";
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));

const PII = /(name|email|phone|firstname|lastname|first_name|last_name)/i;
function safeType(k: string, v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  const t = typeof v;
  if (t === "object") return `object{${Object.keys(v as object).length} keys}`;
  if (PII.test(k)) return `${t} [redacted]`;
  return `${t} = ${JSON.stringify(v)}`;
}
const parseWall = (iso: string) => Date.parse(iso); // Z-labelled; delta between two is a wall-clock delta
const durH = (a: string, b: string) => (parseWall(b) - parseWall(a)) / 3_600_000;

// The production /admin/matches LIST returns only upcoming matches (oldest row is
// tomorrow). Finished matches are reached via the DETAIL endpoint by id — ids are
// chronological, so ids below the current-day boundary are in the past. Probe
// downward from the lowest listed id, collecting finished matches (startDate date
// strictly before today), skipping 404 gaps.
async function findBoundaryId(): Promise<number> {
  const res = await apiGet<{ data?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    "production", "/admin/matches", { page: 1, limit: 5, sortColumn: "startDate", sortDirection: "asc" },
  );
  const rows = Array.isArray(res) ? res : (res.data ?? []);
  return Math.min(...rows.map((m) => Number(m.id)));
}
async function findFinished(want: number): Promise<Record<string, unknown>[]> {
  const start = await findBoundaryId();
  const out: Record<string, unknown>[] = [];
  for (let id = start - 1, tries = 0; out.length < want && tries < 200 && id > 0; id--, tries++) {
    let m: Record<string, unknown>;
    try { m = await apiGet<Record<string, unknown>>("production", `/admin/matches/${id}`); }
    catch { continue; } // 404 gap
    if (typeof m.startDate === "string" && (m.startDate as string).slice(0, 10) < TODAY) out.push(m);
  }
  return out;
}

async function main() {
  hr(); line("(0) AUTH + ADMIN ROLE CHECK (production)"); hr();
  try {
    await stageSignInProbe("production"); // token internal, never printed
    line("sign-in: OK (credentials authenticate against production)");
  } catch (e) {
    if (e instanceof StageAuthError) { line(`sign-in FAILED (bad credentials / auth): ${(e as Error).message.replace(/Body:.*/, "Body: [omitted]")}`); line("=> This is a CREDENTIALS problem, not an admin-role problem."); process.exit(3); }
    throw e;
  }
  try {
    await apiGet("production", "/admin/matches", { page: 1, limit: 1 });
    line("admin check: OK (/admin/matches reachable -> account has admin role)");
  } catch (e) {
    if (e instanceof WriteFailedError && e.status === 403) { line("admin check: 403 FORBIDDEN — the account AUTHENTICATES but is NOT admin on production."); line("=> This is an ADMIN-ROLE problem, not a credentials problem."); process.exit(4); }
    if (e instanceof WriteFailedError && e.status === 401) { line("admin check: 401 — token rejected on /admin (auth problem)."); process.exit(3); }
    throw e;
  }

  hr(); line("(1) A FINISHED PRODUCTION MATCH - full field list with JSON types (PII redacted)"); hr();
  const details = await findFinished(6); // detail-endpoint objects, already full
  if (!details.length) { line("No finished matches found by id probe. Widen the probe window."); process.exit(5); }
  const full = details[0];
  const id = full.id ?? full.api_id;
  line(`match id ${id} (startDate ${String(full.startDate)}, isCancelled ${String(full.isCancelled)}):`);
  const prodKeys = Object.keys(full).sort();
  for (const k of prodKeys) line(`  ${k}: ${safeType(k, full[k])}`);

  hr(); line("(2) FIELD DIFF - production vs staging (both from a live GET)"); hr();
  const stg = await apiGet<Record<string, unknown>>("staging", "/admin/matches/2470");
  const stgKeys = new Set(Object.keys(stg));
  const prodKeySet = new Set(prodKeys);
  const both = [...prodKeySet].filter((k) => stgKeys.has(k)).sort();
  const prodOnly = [...prodKeySet].filter((k) => !stgKeys.has(k)).sort();
  const stgOnly = [...stgKeys].filter((k) => !prodKeySet.has(k)).sort();
  line(`in BOTH (${both.length}): ${both.join(", ")}`);
  line(`PRODUCTION ONLY (${prodOnly.length}) - never seen before: ${prodOnly.join(", ") || "(none)"}`);
  line(`STAGING ONLY (${stgOnly.length}): ${stgOnly.join(", ") || "(none)"}`);

  hr(); line("(3) FOUR FACT CHECKS against production data"); hr();
  // a) prices integers consistent with cents
  const priceVals = details.flatMap((m) => [m.registrationPrice, m.additionalSpotPrice]).filter((v) => v != null);
  const allInt = priceVals.every((v) => Number.isInteger(v as number));
  line(`a) prices integers (cents)? ${allInt ? "YES" : "NO"} — registrationPrice/additionalSpotPrice across ${details.length} matches all ${allInt ? "integers" : "NOT all integers"}`);

  // b) startDate/endDate carry Z; startDateUtc differs by a whole-hour offset
  const s = full;
  const zStart = typeof s.startDate === "string" && (s.startDate as string).endsWith("Z");
  const zEnd = typeof s.endDate === "string" && (s.endDate as string).endsWith("Z");
  let offsetNote = "startDateUtc absent";
  if (typeof s.startDateUtc === "string" && typeof s.startDate === "string") {
    const off = (Date.parse(s.startDateUtc as string) - Date.parse(s.startDate as string)) / 3_600_000;
    offsetNote = `startDateUtc - startDate = ${off}h (whole hour: ${Number.isInteger(off)})`;
  }
  line(`b) startDate ends with Z: ${zStart}; endDate ends with Z: ${zEnd}; ${offsetNote}`);

  // c) maxPlayerCount populated and varying
  const caps = details.map((m) => m.maxPlayerCount);
  const capDistinct = [...new Set(caps.map((c) => JSON.stringify(c)))];
  line(`c) maxPlayerCount across ${details.length}: values ${caps.map((c) => JSON.stringify(c)).join(", ")} — distinct: ${capDistinct.length} (${capDistinct.length > 1 ? "VARYING" : "constant"})`);

  // d) managerId / secondManagerId shape
  const shape = (v: unknown) => v === null ? "null" : typeof v;
  line(`d) managerId shapes: ${details.map((m) => shape(m.managerId)).join(", ")}; secondManagerId shapes: ${details.map((m) => shape(m.secondManagerId)).join(", ")}`);

  hr(); line("(4) RANGES across the finished matches pulled"); hr();
  const regs = details.map((m) => Number(m.registrationPrice)).filter((n) => Number.isFinite(n));
  const capsN = details.map((m) => m.maxPlayerCount).filter((n) => typeof n === "number") as number[];
  const durs = details.filter((m) => typeof m.startDate === "string" && typeof m.endDate === "string").map((m) => durH(m.startDate as string, m.endDate as string));
  line(`matches pulled: ${details.length} (ids ${details.map((m) => m.id).join(", ")})`);
  line(`registrationPrice: min ${Math.min(...regs)}  max ${Math.max(...regs)} (cents) = $${(Math.min(...regs) / 100).toFixed(2)} .. $${(Math.max(...regs) / 100).toFixed(2)}`);
  line(`maxPlayerCount: ${capsN.length ? `min ${Math.min(...capsN)}  max ${Math.max(...capsN)}` : "none numeric"}`);
  line(`duration (start->end h): ${durs.map((d) => d.toFixed(2)).join(", ")}`);
  line(`  range ${Math.min(...durs).toFixed(2)}h .. ${Math.max(...durs).toFixed(2)}h; negative durations: ${durs.filter((d) => d < 0).length}`);
  line("\nDONE (read-only).");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body: [omitted]") : e); process.exit(1); });
