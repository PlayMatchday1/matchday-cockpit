// The Locations map's marks as plain HTML/SVG strings — NO Leaflet import, so the Map tab's legend
// can draw the exact same marks during server rendering. LocationsLeaflet wraps these in divIcons.
//
// Three marks that cannot be confused: a ROUND player bubble with a soccer-player figure, a field
// PIN with a soccer pitch, and a city NAME TAG with a pointer.

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
// A soccer pitch seen from above — rectangle, halfway line, centre circle — for the field pin. It
// replaced a ball, which read as a star at 14px (Ryan, 2026-10-08).
export const PITCH_SVG = (px: number) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 24 24" aria-hidden="true">` +
  `<rect x="2.5" y="5" width="19" height="14" rx="1.2" fill="#2CDB87" stroke="#fff" stroke-width="1.8"/>` +
  `<path d="M12 5v14" stroke="#fff" stroke-width="1.6"/>` +
  `<circle cx="12" cy="12" r="3" fill="none" stroke="#fff" stroke-width="1.6"/></svg>`;

/* BUBBLE SIZE. One player: 24px, icon only. Two or more: room for the icon AND the count under it
 * (30px minimum), growing with the square root of the count. SMALL_ICON switches the smallest
 * bubble to the plain person if the kicker does not read at that size — set after looking at it. */
const SMALL_ICON: "kicker" | "person" = "kicker";
export const bubbleD = (n: number) => (n <= 1 ? 24 : Math.min(54, Math.round(30 + 6 * Math.sqrt(n - 1))));

/* ACTIVITY MODE colours the bubble by when its players last played (wherePlayed.ts) and keeps the
 * outline for the field in reach: solid = a field in reach, dashed = none. Both show at once. The
 * outline is dark ink, so the light fills (yellow, grey) still have an edge on the map. */
export type ActivityPaint = { fill: string; ink: string };
export function bubbleHtml(n: number, tone: "in" | "gap", selected = false, paint?: ActivityPaint) {
  const d = bubbleD(n);
  const icon = n <= 1 ? (SMALL_ICON === "person" ? PERSON_SVG(15) : KICKER_SVG(16)) : KICKER_SVG(d >= 40 ? 18 : 15);
  const style = `width:${d}px;height:${d}px` + (paint ? `;background:${paint.fill};color:${paint.ink};border:2px ${tone === "in" ? "solid" : "dashed"} #1d2b25` : "");
  return `<div class="loc-pb loc-pb-${tone}${selected ? " loc-pb-sel" : ""}" style="${style}">${icon}${n >= 2 ? `<b>${n}</b>` : ""}</div>`;
}

export const pinHtml = (on: boolean) => `<div class="loc-fpin${on ? " loc-fpin-on" : ""}"><span class="loc-fpin-head">${PITCH_SVG(16)}</span></div>`;
export type Dir = "right" | "left" | "top" | "bottom";
/** `split`: in Activity mode, the city's players by bucket as a small proportional bar under the count
 *  (colours in bucket order). Values are integers built from constants — nothing user-supplied. */
export const cityTagHtml = (name: string, count: number | null, dir: Dir = "top", split?: { fill: string; n: number }[]) => {
  const total = split ? split.reduce((s, x) => s + x.n, 0) : 0;
  const bar = split && total > 0
    ? `<span class="loc-ct-split">${split.filter((x) => x.n > 0).map((x) => `<i style="flex:${x.n};background:${x.fill}"></i>`).join("")}</span>` : "";
  return `<div class="loc-ct loc-ct-${dir}"><span class="loc-ct-name">${name}</span>` +
    (count != null ? `<span class="loc-ct-badge${bar ? " loc-ct-badge-split" : ""}">${KICKER_SVG(12)}<b>${count}</b>${bar}</span>` : "") + `</div>`;
};

/** The marks' CSS — shared by the Map tab and the Overview's mini map, so a mark looks the same
 *  wherever it is drawn (it used to live in the Map tab's own style block). */
