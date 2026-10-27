"use client";

// "ADD A TEST FIELD" on Growth > Locations > Map (Nick, Richardson TX, 2026-10-27). Find an address or
// place, or click the map, and a TEST pin drops there; several can be on at once. For each pin at the
// selected reach: players within reach, how many of them no real field reaches today, how many played
// in the last 90 days, and the nearest real fields. The city's coverage now and with the test pins.
//
// Every number comes from POST /api/growth/locations/test-fields/impact (src/lib/testFieldImpact.ts).
// Saved pins live in growth_test_fields (migration 0232) through /api/growth/locations/test-fields,
// which only admins can write. A test pin is NEVER a real field: nothing else reads that table.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { REACHES, type MapCity, type Reach } from "@/lib/locationsMap";
import type { TestFieldImpact } from "@/lib/testFieldImpact";
import type { TestPinMark } from "@/components/LocationsLeaflet";

type Saved = { id: string; name: string; lat: number; lng: number; query: string | null; created_by_email: string; created_by_name: string | null; created_at: string };
type Draft = { key: string; lat: number; lng: number; name: string; query: string | null };
type Hit = { label: string; lat: number; lng: number; source: "zip" | "openstreetmap" };
export type TestPin = TestPinMark & { query: string | null; savedBy?: string; savedAt?: string };

const int = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "n/a");
const players = (n: number) => `${int(n)} ${n === 1 ? "player" : "players"}`;
const dayOf = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

