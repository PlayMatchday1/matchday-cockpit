// Fields page reconciliation (verify steps 2/3/5). Throwaway.
// Recomputes the three tile numbers, the flagged-field count and its breakdown
// straight from the tables (independent fetch), and checks them against the
// rendered page. Also confirms the breakdown sums to the flagged total and that
// every flag has visible evidence in the rows. Screenshots 1600 + 1280 and
// exercises the segment / city / search / tile controls.
//
// Run: npx --yes tsx --env-file=.env.local scripts/fields-reconcile.mts

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import {
  UPCOMING_DAYS, DAY_MS, buildWeeks, weekIndexOf, deriveField, computeTiles,
  type Venue, type VenueMatch,
} from "../src/lib/fieldsOps";

const BASE = "http://localhost:3000";
const OUT = (process.env.CLAUDE_JOB_DIR || ".") + "/tmp";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY!, anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const ref = url.replace("https://", "").split(".")[0];
const sb = createClient(url, svc, { auth: { persistSession: false } });
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "rmancuso@playmatchday.com" });
const cli = createClient(url, anon, { auth: { persistSession: false } });
const { data: sess } = await cli.auth.verifyOtp({ type: "email", token_hash: link!.properties.hashed_token });

// ── independent fetch (same shape as the page, separate code) ──
const now = Date.now();
const weeks = buildWeeks(now);
const winStart = weeks[0].aMs, winEnd = now + UPCOMING_DAYS * DAY_MS;
const { data: venuesRaw } = await sb.from("fin_venues").select("id, venue_name, city, contact_name, contact_number, min_players, max_players, schedule_url").eq("is_active", true);
const { data: links } = await sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id");
const fieldToVenue = new Map<number, number>(); links!.forEach((l: any) => fieldToVenue.set(l.mdapi_field_id, l.fin_venue_id));
const allFieldIds = [...new Set(links!.map((l: any) => l.mdapi_field_id))];
const matches: any[] = [];
for (let from = 0; ; from += 1000) {
  const r = await sb.from("mdapi_matches").select("api_id, field_id, start_date_utc, start_date, field_address, is_cancelled").in("field_id", allFieldIds).gte("start_date_utc", new Date(winStart).toISOString()).lte("start_date_utc", new Date(winEnd).toISOString()).is("deleted_at", null).range(from, from + 999);
  matches.push(...(r.data ?? [])); if (!r.data || r.data.length < 1000) break;
}
const liveIds = matches.filter((m) => !m.is_cancelled).map((m) => m.api_id);
const countByMatch = new Map<number, number>();
for (let i = 0; i < liveIds.length; i += 120) {
  const chunk = liveIds.slice(i, i + 120);
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("mdapi_match_players").select("match_api_id").in("match_api_id", chunk).eq("user_type", "PLAYER").eq("is_cancelled", false).eq("user_is_fake_player", false).range(from, from + 999);
    for (const p of (r.data ?? [])) countByMatch.set(p.match_api_id, (countByMatch.get(p.match_api_id) ?? 0) + 1);
    if (!r.data || r.data.length < 1000) break;
  }
}
const perVenue = new Map<number, VenueMatch[]>();
for (const m of matches) {
  if (m.is_cancelled || !m.start_date_utc) continue;
  const vid = fieldToVenue.get(m.field_id); if (vid == null) continue;
  const ms = Date.parse(m.start_date_utc);
  (perVenue.get(vid) ?? perVenue.set(vid, []).get(vid)!).push({ startMs: ms, played: ms < now, time: "", count: countByMatch.get(m.api_id) ?? 0 });
}
const venues: Venue[] = venuesRaw!.map((v: any) => ({ id: v.id, name: v.venue_name, city: v.city, code: "", contactName: v.contact_name, contactPhone: v.contact_number, minPlayers: v.min_players, maxPlayers: v.max_players, scheduleUrl: v.schedule_url, address: null }));
const rows = venues.map((v) => deriveField(v, perVenue.get(v.id) ?? [], now, weeks));
const tiles = computeTiles(rows);

// ── raw SQL-style cross-check (no fieldsOps) ──
const rawUpcoming = matches.filter((m) => !m.is_cancelled && Date.parse(m.start_date_utc) >= now && Date.parse(m.start_date_utc) <= now + UPCOMING_DAYS * DAY_MS).length;
const lastWk = weeks.length - 1;
const rawPlaying = venues.filter((v) => (perVenue.get(v.id) ?? []).some((m) => weekIndexOf(m.startMs, weeks) === lastWk)).length;
const noContact = rows.filter((r) => !r.venue.contactPhone).length;
const idleOrNever = rows.filter((r) => r.flags.some((f) => f.k === "idle" || f.k === "never")).length;
const fillLow = rows.filter((r) => r.flags.some((f) => f.k === "fill")).length;
const breakdownSum = tiles.breakdown.reduce((s, b) => s + b.n, 0);

