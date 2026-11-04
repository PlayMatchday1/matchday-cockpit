// Checks the DEPLOYED public website feed. Read only: GETs to the deployed URL and the cover photos,
// plus mirror counts for the cross-check. Not part of `npm run verify` (it needs the network).
//   npx tsx scripts/verify-public-site.mts [baseUrl]
// Prints the actual values beside every verdict. Exit 1 if any check fails.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "https://matchday-clubhouse.vercel.app";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const get = (k: string) => { const m = env.match(new RegExp(`^${k}=(.+)$`, "m")); return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : ""; };
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let fails = 0;
const check = (name: string, ok: boolean, actual: unknown) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      actual: ${typeof actual === "string" ? actual : JSON.stringify(actual)}`); };

const res = await fetch(`${BASE}/api/public/site.json`, { headers: { Origin: "https://www.playmatchday.com" } });
const hdr = (r: Response, k: string) => r.headers.get(k);
console.log(`GET ${BASE}/api/public/site.json -> ${res.status}; cache-control: ${hdr(res, "cache-control")}; x-vercel-cache: ${hdr(res, "x-vercel-cache")}; age: ${hdr(res, "age")}`);
const p: any = await res.json();
check("payload served (positive control for every absence check)", res.status === 200 && Array.isArray(p.cities) && p.cities.length > 0, { status: res.status, schema_version: p.schema_version, generated_at: p.generated_at, cities: p.cities?.map((c: any) => `${c.slug}:${c.status}`) });

// Philadelphia: launching, first match this Sunday (derived: the first Sunday on or after today in New York).
const nyToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const [y, m, d] = nyToday.split("-").map(Number);
const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const sunday = new Date(Date.UTC(y, m - 1, d + ((7 - dow) % 7))).toISOString().slice(0, 10);
const phl = p.cities.find((c: any) => c.slug === "philadelphia");
check(`Philadelphia present, launching, first_match_date = this Sunday (${sunday})`, phl?.status === "launching" && phl?.first_match_date === sunday, phl ? { status: phl.status, first_match_date: phl.first_match_date, fields: phl.fields.map((f: any) => `${f.name}:${f.status}:${f.first_match_date}`) } : "absent");

// Austin: San Juan Diego (fields 13, 859) not among the live fields. Westlake assertion dropped (Ryan, 2026-11-03).
const atx = p.cities.find((c: any) => c.slug === "austin");
const atxLive = (atx?.fields ?? []).filter((f: any) => f.status === "live");
check("Austin has live fields (control) and none of them is San Juan Diego (fields 13, 859)", atxLive.length > 0 && !atxLive.some((f: any) => f.mdapi_field_ids.some((id: number) => id === 13 || id === 859) || /juan|sjd/i.test(f.name)), atxLive.map((f: any) => `${f.name} [${f.mdapi_field_ids}]`));

// Absent: El Paso, New York, Warsaw — by slug, by name, and by any field id they own.
const names = p.cities.map((c: any) => `${c.slug}|${c.name}`);
const allIds = p.cities.flatMap((c: any) => c.fields.flatMap((f: any) => f.mdapi_field_ids));
check("El Paso absent", !names.some((n: string) => /el.?paso/i.test(n)), names);
check("New York absent", !names.some((n: string) => /new.?york|nyc/i.test(n)), names);
check("Warsaw absent (city and fields 1684, 2146)", !names.some((n: string) => /warsaw|waw/i.test(n)) && !allIds.includes(1684) && !allIds.includes(2146), { cities: names.length, fieldIds: allIds.length });

// Every live field: an address and a cover photo that returns 200.
const live = p.cities.flatMap((c: any) => c.fields.filter((f: any) => f.status === "live").map((f: any) => ({ city: c.slug, ...f })));
const rows: string[] = []; let bad = 0;
for (const f of live) {
  /* 200 AND IMAGE BYTES. The served Content-Type is printed, not asserted: three covers (Bob Jones Park, Saginaw,
   * One Touch, 2026-11-03) are real PNGs served as binary/octet-stream because they were uploaded without a
   * Content-Type (POST /files accepts that). An <img> renders them; the type is reported so it can be fixed. */
  let code = 0, type = "", magic = "";
  if (f.cover_photo_url) { const r = await fetch(f.cover_photo_url); code = r.status; type = r.headers.get("content-type") ?? ""; const b = Buffer.from(await r.arrayBuffer()); magic = b.subarray(0, 4).toString("hex"); }
  const isImage = /^89504e47|^ffd8ff|^52494646|^47494638/.test(magic); // png, jpeg, webp (RIFF), gif
  const ok = !!f.address?.street && code === 200 && isImage;
  if (!ok) bad++;
  rows.push(`${ok ? "ok " : "BAD"} ${f.city}/${f.slug} | ${f.address?.street ?? "NO ADDRESS"} | cover ${code} ${isImage ? "image bytes" : "NOT AN IMAGE"} (served as ${type})`);
}
check(`every live field has an address and a cover returning 200 with image bytes (${live.length} live fields)`, live.length > 0 && bad === 0, "\n        " + rows.join("\n        "));

// All-time matches: no existing page shows a distinct-match count (the Data Room's "Matches" is one per player
// spot). Cross-checked against the mirror directly, with the same definition, outside the route's code.
const now = new Date().toISOString();
const held = await sb.from("mdapi_matches").select("api_id", { count: "exact", head: true }).is("deleted_at", null).eq("is_cancelled", false).lte("start_date_utc", now).neq("city_identifier", "WAW");
check("totals.matches_all_time = mirror count (kicked off, not cancelled, alive, not Warsaw)", held.count != null && Math.abs(p.totals.matches_all_time - held.count) <= 3, { route: p.totals.matches_all_time, mirror: held.count, mirrorError: held.error?.message ?? null, note: "<=3 apart allowed: a match can kick off between the edge build and this read" });
const perCitySum = p.cities.reduce((s: number, c: any) => s + c.counts.matches_all_time, 0);
console.log(`      info: sum of cities' matches_all_time = ${perCitySum} (omitted cities' history is in the total, not in a city row)`);
const prof = await sb.from("growth_player_profile").select("user_id", { count: "exact", head: true });
const wawOnly = await sb.from("growth_player_profile").select("user_id", { count: "exact", head: true }).not("city_counts->WAW", "is", null);
console.log(`      info: players_all_time ${p.totals.players_all_time}; growth_player_profile rows (the Data Room's all-time Players) ${prof.count}; of those with any Warsaw play ${wawOnly.count}`);

// ── 2026-11-03 follow-ups ──────────────────────────────────────────────────────────────────────
// Price range: regular-play listings, nothing under $5. Every city with a range, printed.
const ranges = p.cities.map((c: any) => `${c.slug} ${c.price_per_match_cents ? `$${c.price_per_match_cents.min / 100}–$${c.price_per_match_cents.max / 100}` : "null"}`);
const withRange = p.cities.filter((c: any) => c.price_per_match_cents);
check("no city's price range starts below $5 (control: cities with a range > 0)", withRange.length > 0 && withRange.every((c: any) => c.price_per_match_cents.min >= 500), ranges);
const venuesWithRange = p.cities.flatMap((c: any) => c.fields.filter((f: any) => f.price_per_match_cents));
check("no venue's price range starts below $5 (control: venues with a range > 0)", venuesWithRange.length > 0 && venuesWithRange.every((f: any) => f.price_per_match_cents.min >= 500), `${venuesWithRange.length} venues with a range; lowest min ${Math.min(...venuesWithRange.map((f: any) => f.price_per_match_cents.min))}`);
const under5 = p.cities.flatMap((c: any) => c.fields.flatMap((f: any) => f.next_14_days.filter((m: any) => m.price_cents != null && m.price_cents < 500).map((m: any) => `${f.name} ${m.date} $${m.price_cents / 100}`)));
console.log(`      info: next_14_days matches under $5 kept at their real price: ${under5.length ? under5.join("; ") : "none in the window today"}`);
// Display counts: rounded DOWN to the hundred.
const fl = (n: number) => `${(Math.floor(n / 100) * 100).toLocaleString("en-US")}+`;
check("totals.matches_display / players_display = rounded down to the hundred, with +", p.totals.matches_display === fl(p.totals.matches_all_time) && p.totals.players_display === fl(p.totals.players_all_time), { matches_all_time: p.totals.matches_all_time, matches_display: p.totals.matches_display, players_all_time: p.totals.players_all_time, players_display: p.totals.players_display });
// Names: no product word in any display name. Control: field 22, whose title is "Tourney ATH Pearland", is present and stripped.
const allVenues = p.cities.flatMap((c: any) => c.fields.map((f: any) => ({ city: c.slug, ...f })));
const PW = /\b(tourney|tournaments?|discounted|discount|premier match)\b/i;
const pearland = allVenues.find((f: any) => f.mdapi_field_ids.includes(22));
check("no venue display name carries Tourney/Tournament/Discount(ed)/Premier Match (control: field 22 'Tourney ATH Pearland' -> 'ATH Pearland')", !!pearland && pearland.name === "ATH Pearland" && !allVenues.some((f: any) => PW.test(f.name)),
  "\n        " + allVenues.map((f: any) => `${f.city}/${f.slug}: ${f.name} [${f.status}] fields ${f.mdapi_field_ids.join(",")}`).join("\n        "));
// site_url: the ten mapped venues, each 200.
const urls = allVenues.filter((f: any) => f.site_url);
const urlRows: string[] = []; let urlBad = 0;
for (const f of urls) { const r = await fetch(f.site_url, { redirect: "manual" }); await r.body?.cancel(); if (r.status !== 200) urlBad++; urlRows.push(`${r.status} ${f.name} -> ${f.site_url}`); }
check("site_url set on the 10 mapped venues, each returning 200", urls.length === 10 && urlBad === 0, "\n        " + urlRows.join("\n        "));

// ── display_name / full_name, spots_open (2026-11-03) ─────────────────────────────────────────
const dal = p.cities.find((c: any) => c.slug === "dallas");
check("Dallas display_name 'Dallas', full_name 'Dallas / Fort Worth'; every city has both", dal?.display_name === "Dallas" && dal?.full_name === "Dallas / Fort Worth" && p.cities.every((c: any) => c.display_name && c.full_name),
  p.cities.map((c: any) => `${c.slug}: ${c.display_name} | ${c.full_name}`));
const allM = p.cities.flatMap((c: any) => c.fields.flatMap((f: any) => f.next_14_days.map((m: any) => ({ v: f.name, ...m }))));
const badSpots = allM.filter((m: any) => !(Number.isInteger(m.spots_open) && m.spots_open >= 0 && (m.spots_total == null || m.spots_open <= m.spots_total)));
const someTaken = allM.filter((m: any) => m.spots_open != null && m.spots_total != null && m.spots_open < m.spots_total);
check("spots_open is an integer 0..spots_total on every listed match (control: some matches have spots taken)", allM.length > 0 && badSpots.length === 0 && someTaken.length > 0,
  { matches: allM.length, invalid: badSpots.slice(0, 5).map((m: any) => `${m.v} ${m.date} ${m.spots_open}/${m.spots_total}`), withSpotsTaken: someTaken.length, full: allM.filter((m: any) => m.spots_open === 0).length, sample: someTaken.slice(0, 4).map((m: any) => `${m.v} ${m.date} ${m.kickoff}: ${m.spots_open} of ${m.spots_total} open`) });

// ── neighborhood (2026-11-03) ──────────────────────────────────────────────────────────────────
const venuesAll = p.cities.flatMap((c: any) => c.fields.map((f: any) => ({ city: c.slug, ...f })));
const liveV = venuesAll.filter((f: any) => f.status === "live" || f.status === "upcoming");
const blankArea = liveV.filter((f: any) => !(typeof f.neighborhood === "string" && f.neighborhood.trim()));
check("every live and upcoming venue has a neighborhood (control: venues listed > 0)", liveV.length > 0 && blankArea.length === 0,
  "\n        " + liveV.map((f: any) => `${f.city}/${f.slug}: ${f.name} -> ${f.neighborhood ?? "(blank)"}`).join("\n        "));

// ── name overrides (2026-11-03) ──────────────────────────────────────────────────────────────
const byField = (id: number) => venuesAll.find((f: any) => f.mdapi_field_ids.includes(id));
const want: [number, string, string][] = [[1, "Westlake High School", "westlake-high-school"], [25, "Round Rock Multipurpose Complex", "round-rock-multipurpose-complex"], [1024, "The Hattrick Leander", "the-hattrick-leander"], [1288, "The Hattrick Tomball", "the-hattrick-tomball"], [1585, "Parmer Stadium", "parmer-stadium"]];
check("display-name overrides applied, slugs follow, The Hattrick Tomball keeps its site_url", want.every(([id, n, sl]) => byField(id)?.name === n && byField(id)?.slug === sl) && byField(1288)?.site_url === "https://www.playmatchday.com/pickup-soccer-hattrick-tomball-houston/",
  want.map(([id]) => { const f = byField(id); return `${id}: ${f?.name} (${f?.slug})${f?.site_url ? " -> " + f.site_url : ""}`; }));

// ATH Pearland's cover is the regular listing's photo (field 32), not the tournament-night graphic on field 22.
const pear = venuesAll.find((f: any) => f.mdapi_field_ids.includes(22));
check("ATH Pearland uses its regular listing's cover (field 32), not the Tourney listing's (field 22)", pear?.cover_photo_url === "https://images.playmatchday.com/images/1cc628ed-0395-452c-9837-0db92bcf118a", pear?.cover_photo_url);

// CORS
for (const o of ["https://playmatchday.com", "https://www.playmatchday.com", "https://playmatchday.com.evil.com"]) {
  const r = await fetch(`${BASE}/api/public/site.json`, { headers: { Origin: o } }); await r.body?.cancel();
  const acao = r.headers.get("access-control-allow-origin");
  check(`CORS for ${o}`, o.endsWith("evil.com") ? acao == null : acao === o, { acao, vary: r.headers.get("vary"), xVercelCache: r.headers.get("x-vercel-cache") });
}
const html = await fetch(`${BASE}/api/public/site`);
const text = await html.text();
check("HTML page renders the feed", html.status === 200 && text.includes("Website feed") && text.includes("Philadelphia"), { status: html.status, bytes: text.length });

// Records to clean up in the Clubhouse: live venues whose fin_venues row says inactive or past its schedule end.
const liveIds = p.cities.flatMap((c: any) => c.fields.filter((f: any) => f.status === "live").flatMap((f: any) => f.mdapi_field_ids));
const { data: links } = await sb.from("fin_venue_fields").select("fin_venue_id,mdapi_field_id").in("mdapi_field_id", liveIds);
const { data: vens } = await sb.from("fin_venues").select("id,venue_name,city,is_active,schedule_end_date").in("id", [...new Set((links ?? []).map((l) => l.fin_venue_id))]);
const today = new Date().toISOString().slice(0, 10);
console.log("\nLIVE VENUES WITH A STALE fin_venues RECORD:");
for (const v of vens ?? []) if (!v.is_active || (v.schedule_end_date && v.schedule_end_date < today))
  console.log(`  fin_venues ${v.id} ${v.venue_name} (${v.city}) is_active=${v.is_active} schedule_end_date=${v.schedule_end_date} fields ${(links ?? []).filter((l) => l.fin_venue_id === v.id).map((l) => l.mdapi_field_id)}`);
const unlinked = liveIds.filter((id: number) => !(links ?? []).some((l) => l.mdapi_field_id === id));
console.log(`LIVE FIELD IDS WITH NO fin_venue_fields LINK: ${unlinked.join(", ") || "none"}`);

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
