"use client";

// Phase 2 — the match field editor. STAGING only, guarded partial write.
//
// THE INVARIANT: the diff IS the payload. `state` is keyed by real API field
// names; `changedKeys` are the keys that differ from `loaded`; the diff chips and
// the request body are both built from that ONE list — `payload = pick(state,
// changedKeys)`. They cannot disagree because they are the same set. We send only
// what changed, so nothing untouched is transmitted and nothing untouched can be
// overwritten (the endpoint is a partial update).
//
// Editable via the match PUT: Match / Pricing / Spots ladder / Automation.
// Read-only this phase: Teams tee prices (separate endpoint PUT /admin/teams/{id})
// and the roster (Add/Move/Toggle-fake are separate endpoints). start/end are
// shown but never sent — changing them moves notifications/fake-spot/auto-cancel
// timing, so that becomes its own action.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { EDITABLE_KEYS, MONEY_KEYS as MONEY, TOGGLE_KEYS as TOGGLE, NULLABLE_NUM, fieldChanged } from "@/lib/matchEditModel";

type FieldRow = { id: number; title: string; city: string | null };
type Data = Record<string, unknown>;
type Spec = {
  key: string; group: "match" | "price" | "ladder" | "auto";
  kind: "text" | "textarea" | "select" | "number" | "money" | "toggle";
  label: string; hint?: string; opts?: [string | number, string][]; wide?: boolean; cond?: (s: Data) => boolean;
};

const LADDER = ["fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h"];
const CATS: [string, string][] = [["OPEN", "Open — Open to all"], ["PREMIER", "Premier — four stars and up"], ["LEGENDS", "Legends"], ["ACADEMY", "Academy"], ["CO_ED", "Co-ed"], ["FEMINE", "Women’s"], ["TOURNAMENT", "Tournament"]];
const TYPES: [string, string][] = [["REGULAR", "Regular"], ["EVENT", "Special event"], ["BRACKET", "Bracket"], ["GROUP", "Group"]];

function specs(fields: FieldRow[]): Spec[] {
  const fieldOpts: [number, string][] = fields.map((f) => [f.id, `${f.city ? f.city + " — " : ""}${f.title}`]);
  return [
    { key: "name", group: "match", kind: "text", label: "Name", wide: true },
    { key: "fieldId", group: "match", kind: "select", label: "Field", opts: fieldOpts },
    { key: "category", group: "match", kind: "select", label: "Category", opts: CATS },
    { key: "type", group: "match", kind: "select", label: "Type", opts: TYPES },
    { key: "managerId", group: "match", kind: "number", label: "Manager 1 (id)" },
    { key: "secondManagerId", group: "match", kind: "number", label: "Manager 2 (id)", hint: "Leave empty if only one" },
    { key: "description", group: "match", kind: "textarea", label: "Description", wide: true },
    { key: "managerIntro", group: "match", kind: "textarea", label: "Manager intro", wide: true },
    { key: "registrationPrice", group: "price", kind: "money", label: "Price" },
    { key: "additionalSpotPrice", group: "price", kind: "money", label: "Spot price" },
    { key: "guestCount", group: "price", kind: "number", label: "Guest count", hint: "Spots a player can buy for someone with no account" },
    ...LADDER.map((k, i) => ({ key: k, group: "ladder", kind: "number", label: ["36 h", "24 h", "12 h", "6 h", "3 h"][i] } as Spec)),
    { key: "autoCanceled", group: "auto", kind: "toggle", label: "Auto-cancel", hint: "Cancel automatically if the match has not filled" },
    { key: "autoCanceledMinutes", group: "auto", kind: "number", label: "Auto-cancel minutes", hint: "Minutes before kick-off" },
    { key: "minPlayerCount", group: "auto", kind: "number", label: "Min players", hint: "Below this, it cancels" },
    { key: "isFreeMember", group: "auto", kind: "toggle", label: "Free to member", hint: "Members join special events at no charge" },
    { key: "isAutoBump", group: "auto", kind: "toggle", label: "Auto bump to tourney", hint: "Grow the match to a tournament if it fills" },
    { key: "maxTeamSize2Team", group: "auto", kind: "number", label: "Bump size, 2 teams", cond: (s) => !!s.isAutoBump },
    { key: "maxTeamSize4Team", group: "auto", kind: "number", label: "Bump size, 4 teams", cond: (s) => !!s.isAutoBump },
  ];
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}
const money = (cents: unknown) => "$" + (Number(cents ?? 0) / 100).toFixed(2);

