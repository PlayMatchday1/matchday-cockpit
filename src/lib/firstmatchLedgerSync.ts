// First-match abuse ledger — the scan + upsert pass.
//
// Shared by the one-time backfill script and the daily cron step. Reads
// every is_first_match = true registration in mdapi_match_players,
// captures a readable name + one-way phone/email hashes (see
// ./firstmatchLedger), tags the city from mdapi_matches, and inserts into
// firstmatch_ledger.
//
// INSERT-ONLY (ignoreDuplicates): a ledger row's hashes are write-once.
// This is deliberate and load-bearing — mdapi_match_players is a mutable
// mirror that gets scrubbed to del_<hash>@playmatchday.com / null phone
// when an account is deleted. A blind re-upsert would overwrite a hash we
// captured while the account was live with NULL once it's deleted,
// erasing the exact evidence the ledger exists to keep. Insert-only means
// a row is hashed once, the first time we see it, and never touched again.
// Trade-off: is_cancelled is captured at first sight and not refreshed if
// a claim is cancelled later (clustering is unaffected — it keys on the
// hashes, not the flag).
//
// Scope: is_first_match = true ONLY (promocode_id intentionally ignored —
// it is null on most claims and split across three 'firstmatch' catalog
// records). Cancelled claims are included; is_cancelled is carried so the
// review view can filter them.

import type { SupabaseClient } from "@supabase/supabase-js";
import { emailHashOrNull, phoneHashOrNull } from "./firstmatchLedger";

const SELECT_PAGE = 1000;
const UPSERT_BATCH = 500;
const CITY_LOOKUP_CHUNK = 300;

type PlayerRow = {
  api_id: number;
  user_id: number;
  user_first_name: string | null;
  user_last_name: string | null;
  user_email: string | null;
  user_phone_number: string | null;
  created_at: string | null;
  synced_at: string;
  match_api_id: number;
  is_cancelled: boolean | null;
};

type LedgerRow = {
  player_api_id: number;
  user_id: number;
  display_name: string | null;
  phone_hash: string | null;
  email_hash: string | null;
  claim_date: string;
  city_identifier: string | null;
  match_api_id: number;
  is_cancelled: boolean;
  is_unrecoverable: boolean;
  source: "backfill" | "sync";
};

export type FirstmatchLedgerSyncResult = {
  scanned: number; // is_first_match=true rows examined
  cleanHashed: number; // rows with >= 1 real hash
  unrecoverable: number; // rows with no hash (scrubbed / no identity)
  inserted: number; // new ledger rows actually written this run
};

function fullName(first: string | null, last: string | null): string | null {
  const name = [first, last]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0)
    .join(" ");
  return name.length > 0 ? name : null;
}

async function selectAllFirstMatchPlayers(
  supabase: SupabaseClient,
): Promise<PlayerRow[]> {
  const all: PlayerRow[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error } = await supabase
      .from("mdapi_match_players")
      .select(
        "api_id, user_id, user_first_name, user_last_name, user_email, user_phone_number, created_at, synced_at, match_api_id, is_cancelled",
      )
      .eq("is_first_match", true)
      .order("api_id", { ascending: true })
      .range(from, from + SELECT_PAGE - 1);
    if (error) {
      throw new Error(`firstmatch_ledger: player scan failed: ${error.message}`);
    }
    const rows = (data ?? []) as PlayerRow[];
    all.push(...rows);
    if (rows.length < SELECT_PAGE) break;
  }
  return all;
}

// match_api_id -> city_identifier. mdapi_match_players has no FK to
// mdapi_matches (mirror tables carry no cross-table constraints), so the
// city is resolved with a chunked in() lookup rather than an embed.
async function buildCityMap(
  supabase: SupabaseClient,
  matchIds: number[],
): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>();
  const unique = [...new Set(matchIds)];
  for (let i = 0; i < unique.length; i += CITY_LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + CITY_LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from("mdapi_matches")
      .select("api_id, city_identifier")
      .in("api_id", chunk);
    if (error) {
      throw new Error(`firstmatch_ledger: city lookup failed: ${error.message}`);
    }
    for (const m of (data ?? []) as { api_id: number; city_identifier: string | null }[]) {
      map.set(m.api_id, m.city_identifier ?? null);
    }
  }
  return map;
}

export async function syncFirstmatchLedger(
  supabase: SupabaseClient,
  source: "backfill" | "sync",
): Promise<FirstmatchLedgerSyncResult> {
  const players = await selectAllFirstMatchPlayers(supabase);
  const cityMap = await buildCityMap(
    supabase,
    players.map((p) => p.match_api_id),
  );

  let cleanHashed = 0;
  let unrecoverable = 0;
  const rows: LedgerRow[] = players.map((p) => {
    const emailHash = emailHashOrNull(p.user_email);
    const phoneHash = phoneHashOrNull(p.user_phone_number);
    const isUnrecoverable = emailHash === null && phoneHash === null;
    if (isUnrecoverable) unrecoverable++;
    else cleanHashed++;
    return {
      player_api_id: p.api_id,
      user_id: p.user_id,
      display_name: fullName(p.user_first_name, p.user_last_name),
      phone_hash: phoneHash,
      email_hash: emailHash,
      claim_date: p.created_at ?? p.synced_at,
      city_identifier: cityMap.get(p.match_api_id) ?? null,
      match_api_id: p.match_api_id,
      is_cancelled: p.is_cancelled === true,
      is_unrecoverable: isUnrecoverable,
      source,
    };
  });

  // Insert-only: existing player_api_id rows are left untouched so their
  // first-captured hashes are immutable. .select() after a DO NOTHING
  // upsert returns only the rows actually inserted, giving an accurate
  // new-row count.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const chunk = rows.slice(i, i + UPSERT_BATCH);
    const { data, error } = await supabase
      .from("firstmatch_ledger")
      .upsert(chunk, { onConflict: "player_api_id", ignoreDuplicates: true })
      .select("player_api_id");
    if (error) {
      throw new Error(
        `firstmatch_ledger: upsert failed at offset ${i}: ${error.message}`,
      );
    }
    inserted += (data ?? []).length;
  }

  return { scanned: players.length, cleanHashed, unrecoverable, inserted };
}
