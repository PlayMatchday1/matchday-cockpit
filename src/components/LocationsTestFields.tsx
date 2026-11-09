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
import { ChevronDown, ChevronRight, Eye, EyeOff, MapPin, X } from "lucide-react";

type Saved = { id: string; name: string; lat: number; lng: number; query: string | null; created_by_email: string; created_by_name: string | null; created_at: string };
type Draft = { key: string; lat: number; lng: number; name: string; query: string | null };
type Hit = { label: string; lat: number; lng: number; source: "zip" | "openstreetmap" };
export type TestPin = TestPinMark & { query: string | null; savedBy?: string; savedAt?: string };

const int = (n: number) => n.toLocaleString("en-US");
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
  /* SHOW / HIDE ON MAP (2026-11-08): the eye on a row. View state for this visit only; a hidden pin
   * still counts in every number, it is only left off the map. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const toggleHidden = useCallback((key: string) => setHidden((h) => { const n = new Set(h); if (n.has(key)) n.delete(key); else n.add(key); return n; }), []);
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
        // A landed save says nothing: the pin moving from "Not saved." to "Added by" is the confirmation.
        if (typeof body.id === "string") setSelected(body.id);
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
      // A landed remove says nothing (the pin disappears); only a failure leaves a line in the box.
      if (outcome !== "LANDED") setMsg({ text: `${outcome}${body?.error ? `: ${body.error}` : ""}`, bad: true });
      if (outcome === "LANDED") setSelected((s) => (s === id ? null : s));
    } catch (e) {
      setMsg({ text: `UNKNOWN: ${e instanceof Error ? e.message : String(e)}. Reload to see whether it was removed.`, bad: true });
    }
    await loadSaved();
  }, [loadSaved]);

  return { enabled, pins, ready, canEdit, loadErr, dropping, setDropping, selected, setSelected, impact, impactErr, impactBusy,
    msg, addDraft, renameDraft, discardDraft, saveDraft, remove, hidden, toggleHidden };
}
export type TestFields = ReturnType<typeof useTestFields>;

/** The test pins a view lists: a city's own (its city is the impact route's, the market whose area
 *  holds the pin; a fresh draft shows before that is known), or every pin on All cities. */