export default function MatchEditor({ id }: { id: string }) {
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [players, setPlayers] = useState<Data[]>([]);
  const [meta, setMeta] = useState<Data | null>(null); // read-only bits (start/end, teams, isCancelled)
  const [loaded, setLoaded] = useState<Data | null>(null);
  const [state, setState] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  // read-only roster preview controls (NOT saved fields)
  const [viewTeams, setViewTeams] = useState(2);
  const [viewSize, setViewSize] = useState(9);
  const [cancelArmed, setCancelArmed] = useState(false);

  const FIELDS = useMemo(() => specs(fields), [fields]);

  const ingest = useCallback((m: Data) => {
    const ed: Data = {};
    for (const k of EDITABLE_KEYS) ed[k] = m[k] ?? (TOGGLE.has(k) ? false : null);
    setLoaded(ed); setState(JSON.parse(JSON.stringify(ed)));
    setMeta({ id: m.id, startDate: m.startDate, endDate: m.endDate, isCancelled: m.isCancelled, teams: m.teams, fieldTitle: m.fieldTitle, cityName: m.cityName });
    const teamsArr = Array.isArray(m.teams) ? m.teams : [];
    setViewTeams(teamsArr.length >= 4 ? 4 : 2);
    setViewSize(Number(m.maxTeamSize2Team) || 9);
  }, []);

  const load = useCallback(async () => {
    setLoadErr(null); setMsg(null);
    const res = await authFetch(`/api/stage/matches/${id}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setLoadErr(json?.error ?? `HTTP ${res.status}`); return; }
    setFields(json.fields ?? []); setPlayers(json.players ?? []); ingest(json.match);
  }, [id, ingest]);
  useEffect(() => { void load(); }, [load]);

  const changedKeys = useMemo(() => {
    if (!state || !loaded) return [];
    return EDITABLE_KEYS.filter((k) => fieldChanged(loaded[k], state[k]));
  }, [state, loaded]);

  // THE PAYLOAD — the same key set the diff shows.
  const payload = useMemo(() => Object.fromEntries(changedKeys.map((k) => [k, state![k]])), [changedKeys, state]);

  const fmt = (k: string, v: unknown) => TOGGLE.has(k) ? (v ? "on" : "off")
    : MONEY.has(k) ? money(v)
    : k === "category" ? (CATS.find((c) => c[0] === v)?.[1] ?? String(v))
    : k === "type" ? (TYPES.find((c) => c[0] === v)?.[1] ?? String(v))
    : k === "fieldId" ? (fields.find((f) => f.id === v)?.title ?? String(v))
    : v === null || v === undefined || v === "" ? "—" : String(v);

  const set = (k: string, v: unknown) => setState((s) => ({ ...(s as Data), [k]: v }));

  if (loadErr) return <div style={{ padding: 24, fontFamily: "system-ui" }}><h1>Match {id}</h1><p style={{ color: "#A83120" }}>Couldn’t load: {loadErr}</p></div>;
  if (!state || !loaded || !meta) return <div style={{ padding: 24, fontFamily: "system-ui", color: "#5C6B62" }}>Loading match {id}…</div>;

  const groupCount = (g: Spec["group"]) => changedKeys.filter((k) => FIELDS.find((f) => f.key === k)?.group === g).length;
  const ladderVals = LADDER.map((k) => Number(state[k]));
  const descending = ladderVals.every((v, i) => i === 0 || v <= ladderVals[i - 1]);

  const renderField = (f: Spec) => {
    if (f.cond && !f.cond(state)) return null;
    const dirty = fieldChanged(loaded[f.key], state[f.key]);
    const cls = `f${dirty ? " dirty" : ""}${f.wide ? " wide" : ""}`;
    const lbl = <label>{f.label}{f.hint ? <span className="hint">{f.hint}</span> : null}</label>;
    let ctl: React.ReactNode;
    if (f.kind === "select") ctl = (
      <select data-k={f.key} data-testid={`in-${f.key}`} value={String(state[f.key] ?? "")} onChange={(e) => set(f.key, f.key === "fieldId" ? Number(e.target.value) : e.target.value)}>
        {(f.opts ?? []).map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    );
    else if (f.kind === "money") ctl = (
      <div className="money"><span>$</span>
        <input type="number" step="0.01" data-testid={`in-${f.key}`} value={(Number(state[f.key] ?? 0) / 100).toFixed(2)}
          onChange={(e) => set(f.key, Math.round((parseFloat(e.target.value) || 0) * 100))} /></div>
    );
    else if (f.kind === "number") ctl = (
      <input type="number" data-testid={`in-${f.key}`} value={state[f.key] === null || state[f.key] === undefined ? "" : String(state[f.key])}
        onChange={(e) => set(f.key, e.target.value === "" ? (NULLABLE_NUM.has(f.key) ? null : 0) : Number(e.target.value))} />
    );
    else if (f.kind === "textarea") ctl = <textarea data-testid={`in-${f.key}`} value={String(state[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
    else ctl = <input type="text" data-testid={`in-${f.key}`} value={String(state[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
    return <div className={cls} key={f.key} data-f={f.key}>{lbl}{ctl}</div>;
  };
  const renderToggle = (f: Spec) => {
    const dirty = fieldChanged(loaded[f.key], state[f.key]);
    return (
      <div className={`tg${dirty ? " dirty" : ""}`} key={f.key} data-f={f.key}>
        <button type="button" data-testid={`in-${f.key}`} aria-pressed={!!state[f.key]} onClick={() => set(f.key, !state[f.key])}><i /></button>
        <span><span className="tl">{f.label}</span><span className="th">{f.hint}</span></span>
      </div>
    );
  };
  const inGroup = (g: Spec["group"]) => FIELDS.filter((f) => f.group === g);

  const save = async () => {
    if (!changedKeys.length) return;
    setSaving(true); setMsg(null);
    const res = await authFetch(`/api/stage/matches/${id}`, { method: "PUT", body: JSON.stringify({ changes: payload }) });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setMsg({ kind: json?.ambiguous ? "warn" : "err", text: json?.error ?? `HTTP ${res.status}` }); return; }
    ingest(json.match); setMsg({ kind: "ok", text: "Saved." });
  };
  const revert = () => setState(JSON.parse(JSON.stringify(loaded)));

  const playerCount = players.length;
  const teamCols = Array.from({ length: viewTeams }, (_, t) => t);
  const slotsPerTeam = Math.max(0, viewSize);

  return (
    <div className="me">
      <style>{CSS}</style>

      <div className="head">
        <div>
          <h1 data-testid="title">{String(state.name)}</h1>
          <div className="hmeta">
            <span className="chip id">ID {String(meta.id)}</span>
            <span className={`chip ${meta.isCancelled ? "warn" : "live"}`}>{meta.isCancelled ? "Cancelled" : "Live"}</span>
            <span>{meta.startDate ? new Date(String(meta.startDate)).toLocaleString() : "—"} · {String(meta.fieldTitle ?? "—")}{meta.cityName ? ` · ${String(meta.cityName)}` : ""}</span>
            <span className="chip warn">STAGING · guarded</span>
          </div>
        </div>
      </div>

      <div className="cols">
        <div>
          {/* Match */}
          <section className="card"><div className="ch"><h2>Match</h2><span className="cnt" data-testid="cnt-match">{groupCount("match") ? `${groupCount("match")} changed` : ""}</span></div>
            <div className="cb"><div className="grid">{inGroup("match").map(renderField)}
              <div className="f"><label>Start and end<span className="hint">Set when the match was created; changing dates is its own action.</span></label>
                <input type="text" disabled value={`${meta.startDate ? new Date(String(meta.startDate)).toLocaleString() : "—"} → ${meta.endDate ? new Date(String(meta.endDate)).toLocaleTimeString() : "—"}`} /></div>
            </div></div></section>

          {/* Teams (read-only this phase) */}
          <section className="card"><div className="ch"><h2>Teams</h2><span className="cnt" data-testid="cnt-teams" /></div>
            <div className="cb"><div id="teamsRO">{(Array.isArray(meta.teams) ? meta.teams as Data[] : []).map((t) => (
              <div className="team" key={String(t.id)}><span className="nm"><i className="sw" style={{ background: Number(t.teamNumber) === 1 ? "#fff" : "#14352A" }} />{String(t.name)}</span>
                <div className="ro">{t.price == null ? "no price" : money(t.price)}{t.locked ? " · locked" : ""}</div></div>
            ))}</div>
            <div className="ladderNote">Team prices use a separate endpoint (<code>PUT /admin/teams/&#123;id&#125;</code>) and are edited with the roster actions — read-only here.</div></div></section>

          {/* Pricing */}
          <section className="card"><div className="ch"><h2>Pricing</h2><span className="cnt" data-testid="cnt-price">{groupCount("price") ? `${groupCount("price")} changed` : ""}</span></div>
            <div className="cb"><div className="grid three">{inGroup("price").map(renderField)}</div></div></section>

          {/* Spots ladder */}
          <section className="card"><div className="ch"><h2>Spots released before kick-off</h2><span className="cnt" data-testid="cnt-ladder">{groupCount("ladder") ? `${groupCount("ladder")} changed` : ""}</span></div>
            <div className="cb"><div className="ladder">{inGroup("ladder").map(renderField)}</div>
              <div className="ladderNote" data-testid="ladder-note">{descending
                ? "Spots still unsold are released back at each mark. Each number should be no higher than the one before it."
                : <><b>These should descend.</b> {ladderVals.join(" → ")} rises at some point, which releases more spots closer to kick-off than further out.</>}</div></div></section>

          {/* Automation */}
          <section className="card"><div className="ch"><h2>Automation</h2><span className="cnt" data-testid="cnt-auto">{groupCount("auto") ? `${groupCount("auto")} changed` : ""}</span></div>
            <div className="cb">
              {renderToggle(inGroup("auto").find((f) => f.key === "autoCanceled")!)}
              <div className="grid">{["autoCanceledMinutes", "minPlayerCount"].map((k) => renderField(inGroup("auto").find((f) => f.key === k)!))}</div>
              {renderToggle(inGroup("auto").find((f) => f.key === "isFreeMember")!)}
              {renderToggle(inGroup("auto").find((f) => f.key === "isAutoBump")!)}
              {state.isAutoBump ? <div className="grid" data-testid="bumps">{["maxTeamSize2Team", "maxTeamSize4Team"].map((k) => renderField(inGroup("auto").find((f) => f.key === k)!))}</div> : null}
            </div></section>

          {/* Cancel — its own red card, never in the save bar */}
          <section className="card danger" data-testid="cancel-card"><div className="ch"><h2>Cancel this match</h2></div>
            <div className="cb"><div className="dz">
              <p><b>{playerCount === 0 ? "No players are signed up." : `${playerCount} player${playerCount === 1 ? "" : "s"} ${playerCount === 1 ? "is" : "are"} signed up.`}</b> Cancelling notifies every one of them and starts refunds. It is not part of Save — it happens on its own.</p>
              <button className="dbtn" data-testid="cancel-btn" aria-pressed={cancelArmed} onClick={() => setCancelArmed((a) => !a)}>{cancelArmed ? "Confirm cancel" : "Cancel match"}</button>
            </div>
            {cancelArmed ? <div className="ladderNote" style={{ marginTop: 10 }}>Would call <code>PATCH /admin/matches/{id}/cancel</code> — a separate action, not wired in this phase.</div> : null}</div></section>
        </div>

        {/* Roster — read-only */}
        <div className="card sticky">
          <div className="ch"><h2>Players in the match</h2><span className="cnt" data-testid="pcount">{playerCount}</span></div>
          <div className="cb">
            <div className="viewctl">
              <label>Preview layout <span className="hint">Not saved — shapes the roster only</span></label>
              <div className="viewrow">
                <span>Teams</span>
                <select data-testid="view-teamnumbers" value={viewTeams} onChange={(e) => setViewTeams(Number(e.target.value))}><option value={2}>2</option><option value={4}>4</option></select>
                <span>× size</span>
                <input type="number" data-testid="view-teamsize" value={viewSize} onChange={(e) => setViewSize(Math.max(0, Number(e.target.value)))} style={{ width: 68 }} />
              </div>
            </div>
            <div className="roster" data-testid="roster">
              {teamCols.map((t) => (
                <div className="teamcol" data-testid="team-col" key={t}>
                  <div className="tch">Team {t + 1}</div>
                  {Array.from({ length: slotsPerTeam }, (_, s) => {
                    const p = players[t * slotsPerTeam + s] as Data | undefined;
                    return <div className="slot" data-testid="slot" key={s}><span className="sn">{s + 1}</span>{p ? <span>{String(p.firstName ?? p.name ?? "Player")}</span> : <span className="open">open</span>}</div>;
                  })}
                </div>
              ))}
            </div>
            <div className="pfoot">{playerCount} in match · {teamCols.length * slotsPerTeam} slots shown. Add / Move / Toggle-fake are separate endpoints (later phase).</div>
          </div>
        </div>
      </div>

      {/* Sticky save bar — diff panel IS the payload; Cancel is NOT here */}
      <div className="savebar" data-testid="savebar">
        {changedKeys.length ? (
          <div className="diff"><div className="diffin">
            <h3>About to change — this list is the request body</h3>
            <div className="dl" data-testid="diff-list">{changedKeys.map((k) => (
              <span className="di" data-testid="diff-item" data-key={k} data-from={JSON.stringify(loaded[k] ?? null)} data-to={JSON.stringify(state[k] ?? null)} key={k}>{FIELDS.find((f) => f.key === k)?.label} <s>{fmt(k, loaded[k])}</s> → <b>{fmt(k, state[k])}</b></span>
            ))}</div>
            <div className="diffnote">Partial update: only these {changedKeys.length} field{changedKeys.length === 1 ? "" : "s"} are sent. Everything you did not touch is left exactly as it was.</div>
          </div></div>
        ) : null}
        <div className="sbin">
          <span className="sbtxt" data-testid="sb-text">{changedKeys.length ? <><b>{changedKeys.length}</b> {changedKeys.length === 1 ? "change" : "changes"} not saved</> : "No changes"}</span>
          {msg ? <span className="sbmsg" data-testid="sb-msg" style={{ color: msg.kind === "ok" ? "#046B45" : msg.kind === "warn" ? "#7A5200" : "#A83120" }}>{msg.kind === "warn" ? "⚠ " : ""}{msg.text}</span> : null}
          <span className="sbact">
            <button className="btn" data-testid="revert" disabled={!changedKeys.length || saving} onClick={revert}>Revert</button>
            <button className="btn go" data-testid="save" disabled={!changedKeys.length || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.me{--forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--faint:#5a6961;--paper:#fff;--line:#E3E8E0;--slot:#F7F9F6;
  --mint:#2CDB87;--mintSoft:#E9FAF1;--mintEdge:#A8E7C9;--mintInk:#046B45;--amber:#FFF6D6;--amberEdge:#F0DC9B;
  --amberInk:#7A5200;--coral:#FDE9E5;--coralEdge:#F3C4BB;--coralInk:#A83120;--blue:#EFF3FF;--blueEdge:#CBD9FF;--blueInk:#1B4FCB;
  background:#F4EEE1;min-height:100vh;padding:0 0 130px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:var(--ink);max-width:1500px;margin:0 auto}
.me .head{padding:22px 24px 14px;display:flex;gap:18px;flex-wrap:wrap}
.me h1{margin:0;font-size:24px;font-weight:900;letter-spacing:-.5px;color:var(--forest)}
.me .hmeta{margin-top:7px;font-size:12.5px;color:var(--muted);display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.me .chip{font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;border-radius:99px;padding:3px 9px;white-space:nowrap}
.me .chip.live{background:var(--mintSoft);color:var(--mintInk);border:1px solid var(--mintEdge)}
.me .chip.id{background:var(--slot);color:var(--muted);border:1px solid var(--line);font-variant-numeric:tabular-nums}
.me .chip.warn{background:var(--amber);color:var(--amberInk);border:1px solid var(--amberEdge)}
.me .cols{display:grid;grid-template-columns:1fr 400px;gap:18px;align-items:start;padding:0 24px}
@media(max-width:1100px){.me .cols{grid-template-columns:1fr}}
.me .card{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 9px 26px rgba(0,51,38,.06);margin-bottom:16px;overflow:hidden}
.me .card.sticky{position:sticky;top:16px}
.me .ch{display:flex;align-items:center;gap:11px;padding:13px 18px;border-bottom:1px solid var(--line)}
.me .ch h2{margin:0;font-size:12px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.me .ch .cnt{margin-left:auto;font-size:11px;font-weight:850;color:var(--mintInk)}
.me .cb{padding:15px 18px}
.me .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:13px}
.me .grid.three{grid-template-columns:repeat(3,1fr)}
.me .f{display:flex;flex-direction:column;gap:6px}
.me .f.wide{grid-column:1/-1}
.me label{font-size:10px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
.me label .hint{display:block;margin-top:3px;font-size:10px;font-weight:700;letter-spacing:0;text-transform:none;color:var(--faint)}
.me input[type=text],.me input[type=number],.me select,.me textarea{width:100%;font-family:inherit;font-size:13px;font-weight:750;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:9px;padding:9px 11px}
.me textarea{min-height:88px;resize:vertical;line-height:1.5;font-weight:600}
.me input:focus,.me select:focus,.me textarea:focus{outline:2px solid var(--mint);outline-offset:-1px;border-color:var(--mint)}
.me input:disabled,.me select:disabled{background:var(--slot);color:var(--faint);cursor:not-allowed}
.me .money{position:relative}
.me .money span{position:absolute;left:11px;top:50%;transform:translateY(-50%);font-size:13px;font-weight:850;color:var(--muted)}
.me .money input{padding-left:24px}
.me .f.dirty input,.me .f.dirty select,.me .f.dirty textarea{border-color:var(--blueEdge);background:var(--blue)}
.me .f.dirty label{color:var(--blueInk)}
.me .tg{display:flex;align-items:center;gap:11px;padding:9px 0}
.me .tg button{width:42px;height:24px;border-radius:99px;border:1px solid var(--line);background:var(--slot);position:relative;cursor:pointer;flex:none;padding:0}
.me .tg button i{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:left .12s}
.me .tg button[aria-pressed=true]{background:var(--mint);border-color:#16C275}
.me .tg button[aria-pressed=true] i{left:21px}
.me .tg .tl{font-size:13px;font-weight:800;color:var(--ink)}
.me .tg .th{font-size:11px;color:var(--muted);display:block}
.me .ladder{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;background:var(--slot);border:1px solid var(--line);border-radius:12px;padding:12px}
.me .ladder .f label{text-align:center}
.me .ladder input{text-align:center;font-variant-numeric:tabular-nums}
.me .ladderNote{font-size:11px;color:var(--muted);margin-top:9px;line-height:1.5}
.me .ladderNote b{color:var(--coralInk);font-weight:900}
.me .ladderNote code{background:var(--slot);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:10.5px}
.me .team{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:11px;margin-bottom:9px}
.me .team:last-child{margin-bottom:0}
.me .team .nm{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:850}
.me .team .ro{font-size:12px;font-weight:800;color:var(--muted)}
.me .team .sw{width:14px;height:14px;border-radius:4px;border:1px solid rgba(0,51,38,.2);flex:none}
.me .card.danger{border-color:var(--coralEdge)}
.me .card.danger .ch{background:var(--coral);border-bottom-color:var(--coralEdge)}
.me .card.danger .ch h2{color:var(--coralInk)}
.me .dz{display:flex;align-items:center;gap:14px}
.me .dz p{margin:0;font-size:12px;color:var(--muted);line-height:1.5}
.me .dz p b{color:var(--ink);font-weight:850}
.me .dbtn{margin-left:auto;background:#fff;border:1px solid var(--coralEdge);color:var(--coralInk);font-family:inherit;font-size:12px;font-weight:900;border-radius:9px;padding:9px 15px;cursor:pointer;white-space:nowrap;flex:none}
.me .dbtn[aria-pressed=true]{background:var(--coralInk);border-color:var(--coralInk);color:#fff}
.me .viewctl{margin-bottom:12px}
.me .viewrow{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;font-weight:800;color:var(--muted)}
.me .viewrow select,.me .viewrow input{width:auto;padding:6px 9px}
.me .roster{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px;overflow-x:auto}
.me .teamcol{border:1px solid var(--line);border-radius:10px;padding:8px;min-width:120px}
.me .tch{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:7px}
.me .slot{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:750;padding:6px 7px;border-bottom:1px solid #EDF1EC}
.me .slot .sn{font-size:10px;font-weight:900;color:var(--faint);min-width:15px;font-variant-numeric:tabular-nums}
.me .slot .open{color:var(--faint);font-weight:700}
.me .pfoot{font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5}
.me .savebar{position:fixed;left:0;right:0;bottom:0;background:var(--paper);border-top:1px solid var(--line);box-shadow:0 -8px 24px rgba(0,51,38,.09);z-index:60}
.me .savebar .diff{max-width:1500px;margin:0 auto;padding:12px 24px 0}
.me .diffin{background:var(--blue);border:1px solid var(--blueEdge);border-radius:12px;padding:11px 14px}
.me .diffin h3{margin:0 0 8px;font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--blueInk)}
.me .dl{display:flex;flex-wrap:wrap;gap:8px}
.me .di{background:#fff;border:1px solid var(--blueEdge);border-radius:99px;padding:5px 12px;font-size:11.5px;font-weight:850;color:var(--ink)}
.me .di b{color:var(--blueInk)}
.me .di s{color:var(--faint);text-decoration:line-through;font-weight:700}
.me .diffnote{font-size:11px;color:var(--blueInk);margin-top:9px;line-height:1.5;font-weight:700}
.me .sbin{max-width:1500px;margin:0 auto;padding:12px 24px;display:flex;align-items:center;gap:14px}
.me .sbtxt{font-size:12.5px;font-weight:850;color:var(--muted)}
.me .sbtxt b{color:var(--forest)}
.me .sbmsg{font-size:12.5px;font-weight:850}
.me .sbact{margin-left:auto;display:flex;gap:9px}
.me .btn{font-family:inherit;font-size:12.5px;font-weight:900;border-radius:9px;padding:10px 17px;cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--forest)}
.me .btn.go{background:var(--forest);border-color:var(--forest);color:#fff}
.me .btn.go:disabled{background:var(--slot);border-color:var(--line);color:var(--faint);cursor:not-allowed}
.me .btn:disabled{color:var(--faint);cursor:not-allowed}
`;
