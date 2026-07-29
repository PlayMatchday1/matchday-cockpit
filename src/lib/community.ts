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
  return `Hey everyone! 👋🏻 Want to stay up to date with games, discounts and community updates? ⚽🔥 Don't miss out! Join our ${cityDisplayName} WhatsApp Community! 💪👇`;
}

// A saved invite must be a chat.whatsapp.com group-invite link with a code.
export function isValidWhatsAppInviteUrl(url: string | null | undefined): boolean {
  return canonicalWhatsAppInviteUrl(url) != null;
}

// Canonicalize an invite link to https://chat.whatsapp.com/<code> — dropping
// WhatsApp's own share-tracking query params (?s=…&p=…) and any fragment. Same
// destination, shorter, fewer characters for a linkifier to trip on. Returns
// null if it isn't a valid chat.whatsapp.com invite. We store the canonical
// form, so every city's URL is normalized on save.
export function canonicalWhatsAppInviteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname !== "chat.whatsapp.com") return null;
  // Invite code is the first path segment; drop everything else (query, hash,
  // any trailing path).
  const code = u.pathname.replace(/^\/+/, "").split("/")[0];
  if (code.length < 6) return null;
  return `https://chat.whatsapp.com/${code}`;
}

// ---------------------------------------------------------------------------
// Eligibility classification (pure)
// ---------------------------------------------------------------------------

// A row of city_community_links (the per-CITY table), now just the city shell:
// the display_name + the canonical city_code list that city_communities hangs
// off. The invite URL lives on city_communities; this type no longer carries
// whatsapp_url so there's a single routing source of truth.
export type CommunityCityLinkRow = {
  city_code: string;
  display_name: string;
  active: boolean;
  activated_at: string | null;
};

// A community within a city — the new posting grain. name is what's
// interpolated into the copy line and shown on the tab. activated_at is the
// per-community floor (stamped on each inactive→active flip): a match is only
// invited if it ended at/after it, so activating posts only future finished
// matches, never the trailing 24h. COMMUNITY_START_POSTING_AFTER is the global
// floor.
export type Community = {
  id: number;
  city_code: string;
  name: string;
  whatsapp_url: string | null;
  active: boolean;
  activated_at: string | null;
};

// The two lookups the resolver needs. byField: field_id → its community (from
// community_field_map). byCity: city_code → all communities in that city
// (drives the single-community fallback + the two-or-more field_unassigned
// rule). Both are built once per run in communityData.ts.
export type CommunityMaps = {
  byField: Map<number, Community>;
  byCity: Map<string, Community[]>;
};

export type CommunityMatch = {
  api_id: number;
  end_date_utc: string | null;
  is_cancelled: boolean | null;
  player_count: number | null;
  min_player_count: number | null;
  cityCode: string | null; // normalizeCityName(match city) — resolved by caller
  fieldId: number | null; // mdapi_matches.field_id — the resolution key
};

export type CommunitySkipReason =
  | "before_cutoff" // ended before START_POSTING_AFTER
  | "outside_lookback" // ended > lookback ago, or in the future
  | "cancelled" // is_cancelled
  | "below_minimum" // player_count < min_player_count (didn't really run)
  | "unknown_city" // couldn't resolve a canonical city code
  | "city_not_configured" // city has no communities at all
  | "field_unassigned" // field has no map row AND the city has ≥2 communities
  | "city_no_url" // resolved community has no whatsapp_url
  | "city_inactive" // resolved community exists, url set, but active=false
  | "before_activation" // ended before the community's activated_at (or unset)
  | "already_posted"; // audit row already exists for this api_id

export type CommunityDecision = {
  apiId: number;
  cityCode: string | null;
  communityId: number | null;
  communityName: string | null;
  // Kept for wire-compat: the display name interpolated into the copy — now the
  // COMMUNITY name (== city display name for single-community cities, so the
  // five active cities are unchanged).
  displayName: string | null;
  endDateUtc: string | null;
  wouldPost: boolean;
  reason: CommunitySkipReason | "eligible";
  copyText: string | null;
  urlText: string | null;
};

// Resolve a match's destination community. THE resolution rule (Phase 1):
//   1. field_id → community_field_map → community. If found, that's it.
//   2. Not found: count the city's communities.
//        exactly one → that community (keeps single-community cities working
//                      and keeps a brand-new venue posting, not going dark).
//        two or more → field_unassigned (do NOT post; must be surfaced).
// URL / active / activation are checked by the caller against the returned
// community, so they read exactly as the per-city checks did before.
export type CommunityResolution =
  | { kind: "community"; community: Community }
  | { kind: "unknown_city" }
  | { kind: "city_not_configured" }
  | { kind: "field_unassigned" };

export function resolveCommunity(
  m: { fieldId: number | null; cityCode: string | null },
  maps: CommunityMaps,
): CommunityResolution {
  if (m.fieldId != null) {
    const c = maps.byField.get(m.fieldId);
    if (c) return { kind: "community", community: c };
  }
  if (!m.cityCode) return { kind: "unknown_city" };
  const list = maps.byCity.get(m.cityCode) ?? [];
  if (list.length === 0) return { kind: "city_not_configured" };
  if (list.length === 1) return { kind: "community", community: list[0] };
  return { kind: "field_unassigned" };
}

// Classify ONE candidate. Ignores the global kill switch — that's applied by
// the caller (real run posts only if the switch is on AND wouldPost). This
// keeps the dry-run able to preview "what would post if enabled".
export function classifyCommunityMatch(
  m: CommunityMatch,
  maps: CommunityMaps,
  ctx: { nowMs: number; cutoffMs: number; lookbackHours: number; alreadyPosted: Set<number> },
): CommunityDecision {
  const r = resolveCommunity(m, maps);
  const community = r.kind === "community" ? r.community : null;
  const displayName = community?.name ?? null;
  const copyText = displayName ? communityMessageText(displayName) : null;
  const urlText = community?.whatsapp_url ?? null;
  const base = {
    apiId: m.api_id,
    cityCode: m.cityCode,
    communityId: community?.id ?? null,
    communityName: displayName,
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

  // Destination resolution (order: any config problem is surfaced, never silent).
  if (r.kind === "unknown_city") return skip("unknown_city");
  if (r.kind === "city_not_configured") return skip("city_not_configured");
  if (r.kind === "field_unassigned") return skip("field_unassigned");

  // community is non-null from here.
  if (!urlText || !urlText.trim()) return skip("city_no_url");
  if (!community!.active) return skip("city_inactive");

  // Per-community floor: never post a match that ended before this community
  // was activated (fails safe if activated_at is somehow unset on an active one).
  const activatedMs = community!.activated_at ? Date.parse(community!.activated_at) : NaN;
  if (Number.isNaN(activatedMs) || endMs < activatedMs) return skip("before_activation");

  return { ...base, wouldPost: true, reason: "eligible" };
}

export function classifyCommunityMatches(
  matches: CommunityMatch[],
  maps: CommunityMaps,
  ctx: { nowMs: number; cutoffMs: number; lookbackHours: number; alreadyPosted: Set<number> },
): CommunityDecision[] {
  return matches.map((m) => classifyCommunityMatch(m, maps, ctx));
}
