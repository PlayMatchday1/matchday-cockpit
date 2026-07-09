import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const weekStart = "2026-05-04";
const weekEnd = "2026-05-10";

function inCT(iso) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(iso));
}

let matches = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("mdapi_matches")
    .select(
      "api_id, city_identifier, field_title, start_date, is_cancelled, manager_id, manager_email, manager_first_name, manager_last_name, second_manager_id, max_player_count, name",
    )
    .gte("start_date", "2026-05-03T00:00:00Z")
    .lt("start_date", "2026-05-12T00:00:00Z")
    .order("api_id")
    .range(from, from + 999);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (!data || data.length === 0) break;
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
if (secondIds.length > 0) {
  const { data } = await sb
    .from("mdapi_users")
    .select("id, email, first_name, last_name")
    .in("id", secondIds);
  for (const r of data ?? []) secondById.set(r.id, r);
}

const acc = new Map();
function add(email, name, mgrId, role, m) {
  if (!email) return;
  const key = email.toLowerCase();
  if (!acc.has(key)) acc.set(key, { email, name, city: m.city_identifier, matches: [] });
  const pay = (m.max_player_count ?? 0) > 22 ? 30 : 20;
  acc
    .get(key)
    .matches.push({ id: m.api_id, day: inCT(m.start_date), city: m.city_identifier, field: m.field_title, max: m.max_player_count, role, pay });
}
for (const m of inWeek) {
  if (m.manager_email) {
    const name = [m.manager_first_name, m.manager_last_name].filter(Boolean).join(" ") || m.manager_email;
    add(m.manager_email, name, m.manager_id, "primary", m);
  }
  if (m.second_manager_id) {
    const u = secondById.get(m.second_manager_id);
    if (u?.email) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
      add(u.email, name, m.second_manager_id, "secondary", m);
    }
  }
}

const rows = [...acc.values()].map((r) => ({
  email: r.email,
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

const cities = [...byCity.entries()].sort(([a], [b]) => a.localeCompare(b));
let networkMatches = 0;
let networkPay = 0;
for (const [city, mgrs] of cities) {
  mgrs.sort((a, b) => b.pay - a.pay);
  console.log(`\n=== ${city} ===`);
  for (const m of mgrs) {
    console.log(`  ${m.name.padEnd(28)}  ${String(m.matches).padStart(2)} match  $${String(m.pay).padStart(4)}  ${m.email}`);
    networkMatches += m.matches;
    networkPay += m.pay;
  }
}
console.log(`\nNetwork: ${networkMatches} manager-match assignments  $${networkPay} total`);
console.log(`Pay date (Sun + 4): 2026-05-14`);

// Specifically print Troy details
console.log("\n--- Troy detail (any city) ---");
for (const r of rows) {
  if (/troy/i.test(r.name)) {
    console.log(`${r.name} (${r.city}): ${r.matches} matches, $${r.pay}`);
    for (const m of r.detail) {
      console.log(`  ${m.day}  match ${m.id}  ${m.field ?? "—"}  max=${m.max}  ${m.role}  $${m.pay}`);
    }
  }
}
