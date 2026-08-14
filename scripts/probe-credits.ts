// READ-ONLY probe for Player Lookup credit editing (Phase 27 Part 0).
// GETs ONLY. No endpoint is called with a body — a credit probe that "works" moves real
// money into a real account. Nothing identifying is printed: ids and amounts only.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/probe-credits.ts
import { readFileSync } from "node:fs";
for (const line of readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
import { apiGet } from "../src/lib/matchdayStageApi";

type U = { id: number; creditAmount?: unknown; isFakePlayer?: boolean };

async function main() {
  let scanned = 0, nonZero = 0, negative = 0, fractionalDollars = 0;
  const samples: { id: number; raw: unknown }[] = [];
  const negs: { id: number; raw: unknown }[] = [];
  let minV = Infinity, maxV = -Infinity;

  for (let page = 1; page <= 12; page++) {
    const r = await apiGet<{ data?: U[] }>("production", "/admin/players", { limit: 100, page, sortColumn: "createdAt", sortDirection: "desc" });
    const rows = (Array.isArray(r) ? r : (r.data ?? [])) as U[];
    if (!rows.length) break;
    for (const u of rows) {
      scanned++;
      const v = u.creditAmount;
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n === 0) continue;
      nonZero++;
      minV = Math.min(minV, n); maxV = Math.max(maxV, n);
      if (n < 0) { negative++; if (negs.length < 5) negs.push({ id: u.id, raw: v }); }
      // A value that is NOT a multiple of 100 can only be cents — dollars would not carry
      // sub-unit precision in an integer field.
      if (Number.isInteger(n) && n % 100 !== 0) { fractionalDollars++; if (samples.length < 8) samples.push({ id: u.id, raw: v }); }
    }
  }

  console.log(`scanned ${scanned} players`);
  console.log(`non-zero creditAmount : ${nonZero}`);
  console.log(`range                 : min ${minV === Infinity ? "-" : minV}  max ${maxV === -Infinity ? "-" : maxV}`);
  console.log(`NEGATIVE balances     : ${negative}${negs.length ? "  e.g. " + negs.map((x) => `id ${x.id} = ${x.raw}`).join(", ") : ""}`);
  console.log(`values NOT a multiple of 100 (only possible if the field is CENTS): ${fractionalDollars}`);
  for (const s of samples) console.log(`   id ${s.id}: raw ${s.raw}  → as cents $${(Number(s.raw) / 100).toFixed(2)}   → as dollars $${Number(s.raw).toFixed(2)}`);

  // and the SINGLE-player read the panel would use, to confirm the same field/shape
  if (samples[0]) {
    const one = await apiGet<Record<string, unknown>>("production", `/admin/players/${samples[0].id}`);
    console.log(`\nGET /admin/players/${samples[0].id} → creditAmount = ${JSON.stringify(one.creditAmount)} (type ${typeof one.creditAmount})`);
    console.log(`  credit-ish keys on the player: ${Object.keys(one).filter((k) => /credit|balance|wallet/i.test(k)).join(", ") || "(none besides creditAmount)"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
