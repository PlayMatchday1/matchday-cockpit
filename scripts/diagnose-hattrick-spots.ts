// Walk the dashboard's filter cascade for Hattrick spots: 874 → 398.
// Side-by-side with the user's raw SQL, applying each filter step
// incrementally to see where the rows go.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key =
  env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)?.[1].trim() ??
  env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  // (3) Distinct field_title values containing 'hat' anywhere
  const { data: titles } = await sb
    .from("mdapi_matches")
    .select("field_title")
    .ilike("field_title", "%hat%");
  const distinctTitles = [...new Set((titles ?? []).map((t: any) => t.field_title))];
  console.log("=== Distinct field_titles containing 'hat' ===");
  for (const t of distinctTitles) console.log(`  ${JSON.stringify(t)}`);
  console.log();

  // (5) fin_venues mapping for hattrick — column raw_venue_name does
  // not exist in this table; select(*) and filter in JS.
  const { data: venues } = await sb.from("fin_venues").select("*");
  const hatVenues = (venues ?? []).filter((v: any) => /hat/i.test(v.venue_name ?? ""));
  console.log("=== fin_venues rows containing 'hat' ===");
  for (const v of hatVenues) console.log(`  id=${v.id} venue_name=${JSON.stringify(v.venue_name)} city=${v.city}`);
  console.log();

  // Dashboard uses fieldLike = `%${venue.venue_name}%` from fin_venues by id.
  const { data: pd } = await sb
    .from("partner_dashboards")
    .select("venue_id, partner_name")
    .eq("slug", "hattrick-yx4sur4t")
    .maybeSingle();
  const venueId = (pd as any)?.venue_id;
  const hatVenue = (venues ?? []).find((v: any) => v.id === venueId);
  console.log("=== partner_dashboards (hattrick slug) ===");
  console.log(`  ${JSON.stringify(pd)}`);
  console.log(`  → fin_venues row: id=${hatVenue?.id} venue_name=${JSON.stringify(hatVenue?.venue_name)}`);
  const venueName = hatVenue?.venue_name ?? "";
  console.log(`  → dashboard's fieldLike pattern: %${venueName}%`);
  console.log();

  // ===================================================================
  // SIDE BY SIDE — user's raw query AND dashboard fetch path
  // ===================================================================

  // --- (A) USER'S QUERY simulated by manual two-step JOIN ---
  // (no foreign key declared in PostgREST schema cache, so PostgREST
  // can't auto-resolve the embedded select. Replicate manually.)
  const userMatchesAll: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("mdapi_matches")
      .select("api_id, field_title, start_date")
      .ilike("field_title", "%hattrick%")
      .gte("start_date", "2026-03-01")
      .lte("start_date", "2026-05-06")
      .order("api_id")
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    userMatchesAll.push(...data);
    if (data.length < 1000) break;
  }
  const userMatchIds = userMatchesAll.map((m) => m.api_id);
  const userPlayersAll: any[] = [];
  for (let i = 0; i < userMatchIds.length; i += 200) {
    const chunk = userMatchIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("mdapi_match_players")
        .select(
          "api_id, match_api_id, user_id, user_email, user_type, paid_status, promocode_id, is_cancelled, canceled_at, is_absent, user_is_fake_player",
        )
        .in("match_api_id", chunk)
        .eq("is_absent", false)
        .eq("is_cancelled", false)
        .eq("user_is_fake_player", false)
        .order("api_id")
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      userPlayersAll.push(...data);
      if (data.length < 1000) break;
    }
  }
  const userGuests = userPlayersAll.filter((r) => r.user_type === "GUEST").length;
  const userPlayers = userPlayersAll.filter((r) => r.user_type === "PLAYER").length;
  const userUniqueIds = new Set(userPlayersAll.map((r) => r.user_id)).size;
  console.log("=== USER'S QUERY (manual two-step JOIN reproduction) ===");
  console.log(`  matches in window:   ${userMatchesAll.length}`);
  console.log(`  total spots:         ${userPlayersAll.length}`);
  console.log(`  unique user_ids:     ${userUniqueIds}`);
  console.log(`  user_type=GUEST:     ${userGuests}`);
  console.log(`  user_type=PLAYER:    ${userPlayers}`);
  console.log();

  // --- (B) DASHBOARD FETCH (mimicking fetchJoinedMatchPlayers) ---
  // Step 1: matches by fieldLike (dashboard uses venue_name from fin_venues)
  const fieldLike = `%${venueName}%`;
  const matches: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("mdapi_matches")
      .select("api_id, city_identifier, field_title, start_date, is_cancelled")
      .ilike("field_title", fieldLike)
      .order("api_id")
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    matches.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`=== DASHBOARD FETCH ===`);
  console.log(`  Step 1: mdapi_matches ILIKE '${fieldLike}' (no date filter at fetch — partner page)`);
  console.log(`    matches fetched: ${matches.length}`);
  console.log(`    match.is_cancelled=true count: ${matches.filter((m: any) => m.is_cancelled).length}`);

  // Step 2: players for those matches (paginated)
  const matchIds = matches.map((m: any) => m.api_id);
  const playersChunks: any[] = [];
  for (let i = 0; i < matchIds.length; i += 200) {
    const chunk = matchIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("mdapi_match_players")
        .select(
          "api_id, match_api_id, user_id, user_email, user_type, paid_status, promocode_id, is_cancelled, canceled_at, amount, created_at, is_absent, user_is_fake_player",
        )
        .in("match_api_id", chunk)
        .order("api_id")
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      playersChunks.push(...data);
      if (data.length < 1000) break;
    }
  }
  console.log(`  Step 2: mdapi_match_players for those match ids`);
  console.log(`    players fetched: ${playersChunks.length}`);
  console.log();

  // Now apply dashboard filters incrementally.
  const matchById = new Map((matches ?? []).map((m: any) => [m.api_id, m]));

  // mapJoinedRow drops paid_status='WAITING'
  const afterWaiting = playersChunks.filter((p) => p.paid_status !== "WAITING");
  console.log(`  Filter A (mapJoinedRow drops paid_status='WAITING'): ${playersChunks.length} → ${afterWaiting.length}`);

  // mapJoinedRow drops if city_identifier doesn't map (we'll allow Austin only since Hattrick is ATX)
  const ATX = (m: any) => m && m.city_identifier === "ATX";
  const afterCity = afterWaiting.filter((p) => ATX(matchById.get(p.match_api_id)));
  console.log(`  Filter B (city_identifier maps to cockpit city, ATX): ${afterWaiting.length} → ${afterCity.length}`);

  // computePartnerStats: drops staff (matchday.com)
  const STAFF = (e: string | null) => !!e && e.toLowerCase().includes("matchday.com");
  const afterStaff = afterCity.filter((p) => !STAFF(p.user_email));
  console.log(`  Filter C (drop staff matchday.com emails): ${afterCity.length} → ${afterStaff.length}`);

  // pacAll → pac: drops match_canceled (sourced from mdapi_matches.is_cancelled)
  const afterMatchCancel = afterStaff.filter((p) => {
    const m = matchById.get(p.match_api_id);
    return !(m as any)?.is_cancelled;
  });
  console.log(`  Filter D (drop match.is_cancelled=true): ${afterStaff.length} → ${afterMatchCancel.length}`);

  // showed: drops player_canceled_at non-null (== player-side cancelled)
  const afterPlayerCancel = afterMatchCancel.filter((p) => !p.canceled_at || String(p.canceled_at).trim() === "");
  console.log(`  Filter E (drop player canceled_at non-null = isCanceled): ${afterMatchCancel.length} → ${afterPlayerCancel.length}`);

  // Mar 31 baseline filter (page.tsx)
  const afterBaseline = afterPlayerCancel.filter((p) => {
    const m = matchById.get(p.match_api_id);
    const ymd = String((m as any)?.start_date ?? "").slice(0, 10);
    return ymd >= "2026-03-31";
  });
  console.log(`  Filter F (page.tsx Mar 31 baseline >= 2026-03-31): ${afterPlayerCancel.length} → ${afterBaseline.length}`);

  // Date upper bound — dashboard does NOT cap at May 6. The user's query does.
  const afterUpperBound = afterBaseline.filter((p) => {
    const m = matchById.get(p.match_api_id);
    const ymd = String((m as any)?.start_date ?? "").slice(0, 10);
    return ymd <= "2026-05-06";
  });
  console.log(`  (G) If we further cap <= 2026-05-06 (user's upper bound): ${afterBaseline.length} → ${afterUpperBound.length}`);
  console.log();

  // Show what fields user's filters cut that dashboard doesn't
  console.log("=== Filters in USER'S query NOT applied by dashboard ===");
  const isAbsentTrue = afterPlayerCancel.filter((p: any) => p.is_absent === true).length;
  const fakeTrue = afterPlayerCancel.filter((p: any) => p.user_is_fake_player === true).length;
  const isCancelledFlag = afterPlayerCancel.filter((p: any) => p.is_cancelled === true).length;
  console.log(`  rows still in dashboard set with is_absent=true:           ${isAbsentTrue}`);
  console.log(`  rows still in dashboard set with user_is_fake_player=true: ${fakeTrue}`);
  console.log(`  rows still in dashboard set with is_cancelled=true (col):  ${isCancelledFlag}`);
  console.log();

  // Also: dashboard counts duplicates (same user_id × match_start) AS GUESTS.
  // User counts user_type='GUEST' rows directly. They may not match.
  console.log("=== Dashboard's guest detection vs user_type='GUEST' ===");
  const userTypeGuestInBaseline = afterBaseline.filter((p: any) => p.user_type === "GUEST").length;
  const userTypePlayerInBaseline = afterBaseline.filter((p: any) => p.user_type === "PLAYER").length;
  console.log(`  In afterBaseline set: user_type=GUEST=${userTypeGuestInBaseline}, PLAYER=${userTypePlayerInBaseline}`);
  // Group by user_id × match_start to see duplicates
  const groups = new Map<string, any[]>();
  for (const p of afterBaseline) {
    const m = matchById.get(p.match_api_id);
    const key = `${p.user_id}|${(m as any)?.start_date}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }
  let dupGuests = 0;
  for (const arr of groups.values()) dupGuests += arr.length - 1;
  console.log(`  Dashboard's "guests" = sum(group_size - 1) over (user_id, match_start) = ${dupGuests}`);
  console.log(`  Dashboard's "MatchDay players" = group count = ${groups.size}`);
  console.log(`  Dashboard's "Total spots" = group count + dups = ${groups.size + dupGuests}`);
  console.log();

  console.log("=== SUMMARY ===");
  console.log(`  USER total spots (Mar 1 – May 6, is_absent=F, is_cancelled=F, fake=F):        874 (per user)`);
  console.log(`  DASHBOARD total spots (Mar 31 baseline, no is_absent / fake filters):         ${afterBaseline.length}`);
  console.log(`  → dashboard "Total Spots Filled" UI value (mdPlayers + dups):                 ${groups.size + dupGuests}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
