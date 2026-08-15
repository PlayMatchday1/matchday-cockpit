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
import {
  emptyPending, normalizePending, pendingCount, sortedTeam, spotsOfTeam, planMove,
  savePlan, clearApplied, teamCountConsequence,
  type Pending, type RosterOrigin, type EditRow, type PlannedWrite,
} from "@/lib/rosterEditModel";

// Only these two `type` values are exposed. The known enum also has BRACKET and GROUP and the full
// set is UNKNOWN (no spec in repo). A match whose current type is NOT one of these renders as
// READ-ONLY TEXT — never a two-option dropdown that would silently rewrite a BRACKET on first touch.
const EXPOSED_TYPES: Record<string, string> = { REGULAR: "Regular", EVENT: "Special event" };
const MARKS = [36, 24, 12, 6, 3] as const;
// EXACT, lowercase, trimmed. "Cancel" and " cancel " with inner spaces are refused — trimmed means
// the surrounding whitespace only, not a fuzzy match.
const CANCEL_WORD = "cancel";
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
type PlayerRow = { umId: number; playerId: number; team: number; playerNumber: number | null; name: string; phone: string | null; fake: boolean; promoCode?: string | null };
type RosterState = { name: string; teams: TeamRow[]; players: PlayerRow[]; shape: { teamN: number; perTeam: number }; maxPlayerCount: number | null; occupancy: number | null; hidden?: { total: number; cancelled: number; unpaid: number; refunded: number }; promo?: { spots: number; codes: string[] } };
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

  // ── TEAMS · ROSTER · TEAM COUNT — STAGED, like every other section ──────────────────────────────
  // These used to fire the instant they were clicked, on their own endpoints, with Save and Revert
  // reaching none of them — which is why the section needed a red badge and a red banner saying so.
  // Moves, removals, renames and the team count are now PENDING LOCAL EDITS held in `pending`; the
  // rules (what counts as a change, what order the writes go in, what a swap means) live in
  // rosterEditModel so they are testable and cannot drift from what the UI draws.
  //
  // STILL IMMEDIATE, AND DELIBERATELY SO: adding a player, adding a fake and the bulk-fake count.
  // Those were not in the brief's list of four, and bulk-fake in particular sets a TOTAL rather than
  // describing a delta, so it has no coherent pending form. They say so on themselves, in the
  // section's own voice rather than a red banner. See the report — this is the one place the
  // section does not behave like the others, and it is flagged rather than hidden.
  const [roster, setRoster] = useState<RosterState | null>(null);
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState<Record<number, string>>({}); // teamId → typed name (the pending rename)
  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [opToast, setOpToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [immediateOps, setImmediateOps] = useState<string[]>([]); // adds that fired this session — drives Revert's warning
  const [pending, setPending] = useState<Pending>(emptyPending());
  const [movePick, setMovePick] = useState<{ umId: number; team: number | null } | null>(null);
  // PER WRITE, not per Save. A batch that stops half-way has to say which of its writes landed.
  const [writeResults, setWriteResults] = useState<{ label: string; verdict: "LANDED" | "FAILED" | "NOT APPLIED" | "UNKNOWN"; detail?: string }[]>([]);
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
    return (roster.players.filter((p) => p.team === teamNumber).reduce((m, p) => Math.max(m, p.playerNumber ?? 0), 0)) + 1;
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
  // ── the STAGED roster edits. None of these touch the network. ─────────────────────────────────
  // `origin` is what the server last told us; `pending` is the intent laid over it. Every read of
  // pending goes through the model, so a move back to where a player started, or a rename back to
  // the committed name, simply stops being a change — the diff IS the request body.
  const origin: RosterOrigin = useMemo(
    () => ({ rows: (roster?.players ?? []) as EditRow[], teams: roster?.teams ?? [] }),
    [roster],
  );
  const pendingN = useMemo(() => pendingCount(pending, origin), [pending, origin]);
  const norm = useMemo(() => normalizePending(pending, origin), [pending, origin]);

  const stageMove = (mover: EditRow, toTeam: number, toSpot: number) => {
    setPending((p) => planMove(p, origin, mover, toTeam, toSpot));
    setMovePick(null);
  };
  const toggleRemove = (p: { umId: number }) => {
    setPending((prev) => {
      const on = prev.removes.includes(p.umId);
      return normalizePending({ ...prev, removes: on ? prev.removes.filter((x) => x !== p.umId) : [...prev.removes, p.umId] }, origin);
    });
  };
  const stageTeamCount = (target: number) => {
    setPending((p) => normalizePending({ ...p, teamCount: target }, origin));
  };
  const stageRename = (teamId: number, value: string) => {
    setTeamDraft((d) => ({ ...d, [teamId]: value }));
    setPending((p) => normalizePending({ ...p, names: { ...p.names, [teamId]: value } }, origin));
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
    // The typed word is "cancel" — lowercase, exact, trimmed. Typing a match name was a
    // transcription exercise, not a decision; this is still a deliberate act but the friction is
    // in the CONSEQUENCE stated above it, not in the copying.
    if (!cancelPreview || cancelBusy || cancelTyped.trim() !== CANCEL_WORD) return;
    const headers = await authHeaders(); if (!headers) { setCancelResult("No active session — sign in again."); return; }
    setCancelBusy(true); setCancelResult(null);
    try {
      const res = await fetch(cancelPath, { method: "POST", headers, body: JSON.stringify({ confirmName: cancelPreview.name, source: "Match panel · cancel" }) });
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
  // EVERYTHING UNSAVED, in one number: staged match fields AND pending roster edits. Batching is
  // what created the risk — while roster actions fired on click there was nothing to lose, so the
  // host's close/step guard only had to know about match fields. Now a close or a ‹ / › with a
  // staged removal on screen would silently throw it away, so the guard ships in the same commit
  // as the batching. The Gameday panel blocks Close and both match arrows on this flag.
  const unsaved = changed.length + pendingN;
  useEffect(() => { onDirtyChange?.(unsaved > 0); }, [unsaved, onDirtyChange]);

  // ...and the same guard for leaving the PAGE, which the host cannot see: a full unload
  // (beforeunload) and an in-app link click, which App Router navigates without unloading.
  useEffect(() => {
    if (unsaved === 0 || typeof window === "undefined") return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      if (a.getAttribute("href")?.startsWith("#")) return;
      if (!window.confirm(`You have ${unsaved} unsaved change${unsaved === 1 ? "" : "s"} on this match. Leaving discards ${unsaved === 1 ? "it" : "them"} — nothing has been sent.\n\nLeave anyway?`)) {
        e.preventDefault(); e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true); // capture: ahead of the router's own handler
    return () => { window.removeEventListener("beforeunload", onUnload); document.removeEventListener("click", onClick, true); };
  }, [unsaved]);
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

  // The EFFECTIVE team count — the pending one if the operator has chosen a different shape, else
  // what the server last said. SPOTS derives capacity and the rung field from this, so the derived
  // numbers describe the match as it will be after Save rather than as it is now.
  // TWO COUNTS, FROM TWO PAYLOADS, DELIBERATELY. SPOTS derives capacity and the rung field from the
  // MATCH detail; the TEAMS section draws the roster route's team rows. They agree in production,
  // but each section reads what it renders — a picker driven by a payload it does not draw is how
  // you end up offering a team that is not on screen.
  const committedTeamCount = Array.isArray(orig?.teams) ? orig!.teams!.length : 0;
  const teamCount = norm.teamCount ?? committedTeamCount;
  const rosterTeamCount = norm.teamCount ?? (roster?.teams.length ?? committedTeamCount);

  // The RUNG this team count writes. 2 and 4 have dedicated size fields; 3 has none (the API models
  // only maxTeamSize2Team / maxTeamSize4Team), so a 3-team match's capacity lives in maxPlayerCount
  // alone — confirmed on 28 live 3-team matches, e.g. 15322: 21 total = 3 × 7, while its m2/m4 hold
  // the OTHER configurations and say nothing about the 3-team shape.
  const rungKey: "maxTeamSize2Team" | "maxTeamSize4Team" | null =
    teamCount === 2 ? "maxTeamSize2Team" : teamCount === 4 ? "maxTeamSize4Team" : null;
  // Sets the TOTAL from a per-team figure, and touches ONLY this rung. The other rung is the
  // alternate configuration the auto-bump ladder moves between; writing it would corrupt that.
  const setPerTeam = (per: number) => {
    const total = Math.max(teamCount, Math.round(per) * teamCount);
    setField("maxPlayerCount", total);
    if (rungKey) setField(rungKey, total);
  };

  // ── ONE roster write, then the RE-READ that decides its verdict ─────────────────────────────────
  // A 2xx is not proof. Every kind is judged against the roster the server returns AFTERWARDS, never
  // against the status code — teamNumbers in particular is write-only and absent from every GET, so
  // the only evidence it took is the number of team rows that come back.
  const runRosterWrite = async (w: PlannedWrite, saveId: string): Promise<{ verdict: "LANDED" | "FAILED" | "NOT APPLIED" | "UNKNOWN"; detail?: string }> => {
    const op: Record<string, unknown> =
      w.kind === "shape" ? { kind: "shape", fields: w.fields }
      : w.kind === "move" ? { kind: "move", userMatchId: w.umId, team: w.team, playerNumber: w.playerNumber }
      : w.kind === "remove" ? { kind: "remove", userMatchId: w.umId }
      : { kind: "teams", teamId: w.teamId, fields: w.fields };
    const r = await rosterPost({ ...op, saveId }, w.label);
    if (!r) return { verdict: "UNKNOWN", detail: "no answer from the server — reload before acting" };
    if (!r.ok) return { verdict: "FAILED", detail: String(r.j.error ?? "rejected") };

    const fresh = await loadRoster(); // THE RE-READ
    if (!fresh) return { verdict: "UNKNOWN", detail: "the write returned 2xx but the re-read failed" };
    const took =
      w.kind === "shape" ? fresh.teams.length === w.fields.teamNumbers
      : w.kind === "move" ? fresh.players.some((p) => p.umId === w.umId && p.team === w.team && p.playerNumber === w.playerNumber)
      : w.kind === "remove" ? !fresh.players.some((p) => p.umId === w.umId)
      : fresh.teams.find((t) => t.id === w.teamId)?.name === w.fields.name;
    if (took) return { verdict: "LANDED" };
    return {
      verdict: "NOT APPLIED",
      detail: w.kind === "shape"
        ? `the re-read shows ${fresh.teams.length} team(s), not ${w.fields.teamNumbers}`
        : "the server accepted it (2xx) but a re-read shows it did not take",
    };
  };

  const doSave = async () => {
    if (!orig || saving) return;
    if (changed.length === 0 && pendingN === 0) return;
    setSaving(true); setToast(null); setWriteResults([]);
    let rosterLanded = 0;
    // CAPTURE THE MATCH DIFF FIRST. The roster batch below re-reads the match, and a re-read
    // reseeds `cur` from the server — which would silently discard the staged field edits before
    // they were ever sent. Taking the diff up front means what Save promised is what Save sends.
    const changes = pick(cur, changed);

    // ── ROSTER FIRST, IN ORDER, ONE AT A TIME ────────────────────────────────────────────────────
    // Team count leads because a move to team 3 is invalid while the match still has two teams.
    // We STOP at the first write that does not land, and we do NOT auto-revert what already did —
    // a revert is another write that can also fail, and a failed revert on a half-applied batch
    // leaves nobody able to say what is true. What landed stays; what did not stays PENDING, on
    // screen, for a deliberate retry. Writes never retry on their own.
    if (pendingN > 0) {
      const saveId = crypto.randomUUID();
      const plan = savePlan(pending, origin);
      const results: typeof writeResults = [];
      let stopped = false;
      for (const w of plan) {
        const res = await runRosterWrite(w, saveId);
        results.push({ label: w.label, ...res });
        setWriteResults([...results]);
        if (res.verdict !== "LANDED") { stopped = true; break; }
        rosterLanded++;
        setPending((p) => clearApplied(p, w));   // forget an intention that is now reality
      }
      if (stopped) {
        const landed = results.filter((r) => r.verdict === "LANDED").length;
        setToast(
          `Stopped after ${results.length} of ${plan.length} write(s). ${landed} LANDED and ${landed === 1 ? "is" : "are"} not undone — ` +
          `a revert is another write that can also fail. The rest are still pending below; nothing was retried.`);
        setSaving(false);
        return;   // the staged MATCH FIELDS are not sent either — stop means stop
      }
      setPending(emptyPending());
      // Only re-read the match here when there is nothing staged to send: `load()` reseeds `cur`,
      // and the PUT below does its own re-read anyway.
      if (changed.length === 0) await load();
    }

    if (changed.length === 0) {
      setToast(`All ${rosterLanded} roster write(s) LANDED (each confirmed by a re-read).`);
      setSaving(false);
      return;
    }
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

  // REVERT DISCARDS PENDING STATE AND ISSUES NO REQUEST. It is not an undo: it cannot take back a
  // write, because taking one back would mean issuing another write, which can fail in its own
  // right. It throws away intentions that were never sent — nothing more. The copy says exactly
  // that, so nobody reaches for it expecting it to reverse something that already landed.
  const doRevert = () => {
    if (!orig) return;
    // Adds are the one control here that still fires on click. If any fired this session, Revert
    // must NAME what it will not undo, rather than letting the word imply more than it does.
    if (immediateOps.length > 0 && typeof window !== "undefined") {
      const okd = window.confirm(
        `Revert discards your ${changed.length + pendingN} unsaved change${changed.length + pendingN === 1 ? "" : "s"} and sends nothing.\n\n` +
        `It does NOT undo the ${immediateOps.length} add${immediateOps.length === 1 ? "" : "s"} that already fired this session — those went to the server on click and cannot be taken back here:\n` +
        `• ${immediateOps.slice(-6).join("\n• ")}\n\nContinue?`);
      if (!okd) return;
    }
    const next: Record<string, unknown> = {};
    for (const k of STAGED_KEYS) next[k] = orig[k] ?? null;
    setCur(next);
    setWhen(orig.startDate ? parseWall(orig.startDate) : { date: "", time: "" });
    setPending(emptyPending());
    setTeamDraft(Object.fromEntries((roster?.teams ?? []).map((t) => [t.id, t.name])));
    setMovePick(null);
    setWriteResults([]);
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

          {/* CAMERA lived here. Removed — Master Schedule carries the Veo toggle on every
              match card (VeoMasterSchedule posts the same /api/veo/intent), so nothing is lost and
              nothing shared went with it. */}
          <Section title="WHEN" dirty={secDirty(["startDate", "endDate"])}>
            <div className="mp-grid">
              <label className="mp-f"><span className="mp-lb">DATE</span>
                <input type="date" data-testid="mp-date" value={when.date} className={isDirty("startDate") ? "mp-chg" : ""} onChange={(e) => applyWhen(e.target.value, when.time)} /></label>
              <label className="mp-f"><span className="mp-lb">START TIME</span>
                <input type="time" data-testid="mp-start" value={when.time} className={isDirty("startDate") ? "mp-chg" : ""} onChange={(e) => applyWhen(when.date, e.target.value)} /></label>
            </div>
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
            <Toggle id="mp-free" on={!!cur.isFreeMember} dirty={isDirty("isFreeMember")} onToggle={(v) => setField("isFreeMember", v)}
              title="Free to member" sub="Members join at no charge" />
          </Section>

          {/* SPOTS */}
          <Section title="SPOTS" dirty={secDirty(["maxPlayerCount", "maxTeamSize2Team", "maxTeamSize4Team"])}>
            {/* NOBODY DECIDES "36". They decide how many teams and how many a side; the capacity
                falls out. So the two controls are TEAMS and SPOTS PER TEAM, and the total is derived
                and read-only.

                THE PICKER OFFERS 2 / 3 / 4, and 3 is real: 28 of 711 non-cancelled matches over the
                last 8 weeks run 3 teams (e.g. 15322, 21 total = 3 × 7). What 3 lacks is a RUNG FIELD
                — the API models only maxTeamSize2Team and maxTeamSize4Team. A 3-team match stores its
                capacity in maxPlayerCount alone, which is why selecting 3 writes only that and says so.

                maxPlayerCount was divisible by the team count on 711 of 711 matches in that window, so
                a derived control can express every real match. The non-divisible branch below is kept
                anyway and shows the TRUE stored total rather than rounding it to something the picker
                could say. */}
            <div className="mp-grid">
              {/* ONE team-count control for the whole panel. This picker and the one in TEAMS below
                  set the SAME pending value — two controls that disagreed about the shape of the
                  match is exactly the drift worth avoiding. Neither fires anything. */}
              <div className="mp-f"><span className="mp-lb">TEAMS <em>{norm.teamCount != null ? "pending" : "staged"}</em></span>
                <div className="mp-seg" role="group" aria-label="Team count" data-testid="mp-teams-seg">
                  {[2, 3, 4].map((n) => (
                    <button key={n} type="button" data-testid={`mp-teams-${n}`} data-on={teamCount === n ? "true" : "false"}
                      aria-pressed={teamCount === n} disabled={!!opBusy}
                      className={teamCount === n ? "on" : ""} onClick={() => stageTeamCount(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <div className="mp-f"><span className="mp-lb">SPOTS PER TEAM <em>{teamCount} teams</em></span>
                {teamCount > 0 && capacity % teamCount === 0 ? (
                  <div className="mp-step">
                    <button type="button" data-testid="mp-spt-minus" aria-label="Fewer per team" disabled={capacity <= teamCount}
                      onClick={() => setPerTeam(capacity / teamCount - 1)}>−</button>
                    <span className="mp-step-val" data-testid="mp-spt">{capacity / teamCount}</span>
                    <button type="button" data-testid="mp-spt-plus" aria-label="More per team"
                      onClick={() => setPerTeam(capacity / teamCount + 1)}>+</button>
                  </div>
                ) : (
                  // The TRUE stored total, never a rounded one. Unobserved in 8 weeks of production
                  // data, but a real match that got here must not be silently reshaped.
                  <span className="mp-ro" data-testid="mp-spt-na">{teamCount > 0
                    ? `${capacity} total doesn't divide evenly into ${teamCount} teams — this match's stored capacity is ${capacity} and is shown as-is.`
                    : `Team count unknown — stored capacity is ${capacity}.`}</span>
                )}
              </div>
              <div className="mp-f"><span className="mp-lb">CAPACITY <em>derived</em></span>
                <span className="mp-ro" data-testid="mp-capacity" data-value={capacity}>
                  {teamCount > 0 && capacity % teamCount === 0
                    ? `${capacity} total — ${teamCount} teams × ${capacity / teamCount}`
                    : `${capacity} total`}
                </span>
              </div>
            </div>
          </Section>

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
          </Section>

          {/* DESCRIPTION */}
          <Section title="DESCRIPTION" dirty={secDirty(["description", "managerIntro"])}>
            <label className="mp-f"><span className="mp-lb">DESCRIPTION</span>
              <textarea data-testid="mp-desc" value={String(cur.description ?? "")} className={isDirty("description") ? "mp-chg" : ""} onChange={(e) => setField("description", e.target.value)} /></label>
            <label className="mp-f" style={{ marginTop: 12 }}><span className="mp-lb">MANAGER INTRO</span>
              <textarea data-testid="mp-intro" value={String(cur.managerIntro ?? "")} className={isDirty("managerIntro") ? "mp-chg" : ""} onChange={(e) => setField("managerIntro", e.target.value)} /></label>
          </Section>

          {/* ── TEAMS · ROSTER · TEAM COUNT — a staged section like every other one ────────────────
             It was a red-edged block with a SAVES IMMEDIATELY badge and a banner explaining that
             Save and Revert did not reach it. All three are gone, because the thing they warned
             about is gone: these edits now stage and land on Save with everything else. ── */}
          <Section title="TEAMS · ROSTER · TEAM COUNT" dirty={pendingN > 0}>
            <div data-testid="mp-teams">
            {rosterErr ? <div className="mp-err" data-testid="mp-teams-error">Couldn’t load teams: {rosterErr}</div>
             : !roster ? <div className="mp-loading" data-testid="mp-teams-loading">Loading teams…</div>
             : <>
              {opToast && <div className={"mp-optoast" + (opToast.bad ? " bad" : "")} data-testid="mp-optoast">{opToast.text}</div>}

              {/* TEAM COUNT — the consequence is stated BEFORE the click, not in a dialog after it.
                  Same pattern as the manager-pay screen: the sentence that tells you what this does
                  to real people is on screen while you are still deciding. */}
              <div className="mp-countrow">
                <span className="mp-lb" style={{ marginBottom: 0 }}>TEAM COUNT</span>
                <div className="mp-countbtns">
                  {[2, 3, 4].map((n) => (
                    <button key={n} type="button" data-testid={`mp-teamcount-${n}`}
                      className={"mp-cbtn" + (rosterTeamCount === n ? " on" : "") + (norm.teamCount === n ? " pend" : "")}
                      aria-pressed={rosterTeamCount === n} disabled={!!opBusy} onClick={() => stageTeamCount(n)}>{n} teams</button>
                  ))}
                </div>
                <span className="mp-help" style={{ marginTop: 0, marginLeft: "auto" }}>
                  now <b>{roster.teams.length}</b>{norm.teamCount != null && <> → <b data-testid="mp-teamcount-pending">{norm.teamCount}</b> on Save</>}
                </span>
              </div>
              <ul className="mp-conseq" data-testid="mp-teamcount-consequence">
                {[2, 3, 4].filter((n) => n !== roster.teams.length).map((n) => {
                  const line = teamCountConsequence(origin, pending, n);
                  return line ? <li key={n} data-n={n} data-chosen={norm.teamCount === n ? "true" : "false"}><b>{n} teams:</b> {line}</li> : null;
                })}
              </ul>

              {/* ADD — the one control here that still fires on click. It says so on itself. */}
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
                <span className="mp-help" data-testid="mp-add-immediate-note">sends on click, not on Save</span>
              </div>

              {!!roster.promo?.spots && (
                // Once per match. A 100%-off code filling a roster is revenue that never arrived.
                <p className="mp-hint" data-testid="mp-promo-count" data-spots={roster.promo.spots}>
                  <b>{roster.promo.spots} on a promo</b>{roster.promo.codes.length ? ` — ${roster.promo.codes.join(", ")}` : ""}
                </p>
              )}
              {!!roster.hidden?.total && (
                // NOT silent. A 20-deep repeat from one player is a payment failure; the noise is
                // gone from the teams but the fact that it happened is stated.
                <p className="mp-hint" data-testid="mp-roster-hidden" data-count={roster.hidden.total}>
                  <b>{roster.hidden.total} hidden</b>{" — "}
                  {[roster.hidden.unpaid ? `${roster.hidden.unpaid} unpaid` : "",
                    roster.hidden.cancelled ? `${roster.hidden.cancelled} cancelled` : "",
                    roster.hidden.refunded ? `${roster.hidden.refunded} refunded` : ""].filter(Boolean).join(" · ")}
                  {". They hold no spot."}
                </p>
              )}

              {/* THE TEAMS. 2 x 2 at four teams, never four abreast: a column narrow enough to fit
                  four across cannot hold a name and a phone number at any panel width worth having.
                  The columns are minmax(0,1fr) so they can actually SHRINK — with a bare 1fr the
                  old per-destination move buttons set a min-content floor and pushed teams 3 and 4
                  clean off the side of the panel. */}
              <div className="mp-teamgrid" data-testid="mp-teamgrid" data-teams={roster.teams.length}>
                {roster.teams.map((t) => {
                  const rows = sortedTeam(origin, pending, t.teamNumber);
                  const live = rows.filter((r) => !r.removed);
                  const draft = teamDraft[t.id] ?? "";
                  const renamePending = norm.names[t.id] != null;
                  return (
                    <section className="mp-team" data-testid="mp-team" data-teamnumber={t.teamNumber} key={t.id}>
                      <div className="mp-teamtop">
                        <span className="mp-teamname" data-testid={`mp-tname-committed-${t.teamNumber}`}>{t.name}</span>
                        <span className="mp-teamcap">{live.length}{roster.shape?.perTeam ? `/${roster.shape.perTeam}` : ""}</span>
                      </div>
                      <div className="mp-renamerow">
                        <input data-testid={`mp-tname-${t.teamNumber}`} className={"mp-tnameinput" + (renamePending ? " mp-chg" : "")} value={draft}
                          aria-label={`Rename team ${t.teamNumber}`} onChange={(e) => stageRename(t.id, e.target.value)} />
                        {renamePending && <span className="mp-pendtag" data-testid={`mp-rename-pending-${t.teamNumber}`}>PENDING</span>}
                      </div>
                      {pendingAdd && <button type="button" data-testid={`mp-add-to-${t.teamNumber}`} className="mp-addto" disabled={!!opBusy} onClick={() => void addPlayer(t.teamNumber)}>+ Add {pendingAdd.fake ? "fake player" : pendingAdd.name} here</button>}
                      <ul className="mp-players">
                        {rows.length === 0 && <li className="mp-empty">no players</li>}
                        {rows.map(({ row: p, spot, moved, removed, collision }) => (
                          <li className={"mp-player" + (moved ? " pend-move" : "") + (removed ? " pend-remove" : "") + (collision ? " clash" : "")}
                            data-testid="mp-player" data-um={p.umId} data-fake={p.fake ? "1" : "0"}
                            data-spot={spot == null ? "" : spot} data-pending={removed ? "remove" : moved ? "move" : ""}
                            data-collision={collision ? "true" : "false"} key={p.umId}>
                            <span className="mp-pnum" data-testid="mp-spot">{spot ?? "—"}</span>
                            {/* NAME then PHONE. Two lines: a phone number on the same line as a name
                                is what crushed both. Display only — see the roster route: it never
                                reaches change_log, where the rule is last-4 via phoneLast4(). */}
                            <span className="mp-pident">
                              <span className="mp-pname" data-testid="mp-pname">{p.name}{p.fake && <span className="mp-fake-tag" data-testid="mp-fake-tag">FAKE</span>}{(p as PlayerRow).promoCode && <span className="mp-promo-tag" data-testid="mp-promo-tag">{(p as PlayerRow).promoCode}</span>}</span>
                              <span className="mp-pphone" data-testid="mp-pphone">{p.phone ?? (p.fake ? "fake — no phone" : "no phone on file")}</span>
                            </span>
                            <span className="mp-pacts">
                              {collision && <span className="mp-clashtag" data-testid="mp-collision">SAME SPOT</span>}
                              {removed ? <span className="mp-pendtag rm" data-testid="mp-pending-remove">REMOVING</span>
                               : moved && <span className="mp-pendtag" data-testid="mp-pending-move">MOVING</span>}
                              {/* ONE move control at ANY team count. Four teams used to mean three
                                  destination buttons plus a x on every row, which is what crushed
                                  the names to "L", "T", "G". */}
                              <button type="button" data-testid={`mp-move-${p.umId}`} className="mp-mini" disabled={removed}
                                aria-expanded={movePick?.umId === p.umId} title={`Move ${p.name}`}
                                onClick={() => setMovePick((m) => (m?.umId === p.umId ? null : { umId: p.umId, team: null }))}>Move</button>
                              <button type="button" data-testid={`mp-remove-${p.umId}`} className={"mp-mini" + (removed ? "" : " danger")}
                                title={removed ? `Keep ${p.name}` : `Remove ${p.name}`} onClick={() => toggleRemove(p)}>{removed ? "Undo" : "\u2715"}</button>
                            </span>
                            {movePick?.umId === p.umId && (
                              // TWO STEPS, the same shape as the check-in screen: which team, then
                              // that team's spots. An open spot and a swap are the same gesture.
                              <div className="mp-movepick" data-testid="mp-movepick" data-step={movePick.team == null ? "team" : "spot"}>
                                {movePick.team == null ? (
                                  <>
                                    <span className="mp-picklb">Move to which team?</span>
                                    <span className="mp-pickrow">
                                      {roster.teams.filter((o) => o.teamNumber <= rosterTeamCount).map((o) => (
                                        <button key={o.id} type="button" data-testid={`mp-movepick-team-${o.teamNumber}`} className="mp-mini"
                                          onClick={() => setMovePick({ umId: p.umId, team: o.teamNumber })}>{o.teamNumber} · {o.name}</button>
                                      ))}
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <span className="mp-picklb">Which spot on team {movePick.team}? <em>an occupied spot swaps the two</em></span>
                                    <span className="mp-pickrow">
                                      {spotsOfTeam(origin, pending, movePick.team, roster.shape?.perTeam || 0).map((sp) => (
                                        <button key={sp.n} type="button" data-testid={`mp-movepick-spot-${sp.n}`} className={"mp-spotbtn" + (sp.who ? " taken" : "")}
                                          data-occupied={sp.who ? "true" : "false"}
                                          title={sp.who ? `Swap with ${sp.who.name}` : `Open spot ${sp.n}`}
                                          onClick={() => stageMove(p as EditRow, movePick.team!, sp.n)}>
                                          <b>{sp.n}</b>{sp.who && <i>{sp.who.name}</i>}
                                        </button>
                                      ))}
                                    </span>
                                    <button type="button" className="mp-x" data-testid="mp-movepick-back" onClick={() => setMovePick({ umId: p.umId, team: null })}>back</button>
                                  </>
                                )}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </>}
            </div>
          </Section>

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
                <label className="mp-f"><span className="mp-lb">TYPE <em>cancel</em></span>
                  <input data-testid="mp-cancel-name" value={cancelTyped} placeholder={CANCEL_WORD} onChange={(e) => setCancelTyped(e.target.value)} /></label>
                <div className="mp-cancel-acts">
                  <button type="button" className="mp-btn" data-testid="mp-cancel-abort" onClick={() => { setCancelOpen(false); setCancelTyped(""); }}>Keep the match</button>
                  <button type="button" className="mp-cancelbtn" data-testid="mp-cancel-do" disabled={cancelBusy || cancelTyped.trim() !== CANCEL_WORD} onClick={() => void doCancel()}>{cancelBusy ? "Cancelling…" : "Cancel the match"}</button>
                </div>
              </div>
            ) : null}
            {cancelResult && <div className="mp-note info" data-testid="mp-cancel-result" style={{ marginTop: 10 }}>{cancelResult}</div>}
          </div>
        </div>

        <div className="mp-foot">
          {toast && <span className="mp-note info" data-testid="mp-toast">{toast}</span>}
          {/* PER WRITE, NOT PER SAVE. A batch that stops half-way has no single verdict: some of it
              landed and is not coming back, and the rest never left. One line each. */}
          {writeResults.length > 0 && (
            <ul className="mp-wres" data-testid="mp-write-results">
              {writeResults.map((r, i) => (
                <li key={i} data-testid="mp-write-result" data-verdict={r.verdict}>
                  <span className="v">{r.verdict}</span>
                  <span>{r.label}{r.detail ? ` — ${r.detail}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mp-diffbox">
            <button type="button" className="mp-diffhd" data-testid="mp-diffhd" aria-expanded={diffOpen} disabled={unsaved === 0} onClick={() => setDiffOpen((o) => !o)}>
              <span className="mp-caret">{unsaved ? (diffOpen ? "▾" : "▸") : "·"}</span>
              <span data-testid="mp-diffcount">{unsaved ? `${unsaved} change${unsaved === 1 ? "" : "s"} will be sent` : "No changes"}</span>
            </button>
            {unsaved > 0 && diffOpen && (
              <ul className="mp-difflist" data-testid="mp-diff">
                {changed.map((k) => (
                  <li key={k} data-testid="mp-diff-item" data-key={k}>
                    <span className="mp-k">{LABELS[k] ?? k}</span>{" "}
                    <span className="mp-to">{shownVal(k, cur[k], managers)}</span>
                  </li>
                ))}
                {/* the roster writes, IN THE ORDER THEY WILL BE SENT — team count first */}
                {savePlan(pending, origin).map((w, i) => (
                  <li key={`w${i}`} data-testid="mp-diff-item" data-key={`roster:${w.kind}`}>
                    <span className="mp-k">{i + 1}.</span>{" "}
                    <span className="mp-to">{w.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mp-btns">
            <span className="mp-sp" />
            {/* REVERT SENDS NOTHING. It discards intentions; it cannot take back a write, because
                taking one back would BE another write. The label says so. */}
            <button type="button" className="mp-btn" data-testid="mp-revert" disabled={unsaved === 0} onClick={doRevert}
              title="Discards every unsaved change on this panel. Sends no request — it cannot undo anything already saved.">Revert <em className="mp-btnsub">discards, sends nothing</em></button>
            <button type="button" className="mp-btn mp-pri" data-testid="mp-save" disabled={unsaved === 0 || saving} onClick={() => void doSave()}>
              {saving ? "Saving…" : unsaved ? `Save · ${unsaved} change${unsaved === 1 ? "" : "s"}` : "Save"}</button>
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
/* ITEM 4 — WIDER AT LARGE VIEWPORTS. 620px was set when a team column held a name and nothing
   else; a name PLUS a phone number needs the room, and at four teams there are two columns of
   them. The phone breakpoint below still collapses the grid to one column. */
.mp-panel{max-width:620px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.mp-head{padding:13px 16px;border-bottom:1px solid var(--line);background:#fafcfb}
.mp-name{font-size:18px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-meta{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:6px;font-size:11.5px;color:var(--ink3)}
.mp-tag{display:inline-flex;border-radius:6px;padding:2px 7px;font-size:10.5px;font-weight:800;border:1px solid var(--line2);background:#eef4f1;color:var(--ink2)}
.mp-body{overflow:auto;min-height:0;padding:0 0 8px}
.mp-seg{display:inline-flex;border:1px solid #D8E2DC;border-radius:10px;overflow:hidden}
.mp-seg button{min-width:44px;min-height:40px;border:0;background:#fff;color:#41514A;font:inherit;font-weight:800;font-size:13px;cursor:pointer;border-left:1px solid #D8E2DC}
.mp-seg button:first-child{border-left:0}
.mp-seg button.on{background:#0d3b2e;color:#fff}
.mp-seg button:disabled{opacity:.55;cursor:default}
.mp-sec{border-bottom:1px solid var(--line)}
.mp-sechd{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;font:inherit;text-align:left;padding:10px 16px;cursor:pointer;min-height:44px}
.mp-sechd:hover{background:#f7fbf9}
.mp-caret{color:var(--ink3);font-size:10px;width:11px;flex:0 0 11px}
.mp-st{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--ink)}
.mp-dirty{width:7px;height:7px;border-radius:50%;background:#c98a00;flex:0 0 7px}
.mp-secbd{padding:2px 16px 12px}
.mp-note{display:block;font-size:11.5px;line-height:1.4;padding:8px 11px;border-radius:9px;margin-bottom:12px}
.mp-note.info{background:#e8f0fa;border:1px solid #a8c4e6;color:#123a6b}
.mp-note.warn{background:#fdf2e0;border:1px solid #e8c383;color:#6b4400;margin-top:10px}
.mp-note b{font-weight:800}
.mp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mp-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.mp-f{display:block;min-width:0;margin-bottom:0}
/* DENSER, now the paragraphs are gone: label, control, microlabel. The old spacing was tuned
   around blocks of prose that no longer sit between the fields, so leaving it would just be the
   gaps the paragraphs used to fill. */
.mp-f + .mp-f,.mp-grid + .mp-grid,.mp-grid + .mp-help{margin-top:9px}
.mp-lb{display:flex;align-items:baseline;gap:6px;font-size:9.5px;font-weight:800;letter-spacing:.11em;color:var(--ink3);margin-bottom:5px}
.mp-lb em{margin-left:auto;font-style:normal;font-size:9.5px;font-weight:700;color:var(--ink3);text-transform:none}
.mp input,.mp select,.mp textarea{width:100%;min-width:0;border:1px solid var(--line2);border-radius:9px;padding:9px 11px;font:inherit;font-size:13.5px;background:#fbfdfc;color:var(--ink);min-height:40px}
.mp textarea{min-height:80px;resize:vertical}
.mp input:focus,.mp select:focus,.mp textarea:focus{outline:2px solid var(--focus);outline-offset:-1px;background:#fff}
.mp input:disabled,.mp select:disabled{background:#f1f5f3;color:var(--ink3);cursor:not-allowed}
.mp .mp-chg{border-color:#c98a00;background:#fffdf7}
.mp .mp-bad{border-color:#f0a9a4;background:#fff7f6;color:var(--red)}
.mp-ro{display:block;padding:9px 11px;border:1px dashed var(--line2);border-radius:9px;background:#f4f9f6;color:var(--ink2);font-size:12.5px}
.mp-help{display:block;margin-top:3px;font-size:11.5px;color:var(--ink3)}
.mp-derived{font-size:12.5px;color:var(--ink2);margin-top:6px}
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
.mp-btnsub{font-style:normal;font-weight:600;font-size:10px;color:var(--ink3);margin-left:6px}
.mp-sp{flex:1 1 auto}
.mp-btn{border:1px solid var(--line2);background:var(--card);border-radius:9px;padding:0 14px;font:inherit;font-weight:700;cursor:pointer;color:var(--ink2);min-height:40px}
.mp-btn:disabled{opacity:.5;cursor:not-allowed}
.mp-btn.mp-pri{background:#12301f;border-color:#12301f;color:#fff}
.mp-err{padding:16px;color:var(--red);font-size:13px}
.mp-loading{padding:16px;color:var(--ink3)}
/* ── TEAMS · ROSTER · TEAM COUNT ─────────────────────────────────────────────────────────────────
   NO RED. Every rule that painted this section as a hazard is gone: the red left edge and border
   (.mp-teams), the red header band (.mp-teams-hd / .mp-teams-title), the SAVES IMMEDIATELY pill
   (.mp-immbadge) and the red banner (.mp-immbanner). They existed to warn that Save and Revert did
   not reach these controls, and that is no longer true. What is left is the neutral palette every
   other section uses, and the pink-tinted borders inside it are neutralised to the shared --line. */
.mp-optoast{margin:11px 13px 0;font-size:12px;padding:8px 11px;border-radius:8px;background:#e6f3ea;border:1px solid #a9d3ba;color:#14512f}
.mp-optoast.bad{background:#fbe7e4;border-color:#e6b0a8;color:#8a2018}
.mp-countrow{display:flex;align-items:center;gap:10px;padding:4px 0}
.mp-countbtns{display:inline-flex;border:1px solid var(--line2);border-radius:8px;overflow:hidden}
.mp-cbtn{border:0;background:#fff;font:inherit;font-weight:700;color:var(--ink2);padding:8px 14px;min-height:38px;cursor:pointer}
.mp-cbtn + .mp-cbtn{border-left:1px solid var(--line2)}
.mp-cbtn.on{background:#e7efe9;color:var(--ink)}
.mp-cbtn.pend{background:var(--grn);color:#fff}
.mp-cbtn:disabled:not(.on){opacity:.55;cursor:not-allowed}
/* the consequence, stated BEFORE the click */
.mp-conseq{list-style:none;margin:6px 0 2px;padding:0;display:flex;flex-direction:column;gap:4px}
.mp-conseq li{font-size:11.5px;line-height:1.45;color:var(--ink3);border-left:2px solid var(--line2);padding:2px 0 2px 8px}
.mp-conseq li[data-chosen="true"]{border-left-color:var(--grn);color:var(--ink2);font-weight:600}
.mp-conseq b{font-weight:800;color:var(--ink2)}
.mp-addrow{position:relative;padding:10px 0 2px}
.mp-addtop{display:flex;gap:7px;align-items:center}
.mp-addsearch{flex:1;min-width:0;border:1px solid var(--line2);border-radius:9px;padding:9px 11px;font:inherit;font-size:13.5px;background:#fff;min-height:40px}
.mp-bulk{display:inline-flex;gap:5px;align-items:center;flex:0 0 auto}
.mp-bulkin{width:48px;text-align:center;border:1px solid var(--line2);border-radius:8px;padding:7px 4px;font:inherit;font-size:13px;background:#fff;min-height:36px}
.mp-addres{position:absolute;left:0;right:0;top:52px;z-index:20;background:#fff;border:1px solid var(--line2);border-radius:9px;box-shadow:0 8px 22px rgba(10,40,26,.16);overflow:hidden}
.mp-addres button{display:block;width:100%;text-align:left;border:0;background:#fff;padding:9px 12px;font:inherit;font-size:13px;border-bottom:1px solid var(--line);cursor:pointer}
.mp-addres button:last-child{border-bottom:0}.mp-addres button:hover{background:#eef4f1}
.mp-addpending{display:inline-flex;align-items:center;gap:7px;margin-top:8px;font-size:12px;color:var(--ink2)}
.mp-x{border:0;background:none;color:var(--ink2);text-decoration:underline;cursor:pointer;font:inherit;font-size:12px;padding:2px 4px}

/* ITEM 4 — 2 x 2 at four teams, never four abreast, and columns that can actually SHRINK.
   minmax(0,1fr) is the whole fix for the overflow: a bare 1fr is minmax(AUTO,1fr), so the grid
   could not go below its content's min-content width and simply ran off the side of the panel. */
.mp-teamgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:11px 0 4px}
.mp-team{border:1px solid var(--line);border-radius:10px;background:#fff;padding:10px;min-width:0}
.mp-teamtop{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.mp-teamname{font-size:14px;font-weight:800;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-teamcap{margin-left:auto;font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums;flex:0 0 auto}
.mp-renamerow{display:flex;gap:6px;margin-bottom:8px;align-items:center}
.mp-tnameinput{flex:1;min-width:0;border:1px solid var(--line2);border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;background:#fff;min-height:36px}
.mp-tnameinput:focus{outline:2px solid var(--focus);outline-offset:-1px;background:#fff}
.mp-mini{border:1px solid var(--line2);background:#fff;border-radius:7px;padding:0 9px;font:inherit;font-size:12px;font-weight:700;color:var(--ink2);min-height:34px;min-width:34px;cursor:pointer;flex:0 0 auto}
.mp-mini:disabled{opacity:.45;cursor:not-allowed}
.mp-mini.danger{color:var(--red);border-color:#e6b7b0}.mp-mini.danger:hover:not(:disabled){background:#fbeeec}
.mp-addto{width:100%;border:1px dashed #7fb894;background:#eef8f1;color:#14512f;border-radius:8px;padding:8px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;margin-bottom:8px}
.mp-players{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.mp-empty{font-size:12px;color:var(--ink3);padding:4px 2px}

/* ITEM 3 — TWO LINES per row: name, then the phone beneath it. flex-wrap lets the move picker
   occupy a full row of its own beneath the controls rather than squeezing in beside them. */
.mp-player{display:flex;align-items:center;gap:7px;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:6px 7px;background:#fbfdfc;min-height:44px}
.mp-player.pend-move{border-color:#8fbf9f;background:#f2fbf5}
.mp-player.pend-remove{border-color:#e6b7b0;background:#fdf4f3}
.mp-player.pend-remove .mp-pident{text-decoration:line-through;opacity:.65}
.mp-player.clash{border-color:#d9a441;background:#fdf8ee}
.mp-pnum{width:20px;height:20px;flex:0 0 20px;border-radius:5px;background:#eef3f0;color:#3a5348;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.mp-pident{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.mp-pname{font-size:13px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-pphone{font-size:11px;line-height:1.25;color:var(--ink3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-fake-tag{font-size:9px;font-weight:800;background:#f2e31d;color:#231f00;border-radius:4px;padding:1px 4px;margin-left:6px;vertical-align:middle}
/* the promo chip carries the CODE NAME and sits at the same weight as the spot number */
.mp-promo-tag{font-size:9px;font-weight:800;letter-spacing:.03em;background:#e7eefb;color:#1c3f7a;border:1px solid #c3d5f0;border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:middle;white-space:nowrap}
.mp-pacts{display:inline-flex;gap:4px;flex:0 0 auto;align-items:center}
.mp-pendtag{font-size:9px;font-weight:800;letter-spacing:.06em;background:#e7f3ea;color:#14512f;border:1px solid #a9d3ba;border-radius:4px;padding:2px 5px}
.mp-pendtag.rm{background:#fbeeec;color:#8a2018;border-color:#e6b7b0}
.mp-clashtag{font-size:9px;font-weight:800;letter-spacing:.06em;background:#fbf0d8;color:#6b4a09;border:1px solid #dcbc71;border-radius:4px;padding:2px 5px}

/* the two-step move picker — same shape as the check-in screen */
.mp-movepick{flex:1 0 100%;margin-top:6px;padding:8px;border:1px solid var(--line2);border-radius:8px;background:#f7faf8}
.mp-picklb{display:block;font-size:11px;font-weight:800;letter-spacing:.05em;color:var(--ink2);margin-bottom:6px}
.mp-picklb em{font-style:normal;font-weight:600;letter-spacing:0;color:var(--ink3);text-transform:none}
.mp-pickrow{display:flex;flex-wrap:wrap;gap:5px}
.mp-spotbtn{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;border:1px solid var(--line2);background:#fff;border-radius:7px;min-height:38px;min-width:38px;padding:3px 7px;font:inherit;cursor:pointer;max-width:96px}
.mp-spotbtn b{font-size:12px;font-weight:800;color:var(--ink)}
.mp-spotbtn i{font-style:normal;font-size:9.5px;color:var(--ink3);max-width:84px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-spotbtn.taken{background:#eef4f1;border-color:#bcd0c6}
/* per-write outcomes — one line per write, because a batch that stops half-way cannot be
   summarised by a single verdict */
.mp-wres{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-direction:column;gap:3px}
.mp-wres li{display:flex;gap:8px;align-items:baseline;font-size:11.5px;padding:5px 8px;border-radius:7px;background:#f4f7f5;border:1px solid var(--line)}
.mp-wres li[data-verdict="LANDED"]{background:#eef7f1;border-color:#a9d3ba}
.mp-wres li[data-verdict="FAILED"],.mp-wres li[data-verdict="NOT APPLIED"]{background:#fbeeec;border-color:#e6b7b0}
.mp-wres li[data-verdict="UNKNOWN"]{background:#fdf8ee;border-color:#dcbc71}
.mp-wres .v{font-weight:800;letter-spacing:.04em;flex:0 0 auto;font-size:10px}
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
@media (min-width:1100px){.mp-panel{max-width:860px}}
@media (max-width:560px){.mp-grid,.mp-grid3{grid-template-columns:1fr}.mp-teamgrid{grid-template-columns:1fr}}
`;
