"use client";

// MATCH MANAGERS — a collapsible section under Player Finder on Player Lookup.
//
// THESE ARE NOT CLUBHOUSE CITY MANAGERS, and the only place that phrase appears in this file is
// the banner that explains the API's own naming. app_users.is_city_manager is a login with city
// confinement — 5 rows, and only 3 of them are also match managers. Two unrelated things sharing
// one noun in one app is how the next permissions bug gets written.
//
// ONE ROW PER PERSON, cities as chips. The API returns 107 rows because a row is a person-in-a-
// city; folding them answers "who are our match managers", which is the question the page is for.
// BOTH COUNTS ARE ON SCREEN and the footer says why they differ — chips sum to 107 while All reads
// 87, which looks like a bug in any page that does not say it isn't.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  filterPeople, emailDisplay, type MatchManager, type Counts,
} from "@/lib/matchManagers";

type Payload = {
  people: MatchManager[]; counts: Counts; neverRan: number;
  canAdd: boolean; canRemove: boolean; mutationReason: string;
  scope: string | null; confined: boolean; error?: string;
};

const fmtDate = (d: string | null) =>
  d && /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "—";

export default function MatchManagersPanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [city, setCity] = useState<string | null>(null);
  const [unrunOnly, setUnrunOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token;
      const r = await fetch("/api/match-managers", { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
      const j = (await r.json()) as Payload;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  // LAZY. The roster is one API call and this section starts collapsed; fetching it on every
  // Player Lookup visit would spend a MatchDay round-trip on a panel nobody opened.
  useEffect(() => { if (open && !data && !loading) void load(); }, [open, data, loading, load]);

  const people = data?.people ?? [];
  const rows = useMemo(() => {
    const base = filterPeople(people, q, city);
    return unrunOnly ? base.filter((p) => p.matchesRun === 0) : base;
  }, [people, q, city, unrunOnly]);

  return (
    <section className="mm" data-testid="mm-panel">
      <button type="button" className="mmhead" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="mm-toggle">
        <span className="mmcar">{open ? "▴" : "▾"}</span>
        <span className="mmttl">MATCH MANAGERS</span>
        <span className="mmcnt" data-testid="mm-counts">
          {data ? <><b>{data.counts.people}</b> people · <b>{data.counts.assignments}</b> city assignments</> : <>—</>}
        </span>
      </button>

      {open && (
        <div className="mmbody">
          {/* THE ONE PLACE THE API'S NAME APPEARS, and it is here to stop the confusion rather
              than to propagate it. */}
          <div className="mmwarn" data-testid="mm-naming-banner">
            <b>The MatchDay API calls these “city managers”.</b> They are not the city managers in
            Clubhouse permissions — those are logins with city confinement. These are the people who
            run matches and are paid through Manager Pay.
          </div>

          {err && <p className="mmerr" data-testid="mm-error">{err}</p>}
          {loading && <p className="mmmut">Loading the roster…</p>}

          {data && (
            <>
              <div className="mmbar">
                <input className="mmfilter" placeholder="Filter by name, phone or ID" value={q}
                  onChange={(e) => setQ(e.target.value)} data-testid="mm-filter" />
                <button type="button" className={`mmchip ${unrunOnly ? "mmon" : ""}`} onClick={() => setUnrunOnly((v) => !v)} data-testid="mm-unrun">
                  Never run a match <span className="mmn">{data.neverRan}</span>
                </button>
                {/* NO SECOND SEARCH BOX FOR ADDING. The operator finds the player in the Player
                    Lookup search at the top — phone, email, name or ID — and the action lives on
                    their card. Retool's modal searches EMAIL ONLY, which cannot find anyone on an
                    Apple relay address; rebuilding that weakness here would be a step backwards. */}
                <button type="button" className="mmadd" disabled={!data.canAdd} title={data.canAdd ? "" : data.mutationReason}
                  data-testid="mm-add">+ Add match manager</button>
              </div>

              <div className="mmcities" data-testid="mm-cities">
                <span className="mmlbl">City</span>
                <button type="button" className={`mmchip ${city === null ? "mmon" : ""}`} onClick={() => setCity(null)}>
                  All <span className="mmn">{data.counts.people}</span>
                </button>
                {data.counts.byCity.map((c) => (
                  <button key={c.label} type="button" className={`mmchip ${city === c.label ? "mmon" : ""}`} onClick={() => setCity(c.label)}>
                    {c.label} <span className="mmn">{c.n}</span>
                  </button>
                ))}
              </div>

              {!data.canAdd && (
                <p className="mmmut" data-testid="mm-no-mutation">{data.mutationReason}</p>
              )}

              <div className="mmtbl">
                <div className="mmth">
                  <div>Match manager</div><div>Cities</div><div>Phone</div>
                  <div className="mmr">Matches run</div><div>Last match</div><div>Actions</div>
                </div>
                {rows.length === 0 && <div className="mmempty">Nothing matches those filters.</div>}
                {rows.map((p) => (
                  <div className="mmtr" key={p.userId} data-testid="mm-row">
                    <div className="mmwho">
                      <b>{p.name}</b>
                      {/* AN APPLE RELAY ADDRESS IS LABELLED, NEVER PRINTED. A random token reads as
                          corrupt data and is not something anyone can search or write to — the ID
                          and the phone are the only handles those people have, so both are on
                          screen. */}
                      <span className={p.relay ? "mmrelay" : "mmem"} data-testid="mm-email">{emailDisplay(p)}</span>
                    </div>
                    <div className="mmchips" data-testid="mm-city-chips">
                      {p.cities.map((c) => <span key={c.cityId} className="mmpill" data-testid="mm-city-chip">{c.label}</span>)}
                    </div>
                    <div className="mmmono" data-testid="mm-phone">{p.phone ?? "—"}</div>
                    {/* THE COLUMN HEADS ARE HIDDEN UNDER 900px, so the figures carry their own
                        labels there — an unlabelled "13" beside a phone number is a number with no
                        unit. Both spans are display:none on the wide layout, where the head says it. */}
                    <div className="mmr mmmono">{p.matchesRun.toLocaleString("en-US")}<span className="mmsm"> matches run</span></div>
                    <div className="mmmono"><span className="mmsm">Last </span>{fmtDate(p.lastMatch)}</div>
                    <div>
                      <button type="button" className="mmrm" disabled={!data.canRemove}
                        title={data.canRemove ? "" : data.mutationReason} data-testid="mm-remove">Remove</button>
                    </div>
                  </div>
                ))}
              </div>

              {/* THE RECONCILIATION, SAID OUT LOUD. Without this the two numbers read as a bug. */}
              <p className="mmfoot" data-testid="mm-foot">
                <b>{data.counts.people}</b> people hold <b>{data.counts.assignments}</b> city
                assignments, so the city chips add up to more than the row count — someone working
                three cities is one person and three chips. Retool lists the {data.counts.assignments} assignments;
                this lists the people.
              </p>
            </>
          )}
        </div>
      )}

      {/* EVERY CLASS IS mm-PREFIXED ON PURPOSE. PlayerLookup renders a plain <style>{CSS}</style> —
          a GLOBAL sheet — and this panel sits inside its .pl wrapper, so `.pl .chips`, `.pl .row`
          and `.pl .chip` outrank a bare styled-jsx class and won. The city column rendered with
          PlayerLookup's chip-strip background until these were renamed. */}
      <style jsx>{`
        .mm { border: 1px solid #E4EAE5; border-radius: 12px; background: #fff; margin-top: 14px; overflow: hidden }
        .mmhead { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: #F5F8F5; padding: 11px 14px; cursor: pointer; font: inherit; text-align: left }
        .mmcar { color: #93A49A; font-size: 12px }
        .mmttl { font-size: 10.5px; font-weight: 900; letter-spacing: .1em; color: rgba(16,35,26,.6) }
        .mmcnt { margin-left: auto; font-size: 12px; color: rgba(16,35,26,.55) }
        .mmbody { padding: 12px 14px 14px }
        .mmwarn { border: 1px solid #F0D8A8; background: #FFF8EC; color: #7A5008; border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.5; margin-bottom: 11px }
        .mmwarn b { color: #5E3D05 }
        .mmbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 9px }
        .mmfilter { flex: 1; min-width: 200px; border: 1px solid #E4EAE5; border-radius: 9px; padding: 8px 11px; font: inherit; font-size: 15px }
        @media (min-width: 640px) { .mmfilter { font-size: 13px } }
        .mmchip, .mmadd, .mmrm { border: 1px solid #E4EAE5; background: #fff; border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 12.5px; font-weight: 600; color: rgba(16,35,26,.65); cursor: pointer; min-height: 32px }
        .mmchip.mmon { background: #0F3323; border-color: #0F3323; color: #fff }
        .mmchip .mmn { opacity: .55; margin-left: 5px; font-weight: 800 }
        .mmadd { border-radius: 9px; font-weight: 700 }
        .mmrm { border-radius: 8px; padding: 4px 10px; min-height: 0; font-size: 11.5px }
        .mmadd:disabled, .mmrm:disabled { opacity: .4; cursor: not-allowed }
        .mmcities { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 10px }
        .mmlbl { font-size: 10px; font-weight: 800; letter-spacing: .09em; color: #93A49A; text-transform: uppercase }
        .mmtbl { border: 1px solid #EFF3EF; border-radius: 9px; overflow: hidden }
        .mmth, .mmtr { display: grid; grid-template-columns: minmax(200px,2fr) minmax(120px,1.2fr) 130px 96px 110px 88px; gap: 10px; padding: 8px 12px; align-items: center }
        .mmth { background: #F9FBF9; font-size: 9.5px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; color: rgba(16,35,26,.5) }
        .mmtr { border-top: 1px solid #F2F5F2; font-size: 12.5px }
        .mmr { text-align: right }
        .mmwho { display: flex; flex-direction: column; gap: 1px; min-width: 0 }
        .mmem { font-size: 11px; color: rgba(16,35,26,.45); overflow-wrap: anywhere }
        .mmrelay { font-size: 11px; color: #5B4BC4; font-style: italic }
        .mmchips { display: flex; gap: 4px; flex-wrap: wrap }
        .mmpill { background: #F1F4F1; color: #3C4F44; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700 }
        .mmmono { font-variant-numeric: tabular-nums; color: #3C4F44 }
        .mmempty, .mmmut { padding: 8px 2px; font-size: 12px; color: rgba(16,35,26,.5) }
        .mmfoot { margin-top: 10px; font-size: 11.5px; color: rgba(16,35,26,.5); line-height: 1.55 }
        .mmerr { color: #E8492A; font-size: 12.5px }
        .mmsm { display: none }
        @media (max-width: 900px) {
          .mmth { display: none }
          .mmtr { grid-template-columns: 1fr auto; gap: 4px 10px; padding: 11px 12px }
          .mmr { text-align: left }
          .mmsm { display: inline; color: rgba(16,35,26,.45); font-size: 11px; font-variant-numeric: normal }
        }
      `}</style>
    </section>
  );
}
