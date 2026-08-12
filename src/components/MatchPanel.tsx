"use client";

// Phase 23 Step 1 — the one-panel match editor, STAGED FIELDS ONLY. Seven sections (MATCH · WHEN ·
// MONEY · SPOTS · SPOTS SHOWN · AUTOMATION · DESCRIPTION) + Save. Roster, team names, team count and
// Cancel are Step 2/3 and are deliberately absent here.
//
// TWO COMMIT MODELS, structural from day one: match fields are STAGED until Save and go out as the
// diff (only what changed — clearing a box is not a change). Immediate roster/team actions (Step 2)
// will live in their own place that Save/Revert never touch — the empty <div class="mp-immediate">
// marker below is where they land, so the distinction is built in, not retrofitted.
//
// It EXTENDS the existing write path /api/matchday/{env}/matches/{id} (env-explicit,
// canEditMatches-gated, diff-as-body, recordWrite-wrapped). Always production; no env badge/toggle.
//
// The diff panel and the request body are BOTH built from matchEditModel's diffKeys()+pick() — the
// one shared engine, so they can never disagree about what is sent (that is the whole point of the
// model; never re-implement it).

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { diffKeys, pick, MONEY_KEYS, TOGGLE_KEYS, NULLABLE_NUM } from "@/lib/matchEditModel";
import { centsToDollars, dollarsToCents } from "@/lib/matchMoney";

// Only these two `type` values are exposed. The known enum also has BRACKET and GROUP and the full
// set is UNKNOWN (no spec in repo). A match whose current type is NOT one of these renders as
// READ-ONLY TEXT — never a two-option dropdown that would silently rewrite a BRACKET on first touch.
const EXPOSED_TYPES: Record<string, string> = { REGULAR: "Regular", EVENT: "Special event" };
const MARKS = [36, 24, 12, 6, 3] as const;
const SIZES = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

// The API keys this panel stages. (category is EDITABLE but out of scope this step, so it is never
// surfaced and never enters the diff.) startDate/endDate are derived from the WHEN date+time and go
// as a duration-preserving PAIR.
const STAGED_KEYS = [
  "name", "type", "managerId", "secondManagerId", "fieldId",
  "registrationPrice", "additionalSpotPrice", "guestCount", "isFreeMember",
  "maxPlayerCount",
  "fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h",
  "autoCanceled", "autoCanceledMinutes", "minPlayerCount", "isAutoBump", "maxTeamSize2Team", "maxTeamSize4Team",
  "description", "managerIntro",
  "startDate", "endDate",
] as const;

const LABELS: Record<string, string> = {
  name: "Match name", type: "Type", managerId: "Manager", secondManagerId: "Second manager", fieldId: "Field",
  registrationPrice: "Price", additionalSpotPrice: "Spot price", guestCount: "Guest count", isFreeMember: "Free to member",
  maxPlayerCount: "Max players", fakeSpotLeft36h: "Shown-left 36 H", fakeSpotLeft24h: "Shown-left 24 H",
  fakeSpotLeft12h: "Shown-left 12 H", fakeSpotLeft6h: "Shown-left 6 H", fakeSpotLeft3h: "Shown-left 3 H",
  autoCanceled: "Auto-cancel", autoCanceledMinutes: "Auto-cancel minutes", minPlayerCount: "Min players",
  isAutoBump: "Auto bump", maxTeamSize2Team: "Max spots, 2 teams", maxTeamSize4Team: "Max spots, 4 teams",
  description: "Description", managerIntro: "Manager intro", startDate: "Start", endDate: "End",
};

type Manager = { id: number; name: string };
type FieldRow = { id: number; title: string; city: string | null };
type TeamRow = { id: number; teamNumber: number; name: string; locked: boolean };
type PlayerRow = { umId: number; playerId: number; team: number; playerNumber: number; name: string; fake: boolean };
type RosterState = { name: string; teams: TeamRow[]; players: PlayerRow[]; shape: { teamN: number; perTeam: number }; maxPlayerCount: number | null; occupancy: number | null };
type MatchData = Record<string, unknown> & {
  type?: string; startDate?: string; endDate?: string; teams?: unknown[];
  occupancy?: number | null; realOccupancy?: number | null; cityName?: string | null; fieldTitle?: string | null;
  manager?: { firstName?: string; lastName?: string } | null;
};

