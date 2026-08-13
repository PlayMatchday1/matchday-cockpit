"use client";

// Phase 26 — Manager Check-In. Built to docs/mockups/cin-v1_1.html (2 teams) and
// cin4-v1_2.html (4 teams). The mockups are the spec; their reasoning is kept here.
//
// The twelve load-bearing behaviours, each present because of a specific failure:
//  1. TO-DO IS THE DEFAULT and the list SHRINKS — at a match the hard problem is finding a person.
//  2. One tap, no confirm; tapping the mark a player already has CLEARS it (same thumb position).
//  3. Optimistic — the mark applies instantly, syncs behind; failures collect into a retry-all bar.
//  4. The sync state NEVER replaces the status: "On time · NOT SAVED", never bare "NOT SAVED".
//  5. Cost on the BUTTON (+1 / +2), never a player's running total — a manager who knows someone
//     is one strike from a ban starts going easy, and the record stops being true.
//  6. Search matches the FULL name even when the row shows a shortened one.
//  7. Photo where one exists, initials otherwise, SAME 40px box so no row is taller than another.
//  8. Human shortening — "Marcus O.", never "Marcu…". Guests get a GUEST chip.
//  9. Move is TWO steps: pick the team, then that team's SPOT GRID. Open spot and swap are one
//     gesture. A flat list of everyone else is 27 rows at four teams.
// 10. A team whose players are all marked collapses; re-opening sticks.
// 11. Per-team size READ FROM THE MATCH (totals ÷ team count) — never the mockups' hardcoded 9/10.
// 12. Winner in the bottom bar. Dark palette unchanged.
//
// NOTHING IS SENT TO MATCHDAY IN THIS PHASE. Marks and the winner live in Clubhouse; the header
// says so permanently, not as a toast. Moves ARE live (POST /admin/user-matches).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  LABEL, GLYPH, WEIGHT, displayName, initials, avatarColor, perTeamCapacity,
  filterPlayers, todoCount, markedCount, teamCollapsed, nextStatus, spotGrid, planMove,
  type CheckinPlayer, type MarkStatus, type ListFilter,
} from "@/lib/checkinModel";

type Team = { teamNumber: number; name: string; id: number | null };
type MatchInfo = {
  id: number; name: string; fieldTitle: string | null; startDate: string | null; cityName: string | null;
  maxPlayerCount: number | null; maxTeamSize2Team: number | null; maxTeamSize4Team: number | null; isCancelled: boolean;
};
type MoveResult = { step: number; userMatchId: number; team: number; playerNumber: number; outcome: string };

const TEAM_TINT = ["#e8f2ec", "#8fd6a8", "#f0c987", "#9fc4e8", "#d6b6e0"];

async function authFetch(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
}

