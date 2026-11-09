"use client";

// PLAYER DATA ROOM — a campaign list builder (rebuilt 2026-11-09, Figma sl6PTy5LhCVj1gF0HvGmuF frames
// 34:3 Played, 34:205 Never played, 36:2 Pivot).
//
// WHY. Miguel builds lists for Klaviyo campaigns and DMs and still used the Master File, because the
// old pivot could not be cleared and always held something selected. Two lists cover nearly every
// campaign — registered and never played, and players who played at given fields — so those are the
// first two tabs; the pivot is the third, and it opens BLANK.
//
// Every list and table is one call to /api/lifecycle/dataroom, which runs one SQL function (0267).
// Players, matches and "played" mean what Churn's 0264 means: an own PLAYER spot, not a match the
// person managed, on a day before today. Fake, staff (@matchday.com / @playmatchday.com) and deleted
// accounts are never listed. Revenue in the pivot is Finance's net (pre-tax), the Finance > Revenue
// figure, which is recorded by month and venue.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  QUICK_LABEL, SHOW_LABEL, PIVOT_DIMS, REVENUE_DIMS, SEP, WITHIN_DAYS,
  cityName, describeNever, describePlayed, drillToPlayed, emptyPlayed, monthAdd, monthShort, periodLabel, pivotReady, revenueBlocked,
  type NeverFilters, type PivotDim, type PivotShow, type PivotSpec, type PivotTableData, type PlayedFilters, type QuickPeriod, type SortKey,
} from "@/lib/dataRoomLists";
import { heatColour, heatStep } from "@/lib/dataRoom";

type Tab = "played" | "never" | "pivot";
type Meta = {
  cities: { code: string; name: string }[];
  fields: { id: number; title: string; city: string | null }[];
  fold: Record<number, number>;
  venues: { id: number; name: string; fields: number[] }[];
  months: { first: string; last: string };
  fieldsNote: string | null;
  today: string;
};
type ListRow = {
  id: number; name: string; email: string | null; phone: string; noEmail: boolean; noPhone: boolean;
  city: string | null; home: string | null; matches?: number; lastPlayed?: string; signedUp?: string;
};
type ListResult = { count: number; noEmail: number; noPhone: number; rows: ListRow[] };
type Saved = { id: string; name: string; tab: "played" | "never"; filters: unknown };
type PivotResult = { table: PivotTableData; labels: Record<string, string>; colLabels: Record<string, string>; spec: PivotSpec } | { blocked: string } | { empty: true };

