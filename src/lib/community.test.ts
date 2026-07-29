// Run: `npm test` (or `node --test src/lib/community.test.ts`). Pure logic only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWhatsAppInviteUrl,
  classifyCommunityMatch,
  resolveCommunity,
  communityMessageText,
  isValidWhatsAppInviteUrl,
  type Community,
  type CommunityMaps,
  type CommunityMatch,
} from "./community.ts";

// ----------------------------- copy -----------------------------

test("communityMessageText: exact shared copy with the name interpolated (single space after 🔥)", () => {
  assert.equal(
    communityMessageText("St. Louis"),
    "Hey everyone! 👋🏻 Want to stay up to date with games, discounts and community updates? ⚽🔥 Don't miss out! Join our St. Louis WhatsApp Community! 💪👇",
  );
  assert.equal(communityMessageText("St. Louis").includes("🔥  Don't"), false); // no double space
  assert.match(communityMessageText("North Austin"), /Join our North Austin WhatsApp Community/);
});

// ------------------------- url validation + canonicalization -------------------------

test("canonicalWhatsAppInviteUrl: strips tracking query, keeps the invite code", () => {
  assert.equal(
    canonicalWhatsAppInviteUrl("https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e?s=cl&p=i&ilr=1&amv=0"),
    "https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e",
  );
  assert.equal(
    canonicalWhatsAppInviteUrl("https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e#x"),
    "https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e",
  );
  assert.equal(canonicalWhatsAppInviteUrl("https://chat.whatsapp.com/AB"), null);
  assert.equal(canonicalWhatsAppInviteUrl("http://chat.whatsapp.com/JKCdpXGeqziHTMzYL"), null);
  assert.equal(canonicalWhatsAppInviteUrl("https://whatsapp.com/JKCdpXGeqziHTMzYL"), null);
  assert.equal(canonicalWhatsAppInviteUrl("https://chat.whatsapp.com.evil.com/JKCdpXGeqziH"), null);
  assert.equal(canonicalWhatsAppInviteUrl("not a url"), null);
  assert.equal(canonicalWhatsAppInviteUrl(null), null);
});

test("isValidWhatsAppInviteUrl: true iff canonicalizable", () => {
  assert.equal(isValidWhatsAppInviteUrl("https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e?s=cl"), true);
  assert.equal(isValidWhatsAppInviteUrl("https://example.com/abc"), false);
});

// --------------------------- resolution + guards ---------------------------

const NOW = Date.parse("2026-07-26T12:00:00Z");
const CUTOFF = Date.parse("2026-07-26T00:00:00Z");
const CTX = { nowMs: NOW, cutoffMs: CUTOFF, lookbackHours: 24, alreadyPosted: new Set<number>([999]) };

const C = (o: Partial<Community> & Pick<Community, "id" | "city_code" | "name">): Community => ({
  whatsapp_url: null,
  active: false,
  activated_at: null,
  ...o,
});

const COMMUNITIES: Community[] = [
  C({ id: 1, city_code: "STL", name: "St. Louis", whatsapp_url: "https://chat.whatsapp.com/abc123def", active: true, activated_at: "2026-07-26T00:00:00Z" }),
  C({ id: 2, city_code: "HOU", name: "Katy" }), // no url, inactive
  C({ id: 3, city_code: "HOU", name: "Pearland" }), // no url, inactive
  C({ id: 4, city_code: "ATL", name: "Atlanta", whatsapp_url: "https://chat.whatsapp.com/xyz789ghi", active: false }),
  C({ id: 5, city_code: "SATX", name: "San Antonio", whatsapp_url: "https://chat.whatsapp.com/satx12345", active: true, activated_at: "2026-07-26T11:00:00Z" }),
  C({ id: 6, city_code: "ATX", name: "North Austin", whatsapp_url: "https://chat.whatsapp.com/north12345", active: true, activated_at: "2026-07-26T00:00:00Z" }),
  C({ id: 7, city_code: "ATX", name: "South Austin" }), // no url, inactive
];
const byId = new Map(COMMUNITIES.map((c) => [c.id, c]));
const MAPS: CommunityMaps = {
  byField: new Map<number, Community>([
    [10, byId.get(6)!], // North Austin
    [892, byId.get(2)!], // Katy
    [22, byId.get(3)!], // Pearland
    [32, byId.get(3)!], // Pearland
  ]),
  byCity: new Map<string, Community[]>([
    ["STL", [byId.get(1)!]],
    ["HOU", [byId.get(2)!, byId.get(3)!]],
    ["ATL", [byId.get(4)!]],
    ["SATX", [byId.get(5)!]],
    ["ATX", [byId.get(6)!, byId.get(7)!]],
  ]),
};

function m(over: Partial<CommunityMatch>): CommunityMatch {
  return {
    api_id: 1,
    end_date_utc: "2026-07-26T10:00:00Z",
    is_cancelled: false,
    player_count: 12,
    min_player_count: 6,
    cityCode: "STL",
    fieldId: null,
    ...over,
  };
}

// ---- resolveCommunity (the destination rule) ----

test("resolveCommunity: field_id maps directly, ignoring cityCode", () => {
  const r = resolveCommunity({ fieldId: 10, cityCode: null }, MAPS);
  assert.equal(r.kind, "community");
  assert.equal(r.kind === "community" && r.community.name, "North Austin");
});

