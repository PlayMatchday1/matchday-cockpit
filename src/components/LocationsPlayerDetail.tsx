"use client";

// The detail panel under an expanded Recent activity row. Loads GET /api/growth/locations/player
// (Supabase only) when the row opens. Matches played, last match and active use the Users lens
// definition (src/lib/playerActivity.ts); member = an active paid subscription.

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { placeName } from "@/lib/playerAreaModel";
import { MARKS_CSS } from "@/components/locationsMarks";

const LocationsMiniMap = dynamic(() => import("@/components/LocationsMiniMap"), {
  ssr: false,
  loading: () => <div className="loc-mini-map loc-mini-loading">Loading map…</div>,
});

type Detail = {
  id: number; name: string | null; signedUpAt: string | null; signupCompleted: boolean;
  matchesPlayed: number; lastPlayedDay: string | null; active: boolean; member: boolean;
  area: string | null; zip: string | null; source: string | null; firstSeenAt: string; seeded: boolean;
  position: { lat: number; lng: number } | null;
  nearest: { id: number; title: string; mi: number } | null;
  within: { 5: number; 10: number; 15: number };
  fields: { id: number; title: string; lat: number; lng: number; mi: number }[];
};

const CHI = "America/Chicago";
const fmtDate = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: CHI, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
const fmtWhen = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: CHI, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
// A match day is its LOCAL calendar day (wall clock, sliced by the server) — formatted at UTC noon so
// no time zone can move it.
const fmtDay = (ymd: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));
const mi = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} mi`;
const sourceName = (raw: string | null) => (raw == null || raw === "none" ? "Not set" : raw === "zip" ? "Zip" : "GPS");

export default function LocationsPlayerDetail({ playerId }: { playerId: number }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        const res = await fetch(`/api/growth/locations/player?id=${playerId}`, {
          cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (live) setD(body as Detail);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, [playerId]);

  if (error) return <div className="loc-detail loc-detail-msg">Couldn&apos;t load this player: {error}</div>;
  if (!d) return <div className="loc-detail loc-detail-msg">Loading…</div>;

  return (
    <div className="loc-detail" data-testid="loc-detail">
      <style>{MARKS_CSS}</style>
      <style>{CSS}</style>
      <div className="loc-detail-info">
        <div className="loc-detail-name">
          {d.name ?? `Player ${d.id}`} <span className="loc-muted">#{d.id}</span>
          <a className="loc-link loc-detail-lookup" href={`/match-ops/player-lookup?id=${d.id}`}>Open in Player Lookup</a>
        </div>
        <dl className="loc-dl">
          <dt>Signed up</dt><dd>{d.signedUpAt ? fmtDate(d.signedUpAt) : "Not known"}{d.signedUpAt && !d.signupCompleted ? " (account created, sign-up not finished)" : ""}</dd>
          <dt>Matches played</dt><dd>{d.matchesPlayed}</dd>
          <dt>Last match</dt><dd>{d.lastPlayedDay ? fmtDay(d.lastPlayedDay) : "None yet"}</dd>
          <dt>Active</dt><dd>{d.active ? "Yes, played or booked in the last 30 days" : "No"}</dd>
          <dt>Member</dt><dd>{d.member ? "Yes" : "No"}</dd>
        </dl>
        <dl className="loc-dl">
          <dt>Area</dt><dd>{placeName(d.area) ?? "Not named"}</dd>
          <dt>Zip</dt><dd>{d.zip ?? "None"}</dd>
          <dt>Source</dt><dd>{sourceName(d.source)} <span className="loc-raw">{d.source ?? "null"}</span></dd>
          <dt>First seen</dt><dd>{d.seeded ? "Before tracking began" : fmtWhen(d.firstSeenAt)}</dd>
        </dl>
        <dl className="loc-dl">
          <dt>Nearest field</dt><dd>{d.nearest ? `${d.nearest.title}, ${mi(d.nearest.mi)}` : "No active field"}</dd>
          <dt>Fields nearby</dt><dd>{d.within[5]} within 5 mi, {d.within[10]} within 10 mi, {d.within[15]} within 15 mi</dd>
        </dl>
      </div>
      {d.position ? (
        <div className="loc-mini-map" data-testid="loc-mini-map">
          <LocationsMiniMap position={d.position} fields={d.fields} inReach={d.within[5] > 0} />
        </div>
      ) : (
        <div className="loc-mini-map loc-mini-loading">No location to map.</div>
      )}
    </div>
  );
}

const CSS = `
.loc-detail{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;padding:14px 16px;background:#F6FBF8;border-top:1px solid #DCE9E1}
.loc-detail-msg{display:block;color:var(--muted);font-size:12.5px}
.loc-detail-info{min-width:0;display:flex;flex-direction:column;gap:10px}
.loc-detail-name{font-size:14px;font-weight:800;color:var(--forest);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.loc-detail-lookup{font-size:12px;margin-left:auto}
.loc-dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:4px 12px;margin:0;font-size:12.5px}
.loc-dl dt{color:var(--muted);font-weight:700}
.loc-dl dd{margin:0;color:var(--ink)}
.loc-mini-map{height:230px;border-radius:10px;overflow:hidden;border:1px solid var(--line);position:relative;z-index:0}
.loc-mini-loading{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;background:var(--slot)}
.loc-mini-leaflet{height:100%;width:100%}
@media (max-width:800px){.loc-detail{grid-template-columns:1fr}.loc-detail-lookup{margin-left:0}}
`;
