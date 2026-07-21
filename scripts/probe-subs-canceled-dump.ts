// READ-ONLY probe. GET requests only — no writes, no DB, no mutation.
//
// Confirms (or refutes) the June 1 corruption hypothesis:
//   "The /admin/subscriptions CANCELED 'dump' returns truly-ACTIVE
//    members tagged status=CANCELED, and the sync's last-write-wins
//    dedup (CANCELED loop runs after ACTIVE loop) overwrites them."
//
// Two questions the probe answers per city:
//   Q1: Does the strict ACTIVE filter still return the FULL active set
//       (~377 company-wide), all rows row.status=ACTIVE? If ACTIVE
//       itself now returns only ~235, the diagnosis changes — the
//       actives are genuinely missing upstream, not overwritten.
//   Q2: Of the ids the ACTIVE filter returns, how many also come back
//       in the CANCELED dump, and what status does the dump tag them?
//       CANCELED tag + a silent existing sanity check = hypothesis holds.
//
// Run (creds can't be pulled from Vercel; prepend them):
//   MATCHDAY_API_EMAIL=you@... MATCHDAY_API_PASSWORD=... \
//     npx tsx scripts/probe-subs-canceled-dump.ts

import { readFileSync } from "node:fs";
import { getMatchdayApiClient } from "../src/lib/matchdayApi";

// Prefer prepended env; fall back to .env.local if it has real values.
const envFile = (() => {
  try {
    return readFileSync(
      "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
      "utf8",
    );
  } catch {
    return "";
  }
})();
function fromEnvFile(name: string): string | undefined {
  const m = envFile.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) return undefined;
  const v = m[1].trim().replace(/^"|"$/g, "");
  return v.length > 0 ? v : undefined;
}
for (const v of [
  "MATCHDAY_API_EMAIL",
  "MATCHDAY_API_PASSWORD",
  "MATCHDAY_API_BASE_URL",
]) {
  if (!process.env[v]) {
    const val = fromEnvFile(v);
    if (val) process.env[v] = val;
  }
}
if (!process.env.MATCHDAY_API_EMAIL || !process.env.MATCHDAY_API_PASSWORD) {
  console.error(
    "Missing creds. Prepend MATCHDAY_API_EMAIL=... MATCHDAY_API_PASSWORD=... to the command.",
  );
  process.exit(1);
}

const CITIES = ["ATX", "SATX", "HOU", "DFW", "ATL", "STL", "OKC"];
const LIMIT = 100;

type Row = { membershipId?: number; status?: string | null };

async function fetchAll(city: string, status: string): Promise<Row[]> {
  const client = getMatchdayApiClient();
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const res = await client.get<{ data?: Row[] }>("/admin/subscriptions", {
      cityIdentifier: city,
      status,
      sortColumn: "id",
      sortDirection: "asc",
      limit: LIMIT,
      page,
    });
    const data = Array.isArray(res?.data) ? res.data : [];
    out.push(...data);
    if (data.length < LIMIT) break;
  }
  return out;
}

async function main() {
  let totalActive = 0;
  let totalCorrupt = 0;
  for (const city of CITIES) {
    const active = await fetchAll(city, "ACTIVE");
    const dump = await fetchAll(city, "CANCELED");

    const activeStatuses: Record<string, number> = {};
    for (const r of active) {
      const s = String(r.status ?? "(null)");
      activeStatuses[s] = (activeStatuses[s] ?? 0) + 1;
    }
    const dumpById = new Map<number, string>();
    for (const r of dump) {
      if (typeof r.membershipId === "number") {
        dumpById.set(r.membershipId, String(r.status ?? "(null)"));
      }
    }

    let overlap = 0;
    const tag = { ACTIVE: 0, CANCELED: 0, other: 0 };
    let corrupt = 0; // active ids the dump tags non-ACTIVE → overwritten
    for (const r of active) {
      if (typeof r.membershipId !== "number") continue;
      const ds = dumpById.get(r.membershipId);
      if (ds === undefined) continue;
      overlap++;
      if (ds === "ACTIVE") tag.ACTIVE++;
      else if (ds === "CANCELED") {
        tag.CANCELED++;
        corrupt++;
      } else {
        tag.other++;
        corrupt++;
      }
    }
    const dumpActiveTagged = dump.filter((r) => r.status === "ACTIVE").length;

    totalActive += active.length;
    totalCorrupt += corrupt;
    console.log(`\n=== ${city} ===`);
    console.log(
      `Q1  ACTIVE filter: ${active.length} rows | status breakdown ${JSON.stringify(activeStatuses)}`,
    );
    console.log(`    CANCELED dump: ${dump.length} rows`);
    console.log(
      `Q2  overlap (ids in BOTH ACTIVE filter and CANCELED dump): ${overlap}`,
    );
    console.log(
      `    dump tags those overlap ids: ACTIVE=${tag.ACTIVE} CANCELED=${tag.CANCELED} other=${tag.other}`,
    );
    console.log(
      `    existing sanity check sees dump-rows-with-status=ACTIVE = ${dumpActiveTagged} ${dumpActiveTagged > 0 ? "(would WARN)" : "(SILENT — no warning)"}`,
    );
    console.log(
      `    >>> sync last-write-wins would CORRUPT ${corrupt} truly-active members in ${city}`,
    );
  }
  console.log(
    `\n=== TOTAL across ${CITIES.length} cities: ACTIVE-filter ${totalActive} | would-corrupt ${totalCorrupt} ===`,
  );
  console.log(
    "VERDICT: hypothesis HOLDS if ACTIVE-filter total ≈ 377 AND would-corrupt ≈ 142 with SILENT sanity.",
  );
  console.log(
    "         hypothesis FAILS if ACTIVE-filter total ≈ 235 (actives genuinely missing) — stop and reassess.",
  );
}

main().catch((e) => {
  console.error("probe error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
