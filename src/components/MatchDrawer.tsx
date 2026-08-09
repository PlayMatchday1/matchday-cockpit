"use client";

// Master Schedule edit drawer (Phase 7 Part B; Phase 10: PRODUCTION). Opens on a
// match card, PUSHES the grid (never covers it), edits nine fields, and writes a
// partial update through the guarded route /api/matchday/{DRAWER_ENV}/matches/{id}
// (DRAWER_ENV from matchEnv.ts; currently production) — env named per call. Uses the
// same shared diff (fieldChanged / diffKeys / pick from matchEditModel) as the full
// editor, so the two screens can never disagree about what a change is. Production
// PUT is a proven partial apply (Phase 9). The manager control is a real dropdown
// scoped to the match's city (GET /city-managers/users).
//
// The date + time inputs collapse into the startDate/endDate PAIR: a time move
// shifts endDate by the same amount so the duration is preserved and the pair
// can never silently invert (Phase 7 date decision — docs/matchday-api-facts.md).
// A match that loads already inverted (endDate <= startDate) is flagged and its
// date/time is held, never silently rewritten. Nothing here calls new Date() on a
// wall-clock string — see matchWallClock.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { diffKeys, pick, MONEY_KEYS } from "@/lib/matchEditModel";
import { buildStartDate, shiftedEndDate, isInvertedPair, wallDate, wallTime } from "@/lib/matchWallClock";
import { tzLabelOfCity, tzShift } from "@/lib/matchTimezone";
import { envBadge } from "@/lib/matchEnvBadge";
import { centsToDollars, dollarsToCents } from "@/lib/matchMoney";
import { DRAWER_ENV, FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { noteLogResponse } from "@/lib/logHealth";

export const DRAWER_W = 480;

// The drawer targets DRAWER_ENV (matchEnv.ts): one value builds the request URL AND
// the badge, so the two can't disagree. The "open full editor" link only renders
// when the full editor targets the SAME environment (FULL_EDITOR_ENV) — otherwise
// it would send the operator from a production match to a different-env editor.
const SAME_ENV_AS_EDITOR = DRAWER_ENV === FULL_EDITOR_ENV;

export type DrawerPatch = { name: string; startDate: string; fieldId: number; venue: string | null; city: string | null };
export type DrawerMatch = { apiId: number; veo: boolean; siblings: number[] };

type FieldRow = { id: number; title: string; city: string | null };
type Mgr = { id?: number | null; firstName?: string | null; lastName?: string | null; name?: string | null; deletedAt?: string | null } | null;
type Detail = {
  match: Record<string, unknown> & {
    id: number; name: string | null; fieldId: number | null; startDate: string | null; endDate: string | null;
    registrationPrice: number | null; additionalSpotPrice: number | null; guestCount: number | null;
    managerId: number | null; secondManagerId: number | null; teams?: unknown[] | null;
    fieldTitle: string | null; cityName: string | null; maxPlayerCount: number | null;
    manager: Mgr; secondManager: Mgr;
  };
  fields: FieldRow[];
  players: unknown[];
  managers: { id: number; name: string }[];
};

// The nine editable fields. date/time are UI-only and collapse to startDate/endDate.
const REAL_KEYS = ["fieldId", "name", "registrationPrice", "additionalSpotPrice", "guestCount", "managerId", "secondManagerId"] as const;
const LABEL: Record<string, string> = {
  date: "Date", time: "Start time", fieldId: "Field", name: "Name",
  registrationPrice: "Price", additionalSpotPrice: "Spot price", guestCount: "Guest count",
  managerId: "Manager", secondManagerId: "Second manager",
};

type State = Record<string, unknown> & { date: string; time: string };

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}
const money = (c: unknown) => "$" + centsToDollars(c);
const dollars = centsToDollars;
const centsOf = dollarsToCents;
const hhmm12 = (t: string) => {
  const [H, M] = t.split(":").map(Number);
  const ap = H >= 12 ? "PM" : "AM";
  const h = H % 12 === 0 ? 12 : H % 12;
  return `${h}:${String(M).padStart(2, "0")} ${ap}`;
};
const mgrName = (m: Mgr): string | null => m ? (m.name ?? ([m.firstName, m.lastName].filter(Boolean).join(" ").trim() || null)) : null;
const mgrDeleted = (m: Mgr, id: number | null) => id != null && (!m || !!m?.deletedAt || !mgrName(m));

