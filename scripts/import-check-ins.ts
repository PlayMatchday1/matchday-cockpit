// ONE-TIME IMPORT — the twelve Google Sheet check-ins into city_manager_check_ins (0167).
//
//   npx tsx --conditions=react-server scripts/import-check-ins.ts          # dry run
//   npx tsx --conditions=react-server scripts/import-check-ins.ts --apply  # write
//
// IDEMPOTENT on (city_identifier, month_ending, submitted_at). Re-running writes nothing; the
// script reports what it skipped rather than inserting a second copy.
//
// THE CITY MAPPING IS THE POINT OF THE SCRIPT, and it uses the OLD fuzzy matcher deliberately —
// that logic is being deleted from src/lib/checkIns.ts in the same change, and this is the last
// job it does. Reproduced here rather than imported so the deletion is not blocked by its own
// migration. ANYTHING IT CANNOT RESOLVE IS NAMED AND SKIPPED, never guessed into a city.
//
// The Sheet's Email Address column is NOT imported. Nothing read it, the new form does not ask for
// it, and it is the one column here that is personal data.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { CITY_SCOPES } from "../src/lib/cityScope";

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQmzasZGvZavVJan2QFpMxWuhc7HNzWIxRKcx1VsQS7jUZej13C9ODkhN1bw1NFOSUa2fgHKYfySrIE/pub?output=csv";

// MANAGERS' (city label -> cityId) pairs, the join the old matcher went through.
const MANAGER_CITIES: { city: string; cityId: string; name: string }[] = [
  { name: "Yara Usheta", city: "Houston", cityId: "HOU" },
  { name: "Garrett Suits", city: "Austin", cityId: "ATX" },
  { name: "Rodrigo", city: "OKC", cityId: "OKC" },
  { name: "Wilfried Nyamsi", city: "St Louis", cityId: "STL" },
  { name: "Chris Padilla", city: "DFW", cityId: "DFW" },
  { name: "Abraham Garcia", city: "San Antonio", cityId: "SATX" },
  { name: "Ben Faye", city: "Atlanta", cityId: "ATL" },
];

