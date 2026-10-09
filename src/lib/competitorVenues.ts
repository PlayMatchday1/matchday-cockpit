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
  /** A field partner of ours that also lists here (Hattrick): tagged on the square and the card. */
  partnerBrand: string | null;
};
/** A competitor listing at one of OUR fields (src/lib/competitorProposals.ts sharedVenues). */
export type SharedVenue = {
  supplyId: number; source: "plei" | "goodrec"; cityLabel: string; facility: string;
  spots: number; lowCents: number | null; highCents: number | null; formats: string[];
  /** When the capture holding this row was taken. A re-import replaces a capture, so this is the
   *  earliest SURVIVING capture of the facility, not necessarily the first ever. */
  firstCapturedAt: string | null;
  status: "confirmed" | "proposed";
  ourVenueId: number; ourVenueName: string; ourCity: string | null;
  field: { id: number; title: string; lat: number; lng: number } | null;
};

export type CompetitorOffMap = {
  name: string; market: string; sources: string[]; reason: string;
  /** Set when an admin can PLACE it: a venue row with no coordinates. Its current address rides along. */
  venueId?: number; street?: string | null; city?: string | null; state?: string | null; zip?: string | null;
};
export type CompetitorPayload = { ready: boolean; reason?: string; venues: CompetitorVenue[]; offMap: CompetitorOffMap[]; canEdit: boolean;
  /** Shared venues; the ones with a `field` are drawn on the map at our field. */
  shared: SharedVenue[] };

/** The Competitors page's colours (CompetitorsView --plei / --gr). */
export const SOURCE_FILL = { plei: "#5b4b8a", goodrec: "#12657a" } as const;
export const SOURCE_NAME = { plei: "Plei", goodrec: "GoodRec" } as const;

/** Side in px: 10 at the smallest, 22 at the city's (or the country's) biggest. */
export const compSide = (spots: number, maxSpots: number) => Math.round(10 + 12 * Math.sqrt(Math.max(0, spots) / Math.max(1, maxSpots)));

export function compHtml(sources: ("plei" | "goodrec")[], side: number, selected = false, partnerBrand: string | null = null) {
  const bg = sources.length > 1
    ? `linear-gradient(135deg,${SOURCE_FILL.plei} 0 50%,${SOURCE_FILL.goodrec} 50% 100%)`
    : SOURCE_FILL[sources[0] ?? "plei"];
  const sq = `<div class="loc-cq${selected ? " loc-cq-sel" : ""}" style="width:${side}px;height:${side}px;background:${bg}"></div>`;
  // PARTNER BRAND: a small tag hanging under the square. The text is a constant, never user input.
  return partnerBrand ? `<div class="loc-cq-pb-wrap">${sq}<span class="loc-cq-pb">Partner brand</span></div>` : sq;
}

/* SHARED: a competitor also runs at one of OUR fields. Split down the middle — our green on the left,
 * the competitor's colour on the right — inside a mint ring, so it reads as neither a plain competitor
 * square (diagonal split, no ring) nor our field pin. Fixed size: it marks a relationship, not supply. */
export const SHARED_SIDE = 18;
export function sharedHtml(source: "plei" | "goodrec", selected = false, side = SHARED_SIDE) {
  return `<div class="loc-cq loc-cs${selected ? " loc-cq-sel" : ""}" style="width:${side}px;height:${side}px;background:linear-gradient(90deg,#0b7d55 0 50%,${SOURCE_FILL[source]} 50% 100%)"></div>`;
}

export const COMP_CSS = `
.loc-cq-wrap{background:transparent;border:0}
.loc-cq{box-sizing:border-box;border:1.5px solid #fff;border-radius:2px;box-shadow:0 0 0 1px rgba(13,31,24,.55),0 1px 3px rgba(0,0,0,.3);cursor:pointer}
.loc-cq-sel{box-shadow:0 0 0 2px #0d1f18,0 0 0 6px rgba(91,75,138,.35)}
.loc-cs{border:2px solid #fff;box-shadow:0 0 0 2.5px #2CDB87,0 1px 4px rgba(0,0,0,.35)}
.loc-cs.loc-cq-sel{box-shadow:0 0 0 2.5px #2CDB87,0 0 0 5px #0d1f18}
.loc-cq-pb-wrap{position:relative;display:inline-block}
.loc-cq-pb{position:absolute;left:50%;top:100%;transform:translate(-50%,3px);white-space:nowrap;background:#fff;color:#7a5a00;border:1px solid #e2c46b;
  border-radius:99px;padding:0 5px;font:800 9px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.2);pointer-events:none}
.loc-cq-drag .loc-cq{cursor:move;outline:2px dashed #0d1f18;outline-offset:3px}
`;

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
/** "$9.50–$15.50", one figure when low = high, "not shown" when the capture has none. */
export const priceText = (low: number | null, high: number | null) =>
  low == null && high == null ? "not shown" : low == null || high == null || low === high ? money((low ?? high)!) : `${money(low)}–${money(high)}`;