export default function CheckinClient({ matchId }: { matchId: string }) {
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [players, setPlayers] = useState<CheckinPlayer[]>([]);
  const [filter, setFilter] = useState<ListFilter>("todo"); // TO-DO IS THE DEFAULT
  const [q, setQ] = useState("");
  const [reopened, setReopened] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<CheckinPlayer | null>(null);
  const [winnerOpen, setWinnerOpen] = useState(false);
  const [winner, setWinner] = useState<number | null>(null);
  const [moveNote, setMoveNote] = useState<{ text: string; results: MoveResult[] } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await authFetch(`/api/matchops/checkin/${matchId}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error || `Could not load the match (${res.status})`); return; }
      const marks = new Map<number, MarkStatus>((j.marks ?? []).map((m: { playerId: number; status: MarkStatus }) => [m.playerId, m.status]));
      setMatch(j.match); setTeams(j.teams ?? []);
      setPlayers((j.players ?? []).map((p: CheckinPlayer) => ({ ...p, status: marks.get(p.playerId) ?? null, sync: "idle" as const })));
      setWinner(j.result?.winningTeam ?? null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [matchId]);
  useEffect(() => { void load(); }, [load]);

  // Per-team capacity from the MATCH's totals ÷ team count. Never 9 or 10 from a mockup.
  const capacity = useMemo(
    () => (match ? perTeamCapacity({ teamCount: teams.length, maxTeamSize2Team: match.maxTeamSize2Team, maxTeamSize4Team: match.maxTeamSize4Team, maxPlayerCount: match.maxPlayerCount }) : null),
    [match, teams.length],
  );

  const shown = useMemo(() => filterPlayers(players, filter, q), [players, filter, q]);
  const done = markedCount(players), left = todoCount(players);
  const failed = players.filter((p) => p.sync === "failed");

  // OPTIMISTIC. The mark lands in the UI immediately and syncs behind the manager; a failure marks
  // the row failed but NEVER erases its status.
  const mark = useCallback(async (p: CheckinPlayer, tapped: MarkStatus) => {
    const next = nextStatus(p.status, tapped);
    const mine = ++seq.current;
    setPlayers((ps) => ps.map((x) => (x.playerId === p.playerId ? { ...x, status: next, sync: "pending" } : x)));
    try {
      const res = next === null
        ? await authFetch(`/api/matchops/checkin/${matchId}?playerId=${p.playerId}`, { method: "DELETE" })
        : await authFetch(`/api/matchops/checkin/${matchId}`, { method: "POST", body: JSON.stringify({ kind: "mark", playerId: p.playerId, status: next }) });
      if (seq.current !== mine && false) return;
      setPlayers((ps) => ps.map((x) => (x.playerId === p.playerId ? { ...x, sync: res.ok ? "idle" : "failed" } : x)));
    } catch {
      setPlayers((ps) => ps.map((x) => (x.playerId === p.playerId ? { ...x, sync: "failed" } : x)));
    }
  }, [matchId]);

  const retryAll = useCallback(async () => {
    for (const p of players.filter((x) => x.sync === "failed")) {
      // re-send whatever the row currently says — the status is the truth, the sync is the noise
      if (p.status) await mark({ ...p, status: null }, p.status);
      else await mark({ ...p, status: "ok" }, "ok");
    }
  }, [players, mark]);

  const doMove = useCallback(async (mover: CheckinPlayer, toTeam: number, toSpot: number, occupant: CheckinPlayer | null) => {
    const plan = planMove(mover, toTeam, toSpot, occupant);
    const res = await authFetch(`/api/matchops/checkin/${matchId}`, { method: "POST", body: JSON.stringify({ kind: "move", steps: plan.steps }) });
    const j = await res.json().catch(() => ({}));
    const results: MoveResult[] = j.results ?? [];
    // A HALF-LANDED SWAP is reported plainly, not hidden and not auto-reverted.
    const text = j.ok
      ? plan.isSwap ? "Both moves landed." : "Move landed."
      : j.halfApplied
        ? `HALF DONE — the first move landed, the second did not. Nothing was reverted (a revert is another write that can fail). Check both spots and retry the one you want.`
        : `Not applied — ${results.map((r) => `step ${r.step}: ${r.outcome}`).join(", ") || "no step landed"}.`;
    setMoveNote({ text, results });
    setMoveFor(null);
    await load();
  }, [matchId, load, players]);

  if (loading && !match) return <div className="cin-wrap"><div className="cin-load">Loading the match…</div><Styles /></div>;

  return (
    <div className="cin-wrap">
      {/* ── header ── */}
      <header className="cin-top">
        <div className="cin-t1">{match?.name || `Match ${matchId}`}</div>
        <div className="cin-t2">
          {match?.fieldTitle ?? ""}{match?.cityName ? ` · ${match.cityName}` : ""}
          {capacity ? ` · ${capacity} a side` : ""}
        </div>
        {/* PERSISTENT, not a toast. Nothing is sent to MatchDay in this phase. */}
        <div className="cin-notsent" data-testid="not-sent">Recorded in Clubhouse. Not yet sent to MatchDay.</div>
      </header>

      {err && <div className="cin-err" role="alert">{err}</div>}

      {/* progress + filters */}
      <div className="cin-tools">
        <div className="cin-prog" data-testid="progress">
          <b>{done}</b> of {players.length} marked{left ? ` · ${left} still to mark` : " · all done"}
        </div>
        <div className="cin-chips" data-testid="filters">
          {([["todo", `To-do ${left}`], ["all", `All ${players.length}`], ["ok", LABEL.ok], ["late", LABEL.late], ["no_show", LABEL.no_show]] as [ListFilter, string][]).map(([k, lab]) => (
            <button key={k} type="button" data-testid="filter-chip" data-filter={k} data-on={filter === k ? "true" : "false"}
              className={`cin-chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{lab}</button>
          ))}
        </div>
        <input className="cin-search" data-testid="checkin-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search a name" autoComplete="off" aria-label="Search a name" />
      </div>

      {failed.length > 0 && (
        <div className="cin-failbar" data-testid="retry-bar">
          {failed.length} didn&apos;t save.
          <button type="button" onClick={() => void retryAll()} data-testid="retry-all">Retry all {failed.length}</button>
        </div>
      )}

      {/* ── the list, grouped by team; a finished team collapses ── */}
      <div className="cin-rows">
        {teams.map((t) => {
          const inTeam = shown.filter((p) => p.team === t.teamNumber);
          const collapsed = teamCollapsed(players, t.teamNumber, reopened);
          const filled = players.filter((p) => p.team === t.teamNumber).length;
          if (inTeam.length === 0 && !collapsed) return null;
          return (
            <section key={t.teamNumber} data-testid="team-block" data-team={t.teamNumber} data-collapsed={collapsed ? "true" : "false"}>
              <button type="button" className="cin-thead" onClick={() => setReopened((s) => { const n = new Set(s); if (n.has(t.teamNumber)) n.delete(t.teamNumber); else n.add(t.teamNumber); return n; })}
                data-testid="team-head">
                <i className="cin-tdot" style={{ background: TEAM_TINT[t.teamNumber] ?? TEAM_TINT[0] }} />
                <span className="cin-tname">{t.name}</span>
                <span className="cin-tcount">{filled}{capacity ? `/${capacity}` : ""}{capacity && filled < capacity ? ` · ${capacity - filled} open` : ""}</span>
                <span className="cin-tchev">{collapsed ? "▸ all marked" : "▾"}</span>
              </button>
              {!collapsed && inTeam.map((p) => (
                <PlayerRow key={p.userMatchId} p={p} onMark={(s) => void mark(p, s)} onMove={() => setMoveFor(p)} />
              ))}
            </section>
          );
        })}
        {shown.length === 0 && (
          <div className="cin-empty" data-testid="empty">
            {filter === "todo" && players.length > 0 ? "Everyone is marked." : "Nobody matches that."}
          </div>
        )}
      </div>

      {/* ── bottom bar: winner ── */}
      <div className="cin-foot">
        <button type="button" className="cin-winb" data-testid="winner-open" onClick={() => setWinnerOpen(true)}>
          {winner ? `Winner: ${teams.find((t) => t.teamNumber === winner)?.name ?? `Team ${winner}`}` : "Set the winner"}
        </button>
      </div>

      {moveNote && (
        <div className="cin-movenote" data-testid="move-note" role="status" onClick={() => setMoveNote(null)}>
          {moveNote.text}
          <ul>{moveNote.results.map((r) => <li key={r.step}>step {r.step} — team {r.team} #{r.playerNumber}: <b>{r.outcome}</b></li>)}</ul>
          <span className="cin-dismiss">tap to dismiss</span>
        </div>
      )}

      {moveFor && (
        <MoveSheet p={moveFor} teams={teams} players={players} capacity={capacity}
          onClose={() => setMoveFor(null)} onPick={(team, spot, occ) => void doMove(moveFor, team, spot, occ)} />
      )}
      {winnerOpen && (
        <WinnerSheet teams={teams} current={winner} onClose={() => setWinnerOpen(false)}
          onPick={async (tn) => {
            setWinner(tn); setWinnerOpen(false);
            await authFetch(`/api/matchops/checkin/${matchId}`, { method: "POST", body: JSON.stringify({ kind: "result", winningTeam: tn }) });
          }} />
      )}
      <Styles />
    </div>
  );
}

