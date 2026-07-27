// Community WhatsApp invite auto-poster: pure logic + config. No server-only
// imports so every guard is unit-testable. The DB/Firestore side lives in
// src/lib/communityData.ts and the route handler.
//
// Once a match finishes we post TWO messages into its chat: a shared copy line
// (city name interpolated) and, as its OWN message, that city's WhatsApp invite
// URL (bare, so the players' app linkifies it). Cities are keyed by the
// canonical short code from normalizeCityName (STL, ATX, …) — the same key
// mdapi_matches.city_identifier uses — never a free-text city string.

// Hard cutoff — never post to a match that ended before this instant. Set to
// the deploy date; this is what stops the first run from posting into every
// historical match chat. Overridable via env for staging. (Guard #2.)
export const COMMUNITY_START_POSTING_AFTER =
  process.env.COMMUNITY_START_POSTING_AFTER ?? "2026-07-26T00:00:00Z";

// Lookback window (Guard #1). 24h, not 6: the audit table's UNIQUE(api_id) +
// the cutoff make repeat/backfill impossible, so a wider window only buys
// self-healing — a match still gets its invite on the next successful run if
// the scheduler/endpoint was down for a few hours.
export const COMMUNITY_LOOKBACK_HOURS = 24;

// The copy line posted immediately BEFORE the bare invite URL. Shared across
// all cities — only {CITY} (display name) and the URL vary. Single place to
// edit the wording (mirrors veoMessageText()).
export function communityMessageText(cityDisplayName: string): string {
  return `Hey everyone! 👋🏻 Want to stay up to date with games, discounts and community updates? ⚽🔥  Don't miss out! Join our ${cityDisplayName} WhatsApp Community! 💪👇`;
}

// A saved invite must be a chat.whatsapp.com group-invite link with a code.
export function isValidWhatsAppInviteUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname !== "chat.whatsapp.com") return false;
  // Path must carry an invite code, e.g. /JKCdpXGeqziHTMzYLPFh8e
  const code = u.pathname.replace(/^\/+/, "");
  return code.length >= 6;
}

// ---------------------------------------------------------------------------
// Eligibility classification (pure)
// ---------------------------------------------------------------------------

export type CommunityCityLink = {
  city_code: string;
  display_name: string;
  whatsapp_url: string | null;
  active: boolean;
  // Set to now() on every inactive→active transition. A match is only invited
  // if it ended at/after this — so activating a city posts only its FUTURE
  // finished matches, never the trailing 24h of the lookback window. This is
  // the per-city floor; COMMUNITY_START_POSTING_AFTER is the global floor.
  activated_at: string | null;
};

export type CommunityMatch = {
  api_id: number;
  end_date_utc: string | null;
  is_cancelled: boolean | null;
  player_count: number | null;
  min_player_count: number | null;
  cityCode: string | null; // normalizeCityName(match city) — resolved by caller
};

export type CommunitySkipReason =
  | "before_cutoff" // ended before START_POSTING_AFTER
  | "outside_lookback" // ended > lookback ago, or in the future
  | "cancelled" // is_cancelled
  | "below_minimum" // player_count < min_player_count (didn't really run)
  | "unknown_city" // couldn't resolve a canonical city code
  | "city_not_configured" // no city_community_links row
  | "city_no_url" // row exists but whatsapp_url is null/blank
  | "city_inactive" // row exists, url set, but active=false
  | "before_activation" // ended before this city's activated_at (or it's unset)
  | "already_posted"; // audit row already exists for this api_id

export type CommunityDecision = {
  apiId: number;
  cityCode: string | null;
  displayName: string | null;
  endDateUtc: string | null;
  wouldPost: boolean;
  reason: CommunitySkipReason | "eligible";
  // Message bodies for the dry-run preview. copyText is present whenever a
  // display name is known; urlText whenever the city has a url on file.
  copyText: string | null;
  urlText: string | null;
};

// Classify ONE candidate. Ignores the global kill switch — that's applied by
// the caller (real run posts only if the switch is on AND wouldPost). This
// keeps the dry-run able to preview "what would post if enabled".
export function classifyCommunityMatch(
  m: CommunityMatch,
  links: Map<string, CommunityCityLink>,
  ctx: { nowMs: number; cutoffMs: number; lookbackHours: number; alreadyPosted: Set<number> },
): CommunityDecision {
  const link = m.cityCode ? links.get(m.cityCode) : undefined;
  const displayName = link?.display_name ?? null;
  const copyText = displayName ? communityMessageText(displayName) : null;
  const urlText = link?.whatsapp_url ?? null;
  const base = {
    apiId: m.api_id,
    cityCode: m.cityCode,
    displayName,
    endDateUtc: m.end_date_utc,
    copyText,
    urlText,
  };
  const skip = (reason: CommunitySkipReason): CommunityDecision => ({
    ...base,
    wouldPost: false,
    reason,
  });

  if (ctx.alreadyPosted.has(m.api_id)) return skip("already_posted");

  const endMs = m.end_date_utc ? Date.parse(m.end_date_utc) : NaN;
  if (Number.isNaN(endMs)) return skip("outside_lookback");
  // Within the last `lookbackHours`, and not in the future.
  if (endMs > ctx.nowMs || endMs < ctx.nowMs - ctx.lookbackHours * 3_600_000) {
    return skip("outside_lookback");
  }
  if (endMs < ctx.cutoffMs) return skip("before_cutoff");

  if (m.is_cancelled === true) return skip("cancelled");
  // Didn't actually run: fewer players than the match's minimum. Only applied
  // when both counts are present (min is occasionally null in mdapi).
  if (
    m.min_player_count != null &&
    m.player_count != null &&
    m.player_count < m.min_player_count
  ) {
    return skip("below_minimum");
  }

  if (!m.cityCode) return skip("unknown_city");
  if (!link) return skip("city_not_configured");
  if (!urlText || !urlText.trim()) return skip("city_no_url");
  if (!link.active) return skip("city_inactive");

  // Per-city floor: never post a match that ended before this city was
  // activated (fails safe if activated_at is somehow unset on an active city).
  const activatedMs = link.activated_at ? Date.parse(link.activated_at) : NaN;
  if (Number.isNaN(activatedMs) || endMs < activatedMs) return skip("before_activation");

  return { ...base, wouldPost: true, reason: "eligible" };
}

export function classifyCommunityMatches(
  matches: CommunityMatch[],
  links: Map<string, CommunityCityLink>,
  ctx: { nowMs: number; cutoffMs: number; lookbackHours: number; alreadyPosted: Set<number> },
): CommunityDecision[] {
  return matches.map((m) => classifyCommunityMatch(m, links, ctx));
}
