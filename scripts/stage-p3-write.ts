import "server-only"; // no-op under --conditions=react-server
// PART B — one real three-key write against staging 2470, then restore.
// The body is exactly what the editor produces for a name/price/guestCount edit
// (Phase 2 proved the editor builds precisely these keys). Single-shot, guarded,
// no retry. registrationPrice = 13337: unambiguous unit probe ($133.37 if cents,
// $13,337 if dollars).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-p3-write.ts

import { stageGet, stageWrite } from "../src/lib/matchdayStageApi";
import { EDITABLE_KEYS } from "../src/lib/matchEditModel";
try { process.loadEnvFile(".env.local"); } catch {}

const ID = 2470;
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(70));
const get = () => stageGet<Record<string, unknown>>(`/admin/matches/${ID}`);

async function main() {
  hr(); line("(1) GET 2470 → BEFORE"); hr();
  const BEFORE = await get();
  line(`name=${JSON.stringify(BEFORE.name)} registrationPrice=${BEFORE.registrationPrice} guestCount=${BEFORE.guestCount}`);

  const changes = {
    name: `${String(BEFORE.name)} [p3]`,
    registrationPrice: 13337,
    guestCount: Number(BEFORE.guestCount) + 1,
  };
  line(); hr(); line("(3) PUT — exact request body (3 keys)"); hr();
  line(JSON.stringify(changes, null, 2));
  await stageWrite("PUT", `/admin/matches/${ID}`, changes);
  line("PUT accepted (2xx).");

  line(); hr(); line("(4/5) GET → AFTER · full BEFORE/AFTER table across every writable field"); hr();
  const AFTER = await get();
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  line(pad("FIELD", 22) + pad("BEFORE", 22) + "AFTER");
  const moved: string[] = [];
  for (const k of EDITABLE_KEYS) {
    const b = JSON.stringify(BEFORE[k]), a = JSON.stringify(AFTER[k]);
    if (b !== a) moved.push(k);
    line(pad(k, 22) + pad(b, 22) + a + (b !== a ? "   ← changed" : ""));
  }
  const expected = ["name", "registrationPrice", "guestCount"].sort();
  const got = [...moved].sort();
  const exactly3 = JSON.stringify(expected) === JSON.stringify(got);
  line();
  line(`fields that moved: ${got.join(", ") || "none"}`);
  line(`price unit probe: sent 13337 → AFTER.registrationPrice = ${AFTER.registrationPrice} ` +
    `(stored verbatim; editor renders /100 = $${(Number(AFTER.registrationPrice) / 100).toFixed(2)})`);

  if (!exactly3) {
    line(`\n✗ PARTIAL-UPDATE VIOLATION: expected exactly [${expected}] to move, but [${got}] did. STOPPING — not restoring.`);
    process.exit(1);
  }
  line("\n✓ exactly the three intended keys moved; every other writable field byte-identical.");

  line(); hr(); line("(6) restore name / registrationPrice / guestCount to BEFORE"); hr();
  await stageWrite("PUT", `/admin/matches/${ID}`, { name: BEFORE.name, registrationPrice: BEFORE.registrationPrice, guestCount: BEFORE.guestCount });
  const FINAL = await get();
  const stillOff = EDITABLE_KEYS.filter((k) => JSON.stringify(FINAL[k]) !== JSON.stringify(BEFORE[k]));
  line(stillOff.length === 0
    ? "✓ restored: all writable fields byte-identical to BEFORE."
    : `✗ NOT fully restored — differ: ${stillOff.map((k) => `${k}: ${JSON.stringify(BEFORE[k])}→${JSON.stringify(FINAL[k])}`).join("; ")}`);
  line("\nDONE.");
}
main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