export default function MatchDrawer({
  apiId, cardVeo, siblings, onClose, onDirtyChange, onSaved, onToggleVeo, onStep, onToast,
}: {
  apiId: number; cardVeo: boolean; siblings: number[];
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (apiId: number, patch: DrawerPatch) => void;
  onToggleVeo: (apiId: number, enabled: boolean) => void;
  onStep: (targetId: number) => void;
  onToast: (msg: string, warn?: boolean) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<State | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Load the staging match detail whenever the open id changes.
  useEffect(() => {
    let alive = true;
    setDetail(null); setLoaded(null); setState(null); setLoadErr(null); setMsg(null);
    (async () => {
      const res = await authFetch(`/api/matchday/${DRAWER_ENV}/matches/${apiId}`);
      const json = await res.json().catch(() => ({}));
      if (!alive) return;
      if (!res.ok) { setLoadErr(json?.error ?? `HTTP ${res.status}`); return; }
      const d = json as Detail;
      const m = d.match;
      const start = m.startDate ?? "";
      const base: State = {
        date: start ? wallDate(start) : "", time: start ? wallTime(start) : "",
        startDate: m.startDate, endDate: m.endDate,
        fieldId: m.fieldId, name: m.name ?? "",
        registrationPrice: m.registrationPrice, additionalSpotPrice: m.additionalSpotPrice, guestCount: m.guestCount,
        managerId: m.managerId, secondManagerId: m.secondManagerId,
      };
      setDetail(d); setLoaded(base); setState(JSON.parse(JSON.stringify(base)));
    })();
    return () => { alive = false; };
  }, [apiId]);

  // Focus the panel (not an input) when it opens — landing in a time box reads
  // like the field is already being edited.
  useEffect(() => { if (loaded) panelRef.current?.focus(); }, [loaded]);

  const inverted = useMemo(() => {
    const s = detail?.match.startDate, e = detail?.match.endDate;
    return !!(s && e && isInvertedPair(s, e));
  }, [detail]);

  // changed keys for the UI (date/time separate + the seven real fields).
  const uiChanged = useMemo(() => {
    if (!loaded || !state) return [] as string[];
    const out: string[] = [];
    if (!inverted) {
      if (state.date !== loaded.date) out.push("date");
      if (state.time !== loaded.time) out.push("time");
    }
    out.push(...diffKeys(REAL_KEYS, loaded, state));
    return out;
  }, [loaded, state, inverted]);

  const dirty = uiChanged.length > 0;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // The request body: real changed fields (shared pick), plus — only if the day
  // or time moved — the startDate/endDate PAIR, duration preserved.
  const buildBody = useCallback((): Record<string, unknown> => {
    if (!loaded || !state) return {};
    const realChanged = diffKeys(REAL_KEYS, loaded, state);
    const body = pick(state, realChanged);
    if (!inverted && (state.date !== loaded.date || state.time !== loaded.time)) {
      const newStart = buildStartDate(state.date, state.time);
      body.startDate = newStart;
      body.endDate = shiftedEndDate(String(loaded.startDate), String(loaded.endDate), newStart);
    }
    return body;
  }, [loaded, state, inverted]);

  const set = (k: string, v: unknown) => setState((s) => (s ? { ...s, [k]: v } : s));

  const requestClose = useCallback(() => {
    if (dirty) { onToast(`Save or revert match ${apiId} first.`, true); return; }
    onClose();
  }, [dirty, apiId, onClose, onToast]);

  const step = useCallback((delta: number) => {
    if (dirty) { onToast(`Save or revert match ${apiId} first.`, true); return; }
    const i = siblings.indexOf(apiId);
    const t = siblings[i + delta];
    if (t != null) onStep(t);
  }, [dirty, apiId, siblings, onStep, onToast]);

  // Escape closes (guarded) while the drawer is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); requestClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const revert = () => { if (loaded) setState(JSON.parse(JSON.stringify(loaded))); };

  const save = async () => {
    const body = buildBody();
    const keys = Object.keys(body);
    if (!keys.length) return;
    setSaving(true); setMsg(null);
    const res = await authFetch(`/api/matchday/${DRAWER_ENV}/matches/${apiId}`, { method: "PUT", body: JSON.stringify({ changes: body }) });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setMsg({ kind: json?.ambiguous ? "warn" : "err", text: json?.error ?? `HTTP ${res.status}` }); return; }
    noteLogResponse(json); // the write landed; if the Change Log couldn't record it, make it loud
    // Rebase loaded onto the saved match and patch the card in place (no refetch).
    const m = (json.match ?? {}) as Detail["match"];
    const nextStart = m.startDate ?? state!.startDate;
    const rebased: State = {
      ...state!, startDate: nextStart, endDate: m.endDate ?? state!.endDate,
      date: nextStart ? wallDate(String(nextStart)) : state!.date, time: nextStart ? wallTime(String(nextStart)) : state!.time,
    };
    setDetail((d) => (d ? { ...d, match: { ...d.match, ...m } } : d));
    setLoaded(JSON.parse(JSON.stringify(rebased))); setState(JSON.parse(JSON.stringify(rebased)));
    setMsg({ kind: "ok", text: `Saved ${keys.length} field${keys.length === 1 ? "" : "s"} to match ${apiId}.` });
    const f = detail?.fields.find((x) => x.id === Number(rebased.fieldId));
    onSaved(apiId, {
      name: String(rebased.name ?? ""), startDate: String(nextStart ?? ""),
      fieldId: Number(rebased.fieldId), venue: f?.title ?? m.fieldTitle ?? null, city: f?.city ?? m.cityName ?? null,
    });
  };

  // ---- render ----------------------------------------------------------------
  const m = detail?.match;
  const curField = detail?.fields.find((f) => f.id === Number(state?.fieldId));
  const loadedField = detail?.fields.find((f) => f.id === Number(loaded?.fieldId));
  const cityName = curField?.city ?? m?.cityName ?? null;
  const tzLabel = tzLabelOfCity(cityName);
  const shift = state && loaded ? tzShift(loadedField?.city ?? m?.cityName, curField?.city) : null;

  const delManagers: string[] = [];
  if (m) {
    if (mgrDeleted(m.manager, Number(loaded?.managerId ?? m.managerId) || null)) delManagers.push("Manager");
    if (mgrDeleted(m.secondManager, Number(loaded?.secondManagerId ?? m.secondManagerId) || null)) delManagers.push("Second manager");
  }

  // Manager dropdown scoped to the match's city (GET /city-managers/users). A
  // currently-selected managerId that is NOT in the returned list stays selected
  // and labelled — it is never blanked (blanking would report a change the admin
  // did not make and then save it).
  const managers = detail?.managers ?? [];
  const managerSelect = (key: "managerId" | "secondManagerId", mgrObj: Mgr) => {
    const cur = state?.[key] as number | null | undefined;
    const curId = cur == null || cur === ("" as unknown) ? null : Number(cur);
    const inList = curId == null || managers.some((x) => x.id === curId);
    const outLabel = mgrName(mgrObj) ?? `id ${curId}`;
    return (
      <select data-testid={`in-${key}`} value={curId == null ? "" : String(curId)}
        onChange={(e) => set(key, e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">— none —</option>
        {!inList && curId != null && <option value={String(curId)}>{outLabel} (not in {cityName ?? "city"} list)</option>}
        {managers.map((x) => <option key={x.id} value={String(x.id)}>{x.name}</option>)}
      </select>
    );
  };

  const showVal = (k: string, v: unknown) => {
    if (v === null || v === "" || v === undefined) return "none";
    if (k === "fieldId") return detail?.fields.find((f) => f.id === Number(v))?.title ?? String(v);
    if (k === "time") return hhmm12(String(v));
    if (MONEY_KEYS.has(k)) return money(v);
    return String(v);
  };
  const blank = (v: unknown) => v === "" || v == null || (typeof v === "number" && Number.isNaN(v));

  const numBlur = (k: string, fmt: (v: unknown) => string) => () => {
    // A blank numeric box is a half-typed number, not a change (Revert stays
    // disabled), so restore the loaded value on blur — otherwise it sits empty.
    setState((s) => (s && (s[k] === "" || s[k] == null) ? { ...s, [k]: loaded![k] } : s));
    void fmt;
  };

  const grp = (keys: string[]) => uiChanged.filter((k) => keys.includes(k)).length;
  const grpTag = (keys: string[]) => { const n = grp(keys); return n ? <span className="mdw-n">{n} changed</span> : null; };
  const dirtyCls = (k: string) => "mdw-f" + (uiChanged.includes(k) ? " mdw-dirty" : "");

  const badge = envBadge(DRAWER_ENV); // derived from the env that routes the request
  return (
    <aside
      ref={panelRef}
      className={"mdw" + (badge.tone === "prod" ? " mdw-prod" : "")}
      role="dialog"
      aria-modal="false"
      aria-label={`${m ? "Edit" : ""} ${badge.tone === "prod" ? "PRODUCTION " : "staging "}match ${apiId}`.trim()}
      tabIndex={-1}
      data-testid="drawer"
      data-env={DRAWER_ENV}
      style={{ width: DRAWER_W }}
    >
      <style>{CSS}</style>
      <div className="mdw-head">
        <div className="mdw-row1">
          <div className="mdw-crumb" data-testid="dr-crumb">{cityName ?? "—"}</div>
          <div className="mdw-sp">
            <button type="button" className="mdw-iconb" data-testid="dr-prev" title="Previous match this day" aria-label="Previous match this day" disabled={siblings.indexOf(apiId) <= 0} onClick={() => step(-1)}>↑</button>
            <button type="button" className="mdw-iconb" data-testid="dr-next" title="Next match this day" aria-label="Next match this day" disabled={siblings.indexOf(apiId) >= siblings.length - 1} onClick={() => step(1)}>↓</button>
            <button type="button" className="mdw-iconb" data-testid="dr-close" title="Close (Esc)" aria-label="Close" onClick={requestClose}>✕</button>
          </div>
        </div>
        <h3 className="mdw-name" data-testid="dr-title">{m ? (String(loaded?.name ?? "") || "Untitled match") : `Loading match ${apiId}…`}</h3>
        <div className="mdw-chips">
          <span className="mdw-chip id">ID {apiId}</span>
          <span className="mdw-chip tz" data-testid="dr-tzchip">{tzLabel.toUpperCase()}</span>
          <span className={"mdw-chip " + (badge.tone === "prod" ? "prod" : "stg")} data-testid="dr-envbadge">{badge.tone === "prod" ? "● " : ""}{badge.label}</span>
          {SAME_ENV_AS_EDITOR ? <a className="mdw-full" data-testid="dr-fulleditor" href={`/match-ops/matches/${apiId}`}>Open full editor →</a> : null}
        </div>
      </div>

      {loadErr ? (
        <div className="mdw-body"><div className="mdw-state" data-testid="dr-error">Couldn’t load: {loadErr}</div></div>
      ) : !m || !state || !loaded ? (
        <div className="mdw-body"><div className="mdw-state">Loading…</div></div>
      ) : (
        <div className="mdw-body">
          {inverted && (
            <div className="mdw-inverted" data-testid="dr-inverted">
              <b>This match ends before it starts.</b> Its end ({showTime(String(m.endDate))}) is on or before its start ({showTime(String(m.startDate))}). The date and time are held so an edit can’t quietly rewrite a broken pair — fix it in the full editor. Other fields still save.
            </div>
          )}

          <div className="mdw-sec">
            <h5>WHEN {grpTag(["date", "time"])}</h5>
            <div className="mdw-two">
              <div className={dirtyCls("date")}><label htmlFor="i-date">DATE</label>
                <input id="i-date" data-testid="in-date" type="date" disabled={inverted} value={String(state.date)} onChange={(e) => set("date", e.target.value)} /></div>
              <div className={dirtyCls("time")}><label htmlFor="i-time">START TIME</label>
                <input id="i-time" data-testid="in-time" type="time" disabled={inverted} value={String(state.time)} onChange={(e) => set("time", e.target.value)} /></div>
            </div>
            <div className="mdw-tzline">Entered as local wall-clock time in <b data-testid="dr-tzname">{cityName} ({tzLabel})</b>. The server derives UTC from the field’s timezone — Clubhouse never converts.</div>
          </div>

          <div className="mdw-sec">
            <h5>WHERE {grpTag(["fieldId", "name"])}</h5>
            <div className={dirtyCls("fieldId")}><label htmlFor="i-field">FIELD</label>
              <select id="i-field" data-testid="in-field" value={String(state.fieldId ?? "")} onChange={(e) => set("fieldId", Number(e.target.value))}>
                {detail.fields.map((f) => <option key={f.id} value={f.id}>{f.title}{f.city ? ` — ${f.city}` : ""}</option>)}
              </select>
              {shift && (
                <div className="mdw-hint warn" data-testid="dr-tzwarn">
                  Moving from {shift.fromLabel} to {shift.toLabel}. The clock stays {hhmm12(String(state.time))} — that is {shift.hours === 1 ? "one hour" : `${shift.hours} hours`} {shift.direction} in real terms.
                </div>
              )}
            </div>
            <div className={dirtyCls("name")}><label htmlFor="i-name">MATCH NAME</label>
              <input id="i-name" data-testid="in-name" type="text" value={String(state.name ?? "")} onChange={(e) => set("name", e.target.value)} /></div>
          </div>

          <div className="mdw-sec">
            <h5>MONEY {grpTag(["registrationPrice", "additionalSpotPrice", "guestCount"])}</h5>
            <div className="mdw-three">
              <div className={dirtyCls("registrationPrice")}><label htmlFor="i-price">PRICE</label>
                <div className="mdw-money"><span>$</span><input id="i-price" data-testid="in-registrationPrice" type="number" step="0.01" min="0"
                  value={blank(state.registrationPrice) ? "" : dollars(state.registrationPrice)}
                  onChange={(e) => set("registrationPrice", e.target.value === "" ? "" : centsOf(e.target.value))}
                  onBlur={numBlur("registrationPrice", dollars)} /></div></div>
              <div className={dirtyCls("additionalSpotPrice")}><label htmlFor="i-spot">SPOT PRICE</label>
                <div className="mdw-money"><span>$</span><input id="i-spot" data-testid="in-additionalSpotPrice" type="number" step="0.01" min="0"
                  value={blank(state.additionalSpotPrice) ? "" : dollars(state.additionalSpotPrice)}
                  onChange={(e) => set("additionalSpotPrice", e.target.value === "" ? "" : centsOf(e.target.value))}
                  onBlur={numBlur("additionalSpotPrice", dollars)} /></div></div>
              <div className={dirtyCls("guestCount")}><label htmlFor="i-guest">GUEST COUNT</label>
                <input id="i-guest" data-testid="in-guestCount" type="number" min="0" step="1"
                  value={blank(state.guestCount) ? "" : String(state.guestCount)}
                  onChange={(e) => set("guestCount", e.target.value === "" ? "" : Number(e.target.value))}
                  onBlur={numBlur("guestCount", (v) => String(v))} /></div>
            </div>
            <div className="mdw-hint">Stored in cents. Clearing a box is not a change — type 0 to actually set a price to zero.</div>
          </div>

          <div className="mdw-sec">
            <h5>WHO {grpTag(["managerId", "secondManagerId"])}</h5>
            <div className="mdw-two">
              <div className={dirtyCls("managerId")}><label htmlFor="i-mgr1">MANAGER</label>
                {managerSelect("managerId", m.manager)}
                {mgrName(m.manager) ? <div className="mdw-sub">{mgrName(m.manager)}</div> : null}</div>
              <div className={dirtyCls("secondManagerId")}><label htmlFor="i-mgr2">SECOND MANAGER</label>
                {managerSelect("secondManagerId", m.secondManager)}
                {mgrName(m.secondManager) ? <div className="mdw-sub">{mgrName(m.secondManager)}</div> : null}</div>
            </div>
            {delManagers.length > 0 && (
              <div className="mdw-hint warn" data-testid="dr-delnote">
                {delManagers.join(" and ")} {delManagers.length === 1 ? "points" : "point"} at a deleted or unresolved account. The id is kept exactly as loaded — nothing is blanked, so opening the match reports no change you did not make.
              </div>
            )}
          </div>

          <div className="mdw-sec">
            <h5>VEO COVERAGE</h5>
            <div className="mdw-veorow">
              <div><div className="mdw-lab">Camera assigned</div>
                <div className="mdw-sub">{cardVeo ? "Counted in this week’s camera nights." : "This match is not covered."}</div></div>
              <button type="button" className={"mdw-sw" + (cardVeo ? " on" : "")} role="switch" aria-checked={cardVeo} data-testid="dr-veo"
                aria-label="Camera assigned" onClick={() => onToggleVeo(apiId, !cardVeo)}><i /></button>
            </div>
            <div className="mdw-hint">Veo lives in Clubhouse, not the MatchDay API — it saves the instant you flip it and stays out of the list below.</div>
          </div>

          <div className="mdw-sec">
            <h5>NOT EDITED HERE</h5>
            <div className="mdw-ro">
              <div className="mdw-rr"><span>Roster</span><b>{detail.players.length} of {m.maxPlayerCount ?? "—"} filled</b></div>
              <div className="mdw-rr"><span>Teams &amp; tee prices</span><b>{Array.isArray(m.teams) ? m.teams.length : 0} teams</b></div>
              <div className="mdw-rr"><span>Capacity &amp; automation</span><b>cap {m.maxPlayerCount ?? "none"}</b></div>
              <div className="mdw-note">These need other endpoints or the room to lay them out.{SAME_ENV_AS_EDITOR ? <> <a href={`/match-ops/matches/${apiId}`}>Open the full editor</a> for every field.</> : " Use the full editor for every field."}</div>
            </div>
          </div>
        </div>
      )}

      <div className="mdw-foot">
        {dirty && loaded && state && (
          <div className="mdw-diff" data-testid="dr-diff">
            <div className="mdw-dt">ABOUT TO CHANGE</div>
            <div className="mdw-chipsrow">
              {uiChanged.map((k) => (
                <span className="mdw-dchip" key={k} data-testid="dr-chip" data-key={k}>
                  <b>{LABEL[k]}</b> <s>{showVal(k, loaded[k])}</s> → <em>{showVal(k, state[k])}</em>
                </span>
              ))}
            </div>
            <div className="mdw-fine">This list is the request. The API leaves out what you omit, so only these fields are sent — nothing you did not touch can be overwritten.{uiChanged.includes("date") || uiChanged.includes("time") ? " A time change sends startDate and endDate together to keep the match’s length." : ""}</div>
          </div>
        )}
        <div className="mdw-acts">
          <span className="mdw-cnt" data-testid="dr-cnt">{dirty ? `${uiChanged.length} ${uiChanged.length === 1 ? "change" : "changes"} not saved` : "No changes"}</span>
          {msg && <span className="mdw-msg" data-testid="dr-msg" style={{ color: msg.kind === "ok" ? "#046B45" : msg.kind === "warn" ? "#7A5200" : "#A83120" }}>{msg.kind === "warn" ? "⚠ " : ""}{msg.text}</span>}
          <div className="mdw-sp">
            <button type="button" className="mdw-gh" data-testid="dr-revert" disabled={!dirty || saving} onClick={revert}>Revert</button>
            <button type="button" className="mdw-go" data-testid="dr-save" disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function showTime(iso: string): string {
  return hhmm12(wallTime(iso)) + " " + wallDate(iso);
}

const CSS = `
.mdw{position:fixed;top:0;right:0;bottom:0;background:#fff;border-left:1px solid #DCE5E0;
  box-shadow:-14px 0 40px rgba(0,32,21,.16);display:flex;flex-direction:column;z-index:60;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0B1F17}
.mdw:focus{outline:none}
.mdw *{box-sizing:border-box}
.mdw-head{background:#04291D;color:#fff;padding:15px 18px 16px;flex:0 0 auto}
.mdw-row1{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.mdw-crumb{font-size:12px;color:#9FC9B6;letter-spacing:.02em}
.mdw-row1 .mdw-sp{margin-left:auto;display:flex;gap:6px}
.mdw-iconb{width:29px;height:29px;border-radius:7px;border:1px solid #2A5644;background:transparent;color:#CFE7DC;line-height:1;font-size:14px;cursor:pointer;font-family:inherit}
.mdw-iconb:hover:not(:disabled){background:#14432F;color:#fff}
.mdw-iconb:disabled{opacity:.32;cursor:not-allowed}
.mdw-name{margin:0;font-size:18.5px;letter-spacing:-.2px}
.mdw-chips{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap;align-items:center}
.mdw-chip{font-size:10.5px;font-weight:700;letter-spacing:.07em;border-radius:20px;padding:3px 9px}
.mdw-chip.id{background:#14432F;color:#B7DECB}
.mdw-chip.tz{background:#14432F;color:#B7DECB}
.mdw-chip.stg{background:#F2E31D;color:#231F00}
/* PRODUCTION is unmistakable: solid red pill with a live dot + distinct label,
   AND a red header ground + red left rail on the whole drawer — not a colour swap
   on the same chip. */
.mdw-chip.prod{background:#E5121B;color:#fff;font-weight:800;letter-spacing:.09em;box-shadow:0 0 0 2px rgba(229,18,27,.35)}
.mdw.mdw-prod{border-left:5px solid #E5121B}
.mdw.mdw-prod .mdw-head{background:#5A0B0F}
.mdw-full{margin-left:auto;color:#2CDB87;font-size:12.5px;text-decoration:none;font-weight:600;white-space:nowrap}
.mdw-full:hover{text-decoration:underline}
.mdw-body{flex:1 1 auto;overflow-y:auto;padding:4px 18px 18px}
.mdw-state{padding:26px 4px;font-size:13px;color:#5C6B62;font-weight:650}
.mdw-inverted{margin:12px 0 0;background:#FDE9E5;border:1px solid #F3C4BB;color:#7a2415;border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.5}
.mdw-inverted b{color:#A83120}
.mdw-sec{border-bottom:1px solid #E9EFEB;padding:16px 0}
.mdw-sec:last-child{border-bottom:0}
.mdw-sec h5{margin:0 0 12px;font-size:10.5px;letter-spacing:.12em;color:#67746C;font-weight:700;display:flex;align-items:center}
.mdw-n{margin-left:auto;font-size:11px;letter-spacing:0;color:#1B4F9C;font-weight:700;text-transform:none}
.mdw-f{margin-bottom:12px}
.mdw-f:last-child{margin-bottom:0}
.mdw-f label{display:block;font-size:11px;letter-spacing:.09em;font-weight:700;color:#67746C;margin-bottom:5px}
.mdw-f.mdw-dirty label{color:#1B4F9C}
.mdw-two{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.mdw-three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px}
.mdw input[type=text],.mdw input[type=time],.mdw input[type=date],.mdw input[type=number],.mdw select{
  width:100%;padding:9px 11px;border:1px solid #CBD7D1;border-radius:8px;background:#fff;font-family:inherit;font-size:13.5px;color:#0B1F17}
.mdw input:focus,.mdw select:focus{outline:2px solid #046B45;outline-offset:-1px;border-color:#046B45}
.mdw input:disabled{background:#F1F4F1;color:#67746C;cursor:not-allowed}
.mdw-f.mdw-dirty input,.mdw-f.mdw-dirty select{border-color:#9CB6DD;background:#F4F8FE}
.mdw-money{position:relative}
/* [type=number] to out-specify the general ".mdw input[type=number]" rule, else
   padding-left is 11px and the "$" overlay covers the leading digit ($12 -> $2). */
.mdw-money input[type=number]{padding-left:24px}
.mdw-money span{position:absolute;left:11px;top:9px;color:#5C6B62;pointer-events:none}
.mdw-hint{font-size:12px;color:#5C6B62;margin-top:6px;line-height:1.45}
.mdw-hint.warn{color:#7A5200}
.mdw-sub{font-size:11.5px;color:#5C6B62;margin-top:4px;font-weight:650}
.mdw-tzline{font-size:12px;line-height:1.5;color:#5C6B62;margin-top:6px}
.mdw-tzline b{color:#2A473B}
.mdw-veorow{display:flex;align-items:center;gap:12px;border:1px solid #DCE5E0;border-radius:10px;padding:12px 13px;background:#FBFCFB}
.mdw-lab{font-weight:600;font-size:14px}
.mdw-sw{margin-left:auto;width:46px;height:26px;border-radius:20px;border:1px solid #C3CDC7;background:#E7EDEA;position:relative;flex:0 0 46px;cursor:pointer}
.mdw-sw i{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:left .13s}
.mdw-sw.on{background:#F2E31D;border-color:#D9CA10}
.mdw-sw.on i{left:22px}
.mdw-sw:focus-visible{outline:2px solid #046B45;outline-offset:2px}
.mdw-ro{background:#F6F9F7;border:1px solid #DCE5E0;border-radius:10px;padding:12px 13px}
.mdw-rr{display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0}
.mdw-rr span{color:#5C6B62}
.mdw-note{font-size:12px;color:#5C6B62;margin-top:9px;border-top:1px solid #E9EFEB;padding-top:9px}
.mdw-note a{color:#046B45}
.mdw-foot{flex:0 0 auto;border-top:1px solid #DCE5E0;background:#fff}
.mdw-diff{background:#F2F7FE;border-bottom:1px solid #D9E5F7;padding:13px 18px}
.mdw-dt{font-size:10.5px;letter-spacing:.12em;font-weight:700;color:#1B4F9C;margin-bottom:9px}
.mdw-dchip{display:inline-block;background:#fff;border:1px solid #C9DBF3;border-radius:7px;padding:4px 9px;font-size:12.5px;margin:0 6px 6px 0}
.mdw-dchip s{color:#5C6B62;text-decoration:line-through}
.mdw-dchip em{font-style:normal;color:#1B4F9C;font-weight:700}
.mdw-fine{font-size:11.5px;color:#264F8C;line-height:1.45;margin-top:3px}
.mdw-acts{display:flex;align-items:center;gap:9px;padding:13px 18px}
.mdw-cnt{font-size:13px;color:#5C6B62}
.mdw-msg{font-size:12.5px;font-weight:700}
.mdw-acts .mdw-sp{margin-left:auto;display:flex;gap:9px}
.mdw-gh{border:1px solid #DCE5E0;background:#fff;border-radius:9px;padding:9px 17px;color:#1B3227;font-family:inherit;font-weight:700;cursor:pointer}
.mdw-gh:disabled{opacity:.42;cursor:not-allowed}
.mdw-gh:not(:disabled):hover{background:#F2F7F4}
.mdw-go{border:0;background:#003326;color:#fff;border-radius:9px;padding:9px 21px;font-weight:700;font-family:inherit;cursor:pointer}
.mdw-go:disabled{background:#DCE3DF;color:#4E5A54;cursor:not-allowed}
.mdw-go:not(:disabled):hover{background:#01452F}
`;
