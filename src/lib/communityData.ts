// Server-only IO for the Community invite poster: load config/settings, load
// recently-finished matches (with their canonical city code resolved), post
// the invite via the SHARED two-message writer, and maintain the heartbeat.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCityName } from "@/lib/cityNormalization";
import { postMessagePairBatch } from "@/lib/messagePairPost";
import {
  communityMessageText,
  type Community,
  type CommunityMaps,
  type CommunityCityLinkRow,
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
): Promise<Map<string, CommunityCityLinkRow>> {
  // Only the city SHELL is read now (code + display_name). The invite URL /
  // active state moved to city_communities — the poster and the admin tab read
  // it there, so city_community_links.whatsapp_url is no longer selected here
  // (it stays in the table, just unused, so there's one source of truth).
  const res = await supabase
    .from("city_community_links")
    .select("city_code, display_name, active, activated_at");
  if (res.error) throw new Error(`city_community_links query failed: ${res.error.message}`);
  const map = new Map<string, CommunityCityLinkRow>();
  for (const r of res.data ?? []) {
    map.set(r.city_code as string, {
      city_code: r.city_code as string,
      display_name: r.display_name as string,
      active: r.active === true,
      activated_at: (r.activated_at as string | null) ?? null,
    });
  }
  return map;
}

// All communities (the new grain). Returned both as a flat list (admin) and as
// the poster's resolution maps.
export async function loadCommunitiesRaw(
  supabase: SupabaseClient,
): Promise<Community[]> {
  const res = await supabase
    .from("city_communities")
    .select("id, city_code, name, whatsapp_url, active, activated_at");
  if (res.error) throw new Error(`city_communities query failed: ${res.error.message}`);
  return (res.data ?? []).map((r) => ({
    id: r.id as number,
    city_code: r.city_code as string,
    name: r.name as string,
    whatsapp_url: (r.whatsapp_url as string | null) ?? null,
    active: r.active === true,
    activated_at: (r.activated_at as string | null) ?? null,
  }));
}

// field_id → community_id (community_field_map).
export async function loadFieldMap(
  supabase: SupabaseClient,
): Promise<Map<number, number>> {
  const res = await supabase.from("community_field_map").select("field_id, community_id");
  if (res.error) throw new Error(`community_field_map query failed: ${res.error.message}`);
  const map = new Map<number, number>();
  for (const r of res.data ?? []) map.set(r.field_id as number, r.community_id as number);
  return map;
}

