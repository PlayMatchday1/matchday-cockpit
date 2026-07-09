import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const weekStart = "2026-05-04";
const weekEnd = "2026-05-10";
const THRESHOLD = 25;

function inCT(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

let matches = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb
    .from("mdapi_matches")
    .select("api_id, city_identifier, field_title, start_date, is_cancelled, manager_id, manager_email, manager_first_name, manager_last_name, second_manager_id, max_player_count, raw")
    .gte("start_date", "2026-05-03T00:00:00Z")
    .lt("start_date", "2026-05-12T00:00:00Z")
    .order("api_id")
    .range(from, from + 999);
  if (!data?.length) break;
  matches.push(...data);
  if (data.length < 1000) break;
}

const inWeek = matches.filter((m) => {
  if (m.is_cancelled) return false;
  if (!m.start_date) return false;
  const ct = inCT(m.start_date);
  return ct >= weekStart && ct <= weekEnd;
});

const secondIds = [...new Set(inWeek.map((m) => m.second_manager_id).filter(Boolean))];
const secondById = new Map();
if (secondIds.length) {
  const { data } = await sb.from("mdapi_users").select("id, email, first_name, last_name").in("id", secondIds);
  for (const r of data ?? []) secondById.set(r.id, r);
}

function payAmount(max, coManaged) {
  if (coManaged) return 20;
  if (max != null && max >= THRESHOLD) return 30;
  return 20;
}

const acc = new Map();
function add(email, name, role, m, coManaged) {
  if (!email) return;
  const k = email.toLowerCase();
  if (!acc.has(k)) acc.set(k, { email, name, city: m.city_identifier, matches: [] });
  acc.get(k).matches.push({
    id: m.api_id,
    day: inCT(m.start_date),
    field: m.field_title,
    max: m.max_player_count,
    role,
    coManaged,
    pay: payAmount(m.max_player_count, coManaged),
  });
}

for (const m of inWeek) {
  const coManaged = !!m.second_manager_id || !!m.raw?.secondManager;
  if (m.manager_email) {
    const name = [m.manager_first_name, m.manager_last_name].filter(Boolean).join(" ") || m.manager_email;
    add(m.manager_email, name, "primary", m, coManaged);
  }
  if (m.second_manager_id) {
    const u = secondById.get(m.second_manager_id);
    if (u?.email) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
      add(u.email, name, "secondary", m, coManaged);
    }
  }
}

const rows = [...acc.values()].map((r) => ({
  name: r.name,
  city: r.city,
  matches: r.matches.length,
  pay: r.matches.reduce((s, x) => s + x.pay, 0),
  detail: r.matches,
}));

const byCity = new Map();
for (const r of rows) {
  const c = r.city ?? "Unknown";
  if (!byCity.has(c)) byCity.set(c, []);
  byCity.get(c).push(r);
}

let net = 0, netMatches = 0;
for (const [city, mgrs] of [...byCity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  mgrs.sort((a, b) => b.pay - a.pay);
  console.log(`\n=== ${city} ===`);
  for (const m of mgrs) {
    console.log(`  ${m.name.padEnd(28)}  ${String(m.matches).padStart(2)} match  $${String(m.pay).padStart(4)}`);
    net += m.pay;
    netMatches += m.matches;
  }
}
console.log(`\nNetwork: ${netMatches} manager-match assignments  $${net} total`);

console.log("\n--- Tournament (max>=25) matches in week ---");
const tournamentMatches = inWeek.filter((m) => (m.max_player_count ?? 0) >= THRESHOLD);
console.log(`${tournamentMatches.length} matches with max>=25`);
for (const m of tournamentMatches) {
  const co = !!m.second_manager_id || !!m.raw?.secondManager;
  console.log(`  ${m.city_identifier}  match ${m.api_id}  max=${m.max_player_count}  ${co ? "CO-MANAGED" : "SOLO"}  ${m.field_title ?? "—"}`);
}

console.log("\n--- Co-managed matches in week ---");
const co = inWeek.filter((m) => !!m.second_manager_id || !!m.raw?.secondManager);
console.log(`${co.length} co-managed matches`);
