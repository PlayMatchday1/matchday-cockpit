import "server-only"; // no-op under --conditions=react-server
// PHASE 9 PART 1 - the FIRST production write. Single key (name), finished match
// 17256, no retry, restore, then re-bolt (bolt flip is done in the file, committed
// separately). Proves whether production PUT PATCHES or REPLACES by measuring an
// applied write across ALL 54 readable fields.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/prod-p9-namewrite.ts
//
// Never prints token/password. Redacts personal data (names/emails/phones and any
// nested relation object).

import { apiGet, apiWrite, AmbiguousWriteError } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const ID = 17256;
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));
const get = () => apiGet<Record<string, unknown>>("production", `/admin/matches/${ID}`);
const SERVER_DERIVED = new Set(["updatedAt", "startDateUtc", "endDateUtc", "_count", "starRating", "starRatingCount"]);
const PII = /(email|phone|firstName|lastName|first_name|last_name)/i;
const showScalarOrShape = (k: string, v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === "object") return `object{${Object.keys(v as object).length} keys}`;
  if (PII.test(k)) return "[redacted]";
  return JSON.stringify(v);
};
const changedVal = (k: string, before: unknown, after: unknown): string => {
  const nested = (v: unknown) => v !== null && typeof v === "object";
  if (nested(before) || nested(after) || PII.test(k)) return "[changed - value hidden (nested/PII)]";
  return `${JSON.stringify(before)}  ->  ${JSON.stringify(after)}`;
};

async function main() {
  hr(); line("(2) GET production 17256 - BEFORE (54 fields, PII/nested redacted)"); hr();
  const BEFORE = await get();
  const keys = Object.keys(BEFORE).sort();
  line(`field count: ${keys.length}`);
  for (const k of keys) line(`  ${k}: ${showScalarOrShape(k, BEFORE[k])}`);
  const beforeName = String(BEFORE.name ?? "");

  const body = { name: `${beforeName} [p9]` };
  line(); hr(); line("(3) PUT exactly this body (one key, no retry)"); hr();
  line(JSON.stringify(body));

  let AFTER: Record<string, unknown>;
  try {
    await apiWrite("production", "PUT", `/admin/matches/${ID}`, body);
    line("PUT accepted (2xx).");
  } catch (e) {
    if (e instanceof AmbiguousWriteError) {
      line(`*** AMBIGUOUS: ${e.message}`);
      line("Not retrying, not restoring. GET to see what actually landed:");
      const amb = await get();
      line(`  name now: ${JSON.stringify(amb.name)} (BEFORE was ${JSON.stringify(BEFORE.name)})`);
      line("STOPPING per protocol."); process.exit(2);
    }
    throw e;
  }

  AFTER = await get();
  hr(); line("(5) DIFF all 54 fields BEFORE vs AFTER"); hr();
  const allKeys = [...new Set([...Object.keys(BEFORE), ...Object.keys(AFTER)])].sort();
  const diffs: string[] = [];
  for (const k of allKeys) {
    if (JSON.stringify(BEFORE[k]) === JSON.stringify(AFTER[k])) continue;
    diffs.push(k);
    line(`- ${k} [${SERVER_DERIVED.has(k) ? "server-derived" : "?"}]: ${changedVal(k, BEFORE[k], AFTER[k])}`);
  }
  const unexpected = diffs.filter((k) => k !== "name" && !SERVER_DERIVED.has(k));
  line(`\nchanged: ${diffs.join(", ") || "(none)"}`);

  // (6) STOP CONDITION
  if (unexpected.length) {
    line();
    line(`*** STOP: unexpected field(s) moved: ${unexpected.join(", ")}. ***`);
    line("NOT restoring, NOT writing again. Reporting and waiting.");
    // flag any that went null/empty/zero
    for (const k of unexpected) {
      const a = AFTER[k];
      if (a === null || a === "" || a === 0) line(`   !! ${k} became ${JSON.stringify(a)} (null/empty/zero)`);
    }
    process.exit(3);
  }
  // Also require name actually changed (write took effect)
  if (!diffs.includes("name")) { line("\n*** name did NOT change — write had no effect. STOP, investigate."); process.exit(4); }

  line("\nClean: only name + server-derived moved. Proceeding to restore.");
  hr(); line("(7) restore name, GET third, confirm all 54 == BEFORE except server-derived"); hr();
  await apiWrite("production", "PUT", `/admin/matches/${ID}`, { name: beforeName });
  const FINAL = await get();
  const stillOff = allKeys.filter((k) => !SERVER_DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
  const derivedMoved = allKeys.filter((k) => SERVER_DERIVED.has(k) && JSON.stringify(BEFORE[k]) !== JSON.stringify(FINAL[k]));
  if (stillOff.length === 0) {
    line(`RESTORED: all ${allKeys.length} fields match BEFORE except server-derived (${derivedMoved.join(", ") || "none"}).`);
    line(`name is back to ${JSON.stringify(FINAL.name)}.`);
  } else {
    line(`*** NOT fully restored - still differ: ${stillOff.join(", ")}`);
    process.exit(5);
  }
  line("\nDONE. Remember to flip PRODUCTION_WRITES_ENABLED back to false and commit.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body:[omitted]") : e); process.exit(1); });
