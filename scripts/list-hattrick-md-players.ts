// List the 266 Hattrick MatchDay registrations grouped by player.
// Uses the exact filter chain the dashboard applies post-fix:
//   - field_title ILIKE '%Hattrick%'
//   - match.is_cancelled = false
//   - paid_status != 'WAITING'
//   - is_absent != true
//   - user_is_fake_player != true
//   - canceled_at is null/empty
//   - email NOT containing 'matchday.com' (staff)
//   - match.start_date >= 2026-03-31 (Hattrick baseline)
//   - user_type = 'PLAYER'

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
  // 1. Hattrick matches (no date bound at fetch — match Mar 31 in JS)
  const matches: Array<{
    api_id: number;
    start_date: string;
    is_cancelled: boolean;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("mdapi_matches")
      .select("api_id, start_date, is_cancelled")
      .ilike("field_title", "%Hattrick%")
      .order("api_id")
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    matches.push(...(data as never));
    if (data.length < 1000) break;
  }
  const okMatchIds = new Set(
    matches
      .filter(
        (m) =>
          !m.is_cancelled && String(m.start_date).slice(0, 10) >= "2026-03-31",
      )
      .map((m) => m.api_id),
  );

  // 2. Players for those matches
  const allMatchIds = matches.map((m) => m.api_id);
  const players: Array<{
    user_id: number;
    user_email: string | null;
    user_type: string | null;
    paid_status: string | null;
    is_cancelled: boolean | null;
    canceled_at: string | null;
    is_absent: boolean | null;
    user_is_fake_player: boolean | null;
    match_api_id: number;
  }> = [];
  for (let i = 0; i < allMatchIds.length; i += 200) {
    const chunk = allMatchIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("mdapi_match_players")
        .select(
          "user_id, user_email, user_type, paid_status, is_cancelled, canceled_at, is_absent, user_is_fake_player, match_api_id",
        )
        .in("match_api_id", chunk)
        .order("api_id")
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      players.push(...(data as never));
      if (data.length < 1000) break;
    }
  }

  // 3. Apply the dashboard's filter chain
  const isStaff = (e: string | null) =>
    !!e && e.toLowerCase().includes("matchday.com");

  const eligible = players.filter(
    (p) =>
      okMatchIds.has(p.match_api_id) &&
      p.paid_status !== "WAITING" &&
      p.is_absent !== true &&
      p.user_is_fake_player !== true &&
      (!p.canceled_at || String(p.canceled_at).trim() === "") &&
      !isStaff(p.user_email) &&
      p.user_type === "PLAYER",
  );

  // 4. Group by user_email (fallback to user_id if email is null)
  const counts = new Map<string, { email: string; count: number }>();
  for (const p of eligible) {
    const key = p.user_email
      ? p.user_email.toLowerCase()
      : `(no email) user_id=${p.user_id}`;
    const cur = counts.get(key) ?? {
      email: p.user_email ?? `(no email) user_id=${p.user_id}`,
      count: 0,
    };
    cur.count += 1;
    counts.set(key, cur);
  }

  const sorted = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.email.localeCompare(b.email),
  );

  console.log(`Hattrick MatchDay registrations (user_type='PLAYER'),`);
  console.log(`baseline 2026-03-31, all dashboard filters applied:\n`);

  let total = 0;
  for (const r of sorted) {
    console.log(`  ${String(r.count).padStart(3)}  ${r.email}`);
    total += r.count;
  }
  console.log(`  ${"-".repeat(50)}`);
  console.log(`  ${String(total).padStart(3)}  TOTAL  (${sorted.length} unique players)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
