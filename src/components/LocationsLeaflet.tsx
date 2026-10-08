"use client";

// The Locations map itself — Leaflet via react-leaflet, OpenStreetMap tiles, no API key. Imported
// ONLY through next/dynamic with ssr:false (LocationsMapTab): Leaflet touches `window` on import.
//
// Draws what the server already aggregated (/api/matchops/locations/map). Nothing here computes a
// distance or a coverage number: zip.inReach[reach] is the server's exact-distance verdict.

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { MapCity, MapField, MapZip, Reach } from "@/lib/locationsMap";

export const IN_REACH = "#1baf7a";
export const GAP = "#eb6834";
const FOREST = "#003326";
const MI_TO_M = 1609.344;

export type Selection = { kind: "field"; id: number } | { kind: "zip"; zip: string } | null;

const pinIcon = (on: boolean) => L.divIcon({
  className: "loc-pin-wrap",
  html: `<svg width="22" height="30" viewBox="0 0 22 30" aria-hidden="true"><path d="M11 29s9-9.6 9-17A9 9 0 0 0 2 12c0 7.4 9 17 9 17z" fill="${on ? "#0F5B44" : FOREST}" stroke="#fff" stroke-width="2"/><circle cx="11" cy="12" r="3.4" fill="#fff"/></svg>`,
  iconSize: [22, 30],
  iconAnchor: [11, 29],
  tooltipAnchor: [0, -26],
});

type Dir = "right" | "left" | "top" | "bottom";
// Leaflet anchors a CircleMarker's tooltip at the CENTRE plus this offset (and its CSS adds ~6px for
// the arrow), so the offset carries the radius — otherwise a big circle swallows its own label.
const offsetFor = (d: Dir, r: number): [number, number] =>
  d === "right" ? [r + 4, 0] : d === "left" ? [-(r + 4), 0] : d === "top" ? [0, -(r + 2)] : [0, r + 2];

/* CITY LABEL PLACEMENT, in PIXELS. Texas puts four cities within a few degrees, and at the
 * all-cities zoom any fixed rule collides somewhere (checked in a browser: a lat/lng rule overlapped
 * Austin with DFW and El Paso; a one-pass greedy boxed El Paso in behind DFW). So: every label
 * starts on the right, then for a few passes each city re-picks whichever of right / left / top /
 * bottom overlaps least with every OTHER label's current box and every circle. Re-run on every
 * zoom and resize. Label sizes are estimates (~7.2px per char plus padding, erring wide). */
function CityLabelLayout({ cities, radius, onLayout }: {
  cities: MapCity[]; radius: (c: MapCity) => number; onLayout: (d: Record<number, Dir>) => void;
}) {
  const map = useMap();
  useEffect(() => {
    type Box = { x: number; y: number; w: number; h: number };
    const area = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const run = () => {
      const pts = cities.map((c) => {
        const p = map.latLngToContainerPoint([c.lat, c.lng]);
        const r = radius(c);
        const w = `${c.name} · ${c.players}`.length * 7.2 + 20, h = 24;
        // The same geometry offsetFor produces: centre + offset + the 6px arrow margin.
        const boxes: Record<Dir, Box> = {
          right: { x: p.x + r + 10, y: p.y - h / 2, w, h },
          left: { x: p.x - r - 10 - w, y: p.y - h / 2, w, h },
          top: { x: p.x - w / 2, y: p.y - r - 8 - h, w, h },
          bottom: { x: p.x - w / 2, y: p.y + r + 8, w, h },
        };
        return { id: c.id, circle: { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r } as Box, boxes };
      });
      const dir: Record<number, Dir> = Object.fromEntries(pts.map((q) => [q.id, "right" as Dir]));
      for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (const q of pts) {
          let best: Dir = dir[q.id], bestCost = Infinity;
          for (const d of ["right", "left", "top", "bottom"] as Dir[]) {
            let cost = 0;
            for (const o of pts) {
              cost += area(q.boxes[d], o.circle);
              if (o.id !== q.id) cost += area(q.boxes[d], o.boxes[dir[o.id]]);
            }
            if (cost < bestCost - 0.5) { best = d; bestCost = cost; }
          }
          if (best !== dir[q.id]) { dir[q.id] = best; changed = true; }
        }
        if (!changed) break;
      }
      onLayout(dir);
    };
    run();
    map.on("zoomend resize", run);
    return () => { map.off("zoomend resize", run); };
  }, [map, cities, radius, onLayout]);
  return null;
}

