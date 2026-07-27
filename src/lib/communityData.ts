// Server-only IO for the Community invite poster: load config/settings, load
// recently-finished matches (with their canonical city code resolved), post
// the invite via the SHARED two-message writer, and maintain the heartbeat.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCityName } from "@/lib/cityNormalization";
import { postMessagePairBatch } from "@/lib/messagePairPost";
import {
  communityMessageText,
  type CommunityCityLink,
  type CommunityMatch,
} from "@/lib/community";

export type CommunitySettings = {
  posting_enabled: boolean;
  last_attempted_at: string | null;
  last_success_at: string | null;
  last_status: number | null;
  last_error: string | null;
};

export async function loadCityLinks(
  supabase: SupabaseClient,
): Promise<Map<string, CommunityCityLink>> {
  const res = await supabase
    .from("city_community_links")
    .select("city_code, display_name, whatsapp_url, active");
  if (res.error) throw new Error(`city_community_links query failed: ${res.error.message}`);
  const map = new Map<string, CommunityCityLink>();
  for (const r of res.data ?? []) {
    map.set(r.city_code as string, {
      city_code: r.city_code as string,
      display_name: r.display_name as string,
      whatsapp_url: (r.whatsapp_url as string | null) ?? null,
      active: r.active === true,
    });
  }
  return map;
}

export async function loadCommunitySettings(
  supabase: SupabaseClient,
): Promise<CommunitySettings> {
  const res = await supabase
    .from("community_settings")
    .select("posting_enabled, last_attempted_at, last_success_at, last_status, last_error")
    .eq("id", 1)
    .maybeSingle();
  if (res.error) throw new Error(`community_settings query failed: ${res.error.message}`);
  const d = res.data;
  return {
    posting_enabled: d?.posting_enabled === true,
    last_attempted_at: (d?.last_attempted_at as string | null) ?? null,
    last_success_at: (d?.last_success_at as string | null) ?? null,
    last_status: (d?.last_status as number | null) ?? null,
    last_error: (d?.last_error as string | null) ?? null,
  };
}

type RawMatchRow = {
  api_id: number;
  end_date_utc: string | null;
  is_cancelled: boolean | null;
  player_count: number | null;
  min_player_count: number | null;
  city_identifier: string | null;
  raw: { field?: { city?: { name?: string | null } | null } | null } | null;
};

// Matches whose scheduled END (true UTC instant) is in [sinceIso, untilIso],
// not soft-deleted. City code resolved via normalizeCityName from
// raw.field.city.name first, then city_identifier — same as the discrepancy
// join. NOTE: we filter on end_date_utc (the real instant), never end_date
// (venue-local wall clock at a fake offset).
export async function loadRecentlyFinishedMatches(
  supabase: SupabaseClient,
  sinceIso: string,
  untilIso: string,
): Promise<CommunityMatch[]> {
  const res = await supabase
    .from("mdapi_matches")
    .select(
      "api_id, end_date_utc, is_cancelled, player_count, min_player_count, city_identifier, raw",
    )
    .is("deleted_at", null)
    .gte("end_date_utc", sinceIso)
    .lte("end_date_utc", untilIso);
  if (res.error) throw new Error(`mdapi_matches query failed: ${res.error.message}`);
  return (res.data ?? []).map((m: RawMatchRow) => ({
    api_id: m.api_id,
    end_date_utc: m.end_date_utc,
    is_cancelled: m.is_cancelled,
    player_count: m.player_count,
    min_player_count: m.min_player_count,
    cityCode: normalizeCityName(m.raw?.field?.city?.name ?? m.city_identifier),
  }));
}

export async function loadAlreadyPosted(
  supabase: SupabaseClient,
  apiIds: number[],
): Promise<Set<number>> {
  if (apiIds.length === 0) return new Set();
  const res = await supabase
    .from("community_posts")
    .select("match_api_id")
    .in("match_api_id", apiIds);
  if (res.error) throw new Error(`community_posts query failed: ${res.error.message}`);
  return new Set((res.data ?? []).map((r) => r.match_api_id as number));
}

// Post the invite (idempotent 2-message batch) then record the audit row. The
// audit insert is idempotent (UNIQUE match_api_id → 23505 no-op). We record it
// whenever the messages are confirmed in place (fresh or already-committed) so
// a prior crash between commit and audit self-heals on the next run. If the
// batch itself throws (real Firestore failure), it propagates — no audit, and
// the caller counts it as a failure to retry next run.
export async function postCommunityInvite(
  supabase: SupabaseClient,
  args: { apiId: number; cityCode: string; displayName: string; url: string },
): Promise<{ freshlyPosted: boolean; copyMessageId: string; urlMessageId: string }> {
  const { apiId, cityCode, displayName, url } = args;
  const res = await postMessagePairBatch({
    supabase,
    chatId: String(apiId),
    copyDocId: `community-${apiId}-copy`,
    urlDocId: `community-${apiId}-url`,
    copyText: communityMessageText(displayName),
    urlText: url,
    sentByUserId: null, // automated post
    auditTag: "community:post",
  });

  const ins = await supabase
    .from("community_posts")
    .insert({
      match_api_id: apiId,
      city_code: cityCode,
      display_name: displayName,
      copy_message_id: res.copyMessageId,
      url_message_id: res.urlMessageId,
    })
    .select("id")
    .maybeSingle();
  if (ins.error && ins.error.code !== "23505") {
    console.error(
      `[community:post] audit insert failed match=${apiId} — ${ins.error.code} ${ins.error.message}`,
    );
  }
  return res;
}

export async function markHeartbeatAttempt(supabase: SupabaseClient): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("community_settings").update({ last_attempted_at: now, updated_at: now }).eq("id", 1);
}

export async function markHeartbeatResult(
  supabase: SupabaseClient,
  ok: boolean,
  status: number,
  error?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("community_settings")
    .update(
      ok
        ? { last_success_at: now, last_status: status, last_error: null, updated_at: now }
        : { last_status: status, last_error: error ?? "error", updated_at: now },
    )
    .eq("id", 1);
}

// Posts per city_code in the last 7 days, for the admin readout.
export async function recentPostCountsByCity(
  supabase: SupabaseClient,
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const res = await supabase
    .from("community_posts")
    .select("city_code")
    .gte("posted_at", since);
  const counts: Record<string, number> = {};
  for (const r of res.data ?? []) {
    const c = (r.city_code as string | null) ?? "?";
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}
