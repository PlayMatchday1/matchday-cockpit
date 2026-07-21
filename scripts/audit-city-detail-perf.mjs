// Measures the four candidate Supabase query shapes that
// fetchJoinedMatchPlayers / useMatchData could issue, on real
// production data, with the same chunking + pagination logic the lib
// uses. Reports wall-clock duration and payload byte size so we can
// reason about the city-detail-page slowness without driving Chrome.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const MATCHES_COLS = "api_id, city_identifier, field_title, start_date, is_cancelled";
const PLAYERS_COLS = "api_id, match_api_id, user_id, user_email, user_type, paid_status, promocode_id, is_cancelled, canceled_at, amount, created_at, is_absent, user_is_fake_player";
const PAGE = 1000;
const IN_CHUNK = 200;
const CHUNK_CONCURRENCY = 4;

async function pageAll(builder) {
  const out = [];
  let bytes = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await builder().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    // Rough byte size — JSON.stringify length of the batch
    bytes += JSON.stringify(data).length;
    if (data.length < PAGE) break;
  }
  return { rows: out, bytes };
}

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function timeShape(label, { fromDate, toDate, cityFilter }) {
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();

  // 1. matches
  const tMatches = Date.now();
  const matchesRes = await pageAll(() => {
    let q = sb.from("mdapi_matches").select(MATCHES_COLS);
    if (fromDate) q = q.gte("start_date", fromDate);
    if (toDate) q = q.lte("start_date", toDate);
    if (cityFilter) q = q.eq("city_identifier", cityFilter);
    return q.order("api_id");
  });
  const matchesDur = Date.now() - tMatches;
  const matches = matchesRes.rows;

  // 2. players — chunked IN-list, 4 concurrent
  const tPlayers = Date.now();
  const matchIds = matches.map((m) => m.api_id);
  const chunks = [];
  for (let i = 0; i < matchIds.length; i += IN_CHUNK) {
    chunks.push(matchIds.slice(i, i + IN_CHUNK));
  }
  let playerCount = 0;
  let playerBytes = 0;
  if (matchIds.length > 0) {
    const chunkResults = await mapWithLimit(chunks, CHUNK_CONCURRENCY, async (chunk) => {
      const got = await pageAll(() =>
        sb.from("mdapi_match_players").select(PLAYERS_COLS).in("match_api_id", chunk).order("api_id"),
      );
      return got;
    });
    for (const r of chunkResults) {
      playerCount += r.rows.length;
      playerBytes += r.bytes;
    }
  }
  const playersDur = Date.now() - tPlayers;

  const totalDur = Date.now() - t0;
  const totalBytes = matchesRes.bytes + playerBytes;

  console.log(`  matches: ${matches.length} rows  (${(matchesRes.bytes/1024).toFixed(0)}KB, ${matchesDur}ms)`);
  console.log(`  players: ${playerCount} rows  (${(playerBytes/1024).toFixed(0)}KB, ${playersDur}ms across ${chunks.length} chunks, ${CHUNK_CONCURRENCY} concurrent)`);
  console.log(`  TOTAL:   ${matches.length + playerCount} rows  ${(totalBytes/1024).toFixed(0)}KB  ${totalDur}ms wall-clock`);
  return { matches: matches.length, players: playerCount, kb: totalBytes/1024, ms: totalDur };
}

// 12 weeks back + 14 days forward, ATX/STL the bookend cases for city volume.
const today = new Date();
const fromDate12wk = new Date(today.getTime() - (12 * 7 + 14) * 86400 * 1000).toISOString().slice(0, 10);
const toDate14d = new Date(today.getTime() + 14 * 86400 * 1000).toISOString().slice(0, 10);

const a = await timeShape("Current behavior — unbounded (useMatchData)", {});
const b = await timeShape("Fix 1 — 12-week bounded (useMatchWindowData(12))", { fromDate: fromDate12wk, toDate: toDate14d });
const c = await timeShape("Fix 2 — 12-week + city=ATX",  { fromDate: fromDate12wk, toDate: toDate14d, cityFilter: "ATX"  });
const d = await timeShape("Fix 2 — 12-week + city=STL",  { fromDate: fromDate12wk, toDate: toDate14d, cityFilter: "STL"  });
const e = await timeShape("Fix 2 — 12-week + city=ATL",  { fromDate: fromDate12wk, toDate: toDate14d, cityFilter: "ATL"  });
const f = await timeShape("Fix 2 — 12-week + city=HOU",  { fromDate: fromDate12wk, toDate: toDate14d, cityFilter: "HOU"  });

console.log("\n=== Summary ===");
console.log(`Current (unbounded):         ${a.ms.toString().padStart(5)}ms  ${a.kb.toFixed(0).padStart(5)}KB  ${a.matches + a.players} rows`);
console.log(`Bounded 12wk (network-wide): ${b.ms.toString().padStart(5)}ms  ${b.kb.toFixed(0).padStart(5)}KB  ${b.matches + b.players} rows  (Δ vs cur: ${((1 - b.ms/a.ms)*100).toFixed(0)}% faster, ${((1 - b.kb/a.kb)*100).toFixed(0)}% smaller)`);
console.log(`Bounded 12wk + ATX:          ${c.ms.toString().padStart(5)}ms  ${c.kb.toFixed(0).padStart(5)}KB  ${c.matches + c.players} rows`);
console.log(`Bounded 12wk + STL:          ${d.ms.toString().padStart(5)}ms  ${d.kb.toFixed(0).padStart(5)}KB  ${d.matches + d.players} rows`);
console.log(`Bounded 12wk + ATL:          ${e.ms.toString().padStart(5)}ms  ${e.kb.toFixed(0).padStart(5)}KB  ${e.matches + e.players} rows`);
console.log(`Bounded 12wk + HOU:          ${f.ms.toString().padStart(5)}ms  ${f.kb.toFixed(0).padStart(5)}KB  ${f.matches + f.players} rows`);