// Build the poster's resolution maps: byField (field_id → community) and
// byCity (city_code → communities[]). One query pair per run.
export async function loadCommunityMaps(
  supabase: SupabaseClient,
): Promise<CommunityMaps> {
  const [communities, fieldMap] = await Promise.all([
    loadCommunitiesRaw(supabase),
    loadFieldMap(supabase),
  ]);
  const byId = new Map<number, Community>();
  const byCity = new Map<string, Community[]>();
  for (const c of communities) {
    byId.set(c.id, c);
    const arr = byCity.get(c.city_code);
    if (arr) arr.push(c);
    else byCity.set(c.city_code, [c]);
  }
  const byField = new Map<number, Community>();
  for (const [fieldId, communityId] of fieldMap) {
    const c = byId.get(communityId);
    if (c) byField.set(fieldId, c);
  }
  return { byField, byCity };
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
  field_id: number | null;
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
      "api_id, end_date_utc, is_cancelled, player_count, min_player_count, city_identifier, field_id, raw",
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
    fieldId: m.field_id,
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
  args: {
    apiId: number;
    cityCode: string;
    displayName: string;
    url: string;
    // Informational attribution only — NOT part of any dedupe key. The two
    // Firestore doc ids and the community_posts UNIQUE(match_api_id) below are
    // still keyed purely on apiId, so a re-grained city→community mapping can
    // never re-post an already-posted match.
    communityId: number | null;
  },
): Promise<{ freshlyPosted: boolean; copyMessageId: string; urlMessageId: string }> {
  const { apiId, cityCode, displayName, url, communityId } = args;
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
      community_id: communityId,
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

// Cities that had matches in the last 30 days (by canonical code), with a
// display name + count. Used to surface new/idle markets on the admin tab:
// a market with recent matches but no row (or no url) needs setup. Uses
// start_date_utc (true instant) — a light query (no raw jsonb).
export async function matchCitiesLast30d(
  supabase: SupabaseClient,
): Promise<Map<string, { count: number; displayName: string }>> {
  const since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  const res = await supabase
    .from("mdapi_matches")
    .select("city_identifier, city_name")
    .is("deleted_at", null)
    .gte("start_date_utc", since);
  const map = new Map<string, { count: number; displayName: string }>();
  for (const r of res.data ?? []) {
    const code = normalizeCityName((r.city_name as string | null) ?? (r.city_identifier as string | null));
    if (!code) continue;
    const cur = map.get(code) ?? { count: 0, displayName: (r.city_name as string | null) ?? code };
    cur.count++;
    map.set(code, cur);
  }
  return map;
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

// "Posts · 7d" per COMMUNITY (community_id), plus a per-city tally of rows that
// have no community_id (historical posts predating the split) — those render
// under the city, not attributed to any single community.
export async function recentPostCountsByCommunity(
  supabase: SupabaseClient,
): Promise<{ byCommunity: Record<number, number>; nullByCity: Record<string, number> }> {
  const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const res = await supabase
    .from("community_posts")
    .select("community_id, city_code")
    .gte("posted_at", since);
  const byCommunity: Record<number, number> = {};
  const nullByCity: Record<string, number> = {};
  for (const r of res.data ?? []) {
    const cid = r.community_id as number | null;
    if (cid != null) byCommunity[cid] = (byCommunity[cid] ?? 0) + 1;
    else {
      const c = (r.city_code as string | null) ?? "?";
      nullByCity[c] = (nullByCity[c] ?? 0) + 1;
    }
  }
  return { byCommunity, nullByCity };
}

export type FieldInventoryRow = {
  field_id: number;
  field_title: string | null;
  matches_30d: number;
  matches_90d: number;
};

// Every field with a PAST match in the last 90d, grouped by canonical city
// code, with 30d/90d counts. Drives the admin "fields in this city" selector
// and the unassigned-field warning. Read-only; uses start_date_utc (true
// instant) and never touches mdapi_* for writes.
export async function fieldInventoryByCity(
  supabase: SupabaseClient,
): Promise<Map<string, FieldInventoryRow[]>> {
  const now = Date.now();
  const since90 = new Date(now - 90 * 24 * 3_600_000).toISOString();
  const since30ms = now - 30 * 24 * 3_600_000;
  const nowIso = new Date(now).toISOString();
  const rows: {
    field_id: number | null;
    field_title: string | null;
    city_identifier: string | null;
    city_name: string | null;
    start_date_utc: string | null;
  }[] = [];
  let from = 0;
  while (from < 300_000) {
    const res = await supabase
      .from("mdapi_matches")
      .select("field_id, field_title, city_identifier, city_name, start_date_utc")
      .is("deleted_at", null)
      .gte("start_date_utc", since90)
      .lte("start_date_utc", nowIso)
      .range(from, from + 999);
    if (res.error) throw new Error(`field inventory query failed: ${res.error.message}`);
    const page = (res.data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }
  const byCity = new Map<string, Map<number, FieldInventoryRow>>();
  for (const m of rows) {
    if (m.field_id == null) continue;
    const code = normalizeCityName(m.city_name ?? m.city_identifier);
    if (!code) continue;
    let cm = byCity.get(code);
    if (!cm) {
      cm = new Map();
      byCity.set(code, cm);
    }
    let e = cm.get(m.field_id);
    if (!e) {
      e = { field_id: m.field_id, field_title: m.field_title, matches_30d: 0, matches_90d: 0 };
      cm.set(m.field_id, e);
    }
    e.matches_90d++;
    if (m.start_date_utc && Date.parse(m.start_date_utc) >= since30ms) e.matches_30d++;
    if (!e.field_title && m.field_title) e.field_title = m.field_title;
  }
  const out = new Map<string, FieldInventoryRow[]>();
  for (const [code, cm] of byCity) {
    out.set(
      code,
      [...cm.values()].sort((a, b) => b.matches_30d - a.matches_30d || b.matches_90d - a.matches_90d),
    );
  }
  return out;
}