// ── the two helpers being deleted, verbatim, for this one job ────────────────────────────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
function findCol(headers: string[], keywords: string[]): number {
  const lower = headers.map((h) => (h || "").toLowerCase());
  for (const kw of keywords) {
    const idx = lower.findIndex((h) => h.includes(kw.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}
function cityMatch(sheetCity: string, managerCity: string): boolean {
  const cl = sheetCity.toLowerCase(); const ml = managerCity.toLowerCase();
  if (cl === ml) return true;
  if (cl.includes(ml) || ml.includes(cl)) return true;
  if (ml === "dfw" && (cl.includes("dallas") || cl.includes("fort worth"))) return true;
  if (ml === "north austin" && cl.includes("austin")) return true;
  if (ml === "okc" && cl.includes("oklahoma")) return true;
  return false;
}

/* A US-FORMAT SHEET DATE ("4/29/2026", "9/19/2025 12:53:34") TO A REAL CALENDAR DATE.
 * Parsed by hand rather than with `new Date(str)`: the Sheet writes M/D/YYYY, and the parts are
 * unambiguous once split, whereas Date's handling of a bare M/D/YYYY is locale-dependent and its
 * UTC/local behaviour is exactly the trap that moves a month-end date into the previous month. */
function sheetDate(raw: string): { iso: string; ts: string } | null {
  const s = (raw || "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hh, mi, ss] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  /* THE SHEET'S TIMESTAMPS ARE WALL-CLOCK IN THE FORM OWNER'S TIMEZONE, America/Chicago. Stamping
   * them as UTC would move every one of them 5-6 hours, which for the 19:57 and 20:46 rows lands
   * them on the NEXT DAY. Chicago is UTC-5 (CDT) for all twelve of these dates (Mar-Nov for the
   * 2026 rows, and 19 Sep 2025); the offset is applied explicitly rather than by a library so the
   * assumption is visible and checkable. */
  const utc = Date.UTC(y, mo - 1, d, hh + 5, mi, ss);
  return { iso, ts: new Date(utc).toISOString() };
}

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const rd = (n: string) => {
  const m = env.match(new RegExp(`^${n}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const res = await fetch(`${SHEET_URL}&_t=${Date.now()}`);
  if (!res.ok) throw new Error(`sheet HTTP ${res.status}`);
  const rows = parseCSV(await res.text());
  const headers = rows[0];
  const data = rows.slice(1).filter((r) => r.some((c) => c && c.trim()));
  console.log(`  source rows: ${data.length}`);

  const idx = {
    timestamp: findCol(headers, ["timestamp"]),
    monthEnding: findCol(headers, ["month ending"]),
    city: findCol(headers, ["city"]),
    rating: findCol(headers, ["rating", "overall"]),
    fieldsContacted: findCol(headers, ["new fields contacted", "fields contacted"]),
    fieldsList: findCol(headers, ["list of fields"]),
    fieldProgress: findCol(headers, ["progress update", "field relationships"]),
    matchMgr: findCol(headers, ["match manager"]),
    marketingEfforts: findCol(headers, ["grassroots", "marketing efforts"]),
    marketingResults: findCol(headers, ["results from", "marketing results"]),
    win: findCol(headers, ["biggest win"]),
    challenge: findCol(headers, ["biggest challenge"]),
    focus: findCol(headers, ["primary focus", "focus for next"]),
  };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] || "").trim() : "");
  const nz = (v: string) => (v ? v : null);

  const mapped: Record<string, unknown>[] = [];
  const unresolved: string[] = [];
  const cityTally: Record<string, number> = {};

  for (const [n, r] of data.entries()) {
    const cityRaw = get(r, idx.city);
    const hit = MANAGER_CITIES.find((m) => cityMatch(cityRaw, m.city));
    const scope = hit ? CITY_SCOPES.find((c) => c.identifier === hit.cityId) : null;
    if (!hit || !scope) {
      unresolved.push(`row ${n + 1}: city ${JSON.stringify(cityRaw)} resolved to NOTHING`);
      continue;
    }
    const ts = sheetDate(get(r, idx.timestamp));
    const me = sheetDate(get(r, idx.monthEnding));
    if (!ts || !me) {
      unresolved.push(`row ${n + 1}: unparseable date ts=${JSON.stringify(get(r, idx.timestamp))} monthEnding=${JSON.stringify(get(r, idx.monthEnding))}`);
      continue;
    }
    const ratingNum = Number.parseInt(get(r, idx.rating), 10);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      unresolved.push(`row ${n + 1}: rating ${JSON.stringify(get(r, idx.rating))} outside 1-5`);
      continue;
    }
    cityTally[`${cityRaw} -> ${hit.cityId}`] = (cityTally[`${cityRaw} -> ${hit.cityId}`] ?? 0) + 1;
    mapped.push({
      submitted_at: ts.ts,
      /* THE SHEET HAS NO NAME COLUMN — that is why the new form asks for one. The manager is taken
       * from MANAGERS by the city the row resolved to, which is the same join that reconstructed
       * these names in the first place. Imported rows therefore carry the roster's spelling; new
       * rows carry whatever the manager types. */
      manager_name: hit.name,
      city_identifier: hit.cityId,
      month_ending: me.iso,
      rating: ratingNum,
      fields_contacted: nz(get(r, idx.fieldsContacted)),
      fields_list: nz(get(r, idx.fieldsList)),
      field_progress: nz(get(r, idx.fieldProgress)),
      match_manager: nz(get(r, idx.matchMgr)),
      marketing_channels: nz(get(r, idx.marketingEfforts)),
      marketing_results: nz(get(r, idx.marketingResults)),
      win: nz(get(r, idx.win)),
      challenge: nz(get(r, idx.challenge)),
      focus: nz(get(r, idx.focus)),
    });
  }

  console.log("\n  CITY MAPPING (sheet spelling -> city_identifier):");
  for (const [k, v] of Object.entries(cityTally).sort()) console.log(`    ${k.padEnd(34)} ${v}`);
  console.log(`\n  mapped: ${mapped.length} · UNRESOLVED: ${unresolved.length}`);
  for (const u of unresolved) console.log(`    ${u}`);

  const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL")!, rd("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: existing, error: readErr } = await sb
    .from("city_manager_check_ins")
    .select("city_identifier, month_ending, submitted_at");
  if (readErr) {
    console.log(`\n  PREFLIGHT FAILED — is migration 0167 applied? ${readErr.message}`);
    process.exit(1);
  }
  const key = (r: { city_identifier: string; month_ending: string; submitted_at: string }) =>
    `${r.city_identifier}|${r.month_ending}|${new Date(r.submitted_at).toISOString()}`;
  const have = new Set((existing ?? []).map(key));
  const toInsert = mapped.filter((m) => !have.has(key(m as never)));
  console.log(`\n  already in the table: ${have.size} · would insert: ${toInsert.length} · skipped as duplicate: ${mapped.length - toInsert.length}`);

  if (!apply) { console.log("\n  DRY RUN — pass --apply to write."); return; }
  if (toInsert.length === 0) { console.log("\n  nothing to insert."); return; }

  const { error } = await sb.from("city_manager_check_ins").insert(toInsert);
  console.log(`  insert error: ${error?.message ?? "none"}`);
  const { count } = await sb
    .from("city_manager_check_ins")
    .select("*", { count: "exact", head: true });
  console.log(`  rows in city_manager_check_ins now: ${count}`);
}

void main();
