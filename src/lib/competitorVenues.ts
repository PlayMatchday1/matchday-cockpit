// COMPETITOR VENUES on the Locations map — the payload's shape and the square mark. Pure, no Leaflet:
// the route (/api/growth/locations/competitors) builds the venues, the map draws them, the legend
// draws the same HTML shrunk.
//
// THE MARK IS A SMALL SQUARE (Ryan, 2026-10-09): never round (players) and never a pin (our fields).
// Coloured by source with the Competitors page's own colours — Plei purple, GoodRec teal — split on
// the diagonal when a place is on both. Its side grows with the square root of spots per week.

export type CompetitorListing = {
  source: "plei" | "goodrec"; facility: string; url: string | null; confidence: string | null; notes: string | null;
  /** The capture row on the Competitors page (null when the capture has no row of that name). */
  supplyId: number | null; spots: number | null; lowCents: number | null; highCents: number | null; formats: string[];
  window: string | null;
};
export type CompetitorVenue = {
  id: number; market: string; name: string;
  street: string | null; city: string | null; state: string | null; zip: string | null;
  lat: number; lng: number; confidence: string | null; updatedAt: string | null; updatedBy: string | null;
  sources: ("plei" | "goodrec")[];
  listings: CompetitorListing[];
  /** Summed over the listings (each listing is its own supply). */
  spots: number;
  lowCents: number | null; highCents: number | null; formats: string[];
};
export type CompetitorOffMap = { name: string; market: string; sources: string[]; reason: string };
export type CompetitorPayload = { ready: boolean; reason?: string; venues: CompetitorVenue[]; offMap: CompetitorOffMap[]; canEdit: boolean };

/** The Competitors page's colours (CompetitorsView --plei / --gr). */
export const SOURCE_FILL = { plei: "#5b4b8a", goodrec: "#12657a" } as const;
export const SOURCE_NAME = { plei: "Plei", goodrec: "GoodRec" } as const;

/** Side in px: 10 at the smallest, 22 at the city's (or the country's) biggest. */
export const compSide = (spots: number, maxSpots: number) => Math.round(10 + 12 * Math.sqrt(Math.max(0, spots) / Math.max(1, maxSpots)));

export function compHtml(sources: ("plei" | "goodrec")[], side: number, selected = false) {
  const bg = sources.length > 1
    ? `linear-gradient(135deg,${SOURCE_FILL.plei} 0 50%,${SOURCE_FILL.goodrec} 50% 100%)`
    : SOURCE_FILL[sources[0] ?? "plei"];
  return `<div class="loc-cq${selected ? " loc-cq-sel" : ""}" style="width:${side}px;height:${side}px;background:${bg}"></div>`;
}

export const COMP_CSS = `
.loc-cq-wrap{background:transparent;border:0}
.loc-cq{box-sizing:border-box;border:1.5px solid #fff;border-radius:2px;box-shadow:0 0 0 1px rgba(13,31,24,.55),0 1px 3px rgba(0,0,0,.3);cursor:pointer}
.loc-cq-sel{box-shadow:0 0 0 2px #0d1f18,0 0 0 6px rgba(91,75,138,.35)}
.loc-cq-drag .loc-cq{cursor:move;outline:2px dashed #0d1f18;outline-offset:3px}
`;

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
/** "$9.50–$15.50", one figure when low = high, "not shown" when the capture has none. */
export const priceText = (low: number | null, high: number | null) =>
  low == null && high == null ? "not shown" : low == null || high == null || low === high ? money((low ?? high)!) : `${money(low)}–${money(high)}`;
