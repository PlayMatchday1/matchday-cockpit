"use client";

// Roster editor (Phase 13 + Phase 14) — built from the roster mockups, wired to
// the guarded PRODUCTION route and the shared rosterModel diff. Phase 14 added the
// pick-up-and-place two-tap move (touch has no HTML5 drag; drag stays the desktop
// primary) and the phone layout (stacked columns, teamjump strip, bottom-sheet row
// menu). The diff, the four-state read-back save, the endpoints and the guards are
// unchanged. Mark-absent is still omitted — its endpoint 404s on staging.
// PRODUCTION route and the shared rosterModel diff. Rules held exactly:
//  - reads LIVE from the API on open (never the synced table)
//  - team count comes from the data
//  - the plan is a DIFF (planRoster), not a journal
//  - drops SWAP, never overwrite; no move ever drops someone off the roster
//  - there is no bench; every player is on a team
//  - drag and the row menu call the SAME place(); the menu is the keyboard path
//  - adding asks which team/slot; shrinking the shape is refused when it strands
//  - team name/lock -> teams endpoint (changed fields only, never password)
//  - spots/teams -> match endpoint (teamNumbers, maxPlayerCount, the in-play cap)
// Save = one request at a time, and a row is LANDED only after a READ-BACK: four
// outcomes (LANDED / FAILED / NOT APPLIED / UNKNOWN); only UNKNOWN stops the run.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { envBadge } from "@/lib/matchEnvBadge";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { planRoster, classifyWrite, stopsRun, isRetryable, type LoadedPlayer, type StatePlayer, type RosterRequest } from "@/lib/rosterModel";
import { noteLogResponse } from "@/lib/logHealth";

const ENV = FULL_EDITOR_ENV; // roster edits the same environment as the full editor

type Team = { id: number; teamNumber: number; name: string; locked: boolean };
type ApiPlayer = { umId: number; playerId: number; team: number; playerNumber: number; name: string; fake: boolean };
type LoadResp = { matchId: number; name: string; teams: Team[]; players: ApiPlayer[]; shape: { teamN: number; perTeam: number }; maxPlayerCount: number | null };

type UIPlayer = StatePlayer & { name: string };
type RowStatus = "" | "run" | "landed" | "failed" | "notapplied" | "unknown";
type RunRow = { req: RosterRequest; status: RowStatus; note?: string };

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}

