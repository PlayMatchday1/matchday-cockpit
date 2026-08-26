"use client";

// MATCH MANAGER ROSTER — the card on a player's profile in Player Lookup.
//
// THIS IS WHERE ADDING HAPPENS, and the reason it is here rather than in the Match Managers panel
// is the search. Retool's ADD CITY MANAGER modal searches GET /admin/players?email= — EMAIL ONLY —
// so it cannot find a single one of the 14 match managers who sign in with an
// @privaterelay.appleid.com token. Clubhouse already has a search that takes phone, email, name OR
// ID at the top of this page; putting the action on the player it found means there is NO SECOND
// SEARCH BOX and no rebuilt weakness.
//
// THE CITY LIST IS THE API'S OWN, KEYED BY NUMERIC ID (GET /cities → ten cities, including NYC and
// ELP which exist in neither CITY_SCOPES nor the finance estate). Never mapped by name.
//
// CONFINEMENT IS NOT THE PICKER. A confined account is served only its own city here, but that is
// a convenience — the ROUTE refuses another city on the identity it reads fresh from app_users,
// and this card cannot bypass it by sending a different id.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { addConfirmLines, removeConfirmLines, type MatchManager } from "@/lib/matchManagers";

type CityOpt = { id: number; label: string };
type Payload = {
  people: MatchManager[]; cities: CityOpt[]; canAdd: boolean; canRemove: boolean;
  confined: boolean; error?: string;
};

