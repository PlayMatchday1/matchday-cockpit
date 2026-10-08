"use client";

// The Locations map itself — Leaflet via react-leaflet, OpenStreetMap tiles, no API key. Imported
// ONLY through next/dynamic with ssr:false (LocationsMapTab): Leaflet touches `window` on import.
//
// Draws what the server already aggregated (/api/matchops/locations/map). Nothing here computes a
// distance or a coverage number: zip.inReach[reach] is the server's exact-distance verdict.

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type { MapCity, MapField, MapZip, NationalZip, Reach } from "@/lib/locationsMap";

export const IN_REACH = "#1baf7a";
export const GAP = "#eb6834";
const FOREST = "#003326";
const MI_TO_M = 1609.344;

/* THE ALL-CITIES VIEW (Ryan, 2026-10-08): ONE solid green bubble per city at its centre, sized by
 * players, count inside, name beside; a city with no players is a small hollow marker with its name.
 * In-market players never appear as their own bubbles at this zoom — they roll up into their own
 * city, never a neighbour's. Zip bubbles appear only in the city view, or here once the map is
 * zoomed to DEEP_ZOOM (about one metro filling the map), and even then merge only within a city.
 * Outside-coverage players stay orange dashed bubbles, count inside, merging only with each other. */
export const DEEP_ZOOM = 9;
export type NatFilter = "all" | "in_market" | "waitlist";
// Kept small: Austin and San Antonio sit ~30px apart at the national fit, and bigger bubbles buried
// one city's label under the other's bubble (seen in a browser).
const cityBubbleR = (n: number) => Math.min(24, 8 + 4 * Math.sqrt(n));
const HOLLOW_R = 5;

const countIcon = (n: number, cls: string) => L.divIcon({
  className: "loc-count-wrap",
  html: `<span class="loc-count ${cls}">${n}</span>`,
  iconSize: [0, 0],
});

