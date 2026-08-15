// City manager — GAMEDAY OPS, READ ONLY (Phase 29b). The third page of the tier.
//
// READ ONLY BY CONSTRUCTION, not by hiding controls. There is no match panel, no roster and no
// cancel here, because /api/city/gameday does not return a roster and this page has nowhere to
// send a write. The Match Ops board carries all three and each is something this tier must not
// reach: a roster is player names and phones for every match in the city, and cancel is one
// confirm from crediting and texting every signed-up player.
//
// Clicking a match goes to its row on Manager Pay — the ONE lever a city manager has (the
// assigned manager), where the write is scoped, logged and read back.
//
// Client-side gating here is COURTESY ONLY. The real gate is authenticateCityManager on
// /api/city/gameday, which is also where the city scope is enforced; this page cannot show
// another city's matches because it is never sent any.
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { cityNameFor } from "@/lib/cityScope";
import CityNav from "../CityNav";
import { supabase } from "@/lib/supabase";

type Match = {
  matchId: number; name: string | null; field: string | null;
  startDate: string | null; startDateUtc: string | null;
  cancelled: boolean; manager: string | null; managerId: number | null; coManaged: boolean;
  signed: number; cap: number; min: number; short: boolean;
};
type Payload = { scope: string; cityName: string; date: string; matches: Match[]; summary: { total: number; cancelled: number; short: number; unassigned: number }; readOnly: boolean };

const isCityManager = (u: { is_city_manager?: boolean } | null | undefined) => u?.is_city_manager === true;
const todayIso = () => new Date().toISOString().slice(0, 10);

// start_date is LOCAL WALL CLOCK wearing a Z (the MATCH model — the opposite of promo dates,
// which are true UTC). Read the labelled components with getUTC* and never re-shift them.
function wallTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  let h = d.getUTCHours(); const m = d.getUTCMinutes();
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

export default function CityGamedayPage() {
  const { appUser, isLoading } = useAuth();
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    (async () => {
      try {
        // NOTE: no ?city= is sent. The scope is the session's, and passing one would only ever be
        // refused — the server does not accept a city from the request.
        const { data: sess } = await supabase.auth.getSession();
        const res = await fetch(`/api/city/gameday?date=${encodeURIComponent(date)}`, {
          headers: sess.session ? { Authorization: `Bearer ${sess.session.access_token}` } : {},
          cache: "no-store",
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (live) { setData(j); setLoading(false); }
      } catch (e) { if (live) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } }
    })();
    return () => { live = false; };
  }, [date]);

  const rows = useMemo(() => data?.matches ?? [], [data]);

  if (isLoading) return <div className="p-6 text-sm text-deep-green/50">Loading…</div>;
  if (!isCityManager(appUser) && !appUser?.is_admin) {
    return <div className="p-6 text-sm text-coral" data-testid="cg-denied">Gameday Ops requires Admin or the City Manager tier.</div>;
  }

  const shift = (n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); setDate(d.toISOString().slice(0, 10)); };

  return (
    <div className="p-4" data-testid="city-gameday">
      <CityNav />
      <h1 className="text-xl font-extrabold tracking-tight text-deep-green">
        Gameday Ops{data?.scope ? ` · ${cityNameFor(data.scope) ?? data.scope}` : ""}
      </h1>
      <p className="mt-1 text-xs text-deep-green/60" data-testid="cg-scope-note">
        Scoped on the server to your city — this page never receives another city&rsquo;s matches. Read only:
        to change a match&rsquo;s manager, open it on Manager Pay.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button className="rounded-md border border-cream-line px-2 py-1 text-sm" data-testid="cg-prev" aria-label="Previous day" onClick={() => shift(-1)}>‹</button>
        <span className="text-sm font-semibold text-deep-green" data-testid="cg-date">{date}</span>
        <button className="rounded-md border border-cream-line px-2 py-1 text-sm" data-testid="cg-next" aria-label="Next day" onClick={() => shift(1)}>›</button>
        <button className="rounded-md border border-cream-line px-2 py-1 text-sm" data-testid="cg-today" disabled={date === todayIso()} onClick={() => setDate(todayIso())}>Today</button>
        {/* The city is a LOCKED label, not a control. There is deliberately no city selector on
            this page: a filter they can change is not scoping. */}
        <span className="ml-auto rounded-full bg-cream px-2.5 py-1 text-[11px] font-semibold text-deep-green" data-testid="cg-city-locked">
          {data?.cityName ?? cityNameFor(appUser?.city_identifier ?? "") ?? appUser?.city_identifier ?? "—"}
        </span>
      </div>

      {error && <div className="mt-4 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral" data-testid="cg-error">{error}</div>}
      {loading && <div className="mt-4 text-sm text-deep-green/50">Loading…</div>}

      {!loading && !error && data && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="cg-metrics">
            <Metric k="MATCHES" v={String(data.summary.total)} testid="cg-total" />
            <Metric k="SHORT" v={String(data.summary.short)} testid="cg-short" />
            <Metric k="NO MANAGER" v={String(data.summary.unassigned)} testid="cg-unassigned" />
            <Metric k="CANCELLED" v={String(data.summary.cancelled)} testid="cg-cancelled" />
          </div>

          {rows.length === 0 ? (
            <p className="mt-6 text-sm text-deep-green/50" data-testid="cg-empty">Nothing scheduled in {data.cityName} on {date}.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm" data-testid="cg-table">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-deep-green/50">
                    <th className="py-2">Kickoff</th><th>Field</th><th>Manager</th><th>Signed up</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.matchId} data-testid="cg-row" data-match={m.matchId}
                      data-short={m.short ? "1" : "0"} data-cancelled={m.cancelled ? "1" : "0"}
                      className="border-t border-cream-line">
                      <td className="py-2 font-semibold text-deep-green" data-testid="cg-kick">{wallTime(m.startDate)}</td>
                      <td className="text-deep-green/80" data-testid="cg-field">{m.field ?? "—"}</td>
                      <td className="text-deep-green/80" data-testid="cg-manager">
                        {m.manager ?? <span className="text-coral">No manager</span>}
                        {m.coManaged && <span className="ml-1 text-[11px] text-deep-green/50">+1</span>}
                      </td>
                      <td data-testid="cg-signed">
                        <span className={m.short ? "font-semibold text-coral" : "text-deep-green/80"}>
                          {m.signed}{m.cap ? ` / ${m.cap}` : ""}
                        </span>
                        {m.cancelled && <span className="ml-2 text-[11px] font-semibold text-deep-green/50">CANCELLED</span>}
                        {m.short && !m.cancelled && <span className="ml-2 text-[11px] font-semibold text-coral">SHORT of {m.min}</span>}
                      </td>
                      <td className="text-right">
                        {/* The ONE lever, and it is not here. This links to the row on Manager Pay
                            rather than opening a panel — no roster, no cancel, no write on this page. */}
                        <Link href={`/city/manager-pay?match=${m.matchId}`} data-testid="cg-to-managerpay"
                          className="text-xs font-semibold text-deep-green underline underline-offset-2">
                          Change manager
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ k, v, testid }: { k: string; v: string; testid: string }) {
  return (
    <div className="rounded-lg border border-cream-line bg-white px-3 py-2" data-testid={testid}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-deep-green/50">{k}</div>
      <div className="text-lg font-extrabold text-deep-green">{v}</div>
    </div>
  );
}
