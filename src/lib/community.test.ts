// Run: `npm test` (or `node --test src/lib/community.test.ts`). Pure logic only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWhatsAppInviteUrl,
  classifyCommunityMatch,
  communityMessageText,
  isValidWhatsAppInviteUrl,
  type CommunityCityLink,
  type CommunityMatch,
} from "./community.ts";

// ----------------------------- copy -----------------------------

test("communityMessageText: exact shared copy with the city interpolated (single space after 🔥)", () => {
  assert.equal(
    communityMessageText("St. Louis"),
    "Hey everyone! 👋🏻 Want to stay up to date with games, discounts and community updates? ⚽🔥 Don't miss out! Join our St. Louis WhatsApp Community! 💪👇",
  );
  assert.equal(communityMessageText("St. Louis").includes("🔥  Don't"), false); // no double space
  // Only the city name varies.
  assert.match(communityMessageText("Houston"), /Join our Houston WhatsApp Community/);
});

// ------------------------- url validation + canonicalization -------------------------

test("canonicalWhatsAppInviteUrl: strips tracking query, keeps the invite code", () => {
  assert.equal(
    canonicalWhatsAppInviteUrl("https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e?s=cl&p=i&ilr=1&amv=0"),
    "https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e",
  );
  // Already canonical → unchanged; fragment also dropped.
  assert.equal(
    canonicalWhatsAppInviteUrl("https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e#x"),
    "https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e",
  );
  assert.equal(canonicalWhatsAppInviteUrl("https://chat.whatsapp.com/AB"), null); // too short
  assert.equal(canonicalWhatsAppInviteUrl("http://chat.whatsapp.com/JKCdpXGeqziHTMzYL"), null); // not https
  assert.equal(canonicalWhatsAppInviteUrl("https://whatsapp.com/JKCdpXGeqziHTMzYL"), null); // wrong host
  assert.equal(canonicalWhatsAppInviteUrl("https://chat.whatsapp.com.evil.com/JKCdpXGeqziH"), null);
  assert.equal(canonicalWhatsAppInviteUrl("not a url"), null);
  assert.equal(canonicalWhatsAppInviteUrl(null), null);
});

test("isValidWhatsAppInviteUrl: true iff canonicalizable", () => {
  assert.equal(isValidWhatsAppInviteUrl("https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e?s=cl"), true);
  assert.equal(isValidWhatsAppInviteUrl("https://example.com/abc"), false);
});

// --------------------------- guards ---------------------------

const NOW = Date.parse("2026-07-26T12:00:00Z");
const CUTOFF = Date.parse("2026-07-26T00:00:00Z");
const CTX = { nowMs: NOW, cutoffMs: CUTOFF, lookbackHours: 24, alreadyPosted: new Set<number>([999]) };

const LINKS = new Map<string, CommunityCityLink>([
  ["STL", { city_code: "STL", display_name: "St. Louis", whatsapp_url: "https://chat.whatsapp.com/abc123def", active: true, activated_at: "2026-07-26T00:00:00Z" }],
  ["HOU", { city_code: "HOU", display_name: "Houston", whatsapp_url: null, active: false, activated_at: null }],
  ["ATL", { city_code: "ATL", display_name: "Atlanta", whatsapp_url: "https://chat.whatsapp.com/xyz789ghi", active: false, activated_at: null }],
  ["SATX", { city_code: "SATX", display_name: "San Antonio", whatsapp_url: "https://chat.whatsapp.com/satx12345", active: true, activated_at: "2026-07-26T11:00:00Z" }],
]);

function m(over: Partial<CommunityMatch>): CommunityMatch {
  return {
    api_id: 1,
    end_date_utc: "2026-07-26T10:00:00Z", // within 24h, after cutoff
    is_cancelled: false,
    player_count: 12,
    min_player_count: 6,
    cityCode: "STL",
    ...over,
  };
}

test("classify: eligible STL match → wouldPost with both message bodies", () => {
  const d = classifyCommunityMatch(m({}), LINKS, CTX);
  assert.equal(d.wouldPost, true);
  assert.equal(d.reason, "eligible");
  assert.equal(d.displayName, "St. Louis");
  assert.equal(d.copyText, communityMessageText("St. Louis"));
  assert.equal(d.urlText, "https://chat.whatsapp.com/abc123def");
});

test("classify: already-posted api_id → skip (idempotency fast path)", () => {
  assert.equal(classifyCommunityMatch(m({ api_id: 999 }), LINKS, CTX).reason, "already_posted");
});

test("classify: before the hard cutoff → skip (no backfill)", () => {
  const d = classifyCommunityMatch(m({ end_date_utc: "2026-07-25T23:00:00Z" }), LINKS, CTX);
  assert.equal(d.reason, "before_cutoff");
  assert.equal(d.wouldPost, false);
});

test("classify: outside the lookback window (too old OR future) → skip", () => {
  assert.equal(classifyCommunityMatch(m({ end_date_utc: "2026-07-25T06:00:00Z" }), LINKS, CTX).reason, "outside_lookback");
  assert.equal(classifyCommunityMatch(m({ end_date_utc: "2026-07-26T18:00:00Z" }), LINKS, CTX).reason, "outside_lookback");
});

test("classify: cancelled and below-minimum matches → skip", () => {
  assert.equal(classifyCommunityMatch(m({ is_cancelled: true }), LINKS, CTX).reason, "cancelled");
  assert.equal(classifyCommunityMatch(m({ player_count: 3, min_player_count: 6 }), LINKS, CTX).reason, "below_minimum");
  // Null min is not treated as below-minimum.
  assert.equal(classifyCommunityMatch(m({ player_count: 1, min_player_count: null }), LINKS, CTX).reason, "eligible");
});

test("classify: active city but match ended before its activated_at → skip (no per-city backfill)", () => {
  // SATX activated at 11:00Z; a match that ended 10:00Z (past the global cutoff
  // and inside the 24h lookback) must NOT be backfilled by the activation.
  const before = classifyCommunityMatch(
    m({ cityCode: "SATX", end_date_utc: "2026-07-26T10:00:00Z" }),
    LINKS,
    CTX,
  );
  assert.equal(before.reason, "before_activation");
  assert.equal(before.wouldPost, false);
  // A match that ended AFTER activation is eligible.
  const after = classifyCommunityMatch(
    m({ cityCode: "SATX", end_date_utc: "2026-07-26T11:30:00Z" }),
    LINKS,
    CTX,
  );
  assert.equal(after.reason, "eligible");
});

test("classify: city guards — unknown / not configured / no url / inactive", () => {
  assert.equal(classifyCommunityMatch(m({ cityCode: null }), LINKS, CTX).reason, "unknown_city");
  assert.equal(classifyCommunityMatch(m({ cityCode: "DFW" }), LINKS, CTX).reason, "city_not_configured");
  assert.equal(classifyCommunityMatch(m({ cityCode: "HOU" }), LINKS, CTX).reason, "city_no_url");
  const atl = classifyCommunityMatch(m({ cityCode: "ATL" }), LINKS, CTX);
  assert.equal(atl.reason, "city_inactive");
  assert.equal(atl.wouldPost, false);
  // Dry-run still shows the bodies for an inactive-but-configured city.
  assert.equal(atl.urlText, "https://chat.whatsapp.com/xyz789ghi");
});