/** A zip bubble is selected by its KEY: a no-zip bubble is a grid cell, and has no zip. */
export type Selection = { kind: "field"; id: number } | { kind: "zip"; key: string } | null;

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
function CityLabelLayout({ cities, radius, obstacles, onLayout }: {
  cities: MapCity[]; radius: (c: MapCity) => number;
  /** Bubbles on the map: a label must not sit on one and hide its count. */
  obstacles: NationalZip[];
  onLayout: (d: Record<number, Dir>) => void;
}) {
  const map = useMap();
  useEffect(() => {
    type Box = { x: number; y: number; w: number; h: number };
    const area = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const run = () => {
      const pts = cities.map((c) => {
        const p = map.latLngToContainerPoint([c.lat, c.lng]);
        const r = radius(c);
        const w = c.name.length * 7.2 + 20, h = 24;
        // The same geometry offsetFor produces: centre + offset + the 6px arrow margin.
        const boxes: Record<Dir, Box> = {
          right: { x: p.x + r + 10, y: p.y - h / 2, w, h },
          left: { x: p.x - r - 10 - w, y: p.y - h / 2, w, h },
          top: { x: p.x - w / 2, y: p.y - r - 8 - h, w, h },
          bottom: { x: p.x - w / 2, y: p.y + r + 8, w, h },
        };
        return { id: c.id, cx: p.x, cy: p.y, circle: { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r } as Box, boxes };
      });
      const bubbles: Box[] = obstacles.map((z) => {
        const p = map.latLngToContainerPoint([z.lat, z.lng]);
        const r = natRadius(z.players);
        return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r };
      });
      const dir: Record<number, Dir> = Object.fromEntries(pts.map((q) => [q.id, "right" as Dir]));
      for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (const q of pts) {
          let best: Dir = dir[q.id], bestCost = Infinity;
          for (const d of ["right", "left", "top", "bottom"] as Dir[]) {
            let cost = 0;
            for (const b of bubbles) cost += area(q.boxes[d], b);
            // A label must read as its OWN city's: if its centre is nearer another city than its
            // own, penalise it (seen: "Austin" placed under San Antonio's bubble at national zoom).
            const bx = q.boxes[d].x + q.boxes[d].w / 2, by = q.boxes[d].y + q.boxes[d].h / 2;
            const own = Math.hypot(bx - q.cx, by - q.cy);
            if (pts.some((o) => o.id !== q.id && Math.hypot(bx - o.cx, by - o.cy) < own)) cost += 2000;
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
  }, [map, cities, radius, obstacles, onLayout]);
  return null;
}

function ZoomWatch({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => { onZoom(map.getZoom()); }, [map, onZoom]);
  return null;
}

/* NATIONAL BUBBLES, CLUSTERED IN PIXELS. At national zoom neighbouring zips sit on top of each
 * other, so after every zoom/resize bubbles of the SAME verdict whose circles would overlap merge
 * into one, at the player-weighted centre, sized by the combined count. Never across verdicts — a
 * merged bubble must not turn an outside-coverage player green. Clicking a merged bubble zooms to
 * its members, which splits it. Size is an absolute scale so a bubble means the same at any zoom. */
export const natRadius = (n: number) => Math.min(28, 6 + 5 * Math.sqrt(n));
type Cluster = { key: string; verdict: NationalZip["verdict"]; cityId: number | null; lat: number; lng: number; players: number; members: NationalZip[] };

function NationalClusters({ bubbles, selectedKey, onSelect }: {
  bubbles: NationalZip[]; selectedKey: string | null; onSelect: (key: string) => void;
}) {
  const map = useMap();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  useEffect(() => {
    const run = () => {
      const out: (Cluster & { px: number; py: number })[] = [];
      for (const b of [...bubbles].sort((x, y) => y.players - x.players || x.key.localeCompare(y.key))) {
        const p = map.latLngToContainerPoint([b.lat, b.lng]);
        // Same verdict AND same city (null for outside coverage): two cities never share a bubble.
        const hit = out.find((c) => c.verdict === b.verdict && c.cityId === b.cityId
          && Math.hypot(c.px - p.x, c.py - p.y) < natRadius(c.players) + natRadius(b.players) - 2);
        if (!hit) { out.push({ key: b.key, verdict: b.verdict, cityId: b.cityId, lat: b.lat, lng: b.lng, players: b.players, members: [b], px: p.x, py: p.y }); continue; }
        const n = hit.players + b.players;
        hit.lat = (hit.lat * hit.players + b.lat * b.players) / n;
        hit.lng = (hit.lng * hit.players + b.lng * b.players) / n;
        hit.px = (hit.px * hit.players + p.x * b.players) / n;
        hit.py = (hit.py * hit.players + p.y * b.players) / n;
        hit.players = n;
        hit.members.push(b);
        hit.key = hit.members.map((m) => m.key).sort().join("+");
      }
      setClusters(out);
    };
    run();
    map.on("zoomend resize", run);
    return () => { map.off("zoomend resize", run); };
  }, [map, bubbles]);

  return (
    <>
      {clusters.map((c) => {
        const merged = c.members.length > 1;
        const sel = !merged && c.members[0].key === selectedKey;
        const style = c.verdict === "in_market"
          ? { color: "#04583A", weight: sel ? 3.5 : 2, dashArray: "", fillColor: IN_REACH, fillOpacity: 0.75 }
          : { color: GAP, weight: sel ? 3.5 : 2.2, dashArray: "5 4", fillColor: GAP, fillOpacity: 0.22 };
        return (
          <CircleMarker key={c.key} center={[c.lat, c.lng]} radius={natRadius(c.players)} pathOptions={style}
            eventHandlers={{ click: () => {
              if (!merged) { onSelect(c.members[0].key); return; }
              const bounds = L.latLngBounds(c.members.map((m) => [m.lat, m.lng] as [number, number]));
              // Members on one rounded point never split by zooming; pick the biggest instead.
              if (map.getZoom() >= 12 || bounds.getNorthEast().equals(bounds.getSouthWest())) { onSelect(c.members[0].key); return; }
              map.fitBounds(bounds.pad(0.4), { maxZoom: 12 });
            } }}>
            <Tooltip key={`${c.key}-${c.players}`} permanent direction="center"
              className={"loc-tip loc-tip-zip loc-tip-count" + (c.verdict === "waitlist" ? " loc-tip-count-gap" : "")}>{c.players}</Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

function Focus({ focus }: { focus: { lat: number; lng: number; zoom: number; n: number } | null }) {
  const map = useMap();
  useEffect(() => { if (focus) map.setView([focus.lat, focus.lng], focus.zoom); }, [map, focus]);
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
  /** All-cities view: the (already filtered) national bubbles, the selected one, and a fly-to. */
  national: NationalZip[];
  /** Everything, unfiltered — the all-cities view fits to this, so a filter never moves the map. */
  nationalAll: NationalZip[];
  selectedNational: string | null;
  onSelectNational: (key: string) => void;
  focus: { lat: number; lng: number; zoom: number; n: number } | null;
  natFilter: NatFilter;
  showRadius: boolean;
}) {
  const { cities, city, fields, zips, reach, selected, highlightFieldId, onCity, onSelect,
    national, nationalAll, selectedNational, onSelectNational, focus, natFilter, showRadius } = props;
  const [zoom, setZoom] = useState(5);
  const deep = zoom >= DEEP_ZOOM;
  // What the all-cities view draws as separate bubbles: outside coverage always (if the filter
  // allows), in-market zips only once zoomed in to a metro.
  const bubbles = useMemo(() => national.filter((z) => z.verdict === "waitlist" || deep), [national, deep]);
  const greenCity = (c: MapCity) => !deep && natFilter !== "waitlist" && c.players > 0;

  const points = useMemo<[number, number][]>(() => {
    if (!city) return [...cities.map((c) => [c.lat, c.lng] as [number, number]), ...nationalAll.map((z) => [z.lat, z.lng] as [number, number])];
    const pts: [number, number][] = [...fields.map((f) => [f.lat, f.lng] as [number, number]), ...zips.map((z) => [z.lat, z.lng] as [number, number])];
    return pts.length ? pts : [[city.lat, city.lng]];
  }, [cities, city, fields, zips, nationalAll]);

  const cityRadius = useMemo(() => (c: MapCity) => (!deep && natFilter !== "waitlist" && c.players > 0 ? cityBubbleR(c.players) : HOLLOW_R),
    [deep, natFilter]);
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
      <ZoomWatch onZoom={setZoom} />
      {!city && <CityLabelLayout cities={cities} radius={cityRadius} obstacles={bubbles} onLayout={setDirs} />}
      <Focus focus={focus} />

      {/* Coverage radius per city — only when "Show coverage radius" is on: a thin outline, no fill. */}
      {!city && showRadius && cities.map((c) => (
        <Circle key={`radius-${c.id}`} center={[c.lat, c.lng]} radius={c.radiusMiles * MI_TO_M} interactive={false}
          pathOptions={{ color: FOREST, weight: 1, opacity: 0.5, fill: false }} />
      ))}

      {!city && cities.map((c) => {
        const green = greenCity(c);
        const d = dirs[c.id] ?? "right";
        return (
          <CircleMarker key={`city-${c.id}-${green ? "g" : "h"}`} center={[c.lat, c.lng]} radius={cityRadius(c)}
            pathOptions={green
              // White ring, so two touching city bubbles keep a visible edge between them.
              ? { color: "#fff", weight: 2, dashArray: "", fillColor: IN_REACH, fillOpacity: 1 }
              : { color: FOREST, weight: 2, dashArray: "", fillColor: "#fff", fillOpacity: 1 }}
            eventHandlers={{ click: () => onCity(c.id) }}>
            {/* keyed on direction: react-leaflet fixes a tooltip's direction at mount */}
            <Tooltip key={d} permanent direction={d} offset={offsetFor(d, cityRadius(c))} className="loc-tip">{c.name}</Tooltip>
          </CircleMarker>
        );
      })}
      {/* The count INSIDE a green city bubble — a second layer, since the bubble's one tooltip is its name. */}
      {!city && cities.filter(greenCity).map((c) => (
        <Marker key={`count-${c.id}`} position={[c.lat, c.lng]} icon={countIcon(c.players, "")}
          eventHandlers={{ click: () => onCity(c.id) }} />
      ))}

      {!city && <NationalClusters bubbles={bubbles} selectedKey={selectedNational} onSelect={onSelectNational} />}

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
        const sel = selected?.kind === "zip" && selected.key === z.key;
        return (
          <CircleMarker key={`zip-${z.key}`} center={[z.lat, z.lng]}
            radius={7 + 16 * Math.sqrt(z.players / maxZipPlayers)}
            pathOptions={covered
              // dashArray "" is deliberate: Leaflet's setStyle MERGES, so omitting it leaves the old
              // dash on a bubble that just came into reach (seen in a browser at 10 mi).
              ? { color: "#04583A", weight: sel ? 3.5 : 2, dashArray: "", fillColor: IN_REACH, fillOpacity: 0.7 }
              : { color: GAP, weight: sel ? 3.5 : 2.2, dashArray: "5 4", fillColor: GAP, fillOpacity: 0.18 }}
            eventHandlers={{ click: () => onSelect({ kind: "zip", key: z.key }) }}>
            {(z.players >= 3 || sel) && (
              <Tooltip permanent direction="center" className="loc-tip loc-tip-zip">{z.area}</Tooltip>
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
