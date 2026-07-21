// Manually replicate the post-refactor math to verify the SJD week
// member-rev numbers before pushing. Pulls Q2-wide mdapi data, builds
// the index, and computes member rev for the canary matches.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fetchLegacyMatchRegistrations } from "../src/lib/mdapiMatchesRead";
import {
  buildMdapiMemberSpotIndex,
  matchAllocatedMemberRevenueFor,
  venueAllocatedMemberRevenueFor,
  Q2_MONTHS,
} from "../src/lib/financeStats";
import type { FinanceData } from "../src/lib/useFinanceData";

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
  // Direct probe to confirm tables have rows
  const m1 = await sb
    .from("mdapi_matches")
    .select("api_id, start_date", { count: "exact", head: true })
    .gte("start_date", "2026-04-01")
    .lte("start_date", "2026-06-30");
  console.log(`# mdapi_matches Q2 count (head, lte 06-30): ${m1.count}`);

  const m2 = await sb
    .from("mdapi_matches")
    .select("api_id, start_date", { count: "exact", head: true })
    .gte("start_date", "2026-04-01")
    .lt("start_date", "2026-07-01");
  console.log(`# mdapi_matches Q2 count (head, lt 07-01): ${m2.count}`);

  const m3 = await sb
    .from("mdapi_matches")
    .select("api_id, start_date", { count: "exact", head: true })
    .gte("start_date", "2026-04-27")
    .lte("start_date", "2026-05-04");
  console.log(`# mdapi_matches Apr 27 - May 4 count: ${m3.count}`);

  const m4 = await sb
    .from("mdapi_matches")
    .select("api_id, start_date")
    .gte("start_date", "2026-04-01")
    .lte("start_date", "2026-06-30")
    .limit(3);
  console.log(`# mdapi_matches sample lte:`, m4.data?.length, m4.error);

  // Mimic useFinanceData's load
  const [vnRows, alRows, revRows, regs] = await Promise.all([
    sb.from("fin_venues").select("*").order("id"),
    sb.from("fin_venue_aliases").select("*").order("alias"),
    sb.from("fin_revenue").select("*").order("id"),
    fetchLegacyMatchRegistrations(sb, {
      fromDate: "2026-04-01",
      toDate: "2026-06-30",
    }),
  ]);
  if (vnRows.error) throw vnRows.error;
  if (alRows.error) throw alRows.error;
  if (revRows.error) throw revRows.error;

  const venueAliases = new Map<string, string>();
  for (const a of alRows.data ?? []) {
    if (a.alias && a.canonical_venue) {
      venueAliases.set(a.alias, a.canonical_venue);
    }
  }
  const venues = (vnRows.data ?? []).map((r: any) => {
    const rawName = String(r.venue_name ?? "").trim();
    return {
      id: r.id as number,
      venue_name: venueAliases.get(rawName) ?? rawName,
      raw_venue_name: rawName,
      city: String(r.city ?? "").trim(),
    };
  });

  console.log(`# regs fetched: ${regs.length}`);
  console.log(`# venues fetched: ${venues.length}`);
  const memberRegs = regs.filter(
    (r) => (r.payment_type ?? "").toUpperCase() === "MEMBER",
  );
  console.log(`# regs with payment_type=MEMBER: ${memberRegs.length}`);
  const sjdRegs = memberRegs.filter((r) =>
    r.field?.toLowerCase().includes("juan diego"),
  );
  console.log(`# MEMBER regs at SJD: ${sjdRegs.length}`);
  if (sjdRegs.length > 0) {
    console.log(`  Sample row: field="${sjdRegs[0].field}" match_start=${sjdRegs[0].match_start} match_canceled=${sjdRegs[0].match_canceled} player_canceled_at=${sjdRegs[0].player_canceled_at}`);
  }

  const sjdVenue = venues.find((v) => v.venue_name.toLowerCase().includes("juan diego") || v.raw_venue_name.toLowerCase().includes("juan diego"));
  console.log(`# SJD venue: ${JSON.stringify(sjdVenue)}`);
  console.log();

  const idx = buildMdapiMemberSpotIndex(regs, venues);

  // Build a minimal FinanceData stub for the helpers (only the fields
  // the helpers actually read).
  const data: Partial<FinanceData> = {
    revenue: (revRows.data ?? []).map((r: any) => ({
      id: r.id,
      date: r.date,
      month: r.month,
      city: r.city,
      venue: r.venue,
      type: r.type,
      gross: Number(r.gross ?? 0),
      fees: Number(r.fees ?? 0),
      net: Number(r.net ?? 0),
      source: r.source,
      notes: r.notes,
      manual_entry: !!r.manual_entry,
    })),
    mdapiMemberSpots: idx,
  };

  console.log("# byCityMonth (Austin):");
  for (const month of Q2_MONTHS) {
    const k = `Austin|${month}`;
    console.log(`  ${k} → ${idx.byCityMonth.get(k) ?? 0}`);
  }
  console.log("\n# byVenueMonth Austin SJD:");
  for (const month of Q2_MONTHS) {
    const k = `Austin|San Juan Diego|${month}`;
    console.log(`  ${k} → ${idx.byVenueMonth.get(k) ?? 0}`);
  }

  // Compute per-match memberSpots from the same regs (mirrors matchPnL.ts).
  const memberSpotsByMatch = new Map<string, number>();
  for (const r of regs) {
    if (r.match_canceled) continue;
    if (r.player_canceled_at && r.player_canceled_at.trim() !== "") continue;
    if ((r.payment_type ?? "").toUpperCase() !== "MEMBER") continue;
    if (!r.field?.toLowerCase().includes("juan diego")) continue;
    const k = r.match_start;
    memberSpotsByMatch.set(k, (memberSpotsByMatch.get(k) ?? 0) + 1);
  }

  console.log("\n# Per-match probe — SJD week Apr 27 - May 3 active matches:");
  const sjdMatches = [...new Set(
    regs
      .filter((r) => r.field?.toLowerCase().includes("juan diego"))
      .filter((r) => !r.match_canceled)
      .filter((r) => {
        const d = r.match_start.slice(0, 10);
        return d >= "2026-04-27" && d <= "2026-05-03";
      })
      .map((r) => r.match_start),
  )].sort();

  let weekTotal = 0;
  for (const iso of sjdMatches) {
    const ms = memberSpotsByMatch.get(iso) ?? 0;
    const result = matchAllocatedMemberRevenueFor(data as FinanceData, {
      city: "Austin",
      venueName: "San Juan Diego",
      matchStartIso: iso,
      memberSpots: ms,
    });
    weekTotal += result;
    console.log(`  ${iso}  memberSpots=${String(ms).padStart(2)}  → $${result.toFixed(2)}`);
  }
  console.log(`\n  SJD week Member rev total: $${weekTotal.toFixed(2)}`);

  console.log("\n# Venue-level (Field Ranking) — Austin SJD:");
  for (const month of Q2_MONTHS) {
    const v = venueAllocatedMemberRevenueFor(
      data as FinanceData,
      "Austin",
      "San Juan Diego",
      month,
    );
    console.log(`  ${month} → $${v.toFixed(2)}`);
  }

  // Full Apr 27 - May 3 page summary: total member rev across all
  // active matches in the visible week. Compares old (fin_member_spots
  // path) vs new (mdapi index path).
  console.log("\n# Apr 27 - May 3 page summary — all cities/venues:");
  // Group active-eligible MEMBER regs by (city, venue, match_start);
  // map field → venue same way the helper does.
  const fields = new Set<string>();
  for (const r of regs) if (r.field) fields.add(r.field);
  // Inline the field→venue resolver (same longest-prefix logic the
  // helper uses).
  const fieldToVenue = (() => {
    const map = new Map<string, number>();
    for (const f of fields) {
      const lf = f.toLowerCase();
      let best: { id: number; len: number; raw: string } | null = null;
      for (const v of venues) {
        for (const cand of [v.raw_venue_name, v.venue_name]) {
          const lc = cand.toLowerCase();
          if (!lc || !lf.includes(lc)) continue;
          if (!best || lc.length > best.len || (lc.length === best.len && cand < best.raw)) {
            best = { id: v.id, len: lc.length, raw: cand };
          }
          break;
        }
      }
      if (best) map.set(f, best.id);
    }
    return map;
  })();
  const venueById = new Map(venues.map((v) => [v.id, v]));
  type MK = { city: string; venue: string; iso: string };
  const matchKey = new Map<string, MK & { memberSpots: number }>();
  for (const r of regs) {
    if (r.match_canceled) continue;
    if (r.player_canceled_at && r.player_canceled_at.trim() !== "") continue;
    if ((r.payment_type ?? "").toUpperCase() !== "MEMBER") continue;
    const d = r.match_start.slice(0, 10);
    if (d < "2026-04-27" || d > "2026-05-03") continue;
    const vid = fieldToVenue.get(r.field);
    if (vid == null) continue;
    const v = venueById.get(vid);
    if (!v) continue;
    const k = `${v.city}|${v.venue_name}|${r.match_start}`;
    let b = matchKey.get(k);
    if (!b) {
      b = { city: v.city, venue: v.venue_name, iso: r.match_start, memberSpots: 0 };
      matchKey.set(k, b);
    }
    b.memberSpots += 1;
  }

  let totalApr = 0;
  let totalMay = 0;
  for (const m of matchKey.values()) {
    const v = matchAllocatedMemberRevenueFor(data as FinanceData, {
      city: m.city,
      venueName: m.venue,
      matchStartIso: m.iso,
      memberSpots: m.memberSpots,
    });
    if (m.iso < "2026-05-01") totalApr += v;
    else totalMay += v;
  }
  console.log(`  NEW: Apr portion (Apr 27-30) = $${totalApr.toFixed(2)}`);
  console.log(`  NEW: May portion (May 1-3)   = $${totalMay.toFixed(2)}`);
  console.log(`  NEW: Page summary total      = $${(totalApr + totalMay).toFixed(2)}`);
  console.log(`  OLD (estimate): May portion was $0; Apr was the OLD-formula total.`);
}
main().catch(console.error);