export function pinsInView(tf: TestFields, cityId: number | null): TestPin[] {
  if (cityId == null) return tf.pins;
  const byKey = new Map((tf.impact?.pins ?? []).map((p) => [p.key, p.cityId]));
  return tf.pins.filter((p) => byKey.get(p.key) === cityId || (p.draft && !byKey.has(p.key)));
}

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
  /* ONE ROW OPEN AT A TIME (Ryan, 2026-10-29). Selecting a pin, on the map or by its row, opens its
   * details; a new draft is selected when it is added, so it opens with its name box and Save. */
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (tf.selected) setOpen(tf.selected); }, [tf.selected]);

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
    setHits(null); setQ("");
  };

  const byKey = new Map((tf.impact?.pins ?? []).map((p) => [p.key, p]));
  const days = tf.impact?.activeRecentDays ?? 90;
  const cityOf = (key: string) => byKey.get(key)?.cityId;
  const inView = pinsInView(tf, city?.id ?? null);
  const elsewhere = city && tf.impact ? tf.pins.length - inView.length : 0;
  /* ALL CITIES GROUPS BY CITY (2026-11-08): each city collapsed with its "N test" count, outside every
   * market last; the group holding the selected pin opens. */
  const groups: { label: string; pins: TestPin[] }[] = city ? [] : (() => {
    const g = new Map<string, TestPin[]>();
    for (const p of inView) {
      const c = cityOf(p.key);
      const label = c === undefined ? "Working out the city" : c == null ? "Outside every market" : cityName(c);
      g.set(label, [...(g.get(label) ?? []), p]);
    }
    const last = (l: string) => (l === "Outside every market" ? 1 : l === "Working out the city" ? 2 : 0);
    return [...g].sort((a, b) => last(a[0]) - last(b[0]) || a[0].localeCompare(b[0])).map(([label, pins]) => ({ label, pins }));
  })();
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const selGroup = !city && tf.selected ? groups.find((g) => g.pins.some((p) => p.key === tf.selected))?.label ?? null : null;
  useEffect(() => { if (selGroup) setOpenGroups((s) => (s.has(selGroup) ? s : new Set([...s, selGroup]))); }, [selGroup]);
  const saveBlock = tf.ready === false ? "Saving needs migration 0232 first." : !tf.canEdit ? "Only admins can save test fields." : null;

  const row = (p: TestPin, compact: boolean) => {
    const im = byKey.get(p.key);
    const x = im?.byReach[reach];
    const on = tf.selected === p.key;
    const expanded = open === p.key;
    const isHidden = tf.hidden.has(p.key);
    const removeBlock = p.draft ? null : !tf.canEdit ? "Only admins can remove test fields." : null;
    return (
      <li key={p.key} className={"lm-tfr" + (compact ? " lm-tfr-c" : "") + (on ? " lm-tfr-on" : "") + (isHidden ? " lm-tfr-hid" : "")} data-testid="tf-pin">
        <div className="lm-tfr-head">
          <button type="button" className="lm-tfr-main" aria-expanded={expanded} data-testid="tf-pin-toggle"
            title={expanded ? "Hide details" : "Show on the map and see details"}
            onClick={() => { if (expanded) { setOpen(null); return; } tf.setSelected(p.key); setOpen(p.key); onFocus(p.lat, p.lng); }}>
            <i className={"lm-tfr-dot" + (p.draft ? " lm-tfr-dot-draft" : "")} aria-hidden />
            {compact ? (
              <>
                <span className="lm-tfr-name" title={p.name}>{p.name || "Unnamed"}</span>
                <span className="lm-tfr-n" data-testid="tf-pin-players">{x ? int(x.players) : tf.impactErr ? "" : "..."}</span>
              </>
            ) : (
              <span className="lm-tfr-col">
                <b className="lm-tfr-name" title={p.name}>{p.name || "Unnamed"}</b>
                <span className="lm-tfr-sub" data-testid="tf-pin-players">
                  {p.draft ? "Not saved · " : ""}{x ? `${players(x.players)} within ${reach} mi` : tf.impactErr ? "" : "..."}
                </span>
              </span>
            )}
          </button>
          <button type="button" className="lm-tfr-icon" aria-pressed={!isHidden} data-testid="tf-eye"
            title={isHidden ? "Show on the map" : "Hide from the map"} aria-label={isHidden ? `Show ${p.name} on the map` : `Hide ${p.name} from the map`}
            onClick={() => tf.toggleHidden(p.key)}>
            {isHidden ? <EyeOff size={16} strokeWidth={1.33} /> : <Eye size={16} strokeWidth={1.33} />}
          </button>
          <button type="button" className="lm-tfr-icon lm-tfr-x" data-testid="tf-remove" disabled={removeBlock != null}
            title={removeBlock ?? (p.draft ? "Discard this draft" : "Remove for everyone")} aria-label={p.draft ? `Discard ${p.name}` : `Remove ${p.name}`}
            onClick={() => { if (p.draft) tf.discardDraft(p.key); else setConfirmRemove(p.key); }}>
            <X size={14} strokeWidth={1.46} />
          </button>
        </div>
        {confirmRemove === p.key && (
          <div className="lm-tf-actions lm-tfr-pad">
            <span className="lm-tf-meta">Remove {p.name} for everyone?</span>
            <button type="button" className="loc-btn lm-tf-danger lm-tf-small" onClick={() => { setConfirmRemove(null); void tf.remove(p.key); }} data-testid="tf-remove-confirm">Yes, remove it</button>
            <button type="button" className="loc-btn lm-tf-small" onClick={() => setConfirmRemove(null)}>Keep it</button>
          </div>
        )}
        {expanded && (
          <div className="lm-tf-detail lm-tfr-pad" data-testid="tf-pin-detail">
            {p.draft && <input className="lm-tf-input lm-tf-name" value={p.name} maxLength={80} aria-label="Test field name" onChange={(e) => tf.renameDraft(p.key, e.target.value)} />}
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
            <div className="lm-tf-meta">
              {p.draft ? "Not saved." : `Added by ${p.savedBy} on ${dayOf(p.savedAt!)}.`}
              {im && ` ${im.cityId != null ? cityName(im.cityId) : "Outside every market"}.`}
            </div>
            {p.draft && (
              <div className="lm-tf-actions">
                <button type="button" className="loc-btn" disabled={saveBlock != null || !p.name.trim()} title={saveBlock ?? (p.name.trim() ? "" : "Give it a name first.")}
                  onClick={() => void tf.saveDraft(p.key)} data-testid="tf-save">Save for the team</button>
                <button type="button" className="loc-btn" onClick={() => tf.discardDraft(p.key)}>Discard</button>
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="lm-tf" data-testid="test-fields">
      {/* ONE INPUT (2026-11-08): Enter (or Find) looks the text up; the pin button drops one on the map. */}
      <form className="lm-tf-add" onSubmit={(e) => { e.preventDefault(); void find(); }}>
        <div className="lm-tf-box">
          <input className="lm-tf-boxin" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a test field: address or drop a pin"
            aria-label="Add a test field: address or place" data-testid="tf-query" />
          {q.trim() && <button type="submit" className="lm-tf-find" disabled={searching} data-testid="tf-find">{searching ? "Finding..." : "Find"}</button>}
          <button type="button" className={"lm-tf-pinbtn" + (tf.dropping ? " lm-tf-pinbtn-on" : "")} aria-pressed={tf.dropping} data-testid="tf-drop"
            title={tf.dropping ? "Cancel pin drop" : "Drop a pin on the map"} aria-label={tf.dropping ? "Cancel pin drop" : "Drop a pin on the map"}
            onClick={() => tf.setDropping(!tf.dropping)}><MapPin size={15} strokeWidth={1.6} /></button>
        </div>
        {tf.dropping && <div className="lm-tf-msg lm-tf-dropmsg">Click the map to drop a pin. <button type="button" className="lm-tf-link" onClick={() => tf.setDropping(false)}>Cancel</button></div>}
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
        {/* All cities has no Reach control in the bar above the map; the test fields keep theirs here. */}
        {!city && tf.pins.length > 0 && (
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
        {tf.msg && <div className={"lm-tf-msg" + (tf.msg.bad ? " lm-tf-bad" : "")} data-testid="tf-msg">{tf.msg.text}</div>}
        {tf.loadErr && tf.ready !== false && <div className="lm-tf-msg lm-tf-bad">Could not load saved test fields: {tf.loadErr}</div>}
        {tf.ready === false && <div className="lm-note">Saving is not set up yet.</div>}
      </form>

      {city ? (
        <>
          {!tf.impact && tf.pins.some((p) => !p.draft) && !tf.impactErr && <div className="lm-tfr-foot">Finding which test fields are in {city.name}...</div>}
          {tf.impact && inView.length === 0 && <div className="lm-tfr-foot" data-testid="tf-none-here">No test fields in {city.name} yet.</div>}
          {inView.length > 0 && <ul className="lm-tfr-list">{inView.map((p) => row(p, false))}</ul>}
          {elsewhere > 0 && <div className="lm-tfr-foot" data-testid="tf-elsewhere">{elsewhere} more test {elsewhere === 1 ? "field" : "fields"} in other cities</div>}
        </>
      ) : groups.length === 0 ? (
        tf.pins.length === 0 && <div className="lm-tfr-foot">No test fields yet.</div>
      ) : (
        <ul className="lm-tfr-list">
          {groups.map((g) => {
            const isOpen = openGroups.has(g.label);
            return (
              <li key={g.label} className="lm-tfg" data-testid="tf-city">
                <button type="button" className={"lm-tfg-head" + (isOpen ? " lm-tfg-open" : "")} aria-expanded={isOpen}
                  onClick={() => setOpenGroups((s) => { const n = new Set(s); if (n.has(g.label)) n.delete(g.label); else n.add(g.label); return n; })}>
                  {isOpen ? <ChevronDown size={12} strokeWidth={1.25} /> : <ChevronRight size={12} strokeWidth={1.25} />}
                  <span className="lm-tfg-name">{g.label}</span>
                  <span className="lm-tfg-n">{g.pins.length} test</span>
                </button>
                {isOpen && <ul className="lm-tfr-list">{g.pins.map((p) => row(p, true))}</ul>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export const TEST_FIELDS_CSS = `
.lm-tf{display:flex;flex-direction:column}
.lm-tf-add{padding:8px 14px 10px}
.lm-tf-box{display:flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:8px;padding:0 4px 0 10px;background:#fff}
.lm-tf-box:focus-within{border-color:#7b4fd6}
.lm-tf-boxin{flex:1;min-width:0;border:0;outline:0;background:transparent;padding:8px 0;font:inherit;font-size:12px;color:var(--forest)}
.lm-tf-boxin::placeholder{color:#9aaba5}
.lm-tf-find{border:0;background:none;font:inherit;font-size:12px;font-weight:700;color:#7b4fd6;padding:4px 6px;cursor:pointer}
.lm-tf-pinbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:none;color:#6b807a;cursor:pointer}
.lm-tf-pinbtn:hover{background:#f6f8f7;color:#7b4fd6}
.lm-tf-pinbtn-on{background:#f1ecfc;color:#7b4fd6}
.lm-tf-dropmsg{color:#7b4fd6}
.lm-tf-link{border:0;background:none;padding:0;font:inherit;font-weight:700;color:inherit;text-decoration:underline;cursor:pointer}
.lm-tf-input{flex:1;min-width:0;border:1px solid #c9d3ce;border-radius:7px;padding:6px 8px;font:inherit;font-size:13px}
.lm-tf-hits{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:4px}
.lm-tf-hit{width:100%;text-align:left;background:#fff;border:1px solid #d8dfdb;border-radius:7px;padding:6px 8px;font:inherit;font-size:12.5px;cursor:pointer}
.lm-tf-hit:hover{border-color:#7b4fd6}
.lm-tf-reach{margin:10px 0 0}
.lm-tf-msg{margin-top:6px;font-size:12px;color:#4f5f57}
.lm-tf-bad{color:#a2340f}
.lm-tfr-list{list-style:none;margin:0;padding:0}
.lm-tfr{border-top:1px solid var(--line)}
.lm-tfr-on{background:#faf8ff}
.lm-tfr-head{display:flex;align-items:center;gap:6px;padding:0 10px 0 0}
.lm-tfr-main{flex:1;min-width:0;display:flex;align-items:center;gap:10px;border:0;background:none;padding:11px 0 11px 18px;font:inherit;text-align:left;cursor:pointer;color:var(--forest)}
.lm-tfr-c .lm-tfr-main{padding-left:40px}
.lm-tfr-dot{flex:none;width:10px;height:10px;border-radius:50%;background:#7b4fd6}
.lm-tfr-c .lm-tfr-dot{width:8px;height:8px}
.lm-tfr-dot-draft{background:#fff;border:2px dashed #7b4fd6}
.lm-tfr-hid .lm-tfr-dot{opacity:.35}
.lm-tfr-hid .lm-tfr-name{color:#6b807a}
.lm-tfr-col{min-width:0;display:flex;flex-direction:column;gap:1px}
.lm-tfr-name{min-width:0;font-size:13px;font-weight:600;color:var(--forest);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lm-tfr-c .lm-tfr-name{flex:1;font-size:12px;font-weight:500}
.lm-tfr-sub{font-size:11px;color:#6b807a;font-variant-numeric:tabular-nums}
.lm-tfr-n{font-size:12px;font-weight:600;color:#6b807a;font-variant-numeric:tabular-nums}
.lm-tfr-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:none;color:#6b807a;cursor:pointer}
.lm-tfr-x{color:#9aaba5}
.lm-tfr-icon:hover:not(:disabled){background:#f6f8f7;color:var(--forest)}
.lm-tfr-icon:disabled{opacity:.35;cursor:not-allowed}
.lm-tfr-pad{padding:0 14px 10px 38px}
.lm-tfr-foot{border-top:1px solid var(--line);padding:10px 18px 12px;font-size:12px;font-weight:500;color:#9aaba5}
.lm-tfg{border-top:1px solid var(--line)}
.lm-tfg-head{width:100%;display:flex;align-items:center;gap:10px;border:0;background:#fff;padding:11px 14px 11px 18px;font:inherit;text-align:left;cursor:pointer;color:#6b807a}
.lm-tfg-open{background:#f6f8f7}
.lm-tfg-name{flex:1;min-width:0;font-size:13px;font-weight:700;color:var(--forest)}
.lm-tfg-n{background:#f1ecfc;color:#7b4fd6;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:600}
.lm-tf-name{font-weight:700;width:100%;margin-bottom:4px}
.lm-tf-small{padding:2px 8px;font-size:12px}
.lm-tf-meta{font-size:12px;color:#5b6b63;margin:4px 0}
.lm-tf-nums{width:100%;border-collapse:collapse;font-size:12.5px}
.lm-tf-nums td{padding:2px 0;border-bottom:1px solid #eef1ef}
.lm-tf-near{font-size:12px;color:#33433b;margin-top:6px}
.lm-tf-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}
.lm-tf-danger{border-color:#a2340f;color:#a2340f}
`;
