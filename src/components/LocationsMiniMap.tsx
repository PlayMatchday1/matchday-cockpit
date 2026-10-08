"use client";

// The small map inside an expanded Recent activity row: the player's area and the active fields
// within 15 miles (or the nearest one), with 5 / 10 / 15 mile rings around the player. Leaflet, so
// imported ONLY through next/dynamic with ssr:false. Same marks as the Map tab (locationsMarks).

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { Circle, MapContainer, Marker, TileLayer, Tooltip, useMap } from "react-leaflet";
import { bubbleHtml, pinHtml } from "@/components/locationsMarks";

const MI_TO_M = 1609.344;

function Fit({ points }: { points: [number, number][] }) {
  const map = useMap();
  const key = JSON.stringify(points);
  useEffect(() => {
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom: 12 });
    else if (points[0]) map.setView(points[0], 11);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

export default function LocationsMiniMap({ position, fields, inReach }: {
  position: { lat: number; lng: number };
  fields: { id: number; title: string; lat: number; lng: number; mi: number }[];
  /** Whether a field is within 5 miles — sets the player bubble green or orange dashed. */
  inReach: boolean;
}) {
  const points: [number, number][] = [[position.lat, position.lng], ...fields.map((f) => [f.lat, f.lng] as [number, number])];
  return (
    <MapContainer center={[position.lat, position.lng]} zoom={11} scrollWheelZoom={false} className="loc-mini-leaflet" attributionControl>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' maxZoom={18} />
      <Fit points={points} />
      {[5, 10, 15].map((r) => (
        <Circle key={r} center={[position.lat, position.lng]} radius={r * MI_TO_M} interactive={false}
          pathOptions={{ color: "#003326", weight: 1, opacity: 0.35, dashArray: "4 4", fill: false }} />
      ))}
      <Marker position={[position.lat, position.lng]} zIndexOffset={600}
        icon={L.divIcon({ className: "loc-pb-wrap", html: bubbleHtml(1, inReach ? "in" : "gap"), iconSize: [24, 24], iconAnchor: [12, 12] })}>
        <Tooltip direction="top" className="loc-tip">Player&apos;s area</Tooltip>
      </Marker>
      {fields.map((f) => (
        <Marker key={f.id} position={[f.lat, f.lng]}
          icon={L.divIcon({ className: "loc-pin-wrap", html: pinHtml(false), iconSize: [26, 34], iconAnchor: [13, 33], tooltipAnchor: [0, -30] })}>
          <Tooltip direction="top" className="loc-tip">{f.title}, {f.mi} mi</Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