// ── wall-clock date helpers. The Z is a LABEL, not UTC — read the components with getUTC* (which
// pull the labelled wall time back), do arithmetic in wall minutes, rebuild the string verbatim.
// NEVER new Date(str) and read local getters — that re-reads the Z as UTC and lands hours off.
const p2 = (n: number) => String(n).padStart(2, "0");
function parseWall(z: string): { date: string; time: string } {
  const d = new Date(z);
  return { date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}
function buildWall(date: string, time: string): string { return `${date}T${time}:00.000Z`; }
function wallMin(z: string): number { const d = new Date(z); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()) / 60000; }
function fromWallMin(min: number): string { const d = new Date(min * 60000); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00.000Z`; }
function clock12(time: string): string { const [h, m] = time.split(":").map(Number); const hr = h % 12 === 0 ? 12 : h % 12; return `${hr}:${p2(m)} ${h < 12 ? "AM" : "PM"}`; }
function prettyDate(date: string): string { const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; const [y, mo, d] = date.split("-").map(Number); return `${MON[mo - 1]} ${d}, ${y}`; }

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : null;
}

export default function MatchPanel({ matchId, env = "production", onDirtyChange }: { matchId: string; env?: "production" | "staging"; onDirtyChange?: (dirty: boolean) => void }) {
  const [orig, setOrig] = useState<MatchData | null>(null);
  const [cur, setCur] = useState<Record<string, unknown>>({});
  const [when, setWhen] = useState<{ date: string; time: string }>({ date: "", time: "" });
  const [managers, setManagers] = useState<Manager[]>([]);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  // ── Step 2 · TEAMS — the IMMEDIATE half. None of this stages; each action fires on its own
  // endpoint the moment it happens and Revert never touches it. State is entirely separate from the
  // staged `cur`/STAGED_KEYS above, so a team rename or a roster move can NEVER enter the diff.
  const [roster, setRoster] = useState<RosterState | null>(null);
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState<Record<number, string>>({}); // teamId → typed name (kept on failure)
  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [opToast, setOpToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [immediateOps, setImmediateOps] = useState<string[]>([]); // what fired this session — drives Revert's warning
  const [countResult, setCountResult] = useState<string | null>(null); // LANDED / NOT APPLIED for team count
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: number; name: string }[]>([]);
  const [pendingAdd, setPendingAdd] = useState<{ id: number | null; name: string; fake?: boolean } | null>(null);
  const [bulkFakes, setBulkFakes] = useState("");
  // ── CANCEL (Part C) — the rarest, heaviest, irreversible action. Reaches everyone at once and
  // cannot be undone, so the friction is deliberately the opposite of the chat composer: live numbers
  // read at confirm time + the match NAME typed, not a yes/no.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPreview, setCancelPreview] = useState<{ name: string; count: number; perPlayerCents: number; totalCents: number; alreadyCancelled: boolean } | null>(null);
  const [cancelTyped, setCancelTyped] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelResult, setCancelResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    const headers = await authHeaders();
    if (!headers) { setLoadErr("No active session — sign in again."); return; }
    try {
      const res = await fetch(`/api/matchday/${env}/matches/${matchId}`, { headers, cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const m = j.match as MatchData;
      setOrig(m);
      setManagers(j.managers ?? []);
      setFields(j.fields ?? []);
      const w = m.startDate ? parseWall(m.startDate) : { date: "", time: "" };
      setWhen(w);
      // seed the editable copy with the staged keys (+ startDate/endDate verbatim)
      const next: Record<string, unknown> = {};
      for (const k of STAGED_KEYS) next[k] = m[k] ?? null;
      setCur(next);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [env, matchId]);
  useEffect(() => { void load(); }, [load]);

  // ── TEAMS (immediate) — load the roster + teams from the SAME guarded roster route the standalone
  // editor used (Part A absorbs it). Returns the fresh payload so the write-only team-count re-read
  // can compare teams[].length directly rather than racing setState.
  const rosterPath = `/api/matchday/${env}/roster/${matchId}`;
  const loadRoster = useCallback(async (): Promise<RosterState | null> => {
    const headers = await authHeaders();
    if (!headers) { setRosterErr("No active session — sign in again."); return null; }
    try {
      const res = await fetch(rosterPath, { headers, cache: "no-store" });
      const j = await res.json();
      if (!res.ok) { setRosterErr(j.error || `HTTP ${res.status}`); return null; }
      setRoster(j as RosterState);
      setTeamDraft(Object.fromEntries((j.teams as TeamRow[]).map((t) => [t.id, t.name])));
      setRosterErr(null);
      return j as RosterState;
    } catch (e) { setRosterErr(e instanceof Error ? e.message : String(e)); return null; }
  }, [rosterPath]);
  useEffect(() => { void loadRoster(); }, [loadRoster]);

  // add-a-player search (id or email), debounced — id + name only, no PII beyond the dropdown name.
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      const headers = await authHeaders(); if (!headers) return;
      const res = await fetch(`${rosterPath}?q=${encodeURIComponent(q.trim())}`, { headers, cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (live) setResults((j.results ?? []).slice(0, 8));
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, rosterPath]);

  const noteImmediate = (msg: string) => setImmediateOps((a) => [...a, msg]);

  // One immediate write. Fires NOW; there is no staging and no batch. Returns {ok, j} or null (network).
  const rosterPost = async (op: Record<string, unknown>, label: string): Promise<{ ok: boolean; j: Record<string, unknown> } | null> => {
    const headers = await authHeaders();
    if (!headers) { setOpToast({ text: "No active session — sign in again.", bad: true }); return null; }
    setOpBusy(label); setOpToast(null);
    try {
      const res = await fetch(rosterPath, { method: "POST", headers, body: JSON.stringify({ ...op, source: "Match panel · teams", matchName: roster?.name }) });
      const j = await res.json().catch(() => ({}));
      setOpBusy(null);
      if (!res.ok) { setOpToast({ text: `${label} failed: ${j.error || res.status}. Nothing else changed.`, bad: true }); return { ok: false, j }; }
      return { ok: true, j };
    } catch (e) { setOpBusy(null); setOpToast({ text: `${label} — ${e instanceof Error ? e.message : String(e)}. UNKNOWN; reload before acting.`, bad: true }); return null; }
  };

  // Classify an immediate op by the route's read-back OUTCOME ("landed"/"notapplied"), never by HTTP
  // alone — the roster route re-reads after each write. This restores the standalone editor's rule:
  // a change is LANDED only after a read-back confirms it; a 2xx that didn't take reads as NOT APPLIED.
  const afterOp = async (r: { ok: boolean; j: Record<string, unknown> } | null, landedMsg: string, note: string): Promise<boolean> => {
    if (!r) return false;    // network failure — rosterPost already toasted UNKNOWN
    if (!r.ok) return false; // rejected — rosterPost toasted; do NOT reload (nothing changed; keeps the typed input)
    await loadRoster();      // accepted — re-read to reflect the server and reseed
    if (r.j.outcome === "landed") { noteImmediate(note); setOpToast({ text: landedMsg }); return true; }
    setOpToast({ text: `NOT APPLIED — the server accepted it (2xx) but a re-read shows it did not take. Nothing changed; reload and check.`, bad: true });
    return false;
  };

  const firstOpenSlot = (teamNumber: number): number => {
    if (!roster) return 1;
    const used = new Set(roster.players.filter((p) => p.team === teamNumber).map((p) => p.playerNumber));
    const per = roster.shape?.perTeam || 0;
    for (let n = 1; n <= per; n++) if (!used.has(n)) return n;
    return (roster.players.filter((p) => p.team === teamNumber).reduce((m, p) => Math.max(m, p.playerNumber), 0)) + 1;
  };

  // RENAME — teams endpoint only, {name} only (password is deny-listed and never sent). Confirm THEN
  // update: the committed name changes only after the response re-read confirms it, never optimistically.
  const renameTeam = async (teamId: number, teamNumber: number) => {
    if (!roster || opBusy) return;
    const name = (teamDraft[teamId] ?? "").trim();
    const team = roster.teams.find((t) => t.id === teamId);
    if (!team || !name || name === team.name) return;
    const r = await rosterPost({ kind: "teams", teamId, fields: { name } }, `Rename team ${teamNumber}`);
    // afterOp reloads (committed name follows the server) and reports LANDED / NOT APPLIED from the
    // read-back. On failure or NOT APPLIED the committed name is unchanged and teamDraft keeps the text.
    await afterOp(r, `Team ${teamNumber} is now “${name}” — saved (re-read confirmed).`, `renamed team ${teamNumber} → “${name}”`);
  };

  const addPlayer = async (teamNumber: number) => {
    if (!roster || !pendingAdd || opBusy) return;
    const isFake = pendingAdd.fake === true;
    const nm = isFake ? "fake player" : pendingAdd.name;
    const n = firstOpenSlot(teamNumber);
    // fakes are their own endpoint (add-fake), never the real-player add — they carry no playerId.
    const op = isFake
      ? { kind: "add-fake", team: teamNumber, playerNumber: n }
      : { kind: "add", playerId: pendingAdd.id, team: teamNumber, playerNumber: n };
    const r = await rosterPost(op, isFake ? "Add fake player" : `Add ${nm}`);
    if (await afterOp(r, `${nm} added to team ${teamNumber} — saved (re-read confirmed).`, `added ${nm} to team ${teamNumber}`)) { setPendingAdd(null); setQ(""); setResults([]); }
  };
  // bulk fakes — one call sets the match's fake count (kind:"bulk-fake" → /batch/fake-players {totalFakes}).
  const addFakesBulk = async () => {
    if (!roster || opBusy) return;
    const n = Number(bulkFakes);
    if (!Number.isFinite(n) || n <= 0) return;
    const r = await rosterPost({ kind: "bulk-fake", totalFakes: n }, `Add ${n} fake players`);
    if (await afterOp(r, `${n} fake player${n === 1 ? "" : "s"} added — saved (re-read confirmed).`, `added ${n} fake players`)) setBulkFakes("");
  };
  const movePlayer = async (p: PlayerRow, toTeam: number) => {
    if (!roster || opBusy) return;
    const n = firstOpenSlot(toTeam);
    const r = await rosterPost({ kind: "move", userMatchId: p.umId, team: toTeam, playerNumber: n }, `Move ${p.name}`);
    await afterOp(r, `${p.name} moved to team ${toTeam} — saved (re-read confirmed).`, `moved ${p.name} to team ${toTeam}`);
  };
  const removePlayer = async (p: PlayerRow) => {
    if (!roster || opBusy) return;
    const okd = typeof window !== "undefined" && window.confirm(
      `Remove ${p.name} from this match now?\n\nThis fires IMMEDIATELY and Revert will NOT undo it. It takes them off the roster — it is NOT a refund, and the effect on any charge they paid is UNCONFIRMED. If ${p.name} paid, check before you do this.`);
    if (!okd) return;
    const r = await rosterPost({ kind: "remove", userMatchId: p.umId }, `Remove ${p.name}`);
    await afterOp(r, `${p.name} removed — saved (re-read confirmed).`, `removed ${p.name}`);
  };

  // TEAM COUNT 2 ⇄ 4. teamNumbers is WRITE-ONLY: a 2xx is NOT proof. Send it, then RE-READ and
  // report from teams[].length — never from the response status. 4→2 is the dangerous direction and
  // gets a confirm naming how many players sit on the teams about to disappear.
  const changeTeamCount = async (target: number) => {
    if (!roster || opBusy) return;
    const curN = roster.teams.length;
    if (target === curN) return;
    if (target < curN) {
      const affected = roster.players.filter((p) => p.team > target);
      const span = target + 1 === curN ? `team ${curN}` : `teams ${target + 1}–${curN}`;
      const okd = typeof window !== "undefined" && window.confirm(
        `Change to ${target} teams?\n\n${affected.length} player(s) currently on ${span} will be reassigned BY THE SERVER — Clubhouse cannot say where they land. This fires immediately and Revert will not undo it.` +
        (affected.length ? `\n\nAffected: ${affected.slice(0, 8).map((p) => p.name).join(", ")}${affected.length > 8 ? ` +${affected.length - 8}` : ""}.` : ""));
      if (!okd) { setCountResult(null); return; }
    }
    setCountResult(`Sending teamNumbers = ${target}…`);
    const r = await rosterPost({ kind: "shape", fields: { teamNumbers: target } }, `Set ${target} teams`);
    if (!r) { setCountResult("UNKNOWN — no answer from the server. Reload before acting."); return; }
    const fresh = await loadRoster(); // the RE-READ; teamNumbers is absent from GET so we compare team ROWS
    const landedN = fresh ? fresh.teams.length : null;
    if (landedN === target) { noteImmediate(`set team count to ${target}`); setCountResult(`LANDED — the panel re-read the match and now sees ${landedN} teams.`); }
    else setCountResult(`NOT APPLIED — the re-read shows ${landedN ?? "?"} team(s), not ${target}. teamNumbers is write-only so a 2xx proves nothing; the server did not change the count.`);
  };

  const cancelPath = `/api/matchday/${env}/matches/${matchId}/cancel`;
  const openCancel = async () => {
    if (cancelBusy) return;
    const headers = await authHeaders(); if (!headers) { setCancelResult("No active session — sign in again."); return; }
    setCancelBusy(true); setCancelResult(null);
    try {
      const res = await fetch(cancelPath, { headers, cache: "no-store" }); // LIVE preview, read at confirm time
      const j = await res.json();
      setCancelBusy(false);
      if (!res.ok) { setCancelResult(`Couldn't read the cancellation preview: ${j.error || res.status}`); return; }
      setCancelPreview(j); setCancelTyped(""); setCancelOpen(true);
    } catch (e) { setCancelBusy(false); setCancelResult(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}.`); }
  };
  const doCancel = async () => {
    if (!cancelPreview || cancelBusy || cancelTyped.trim() !== cancelPreview.name) return;
    const headers = await authHeaders(); if (!headers) { setCancelResult("No active session — sign in again."); return; }
    setCancelBusy(true); setCancelResult(null);
    try {
      const res = await fetch(cancelPath, { method: "POST", headers, body: JSON.stringify({ confirmName: cancelTyped.trim(), source: "Match panel · cancel" }) });
      const j = await res.json();
      setCancelBusy(false);
      if (!res.ok) { setCancelResult(`Cancel failed: ${j.error || res.status}. Nothing was credited.`); return; }
      setCancelOpen(false); noteImmediate("cancelled the match");
      // Report from match state (server re-read of isCancelled), NOT the status code.
      setCancelResult(j.landed
        ? `LANDED — “${j.name}” is cancelled. ${j.count} player(s) credited $${centsToDollars(j.totalCents)} and texted (re-read confirmed).`
        : `NOT APPLIED — the re-read shows the match is NOT cancelled; nothing was credited. Reload and check before retrying.`);
      await load(); await loadRoster();
    } catch (e) { setCancelBusy(false); setCancelResult(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Reload before acting.`); }
  };

  // Recompute the derived date pair whenever the WHEN inputs move: apply the start delta to the
  // loaded end so DURATION is preserved, and send BOTH (the route rejects a lone date field).
  const applyWhen = (date: string, time: string) => {
    setWhen({ date, time });
    setCur((c) => {
      if (!orig?.startDate || !orig?.endDate) return { ...c, startDate: buildWall(date, time) };
      const newStart = buildWall(date, time);
      const delta = wallMin(newStart) - wallMin(orig.startDate);
      const newEnd = fromWallMin(wallMin(orig.endDate) + delta);
      return { ...c, startDate: newStart, endDate: newEnd };
    });
  };

  const setField = (k: string, v: unknown) => setCur((c) => ({ ...c, [k]: v }));

  const changed = useMemo(() => (orig ? diffKeys(STAGED_KEYS, orig, cur) : []), [orig, cur]);
  // Report STAGED dirtiness to a host (the Gameday panel guards close/step on it). Immediate TEAMS
  // ops are already saved, so they never count as dirty.
  useEffect(() => { onDirtyChange?.(changed.length > 0); }, [changed.length, onDirtyChange]);
  const isDirty = (k: string) => changed.includes(k);
  const secDirty = (keys: string[]) => keys.some((k) => changed.includes(k));

  const typeExposed = orig ? Object.prototype.hasOwnProperty.call(EXPOSED_TYPES, String(orig.type)) : true;

  // ── the fakeSpotLeft ceiling math. capacity = maxPlayerCount (the server's cap field — see the
  // report; NOT spotsPerTeam×teamCount, which is a UI derivation). realPlayers = realOccupancy,
  // computed by the route from the ROSTER as _count.players − fake rows (the detail _count has no
  // fakePlayers — proven on prod). At each mark the ceiling caps shown-left, so fakes are added to
  // reach it: max(0, capacity − real − ceiling).
  const capacity = Number(cur.maxPlayerCount) || 0;
  const realPlayers = Math.max(0, Number(orig?.realOccupancy ?? 0));
  const fakesNeeded = (ceiling: number) => Math.max(0, capacity - realPlayers - ceiling);
  const ladderBreak = useMemo(() => {
    for (let i = 1; i < MARKS.length; i++) {
      const prev = Number(cur[`fakeSpotLeft${MARKS[i - 1]}h`]) || 0;
      const here = Number(cur[`fakeSpotLeft${MARKS[i]}h`]) || 0;
      if (here > prev) return { prevMark: MARKS[i - 1], prevN: prev, mark: MARKS[i], n: here };
    }
    return null;
  }, [cur]);

  const teamCount = Array.isArray(orig?.teams) ? orig!.teams!.length : 0;

  const doSave = async () => {
    if (!orig || saving || changed.length === 0) return;
    setSaving(true); setToast(null);
    const changes = pick(cur, changed);
    // Money fields staged as cents already; nothing to convert here.
    const headers = await authHeaders();
    if (!headers) { setToast("No active session — sign in again."); setSaving(false); return; }
    try {
      const res = await fetch(`/api/matchday/${env}/matches/${matchId}`, {
        method: "PUT", headers, body: JSON.stringify({ changes, source: "Match panel" }),
      });
      const j = await res.json();
      if (!res.ok) { setToast(`Save failed: ${j.error || res.status}`); setSaving(false); return; }
      // A 2xx is not proof it landed — re-read and classify per field.
      const sentKeys = Object.keys(changes);
      await load();
      const after = j.match as MatchData | undefined;
      let landed = 0, notApplied: string[] = [];
      if (after) for (const k of sentKeys) {
        if (JSON.stringify(after[k] ?? null) === JSON.stringify((changes as Record<string, unknown>)[k] ?? null)) landed++;
        else notApplied.push(k);
      }
      setToast(
        `Outcome ${j.outcome ?? "?"} — ${landed}/${sentKeys.length} field(s) LANDED (re-read confirmed).` +
        (notApplied.length ? ` NOT APPLIED: ${notApplied.map((k) => LABELS[k] ?? k).join(", ")}.` : ""),
      );
    } catch (e) {
      setToast(`UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Reload before acting.`);
    } finally {
      setSaving(false);
    }
  };

  const doRevert = () => {
    if (!orig) return;
    // If any TEAMS action fired this session, Revert must NAME what it will NOT undo — the whole risk
    // of Step 2 is someone removing a player, hitting Revert, and believing they took it back.
    if (immediateOps.length > 0 && typeof window !== "undefined") {
      const okd = window.confirm(
        `Revert clears the ${changed.length} unsaved match-field change${changed.length === 1 ? "" : "s"} above.\n\n` +
        `It does NOT undo the ${immediateOps.length} team/roster change${immediateOps.length === 1 ? "" : "s"} you already saved this session — those fired immediately on their own endpoints and cannot be taken back here:\n` +
        `• ${immediateOps.slice(-6).join("\n• ")}\n\nContinue?`);
      if (!okd) return;
    }
    const next: Record<string, unknown> = {};
    for (const k of STAGED_KEYS) next[k] = orig[k] ?? null;
    setCur(next);
    setWhen(orig.startDate ? parseWall(orig.startDate) : { date: "", time: "" });
    setDiffOpen(false);
    setToast(null);
  };

  if (loadErr) return <div className="mp"><style>{CSS}</style><div className="mp-panel" data-testid="mp-panel"><div className="mp-err" data-testid="mp-load-error">{loadErr}</div></div></div>;
  if (!orig) return <div className="mp"><style>{CSS}</style><div className="mp-panel" data-testid="mp-panel"><div className="mp-loading">Loading match…</div></div></div>;

  const mgrName = (id: unknown) => managers.find((m) => m.id === Number(id))?.name ?? (id == null || id === "" ? "—" : `id ${id}`);
  const dollarInput = (k: string) => (cur[k] === "" || cur[k] == null ? "" : centsToDollars(cur[k]));

  return (
    <div className="mp">
      <style>{CSS}</style>
      <div className="mp-panel" data-testid="mp-panel">
        <div className="mp-head">
          <div className="mp-name" data-testid="mp-title">{String(cur.name ?? orig.name ?? "")}</div>
          <div className="mp-meta">
            <span className="mp-tag">ID {String(orig.id)}</span>
            <span>{orig.cityName ?? ""}</span>
            {when.date && <span>· {prettyDate(when.date)} {clock12(when.time)}</span>}
          </div>
        </div>

        <div className="mp-body">
          {/* MATCH */}
          <Section title="MATCH" dirty={secDirty(["name", "type", "managerId", "secondManagerId", "fieldId"])}>
            <label className="mp-f"><span className="mp-lb">MATCH NAME</span>
              <input data-testid="mp-name" value={String(cur.name ?? "")} className={isDirty("name") ? "mp-chg" : ""} onChange={(e) => setField("name", e.target.value)} /></label>
            <div className="mp-grid">
              <label className="mp-f"><span className="mp-lb">FIELD</span>
                <select data-testid="mp-field" value={Number(cur.fieldId ?? 0)} className={isDirty("fieldId") ? "mp-chg" : ""} onChange={(e) => setField("fieldId", Number(e.target.value))}>
                  {fields.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
                </select></label>
              <label className="mp-f"><span className="mp-lb">TYPE</span>
                {typeExposed ? (
                  <select data-testid="mp-type" value={String(cur.type)} className={isDirty("type") ? "mp-chg" : ""} onChange={(e) => setField("type", e.target.value)}>
                    {Object.entries(EXPOSED_TYPES).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                ) : (
                  <span className="mp-ro" data-testid="mp-type-readonly">{String(orig.type)} — read-only (not Regular or Special event)</span>
                )}</label>
            </div>
            <div className="mp-grid">
              <label className="mp-f"><span className="mp-lb">MANAGER <em>send the id, choose the name</em></span>
                <select data-testid="mp-mgr" value={Number(cur.managerId ?? 0)} className={isDirty("managerId") ? "mp-chg" : ""} onChange={(e) => setField("managerId", e.target.value === "" ? null : Number(e.target.value))}>
                  {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>
              <label className="mp-f"><span className="mp-lb">SECOND MANAGER <em>optional</em></span>
                <select data-testid="mp-mgr2" value={cur.secondManagerId == null ? "" : Number(cur.secondManagerId)} className={isDirty("secondManagerId") ? "mp-chg" : ""} onChange={(e) => setField("secondManagerId", e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">— none —</option>
                  {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>
            </div>
          </Section>

          {/* WHEN */}
          <Section title="WHEN" dirty={secDirty(["startDate", "endDate"])}>
            <span className="mp-note info">Entered as LOCAL wall-clock in <b>{orig.cityName ?? "the field's city"}</b>. The server derives UTC from the field's timezone — Clubhouse never converts. Date + start move together preserving the match duration.</span>
            <div className="mp-grid">
              <label className="mp-f"><span className="mp-lb">DATE</span>
                <input type="date" data-testid="mp-date" value={when.date} className={isDirty("startDate") ? "mp-chg" : ""} onChange={(e) => applyWhen(e.target.value, when.time)} /></label>
              <label className="mp-f"><span className="mp-lb">START TIME</span>
                <input type="time" data-testid="mp-start" value={when.time} className={isDirty("startDate") ? "mp-chg" : ""} onChange={(e) => applyWhen(when.date, e.target.value)} /></label>
            </div>
            <div className="mp-derived" data-testid="mp-when-derived">Sends <b>startDate</b> {String(cur.startDate)} and <b>endDate</b> {String(cur.endDate)} together.</div>
          </Section>

          {/* MONEY */}
          <Section title="MONEY" dirty={secDirty(["registrationPrice", "additionalSpotPrice", "guestCount", "isFreeMember"])}>
            <div className="mp-grid3">
              <label className="mp-f"><span className="mp-lb">PRICE <em>$</em></span>
                <input data-testid="mp-price" inputMode="decimal" value={dollarInput("registrationPrice")} className={isDirty("registrationPrice") ? "mp-chg" : ""}
                  onChange={(e) => setField("registrationPrice", e.target.value.trim() === "" ? "" : dollarsToCents(e.target.value))} /></label>
              <label className="mp-f"><span className="mp-lb">SPOT PRICE <em>$</em></span>
                <input data-testid="mp-spot" inputMode="decimal" placeholder="—" value={dollarInput("additionalSpotPrice")} className={isDirty("additionalSpotPrice") ? "mp-chg" : ""}
                  onChange={(e) => setField("additionalSpotPrice", e.target.value.trim() === "" ? "" : dollarsToCents(e.target.value))} /></label>
              <label className="mp-f"><span className="mp-lb">GUEST COUNT</span>
                <input data-testid="mp-guests" inputMode="numeric" value={cur.guestCount == null ? "" : String(cur.guestCount)} className={isDirty("guestCount") ? "mp-chg" : ""}
                  onChange={(e) => setField("guestCount", e.target.value.trim() === "" ? "" : Number(e.target.value))} /></label>
            </div>
            <span className="mp-help">Stored in CENTS. Clearing a box is <b>not</b> a change — type 0 to set a price to zero.</span>
            <Toggle id="mp-free" on={!!cur.isFreeMember} dirty={isDirty("isFreeMember")} onToggle={(v) => setField("isFreeMember", v)}
              title="Free to member" sub="Members join at no charge" />
          </Section>

          {/* SPOTS */}
          <Section title="SPOTS" dirty={secDirty(["maxPlayerCount"])}>
            <div className="mp-grid">
              <label className="mp-f"><span className="mp-lb">MAX PLAYERS <em>total capacity</em></span>
                <input data-testid="mp-maxplayers" inputMode="numeric" value={cur.maxPlayerCount == null ? "" : String(cur.maxPlayerCount)} className={isDirty("maxPlayerCount") ? "mp-chg" : ""}
                  onChange={(e) => setField("maxPlayerCount", e.target.value.trim() === "" ? "" : Number(e.target.value))} /></label>
              <div className="mp-f"><span className="mp-lb">SPOTS PER TEAM <em>{teamCount} teams</em></span>
                {teamCount > 0 && capacity % teamCount === 0 ? (
                  // whole number per team — the stepper writes maxPlayerCount = perTeam × teamCount
                  <div className="mp-step">
                    <button type="button" data-testid="mp-spt-minus" aria-label="Fewer per team" disabled={capacity <= teamCount}
                      onClick={() => setField("maxPlayerCount", Math.max(teamCount, capacity - teamCount))}>−</button>
                    <span className="mp-step-val" data-testid="mp-spt">{capacity / teamCount}</span>
                    <button type="button" data-testid="mp-spt-plus" aria-label="More per team"
                      onClick={() => setField("maxPlayerCount", capacity + teamCount)}>+</button>
                  </div>
                ) : (
                  // NOT a whole number per team (or team count unknown). A fractional "4.5 per team" is
                  // nonsense and a silently-rounded one would write a capacity the operator never chose —
                  // so hide the per-team figure and edit the total directly.
                  <span className="mp-ro" data-testid="mp-spt-na">{teamCount > 0
                    ? `${capacity} total doesn't divide evenly into ${teamCount} teams — edit the total above.`
                    : `Team count unknown — edit the total above.`}</span>
                )}</div>
            </div>
            <div className="mp-derived">Capacity is <b>{capacity} total</b>{teamCount ? <> over <b>{teamCount} teams</b></> : null}. The server caps on maxPlayerCount; team count is Step 2.</div>
          </Section>

          {/* SPOTS SHOWN — the fakeSpotLeft ceilings */}
          <Section title="SPOTS SHOWN" dirty={secDirty(MARKS.map((h) => `fakeSpotLeft${h}h`))}>
            <span className="mp-lb" style={{ marginBottom: 8 }}>MOST SPOTS SHOWN AS LEFT</span>
            <div className="mp-rel" data-testid="mp-ladder">
              {MARKS.map((h) => {
                const ceiling = Number(cur[`fakeSpotLeft${h}h`]) || 0;
                const need = fakesNeeded(ceiling);
                const bad = ladderBreak?.mark === h;
                return (
                  <div className="mp-relcol" key={h} data-mark={h}>
                    <span className="mp-relmk">{h} H</span>
                    <input data-testid={`mp-fake${h}`} className={"mp-relin" + (bad ? " mp-bad" : "")} inputMode="numeric" value={ceiling}
                      aria-label={`Most spots shown as left from ${h} hours before kickoff`}
                      onChange={(e) => setField(`fakeSpotLeft${h}h`, e.target.value.trim() === "" ? "" : Number(e.target.value))} />
                    <span className="mp-relfk" data-testid={`mp-fakeneed${h}`}>{need === 0 ? "no fakes" : `${need} fake`}</span>
                  </div>
                );
              })}
            </div>
            <span className="mp-help">From each mark onward the app never shows more than this many spots left — fake players are added to reach it. The grey figure is how many fakes that ceiling needs at today's roster (<b>{capacity} capacity</b>, <b>{realPlayers} real</b>). Each number should be no higher than the one before it.</span>
            {ladderBreak && (
              <span className="mp-note warn" data-testid="mp-ladderwarn">
                <b>{ladderBreak.n} at {ladderBreak.mark} H is higher than {ladderBreak.prevN} at {ladderBreak.prevMark} H.</b> A ceiling that RISES as kickoff approaches takes fake players back OFF the match, so players watch it empty out instead of filling up. (This is a UI caution — the server does not enforce it, so Save is not blocked.)
              </span>
            )}
          </Section>

          {/* AUTOMATION */}
          <Section title="AUTOMATION" dirty={secDirty(["autoCanceled", "autoCanceledMinutes", "minPlayerCount", "isAutoBump", "maxTeamSize2Team", "maxTeamSize4Team"])}>
            <Toggle id="mp-ac" on={!!cur.autoCanceled} dirty={isDirty("autoCanceled")} onToggle={(v) => setField("autoCanceled", v)}
              title="Auto-cancel" sub="Cancel automatically if the match has not filled" />
            <div className="mp-grid" style={{ marginTop: 11 }}>
              <label className="mp-f"><span className="mp-lb">AUTO-CANCEL MINUTES <em>before kickoff</em></span>
                <input data-testid="mp-acmin" inputMode="numeric" value={cur.autoCanceledMinutes == null ? "" : String(cur.autoCanceledMinutes)} disabled={!cur.autoCanceled}
                  className={isDirty("autoCanceledMinutes") ? "mp-chg" : ""} onChange={(e) => setField("autoCanceledMinutes", e.target.value.trim() === "" ? "" : Number(e.target.value))} /></label>
              <label className="mp-f"><span className="mp-lb">MIN PLAYERS <em>below this, it cancels</em></span>
                <input data-testid="mp-min" inputMode="numeric" value={cur.minPlayerCount == null ? "" : String(cur.minPlayerCount)} disabled={!cur.autoCanceled}
                  className={isDirty("minPlayerCount") ? "mp-chg" : ""} onChange={(e) => setField("minPlayerCount", e.target.value.trim() === "" ? "" : Number(e.target.value))} /></label>
            </div>
            <p className="mp-derived" data-testid="mp-ac-line">{cur.autoCanceled
              ? <>Decides <b>{Number(cur.autoCanceledMinutes) || 0} minutes</b> before kickoff, cancelling if fewer than <b>{Number(cur.minPlayerCount) || 0} real players</b> have joined. (Both the timer and the threshold — the API's fake-vs-real basis is unproven; Clubhouse assumes real.)</>
              : <>Auto-cancel is off; the two fields above are inert.</>}</p>

            <Toggle id="mp-bump" on={!!cur.isAutoBump} dirty={isDirty("isAutoBump")} onToggle={(v) => setField("isAutoBump", v)}
              title="Auto bump to tournament" sub="Grow the match to a tournament if it fills" />
            <div className="mp-grid" style={{ marginTop: 11 }}>
              <label className="mp-f"><span className="mp-lb">MAX SPOTS, 2 TEAMS <em>total</em></span>
                <select data-testid="mp-max2" value={Number(cur.maxTeamSize2Team) || 0} className={isDirty("maxTeamSize2Team") ? "mp-chg" : ""} onChange={(e) => setField("maxTeamSize2Team", Number(e.target.value))}>
                  {SIZES.map((v) => <option key={v} value={v * 2}>{v} × {v}</option>)}
                </select>
                <span className="mp-help">{(Number(cur.maxTeamSize2Team) || 0) / 2} v {(Number(cur.maxTeamSize2Team) || 0) / 2} = <b>{Number(cur.maxTeamSize2Team) || 0} spots</b></span></label>
              <label className="mp-f"><span className="mp-lb">MAX SPOTS, 4 TEAMS <em>total</em></span>
                <select data-testid="mp-max4" value={Number(cur.maxTeamSize4Team) || 0} className={isDirty("maxTeamSize4Team") ? "mp-chg" : ""} disabled={!cur.isAutoBump} onChange={(e) => setField("maxTeamSize4Team", Number(e.target.value))}>
                  {SIZES.map((v) => <option key={v} value={v * 4}>{v} each</option>)}
                </select>
                <span className="mp-help">4 × {(Number(cur.maxTeamSize4Team) || 0) / 4} = <b>{Number(cur.maxTeamSize4Team) || 0} spots</b></span></label>
            </div>
            <p className="mp-derived" data-testid="mp-ladder-text">The bump ladder: a 2-team match grows one spot a side up to its 2-team ceiling of <b>{(Number(cur.maxTeamSize2Team) || 0) / 2} v {(Number(cur.maxTeamSize2Team) || 0) / 2}</b> (<b>{Number(cur.maxTeamSize2Team) || 0} spots</b>). {cur.isAutoBump ? <>Then it CONVERTS TO 4 TEAMS and climbs again to <b>{(Number(cur.maxTeamSize4Team) || 0) / 4} each</b> (<b>{Number(cur.maxTeamSize4Team) || 0} spots</b>).</> : <>Auto-bump is off, so it stops there — it never becomes a tournament.</>}</p>
            <span className="mp-note info"><b>These two are sent as TOTALS.</b> maxTeamSize2Team / maxTeamSize4Team store the whole match size, not the per-side number the dropdown shows. "10 × 10" is sent as 20.</span>
          </Section>

          {/* DESCRIPTION */}
          <Section title="DESCRIPTION" dirty={secDirty(["description", "managerIntro"])}>
            <label className="mp-f"><span className="mp-lb">DESCRIPTION</span>
              <textarea data-testid="mp-desc" value={String(cur.description ?? "")} className={isDirty("description") ? "mp-chg" : ""} onChange={(e) => setField("description", e.target.value)} /></label>
            <label className="mp-f" style={{ marginTop: 12 }}><span className="mp-lb">MANAGER INTRO</span>
              <textarea data-testid="mp-intro" value={String(cur.managerIntro ?? "")} className={isDirty("managerIntro") ? "mp-chg" : ""} onChange={(e) => setField("managerIntro", e.target.value)} /></label>
          </Section>

          {/* ── TEAMS (Step 2) — the IMMEDIATE half. Deliberately NOT another accordion: a red-edged
             block, its own banner, so it never reads like the six staged sections above. Save and
             Revert do not reach anything in here. ── */}
          <div className="mp-teams" data-testid="mp-teams">
            <div className="mp-teams-hd">
              <span className="mp-teams-title">TEAMS · ROSTER · TEAM COUNT</span>
              <span className="mp-immbadge">SAVES IMMEDIATELY</span>
            </div>
            <div className="mp-immbanner" data-testid="mp-immediate-banner">
              <b>These changes save as you make them.</b> Team renames, roster moves and the team count fire the moment you click — on their own endpoints. <b>Save and Revert do not apply to them.</b>
            </div>

            {rosterErr ? <div className="mp-err" data-testid="mp-teams-error">Couldn’t load teams: {rosterErr}</div>
             : !roster ? <div className="mp-loading" data-testid="mp-teams-loading">Loading teams…</div>
             : <>
              {opToast && <div className={"mp-optoast" + (opToast.bad ? " bad" : "")} data-testid="mp-optoast">{opToast.text}</div>}

              {/* TEAM COUNT 2 ⇄ 4 — write-only teamNumbers; verdict comes from a re-read of teams[].length */}
              <div className="mp-countrow">
                <span className="mp-lb" style={{ marginBottom: 0 }}>TEAM COUNT</span>
                <div className="mp-countbtns">
                  {[2, 4].map((n) => (
                    <button key={n} type="button" data-testid={`mp-teamcount-${n}`} className={"mp-cbtn" + (roster.teams.length === n ? " on" : "")}
                      disabled={!!opBusy || roster.teams.length === n} onClick={() => void changeTeamCount(n)}>{n} teams</button>
                  ))}
                </div>
                <span className="mp-help" style={{ marginTop: 0, marginLeft: "auto" }}>now <b>{roster.teams.length}</b></span>
              </div>
              {countResult && <div className="mp-note info" data-testid="mp-teamcount-result">{countResult}</div>}

              {/* ADD — search id/email, then place onto a team; fires immediately */}
              <div className="mp-addrow">
                <div className="mp-addtop">
                  <input data-testid="mp-add-search" className="mp-addsearch" value={q} placeholder="Add a player — search name or email" onChange={(e) => setQ(e.target.value)} />
                  <button type="button" className="mp-mini" data-testid="mp-add-fake" disabled={!!opBusy} onClick={() => { setPendingAdd({ id: null, name: "Fake player", fake: true }); setQ(""); setResults([]); }}>+ Fake</button>
                  <span className="mp-bulk">
                    <input data-testid="mp-bulk-fakes" className="mp-bulkin" inputMode="numeric" placeholder="N" value={bulkFakes} onChange={(e) => setBulkFakes(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Number of fake players to add in bulk" />
                    <button type="button" className="mp-mini" data-testid="mp-add-fakes-bulk" disabled={!!opBusy || !(Number(bulkFakes) > 0)} onClick={() => void addFakesBulk()}>Add fakes</button>
                  </span>
                </div>
                {results.length > 0 && (
                  <div className="mp-addres">{results.map((r) => (
                    <button key={r.id} type="button" data-testid="mp-add-result" onClick={() => { setPendingAdd({ id: r.id, name: r.name }); setQ(""); setResults([]); }}>{r.name}</button>
                  ))}</div>
                )}
                {pendingAdd && <span className="mp-addpending" data-testid="mp-add-pending">Adding <b>{pendingAdd.fake ? "a FAKE player" : pendingAdd.name}</b> — pick a team →<button type="button" className="mp-x" onClick={() => setPendingAdd(null)}>cancel</button></span>}
              </div>

              {/* the teams themselves — rename + roster. No price control, no lock control (not asked for). */}
              <div className="mp-teamgrid" data-testid="mp-teamgrid">
                {roster.teams.map((t) => {
                  const roster2 = roster; // narrow
                  const members = roster2.players.filter((p) => p.team === t.teamNumber);
                  const draft = teamDraft[t.id] ?? "";
                  const canRename = draft.trim() !== "" && draft.trim() !== t.name;
                  return (
                    <section className="mp-team" data-testid="mp-team" data-teamnumber={t.teamNumber} key={t.id}>
                      <div className="mp-teamtop">
                        <span className="mp-teamname" data-testid={`mp-tname-committed-${t.teamNumber}`}>{t.name}</span>
                        <span className="mp-teamcap">{members.length}{roster2.shape?.perTeam ? `/${roster2.shape.perTeam}` : ""}</span>
                      </div>
                      <div className="mp-renamerow">
                        <input data-testid={`mp-tname-${t.teamNumber}`} className="mp-tnameinput" value={draft}
                          aria-label={`Rename team ${t.teamNumber}`} onChange={(e) => setTeamDraft((d) => ({ ...d, [t.id]: e.target.value }))} />
                        <button type="button" data-testid={`mp-rename-${t.teamNumber}`} className="mp-mini" disabled={!canRename || !!opBusy}
                          onClick={() => void renameTeam(t.id, t.teamNumber)}>Rename</button>
                      </div>
                      {pendingAdd && <button type="button" data-testid={`mp-add-to-${t.teamNumber}`} className="mp-addto" disabled={!!opBusy} onClick={() => void addPlayer(t.teamNumber)}>+ Add {pendingAdd.fake ? "fake player" : pendingAdd.name} here</button>}
                      <ul className="mp-players">
                        {members.length === 0 && <li className="mp-empty">no players</li>}
                        {members.map((p) => (
                          <li className="mp-player" data-testid="mp-player" data-um={p.umId} data-fake={p.fake ? "1" : "0"} key={p.umId}>
                            <span className="mp-pnum">{p.playerNumber}</span>
                            <span className="mp-pname">{p.name}{p.fake && <span className="mp-fake-tag" data-testid="mp-fake-tag">FAKE</span>}</span>
                            <span className="mp-pacts">
                              {roster2.teams.filter((o) => o.teamNumber !== t.teamNumber).map((o) => (
                                <button key={o.id} type="button" data-testid={`mp-move-${p.umId}-${o.teamNumber}`} className="mp-mini" title={`Move to ${o.name}`} disabled={!!opBusy} onClick={() => void movePlayer(p, o.teamNumber)}>→ {o.teamNumber}</button>
                              ))}
                              <button type="button" data-testid={`mp-remove-${p.umId}`} className="mp-mini danger" title={`Remove ${p.name}`} disabled={!!opBusy} onClick={() => void removePlayer(p)}>✕</button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </>}
          </div>

          {/* ── CANCEL (Part C) — the danger zone. Separate, immediate, irreversible. ── */}
          <div className="mp-danger" data-testid="mp-danger">
            <div className="mp-danger-hd">DANGER ZONE · CANCEL THE MATCH</div>
            {!cancelOpen ? (
              <button type="button" className="mp-cancelbtn" data-testid="mp-cancel-open" disabled={cancelBusy} onClick={() => void openCancel()}>{cancelBusy ? "Reading…" : "Cancel this match…"}</button>
            ) : cancelPreview?.alreadyCancelled ? (
              <div className="mp-note warn" data-testid="mp-cancel-already">This match is already cancelled — nothing to do.</div>
            ) : cancelPreview ? (
              <div className="mp-cancelconfirm" data-testid="mp-cancel-confirm">
                <p className="mp-cancel-line" data-testid="mp-cancel-line">
                  <b>{cancelPreview.count} player{cancelPreview.count === 1 ? "" : "s"} will be credited ${centsToDollars(cancelPreview.totalCents)}</b> and texted that “{cancelPreview.name}” is off. Each gets a <b>CREDIT</b> of the match value to their MatchDay account — nothing leaves Stripe and no money returns to a card. This fires once and cannot be undone.
                </p>
                <label className="mp-f"><span className="mp-lb">TYPE THE MATCH NAME TO CONFIRM <em>{cancelPreview.name}</em></span>
                  <input data-testid="mp-cancel-name" value={cancelTyped} placeholder={cancelPreview.name} onChange={(e) => setCancelTyped(e.target.value)} /></label>
                <div className="mp-cancel-acts">
                  <button type="button" className="mp-btn" data-testid="mp-cancel-abort" onClick={() => { setCancelOpen(false); setCancelTyped(""); }}>Keep the match</button>
                  <button type="button" className="mp-cancelbtn" data-testid="mp-cancel-do" disabled={cancelBusy || cancelTyped.trim() !== cancelPreview.name} onClick={() => void doCancel()}>{cancelBusy ? "Cancelling…" : "Cancel the match"}</button>
                </div>
              </div>
            ) : null}
            {cancelResult && <div className="mp-note info" data-testid="mp-cancel-result" style={{ marginTop: 10 }}>{cancelResult}</div>}
          </div>
        </div>

        <div className="mp-foot">
          {toast && <span className="mp-note info" data-testid="mp-toast">{toast}</span>}
          <div className="mp-diffbox">
            <button type="button" className="mp-diffhd" data-testid="mp-diffhd" aria-expanded={diffOpen} disabled={changed.length === 0} onClick={() => setDiffOpen((o) => !o)}>
              <span className="mp-caret">{changed.length ? (diffOpen ? "▾" : "▸") : "·"}</span>
              <span data-testid="mp-diffcount">{changed.length ? `${changed.length} change${changed.length === 1 ? "" : "s"} will be sent` : "No changes"}</span>
            </button>
            {changed.length > 0 && diffOpen && (
              <ul className="mp-difflist" data-testid="mp-diff">
                {changed.map((k) => (
                  <li key={k} data-testid="mp-diff-item" data-key={k}>
                    <span className="mp-k">{LABELS[k] ?? k}</span>{" "}
                    <span className="mp-to">{shownVal(k, cur[k], managers)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mp-btns">
            <span className="mp-sp" />
            <button type="button" className="mp-btn" data-testid="mp-revert" disabled={changed.length === 0} onClick={doRevert}>Revert</button>
            <button type="button" className="mp-btn mp-pri" data-testid="mp-save" disabled={changed.length === 0 || saving} onClick={() => void doSave()}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function shownVal(k: string, v: unknown, managers: Manager[]): string {
  if (MONEY_KEYS.has(k)) return v == null || v === "" ? "—" : "$" + centsToDollars(v);
  if (k === "managerId" || k === "secondManagerId") return v == null || v === "" ? "none" : (managers.find((m) => m.id === Number(v))?.name ?? `id ${v}`);
  if (TOGGLE_KEYS.has(k)) return v ? "on" : "off";
  if (k === "maxTeamSize2Team") return `${Number(v) / 2} v ${Number(v) / 2} (${v})`;
  if (k === "maxTeamSize4Team") return `${Number(v) / 4} each (${v})`;
  if (k === "type") return EXPOSED_TYPES[String(v)] ?? String(v);
  const s = String(v ?? "");
  return s.length > 44 ? s.slice(0, 44) + "…" : s || "empty";
}

function Section({ title, dirty, children }: { title: string; dirty?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mp-sec" data-section={title}>
      <button type="button" className="mp-sechd" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mp-caret">{open ? "▾" : "▸"}</span>
        <span className="mp-st">{title}</span>
        {dirty && <span className="mp-dirty" title="unsaved change" />}
      </button>
      <div className="mp-secbd" hidden={!open}>{children}</div>
    </div>
  );
}

function Toggle({ id, on, dirty, onToggle, title, sub }: { id: string; on: boolean; dirty?: boolean; onToggle: (v: boolean) => void; title: string; sub: string }) {
  return (
    <label className={"mp-tog" + (on ? " on" : "")} style={{ marginTop: 14 }}>
      <input type="checkbox" data-testid={id} checked={on} onChange={(e) => onToggle(e.target.checked)} />
      <span className="mp-knob" />
      <span className="mp-tt"><b>{title}{dirty ? " •" : ""}</b><em>{sub}</em></span>
    </label>
  );
}

const CSS = `
.mp *{box-sizing:border-box}
.mp [hidden]{display:none !important}
.mp{--ink:#0e1a13;--ink2:#3d5349;--ink3:#4a6157;--line:#dde6e1;--line2:#cbd8d1;--card:#fff;--grn:#146c43;--focus:#0b6bcb;--red:#a4231e;font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink)}
.mp-panel{max-width:620px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.mp-head{padding:13px 16px;border-bottom:1px solid var(--line);background:#fafcfb}
.mp-name{font-size:18px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-meta{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:6px;font-size:11.5px;color:var(--ink3)}
.mp-tag{display:inline-flex;border-radius:6px;padding:2px 7px;font-size:10.5px;font-weight:800;border:1px solid var(--line2);background:#eef4f1;color:var(--ink2)}
.mp-body{overflow:auto;min-height:0;padding:0 0 8px}
.mp-sec{border-bottom:1px solid var(--line)}
.mp-sechd{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;font:inherit;text-align:left;padding:13px 16px;cursor:pointer;min-height:50px}
.mp-sechd:hover{background:#f7fbf9}
.mp-caret{color:var(--ink3);font-size:10px;width:11px;flex:0 0 11px}
.mp-st{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--ink)}
.mp-dirty{width:7px;height:7px;border-radius:50%;background:#c98a00;flex:0 0 7px}
.mp-secbd{padding:2px 16px 16px}
.mp-note{display:block;font-size:11.5px;line-height:1.4;padding:8px 11px;border-radius:9px;margin-bottom:12px}
.mp-note.info{background:#e8f0fa;border:1px solid #a8c4e6;color:#123a6b}
.mp-note.warn{background:#fdf2e0;border:1px solid #e8c383;color:#6b4400;margin-top:10px}
.mp-note b{font-weight:800}
.mp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mp-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.mp-f{display:block;min-width:0;margin-bottom:0}
.mp-f + .mp-f,.mp-grid + .mp-grid,.mp-grid + .mp-help{margin-top:12px}
.mp-lb{display:flex;align-items:baseline;gap:6px;font-size:9.5px;font-weight:800;letter-spacing:.11em;color:var(--ink3);margin-bottom:5px}
.mp-lb em{margin-left:auto;font-style:normal;font-size:9.5px;font-weight:700;color:var(--ink3);text-transform:none}
.mp input,.mp select,.mp textarea{width:100%;min-width:0;border:1px solid var(--line2);border-radius:9px;padding:9px 11px;font:inherit;font-size:13.5px;background:#fbfdfc;color:var(--ink);min-height:40px}
.mp textarea{min-height:80px;resize:vertical}
.mp input:focus,.mp select:focus,.mp textarea:focus{outline:2px solid var(--focus);outline-offset:-1px;background:#fff}
.mp input:disabled,.mp select:disabled{background:#f1f5f3;color:var(--ink3);cursor:not-allowed}
.mp .mp-chg{border-color:#c98a00;background:#fffdf7}
.mp .mp-bad{border-color:#f0a9a4;background:#fff7f6;color:var(--red)}
.mp-ro{display:block;padding:9px 11px;border:1px dashed var(--line2);border-radius:9px;background:#f4f9f6;color:var(--ink2);font-size:12.5px}
.mp-help{display:block;margin-top:5px;font-size:11.5px;color:var(--ink3)}
.mp-derived{font-size:12.5px;color:var(--ink2);margin-top:9px}
.mp-derived b{font-weight:800;color:var(--ink)}
.mp-step{display:inline-flex;align-items:center;border:1px solid var(--line2);border-radius:9px;overflow:hidden;background:#fbfdfc}
.mp-step button{border:0;background:none;font:inherit;font-size:16px;font-weight:800;color:var(--ink2);min-width:40px;min-height:40px;cursor:pointer}
.mp-step button:disabled{color:#b5c4bc;cursor:not-allowed}
.mp-step-val{min-width:52px;text-align:center;font-weight:800;border-left:1px solid var(--line2);border-right:1px solid var(--line2);padding:9px 0}
.mp-rel{display:grid;grid-template-columns:repeat(5,1fr);gap:9px;border:1px solid var(--line);border-radius:11px;padding:11px;background:#fbfdfc}
.mp-relcol{display:block;min-width:0;text-align:center}
.mp-relmk{display:block;font-size:10.5px;font-weight:800;letter-spacing:.09em;color:var(--ink2);margin-bottom:6px}
.mp-relin{width:100%;text-align:center;font-size:16px;font-weight:800;min-height:44px;padding:6px 4px;background:#fff}
.mp-relfk{display:block;margin-top:4px;font-size:10px;font-weight:700;color:#6b5200;background:#fdf2c8;border:1px solid #e6cf7a;border-radius:5px;padding:1px 0;white-space:nowrap}
.mp-tog{display:flex;align-items:flex-start;gap:11px;cursor:pointer;min-height:44px;position:relative}
.mp-tog input{position:absolute;opacity:0;width:1px;height:1px;min-height:0;margin:0}
.mp-knob{flex:0 0 44px;width:44px;height:26px;border-radius:999px;background:#d6e0da;position:relative;margin-top:2px;transition:background .12s}
.mp-knob::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:left .12s}
.mp-tog.on .mp-knob{background:#35c07a}
.mp-tog.on .mp-knob::after{left:21px}
.mp-tog input:focus-visible + .mp-knob{outline:2px solid var(--focus);outline-offset:2px}
.mp-tt b{display:block;font-size:14px;font-weight:800}
.mp-tt em{display:block;font-style:normal;font-size:12px;color:var(--ink3);margin-top:1px}
.mp-foot{border-top:1px solid var(--line);background:#fafcfb;padding:11px 16px}
.mp-diffbox{margin-bottom:10px}
.mp-diffhd{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;font:inherit;text-align:left;cursor:pointer;padding:0 2px;min-height:32px;font-size:12.5px;color:var(--ink2)}
.mp-diffhd:disabled{cursor:default;opacity:.7}
.mp-difflist{list-style:none;margin:8px 0 0;padding:9px 11px;background:#fff;border:1px solid var(--line);border-radius:9px;font-size:12px;max-height:150px;overflow:auto}
.mp-difflist li{padding:3px 0;border-bottom:1px solid #f0f5f2}
.mp-difflist li:last-child{border-bottom:0}
.mp-k{font-weight:800}
.mp-to{color:var(--grn);font-weight:700}
.mp-btns{display:flex;gap:9px;align-items:center}
.mp-sp{flex:1 1 auto}
.mp-btn{border:1px solid var(--line2);background:var(--card);border-radius:9px;padding:0 14px;font:inherit;font-weight:700;cursor:pointer;color:var(--ink2);min-height:40px}
.mp-btn:disabled{opacity:.5;cursor:not-allowed}
.mp-btn.mp-pri{background:#12301f;border-color:#12301f;color:#fff}
.mp-err{padding:16px;color:var(--red);font-size:13px}
.mp-loading{padding:16px;color:var(--ink3)}
/* ── TEAMS (immediate half) — red-edged so it never reads as one of the staged accordions ── */
.mp-teams{margin:14px 16px 4px;border:1px solid #e6b7b0;border-left:4px solid #c0392b;border-radius:11px;background:#fdf7f6;overflow:hidden}
.mp-teams-hd{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid #eecdc8;background:#fbeeec}
.mp-teams-title{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:#7c241b}
.mp-immbadge{margin-left:auto;font-size:9.5px;font-weight:800;letter-spacing:.07em;color:#fff;background:#c0392b;border-radius:5px;padding:2px 7px}
.mp-immbanner{font-size:11.5px;line-height:1.45;color:#6b2019;padding:10px 13px;border-bottom:1px solid #eecdc8;background:#fdf1ef}
.mp-immbanner b{font-weight:800}
.mp-optoast{margin:11px 13px 0;font-size:12px;padding:8px 11px;border-radius:8px;background:#e6f3ea;border:1px solid #a9d3ba;color:#14512f}
.mp-optoast.bad{background:#fbe7e4;border-color:#e6b0a8;color:#8a2018}
.mp-countrow{display:flex;align-items:center;gap:10px;padding:12px 13px 4px}
.mp-countbtns{display:inline-flex;border:1px solid #d9c3bf;border-radius:8px;overflow:hidden}
.mp-cbtn{border:0;background:#fff;font:inherit;font-weight:700;color:#5a4b48;padding:8px 14px;min-height:38px;cursor:pointer}
.mp-cbtn + .mp-cbtn{border-left:1px solid #d9c3bf}
.mp-cbtn.on{background:#c0392b;color:#fff}
.mp-cbtn:disabled:not(.on){opacity:.55;cursor:not-allowed}
.mp-teams .mp-note.info{margin:10px 13px 0}
.mp-addrow{position:relative;padding:10px 13px 2px}
.mp-addtop{display:flex;gap:7px;align-items:center}
.mp-addsearch{flex:1;min-width:0;border:1px solid #d9c3bf;border-radius:9px;padding:9px 11px;font:inherit;font-size:13.5px;background:#fff;min-height:40px}
.mp-bulk{display:inline-flex;gap:5px;align-items:center;flex:0 0 auto}
.mp-bulkin{width:48px;text-align:center;border:1px solid #d9c3bf;border-radius:8px;padding:7px 4px;font:inherit;font-size:13px;background:#fff;min-height:36px}
.mp-addres{position:absolute;left:13px;right:13px;top:52px;z-index:20;background:#fff;border:1px solid #d9c3bf;border-radius:9px;box-shadow:0 8px 22px rgba(120,30,20,.16);overflow:hidden}
.mp-addres button{display:block;width:100%;text-align:left;border:0;background:#fff;padding:9px 12px;font:inherit;font-size:13px;border-bottom:1px solid #f1e4e1;cursor:pointer}
.mp-addres button:last-child{border-bottom:0}.mp-addres button:hover{background:#fbeeec}
.mp-addpending{display:inline-flex;align-items:center;gap:7px;margin-top:8px;font-size:12px;color:#6b2019}
.mp-x{border:0;background:none;color:#8a2018;text-decoration:underline;cursor:pointer;font:inherit;font-size:12px;padding:2px 4px}
.mp-teamgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:11px 13px 13px}
.mp-team{border:1px solid #ecd6d2;border-radius:10px;background:#fff;padding:10px;min-width:0}
.mp-teamtop{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.mp-teamname{font-size:14px;font-weight:800;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-teamcap{margin-left:auto;font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums;flex:0 0 auto}
.mp-renamerow{display:flex;gap:6px;margin-bottom:8px}
.mp-tnameinput{flex:1;min-width:0;border:1px solid #d9c3bf;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;background:#fffdfc;min-height:36px}
.mp-tnameinput:focus{outline:2px solid var(--focus);outline-offset:-1px;background:#fff}
.mp-mini{border:1px solid #d9c3bf;background:#fff;border-radius:7px;padding:0 9px;font:inherit;font-size:12px;font-weight:700;color:#5a4b48;min-height:34px;min-width:34px;cursor:pointer;flex:0 0 auto}
.mp-mini:disabled{opacity:.45;cursor:not-allowed}
.mp-mini.danger{color:#a4231e;border-color:#e6b7b0}.mp-mini.danger:hover:not(:disabled){background:#fbeeec}
.mp-addto{width:100%;border:1px dashed #7fb894;background:#eef8f1;color:#14512f;border-radius:8px;padding:8px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;margin-bottom:8px}
.mp-players{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.mp-empty{font-size:12px;color:var(--ink3);padding:4px 2px}
.mp-player{display:flex;align-items:center;gap:7px;border:1px solid #eef1ef;border-radius:8px;padding:5px 7px;background:#fbfdfc;min-height:40px}
.mp-pnum{width:18px;height:18px;flex:0 0 18px;border-radius:5px;background:#eef3f0;color:#3a5348;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center}
.mp-pname{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-fake-tag{font-size:9px;font-weight:800;background:#f2e31d;color:#231f00;border-radius:4px;padding:1px 4px;margin-left:6px;vertical-align:middle}
.mp-pacts{display:inline-flex;gap:4px;flex:0 0 auto}
/* ── CANCEL danger zone — the darkest treatment; separate from everything above ── */
.mp-danger{margin:14px 16px 16px;border:1px solid #d8968f;border-left:4px solid #8a1a12;border-radius:11px;background:#fbeeec;padding:13px}
.mp-danger-hd{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:#8a1a12;margin-bottom:10px}
.mp-cancelbtn{border:1px solid #8a1a12;background:#a4231e;color:#fff;border-radius:9px;padding:0 16px;font:inherit;font-weight:700;cursor:pointer;min-height:40px}
.mp-cancelbtn:hover:not(:disabled){background:#8a1a12}
.mp-cancelbtn:disabled{opacity:.5;cursor:not-allowed}
.mp-cancelconfirm{display:block}
.mp-cancel-line{font-size:13px;line-height:1.5;color:#5a1611;margin:0 0 12px}
.mp-cancel-line b{font-weight:800;color:#3d0e0a}
.mp-cancel-acts{display:flex;gap:9px;justify-content:flex-end;margin-top:12px}
@media (max-width:560px){.mp-grid,.mp-grid3{grid-template-columns:1fr}.mp-teamgrid{grid-template-columns:1fr}}
`;