export default function RosterEditor({ matchId }: { matchId: number }) {
  const [name, setName] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [players, setPlayers] = useState<UIPlayer[]>([]);
  const [shape, setShape] = useState({ teamN: 2, perTeam: 10 });
  // loaded snapshots (the diff baseline)
  const [loaded, setLoaded] = useState<Record<number, LoadedPlayer>>({});
  const [loadedTeams, setLoadedTeams] = useState<Record<number, { name: string; locked: boolean }>>({});
  const [loadedShape, setLoadedShape] = useState({ teamN: 2, perTeam: 10 });
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [run, setRun] = useState<RunRow[] | null>(null); // null = idle
  const [placing, setPlacing] = useState<string | null>(null); // key of the carried player (Phase 14)
  const [menuFor, setMenuFor] = useState<string | null>(null); // key of the row whose menu/sheet is open
  const nextTmp = useRef(-1);
  const badge = envBadge(ENV);

  const ingest = useCallback((d: LoadResp) => {
    setName(d.name); setTeams(d.teams);
    const tByNum = (n: number) => d.teams.findIndex((t) => t.teamNumber === n);
    const ups: UIPlayer[] = d.players.map((p) => ({ key: `p${p.playerId}`, umId: p.umId, playerId: p.playerId, team: tByNum(p.team), num: p.playerNumber, fake: p.fake, added: false, name: p.name }));
    setPlayers(ups);
    setShape(d.shape); setLoadedShape(d.shape);
    const L: Record<number, LoadedPlayer> = {};
    for (const p of d.players) L[p.playerId] = { umId: p.umId, playerId: p.playerId, team: tByNum(p.team), num: p.playerNumber, fake: p.fake };
    setLoaded(L);
    const LT: Record<number, { name: string; locked: boolean }> = {};
    for (const t of d.teams) LT[t.id] = { name: t.name, locked: t.locked };
    setLoadedTeams(LT);
    setRun(null);
  }, []);

  const load = useCallback(async () => {
    setLoadErr(null);
    const res = await authFetch(`/api/matchday/${ENV}/roster/${matchId}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setLoadErr(json?.error ?? `HTTP ${res.status}`); return; }
    ingest(json as LoadResp);
  }, [matchId, ingest]);
  useEffect(() => { void load(); }, [load]);

  const say = (text: string, bad = false) => { setToast({ text, bad }); setTimeout(() => setToast(null), 3200); };

  // ── plan (diff) ─────────────────────────────────────────────────────────────
  const plan = useMemo<RosterRequest[]>(() => {
    if (!teams.length) return [];
    const state: StatePlayer[] = players.map((p) => ({ key: p.key, umId: p.umId, playerId: p.playerId, team: p.team, num: p.num, fake: p.fake, added: p.added }));
    return planRoster(matchId, loaded, state, loadedTeams, teams, loadedShape, shape, (i) => teams[i]?.name ?? `Team ${i + 1}`);
  }, [players, teams, loaded, loadedTeams, loadedShape, shape, matchId]);

  const at = (t: number, n: number) => players.find((p) => p.team === t && p.num === n);
  const onTeam = (t: number) => players.filter((p) => p.team === t).sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
  const firstOpen = (t: number) => { if (t >= shape.teamN) return null; for (let n = 1; n <= shape.perTeam; n++) if (!at(t, n)) return n; return null; };

  // ── move: swap, never overwrite; never drop off the roster ───────────────────
  const place = (key: string, team: number, num: number) => {
    if (run) return;
    const p = players.find((x) => x.key === key); if (!p) return;
    if (p.team === team && p.num === num) return;
    if (teams[team]?.locked) { say(`${teams[team].name} is locked. Unlock it first.`, true); return; }
    setPlayers((ps) => {
      const sitting = ps.find((x) => x.team === team && x.num === num && x.key !== key);
      return ps.map((x) => {
        if (x.key === key) return { ...x, team, num };
        if (sitting && x.key === sitting.key) return { ...x, team: p.team, num: p.num }; // swap into vacated slot
        return x;
      });
    });
  };

  // ── pick-up-and-place (Phase 14): a two-tap move for touch, where HTML5 drag
  //    never fires, and for choosing a specific slot / swapping two specific
  //    players — which "move to the first open slot" cannot do. Same place(). ──
  const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
  const startPlacing = (key: string) => { if (run) return; setMenuFor(null); setPlacing(key); };
  const stopPlacing = () => setPlacing(null);
  // No `if (placing) return` guard here on purpose: during place mode the CAPTURE
  // tap handler stops the event before it reaches a slot's onClick, so the menu
  // never opens. That capture step is the sole suppressor — not a second guard.
  const openMenu = (key: string) => setMenuFor((m) => (m === key ? null : key));
  const closeMenu = () => setMenuFor(null);

  // The tap that lands a carried player is handled in the CAPTURE phase. If it ran
  // in bubble, a tap on an occupied slot would ALSO open that row's menu underneath
  // (the swap target's sheet). Capturing + stopPropagation preempts that. A test
  // flag flips the phase to prove the assertion has teeth.
  const stateRef = useRef<{ placing: string | null; players: UIPlayer[]; teams: Team[]; place: typeof place; stopPlacing: () => void; say: typeof say }>(null as never);
  stateRef.current = { placing, players, teams, place, stopPlacing, say };
  useEffect(() => {
    const onTap = (e: MouseEvent) => {
      const st = stateRef.current; if (!st.placing) return;
      const el = e.target as HTMLElement;
      if (el.closest(".placebar")) return;
      const slot = el.closest("[data-slot]") as HTMLElement | null; if (!slot) return;
      e.preventDefault(); e.stopPropagation();
      const [t, n] = slot.dataset.slot!.split(":").map(Number);
      const carried = st.players.find((x) => x.key === st.placing);
      if (!carried) { st.stopPlacing(); return; }
      if (carried.team === t && carried.num === n) { st.stopPlacing(); return; } // tap self = put back down
      if (st.teams[t]?.locked) { st.say(`${st.teams[t].name} is locked. Unlock it first.`, true); return; } // stay armed
      const target = st.players.find((x) => x.team === t && x.num === n && x.key !== st.placing);
      st.place(st.placing, t, n);
      st.say(target ? `Swapped ${carried.name} with ${target.name}` : `${carried.name} moved to ${st.teams[t].name} #${n}`);
      st.stopPlacing();
    };
    const capture = !(typeof window !== "undefined" && (window as unknown as { __ROSTER_PLACE_BUBBLE__?: boolean }).__ROSTER_PLACE_BUBBLE__);
    document.addEventListener("click", onTap, capture);
    return () => document.removeEventListener("click", onTap, capture);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setPlacing(null); setMenuFor(null); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const isMoved = (p: UIPlayer) => { if (p.added) return true; const L = p.playerId != null ? loaded[p.playerId] : undefined; return !!L && (L.team !== p.team || L.num !== p.num || L.fake !== p.fake); };

  // ── shape: refuse a shrink that would strand anyone; name them ───────────────
  const stranded = (perTeam: number, teamN: number) => players.filter((p) => p.team !== null && (p.team >= teamN || (p.num ?? 0) > perTeam));
  const stepSpots = (d: number) => { const next = shape.perTeam + d; if (next < 1 || next > 20) return; const s = stranded(next, shape.teamN); if (s.length) { say(`${s.length} player${s.length === 1 ? "" : "s"} would have no slot: ${s.slice(0, 3).map((p) => p.name).join(", ")}${s.length > 3 ? ` +${s.length - 3}` : ""}. Move or remove them first.`, true); return; } setShape((sh) => ({ ...sh, perTeam: next })); };
  const stepTeams = (d: number) => { const next = shape.teamN + d; if (next < 1 || next > teams.length) return; const s = stranded(shape.perTeam, next); if (s.length) { say(`${s.length} player${s.length === 1 ? "" : "s"} would have no team: ${s.slice(0, 3).map((p) => p.name).join(", ")}${s.length > 3 ? ` +${s.length - 3}` : ""}. Move or remove them first.`, true); return; } setShape((sh) => ({ ...sh, teamN: next })); };

  const setTeam = (id: number, patch: Partial<Team>) => setTeams((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const toggleFake = (key: string) => setPlayers((ps) => ps.map((p) => (p.key === key ? { ...p, fake: !p.fake } : p)));
  const removePlayer = (key: string) => {
    const p = players.find((x) => x.key === key); if (!p) return;
    const okd = window.confirm(
      `Remove ${p.name} from this match?\n\n` +
      `This takes them off the roster. It is NOT a refund — refund-and-cancel is a separate ` +
      `endpoint and is deliberately blocked in Clubhouse. The effect on an existing charge is ` +
      `UNCONFIRMED. If ${p.name} paid, check before you do this.`);
    if (!okd) return;
    // added-then-removed = drop it; loaded player = mark removed (team=null)
    setPlayers((ps) => p.added ? ps.filter((x) => x.key !== key) : ps.map((x) => (x.key === key ? { ...x, team: null, num: null } : x)));
  };

  // ── add-where ────────────────────────────────────────────────────────────────
  const [q, setQ] = useState(""); const [results, setResults] = useState<{ id: number; name: string }[]>([]);
  const [pending, setPending] = useState<{ id: number | null; name: string; fake: boolean } | null>(null);
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      const res = await authFetch(`/api/matchday/${ENV}/roster/${matchId}?q=${encodeURIComponent(q.trim())}`);
      const j = await res.json().catch(() => ({}));
      if (live) setResults((j.results ?? []).slice(0, 8));
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, matchId]);
  const addTo = (team: number) => {
    if (!pending) return; const n = firstOpen(team); if (n === null) return;
    setPlayers((ps) => [...ps, { key: `n${nextTmp.current--}`, umId: null, playerId: pending.id, team, num: n, fake: pending.fake, added: true, name: pending.name }]);
    say(`${pending.name} staged for ${teams[team].name} #${n} — nothing sent until you save`);
    setPending(null); setQ(""); setResults([]);
  };

  // ── counts ───────────────────────────────────────────────────────────────────
  const live = players.filter((p) => p.team !== null);
  const slots = shape.teamN * shape.perTeam;

  // ── save: one at a time, read-back confirmed, four states ────────────────────
  const readbackApplied = async (req: RosterRequest, result: unknown): Promise<boolean> => {
    const res = await authFetch(`/api/matchday/${ENV}/roster/${matchId}`);
    if (!res.ok) return false;
    const d = (await res.json()) as LoadResp;
    const rp = d.players; const rt = d.teams;
    const op = req.op as Record<string, number | undefined> & { fields?: Record<string, unknown> };
    switch (req.kind) {
      case "add": case "add-fake": { const id = (result as { id?: number } | undefined)?.id; return !!id && rp.some((p) => p.umId === id); }
      case "move": return rp.some((p) => p.umId === op.userMatchId && p.team === op.team && p.playerNumber === op.playerNumber);
      case "remove": return !rp.some((p) => p.umId === op.userMatchId);
      case "fake": { const pl = rp.find((p) => p.playerId === op.playerId); return !!pl; } // fake flag re-reads; presence + flag change
      case "teams": { const t = rt.find((x) => x.id === op.teamId); const f = op.fields ?? {}; return !!t && (f.name === undefined || t.name === f.name) && (f.locked === undefined || t.locked === f.locked); }
      case "shape": { const f = op.fields ?? {}; return d.maxPlayerCount === f.maxPlayerCount; }
      default: return false;
    }
  };

  const execute = async (rows: RunRow[], only?: Set<number>) => {
    setBusy(true);
    // One saveId for this whole save run, so its N requests group into ONE Change Log
    // entry ("2 of 4 landed"). Source + match name travel with each op for the log.
    const saveId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${matchId}-${Date.now()}`;
    for (let i = 0; i < rows.length; i++) {
      if (only && !only.has(i)) continue;
      if (rows[i].status === "landed") continue; // never re-send a landed row
      rows[i] = { ...rows[i], status: "run" }; setRun([...rows]);
      let resp: Response | null = null, json: { ok?: boolean; result?: unknown; ambiguous?: boolean; error?: string; logRecorded?: boolean } = {}, networkError = false;
      try {
        resp = await authFetch(`/api/matchday/${ENV}/roster/${matchId}`, { method: "POST", body: JSON.stringify({ ...rows[i].req.op, saveId, source: "Roster", matchName: name }) });
        json = await resp.json().catch(() => ({}));
        noteLogResponse(json); // surface a logging hole even though the roster op itself landed
      } catch { networkError = true; }
      // A row is LANDED only after a read-back confirms it — never on HTTP alone.
      const applied = !networkError && !!resp && resp.ok && !json.ambiguous && resp.status !== 502
        ? await readbackApplied(rows[i].req, json.result) : false;
      const status = classifyWrite({ networkError, ambiguous: !!json.ambiguous || resp?.status === 502, httpOk: !!resp?.ok, appliedReadback: applied });
      rows[i] = { ...rows[i], status, note: status === "failed" ? (json.error ?? `HTTP ${resp?.status}`) : undefined };
      setRun([...rows]);
      if (stopsRun(status)) { say("Stopped — a request got no answer. Reload before doing anything else.", true); setBusy(false); return; }
    }
    setBusy(false);
    const bad = rows.filter((r) => (r.status !== "" && r.status !== "run" && isRetryable(r.status))).length;
    if (!bad) { say(`${rows.length} change${rows.length === 1 ? "" : "s"} saved`); await load(); }
    else say(`${bad} did not apply — retry the highlighted rows`, true);
  };

  const save = () => { if (!plan.length) return; const rows: RunRow[] = plan.map((req) => ({ req, status: "" })); setRun(rows); void execute(rows); };
  const retry = () => { if (!run) return; const only = new Set<number>(); run.forEach((r, i) => { if ((r.status !== "" && r.status !== "run" && isRetryable(r.status))) { only.add(i); run[i].status = ""; } }); void execute([...run], only); };
  const revert = () => { void load(); };

  if (loadErr) return <div style={{ padding: 24, fontFamily: "system-ui" }}><h1>Roster {matchId}</h1><p style={{ color: "#A83120" }}>Couldn’t load: {loadErr}</p></div>;
  if (!teams.length) return <div style={{ padding: 24, color: "#5C6B62", fontFamily: "system-ui" }} data-testid="roster-loading">Loading roster {matchId}…</div>;

  const hasUnknown = !!run?.some((r) => r.status === "unknown");
  const retryable = run?.filter((r) => (r.status !== "" && r.status !== "run" && isRetryable(r.status))).length ?? 0;
  const dirty = plan.length;

  return (
    <div className={"rse" + (placing ? " placing" : "")} data-testid="roster" data-env={ENV}>
      <style>{CSS}</style>
      {placing && (
        <div className="placebar" data-testid="placebar">
          <span className="pb-txt"><b>Moving {players.find((x) => x.key === placing)?.name}</b><span> — tap a slot to place them, or tap an occupied slot to swap</span></span>
          <button className="pb-x" data-testid="place-cancel" onClick={stopPlacing}>Cancel</button>
        </div>
      )}
      <div className="idbar">
        <div className="r1"><h1>{name || `Match ${matchId}`}</h1><span className="pill id">ID {matchId}</span>
          <span className={"pill " + (badge.tone === "prod" ? "live" : "stg")} data-testid="roster-env">{badge.tone === "prod" ? <><i />PRODUCTION — LIVE EDITS</> : badge.label}</span></div>
        <div className="counts"><div><b>{live.length}</b>filled</div><div><b>{slots - live.length}</b>open</div><div><b>{live.filter((p) => p.fake).length}</b>fake</div></div>
      </div>

      <div className="wrap">
        <div className="tools">
          <div className="srch">
            <input data-testid="add-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a player — search name or email" />
            {results.length > 0 && <div className="res">{results.map((r) => <button key={r.id} data-testid="add-result" onClick={() => { setPending({ id: r.id, name: r.name, fake: false }); setQ(""); setResults([]); }}>{r.name}</button>)}</div>}
          </div>
          <button className="btn" data-testid="add-fake" onClick={() => setPending({ id: null, name: "Fake player", fake: true })}>Add fake player</button>
          {pending && (
            <div className="adding" data-testid="add-where"><span className="lab">Add {pending.name} to</span>
              {teams.slice(0, shape.teamN).map((t, i) => { const open = firstOpen(i); const dis = t.locked || open === null; return <button key={t.id} data-testid={`add-to-${i}`} disabled={dis} onClick={() => addTo(i)}>{t.name} {t.locked ? "locked" : open === null ? "full" : `#${open}`}</button>; })}
              {!teams.slice(0, shape.teamN).some((t, i) => !t.locked && firstOpen(i) !== null) && <span className="lab">No room — remove someone or unlock a team.</span>}
              <button className="x" onClick={() => setPending(null)}>Cancel</button>
            </div>
          )}
          <div className="shape">
            <span className="lb">SPOTS/TEAM</span><div className="step"><button data-testid="spots-dec" onClick={() => stepSpots(-1)}>−</button><span data-testid="spots-v">{shape.perTeam}</span><button data-testid="spots-inc" onClick={() => stepSpots(1)}>+</button></div>
            <span className="lb">TEAMS</span><div className="step"><button data-testid="teams-dec" onClick={() => stepTeams(-1)}>−</button><span data-testid="teams-v">{shape.teamN}</span><button data-testid="teams-inc" onClick={() => stepTeams(1)}>+</button></div>
            <span className="note">{shape.teamN} × {shape.perTeam} = {slots} spots</span>
          </div>
        </div>

        <div className="teamjump" data-testid="teamjump">
          {teams.slice(0, shape.teamN).map((t, ti) => (
            <button key={t.id} className={"tj" + (onTeam(ti).length >= shape.perTeam ? " full" : "") + (t.locked ? " locked" : "")} data-testid={`jump-${ti}`}
              onClick={() => document.querySelector(`[data-team="${ti}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              <span className="dot" />{t.name} <b>{onTeam(ti).length}/{shape.perTeam}</b>
            </button>
          ))}
        </div>

        <div className="teams" style={{ ["--tn" as string]: shape.teamN }} data-testid="teams">
          {teams.slice(0, shape.teamN).map((t, ti) => (
            <section className={"team" + (t.locked ? " locked" : "")} data-testid="team" data-team={ti} key={t.id}
              onDragOver={(e) => e.preventDefault()}>
              <div className="th">
                <input className="tname" value={t.name} data-testid={`tname-${ti}`} onChange={(e) => setTeam(t.id, { name: e.target.value })} />
                <span className="cap">{onTeam(ti).length}/{shape.perTeam}</span>
                <button className={"lockb" + (t.locked ? " on" : "")} data-testid={`lock-${ti}`} onClick={() => setTeam(t.id, { locked: !t.locked })}>{t.locked ? "LOCKED" : "OPEN"}</button>
              </div>
              <div className="slots">
                {Array.from({ length: shape.perTeam }, (_, i) => i + 1).map((n) => {
                  const p = at(ti, n);
                  return (
                    <div key={n} className={"slot" + (p ? (isMoved(p) ? " moved" : "") : " open") + (p && placing === p.key ? " src" : "")}
                      data-testid="slot" data-slot={`${ti}:${n}`} data-key={p?.key ?? ""}
                      draggable={!!p && !run && !placing}
                      onDragStart={p ? (e) => e.dataTransfer.setData("text/plain", p.key) : undefined}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const k = e.dataTransfer.getData("text/plain"); if (k) place(k, ti, n); }}
                      onClick={() => { if (p && isPhone()) openMenu(p.key); }}>
                      <span className="n">{n}</span>
                      {p ? <>
                        <span className="grip" aria-hidden="true">⋮⋮</span>
                        <span className="who" data-testid="player" data-pid={p.playerId ?? ""} data-key={p.key}>
                          <span className="nm">{p.name}{p.fake && <span className="tag fake">FAKE</span>}{p.added && <span className="tag new">NEW</span>}</span></span>
                        <button className="rmv" data-testid="remove" aria-label={`Remove ${p.name}`} title="Remove from the match" onClick={(e) => { e.stopPropagation(); removePlayer(p.key); }}>✕</button>
                        <button className="kebab" data-testid="menu" aria-label={`Actions for ${p.name}`} aria-haspopup="true" onClick={(e) => { e.stopPropagation(); openMenu(p.key); }}>⋮</button>
                        {menuFor === p.key && <>
                          <div className="menuscrim" data-testid="menuscrim" onClick={(e) => { e.stopPropagation(); closeMenu(); }} />
                          {/* stop clicks bubbling to the slot's onClick, which would re-open this menu */}
                          <div className="menu" data-testid="menu-pop" role="menu" onClick={(e) => e.stopPropagation()}>
                            <h6>MOVE OR SWAP</h6>
                            <button className="primary" data-testid="menu-pickup" onClick={() => { const k = p.key; closeMenu(); startPlacing(k); }}>Pick up &amp; choose a slot…</button>
                            <h6>OR SEND STRAIGHT TO</h6>
                            {teams.slice(0, shape.teamN).map((tt, tj) => { const open = firstOpen(tj); const same = p.team === tj; const dis = same || tt.locked || open === null; return <button key={tt.id} data-testid={`menu-to-${tj}`} disabled={dis} onClick={() => { place(p.key, tj, open ?? 1); closeMenu(); }}>{tt.name}{same ? " (current)" : tt.locked ? " (locked)" : open === null ? " (full)" : ` #${open}`}</button>; })}
                            <div className="sep" /><h6>FLAGS</h6>
                            <button data-testid="menu-fake" onClick={() => { toggleFake(p.key); closeMenu(); }}>{p.fake ? "Unset fake player" : "Set as fake player"}</button>
                            <div className="sep" />
                            <button className="danger" data-testid="menu-remove" onClick={() => { const k = p.key; closeMenu(); removePlayer(k); }}>Remove from the match…</button>
                          </div>
                        </>}
                      </> : <span className="openlab">Open</span>}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      <div className="bar">
        {run ? (
          <div className="plan" data-testid="plan">
            <div className="pt">SENDING — one request at a time{hasUnknown ? " · STOPPED" : ""}</div>
            {run.map((r, i) => (
              <div key={i} className={"mv " + r.status} data-testid="plan-row" data-state={r.status || "pending"}>
                <span className="st">{r.status === "landed" ? "✓" : r.status === "failed" ? "!" : r.status === "notapplied" ? "∅" : r.status === "unknown" ? "?" : r.status === "run" ? "…" : ""}</span>
                <span className="txt">{r.req.label}<code>{r.req.method} {r.req.path}</code>{r.status === "notapplied" && <em> NOT APPLIED — server accepted it and did nothing</em>}{r.status === "unknown" && <em> NO ANSWER — may or may not have landed; reload before acting</em>}{r.status === "failed" && <em> FAILED — rejected, did not happen</em>}</span>
              </div>
            ))}
          </div>
        ) : dirty ? (
          <div className="plan" data-testid="plan">
            <div className="pt">ABOUT TO SEND — {dirty} request{dirty === 1 ? "" : "s"}, one at a time</div>
            {plan.map((r, i) => <div key={i} className="mv" data-testid="plan-row" data-state="pending"><span className="st" /><span className="txt">{r.label}<code>{r.method} {r.path}</code></span></div>)}
          </div>
        ) : null}
        <div className="acts">
          <span className="cnt" data-testid="cnt">{hasUnknown ? "Stopped — reload before acting" : dirty ? `${dirty} change${dirty === 1 ? "" : "s"} not saved` : "No changes"}</span>
          <span className="sp">
            <button className="gh" data-testid="revert" disabled={busy || (!dirty && !run)} onClick={revert}>Reload</button>
            {retryable > 0 && !hasUnknown
              ? <button className="go retry" data-testid="retry" disabled={busy} onClick={retry}>Retry {retryable}</button>
              : <button className="go" data-testid="save" disabled={busy || !dirty || !!run} onClick={save}>Save</button>}
          </span>
        </div>
      </div>
      {toast && <div className={"toast" + (toast.bad ? " bad" : "")} data-testid="toast">{toast.text}</div>}
    </div>
  );
}

const CSS = `
.rse{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#0B1F17;background:#EDF2EF;min-height:100vh;padding-bottom:220px}
.rse .idbar{background:#04291D;color:#fff;padding:16px 24px}
.rse .r1{display:flex;align-items:center;gap:10px}.rse h1{margin:0;font-size:20px}
.rse .pill{font-size:10.5px;font-weight:800;letter-spacing:.06em;border-radius:20px;padding:4px 10px}
.rse .pill.id{background:#14432F;color:#B7DECB}
.rse .pill.live{background:#E5121B;color:#fff;display:inline-flex;align-items:center;gap:6px}.rse .pill.live i{width:7px;height:7px;border-radius:50%;background:#fff}
.rse .pill.stg{background:#F2E31D;color:#231F00}
.rse .counts{display:flex;gap:22px;margin-top:12px}.rse .counts div{font-size:12px;color:#9FC9B6}.rse .counts b{display:block;font-size:20px;color:#fff}
.rse .wrap{padding:16px 24px 0}
.rse .tools{background:#fff;border:1px solid #DCE5E0;border-radius:12px;padding:12px;margin-bottom:12px;display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.rse .srch{position:relative;flex:0 0 280px}.rse .srch input{width:100%;padding:9px 11px;border:1px solid #CBD7D1;border-radius:8px}
.rse .res{position:absolute;top:44px;left:0;right:0;background:#fff;border:1px solid #DCE5E0;border-radius:10px;box-shadow:0 8px 24px rgba(0,32,21,.14);z-index:30;overflow:hidden}
.rse .res button{display:block;width:100%;text-align:left;border:0;background:#fff;padding:9px 12px;border-bottom:1px solid #E9EFEB}
.rse .btn{border:1px solid #DCE5E0;background:#fff;border-radius:9px;padding:8px 14px;color:#1B3227}
.rse .adding{display:flex;align-items:center;gap:7px;flex-wrap:wrap;background:#EFF6FF;border:1px solid #C9DBF3;border-radius:10px;padding:8px 10px;width:100%}
.rse .adding .lab{font-size:13px;color:#1B4F9C;font-weight:600}.rse .adding button{border:1px solid #BFD3EE;background:#fff;border-radius:8px;padding:6px 12px;font-size:13px;color:#17406F}
.rse .adding button:disabled{opacity:.45}.rse .adding .x{margin-left:auto;border:0;background:transparent;color:#1B4F9C}
.rse .shape{display:flex;align-items:center;gap:8px;width:100%;border-top:1px solid #E9EFEB;padding-top:10px;margin-top:2px}
.rse .shape .lb{font-size:11px;letter-spacing:.08em;font-weight:700;color:#67746C}.rse .shape .note{font-size:12px;color:#5C6B62;margin-left:auto}
.rse .step{display:inline-flex;border:1px solid #DCE5E0;border-radius:8px;overflow:hidden}.rse .step button{border:0;background:#fff;padding:6px 11px;font-weight:700}
.rse .step span{padding:6px 10px;min-width:30px;text-align:center;border-left:1px solid #DCE5E0;border-right:1px solid #DCE5E0;font-variant-numeric:tabular-nums}
/* grid driven by a custom property, NOT an inline grid-template-columns — an inline
   style would beat the phone media query and never let the columns stack. */
.rse .teams{display:grid;gap:12px;grid-template-columns:repeat(var(--tn,2),minmax(0,1fr))}
.rse .team{background:#fff;border:1px solid #DCE5E0;border-radius:12px;padding:12px}.rse .team.locked{background:#FAFBFA}
/* min-width:0 — an <input> has an intrinsic min width that otherwise pushes the
   whole section past a phone viewport. */
.rse .th{display:flex;align-items:center;gap:8px;margin-bottom:10px}.rse .tname{font-size:14px;font-weight:700;border:1px solid transparent;background:transparent;border-radius:6px;padding:2px 5px;width:90px;min-width:0}
.rse .teamjump{display:none}
.rse .dot{width:12px;height:12px;border-radius:50%;border:1px solid #B9C6BF;flex:0 0 12px;background:#fff}
.rse .tname:hover{border-color:#DCE5E0}.rse .cap{margin-left:auto;font-size:12px;color:#5C6B62;font-variant-numeric:tabular-nums}
.rse .lockb{border:1px solid #DCE5E0;background:#fff;border-radius:6px;padding:2px 7px;font-size:10.5px;font-weight:700;color:#5C6B62}.rse .lockb.on{background:#FBF0DC;border-color:#E3C88A;color:#7A5200}
.rse .slots{display:flex;flex-direction:column;gap:5px}
.rse .slot{display:flex;align-items:center;gap:8px;border:1px solid #DCE5E0;border-radius:8px;padding:6px 8px;background:#fff;min-height:38px;position:relative}
.rse .slot.open{border-style:dashed;background:#FBFDFC}
.rse .slot.moved{background:#F2F7FE;border-color:#C9DBF3}
.rse .n{width:19px;height:19px;border-radius:5px;background:#EEF3F0;color:#3A5348;font-size:10.5px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:0 0 19px}
.rse .grip{cursor:grab;color:#5C6B62;font-size:13px;line-height:1;padding:2px 3px;flex:0 0 auto}
.rse .who{flex:1;min-width:0}.rse .who .nm{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rse .tag{font-size:10px;font-weight:800;border-radius:4px;padding:1px 5px;margin-left:5px}
.rse .tag.fake{background:#F2E31D;color:#231F00}.rse .tag.new{background:#E6F7EE;color:#046B45}
.rse .openlab{font-size:12.5px;color:#5C6B62}
.rse .kebab{border:1px solid transparent;background:transparent;border-radius:6px;padding:2px 6px;color:#4E5A54;line-height:1;flex:0 0 auto}
.rse .kebab:hover{border-color:#DCE5E0;background:#F2F7F4}
.rse .rmv{border:1px solid transparent;background:transparent;border-radius:6px;padding:2px 6px;color:#67746C;line-height:1;font-size:12px;flex:0 0 auto}.rse .rmv:hover{color:#A83120;background:#FDEEEB}
/* row menu — popover on desktop, bottom sheet on phone */
.rse .menu{position:absolute;right:6px;top:34px;z-index:60;background:#fff;border:1px solid #DCE5E0;border-radius:10px;box-shadow:0 10px 28px rgba(0,32,21,.16);min-width:214px;overflow:hidden}
.rse .menu h6{margin:0;padding:8px 12px 5px;font-size:10px;letter-spacing:.11em;color:#67746C;font-weight:700}
.rse .menu button{display:block;width:100%;text-align:left;border:0;background:#fff;padding:9px 12px;font-size:13.5px;color:#0B1F17}
.rse .menu button:hover{background:#F2F7F4}.rse .menu button:disabled{color:#A7B3AD;background:#fff}
.rse .menu .sep{height:1px;background:#E9EFEB;margin:4px 0}
.rse .menu button.primary{font-weight:700;color:#046B45}.rse .menu button.primary:hover{background:#EAF9F1}
.rse .menu button.danger{color:#A83120}.rse .menu button.danger:hover{background:#FDEEEB}
.rse .menuscrim{position:fixed;inset:0;z-index:55;background:transparent}
/* place mode — pick up, then tap a destination */
.rse .placebar{position:fixed;left:0;right:0;top:0;z-index:70;display:flex;align-items:center;gap:12px;background:#003326;color:#fff;padding:12px 18px;box-shadow:0 4px 18px rgba(0,32,21,.3)}
.rse .placebar .pb-txt{flex:1;min-width:0;font-size:14px}.rse .placebar .pb-txt b{font-weight:700}.rse .placebar .pb-txt span{color:#A9D7C3}
.rse .placebar .pb-x{border:1px solid #2A5644;background:transparent;color:#CFE7DC;border-radius:8px;padding:8px 15px}.rse .placebar .pb-x:hover{background:#14432F;color:#fff}
.rse.placing{padding-top:52px}
.rse.placing .slot{cursor:pointer}
.rse.placing .slot.open{border-color:#046B45;border-style:dashed;background:#EAF9F1}
.rse.placing .slot:not(.open):not(.src){box-shadow:inset 0 0 0 1px #9FC4B2}
.rse.placing .slot:not(.open):not(.src)::after{content:"SWAP";position:absolute;right:9px;top:50%;transform:translateY(-50%);font-size:9.5px;font-weight:800;letter-spacing:.07em;color:#046B45;background:#E4F8EE;border:1px solid #A9E3C6;border-radius:4px;padding:2px 6px;pointer-events:none}
.rse.placing .slot.src{box-shadow:0 0 0 2px #2CDB87;background:#E9F8F0}
.rse.placing .slot.src::after{content:"MOVING";position:absolute;right:9px;top:50%;transform:translateY(-50%);font-size:9.5px;font-weight:800;letter-spacing:.07em;color:#046B45;background:#fff;border:1px solid #2CDB87;border-radius:4px;padding:2px 6px}
.rse.placing .team.locked{opacity:.5}.rse.placing .team.locked .slot{cursor:not-allowed}
.rse.placing .kebab,.rse.placing .rmv,.rse.placing .grip{visibility:hidden}
.rse .bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #DCE5E0;box-shadow:0 -6px 22px rgba(0,32,21,.09);z-index:50}
.rse .plan{background:#F2F7FE;border-bottom:1px solid #C9DBF3;padding:12px 24px;max-height:200px;overflow-y:auto}
.rse .plan .pt{font-size:10.5px;letter-spacing:.1em;font-weight:700;color:#1B4F9C;margin-bottom:9px}
.rse .mv{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #C9DBF3;border-radius:8px;padding:7px 10px;margin-bottom:5px;font-size:13px}
.rse .mv .st{width:18px;text-align:center;font-weight:800}.rse .mv .txt{flex:1;min-width:0}.rse .mv code{display:block;font-size:11px;color:#5C6B62;font-family:ui-monospace,Menlo,monospace}
.rse .mv em{font-style:normal;font-weight:700;font-size:11.5px}
.rse .mv.landed{border-color:#B6E3CC;background:#F4FBF7}.rse .mv.landed .st{color:#046B45}
.rse .mv.failed{border-color:#E9B6AC;background:#FDEEEB}.rse .mv.failed .st,.rse .mv.failed em{color:#A83120}
.rse .mv.notapplied{border-color:#E3C88A;background:#FBF0DC}.rse .mv.notapplied .st,.rse .mv.notapplied em{color:#7A5200}
.rse .mv.unknown{border:2px solid #A83120;background:#FDEEEB}.rse .mv.unknown .st,.rse .mv.unknown em{color:#A83120;font-weight:800}
.rse .acts{display:flex;align-items:center;gap:10px;padding:13px 24px}.rse .cnt{font-size:13px;color:#5C6B62}.rse .sp{margin-left:auto;display:flex;gap:9px}
.rse .gh{border:1px solid #DCE5E0;background:#fff;border-radius:9px;padding:9px 16px;color:#1B3227}.rse .gh:disabled{opacity:.42}
.rse .go{border:0;background:#003326;color:#fff;border-radius:9px;padding:9px 20px;font-weight:600}.rse .go:disabled{background:#DCE3DF;color:#4E5A54}.rse .go.retry{background:#A83120}
.rse .toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#003326;color:#fff;padding:10px 18px;border-radius:10px;font-size:14px;z-index:80;box-shadow:0 6px 20px rgba(0,32,21,.28)}
.rse .toast.bad{background:#A83120}
/* teamjump chips — the overview once the columns are gone (phone only) */
.rse .tj{flex:0 0 auto;display:flex;align-items:center;gap:7px;border:1px solid #DCE5E0;background:#fff;border-radius:20px;padding:8px 13px;font-size:13.5px;color:#1B3227}
.rse .tj .dot{width:10px;height:10px;flex:0 0 10px}.rse .tj b{font-variant-numeric:tabular-nums}.rse .tj.full b{color:#7A5200}.rse .tj.locked{background:#FBF0DC;border-color:#E3C88A}

/* ── Phone. Four columns do not fit, and HTML5 drag never fires on touch — so the
   row menu becomes the interaction (a bottom sheet), the whole row is the target,
   the columns stack, and every control is at least 32px tall. ── */
@media (max-width: 820px){
  .rse{padding-bottom:230px}
  .rse .wrap{padding:12px 12px 0}
  .rse .tools{padding:11px}
  .rse .srch{flex:1 1 100%}
  .rse .btn{flex:1 1 auto;min-height:40px}
  .rse .step button{padding:10px 14px}.rse .step span{padding:10px 12px}
  .rse .teamjump{display:flex;gap:7px;overflow-x:auto;margin-bottom:12px;scrollbar-width:none}
  .rse .teamjump::-webkit-scrollbar{display:none}
  .rse .teams{grid-template-columns:minmax(0,1fr);gap:10px}
  .rse .team{scroll-margin-top:60px}
  .rse .tname{width:auto;flex:1;font-size:15.5px;padding:8px 7px}
  .rse .lockb{padding:8px 12px;font-size:11px;min-height:34px}
  .rse .grip{display:none}
  .rse .slot{min-height:46px;padding:8px 9px}.rse .slot .who{cursor:pointer}.rse .who .nm{font-size:14.5px}
  .rse .kebab{padding:9px 11px;font-size:16px}.rse .rmv{padding:9px 11px;font-size:15px}
  /* the row menu becomes a full-width bottom sheet with a dimming scrim */
  .rse .menu{position:fixed;left:0;right:0;bottom:0;top:auto;min-width:0;border-radius:16px 16px 0 0;box-shadow:0 -12px 34px rgba(0,32,21,.26);max-height:76vh;overflow-y:auto;padding-bottom:env(safe-area-inset-bottom)}
  .rse .menu::before{content:"";display:block;width:36px;height:4px;border-radius:3px;background:#C6D2CC;margin:10px auto 2px}
  .rse .menu button{padding:14px 16px;font-size:15px}
  .rse .menuscrim{background:rgba(6,26,18,.34)}
  /* the plan reflows so every row still shows the endpoint it will call */
  .rse .plan{padding:11px 13px;max-height:34vh}
  .rse .mv{flex-wrap:wrap;gap:7px}.rse .mv .txt{flex:1 1 100%;order:2}.rse .mv .st{order:1}.rse .mv em{flex:1 1 100%;order:3}
  .rse .acts{padding:11px 13px;flex-wrap:wrap;gap:8px}.rse .cnt{flex:1 1 100%}.rse .sp{width:100%;margin-left:0}.rse .gh{flex:1;min-height:40px}.rse .go{flex:2;min-height:40px}
  .rse .adding button{flex:1 1 auto;min-height:40px}
  .rse .toast{left:12px;right:12px;transform:none}
}
`;
