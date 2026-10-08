// The Locations map's marks as plain HTML/SVG strings — NO Leaflet import, so the Map tab's legend
// can draw the exact same marks during server rendering. LocationsLeaflet wraps these in divIcons.
//
// Three marks that cannot be confused: a ROUND player bubble with a soccer-player figure, a field
// PIN with a soccer ball, and a city NAME TAG with a pointer.

// ── ICONS (inline SVG, currentColor) ───────────────────────────────────────────────────────────
// A figure kicking a ball. Drawn on a 24-unit grid with round 2.4 strokes so it survives 14px.
export const KICKER_SVG = (px: number) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<circle cx="13" cy="3.6" r="2.3" fill="currentColor" stroke="none"/>` +
  `<path d="M12.6 7 11 13.2"/><path d="M8 9.6 12.4 8l3.4 1.8"/>` +
  `<path d="M11 13.2 8.6 17.4 9.6 21.4"/><path d="M11 13.2l4.4 2.2 2.4-1.6"/>` +
  `<circle cx="20" cy="19" r="2.4" fill="currentColor" stroke="none"/></svg>`;
// The fallback for the smallest bubble, if the kicker is not legible there: head and shoulders.
export const PERSON_SVG = (px: number) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<circle cx="12" cy="7.5" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/></svg>`;
export const BALL_SVG = (px: number) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#0d1f18" stroke-width="1.6"/>` +
  `<path d="M12 7.6 15.8 10.4 14.4 14.9H9.6L8.2 10.4z" fill="#0d1f18"/>` +
  `<path d="M12 7.6V2.4M15.8 10.4 20.6 8.6M14.4 14.9 17.4 19.4M9.6 14.9 6.6 19.4M8.2 10.4 3.4 8.6" stroke="#0d1f18" stroke-width="1.4" fill="none"/></svg>`;

/* BUBBLE SIZE. One player: 24px, icon only. Two or more: room for the icon AND the count under it
 * (30px minimum), growing with the square root of the count. SMALL_ICON switches the smallest
 * bubble to the plain person if the kicker does not read at that size — set after looking at it. */
const SMALL_ICON: "kicker" | "person" = "kicker";
export const bubbleD = (n: number) => (n <= 1 ? 24 : Math.min(54, Math.round(30 + 6 * Math.sqrt(n - 1))));

export function bubbleHtml(n: number, tone: "in" | "gap", selected = false) {
  const d = bubbleD(n);
  const icon = n <= 1 ? (SMALL_ICON === "person" ? PERSON_SVG(15) : KICKER_SVG(16)) : KICKER_SVG(d >= 40 ? 18 : 15);
  return `<div class="loc-pb loc-pb-${tone}${selected ? " loc-pb-sel" : ""}" style="width:${d}px;height:${d}px">${icon}${n >= 2 ? `<b>${n}</b>` : ""}</div>`;
}

export const pinHtml = (on: boolean) => `<div class="loc-fpin${on ? " loc-fpin-on" : ""}"><span class="loc-fpin-head">${BALL_SVG(14)}</span></div>`;
export type Dir = "right" | "left" | "top" | "bottom";
export const cityTagHtml = (name: string, count: number | null, dir: Dir = "top") =>
  `<div class="loc-ct loc-ct-${dir}"><span class="loc-ct-name">${name}</span>` +
  (count != null ? `<span class="loc-ct-badge">${KICKER_SVG(12)}<b>${count}</b></span>` : "") + `</div>`;