function PlayerRow({ p, onMark, onMove }: { p: CheckinPlayer; onMark: (s: MarkStatus) => void; onMove: () => void }) {
  const { name, guest } = displayName(p.fullName);
  const isGuest = guest || p.userType === "GUEST";
  // THE STATUS TEXT IS NEVER REPLACED BY THE SYNC STATE — the one player you need to re-check must
  // not become invisible.
  const statusText = p.status ? `${LABEL[p.status]}${WEIGHT[p.status] ? ` · +${WEIGHT[p.status]}` : ""}` : "Not marked";
  const meta = p.sync === "pending" ? `${statusText} · SAVING…` : p.sync === "failed" ? `${statusText} · NOT SAVED` : statusText;
  return (
    <div className="cin-p" data-testid="player-row" data-player-id={p.playerId} data-status={p.status ?? ""} data-sync={p.sync ?? "idle"}>
      {/* The WHOLE avatar + name block is the options/move target, as in the mockup — not the 40px
          avatar alone. At a touchline the thumb lands on the person, not on a badge. */}
      <button type="button" className="cin-pwho" onClick={onMove} data-testid="move-open" aria-label={`Options for ${p.fullName}`}>
        <span className="cin-avwrap">
          {p.avatar
            ? <img className="cin-av" src={p.avatar} alt="" />
            : <span className="cin-av" style={{ background: avatarColor(p.fullName), color: "#0b1f15" }}>{initials(p.fullName)}</span>}
          {p.playerNumber != null && <span className="cin-pnum">{p.playerNumber}</span>}
        </span>
        <span className="cin-ptxt">
          <span className="cin-pname" data-testid="player-name" data-full={p.fullName}>{name}{isGuest && <em className="cin-gst">GUEST</em>}</span>
          <span className={`cin-pmeta${p.sync === "failed" ? " bad" : ""}`} data-testid="player-meta">{meta}</span>
        </span>
      </button>
      <span className="cin-marks">
        {(["ok", "late", "no_show"] as MarkStatus[]).map((k) => (
          <button key={k} type="button" data-testid="mark-btn" data-mark={k} data-on={p.status === k ? "true" : "false"}
            className={`cin-mk ${k}${p.status === k ? " on" : ""}`} onClick={() => onMark(k)}
            aria-label={`${LABEL[k]} — ${p.fullName}`}>
            <span className="cin-glyph">{GLYPH[k]}</span>
            {/* THE COST IS ON THE BUTTON, never the player's total. */}
            {WEIGHT[k] > 0 && <span className="cin-cost">+{WEIGHT[k]}</span>}
          </button>
        ))}
      </span>
    </div>
  );
}