export default function MatchManagerRosterCard({ playerId, playerName }: { playerId: number; playerName: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickCity, setPickCity] = useState<number | "">("");
  const [pending, setPending] = useState<{ op: "add" | "remove"; cityId: number; cityLabel: string; lines: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verdict: string; text: string } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const t = s.session?.access_token;
      const r = await fetch("/api/match-managers", { headers: t ? { Authorization: `Bearer ${t}` } : {}, cache: "no-store" });
      const j = (await r.json()) as Payload;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /* AN ABSENCE IS NOT A CLAIM UNTIL THE DATA HAS ARRIVED. `me` is null both when this person is on
   * no roster AND while the fetch is still in flight, and rendering "Not a match manager anywhere"
   * for the second case tells the operator something false about a real person. The browser suite
   * caught it: it waited for the card to have decided, and the card had already said "none". */
  const loaded = data !== null;
  const me = data?.people.find((p) => p.userId === playerId) ?? null;
  const held = new Set((me?.cities ?? []).map((c) => c.cityId));
  const addable = (data?.cities ?? []).filter((c) => !held.has(c.id));

  /* ONE WRITE, NEVER RETRIED, and the verdict is the ROUTE's — which reads the roster back rather
   * than trusting a status code. There is no retry button on purpose: a duplicate add is a
   * duplicate roster row. */
  const commit = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true); setResult(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (s.session?.access_token) headers.Authorization = `Bearer ${s.session.access_token}`;
      const r = pending.op === "add"
        ? await fetch("/api/match-managers", { method: "POST", headers, body: JSON.stringify({ userId: playerId, cityId: pending.cityId }) })
        : await fetch(`/api/match-managers?userId=${playerId}&cityId=${pending.cityId}`, { method: "DELETE", headers });
      const j = (await r.json()) as { verdict?: string; error?: string };
      const v = j.verdict ?? (r.ok ? "UNKNOWN" : "FAILED");
      setResult({ verdict: v, text: v === "LANDED"
        ? `${playerName} is ${pending.op === "add" ? "on" : "off"} ${pending.cityLabel}'s match-manager roster — confirmed by reading the roster back.`
        : v === "NOT APPLIED" ? `Accepted, but the roster did not change. Nothing was retried.`
        : v === "UNKNOWN" ? `It is not known whether this landed. Reload and look before acting — do NOT press it again. ${j.error ?? ""}`
        : `${j.error ?? "The write was rejected."} Nothing changed and nothing was retried.` });
      setPending(null); setPickCity("");
      if (v === "LANDED") await load();   // re-read; never patch the list optimistically
    } catch (e) {
      /* A THROWN FETCH IS THE LEAST-INFORMED CASE, so it says MORE, not less. The request may have
       * reached MatchDay and landed; pressing again would be a second write. */
      setResult({ verdict: "UNKNOWN", text: `${e instanceof Error ? e.message : String(e)} — it is not known whether this landed. Reload and look before acting; do NOT press it again.` });
      setPending(null);
    } finally { setBusy(false); }
  }, [pending, busy, playerId, playerName, load]);

  return (
    <section className="mmr" data-testid="mmr-card">
      <div className="mmr-h"><h3>MATCH MANAGER</h3>
        <span className="mmr-note">{!loaded ? "reading the roster…"
          : me ? `on ${me.cities.length} ${me.cities.length === 1 ? "city" : "cities"}`
          : "not on any city's roster"}</span>
      </div>

      {err && <p className="mmr-err" data-testid="mmr-error">{err}</p>}

      <div className="mmr-b">
        <div className="mmr-chips" data-testid="mmr-cities">
          {!loaded ? <span className="mmr-none" data-testid="mmr-loading">Reading the roster…</span>
            : me && me.cities.length > 0 ? me.cities.map((c) => (
            <span key={c.cityId} className="mmr-pill" data-testid="mmr-held">
              {c.label}
              <button type="button" className="mmr-x" data-testid="mmr-remove" data-city={c.label}
                disabled={!data?.canRemove || busy} aria-label={`Remove from ${c.label}`}
                onClick={() => { setResult(null); setPending({ op: "remove", cityId: c.cityId, cityLabel: c.label,
                  lines: removeConfirmLines({ name: playerName, cityLabel: c.label, matchesRun: me.matchesRun }) }); }}>×</button>
            </span>
          )) : <span className="mmr-none" data-testid="mmr-none">Not a match manager anywhere.</span>}
        </div>

        <div className="mmr-add">
          {/* KEYED ON THE NUMERIC ID FROM GET /cities. The label is only for the human. */}
          <select value={pickCity} disabled={!data?.canAdd || busy || addable.length === 0}
            data-testid="mmr-city" onChange={(e) => setPickCity(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">{addable.length === 0 ? "— already on every city —" : "— choose a city —"}</option>
            {addable.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <button type="button" className="mmr-go" data-testid="mmr-add"
            disabled={!data?.canAdd || busy || pickCity === ""}
            onClick={() => {
              const c = addable.find((x) => x.id === pickCity); if (!c) return;
              setResult(null);
              setPending({ op: "add", cityId: c.id, cityLabel: c.label, lines: addConfirmLines({ name: playerName, cityLabel: c.label }) });
            }}>Add to city</button>
        </div>
      </div>

      {/* CANCEL SENDS NOTHING — the fetch lives in commit() and commit() runs only from Confirm.
          Retool asks nothing at all before either write; this asks before both. */}
      {pending && (
        <div className="mmr-confirm" data-testid="mmr-confirm">
          <b>{pending.op === "add" ? "This puts someone on a city's roster." : "This takes someone off a city's roster."}</b>
          <ul>{pending.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <div className="mmr-cb">
            <button type="button" className="mmr-cancel" data-testid="mmr-cancel" onClick={() => setPending(null)}>Cancel — send nothing</button>
            <button type="button" className="mmr-go" data-testid="mmr-go" disabled={busy} onClick={() => { void commit(); }}>
              {busy ? "Sending…" : pending.op === "add" ? "Confirm and add" : "Confirm and remove"}</button>
          </div>
        </div>
      )}

      {result && (
        <p className={`mmr-res v-${result.verdict.replace(/\s+/g, "")}`} data-testid="mmr-result" data-verdict={result.verdict}>
          <b>{result.verdict}</b> — {result.text}
        </p>
      )}

      {/* mmr-PREFIXED for the same reason MatchManagersPanel is mm-prefixed: PlayerLookup ships a
          plain global <style>{CSS}</style> and this card lives inside its .pl wrapper. */}
      <style jsx>{`
        .mmr { border: 1px solid #E4EAE5; border-radius: 14px; background: #fff; margin-bottom: 14px; overflow: hidden }
        .mmr-h { display: flex; align-items: center; gap: 10px; padding: 11px 16px; background: #F5F8F5; border-bottom: 1px solid #EFF3EF }
        .mmr-h h3 { margin: 0; font-size: 10.5px; font-weight: 900; letter-spacing: .1em; color: rgba(16,35,26,.6) }
        .mmr-note { margin-left: auto; font-size: 12px; color: rgba(16,35,26,.5) }
        .mmr-b { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; padding: 13px 16px }
        .mmr-chips { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 180px }
        .mmr-pill { display: inline-flex; align-items: center; gap: 5px; background: #F1F4F1; color: #3C4F44; border-radius: 999px; padding: 4px 6px 4px 11px; font-size: 12px; font-weight: 700 }
        .mmr-x { border: 0; background: rgba(16,35,26,.09); color: #3C4F44; border-radius: 999px; width: 20px; height: 20px; line-height: 1; font: inherit; font-size: 13px; cursor: pointer }
        .mmr-x:disabled { opacity: .35; cursor: not-allowed }
        .mmr-none { font-size: 12.5px; color: rgba(16,35,26,.5) }
        .mmr-add { display: flex; gap: 7px; align-items: center; flex-wrap: wrap }
        .mmr-add select { border: 1px solid #E4EAE5; border-radius: 9px; padding: 7px 10px; font: inherit; font-size: 13px; min-height: 34px; background: #fff }
        .mmr-go, .mmr-cancel { border: 1px solid #0F3323; background: #0F3323; color: #fff; border-radius: 9px; padding: 7px 13px; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; min-height: 34px }
        .mmr-cancel { background: #fff; color: rgba(16,35,26,.65); border-color: #E4EAE5 }
        .mmr-go:disabled { opacity: .4; cursor: not-allowed }
        .mmr-confirm { border-top: 1px solid #F0C98A; background: #FFF7EA; padding: 11px 16px; font-size: 13px; color: #5E3D05; line-height: 1.5 }
        .mmr-confirm b { display: block; margin-bottom: 5px; color: #4A3004 }
        .mmr-confirm ul { margin: 0 0 9px; padding-left: 18px }
        .mmr-cb { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap }
        .mmr-res { margin: 0; padding: 9px 16px; font-size: 12.5px; line-height: 1.5; border-top: 1px solid #EFF3EF; color: #3C4F44 }
        .mmr-res.v-LANDED { background: #F1FAF4; color: #17593A }
        .mmr-res.v-FAILED { background: #FEF4F1; color: #8C2A14 }
        .mmr-res.v-UNKNOWN, .mmr-res.v-NOTAPPLIED { background: #FFF8EC; color: #7A5008 }
        .mmr-err { margin: 0; padding: 9px 16px; color: #E8492A; font-size: 12.5px }
      `}</style>
    </section>
  );
}