async function authed(path: string, init?: RequestInit) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  const res = await fetch(path, { cache: "no-store", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/** The test pins' state, shared by the map (draws them, takes clicks) and the panel (lists them). */
export function useTestFields(enabled: boolean) {
  const [saved, setSaved] = useState<Saved[]>([]);
  const [ready, setReady] = useState<boolean | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dropping, setDropping] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [impact, setImpact] = useState<TestFieldImpact | null>(null);
  const [impactErr, setImpactErr] = useState<string | null>(null);
  const [impactBusy, setImpactBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const seq = useRef(0);

  const loadSaved = useCallback(async () => {
    if (!enabled) return;
    try {
      const { res, body } = await authed("/api/growth/locations/test-fields");
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setSaved(body.pins as Saved[]); setReady(body.ready === true); setCanEdit(body.canEdit === true); setLoadErr(body.ready ? null : body.error ?? null);
    } catch (e) { setLoadErr(e instanceof Error ? e.message : String(e)); }
  }, [enabled]);
  useEffect(() => { void loadSaved(); }, [loadSaved]);

  const pins: TestPin[] = useMemo(() => [
    ...saved.map((s) => ({ key: s.id, lat: s.lat, lng: s.lng, name: s.name, draft: false, query: s.query, savedBy: s.created_by_name ?? s.created_by_email, savedAt: s.created_at })),
    ...drafts.map((d) => ({ key: d.key, lat: d.lat, lng: d.lng, name: d.name, draft: true, query: d.query })),
  ], [saved, drafts]);

  // The numbers follow the pins: one request per change of the pin set (the reach is answered for all four).
  const pinSig = JSON.stringify(pins.map((p) => [p.key, p.lat, p.lng]));
  useEffect(() => {
    if (!enabled) return;
    if (pins.length === 0) { setImpact(null); setImpactErr(null); return; }
    const n = ++seq.current;
    setImpactBusy(true);
    const t = setTimeout(async () => {
      try {
        const { res, body } = await authed("/api/growth/locations/test-fields/impact", { method: "POST", body: JSON.stringify({ pins: pins.map((p) => ({ key: p.key, lat: p.lat, lng: p.lng })) }) });
        if (n !== seq.current) return;
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setImpact(body as TestFieldImpact); setImpactErr(null);
      } catch (e) { if (n === seq.current) setImpactErr(e instanceof Error ? e.message : String(e)); }
      finally { if (n === seq.current) setImpactBusy(false); }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pinSig]);

  const addDraft = useCallback((lat: number, lng: number, name: string, query: string | null) => {
    const key = `draft-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    setDrafts((d) => [...d, { key, lat, lng, name: name.slice(0, 80), query }]);
    setSelected(key); setMsg(null);
    return key;
  }, []);
  const renameDraft = useCallback((key: string, name: string) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, name: name.slice(0, 80) } : x))), []);
  const discardDraft = useCallback((key: string) => { setDrafts((d) => d.filter((x) => x.key !== key)); setSelected((s) => (s === key ? null : s)); }, []);

  /* SAVE: one POST, no retry; the outcome is the route's read-back. A draft leaves the list only when LANDED. */
  const saveDraft = useCallback(async (key: string) => {
    const d = drafts.find((x) => x.key === key);
    if (!d) return;
    setMsg(null);
    try {
      const { res, body } = await authed("/api/growth/locations/test-fields", { method: "POST", body: JSON.stringify({ name: d.name.trim(), lat: d.lat, lng: d.lng, query: d.query }) });
      const outcome = String(body?.outcome ?? `HTTP ${res.status}`);
      if (outcome === "LANDED") {
        setDrafts((x) => x.filter((y) => y.key !== key));
        if (typeof body.id === "string") setSelected(body.id);
        setMsg({ text: `Saved "${d.name.trim()}". The team can see it now.`, bad: false });
      } else {
        setMsg({ text: `${outcome}${body?.error ? `: ${body.error}` : ""}`, bad: true });
      }
    } catch (e) {
      setMsg({ text: `UNKNOWN: ${e instanceof Error ? e.message : String(e)}. Reload before trying again, it may have saved.`, bad: true });
    }
    await loadSaved();
  }, [drafts, loadSaved]);

  const remove = useCallback(async (id: string) => {
    setMsg(null);
    try {
      const { res, body } = await authed(`/api/growth/locations/test-fields?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const outcome = String(body?.outcome ?? `HTTP ${res.status}`);
      setMsg(outcome === "LANDED" ? { text: "Removed.", bad: false } : { text: `${outcome}${body?.error ? `: ${body.error}` : ""}`, bad: true });
      if (outcome === "LANDED") setSelected((s) => (s === id ? null : s));
    } catch (e) {
      setMsg({ text: `UNKNOWN: ${e instanceof Error ? e.message : String(e)}. Reload to see whether it was removed.`, bad: true });
    }
    await loadSaved();
  }, [loadSaved]);

  return { enabled, pins, ready, canEdit, loadErr, dropping, setDropping, selected, setSelected, impact, impactErr, impactBusy,
    msg, addDraft, renameDraft, discardDraft, saveDraft, remove };
}
export type TestFields = ReturnType<typeof useTestFields>;

export default function LocationsTestFields({ tf, city, reach, onReach, cityName, onFocus }: {
  tf: TestFields;
  city: MapCity | null;
  reach: Reach;
  onReach: (r: Reach) => void;
  cityName: (id: number | null) => string;
  onFocus: (lat: number, lng: number) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const find = async () => {
    const text = q.trim();
    if (text.length < 3) { setSearchErr("Type an address or place name, at least 3 characters."); return; }
    setSearching(true); setSearchErr(null); setHits(null);
    try {
      const { res, body } = await authed(`/api/growth/locations/geocode?q=${encodeURIComponent(text)}`);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setHits(body.hits as Hit[]);
    } catch (e) { setSearchErr(e instanceof Error ? e.message : String(e)); }
    finally { setSearching(false); }
  };
  const pick = (h: Hit) => {
    // The first part of the geocoder's label ("Richardson", "1000 Hampshire Lane") names the pin; it can be renamed before saving.
    const short = h.source === "zip" ? h.label : h.label.split(",").slice(0, 2).join(",").trim();
    tf.addDraft(h.lat, h.lng, short || q.trim(), q.trim());
    onFocus(h.lat, h.lng);
    setHits(null);
  };

  const byKey = new Map((tf.impact?.pins ?? []).map((p) => [p.key, p]));
  const coverage = (tf.impact?.cities ?? []).filter((c) => !city || c.cityId === city.id);
  const leftOut = tf.impact ? (city ? coverage.reduce((s, c) => s + c.leftOut, 0) : tf.impact.leftOut) : null;
  const days = tf.impact?.activeRecentDays ?? 90;
  const saveBlock = tf.ready === false ? "Saving needs migration 0232 first." : !tf.canEdit ? "Only admins can save test fields." : null;

  return (
    <div className="lm-pcard lm-tf" data-testid="test-fields">
      <div className="lm-ptitle">Add a test field</div>
      <form className="lm-tf-find" onSubmit={(e) => { e.preventDefault(); void find(); }}>
        <input className="lm-tf-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Address or place" aria-label="Address or place" data-testid="tf-query" />
        <button type="submit" className="loc-btn" disabled={searching} data-testid="tf-find">{searching ? "Finding..." : "Find"}</button>
      </form>
      <button type="button" className={"loc-btn lm-tf-drop" + (tf.dropping ? " lm-tf-drop-on" : "")} aria-pressed={tf.dropping} data-testid="tf-drop"
        onClick={() => tf.setDropping(!tf.dropping)}>{tf.dropping ? "Cancel pin drop" : "Drop a pin on the map"}</button>
      {searchErr && <div className="lm-tf-msg lm-tf-bad">{searchErr}</div>}
      {hits && (hits.length === 0
        ? <div className="lm-tf-msg">Nothing found.</div>
        : (
          <ul className="lm-tf-hits" data-testid="tf-hits">
            {hits.map((h, i) => (
              <li key={i}><button type="button" className="lm-tf-hit" onClick={() => pick(h)}>{h.label}</button></li>
            ))}
          </ul>
        ))}

      {tf.pins.length > 0 && (
        <>
          {!city && (
            <div className="lm-reach lm-tf-reach" role="group" aria-label="Test field reach">
              <span className="loc-control-label">Reach</span>
              <div className="lm-seg">
                {REACHES.map((r) => (
                  <button type="button" key={r} aria-pressed={reach === r} className={"lm-seg-btn" + (reach === r ? " lm-seg-on" : "")} onClick={() => onReach(r)}>{r} mi</button>
                ))}
              </div>
            </div>
          )}
          {tf.impactErr && <div className="lm-tf-msg lm-tf-bad">Could not work out the numbers: {tf.impactErr}</div>}
          {!tf.impact && !tf.impactErr && <div className="lm-tf-msg">Loading...</div>}
          {coverage.map((c) => (
            <div key={c.cityId} className="lm-tf-cov" data-testid="tf-coverage">
              Coverage at {reach} mi{city ? "" : ` in ${cityName(c.cityId)}`}: <b>{pct(c.before[reach], c.players)}</b> now, <b>{pct(c.after[reach], c.players)}</b> with test fields.
              <span className="lm-tf-covsub"> {int(c.after[reach] - c.before[reach])} more of {players(c.players)}.</span>
            </div>
          ))}
          {city && tf.impact && coverage.length === 0 && <div className="lm-tf-msg">No change to coverage in {city.name}.</div>}
          {leftOut != null && <div className="lm-note" data-testid="tf-left-out">City-level only, left out: {int(leftOut)}</div>}
          {tf.impactBusy && tf.impact && <div className="lm-note">Updating...</div>}

          <ul className="lm-tf-pins">
            {tf.pins.map((p) => {
              const im = byKey.get(p.key);
              const x = im?.byReach[reach];
              const on = tf.selected === p.key;
              return (
                <li key={p.key} className={"lm-tf-pin" + (on ? " lm-tf-pin-on" : "")} data-testid="tf-pin">
                  <div className="lm-tf-pinhead">
                    <span className="lm-tf-tag">Test</span>
                    {p.draft
                      ? <input className="lm-tf-input lm-tf-name" value={p.name} maxLength={80} aria-label="Test field name" onChange={(e) => tf.renameDraft(p.key, e.target.value)} />
                      : <b className="lm-tf-pname">{p.name}</b>}
                    <button type="button" className="loc-btn lm-tf-small" onClick={() => { tf.setSelected(p.key); onFocus(p.lat, p.lng); }}>Show</button>
                  </div>
                  <div className="lm-tf-meta">
                    {p.draft ? "Not saved." : `Added by ${p.savedBy} on ${dayOf(p.savedAt!)}.`}
                    {im && ` ${im.cityId != null ? cityName(im.cityId) : "Outside every market"}.`}
                  </div>
                  {x ? (
                    <table className="lm-tf-nums">
                      <tbody>
                        <tr><td>Players within {reach} mi</td><td className="loc-num">{int(x.players)}</td></tr>
                        <tr><td>New coverage</td><td className="loc-num"><b>{int(x.newCoverage)}</b></td></tr>
                        <tr><td>Played in the last {days} days</td><td className="loc-num">{int(x.activeRecent)}</td></tr>
                        {x.outsideMarket > 0 && <tr><td>Outside every market</td><td className="loc-num">{int(x.outsideMarket)}</td></tr>}
                      </tbody>
                    </table>
                  ) : !tf.impactErr && <div className="lm-note">Loading...</div>}
                  {im && im.nearestFields.length > 0 && (
                    <div className="lm-tf-near">Nearest fields: {im.nearestFields.map((f) => `${f.title} (${f.mi} mi)`).join(", ")}</div>
                  )}
                  <div className="lm-tf-actions">
                    {p.draft ? (
                      <>
                        <button type="button" className="loc-btn" disabled={saveBlock != null || !p.name.trim()} title={saveBlock ?? (p.name.trim() ? "" : "Give it a name first.")}
                          onClick={() => void tf.saveDraft(p.key)} data-testid="tf-save">Save for the team</button>
                        <button type="button" className="loc-btn" onClick={() => tf.discardDraft(p.key)}>Discard</button>
                      </>
                    ) : tf.canEdit ? (
                      confirmRemove === p.key ? (
                        <>
                          <button type="button" className="loc-btn lm-tf-danger" onClick={() => { setConfirmRemove(null); void tf.remove(p.key); }} data-testid="tf-remove-confirm">Yes, remove it</button>
                          <button type="button" className="loc-btn" onClick={() => setConfirmRemove(null)}>Keep it</button>
                        </>
                      ) : <button type="button" className="loc-btn" onClick={() => setConfirmRemove(p.key)} data-testid="tf-remove">Remove</button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {tf.msg && <div className={"lm-tf-msg" + (tf.msg.bad ? " lm-tf-bad" : "")} data-testid="tf-msg">{tf.msg.text}</div>}
      {tf.loadErr && tf.ready !== false && <div className="lm-tf-msg lm-tf-bad">Could not load saved test fields: {tf.loadErr}</div>}
      {tf.ready === false && <div className="lm-note">Saving is not set up yet.</div>}
      <div className="lm-note">Distances in a straight line.</div>
    </div>
  );
}

export const TEST_FIELDS_CSS = `
.lm-tf{border-color:#cbbdf2}
.lm-tf-find{display:flex;gap:6px;margin:8px 0 6px}
.lm-tf-input{flex:1;min-width:0;border:1px solid #c9d3ce;border-radius:7px;padding:6px 8px;font:inherit;font-size:13px}
.lm-tf-drop{width:100%;text-align:left}
.lm-tf-drop-on{background:#efe9fd;border-color:#6b3fd4;color:#3d1f8f}
.lm-tf-hits{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.lm-tf-hit{width:100%;text-align:left;background:#fff;border:1px solid #d8dfdb;border-radius:7px;padding:6px 8px;font:inherit;font-size:12.5px;cursor:pointer}
.lm-tf-hit:hover{border-color:#6b3fd4}
.lm-tf-reach{margin:10px 0 4px}
.lm-tf-cov{margin:8px 0 2px;font-size:13.5px}
.lm-tf-covsub{color:#4f5f57;font-size:12.5px}
.lm-tf-msg{margin-top:6px;font-size:12.5px;color:#4f5f57}
.lm-tf-bad{color:#a2340f}
.lm-tf-pins{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.lm-tf-pin{border:1.5px dashed #b9a6ee;border-radius:9px;padding:8px}
.lm-tf-pin-on{border-color:#6b3fd4;background:#faf8ff}
.lm-tf-pinhead{display:flex;align-items:center;gap:6px}
.lm-tf-tag{background:#6b3fd4;color:#fff;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em}
.lm-tf-pname{flex:1;min-width:0;overflow-wrap:anywhere}
.lm-tf-name{font-weight:700}
.lm-tf-small{padding:2px 8px;font-size:12px}
.lm-tf-meta{font-size:12px;color:#5b6b63;margin:4px 0}
.lm-tf-nums{width:100%;border-collapse:collapse;font-size:12.5px}
.lm-tf-nums td{padding:2px 0;border-bottom:1px solid #eef1ef}
.lm-tf-near{font-size:12px;color:#33433b;margin-top:6px}
.lm-tf-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}
.lm-tf-danger{border-color:#a2340f;color:#a2340f}
`;