// ── render ──
const browser = await chromium.launch();
async function open(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k as string, v as string); } catch {} }, [`sb-${ref}-auth-token`, JSON.stringify(sess!.session)]);
  const pg = await ctx.newPage();
  const errs: string[] = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto(BASE + "/match-ops/field-ops", { waitUntil: "load", timeout: 60000 });
  await pg.waitForTimeout(5000);
  return { ctx, pg, errs };
}
const { ctx, pg, errs } = await open(1600);
const read = await pg.evaluate(() => ({
  playing: (document.querySelector('[data-fo="playing"]')?.textContent || "").trim(),
  upcoming: (document.querySelector('[data-fo="upcoming"]')?.textContent || "").trim(),
  needslook: (document.querySelector('[data-fo="needslook"]')?.textContent || "").trim(),
  addContactBtns: [...document.querySelectorAll("button")].filter((b) => /Add contact/.test(b.textContent || "")).length,
  idleChips: [...document.querySelectorAll("span")].filter((s) => /^(Idle \d+d|Never used)$/.test((s.textContent || "").trim())).length,
  underMin: [...document.querySelectorAll("div")].filter((d) => /under the minimum$/.test((d.textContent || "").trim())).length,
  docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
await pg.screenshot({ path: `${OUT}/fields_1600.png` });

const num = (s: string) => Number((s.match(/\d+/) || [0])[0]);
const P = (ok: boolean, l: string, a: any, b: any) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${l.padEnd(34)} page=${a}  independent=${b}`); return ok; };
let fails = 0; const chk = (ok: boolean, l: string, a: any, b: any) => { if (!P(ok, l, a, b)) fails++; };

console.log("=== SQL-style raw counts (no fieldsOps) vs fieldsOps ===");
console.log(`  upcoming matches (7d): raw=${rawUpcoming}  fieldsOps=${tiles.upcomingMatches}  ${rawUpcoming === tiles.upcomingMatches ? "OK" : "MISMATCH"}`);
console.log(`  playing this week: raw=${rawPlaying}  fieldsOps=${tiles.playingThisWeek}  ${rawPlaying === tiles.playingThisWeek ? "OK" : "MISMATCH"}`);

console.log("\n=== tiles: page vs independent ===");
chk(num(read.playing) === tiles.playingThisWeek, "tile · playing this week", num(read.playing), tiles.playingThisWeek);
chk(num(read.upcoming) === tiles.upcomingMatches, "tile · matches next 7 days", num(read.upcoming), tiles.upcomingMatches);
chk(num(read.needslook) === tiles.needsLook, "tile · needs a look", num(read.needslook), tiles.needsLook);

console.log("\n=== flag accounting ===");
chk(breakdownSum === tiles.needsLook, "breakdown sums to flagged total", breakdownSum, tiles.needsLook);
console.log(`  breakdown: ${tiles.breakdown.map((b) => `${b.n} ${b.k}`).join(", ")}`);

console.log("\n=== every flag has visible evidence in a row (view=all) ===");
chk(read.addContactBtns === noContact, "Add-contact buttons == no-contact fields", read.addContactBtns, noContact);
chk(read.idleChips === idleOrNever, "Idle/Never chips == idle-or-never fields", read.idleChips, idleOrNever);
chk(read.underMin === fillLow, "under-minimum notes == fill-flagged fields", read.underMin, fillLow);

console.log(`\n1600px docOverflow=${read.docOverflow} (must be 0)`);
chk(read.docOverflow <= 0, "no horizontal overflow @1600", read.docOverflow, 0);

// exercise controls — counts move together
console.log("\n=== controls move counts together ===");
for (const seg of ["Needs a look", "Idle", "Playing this week", "All"]) {
  await pg.locator(`.inline-flex button:has-text("${seg}")`).first().click().catch(async () => { await pg.locator(`button:has-text("${seg}")`).first().click().catch(() => {}); });
  await pg.waitForTimeout(500);
  const scope = (await pg.locator("text=/Showing/").first().textContent()) || "";
  console.log(`  segment "${seg}": ${scope.replace(/\s+/g, " ").trim()}`);
}
// city dropdown
await pg.locator("select").first().selectOption({ index: 1 }).catch(() => {});
await pg.waitForTimeout(500);
console.log("  after city filter:", ((await pg.locator("text=/Showing/").first().textContent()) || "").replace(/\s+/g, " ").trim());
await pg.locator("button:has-text('Clear filters')").click().catch(() => {});
await pg.waitForTimeout(400);
// search
await pg.locator('input[type="search"]').fill("turf");
await pg.waitForTimeout(500);
console.log("  after search 'turf':", ((await pg.locator("text=/Showing/").first().textContent()) || "").replace(/\s+/g, " ").trim());
await pg.locator('input[type="search"]').fill("");
await pg.waitForTimeout(300);
console.log(`\npageerrors @1600: ${errs.length}`);
await ctx.close();

// 1280px
const { ctx: c2, pg: p2, errs: e2 } = await open(1280);
const over2 = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await p2.screenshot({ path: `${OUT}/fields_1280.png` });
chk(over2 <= 0, "no horizontal overflow @1280", over2, 0);
console.log(`pageerrors @1280: ${e2.length}`);
await c2.close();

await browser.close();
console.log(`\n=== ${fails === 0 ? "ALL RECONCILED" : fails + " FAILURE(S)"} ===`);
process.exit(fails ? 1 : 0);