// TWO STEPS: pick a team, then that team's spot grid. An open spot and a swap are one gesture.
function MoveSheet({ p, teams, players, capacity, onClose, onPick }: {
  p: CheckinPlayer; teams: Team[]; players: CheckinPlayer[]; capacity: number | null;
  onClose: () => void; onPick: (team: number, spot: number, occupant: CheckinPlayer | null) => void;
}) {
  const [team, setTeam] = useState<number | null>(null);
  const { name } = displayName(p.fullName);
  return (
    <>
      <div className="cin-scrim" onClick={onClose} />
      <div className="cin-sheet" data-testid="move-sheet" role="dialog" aria-label={`Move ${p.fullName}`}>
        <div className="cin-sht">Move {name}</div>
        <div className="cin-shs">Currently {teams.find((t) => t.teamNumber === p.team)?.name ?? "—"}{p.playerNumber ? ` · shirt ${p.playerNumber}` : ""}</div>
        {team == null ? (
          <div className="cin-opts" data-testid="move-step-team">
            {teams.map((t) => {
              const on = players.filter((x) => x.team === t.teamNumber).length;
              const open = capacity ? capacity - on : null;
              return (
                <button key={t.teamNumber} type="button" className="cin-opt" data-testid="move-team" data-team={t.teamNumber} onClick={() => setTeam(t.teamNumber)}>
                  <i className="cin-tdot" style={{ background: TEAM_TINT[t.teamNumber] ?? TEAM_TINT[0] }} />
                  <span className="cin-optn">{t.name}</span>
                  <span className="cin-optm">{on}{capacity ? ` of ${capacity}` : ""} filled{open != null ? (open > 0 ? ` · ${open} open` : " · swap only") : ""}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <>
            <button type="button" className="cin-backb" data-testid="move-back" onClick={() => setTeam(null)}>← teams</button>
            <div className="cin-spots" data-testid="spot-grid">
              {(capacity ? spotGrid(players, team, capacity) : []).map((s) => (
                <button key={s.n} type="button" className={`cin-spot${s.who ? "" : " open"}`} data-testid="spot" data-spot={s.n} data-occupied={s.who ? "true" : "false"}
                  onClick={() => onPick(team, s.n, s.who)}>
                  <span className="cin-spn">{s.n}</span>
                  <span className="cin-spw">{s.who ? displayName(s.who.fullName).name : "open"}</span>
                </button>
              ))}
              {!capacity && <div className="cin-empty">This match has no team size on record, so the spot grid can&apos;t be drawn.</div>}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function WinnerSheet({ teams, current, onClose, onPick }: { teams: Team[]; current: number | null; onClose: () => void; onPick: (t: number | null) => void }) {
  return (
    <>
      <div className="cin-scrim" onClick={onClose} />
      <div className="cin-sheet" data-testid="winner-sheet" role="dialog" aria-label="Set the winner">
        <div className="cin-sht">Who won?</div>
        <div className="cin-shs">Recorded in Clubhouse. Not sent to MatchDay.</div>
        <div className="cin-opts">
          {teams.map((t) => (
            <button key={t.teamNumber} type="button" className={`cin-opt${current === t.teamNumber ? " on" : ""}`} data-testid="winner-team" data-team={t.teamNumber} onClick={() => onPick(t.teamNumber)}>
              <i className="cin-tdot" style={{ background: TEAM_TINT[t.teamNumber] ?? TEAM_TINT[0] }} />
              <span className="cin-optn">{t.name}</span>
            </button>
          ))}
          <button type="button" className="cin-opt" data-testid="winner-clear" onClick={() => onPick(null)}><span className="cin-optn">No winner / draw</span></button>
        </div>
      </div>
    </>
  );
}

// The mockups' dark palette, unchanged.
function Styles() {
  return (
    <style>{`
      .cin-wrap{--bg:#0b1f15;--bg2:#0e2a1c;--card:#143223;--card2:#183b29;--line:#1f4c36;--line2:#286044;
        --ink:#ecf7f0;--ink2:#b6d3c3;--ink3:#7fa793;--acc:#3ddc84;--accd:#0d5c33;
        --ok:#27a35f;--okbg:#153a27;--okln:#2c7a4f;--late:#c98a00;--latebg:#3a2f10;--lateln:#8a6410;
        --no:#cf4436;--nobg:#3a1a17;--noln:#8d3229;--tap:56px;
        background:var(--bg);color:var(--ink);min-height:100dvh;padding:0 0 88px;
        font-family:inherit;-webkit-font-smoothing:antialiased}
      .cin-load{padding:28px 16px;color:var(--ink2);font-size:14px}
      .cin-top{padding:14px 14px 10px;background:var(--bg2);border-bottom:1px solid var(--line)}
      .cin-t1{font-size:17px;font-weight:800;letter-spacing:-.01em;overflow-wrap:anywhere}
      .cin-t2{margin-top:2px;font-size:12.5px;color:var(--ink3);overflow-wrap:anywhere}
      .cin-notsent{margin-top:8px;border:1px solid var(--lateln);background:var(--latebg);color:#f0c987;
        border-radius:9px;padding:6px 9px;font-size:11.5px;font-weight:700}
      .cin-err{margin:10px 14px;border:1px solid var(--noln);background:var(--nobg);color:#f2b3aa;border-radius:9px;padding:8px 10px;font-size:12px}
      .cin-tools{padding:10px 14px 6px;display:flex;flex-direction:column;gap:8px}
      .cin-prog{font-size:12.5px;color:var(--ink2)}
      .cin-chips{display:flex;flex-wrap:wrap;gap:6px}
      /* mockup is 42px; raised to the 44px touch floor the gate requires (a floor, not a look) */
      .cin-chip{min-height:44px;border-radius:999px;border:1px solid var(--line2);background:var(--card);
        color:var(--ink2);font-size:12.5px;font-weight:700;padding:0 12px;font-family:inherit}
      .cin-chip.on{background:var(--acc);border-color:var(--acc);color:#06301b}
      .cin-search{min-height:44px;border-radius:11px;border:1px solid var(--line2);background:var(--card);
        color:var(--ink);padding:0 12px;font-size:14px;font-family:inherit;width:100%}
      .cin-failbar{margin:8px 14px;border:1px solid var(--noln);background:var(--nobg);border-radius:10px;
        padding:8px 10px;font-size:12.5px;font-weight:700;color:#f2b3aa;display:flex;align-items:center;gap:10px}
      .cin-failbar button{margin-left:auto;min-height:36px;border-radius:9px;border:0;background:#cf4436;color:#fff;
        font-weight:800;font-size:12.5px;padding:0 12px;font-family:inherit}
      .cin-rows{padding:6px 14px}
      .cin-thead{width:100%;display:flex;align-items:center;gap:8px;padding:12px 4px 8px;background:none;border:0;
        color:var(--ink2);font-family:inherit;min-height:44px}
      .cin-tdot{width:10px;height:10px;border-radius:50%;flex:none}
      .cin-tname{font-size:13px;font-weight:800;color:var(--ink)}
      .cin-tcount{font-size:11.5px;color:var(--ink3)}
      .cin-tchev{margin-left:auto;font-size:11px;color:var(--ink3)}
      .cin-p{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);min-height:74px}
      .cin-avwrap{position:relative;width:40px;height:40px;flex:none;display:block}
      .cin-av{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;
        font-size:14px;font-weight:800;object-fit:cover}
      .cin-pnum{position:absolute;right:-4px;bottom:-4px;min-width:18px;height:18px;border-radius:9px;
        background:var(--accd);color:#d8f7e6;font-size:10px;font-weight:800;display:flex;align-items:center;
        justify-content:center;padding:0 4px;border:1px solid var(--line2)}
      .cin-pwho{min-width:0;flex:1;display:flex;align-items:center;gap:10px;background:none;border:0;
        padding:0;font-family:inherit;color:inherit;text-align:left;min-height:56px}
      .cin-ptxt{min-width:0;flex:1}
      .cin-pname{display:block;font-size:14px;font-weight:700;overflow-wrap:anywhere}
      .cin-gst{margin-left:6px;font-style:normal;font-size:9px;font-weight:900;letter-spacing:.06em;
        border:1px solid var(--line2);border-radius:4px;padding:1px 4px;color:var(--ink3)}
      .cin-pmeta{display:block;font-size:11.5px;color:var(--ink3);margin-top:1px}
      .cin-pmeta.bad{color:#f2b3aa}
      .cin-marks{display:flex;gap:6px;flex:none}
      .cin-mk{width:var(--tap);height:var(--tap);border-radius:14px;border:1px solid var(--line2);
        background:var(--card2);color:var(--ink2);font-family:inherit;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:1px}
      .cin-mk .cin-glyph{font-size:17px;line-height:1}
      .cin-mk .cin-cost{font-size:9.5px;font-weight:800;opacity:.85}
      .cin-mk.ok.on{background:var(--okbg);border-color:var(--okln);color:#8ee7b3}
      .cin-mk.late.on{background:var(--latebg);border-color:var(--lateln);color:#f0c987}
      .cin-mk.no_show.on{background:var(--nobg);border-color:var(--noln);color:#f2b3aa}
      .cin-empty{padding:26px 6px;text-align:center;color:var(--ink3);font-size:13px}
      .cin-foot{position:fixed;left:0;right:0;bottom:0;padding:10px 14px calc(10px + env(safe-area-inset-bottom));
        background:var(--bg2);border-top:1px solid var(--line)}
      .cin-winb{width:100%;min-height:48px;border-radius:12px;border:0;background:var(--acc);color:#06301b;
        font-weight:900;font-size:14px;font-family:inherit}
      .cin-scrim{position:fixed;inset:0;background:rgba(3,14,9,.6);z-index:40}
      .cin-sheet{position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--card);border-top:1px solid var(--line2);
        border-radius:18px 18px 0 0;padding:14px 14px calc(16px + env(safe-area-inset-bottom));max-height:82dvh;overflow:auto}
      .cin-sht{font-size:16px;font-weight:800}
      .cin-shs{font-size:12px;color:var(--ink3);margin-top:2px;margin-bottom:10px}
      .cin-opts{display:flex;flex-direction:column;gap:8px}
      .cin-opt{display:flex;align-items:center;gap:9px;min-height:52px;border-radius:12px;border:1px solid var(--line2);
        background:var(--card2);color:var(--ink);padding:0 12px;font-family:inherit;text-align:left}
      .cin-opt.on{border-color:var(--acc)}
      .cin-optn{font-size:14px;font-weight:700}
      .cin-optm{margin-left:auto;font-size:11.5px;color:var(--ink3)}
      .cin-backb{min-height:40px;background:none;border:0;color:var(--acc);font-weight:800;font-size:12.5px;
        font-family:inherit;padding:0 0 8px}
      .cin-spots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
      .cin-spot{border:1px solid var(--line2);background:var(--card2);border-radius:14px;color:var(--ink);
        padding:9px 6px 8px;min-height:64px;display:flex;flex-direction:column;align-items:center;gap:3px;font-family:inherit}
      .cin-spot.open{border-style:dashed;border-color:var(--accd);background:var(--okbg)}
      .cin-spn{font-size:15px;font-weight:900}
      .cin-spw{font-size:10.5px;color:var(--ink3);overflow-wrap:anywhere;text-align:center}
      .cin-spot.open .cin-spw{color:var(--acc)}
      .cin-movenote{position:fixed;left:14px;right:14px;bottom:76px;z-index:60;background:var(--card2);
        border:1px solid var(--line2);border-radius:12px;padding:10px 12px;font-size:12.5px;color:var(--ink)}
      .cin-movenote ul{margin:6px 0 0;padding-left:16px;color:var(--ink2);font-size:11.5px}
      .cin-dismiss{display:block;margin-top:6px;font-size:10.5px;color:var(--ink3)}
      /* Never broken at desktop: the column centres rather than stretching a phone layout across 1600px. */
      @media(min-width:900px){
        .cin-wrap{max-width:560px;margin:0 auto;border-left:1px solid var(--line);border-right:1px solid var(--line)}
        .cin-foot{left:50%;transform:translateX(-50%);max-width:560px;width:100%}
        .cin-scrim{background:rgba(3,14,9,.5)}
        .cin-sheet{left:50%;transform:translateX(-50%);max-width:560px;width:100%;border-radius:18px 18px 0 0}
        .cin-movenote{left:50%;transform:translateX(-50%);max-width:532px;width:100%}
      }
    `}</style>
  );
}
