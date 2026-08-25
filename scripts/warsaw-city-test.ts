// WARSAW — a partner market must resolve as a city everywhere, and stay out of the estate.
//
// NOTHING HAS EVER TESTED A CITY THAT IS NOT IN types.CITIES, which is exactly how this shipped:
// WAW was in CITY_SCOPES and in nothing else, so normalizeCityName("Warsaw") returned null, the
// confinement check could not confirm Warsaw was the Warsaw operator's own city, and his own
// matches were refused. Every assertion below is driven from jf@playmatchday.pl's REAL row.
//
// THE TWO HALVES ARE DIFFERENT QUESTIONS and this file keeps them apart:
//   (a) "does this city exist" — CITY_MAP, KNOWN_CITY_CODES, CITY_TIMEZONES, colours, labels.
//   (b) "is this city ours"    — types.CITIES and every financial list. Warsaw must NOT be there,
//       and the assertion that it is not is the most load-bearing one here: it is what stops a
//       future "add Warsaw everywhere" landing a partner market in a city P&L.
import assert from "node:assert/strict";
process.loadEnvFile(".env.local");

let n = 0, failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); n += 1; console.log(`  ok ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL ${name} — ${(e as Error).message.split("\n")[0]}`); }
};

async function main() {
  const norm    = await import("../src/lib/cityNormalization");
  const scope   = await import("../src/lib/cityScope");
  const tzmod   = await import("../src/lib/cityTimezones");
  const mtz     = await import("../src/lib/matchTimezone");
  const colors  = await import("../src/lib/cityColors");
  const kanban  = await import("../src/lib/kanban");
  const types   = await import("../src/lib/types");
  const fstats  = await import("../src/lib/financeStats");
  const smod    = await import("../src/lib/scheduleMaster");
  const gmod    = await import("../src/lib/growthAnalytics");
  const inv     = await import("../src/lib/inventory");
  const conf    = await import("../src/lib/cityConfinement");
  const { createClient } = await import("@supabase/supabase-js");

  // ── the real row ────────────────────────────────────────────────────────────────────────────
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: row, error } = await sb.from("app_users").select("*").eq("email", "jf@playmatchday.pl").maybeSingle();
  if (error || !row) { console.log(`  FAIL could not read jf@playmatchday.pl — ${error?.message ?? "no row"}`); process.exit(1); }
  const r = row as Record<string, unknown>;
  t("control: the Warsaw account is confined to WAW", () => {
    assert.equal(conf.isConfined(r as never), true);
    assert.equal(conf.confinedCity(r as never), "WAW");
  });

  // ── (a) Warsaw RESOLVES as a city ───────────────────────────────────────────────────────────
  const city = String(r.city_identifier);
  t("cityNameFor(his scope) is Warsaw", () => assert.equal(scope.cityNameFor(city), "Warsaw"));
  t("confinedCityName resolves from his row", () => assert.equal(conf.confinedCityName(r as never), "Warsaw"));
  t("normalizeCityName round-trips his city back to his scope", () =>
    assert.equal(norm.normalizeCityName(scope.cityNameFor(city)), city));
  t("…and accepts the code form too", () => assert.equal(norm.normalizeCityName("WAW"), "WAW"));
  t("…and is case-insensitive on the name", () => assert.equal(norm.normalizeCityName("warsaw"), "WAW"));
  t("his city is a KNOWN_CITY_CODE", () => assert.equal((norm.KNOWN_CITY_CODES as readonly string[]).includes(city), true));
  t("his city is NOT hidden (hiding is for paused markets, not partner ones)", () =>
    assert.equal(norm.HIDDEN_CITY_CODES.has(city), false));
  t("his city has a colour", () => assert.equal(typeof colors.CITY_COLORS[city], "string"));
  t("his city has a kanban label", () => assert.equal(kanban.cityLabel(city), "Warsaw"));
  t("his city is a field-pipeline city code", () => assert.equal(kanban.FIELD_CITY_CODES.includes(city), true));

  // ── the timezone, and the two hours it was out by ────────────────────────────────────────────
  t("his city has an IANA timezone", () => assert.equal(tzmod.timezoneFor(city), "Europe/Warsaw"));
  t("…which is NOT a US zone — the first non-US market", () =>
    assert.equal(/^America\//.test(tzmod.timezoneFor(city) ?? ""), false));
  t("the match-drawer chip names his zone instead of falling back to UTC", () =>
    assert.equal(mtz.tzLabelOfCity("Warsaw"), "Central European"));
  t("a match moved Austin -> Warsaw warns, with the right direction and gap", () => {
    const shift = mtz.tzShift("Austin", "Warsaw");
    assert.notEqual(shift, null, "no warning raised at all");
    assert.equal(shift!.direction, "earlier");     // further EAST = earlier in real terms
    assert.equal(shift!.hours, 7);                 // Central (rank 1) -> Central European (-6)
  });

  /* THE TWO HOURS. formatMatchTitle takes the true instant and renders it in the city's zone. With
   * no zone it fell back to UTC — silently, because isUtcFallback was returned and never read.
   * A 21:30 Warsaw kickoff in August (CEST, UTC+2) rendered as 19:30. */
  const AUG_KICKOFF = "2026-08-26T19:30:00.000Z";   // 21:30 in Warsaw
  t("a Warsaw kickoff renders in Warsaw time, not UTC", () => {
    const got = tzmod.formatMatchTitle({ cityCode: city, startDateIso: AUG_KICKOFF, fieldTitle: "Hala Piłkarska Bemowo" });
    assert.equal(got.isUtcFallback, false, "still falling back to UTC");
    assert.equal(/9:30/.test(got.time), true, `expected 9:30 PM, got ${JSON.stringify(got.time)}`);
    assert.equal(/UTC/.test(got.time), false, "a resolved zone must not carry the UTC suffix");
  });
  t("an UNKNOWN city still falls back to UTC — and now SAYS so", () => {
    const got = tzmod.formatMatchTitle({ cityCode: "ZZZ", startDateIso: AUG_KICKOFF, fieldTitle: "x" });
    assert.equal(got.isUtcFallback, true);
    assert.equal(/\(UTC\)$/.test(got.time), true, `the promised suffix is missing: ${JSON.stringify(got.time)}`);
  });

  // ── (b) Warsaw STAYS OUT of the estate. The most important assertions in this file. ──────────
  const NAME = "Warsaw";
  const has = (xs: readonly string[]) => xs.some((x) => x === NAME || x === city);
  t("*** Warsaw is NOT in types.CITIES — a partner market must never enter a P&L ***", () =>
    assert.equal(has(types.CITIES as unknown as string[]), false));
  t("*** Warsaw is NOT in CITY_DISPLAY_ORDER — the Finance city chips ***", () =>
    assert.equal(has(fstats.CITY_DISPLAY_ORDER as unknown as string[]), false));
  t("Warsaw is NOT in VISIBLE_CITIES", () => assert.equal(has(types.VISIBLE_CITIES as unknown as string[]), false));
  t("Warsaw is NOT in scheduleMaster.CANONICAL_CITIES", () => assert.equal(has(smod.CANONICAL_CITIES as unknown as string[]), false));
  t("Warsaw is NOT in growthAnalytics.CANONICAL_CITIES", () => assert.equal(has(gmod.CANONICAL_CITIES as unknown as string[]), false));
  t("Warsaw is NOT in INVENTORY_CITIES", () => assert.equal(has(inv.INVENTORY_CITIES as unknown as string[]), false));
  t("Warsaw is NOT a key of CITY_STATS", () => assert.equal(has(Object.keys(types.CITY_STATS)), false));
  t("and it is NOT hidden-listed either — 'not ours' is not 'paused'", () =>
    assert.equal(has([...types.HIDDEN_CITIES] as string[]), false));

  // ── the rail keys must resolve. An invariant stated in a comment and never asserted. ─────────
  const sections = await import("../src/app/(internal)/match-ops/sections");
  const sectionKeys = new Set((sections.MATCH_OPS_SECTIONS as { key: string }[]).map((s) => s.key));
  t("control: MATCH_OPS_SECTIONS has keys to check", () => assert.equal(sectionKeys.size >= 10, true));
  for (const k of conf.CONFINED_RAIL_KEYS) {
    t(`CONFINED_RAIL_KEYS "${k}" resolves to a real section`, () => assert.equal(sectionKeys.has(k), true));
  }
  t("Master Schedule is one of them", () => assert.equal(conf.CONFINED_RAIL_KEYS.includes("master"), true));

  console.log(`\n${n} passed, ${failed} failed`);
  if (failed) process.exit(1);
  if (n === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}
main();