function Fit({ points, fallback, zoom }: { points: [number, number][]; fallback: [number, number]; zoom: number }) {
  const map = useMap();
  const key = JSON.stringify(points);
  useEffect(() => {
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 12 });
    else map.setView(points[0] ?? fallback, zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

export default function LocationsLeaflet(props: {
  cities: MapCity[];
  city: MapCity | null;
  fields: MapField[];
  zips: MapZip[];
  reach: Reach;
  selected: Selection;
  highlightFieldId: number | null;
  onCity: (id: number) => void;
  onSelect: (s: Selection) => void;
}) {
  const { cities, city, fields, zips, reach, selected, highlightFieldId, onCity, onSelect } = props;

  const points = useMemo<[number, number][]>(() => {
    if (!city) return cities.map((c) => [c.lat, c.lng]);
    const pts: [number, number][] = [...fields.map((f) => [f.lat, f.lng] as [number, number]), ...zips.map((z) => [z.lat, z.lng] as [number, number])];
    return pts.length ? pts : [[city.lat, city.lng]];
  }, [cities, city, fields, zips]);

  const maxCityPlayers = Math.max(1, ...cities.map((c) => c.players));
  const cityRadius = useMemo(() => (c: MapCity) => 7 + 11 * Math.sqrt(c.players / maxCityPlayers), [maxCityPlayers]);
  const [dirs, setDirs] = useState<Record<number, Dir>>({});
  const maxZipPlayers = Math.max(1, ...zips.map((z) => z.players));

  return (
    <MapContainer center={[33, -92]} zoom={5} scrollWheelZoom={false} className="loc-leaflet" attributionControl>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={18}
      />
      <Fit points={points} fallback={city ? [city.lat, city.lng] : [33, -92]} zoom={city ? 10 : 5} />
      {!city && <CityLabelLayout cities={cities} radius={cityRadius} onLayout={setDirs} />}

      {!city && cities.map((c) => (
        <CircleMarker key={c.id} center={[c.lat, c.lng]}
          radius={cityRadius(c)}
          pathOptions={{ color: FOREST, weight: 2, fillColor: FOREST, fillOpacity: c.players > 0 ? 0.28 : 0.08 }}
          eventHandlers={{ click: () => onCity(c.id) }}>
          {/* keyed on direction: react-leaflet fixes a tooltip's direction at mount */}
          <Tooltip key={dirs[c.id] ?? "right"} permanent direction={dirs[c.id] ?? "right"} offset={offsetFor(dirs[c.id] ?? "right", cityRadius(c))} className="loc-tip">
            {c.name} · {c.players}
          </Tooltip>
        </CircleMarker>
      ))}

      {city && fields.map((f) => {
        const on = highlightFieldId === f.id || (selected?.kind === "field" && selected.id === f.id);
        return (
          <Circle key={`ring-${f.id}`} center={[f.lat, f.lng]} radius={reach * MI_TO_M}
            pathOptions={{ color: FOREST, weight: on ? 3 : 1.2, opacity: on ? 0.9 : 0.35, fillColor: FOREST, fillOpacity: on ? 0.1 : 0.03 }}
            interactive={false} />
        );
      })}

      {city && zips.map((z) => {
        const covered = z.inReach[reach];
        const sel = selected?.kind === "zip" && selected.zip === z.zip;
        return (
          <CircleMarker key={`zip-${z.zip}`} center={[z.lat, z.lng]}
            radius={7 + 16 * Math.sqrt(z.players / maxZipPlayers)}
            pathOptions={covered
              // dashArray "" is deliberate: Leaflet's setStyle MERGES, so omitting it leaves the old
              // dash on a bubble that just came into reach (seen in a browser at 10 mi).
              ? { color: "#04583A", weight: sel ? 3.5 : 2, dashArray: "", fillColor: IN_REACH, fillOpacity: 0.7 }
              : { color: GAP, weight: sel ? 3.5 : 2.2, dashArray: "5 4", fillColor: GAP, fillOpacity: 0.18 }}
            eventHandlers={{ click: () => onSelect({ kind: "zip", zip: z.zip }) }}>
            {(z.players >= 3 || sel) && (
              <Tooltip permanent direction="center" className="loc-tip loc-tip-zip">{z.zip}</Tooltip>
            )}
          </CircleMarker>
        );
      })}

      {city && fields.map((f) => {
        const on = highlightFieldId === f.id || (selected?.kind === "field" && selected.id === f.id);
        return (
          <Marker key={`pin-${f.id}`} position={[f.lat, f.lng]} icon={pinIcon(on)}
            eventHandlers={{ click: () => onSelect({ kind: "field", id: f.id }) }}>
            {/* keyed on `on`: react-leaflet fixes `permanent` at mount, so a change needs a remount */}
            <Tooltip key={on ? "pinned" : "hover"} direction="top" permanent={on} className="loc-tip">{f.title}</Tooltip>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
