import "server-only"; // no-op under --conditions=react-server
// PART A step 1 + fixtures. GET 2470, print every writable field with raw value +
// JSON type, and write two permanent fixtures: the real 2470 payload and an
// all-nulls variant (every editable field nulled) — both in the shape the editor
// route returns ({ match, fields, players }).
import fs from "node:fs";
import { stageGet } from "../src/lib/matchdayStageApi";
import { EDITABLE_KEYS } from "../src/lib/matchEditModel";
try { process.loadEnvFile(".env.local"); } catch {}

async function main() {
  const raw = await stageGet<Record<string, any>>(`/admin/matches/2470`);
  const fieldsRaw = await stageGet<any[]>(`/admin/fields`).catch(() => []);
  const players = await stageGet<any[]>(`/admin/matches/2470/players`).catch(() => []);

  const jtype = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("WRITABLE FIELD", 22) + pad("RAW JSON VALUE", 32) + "JSON TYPE");
  console.log("─".repeat(66));
  const nulls: string[] = [];
  for (const k of EDITABLE_KEYS) {
    const v = raw[k];
    if (v === null) nulls.push(k);
    console.log(pad(k, 22) + pad(JSON.stringify(v), 32) + jtype(v));
  }
  console.log("─".repeat(66));
  console.log(`nulls (${nulls.length}): ${nulls.join(", ") || "none"}`);

  const field = raw.field ?? {}; const city = field.city ?? {};
  const match: Record<string, unknown> = {};
  for (const k of EDITABLE_KEYS) match[k] = raw[k] ?? null;
  Object.assign(match, { id: raw.id, startDate: raw.startDate, endDate: raw.endDate, isCancelled: raw.isCancelled, teams: raw.teams, fieldTitle: (field.title ?? "").trim() || null, cityName: city.name ?? null });
  const fields = fieldsRaw.map((f) => ({ id: f.id, title: (f.title ?? "").trim(), city: f.city?.name ?? null }));

  fs.writeFileSync("scripts/e2e/fixtures/match-2470.json", JSON.stringify({ match, fields, players }, null, 2));
  const nMatch = { ...match };
  for (const k of EDITABLE_KEYS) nMatch[k] = null; // null EVERY editable field
  fs.writeFileSync("scripts/e2e/fixtures/match-nulls.json", JSON.stringify({ match: nMatch, fields, players }, null, 2));
  console.log("\nwrote scripts/e2e/fixtures/match-2470.json and match-nulls.json");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