export const MARKS_CSS = `
/* PLAYER BUBBLE — round, figure + count. Green fill is #0b7d55, darker than the palette aqua, so
   the white figure and number clear contrast; orange is a light fill with a dashed orange edge. */
.loc-pb-wrap{background:transparent;border:0}
.loc-pb{box-sizing:border-box;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:0;line-height:1;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.loc-pb b{font:800 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;margin-top:1px}
.loc-pb-in{background:#0b7d55;border:2px solid #fff;color:#fff}
.loc-pb-gap{background:#FFF1EA;border:2px dashed #eb6834;color:#8A3A12}
/* SELECTED: a dark outline and a mint halo, drawn above its neighbours (zIndexOffset). */
.loc-pb-sel{outline:3px solid #003326;outline-offset:1px;box-shadow:0 0 0 7px rgba(44,219,135,.55),0 1px 3px rgba(0,0,0,.25)}
/* FIELD PIN — a teardrop with a small pitch in its head: never round, never a player. */
.loc-fpin{position:relative;width:26px;height:34px}
.loc-fpin::before{content:"";position:absolute;left:2px;top:1px;width:22px;height:22px;background:#003326;border:2px solid #fff;
  border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 1px 3px rgba(0,0,0,.3)}
.loc-fpin-on::before{background:#0b7d55;box-shadow:0 0 0 3px rgba(11,125,85,.35)}
.loc-fpin-head{position:absolute;left:5px;top:4px;width:16px;height:16px;display:block}
.loc-fpin-head svg{display:block}
/* CITY TAG — dark green name tag, pointer touching the city, count in a player badge. */
.loc-ct-wrap{background:transparent;border:0}
.loc-ct{position:absolute;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;background:#003326;color:#fff;
  border-radius:7px;padding:4px 8px;font:800 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;
  box-shadow:0 2px 6px rgba(0,0,0,.28);cursor:pointer}
.loc-ct::after{content:"";position:absolute;width:0;height:0;border:6px solid transparent}
.loc-ct-top{left:0;top:0;transform:translate(-50%,calc(-100% - 8px))}
.loc-ct-top::after{left:50%;top:100%;margin-left:-6px;border-top-color:#003326}
.loc-ct-bottom{left:0;top:0;transform:translate(-50%,8px)}
.loc-ct-bottom::after{left:50%;bottom:100%;margin-left:-6px;border-bottom-color:#003326}
.loc-ct-right{left:0;top:0;transform:translate(8px,-50%)}
.loc-ct-right::after{right:100%;top:50%;margin-top:-6px;border-right-color:#003326}
.loc-ct-left{left:0;top:0;transform:translate(calc(-100% - 8px),-50%)}
.loc-ct-left::after{left:100%;top:50%;margin-top:-6px;border-left-color:#003326}
.loc-ct-badge{display:inline-flex;align-items:center;gap:3px;background:#2CDB87;color:#003326;border-radius:99px;padding:2px 7px 2px 5px}
.loc-ct-badge b{font-size:11.5px}
.loc-ct-badge-split{position:relative;padding-bottom:6px}
.loc-ct-split{position:absolute;left:5px;right:6px;bottom:2px;height:4px;display:flex;border-radius:2px;overflow:hidden;gap:1px;background:#003326}
.loc-ct-split i{display:block;height:100%}
.loc-tip{font:700 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#0d1f18;border-radius:6px;padding:3px 6px}
.loc-tip-zip{background:transparent;border:0;box-shadow:none;color:#0d1f18}
.loc-tip-zip::before{display:none}
.loc-pin-wrap{background:transparent;border:0}
.loc-pin-closed .loc-fpin::before{background:#8a948f}
.loc-pl-wrap{background:transparent;border:0}
.loc-pl-n{position:absolute;transform:translate(-50%,-50%);background:#fff;color:#1d2b25;border:1.5px solid #1d2b25;border-radius:99px;
  padding:1px 6px;font:800 10.5px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.2)}
`;