const num = (n: number) => n.toLocaleString("en-US");
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (ymd: string | undefined, today: string) => {
  if (!ymd) return "";
  const d = ymd.slice(0, 10);
  return `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}${d.slice(0, 4) !== today.slice(0, 4) ? `, ${d.slice(0, 4)}` : ""}`;
};
const chicagoDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));
const daysSince = (iso: string, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${chicagoDay(iso)}T00:00:00Z`)) / 86_400_000);
const monthsBetween = (a: string, b: string) => { const out: string[] = []; for (let m = a; m <= b; m = monthAdd(m, 1)) out.push(m); return out; };

type Preset = { name: string; rows: PivotDim[]; col: PivotDim | null; show: PivotShow };
// KEPT — the five "start from" views. Spots per player by field shows spots; the old two-value cell
// (spots and players side by side) is one value now that Show is a single choice.
const PRESETS: Preset[] = [
  { name: "Players by city by month", rows: ["City"], col: "Month", show: "players" },
  { name: "Spots per player by field", rows: ["Field"], col: null, show: "spots" },
  { name: "Revenue by cohort year", rows: ["Cohort year"], col: null, show: "revenue" },
  { name: "New players by city", rows: ["City"], col: "Month", show: "new" },
  { name: "Field by month", rows: ["City", "Field"], col: "Month", show: "spots" },
];

export default function DataRoomPanel({ authHeaders }: { authHeaders: Record<string, string> }) {
  const [tab, setTab] = useState<Tab>("played");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [played, setPlayed] = useState<PlayedFilters>(emptyPlayed());
  const [never, setNever] = useState<NeverFilters | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const [result, setResult] = useState<ListResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [savedReady, setSavedReady] = useState<boolean | null>(null);
  const [activeList, setActiveList] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);   // the name being typed, or null
  const [saveMsg, setSaveMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<null | "fields" | "period" | "signup">(null);

  /* A FRESH TOKEN ON EVERY REQUEST. The page's authHeaders are read once at mount; after an hour the
   * token has expired and every call would 401. supabase-js refreshes the session itself. */
  const headers = useCallback(async (): Promise<Record<string, string>> => {
    const { data } = await supabase.auth.getSession();
    const t = data.session?.access_token;
    return t ? { Authorization: `Bearer ${t}` } : authHeaders;
  }, [authHeaders]);
  const post = useCallback(async <T,>(body: unknown): Promise<T> => {
    const res = await fetch("/api/lifecycle/dataroom", { method: "POST", headers: { "Content-Type": "application/json", ...(await headers()) }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !j) throw new Error(j?.error ?? `Request failed (${res.status})`);
    return j;
  }, [headers]);

  const loadSaved = useCallback(async () => {
    const res = await fetch("/api/lifecycle/dataroom/lists", { headers: await headers(), cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setSaved(j.lists ?? []); setSavedReady(j.ready === true); }
    else setSavedReady(false);
  }, [headers]);

  useEffect(() => {
    if (!Object.keys(authHeaders).length) return;
    let alive = true;
    post<Meta>({ mode: "meta" })
      .then((m) => { if (alive) { setMeta(m); setNever((n) => n ?? { from: monthAdd(m.today.slice(0, 7), -1), to: monthAdd(m.today.slice(0, 7), -1), city: null }); } })
      .catch((e) => { if (alive) setMetaErr(e instanceof Error ? e.message : String(e)); });
    void loadSaved();
    return () => { alive = false; };
  }, [authHeaders, post, loadSaved]);

  // ── the list ──────────────────────────────────────────────────────────────────────────────────
  const listBody = useMemo(() => (tab === "played" ? { mode: "played", filters: played, sort } : { mode: "never", filters: never, sort }), [tab, played, never, sort]);
  useEffect(() => {
    if (!meta || tab === "pivot" || (tab === "never" && !never)) return;
    let alive = true;
    setBusy(true); setErr(null);
    const t = setTimeout(() => {
      post<ListResult>(listBody)
        .then((r) => { if (alive) { setResult(r); setBusy(false); } })
        .catch((e) => { if (alive) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); } });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [meta, tab, never, listBody, post]);

  const fieldTitle = useCallback((id: number) => meta?.fields.find((f) => f.id === id)?.title ?? `Field ${id}`, [meta]);
  const today = meta?.today ?? "";
  const description = !meta ? "" : tab === "played" ? describePlayed(played, today, fieldTitle) : never ? describeNever(never, today) : "";
  const editPlayed = (patch: Partial<PlayedFilters>) => { setPlayed((f) => ({ ...f, ...patch })); setActiveList(null); };
  const editNever = (patch: Partial<NeverFilters>) => { setNever((f) => (f ? { ...f, ...patch } : f)); setActiveList(null); };
  const switchTab = (t: Tab) => { setTab(t); setResult(null); setSort(null); setOpen(null); setSaving(null); setSaveMsg(null); };

  const applySaved = (s: Saved) => {
    setActiveList(s.id); setSaveMsg(null); setSaving(null);
    if (s.tab === "played") { setPlayed({ ...emptyPlayed(), ...(s.filters as PlayedFilters) }); if (tab !== "played") switchTab("played"); }
    else { setNever(s.filters as NeverFilters); if (tab !== "never") switchTab("never"); }
  };
  const saveList = async () => {
    const name = (saving ?? "").trim();
    if (!name) return;
    setSaveMsg(null);
    try {
      const res = await fetch("/api/lifecycle/dataroom/lists", { method: "POST", headers: { "Content-Type": "application/json", ...(await headers()) },
        body: JSON.stringify({ name, tab, filters: tab === "played" ? played : never }) });
      const j = await res.json().catch(() => ({}));
      if (j.outcome === "LANDED") { setSaving(null); await loadSaved(); if (j.id) setActiveList(j.id); }
      else setSaveMsg({ text: `${j.outcome ?? `HTTP ${res.status}`}${j.error ? `: ${j.error}` : ""}`, bad: true });
    } catch (e) {
      setSaveMsg({ text: `UNKNOWN: ${e instanceof Error ? e.message : String(e)}. Reload to see whether it saved.`, bad: true });
    }
  };
  const removeList = async (id: string) => {
    setConfirmRemove(null); setSaveMsg(null);
    try {
      const res = await fetch(`/api/lifecycle/dataroom/lists?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: await headers() });
      const j = await res.json().catch(() => ({}));
      if (j.outcome !== "LANDED") setSaveMsg({ text: `${j.outcome ?? `HTTP ${res.status}`}${j.error ? `: ${j.error}` : ""}`, bad: true });
    } catch (e) {
      setSaveMsg({ text: `UNKNOWN: ${e instanceof Error ? e.message : String(e)}. Reload to see whether it was removed.`, bad: true });
    }
    if (activeList === id) setActiveList(null);
    await loadSaved();
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const listName = saved.find((s) => s.id === activeList)?.name ?? (tab === "played" ? "played" : "never-played");
      const res = await fetch("/api/lifecycle/dataroom", { method: "POST", headers: { "Content-Type": "application/json", ...(await headers()) },
        body: JSON.stringify({ mode: tab === "played" ? "playedCsv" : "neverCsv", filters: tab === "played" ? played : never, name: listName }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${res.status}`); }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = /filename="([^"]+)"/.exec(cd)?.[1] ?? "players.csv";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { setErr(`Export failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setExporting(false); }
  };
  const toggleSort = (key: SortKey) => setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "email" || key === "city" ? "asc" : "desc" }));

  // ── the pivot ─────────────────────────────────────────────────────────────────────────────────
  const blankSpec = useCallback((): PivotSpec => {
    const last = meta ? monthAdd(meta.today.slice(0, 7), -1) : "";
    return { rows: [], col: null, show: null, from: meta ? monthAdd(last, -5) : "", to: last, city: null, fieldId: null };
  }, [meta]);
  const [spec, setSpec] = useState<PivotSpec | null>(null);
  const [preset, setPreset] = useState<number | null>(null);
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [pivotBusy, setPivotBusy] = useState(false);
  const [pivotErr, setPivotErr] = useState<string | null>(null);
  useEffect(() => { if (meta && !spec) setSpec(blankSpec()); }, [meta, spec, blankSpec]);
  const editSpec = (patch: Partial<PivotSpec>) => { setSpec((s) => (s ? { ...s, ...patch } : s)); setPreset(null); };
  useEffect(() => {
    if (tab !== "pivot" || !spec) return;
    if (!pivotReady(spec)) { setPivot(null); setPivotErr(null); setPivotBusy(false); return; }
    const blocked = revenueBlocked(spec);
    if (blocked) { setPivot({ blocked }); setPivotErr(null); setPivotBusy(false); return; }
    let alive = true;
    setPivotBusy(true); setPivotErr(null);
    const t = setTimeout(() => {
      post<PivotResult>({ mode: "pivot", spec })
        .then((r) => { if (alive) { setPivot(r); setPivotBusy(false); } })
        .catch((e) => { if (alive) { setPivotErr(e instanceof Error ? e.message : String(e)); setPivotBusy(false); } });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [tab, spec, post]);
  const drill = (rowKey: string, colKey: string) => {
    if (!spec || !meta) return;
    const venueFields = (v: string) => (meta.venues.find((x) => String(x.id) === v)?.fields ?? []).filter((id) => meta.fields.some((f) => f.id === id));
    const f = drillToPlayed(spec, rowKey, colKey, venueFields);
    if (!f) return;
    setPlayed(f); setActiveList(null); switchTab("played");
  };
  const drillable = !!spec && spec.show !== "new" && ![...spec.rows, spec.col].some((d) => d === "Cohort month" || d === "Cohort year");

  if (metaErr) return <div className="dr-state">Couldn&apos;t open the Data Room: {metaErr} <button type="button" className="dr-link" onClick={() => location.reload()}>Reload</button></div>;

  const fieldsForCity = (c: string | null) => (meta?.fields ?? []).filter((f) => !c || f.city === c);
  const months = meta ? monthsBetween(meta.months.first, meta.months.last) : [];
  const fieldsLabel = played.fieldIds.length === 0 ? "All fields" : played.fieldIds.length === 1 ? fieldTitle(played.fieldIds[0]) : `${played.fieldIds.length} fields`;
  const matchKey = played.matches.max != null ? "range" : String(played.matches.min);

  return (
    <section className="dr" data-testid="dataroom">
      <div className="dr-head">
        <p className="dr-sub">{tab === "pivot" ? "Slice players, spots or revenue any way you want" : "Build a player list for a campaign, then export it"}</p>
        <div className="dr-seg dr-tabs" role="tablist" aria-label="Data Room">
          {(["played", "never", "pivot"] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} data-testid={`dr-tab-${t}`} className={tab === t ? "on" : ""} onClick={() => switchTab(t)}>
              {t === "played" ? "Played" : t === "never" ? "Never played" : "Pivot"}
            </button>
          ))}
        </div>
      </div>

      {tab !== "pivot" && (
        <div className="dr-chips" data-testid="dr-saved">
          <span className="dr-chips-l">Saved lists</span>
          {savedReady === false && <span className="dr-muted">Saved lists need migration 0267 first.</span>}
          {savedReady && saved.length === 0 && <span className="dr-muted">None yet. Build a list and press Save list.</span>}
          {saved.map((s) => (
            <span key={s.id} className={`dr-chip${activeList === s.id ? " on" : ""}`}>
              <button type="button" onClick={() => applySaved(s)} title={s.tab === "never" ? "Never played list" : "Played list"}>{s.name}</button>
              <button type="button" className="dr-chip-x" aria-label={`Remove ${s.name}`} onClick={() => setConfirmRemove(s.id)}>×</button>
            </span>
          ))}
          {confirmRemove && (
            <span className="dr-confirm">Remove “{saved.find((s) => s.id === confirmRemove)?.name}” for everyone?
              <button type="button" className="dr-link dr-danger" onClick={() => void removeList(confirmRemove)}>Remove</button>
              <button type="button" className="dr-link" onClick={() => setConfirmRemove(null)}>Keep</button>
            </span>
          )}
        </div>
      )}

      {tab === "played" && meta && (
        <div className="dr-card dr-filters" data-testid="dr-played-filters">
          <div className="dr-frow">
            <label className="dr-f"><span>City</span>
              <select className="dr-pill" value={played.city ?? ""} onChange={(e) => {
                const c = e.target.value || null;
                editPlayed({ city: c, fieldIds: c ? played.fieldIds.filter((id) => fieldsForCity(c).some((f) => f.id === id)) : played.fieldIds });
              }}>
                <option value="">All cities</option>
                {meta.cities.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <div className="dr-f"><span>Fields</span>
              <button type="button" className="dr-pill dr-drop" data-testid="dr-fields" aria-expanded={open === "fields"} onClick={() => setOpen(open === "fields" ? null : "fields")}>{fieldsLabel}</button>
              {open === "fields" && (
                <div className="dr-pop dr-pop-fields" data-testid="dr-fields-pop">
                  <div className="dr-pop-top">
                    <button type="button" className="dr-link" onClick={() => editPlayed({ fieldIds: [] })}>All fields</button>
                    <button type="button" className="dr-link" onClick={() => setOpen(null)}>Done</button>
                  </div>
                  {(played.city ? [played.city] : meta.cities.map((c) => c.code)).map((code) => {
                    const fs = fieldsForCity(code);
                    if (!fs.length) return null;
                    return (
                      <div key={code}>
                        {!played.city && <div className="dr-pop-h">{cityName(code)}</div>}
                        {fs.map((f) => (
                          <label key={f.id} className="dr-check">
                            <input type="checkbox" checked={played.fieldIds.includes(f.id)}
                              onChange={(e) => editPlayed({ fieldIds: e.target.checked ? [...played.fieldIds, f.id] : played.fieldIds.filter((x) => x !== f.id) })} />
                            {f.title}
                          </label>
                        ))}
                      </div>
                    );
                  })}
                  {meta.fieldsNote && <div className="dr-pop-note">{meta.fieldsNote}</div>}
                </div>
              )}
            </div>
            <div className="dr-f"><span>Played between</span>
              <button type="button" className="dr-pill dr-drop" data-testid="dr-period" aria-expanded={open === "period"} onClick={() => setOpen(open === "period" ? null : "period")}>{periodLabel(played.period, today)}</button>
              {open === "period" && (
                <div className="dr-pop" data-testid="dr-period-pop">
                  <div className="dr-quick">
                    <button type="button" className={!played.period ? "on" : ""} onClick={() => { editPlayed({ period: null }); setOpen(null); }}>Any time</button>
                    {(Object.keys(QUICK_LABEL) as QuickPeriod[]).map((q) => (
                      <button key={q} type="button" className={played.period && "quick" in played.period && played.period.quick === q ? "on" : ""}
                        onClick={() => { editPlayed({ period: { quick: q } }); setOpen(null); }}>{QUICK_LABEL[q]}</button>
                    ))}
                  </div>
                  <div className="dr-pop-h">Custom months</div>
                  <div className="dr-range">
                    {(() => {
                      const cur = played.period && "from" in played.period ? played.period : { from: monthAdd(today.slice(0, 7), -3), to: monthAdd(today.slice(0, 7), -1) };
                      return (<>
                        <select aria-label="From month" value={cur.from} onChange={(e) => editPlayed({ period: { from: e.target.value, to: e.target.value > cur.to ? e.target.value : cur.to } })}>
                          {months.map((m) => <option key={m} value={m}>{monthShort(m)}</option>)}
                        </select>
                        <span>to</span>
                        <select aria-label="To month" value={cur.to} onChange={(e) => editPlayed({ period: { from: e.target.value < cur.from ? e.target.value : cur.from, to: e.target.value } })}>
                          {months.map((m) => <option key={m} value={m}>{monthShort(m)}</option>)}
                        </select>
                      </>);
                    })()}
                  </div>
                </div>
              )}
            </div>
            <div className="dr-f"><span>Player type</span>
              <div className="dr-seg">
                {([["all", "All"], ["members", "Members"], ["non_members", "Non-members"]] as const).map(([k, l]) => (
                  <button key={k} type="button" className={played.type === k ? "on" : ""} aria-pressed={played.type === k} onClick={() => editPlayed({ type: k })}>{l}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="dr-frow">
            <label className="dr-f"><span>Matches in that period</span>
              <span className="dr-inline">
                <select className="dr-pill" data-testid="dr-matches" value={matchKey} onChange={(e) => {
                  const v = e.target.value;
                  editPlayed({ matches: v === "range" ? { min: played.matches.min, max: Math.max(played.matches.min, played.matches.min + 2) } : { min: Number(v), max: null } });
                }}>
                  {[1, 2, 3, 4, 5, 6, 8, 10, 15, 20].map((n) => <option key={n} value={String(n)}>{n === 1 ? "1 or more" : `${n} or more`}</option>)}
                  <option value="range">Exact range…</option>
                </select>
                {played.matches.max != null && (
                  <span className="dr-minmax">
                    <input type="number" min={1} aria-label="At least" value={played.matches.min}
                      onChange={(e) => { const min = Math.max(1, Number(e.target.value) || 1); editPlayed({ matches: { min, max: Math.max(min, played.matches.max ?? min) } }); }} />
                    <span>to</span>
                    <input type="number" min={1} aria-label="At most" value={played.matches.max}
                      onChange={(e) => { const max = Math.max(1, Number(e.target.value) || 1); editPlayed({ matches: { min: Math.min(played.matches.min, max), max } }); }} />
                  </span>
                )}
              </span>
            </label>
            <div className="dr-f"><span>Last played within</span>
              <div className="dr-seg">
                <button type="button" className={played.within == null ? "on" : ""} aria-pressed={played.within == null} onClick={() => editPlayed({ within: null })}>Any</button>
                {WITHIN_DAYS.map((d) => (
                  <button key={d} type="button" className={played.within === d ? "on" : ""} aria-pressed={played.within === d} onClick={() => editPlayed({ within: d })}>{d}d</button>
                ))}
              </div>
            </div>
            <button type="button" className="dr-link dr-clear" data-testid="dr-clear" onClick={() => { setPlayed(emptyPlayed()); setActiveList(null); setOpen(null); }}>Clear all</button>
          </div>
        </div>
      )}

      {tab === "never" && meta && never && (
        <div className="dr-card dr-filters" data-testid="dr-never-filters">
          <div className="dr-frow">
            <div className="dr-f"><span>Signed up in</span>
              <button type="button" className="dr-pill dr-drop" aria-expanded={open === "signup"} onClick={() => setOpen(open === "signup" ? null : "signup")}>
                {never.from === never.to ? monthShort(never.from).replace(/^(\w+)/, (m) => ({ Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December" } as Record<string, string>)[m] ?? m) : `${monthShort(never.from)} – ${monthShort(never.to)}`}
              </button>
              {open === "signup" && (
                <div className="dr-pop">
                  <div className="dr-quick">
                    {[0, -1, -2].map((n) => { const m = monthAdd(today.slice(0, 7), n); return (
                      <button key={n} type="button" className={never.from === m && never.to === m ? "on" : ""} onClick={() => { editNever({ from: m, to: m }); setOpen(null); }}>{monthShort(m)}</button>
                    ); })}
                  </div>
                  <div className="dr-pop-h">Month range</div>
                  <div className="dr-range">
                    <select aria-label="From month" value={never.from} onChange={(e) => editNever({ from: e.target.value, to: e.target.value > never.to ? e.target.value : never.to })}>
                      {months.map((m) => <option key={m} value={m}>{monthShort(m)}</option>)}
                    </select>
                    <span>to</span>
                    <select aria-label="To month" value={never.to} onChange={(e) => editNever({ from: e.target.value < never.from ? e.target.value : never.from, to: e.target.value })}>
                      {months.map((m) => <option key={m} value={m}>{monthShort(m)}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>
            <label className="dr-f"><span>City</span>
              <select className="dr-pill" value={never.city ?? ""} onChange={(e) => editNever({ city: e.target.value || null })}>
                <option value="">All cities</option>
                {meta.cities.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}

      {tab !== "pivot" && (
        <div className="dr-card dr-results" data-testid="dr-results">
          <div className="dr-rhead">
            <div className="dr-rtitle">
              <b data-testid="dr-count">{!meta || (busy && !result) ? "…" : result ? `${num(result.count)} ${result.count === 1 ? "player" : "players"}` : "—"}</b>
              <span data-testid="dr-desc">{description}</span>
              {result && (result.noEmail > 0 || result.noPhone > 0) && (
                <span className="dr-gaps" data-testid="dr-gaps">{[result.noEmail ? `${num(result.noEmail)} without an email` : "", result.noPhone ? `${num(result.noPhone)} without a usable phone` : ""].filter(Boolean).join(" · ")}. Still listed and exported, flagged.</span>
              )}
            </div>
            <span className="dr-sp" />
            {saving == null ? (
              <button type="button" className="dr-btn" data-testid="dr-save" disabled={savedReady !== true}
                title={savedReady === true ? "Save these filters (not the players) under a name" : "Saved lists need migration 0267 first."}
                onClick={() => { setSaving(""); setSaveMsg(null); }}>Save list</button>
            ) : (
              <form className="dr-saveform" onSubmit={(e) => { e.preventDefault(); void saveList(); }}>
                <input autoFocus value={saving} maxLength={80} placeholder="List name" aria-label="List name" onChange={(e) => setSaving(e.target.value)} />
                <button type="submit" className="dr-btn" disabled={!saving.trim()}>Save</button>
                <button type="button" className="dr-link" onClick={() => setSaving(null)}>Cancel</button>
              </form>
            )}
            <button type="button" className="dr-btn dr-primary" data-testid="dr-export" disabled={!result || result.count === 0 || exporting} onClick={() => void exportCsv()}>
              {exporting ? "Exporting…" : "Export CSV for Klaviyo"}
            </button>
          </div>
          {saveMsg && <div className={`dr-msg${saveMsg.bad ? " bad" : ""}`}>{saveMsg.text}</div>}
          {err && <div className="dr-msg bad">{err}</div>}
          <div className="dr-tablewrap">
            <table className="dr-table" data-testid="dr-table">
              <thead>
                <tr>
                  {(tab === "played"
                    ? [["name", "Player"], ["email", "Email"], ["phone", "Phone"], ["city", "City"], ["matches", "Matches"], ["lastPlayed", "Last played"]]
                    : [["name", "Player"], ["email", "Email"], ["phone", "Phone"], ["city", "City"], ["signedUp", "Signed up"], ["signedUp", "Days since"]]
                  ).map(([k, l], i) => (
                    <th key={`${k}${i}`} aria-sort={sort?.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" onClick={() => toggleSort(k as SortKey)}>{l}{sort?.key === k ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result?.rows.map((r) => (
                  <tr key={r.id} data-testid="dr-row">
                    <td className="dr-name">{r.name}</td>
                    <td className="dr-email">{r.email ?? <span className="dr-flag">No email</span>}</td>
                    <td>{r.phone || <span className="dr-flag">No phone</span>}</td>
                    <td>{cityName(r.city ?? r.home)}</td>
                    {tab === "played" ? (<>
                      <td>{num(r.matches ?? 0)}</td>
                      <td>{shortDay(r.lastPlayed, today)}</td>
                    </>) : (<>
                      <td>{r.signedUp ? shortDay(chicagoDay(r.signedUp), today) : ""}</td>
                      <td>{r.signedUp ? num(daysSince(r.signedUp, today)) : ""}</td>
                    </>)}
                  </tr>
                ))}
                {result && result.rows.length === 0 && !busy && <tr><td colSpan={6} className="dr-empty">No players match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="dr-foot">
            {result && result.count > 0 ? `Showing first ${num(result.rows.length)} · export includes all ${num(result.count)}` : busy ? "Building the list…" : ""}
            {busy && result ? " · updating" : ""}
          </div>
        </div>
      )}

      {tab === "pivot" && meta && spec && (
        <>
          <div className="dr-chips">
            <span className="dr-chips-l">Or start from a view</span>
            {PRESETS.map((p, i) => {
              const blocked = revenueBlocked({ rows: p.rows, col: p.col, show: p.show });
              return (
                <span key={p.name} className={`dr-chip${preset === i ? " on" : ""}${blocked ? " off" : ""}`}>
                  <button type="button" disabled={!!blocked} title={blocked ?? undefined}
                    onClick={() => { setSpec({ ...spec, rows: [...p.rows], col: p.col, show: p.show }); setPreset(i); }}>{p.name}</button>
                </span>
              );
            })}
          </div>
          <div className="dr-card dr-filters" data-testid="dr-pivot-builder">
            <div className="dr-frow">
              <div className="dr-f"><span>Rows</span>
                <span className="dr-inline">
                  {spec.rows.map((d) => (
                    <span key={d} className="dr-tag" data-testid="dr-chip-row">{d}<button type="button" aria-label={`Remove ${d} from rows`} onClick={() => editSpec({ rows: spec.rows.filter((x) => x !== d) })}>×</button></span>
                  ))}
                  {spec.rows.length < 2 && (
                    <select className={`dr-pill${spec.rows.length ? "" : " dr-dashed"}`} data-testid="dr-rows" value="" aria-label="Add rows"
                      onChange={(e) => e.target.value && editSpec({ rows: [...spec.rows, e.target.value as PivotDim] })}>
                      <option value="">{spec.rows.length ? "Add…" : "Add rows…"}</option>
                      {PIVOT_DIMS.filter((d) => !spec.rows.includes(d) && d !== spec.col).map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  )}
                </span>
              </div>
              <div className="dr-f"><span>Columns</span>
                <select className={`dr-pill${spec.col ? "" : " dr-dashed"}`} data-testid="dr-cols" value={spec.col ?? ""} aria-label="Columns"
                  onChange={(e) => editSpec({ col: (e.target.value || null) as PivotDim | null })}>
                  <option value="">{spec.col ? "None" : "Add columns…"}</option>
                  {PIVOT_DIMS.filter((d) => !spec.rows.includes(d)).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <button type="button" className="dr-link dr-swap" data-testid="dr-swap"
                disabled={spec.rows.length > 1 || (!spec.rows.length && !spec.col)}
                title={spec.rows.length > 1 ? "Rows holds two fields and Columns one, so a swap would drop one" : "Exchange rows and columns"}
                onClick={() => editSpec({ rows: spec.col ? [spec.col] : [], col: spec.rows[0] ?? null })}>⇄ Swap</button>
              <label className="dr-f"><span>Show</span>
                <select className={`dr-pill${spec.show ? "" : " dr-dashed"}`} data-testid="dr-show" value={spec.show ?? ""} onChange={(e) => editSpec({ show: (e.target.value || null) as PivotShow | null })}>
                  <option value="">Choose what to show…</option>
                  {(Object.keys(SHOW_LABEL) as PivotShow[]).map((k) => <option key={k} value={k}>{SHOW_LABEL[k]}</option>)}
                </select>
              </label>
              <div className="dr-f"><span>From</span>
                <span className="dr-inline">
                  <select className="dr-pill" aria-label="From month" value={spec.from} onChange={(e) => editSpec({ from: e.target.value, to: e.target.value > spec.to ? e.target.value : spec.to })}>
                    {months.map((m) => <option key={m} value={m}>{monthShort(m)}</option>)}
                  </select>
                  <span className="dr-muted">–</span>
                  <select className="dr-pill" aria-label="To month" value={spec.to} onChange={(e) => editSpec({ to: e.target.value, from: e.target.value < spec.from ? e.target.value : spec.from })}>
                    {months.map((m) => <option key={m} value={m}>{monthShort(m)}</option>)}
                  </select>
                </span>
              </div>
              <label className="dr-f"><span>City</span>
                <select className="dr-pill" value={spec.city ?? ""} onChange={(e) => {
                  const c = e.target.value || null;
                  editSpec({ city: c, fieldId: spec.fieldId != null && c && !fieldsForCity(c).some((f) => f.id === spec.fieldId) ? null : spec.fieldId });
                }}>
                  <option value="">All cities</option>
                  {meta.cities.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              </label>
              <label className="dr-f"><span>Field</span>
                <select className="dr-pill" value={spec.fieldId ?? ""} onChange={(e) => editSpec({ fieldId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">All fields</option>
                  {fieldsForCity(spec.city).map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
                </select>
              </label>
            </div>
            <div className="dr-frow dr-hint">
              <button type="button" className="dr-link" data-testid="dr-pivot-clear" onClick={() => { setSpec(blankSpec()); setPreset(null); }}>Clear all</button>
              <span className="dr-muted">Starts blank. Pick rows, columns and what to show in any order. Revenue is Finance&apos;s net, pre-tax (the Finance &gt; Revenue figure), by month and venue.</span>
            </div>
          </div>
          <div className="dr-card" data-testid="dr-pivot">
            {!pivotReady(spec) ? (
              <div className="dr-blank" data-testid="dr-pivot-empty">
                <b>Nothing to show yet</b>
                <span>{spec.show ? "Add rows or columns above, or pick a view" : "Add rows, columns and what to show above, or pick a view"}</span>
              </div>
            ) : pivotErr ? (
              <div className="dr-blank"><b>The table did not load</b><span>{pivotErr}</span>
                <button type="button" className="dr-link" onClick={() => setSpec({ ...spec })}>Try again</button></div>
            ) : pivot && "blocked" in pivot ? (
              <div className="dr-blank"><b>Revenue can&apos;t be split this way</b><span>{pivot.blocked} Try {REVENUE_DIMS.join(", ")}.</span></div>
            ) : !pivot || !("table" in pivot) ? (
              <div className="dr-blank"><b>Building the table…</b></div>
            ) : (
              <PivotGrid res={pivot} busy={pivotBusy} drillable={drillable} onDrill={drill} />
            )}
          </div>
        </>
      )}

      <style jsx>{`
        .dr { display: flex; flex-direction: column; gap: 18px; color: #003326 }
        .dr-state { padding: 24px; color: #6b807a }
        .dr-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap }
        .dr-sub { margin: 0; color: #6b807a; font-size: 14px; flex: 1 }
        .dr-seg { display: inline-flex; gap: 2px; padding: 3px; background: #fff; border: 1px solid #dde5e0; border-radius: 10px }
        .dr-seg button { border: 0; background: none; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; color: #003326; cursor: pointer; white-space: nowrap }
        .dr-seg button.on { background: #003326; color: #fff }
        .dr-chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
        .dr-chips-l { font-size: 12px; font-weight: 600; color: #6b807a }
        .dr-chip { display: inline-flex; align-items: center; background: #fff; border: 1px solid #dde5e0; border-radius: 999px }
        .dr-chip button { border: 0; background: none; font: inherit; font-size: 12px; font-weight: 600; color: #003326; padding: 6px 12px; cursor: pointer }
        .dr-chip .dr-chip-x { padding: 6px 10px 6px 0; color: #9aaba5 }
        .dr-chip .dr-chip-x:hover { color: #a2340f }
        .dr-chip.on { background: #003326; border-color: #003326 }
        .dr-chip.on button { color: #fff }
        .dr-chip.off button { color: #9aaba5; cursor: not-allowed }
        .dr-confirm { font-size: 12px; color: #003326; display: inline-flex; gap: 8px; align-items: center }
        .dr-muted { font-size: 12px; color: #9aaba5 }
        .dr-card { background: #fff; border: 1px solid #dde5e0; border-radius: 14px; overflow: visible }
        .dr-filters { padding: 18px 20px; display: flex; flex-direction: column; gap: 16px }
        .dr-frow { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap }
        .dr-f { display: flex; flex-direction: column; gap: 6px; position: relative }
        .dr-f > span:first-child { font-size: 11px; font-weight: 600; letter-spacing: .66px; text-transform: uppercase; color: #6b807a }
        .dr-pill { border: 1px solid #dde5e0; border-radius: 8px; background: #fff; padding: 7px 10px; font: inherit; font-size: 13px; font-weight: 600; color: #003326; cursor: pointer; max-width: 260px }
        .dr-dashed { border-style: dashed; color: #9aaba5; font-weight: 500 }
        .dr-drop::after { content: " ▾"; color: #6b807a; font-size: 11px }
        .dr-inline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap }
        .dr-minmax { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #6b807a }
        .dr-minmax input { width: 56px; border: 1px solid #dde5e0; border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px }
        .dr-link { border: 0; background: none; padding: 0; font: inherit; font-size: 13px; font-weight: 600; color: #138a55; cursor: pointer }
        .dr-link:disabled { color: #9aaba5; cursor: not-allowed }
        .dr-danger { color: #a2340f }
        .dr-clear, .dr-swap { padding-bottom: 8px }
        .dr-hint { align-items: center; gap: 16px }
        .dr-pop { position: absolute; top: 100%; left: 0; margin-top: 6px; z-index: 30; background: #fff; border: 1px solid #dde5e0; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,51,38,.12); padding: 10px; min-width: 260px }
        .dr-pop-fields { max-height: 340px; overflow-y: auto; width: 300px }
        .dr-pop-top { display: flex; justify-content: space-between; margin-bottom: 6px }
        .dr-pop-h { font-size: 11px; font-weight: 600; letter-spacing: .66px; text-transform: uppercase; color: #6b807a; margin: 10px 0 4px }
        .dr-pop-note { font-size: 11.5px; color: #8a5300; margin-top: 8px }
        .dr-check { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 4px 2px; cursor: pointer }
        .dr-check input { accent-color: #003326 }
        .dr-quick { display: flex; flex-wrap: wrap; gap: 6px }
        .dr-quick button { border: 1px solid #dde5e0; background: #fff; border-radius: 999px; padding: 5px 10px; font: inherit; font-size: 12px; font-weight: 600; color: #003326; cursor: pointer }
        .dr-quick button.on { background: #003326; color: #fff; border-color: #003326 }
        .dr-range { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6b807a }
        .dr-range select { border: 1px solid #dde5e0; border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px; color: #003326 }
        .dr-tag { display: inline-flex; align-items: center; gap: 6px; background: #f6f8f7; border: 1px solid #dde5e0; border-radius: 8px; padding: 6px 8px 6px 10px; font-size: 13px; font-weight: 600 }
        .dr-tag button { border: 0; background: none; color: #9aaba5; cursor: pointer; font: inherit; padding: 0 }
        .dr-results { overflow: hidden }
        .dr-rhead { display: flex; align-items: center; gap: 14px; padding: 16px 20px; flex-wrap: wrap }
        .dr-rtitle { display: flex; flex-direction: column; gap: 2px; min-width: 0 }
        .dr-rtitle b { font-size: 26px; font-weight: 800; letter-spacing: -.3px }
        .dr-rtitle span { font-size: 12px; color: #6b807a }
        .dr-rtitle .dr-gaps { color: #8a5300 }
        .dr-sp { flex: 1 }
        .dr-btn { border: 1px solid #dde5e0; background: #fff; border-radius: 10px; padding: 9px 14px; font: inherit; font-size: 13px; font-weight: 600; color: #003326; cursor: pointer; white-space: nowrap }
        .dr-btn:disabled { opacity: .45; cursor: not-allowed }
        .dr-primary { background: #003326; border-color: #003326; color: #fff }
        .dr-saveform { display: inline-flex; align-items: center; gap: 8px }
        .dr-saveform input { border: 1px solid #dde5e0; border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px; width: 200px }
        .dr-msg { padding: 0 20px 10px; font-size: 12.5px; color: #4f5f57 }
        .dr-msg.bad { color: #a2340f }
        .dr-tablewrap { overflow-x: auto }
        .dr-table { width: 100%; border-collapse: collapse; font-size: 13px }
        .dr-table th { background: #f6f8f7; border-top: 1px solid #dde5e0; text-align: left; padding: 0 20px; height: 36px }
        .dr-table th button { border: 0; background: none; padding: 0; font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .66px; text-transform: uppercase; color: #6b807a; cursor: pointer; white-space: nowrap }
        .dr-table td { border-top: 1px solid #dde5e0; padding: 0 20px; height: 46px; white-space: nowrap }
        .dr-name { font-weight: 700 }
        .dr-email { color: #6b807a }
        .dr-flag { display: inline-block; font-size: 11px; font-weight: 700; color: #8a5300; background: #fff3c4; border-radius: 4px; padding: 1px 6px }
        .dr-empty { color: #6b807a; text-align: center }
        .dr-foot { border-top: 1px solid #dde5e0; padding: 12px 20px; font-size: 12px; color: #6b807a; min-height: 14px }
        .dr-blank { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 64px 20px; text-align: center }
        .dr-blank b { font-size: 16px }
        .dr-blank span { font-size: 13px; color: #6b807a; max-width: 560px }
        @media (max-width: 760px) { .dr-pop { position: fixed; left: 16px; right: 16px; top: 120px; width: auto } .dr-rtitle b { font-size: 22px } }
      `}</style>
    </section>
  );
}

function PivotGrid({ res, busy, drillable, onDrill }: {
  res: { table: PivotTableData; labels: Record<string, string>; colLabels: Record<string, string>; spec: PivotSpec };
  busy: boolean; drillable: boolean; onDrill: (r: string, c: string) => void;
}) {
  const { table: t, labels, colLabels, spec } = res;
  const isMoney = spec.show === "revenue";
  const show = (v: number | undefined) => (v == null ? "—" : isMoney ? money(v) : num(v));
  const hasCols = !!spec.col;
  const vals = t.rowKeys.flatMap((r) => t.colKeys.map((c) => t.cells[r]?.[c]).filter((v): v is number => v != null));
  const min = vals.length ? Math.min(...vals) : 0, max = vals.length ? Math.max(...vals) : 0;
  const totalHead = t.additive ? "Total" : "All (distinct)";
  /* THE TABLE AS CSV, built here from what is on screen: counts and money, no contact data. */
  const exportCsv = () => {
    const q = (x: string) => (/[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
    const rowsK = spec.rows.length ? t.rowKeys : [SEP];
    const head = [spec.rows.join(" · ") || "", ...(hasCols ? t.colKeys.map((c) => colLabels[c] ?? c) : [SHOW_LABEL[spec.show!]]), ...(hasCols && spec.rows.length ? [totalHead] : [])];
    const body = rowsK.map((r) => [spec.rows.length ? labels[r] ?? r : "All", ...t.colKeys.map((c) => String(t.cells[r]?.[c] ?? "")), ...(hasCols && spec.rows.length ? [String(t.rowTotals[r] ?? "")] : [])]);
    const foot = spec.rows.length ? [[totalHead, ...t.colKeys.map((c) => String(hasCols ? t.colTotals[c] ?? "" : t.grand)), ...(hasCols ? [String(t.grand)] : [])]] : [];
    const csv = [head, ...body, ...foot].map((l) => l.map(q).join(",")).join("\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `data-room-pivot-${spec.from}-${spec.to}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const cellBtn = (v: number | undefined, r: string, c: string) =>
    v == null ? "—" : drillable ? <button type="button" title="Open these players on the Played tab" onClick={() => onDrill(r, c)}>{show(v)}</button> : <span title="This number has no Played list behind it (cohort, or new players)">{show(v)}</span>;
  return (
    <div className="pg" data-testid="dr-grid">
      <div className="pg-cap">{SHOW_LABEL[spec.show!]} · {monthShort(spec.from)} – {monthShort(spec.to)}{spec.city ? ` · ${cityName(spec.city)}` : ""}
        {!t.additive && <span> · totals are distinct players, so a row or column can be less than the sum of its cells</span>}
        {busy && <span> · updating</span>}
        <button type="button" className="pg-x" data-testid="dr-pivot-export" onClick={exportCsv}>Export</button>
      </div>
      <div className="pg-scroll">
        <table>
          <thead>
            <tr>
              <th>{spec.rows.join(" · ") || ""}</th>
              {hasCols ? t.colKeys.map((c) => <th key={c}>{colLabels[c] ?? c}</th>) : <th>{SHOW_LABEL[spec.show!]}</th>}
              {hasCols && spec.rows.length > 0 && <th className="pg-t">{totalHead}</th>}
            </tr>
          </thead>
          <tbody>
            {(spec.rows.length ? t.rowKeys : [SEP]).map((r) => (
              <tr key={r}>
                <th>{spec.rows.length ? labels[r] ?? r.split(SEP).join(" · ") : "All"}</th>
                {t.colKeys.map((c) => {
                  const v = t.cells[r]?.[c];
                  return <td key={c} style={v == null ? undefined : { background: heatColour(heatStep(v, min, max)) }} data-testid="dr-cell">{cellBtn(v, r, hasCols ? c : "")}</td>;
                })}
                {hasCols && spec.rows.length > 0 && <td className="pg-t" data-testid="dr-row-total">{cellBtn(t.rowTotals[r], r, "")}</td>}
              </tr>
            ))}
          </tbody>
          {spec.rows.length > 0 && (
            <tfoot>
              <tr>
                <th>{totalHead}</th>
                {t.colKeys.map((c) => <td key={c} data-testid="dr-col-total">{cellBtn(hasCols ? t.colTotals[c] : t.grand, SEP, hasCols ? c : "")}</td>)}
                {hasCols && <td className="pg-t" data-testid="dr-grand">{cellBtn(t.grand, SEP, "")}</td>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <style jsx>{`
        .pg-cap { padding: 14px 20px; font-size: 12.5px; color: #6b807a; border-bottom: 1px solid #dde5e0; display: flex; align-items: center; gap: 4px; flex-wrap: wrap }
        .pg-x { margin-left: auto; border: 1px solid #dde5e0; background: #fff; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 12.5px; font-weight: 600; color: #003326; cursor: pointer }
        .pg-scroll { overflow: auto; max-height: 62vh }
        table { border-collapse: separate; border-spacing: 0; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px }
        th, td { padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid #eef2ef; text-align: right }
        thead th { position: sticky; top: 0; z-index: 3; background: #f6f8f7; font-size: 11px; font-weight: 600; letter-spacing: .66px; text-transform: uppercase; color: #6b807a }
        thead th:first-child, tbody th, tfoot th { text-align: left; position: sticky; left: 0; z-index: 2; background: #fff }
        thead th:first-child { z-index: 4; background: #f6f8f7 }
        tbody th { font-weight: 700 }
        .pg-t { background: #f6f8f7; font-weight: 700 }
        tfoot th, tfoot td { position: sticky; bottom: 0; background: #003326; color: #fff; font-weight: 700; border-bottom: 0 }
        td :global(button) { border: 0; background: none; font: inherit; color: inherit; cursor: pointer; padding: 2px 4px; border-radius: 4px }
        td :global(button:hover) { outline: 2px solid #138a55; outline-offset: -1px }
      `}</style>
    </div>
  );
}