test("resolveCommunity: unmapped field, single-community city → that community", () => {
  const r = resolveCommunity({ fieldId: 99999, cityCode: "STL" }, MAPS);
  assert.equal(r.kind === "community" && r.community.name, "St. Louis");
});

test("resolveCommunity: unmapped field, two-community city → field_unassigned", () => {
  assert.equal(resolveCommunity({ fieldId: 1288, cityCode: "HOU" }, MAPS).kind, "field_unassigned");
});

test("resolveCommunity: no community rows for the city → city_not_configured", () => {
  assert.equal(resolveCommunity({ fieldId: 5, cityCode: "DFW" }, MAPS).kind, "city_not_configured");
});

test("resolveCommunity: no field and no city → unknown_city", () => {
  assert.equal(resolveCommunity({ fieldId: null, cityCode: null }, MAPS).kind, "unknown_city");
});

// ---- classify (guards, unchanged behavior for single-community cities) ----

test("classify: eligible STL match (single-community fallback) → wouldPost with bodies", () => {
  const d = classifyCommunityMatch(m({}), MAPS, CTX);
  assert.equal(d.wouldPost, true);
  assert.equal(d.reason, "eligible");
  assert.equal(d.displayName, "St. Louis");
  assert.equal(d.communityId, 1);
  assert.equal(d.urlText, "https://chat.whatsapp.com/abc123def");
});

test("classify: field-mapped ATX match → North Austin, name in the copy", () => {
  const d = classifyCommunityMatch(m({ cityCode: "ATX", fieldId: 10, end_date_utc: "2026-07-26T11:30:00Z" }), MAPS, CTX);
  assert.equal(d.reason, "eligible");
  assert.equal(d.communityName, "North Austin");
  assert.equal(d.copyText, communityMessageText("North Austin"));
  assert.equal(d.urlText, "https://chat.whatsapp.com/north12345");
});

test("classify: unmapped field in a two-community city → field_unassigned (never silent)", () => {
  const d = classifyCommunityMatch(m({ cityCode: "HOU", fieldId: 1288 }), MAPS, CTX);
  assert.equal(d.reason, "field_unassigned");
  assert.equal(d.wouldPost, false);
});

test("classify: a brand-new unmapped field in a single-community city still resolves + posts", () => {
  // The Atlanta case, but with an ACTIVE single-community city so we see it post.
  const d = classifyCommunityMatch(m({ cityCode: "STL", fieldId: 424242 }), MAPS, CTX);
  assert.equal(d.reason, "eligible");
  assert.equal(d.communityId, 1);
});

test("classify: already-posted api_id → skip", () => {
  assert.equal(classifyCommunityMatch(m({ api_id: 999 }), MAPS, CTX).reason, "already_posted");
});

test("classify: before cutoff / outside lookback → skip", () => {
  assert.equal(classifyCommunityMatch(m({ end_date_utc: "2026-07-25T23:00:00Z" }), MAPS, CTX).reason, "before_cutoff");
  assert.equal(classifyCommunityMatch(m({ end_date_utc: "2026-07-25T06:00:00Z" }), MAPS, CTX).reason, "outside_lookback");
  assert.equal(classifyCommunityMatch(m({ end_date_utc: "2026-07-26T18:00:00Z" }), MAPS, CTX).reason, "outside_lookback");
});

test("classify: cancelled and below-minimum → skip; null min is not below-minimum", () => {
  assert.equal(classifyCommunityMatch(m({ is_cancelled: true }), MAPS, CTX).reason, "cancelled");
  assert.equal(classifyCommunityMatch(m({ player_count: 3, min_player_count: 6 }), MAPS, CTX).reason, "below_minimum");
  assert.equal(classifyCommunityMatch(m({ player_count: 1, min_player_count: null }), MAPS, CTX).reason, "eligible");
});

test("classify: per-community activation floor blocks pre-activation matches", () => {
  const before = classifyCommunityMatch(m({ cityCode: "SATX", end_date_utc: "2026-07-26T10:00:00Z" }), MAPS, CTX);
  assert.equal(before.reason, "before_activation");
  const after = classifyCommunityMatch(m({ cityCode: "SATX", end_date_utc: "2026-07-26T11:30:00Z" }), MAPS, CTX);
  assert.equal(after.reason, "eligible");
});

test("classify: community guards — unknown / not configured / no url / inactive", () => {
  assert.equal(classifyCommunityMatch(m({ cityCode: null }), MAPS, CTX).reason, "unknown_city");
  assert.equal(classifyCommunityMatch(m({ cityCode: "DFW" }), MAPS, CTX).reason, "city_not_configured");
  // HOU field 892 → Katy (no url).
  assert.equal(classifyCommunityMatch(m({ cityCode: "HOU", fieldId: 892 }), MAPS, CTX).reason, "city_no_url");
  const atl = classifyCommunityMatch(m({ cityCode: "ATL" }), MAPS, CTX);
  assert.equal(atl.reason, "city_inactive");
  assert.equal(atl.urlText, "https://chat.whatsapp.com/xyz789ghi");
});
