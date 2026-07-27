// Run: `npm test` (or `node --test src/lib/community.test.ts`). Pure logic only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCommunityMatch,
  communityMessageText,
  isValidWhatsAppInviteUrl,
  type CommunityCityLink,
  type CommunityMatch,
} from "./community.ts";

// ----------------------------- copy -----------------------------

test("communityMessageText: exact shared copy with the city interpolated", () => {
  assert.equal(
    communityMessageText("St. Louis"),
    "Hey everyone! 👋🏻 Want to stay up to date with games, discounts and community updates? ⚽🔥  Don't miss out! Join our St. Louis WhatsApp Community! 💪👇",
  );
  // Only the city name varies.
  assert.match(communityMessageText("Houston"), /Join our Houston WhatsApp Community/);
});

// ------------------------- url validation -------------------------

test("isValidWhatsAppInviteUrl: accepts a chat.whatsapp.com invite, rejects others", () => {
  assert.equal(
    isValidWhatsAppInviteUrl("https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e?s=cl&p=i&ilr=1&amv=0"),
    true,
  );
  assert.equal(isValidWhatsAppInviteUrl("https://chat.whatsapp.com/AB"), false); // code too short
  assert.equal(isValidWhatsAppInviteUrl("http://chat.whatsapp.com/JKCdpXGeqziHTMzYL"), false); // not https
  assert.equal(isValidWhatsAppInviteUrl("https://whatsapp.com/JKCdpXGeqziHTMzYL"), false); // wrong host
  assert.equal(isValidWhatsAppInviteUrl("https://chat.whatsapp.com.evil.com/JKCdpXGeqziH"), false);
  assert.equal(isValidWhatsAppInviteUrl("not a url"), false);
  assert.equal(isValidWhatsAppInviteUrl(null), false);
});

// --------------------------- guards ---------------------------

const NOW = Date.parse("2026-07-26T12:00:00Z");
const CUTOFF = Date.parse("2026-07-26T00:00:00Z");
const CTX = { nowMs: NOW, cutoffMs: CUTOFF, lookbackHours: 24, alreadyPosted: new Set<number>([999]) };

const LINKS = new Map<string, CommunityCityLink>([
  ["STL", { city_code: "STL", display_name: "St. Louis", whatsapp_url: "https://chat.whatsapp.com/abc123def", active: true }],
  ["HOU", { city_code: "HOU", display_name: "Houston", whatsapp_url: null, active: false }],
  ["ATL", { city_code: "ATL", display_name: "Atlanta", whatsapp_url: "https://chat.whatsapp.com/xyz789ghi", active: false }],
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
