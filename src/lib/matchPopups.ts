// MATCH PROMOTION › POPUP: which in-app popups (Offers campaigns) are about a match. Client-safe.
//
// A popup is "for" a match when it shows a popup (popupEnabled isn't false) and either applies to that match only
// (matchIds) or its button opens it (buttonTarget MATCH, buttonMatchId) — which is how a no-discount announcement
// names its match (backend docs/offers/announcements.md). The channel's stored key is still "dm" (matchPromotion
// CHANNELS): it was relabelled Popup without renaming any stored value.

import type { Campaign, CampaignState } from "./offersModel";

export type MatchPopup = { id: number; name: string; state: CampaignState };

export function popupMatchIds(c: Pick<Campaign, "popupEnabled" | "matchIds" | "buttonTarget" | "buttonMatchId">): number[] {
  if (c.popupEnabled === false) return [];
  const ids = new Set<number>(c.matchIds ?? []);
  if (c.buttonTarget === "MATCH" && c.buttonMatchId != null) ids.add(c.buttonMatchId);
  return [...ids];
}

// match id -> its popups, the one to show first: live, then scheduled, paused, draft, ended; newest (highest id) first.
const RANK: Record<CampaignState, number> = { LIVE: 0, SCHEDULED: 1, PAUSED: 2, DRAFT: 3, ENDED: 4 };
export function popupsByMatch(campaigns: Campaign[]): Record<number, MatchPopup[]> {
  const out: Record<number, MatchPopup[]> = {};
  for (const c of campaigns) for (const m of popupMatchIds(c)) (out[m] ??= []).push({ id: c.id, name: c.name, state: c.state });
  for (const k of Object.keys(out)) out[+k].sort((a, b) => RANK[a.state] - RANK[b.state] || b.id - a.id);
  return out;
}

export const createPopupHref = (matchId: number) => `/match-ops/offers?new=announcement&match=${matchId}`;
export const viewPopupHref = (id: number) => `/match-ops/offers?open=${id}`;
