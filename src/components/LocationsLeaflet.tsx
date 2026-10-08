"use client";

// The Locations map itself — Leaflet via react-leaflet, OpenStreetMap tiles, no API key. Imported
// ONLY through next/dynamic with ssr:false (LocationsMapTab): Leaflet touches `window` on import.
//
// Draws what the server already aggregated (/api/growth/locations/map). Nothing here computes a
// distance or a coverage number: zip.inReach / zip.nearby are the server's exact-distance results.
//
// THREE MARKS THAT CANNOT BE CONFUSED (Ryan, 2026-10-08):
//   players  a ROUND bubble with a soccer-player figure; the count under it when 2 or more.
//            Green solid = a field in reach (city view) / in a market; orange dashed = none / outside.
//   fields   a PIN with a small pitch in its head — never round, so never read as players.
//   cities   a dark green NAME TAG with a pointer (All cities view); the count sits in a player badge.

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { Circle, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type { MapCity, MapField, MapZip, NationalZip, Reach } from "@/lib/locationsMap";
import { bubbleD, bubbleHtml, cityTagHtml, pinHtml, type Dir } from "@/components/locationsMarks";

export const IN_REACH = "#1baf7a";
export const GAP = "#eb6834";
const FOREST = "#003326";
const MI_TO_M = 1609.344;

/* THE ALL-CITIES VIEW: one name tag per city; in-market players roll up into their own city's tag,
 * never a neighbour's. Zip bubbles appear only in the city view, or here from DEEP_ZOOM (about one
 * metro filling the map), merging only within a city. Outside-coverage players are orange dashed
 * bubbles, merging only with each other. */
export const DEEP_ZOOM = 9;
export type NatFilter = "all" | "in_market" | "waitlist";

/** A zip bubble is selected by its KEY: a no-zip bubble is a grid cell, and has no zip. */
export type Selection = { kind: "field"; id: number } | { kind: "zip"; key: string } | null;

const players = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "player" : "players"}`;

function bubbleIcon(n: number, tone: "in" | "gap", selected: boolean) {
  const d = bubbleD(n);
  return L.divIcon({
    className: "loc-pb-wrap",
    html: bubbleHtml(n, tone, selected),
    iconSize: [d, d],
    iconAnchor: [d / 2, d / 2],
    tooltipAnchor: [0, -d / 2],
  });
}

const pinIcon = (on: boolean) => L.divIcon({
  className: "loc-pin-wrap",
  html: pinHtml(on),
  iconSize: [26, 34],
  iconAnchor: [13, 33],
  tooltipAnchor: [0, -30],
});

const cityTagIcon = (c: MapCity, dir: Dir, showCount: boolean) => L.divIcon({
  className: "loc-ct-wrap",
  html: cityTagHtml(c.name, showCount ? c.players : null, dir),
  iconSize: [0, 0],
  iconAnchor: [0, 0],
});
const tagWidth = (c: MapCity, showCount: boolean) => c.name.length * 7 + 22 + (showCount ? 16 + String(c.players).length * 7 + 14 : 0);

/* CITY TAG PLACEMENT, in PIXELS. Texas puts four cities within a few degrees; at the national fit
 * Austin and San Antonio are ~13px apart. Each tag can sit above, below, left or right of its city
 * (the pointer always touches the city's point). A few passes: every city re-picks the side whose
 * box overlaps least with the other tags, every city point and every bubble, and a side that would
 * sit nearer another city than its own is penalised so a tag never reads as its neighbour's. */
function CityTagLayout({ cities, showCount, obstacles, onLayout }: {
  cities: MapCity[]; showCount: (c: MapCity) => boolean; obstacles: NationalZip[];
  onLayout: (d: Record<number, Dir>) => void;
}) {
  const map = useMap();
  useEffect(() => {
    type Box = { x: number; y: number; w: number; h: number };
    const area = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const run = () => {
      const pts = cities.map((c) => {
        const p = map.latLngToContainerPoint([c.lat, c.lng]);
        const w = tagWidth(c, showCount(c)), h = 26, g = 8; // g = pointer length
        const boxes: Record<Dir, Box> = {
          top: { x: p.x - w / 2, y: p.y - g - h, w, h },
          bottom: { x: p.x - w / 2, y: p.y + g, w, h },
          right: { x: p.x + g, y: p.y - h / 2, w, h },
          left: { x: p.x - g - w, y: p.y - h / 2, w, h },
        };
        return { id: c.id, cx: p.x, cy: p.y, dot: { x: p.x - 4, y: p.y - 4, w: 8, h: 8 } as Box, boxes };
      });
      const bubbles: Box[] = obstacles.map((z) => {
        const p = map.latLngToContainerPoint([z.lat, z.lng]);
        const r = bubbleD(z.players) / 2;
        return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r };
      });
      const dir: Record<number, Dir> = Object.fromEntries(pts.map((q) => [q.id, "top" as Dir]));
      for (let pass = 0; pass < 5; pass++) {
        let changed = false;
        for (const q of pts) {
          let best: Dir = dir[q.id], bestCost = Infinity;
          for (const d of ["top", "right", "left", "bottom"] as Dir[]) {
            const b = q.boxes[d];
            let cost = 0;
            for (const bb of bubbles) cost += area(b, bb);
            for (const o of pts) {
              cost += area(b, o.dot);
              if (o.id !== q.id) cost += area(b, o.boxes[dir[o.id]]);
            }
            const bx = b.x + b.w / 2, by = b.y + b.h / 2, own = Math.hypot(bx - q.cx, by - q.cy);
            if (pts.some((o) => o.id !== q.id && Math.hypot(bx - o.cx, by - o.cy) < own)) cost += 2000;
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
  }, [map, cities, showCount, obstacles, onLayout]);
  return null;
}

function ZoomWatch({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => { onZoom(map.getZoom()); }, [map, onZoom]);
  return null;
}

/* PLAYER BUBBLES, CLUSTERED IN PIXELS — both views. After every zoom/resize, bubbles in the same
 * GROUP whose circles would overlap merge into one at the player-weighted centre with the combined
 * count, so a busy map never hides one count under another. Groups: national = kind + city (never
 * across cities, never in-market with outside coverage); city view = green vs orange at the current
 * reach (a merged bubble never mixes players with and without a field in reach). Clicking a merged
 * bubble zooms to its members, which splits it; a single bubble is selected. */
export type BubbleItem = { key: string; group: string; tone: "in" | "gap"; lat: number; lng: number; players: number };
type Cluster = { key: string; group: string; tone: "in" | "gap"; lat: number; lng: number; players: number; members: BubbleItem[] };

function ClusteredBubbles({ items, selectedKey, onSelect }: {
  items: BubbleItem[]; selectedKey: string | null; onSelect: (key: string) => void;
}) {
  const map = useMap();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  useEffect(() => {
    const run = () => {
      const out: (Cluster & { px: number; py: number })[] = [];
      for (const b of [...items].sort((x, y) => y.players - x.players || x.key.localeCompare(y.key))) {
        const p = map.latLngToContainerPoint([b.lat, b.lng]);
        const hit = out.find((c) => c.group === b.group
          && Math.hypot(c.px - p.x, c.py - p.y) < (bubbleD(c.players) + bubbleD(b.players)) / 2 - 2);
        if (!hit) { out.push({ key: b.key, group: b.group, tone: b.tone, lat: b.lat, lng: b.lng, players: b.players, members: [b], px: p.x, py: p.y }); continue; }
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
  }, [map, items]);

  return (
    <>
      {clusters.map((c) => {
        const merged = c.members.length > 1;
        const sel = !merged && c.members[0].key === selectedKey;
        return (
          // STABLE key: react-leaflet swaps the icon in place (setIcon), so selecting a bubble does not
          // remount it — a remount would close the "N players" tooltip that a tap just opened.
          <Marker key={c.key} position={[c.lat, c.lng]} icon={bubbleIcon(c.players, c.tone, sel)}
            eventHandlers={{ click: (e) => {
              (e.target as L.Marker).openTooltip(); // a TAP shows "N players" too, not only a hover
              if (!merged) { onSelect(c.members[0].key); return; }
              const bounds = L.latLngBounds(c.members.map((m) => [m.lat, m.lng] as [number, number]));
              // Members on one rounded point never split by zooming; pick the biggest instead.
              if (map.getZoom() >= 13 || bounds.getNorthEast().equals(bounds.getSouthWest())) { onSelect(c.members[0].key); return; }
              map.fitBounds(bounds.pad(0.5), { maxZoom: 13 });
            } }}>
            <Tooltip direction="top" className="loc-tip">{players(c.players)}</Tooltip>
          </Marker>
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
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 12 });
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
  const bubbles = useMemo(() => national.filter((z) => z.verdict === "waitlist" || deep), [national, deep]);
  const showCount = useMemo(() => (c: MapCity) => !deep && natFilter !== "waitlist" && c.players > 0, [deep, natFilter]);
  const [dirs, setDirs] = useState<Record<number, Dir>>({});
  const nationalItems = useMemo<BubbleItem[]>(() => bubbles.map((z) => ({ key: z.key, group: `${z.verdict}|${z.cityId ?? ""}`,
    tone: z.verdict === "in_market" ? "in" : "gap", lat: z.lat, lng: z.lng, players: z.players })), [bubbles]);
  const zipItems = useMemo<BubbleItem[]>(() => zips.map((z) => {
    const tone = z.inReach[reach] ? "in" : "gap";
    return { key: z.key, group: tone, tone, lat: z.lat, lng: z.lng, players: z.players };
  }), [zips, reach]);

  const points = useMemo<[number, number][]>(() => {
    if (!city) return [...cities.map((c) => [c.lat, c.lng] as [number, number]), ...nationalAll.map((z) => [z.lat, z.lng] as [number, number])];
    const pts: [number, number][] = [...fields.map((f) => [f.lat, f.lng] as [number, number]), ...zips.map((z) => [z.lat, z.lng] as [number, number])];
    return pts.length ? pts : [[city.lat, city.lng]];
  }, [cities, city, fields, zips, nationalAll]);

  // City view: the selected bubble, and the fields inside ITS ring at the current reach.
  const selZip = city && selected?.kind === "zip" ? zips.find((z) => z.key === selected.key) ?? null : null;
  const fieldsInSelRing = useMemo(() => new Set((selZip?.nearby ?? []).filter((n) => n.minReach <= reach).map((n) => n.fieldId)), [selZip, reach]);

  return (
    <MapContainer center={[33, -92]} zoom={5} scrollWheelZoom={false} className="loc-leaflet" attributionControl>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={18}
      />
      <Fit points={points} fallback={city ? [city.lat, city.lng] : [33, -92]} zoom={city ? 10 : 5} />
      <ZoomWatch onZoom={setZoom} />
      {!city && <CityTagLayout cities={cities} showCount={showCount} obstacles={bubbles} onLayout={setDirs} />}
      <Focus focus={focus} />

      {/* Coverage radius per city — only when "Show coverage radius" is on: a thin outline, no fill. */}
      {!city && showRadius && cities.map((c) => (
        <Circle key={`radius-${c.id}`} center={[c.lat, c.lng]} radius={c.radiusMiles * MI_TO_M} interactive={false}
          pathOptions={{ color: FOREST, weight: 1, opacity: 0.5, fill: false }} />
      ))}

      {!city && <ClusteredBubbles items={nationalItems} selectedKey={selectedNational} onSelect={onSelectNational} />}

      {!city && cities.map((c) => {
        const d = dirs[c.id] ?? "top";
        const sc = showCount(c);
        return (
          <Marker key={`tag-${c.id}-${d}-${sc ? c.players : "n"}`} position={[c.lat, c.lng]} icon={cityTagIcon(c, d, sc)}
            zIndexOffset={1000} eventHandlers={{ click: () => onCity(c.id) }}
            title={sc ? `${c.name}: ${players(c.players)}` : c.name} />
        );
      })}

      {/* Reach rings stay on FIELDS. A ring around a player bubble appears only when one is selected. */}
      {city && fields.map((f) => {
        const on = highlightFieldId === f.id || (selected?.kind === "field" && selected.id === f.id) || fieldsInSelRing.has(f.id);
        return (
          <Circle key={`ring-${f.id}`} center={[f.lat, f.lng]} radius={reach * MI_TO_M}
            pathOptions={{ color: FOREST, weight: on ? 2.5 : 1.2, opacity: on ? 0.8 : 0.3, fillColor: FOREST, fillOpacity: on ? 0.07 : 0.025 }}
            interactive={false} />
        );
      })}
      {selZip && (
        <Circle key={`selring-${selZip.key}-${reach}`} center={[selZip.lat, selZip.lng]} radius={reach * MI_TO_M} interactive={false}
          pathOptions={{ color: "#0b7d55", weight: 2.5, dashArray: "7 5", fillColor: "#0b7d55", fillOpacity: 0.06 }} />
      )}

      {city && <ClusteredBubbles items={zipItems} selectedKey={selected?.kind === "zip" ? selected.key : null}
        onSelect={(key) => onSelect({ kind: "zip", key })} />}

      {city && fields.map((f) => {
        const on = highlightFieldId === f.id || (selected?.kind === "field" && selected.id === f.id) || fieldsInSelRing.has(f.id);
        return (
          <Marker key={`pin-${f.id}`} position={[f.lat, f.lng]} icon={pinIcon(on)} zIndexOffset={500}
            eventHandlers={{ click: () => onSelect({ kind: "field", id: f.id }) }}>
            {/* keyed on `on`: react-leaflet fixes `permanent` at mount, so a change needs a remount */}
            <Tooltip key={on ? "pinned" : "hover"} direction="top" permanent={on} className="loc-tip">{f.title}</Tooltip>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
