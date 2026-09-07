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
// THE PANEL CHECKS WHAT THE ROUTE ENFORCES. It used to check NOTHING — Save was disabled only on
// `unsaved === 0 || saving` — so someone holding EDIT MATCHES but not admin could edit 24 fields,
// press Save, and be told "Admin access required": a permission the grant screen never offered,
// contradicting the ticked EDIT MATCHES box. The rule is matchEditAccess(), the single definition
// this and the route are pinned to.
//
// The diff panel and the request body are BOTH built from matchEditModel's diffKeys()+pick() — the
// one shared engine, so they can never disagree about what is sent (that is the whole point of the
// model; never re-implement it).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCancelMatch, cancelStakes } from "@/lib/useCancelMatch";
import MoneyInput from "@/components/MoneyInput";
import { useAuth } from "@/lib/useAuth";
import { matchEditAccess } from "@/lib/matchEditAccess";
import { supabase } from "@/lib/supabase";
import { diffKeys, pick, MONEY_KEYS, TOGGLE_KEYS, NULLABLE_NUM } from "@/lib/matchEditModel";
import { centsToDollars, dollarsToCents } from "@/lib/matchMoney";
import {
  parseWall, buildWall, movePair, moveEnd, durationLabel, whenError, wallInputsReady,
} from "@/lib/matchWhen";
import {
  pickerOptions, offeredCounts, confirmLines, normalizeManagerId, managerNameIn,
  CAN_UNASSIGN_MANAGER_FROM_MATCH, UNASSIGN_PROOF,
} from "@/lib/managerAssign";
import {
  emptyPending, normalizePending, pendingCount, sortedTeam, spotsOfTeam, planMove, effectiveRow,
  savePlan, clearApplied, teamCountWrites, teamShapeError,
  playerKinds, teamMemberCount, textsForSelection, moneyKinds, teamMoney, sumMoney, rosterCounts,
  boardSlots, boardTeamFill, dropHint, gestureFor, usd, usdPlain,
  type Pending, type RosterOrigin, type EditRow, type PlannedWrite, type PlayerKind,
} from "@/lib/rosterEditModel";
import { TEMPLATE_LABELS, buildTemplateBody, smsSegments, unfilledTokens } from "@/lib/matchNotify";

// Only these two `type` values are exposed. The known enum also has BRACKET and GROUP and the full
// set is UNKNOWN (no spec in repo). A match whose current type is NOT one of these renders as
// READ-ONLY TEXT — never a two-option dropdown that would silently rewrite a BRACKET on first touch.
const EXPOSED_TYPES: Record<string, string> = { REGULAR: "Regular", EVENT: "Special event" };
const MARKS = [36, 24, 12, 6, 3] as const;
// EXACT, lowercase, trimmed. "Cancel" and " cancel " with inner spaces are refused — trimmed means
// the surrounding whitespace only, not a fuzzy match.
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
type PlayerRow = { umId: number; playerId: number; team: number; playerNumber: number | null; name: string; phone: string | null; fake: boolean; promoCode?: string | null; email?: string | null; member?: boolean; paid?: number; charged?: number; credit?: number; paidStatus?: string | null };
type RosterState = { name: string; teams: TeamRow[]; players: PlayerRow[]; shape: { teamN: number; perTeam: number }; maxPlayerCount: number | null; occupancy: number | null; hidden?: { total: number; cancelled: number; unpaid: number; refunded: number }; promo?: { spots: number; codes: string[] }; membershipError?: string | null };
type MatchData = Record<string, unknown> & {
  type?: string; startDate?: string; endDate?: string; teams?: unknown[];
  occupancy?: number | null; realOccupancy?: number | null; cityName?: string | null; fieldTitle?: string | null;
  manager?: { firstName?: string; lastName?: string } | null;
};

// ── wall-clock date helpers. The Z is a LABEL, not UTC — read the components with getUTC* (which
// pull the labelled wall time back), do arithmetic in wall minutes, rebuild the string verbatim.
// NEVER new Date(str) and read local getters — that re-reads the Z as UTC and lands hours off.
const p2 = (n: number) => String(n).padStart(2, "0");
function clock12(time: string): string { const [h, m] = time.split(":").map(Number); const hr = h % 12 === 0 ? 12 : h % 12; return `${hr}:${p2(m)} ${h < 12 ? "AM" : "PM"}`; }
function prettyDate(date: string): string { const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; const [y, mo, d] = date.split("-").map(Number); return `${MON[mo - 1]} ${d}, ${y}`; }

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  return t ? { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } : null;
}

export default function MatchPanel({ matchId, env = "production", onDirtyChange }: { matchId: string; env?: "production" | "staging"; onDirtyChange?: (dirty: boolean) => void }) {
  // THE SAME RULE THE ROUTE ENFORCES. Not a guess and not a second copy — matchEditAccess() is
  // pinned to adminGate + deriveMatchOpsFlags by an equivalence assertion in matchops-auth-test.
  const { appUser } = useAuth();
  const access = matchEditAccess(appUser);
  const mayWrite = access.ok;
  const [orig, setOrig] = useState<MatchData | null>(null);
  const [cur, setCur] = useState<Record<string, unknown>>({});
  const [when, setWhen] = useState<{ date: string; time: string; endDate: string; endTime: string }>(
    { date: "", time: "", endDate: "", endTime: "" });
  const [managers, setManagers] = useState<Manager[]>([]);
  /* THE ESCAPE, AND IT IS OFF BY DEFAULT. `managers` is this match's CITY roster — 28 of the 87 for
   * a typical Austin fixture. `managersAll` is every match manager, revealed by a visible control,
   * with the people it adds LABELLED as off-city rather than mixed in unmarked. A manager covering
   * a one-off outside their listed cities is real; silently hiding them turns a real assignment
   * into an impossible one. */
  const [managersAll, setManagersAll] = useState<Manager[]>([]);
  /* THE CONFIRMATION THIS WRITE NEEDS. Manager Pay pays per match on this attachment, so the wrong
   * person here is a wrong PAYMENT. Save does not commit a manager change until this names the
   * person, the match and the amount and is confirmed. */
  const [mgrConfirm, setMgrConfirm] = useState<{ lines: string[]; keys: string[] } | null>(null);
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
  // Those were not in the brief's list of four. They say so on themselves, in the section's own
  // voice rather than a red banner. See the report — this is the one place the section does not
  // behave like the others, and it is flagged rather than hidden.
  //
  // CORRECTED 2026-09-02: this comment used to say bulk-fake "sets a TOTAL rather than describing
  // a delta". IT IS A DELTA. Measured on staging match 2470 (capacity 10): six fakes on the roster
  // and totalFakes:2 produced EIGHT, not two. The parameter name is a misnomer. See
  // src/lib/fakeRosterPlan.ts for the full probe.
  const [roster, setRoster] = useState<RosterState | null>(null);
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState<Record<number, string>>({}); // teamId → typed name (the pending rename)
  const [opBusy, setOpBusy] = useState<string | null>(null);
  const [opToast, setOpToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [immediateOps, setImmediateOps] = useState<string[]>([]); // adds that fired this session — drives Revert's warning
  const [pending, setPending] = useState<Pending>(emptyPending());
  const [movePick, setMovePick] = useState<{ umId: number; team: number | null } | null>(null);
  /* WHO IS PICKED FOR A TEXT. umIds, because a row is what an operator clicks — the phone dedupe
   * and the user-id narrowing both happen downstream, and the count on screen is phones. */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [composer, setComposer] = useState(false);
  const [tplId, setTplId] = useState<"field_change" | "time_change" | "weather_policy" | "free_form">("free_form");
  const [smsBody, setSmsBody] = useState("");
  const [smsConfirm, setSmsConfirm] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsMsg, setSmsMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
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
      setManagersAll(j.managersAllCities ?? []);
      setFields(j.fields ?? []);
      const w = m.startDate ? parseWall(m.startDate) : { date: "", time: "" };
      const we = m.endDate ? parseWall(m.endDate) : { date: "", time: "" };
      setWhen({ date: w.date, time: w.time, endDate: we.date, endTime: we.time });
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
  /* BULK FAKES — kind:"bulk-fake" → POST /batch/fake-players {totalFakes}.
   *
   * IT ADDS, IT DOES NOT SET, whatever the parameter is called. CORRECTED 2026-09-02 by probe on
   * staging match 2470 (capacity 10):
   *     6 fakes + totalFakes:6  -> 403 NO_SPOTS_LEFT      (a SET would be a no-op)
   *     6 fakes + totalFakes:2  -> 8 fakes                (a lower "total" ADDED two)
   *     8 fakes + totalFakes:0  -> 403 INVALID_TOTAL_FAKES
   * The button says "Add fakes" and the toast says "added" because that is what it does. There is
   * NO endpoint that lowers a fake count; reducing is one DELETE per user-match row. */
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

  /* MEMBER · DAILY · GUEST, derived from the roster in front of us. Recomputed whenever it
   * changes, never stored on a person. */
  const kinds = useMemo(() => playerKinds(origin.rows), [origin.rows]);
  /* THE MONEY. Each figure is a sum of one real column and nothing is derived from another — see
   * moneyKinds() for why every row's own amount is safe to add up even when one person holds
   * several spots. */
  const money = useMemo(() => moneyKinds(origin.rows), [origin.rows]);
  const matchMoney = useMemo(() => sumMoney(origin.rows), [origin.rows]);
  const counts = useMemo(() => rosterCounts(origin.rows), [origin.rows]);

  /* ── REARRANGE ────────────────────────────────────────────────────────────────────────────────
   * A separate full-window mode, not a second life for the roster row. That row already carries a
   * checkbox, a spot, a name, a phone, a badge, money and three controls; it cannot also be a drag
   * card, and four teams of nine need four columns of ~350px, which the drawer does not have.
   *
   * IT SHARES THIS COMPONENT'S PLAN. `pending` is the same object the Move button stages into, so
   * opening the board, dropping, closing it and saving from the panel is one plan throughout — and
   * so is the reverse. Nothing here writes; Save does, in savePlan's order, as it always did. */
  const [rearrange, setRearrange] = useState(false);
  /* WHAT YOU DID, beside what Save sends. A swap is one gesture and two writes; showing only the
   * writes made a pair of swaps read as a rotation nobody performed. Each entry carries the WHOLE
   * pending state from before it, because Step back must put both halves of a swap back at once. */
  const [gestures, setGestures] = useState<{ text: string; writes: number; before: Pending }[]>([]);
  const [boardPick, setBoardPick] = useState<{ umId: number; team: number | null } | null>(null);
  const [dragUm, setDragUm] = useState<number | null>(null);
  const [over, setOver] = useState<{ team: number; spot: number } | null>(null);
  const dragRef = useRef<{ umId: number; dx: number; dy: number } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const perTeam = roster?.shape?.perTeam || 0;
  const slots = useMemo(() => boardSlots(origin, pending, perTeam), [origin, pending, perTeam]);
  const fill = useMemo(() => boardTeamFill(origin, pending), [origin, pending]);
  const uneven = useMemo(() => new Set(fill.values()).size > 1, [fill]);
  const rowByUm = useMemo(() => new Map(origin.rows.map((r) => [r.umId, r])), [origin.rows]);
  /* WHO IS HOLDING MORE THAN ONE SPOT ON THIS MATCH — the blue tick. Same derivation as the
   * panel's guest badge, from the repeated player id, never stored on a person. */
  const multi = useMemo(() => {
    const seen = new Map<number, number>();
    for (const r of origin.rows) seen.set(r.playerId, (seen.get(r.playerId) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
  }, [origin.rows]);

  /* ONE PLACE WHERE A DROP HAPPENS, so the gesture list and the plan can never disagree about what
   * was done. planMove is the panel's own — an occupied spot swaps, an empty one does not. */
  const dropOn = (mover: EditRow, toTeam: number, toSpot: number) => {
    const eff = effectiveRow(mover, pending, origin);
    if (eff.team === toTeam && eff.playerNumber === toSpot) return;
    const g = gestureFor(origin, pending, mover, toTeam, toSpot);
    const before = pending;
    const next = planMove(pending, origin, mover, toTeam, toSpot);
    setPending(next);
    /* A SEQUENCE THAT PUTS EVERYONE HOME LEAVES NOTHING PENDING. Swap two players and swap them
     * back and the honest count is zero, not two — so the gesture list empties with the plan. */
    setGestures((prev) => (pendingCount(next, origin) === 0 ? [] : [...prev, { ...g, before }]));
    setBoardPick(null);
  };
  /* STEP BACK, NOT UNDO-ANY. Swaps chain, so undoing a middle one would put somebody where a later
   * swap has already moved someone else. Only the most recent gesture comes off, both halves at
   * once, by restoring the plan exactly as it was before it. */
  const stepBack = () => {
    setGestures((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      setPending(last.before);
      return pendingCount(last.before, origin) === 0 ? [] : prev.slice(0, -1);
    });
  };

  const onGrab = (e: React.PointerEvent<HTMLDivElement>, umId: number) => {
    /* A PRESS ON A CONTROL IS NOT A DRAG. Move sits inside the card, so without this the card is
     * picked up and the button never fires. */
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    dragRef.current = { umId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    setDragUm(umId);
    if (ghostRef.current) {
      ghostRef.current.style.width = `${r.width}px`;
      ghostRef.current.style.transform = `translate(${r.left}px, ${r.top}px)`;
    }
    el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current; if (!d) return;
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${e.clientX - d.dx}px, ${e.clientY - d.dy}px)`;
    /* elementFromPoint, with the ghost pointer-events:none so it never finds itself. */
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const slot = el?.closest<HTMLElement>("[data-slot-team]");
    const next = slot ? { team: Number(slot.dataset.slotTeam), spot: Number(slot.dataset.slotSpot) } : null;
    setOver((cur) => (cur?.team === next?.team && cur?.spot === next?.spot ? cur : next));
  };
  const onDrop = () => {
    const d = dragRef.current; dragRef.current = null;
    const target = over;
    setDragUm(null); setOver(null);
    if (!d || !target) return;
    const mover = rowByUm.get(d.umId);
    if (mover) dropOn(mover, target.team, target.spot);
  };

  /* THE TEMPLATE'S MATCH FACTS. startDate is WALL CLOCK carrying a Z it does not mean, so it is
   * split with parseWall and printed as text — never re-parsed with a Date, which would shift a
   * 7pm match into the next day and put the wrong date in a text to real players. */
  const mergeValues = useMemo(() => {
    const w = orig?.startDate ? parseWall(String(orig.startDate)) : { date: "", time: "" };
    const [y, mo, d] = (w.date || "").split("-").map(Number);
    const dateLabel = y ? new Date(Date.UTC(y, (mo ?? 1) - 1, d ?? 1)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
    const [hh, mm] = (w.time || "").split(":").map(Number);
    const timeLabel = Number.isFinite(hh) ? `${((hh + 11) % 12) + 1}:${String(mm ?? 0).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}` : "";
    return { date: dateLabel, time: timeLabel, field: String(orig?.fieldTitle ?? roster?.name ?? "the field") };
  }, [orig?.startDate, orig?.fieldTitle, roster?.name]);
  /* HOW MANY TEXTS, NOT HOW MANY ROWS. One person holding two spots is one text, and the number on
   * the button is this one — always. */
  const tally = useMemo(() => textsForSelection(origin.rows, picked), [origin.rows, picked]);
  const pickedRows = useMemo(() => origin.rows.filter((r) => picked.has(r.umId)), [origin.rows, picked]);
  const togglePick = (umId: number) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(umId)) next.delete(umId); else next.add(umId);
    return next;
  });
  const clearPicks = () => { setPicked(new Set()); setComposer(false); setSmsConfirm(false); };

  const copyEmail = async (p: PlayerRow) => {
    if (!p.email) return;
    try { await navigator.clipboard.writeText(p.email); setCopied(p.umId); setTimeout(() => setCopied((c) => (c === p.umId ? null : c)), 1400); }
    catch { setSmsMsg({ text: `Could not reach the clipboard. The address is ${p.email}`, bad: true }); }
  };

  /* THE SEND. One attempt. `picked` is turned into player ids server-side by the notify route,
   * which narrows its own recipient list — the client never sends a phone number, and a list that
   * names somebody who is not on this match can only make the send smaller. */
  const sendText = async () => {
    if (smsBusy || !smsBody.trim() || tally.texts === 0) return;
    const h = await authHeaders(); if (!h) { setSmsMsg({ text: "No active session — sign in again.", bad: true }); return; }
    setSmsBusy(true); setSmsMsg(null);
    try {
      const userIds = [...new Set(pickedRows.filter((r) => !r.fake).map((r) => r.playerId))];
      const res = await fetch(`/api/match-chats/${matchId}/notify`, {
        method: "POST", headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ template_used: tplId, message_body: smsBody, user_ids: userIds }),
      });
      const j = await res.json();
      if (!res.ok) { setSmsMsg({ text: j.error ?? `HTTP ${res.status}`, bad: true }); return; }
      setSmsMsg({
        text: `Sent to ${j.success_count} of ${j.recipient_count} phone${j.recipient_count === 1 ? "" : "s"}`
          + (j.failure_count ? `, ${j.failure_count} failed.` : ".")
          + (j.ignored_user_ids?.length ? ` ${j.ignored_user_ids.length} id(s) were not on this match and were ignored.` : ""),
        bad: j.failure_count > 0,
      });
      setComposer(false); setSmsConfirm(false); setSmsBody(""); setPicked(new Set());
    } catch (e) {
      setSmsMsg({ text: `UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Check the log before sending again.`, bad: true });
    } finally { setSmsBusy(false); }
  };

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
  /* SWITCHING MODE CARRIES THE CAPACITY WITH IT. This used to stage the team count ALONE, so the
   * only thing on the wire was PUT {teamNumbers: 4} and the match landed in 4-team mode reading a
   * maxTeamSize4Team nobody had set for it. Production match 18125 did exactly that on 2026-08-28
   * with 28 players on it, and the player app divided a stale 4-team total by 4 to show a
   * FRACTIONAL team size.
   *
   * The per-team figure is the one on screen — SPOTS PER TEAM — so switching 2 -> 4 at 9 a side
   * writes 36, and teamCountWrites puts it in maxPlayerCount AND in the target mode's rung. The
   * totals are TOTALS: 36, never 9. */
  const stageTeamCount = (target: number) => {
    const per = teamCount > 0 && capacity % teamCount === 0 ? capacity / teamCount : null;
    setPending((p) => normalizePending({ ...p, teamCount: target }, origin));
    // A match whose stored capacity does not divide evenly has no honest per-team figure to carry,
    // so the capacity is left exactly as stored rather than reshaped behind the operator.
    if (per == null) return;
    const writes = teamCountWrites(target, per);
    setCur((c) => ({ ...c, ...writes }));
  };
  const stageRename = (teamId: number, value: string) => {
    setTeamDraft((d) => ({ ...d, [teamId]: value }));
    setPending((p) => normalizePending({ ...p, names: { ...p.names, [teamId]: value } }, origin));
  };

  /* THE SHARED HOOK, NOT A SECOND COPY. This panel carried its own openCancel/doCancel — the
   * same GET-preview, one-POST, verdict-from-the-re-read flow, written twice. useCancelMatch's
   * own header already claimed both surfaces called it; only the Master Schedule editor did. A
   * write that texts every signed-up player and credits every account is the worst possible place
   * for two implementations to drift, so there is now one.
   *
   * NO TYPE-TO-CONFIRM on either. Two buttons, and the friction is the consequence sentence. */
  /* CONVERT TO 4 TEAMS. Two calls: GET the plan for the confirmation (writes nothing), then POST.
   * The confirmation shows REAL FIGURES computed at click time — spots before and after and how
   * many players get dealt — because a control that changes a match's capacity should not be
   * asking anyone to trust a number that was rendered when the drawer opened. */
  const [cv, setCv] = useState<{ summary: string; spotsBefore: number; spotsAfter: number; playerCount: number;
    moveCount: number; keptCount: number; refusal: string | null; shapeError: string | null } | null>(null);
  const [cvBusy, setCvBusy] = useState(false);
  const [cvResults, setCvResults] = useState<{ kind: string; label: string; verdict: string; detail?: string }[] | null>(null);
  const [cvMsg, setCvMsg] = useState<{ text: string; bad: boolean } | null>(null);

  const openConvert = async () => {
    if (cvBusy) return;
    const h = await authHeaders(); if (!h) { setCvMsg({ text: "No active session — sign in again.", bad: true }); return; }
    setCvBusy(true); setCvMsg(null); setCvResults(null);
    try {
      const r = await fetch(`/api/matchday/${env}/matches/${matchId}/convert-4`, { headers: h, cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setCvMsg({ text: j.error ?? `HTTP ${r.status}`, bad: true }); return; }
      setCv(j);
    } catch (e) { setCvMsg({ text: `UNKNOWN — ${e instanceof Error ? e.message : String(e)}.`, bad: true }); }
    finally { setCvBusy(false); }
  };

  const runConvert = async () => {
    /* NO RETRY. busy is set before the request and the confirmation closes on completion; a second
     * press would re-deal players someone may have moved in between. */
    if (!cv || cvBusy) return;
    const h = await authHeaders(); if (!h) { setCvMsg({ text: "No active session — sign in again.", bad: true }); return; }
    setCvBusy(true); setCvMsg(null);
    try {
      const r = await fetch(`/api/matchday/${env}/matches/${matchId}/convert-4`, {
        method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const j = await r.json();
      setCv(null);
      setCvResults(j.results ?? null);
      /* THE MIRROR IS PART OF THE OUTCOME, same rule as a field edit. A conversion that landed in
       * MatchDay but did not reach the mirror leaves every Clubhouse screen showing the old spot
       * count, and until 2026-09-01 said nothing about it. */
      const cvMirrorWarn = j.ok && j.mirrored === false
        && j.mirrorReason !== "not production" && j.mirrorReason !== "no mirrored fields";
      setCvMsg({
        text: (j.message ?? j.error ?? `HTTP ${r.status}`)
          + (cvMirrorWarn ? ` — BUT THE CLUBHOUSE COPY STILL SHOWS THE OLD SPOT COUNT (${j.mirrorReason ?? "unknown"}). Run the matches sync on /data.` : ""),
        bad: !j.ok || cvMirrorWarn,
      });
      await load(); await loadRoster();
    } catch (e) {
      setCvMsg({ text: `UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Reload before acting.`, bad: true });
    } finally { setCvBusy(false); }
  };

  /* REDUCE TO 2 TEAMS. The same two-call shape as convert-4 — GET the plan, then POST — because the
   * numbers on the confirmation must be computed at click time, and because this operation's
   * refusal (a match with more real players than 22 spots) can only be answered by the roster.
   *
   * IT IS NOT THE SAME OPERATION MIRRORED. The write order is reversed and the state is kept
   * separately, so a future edit to one cannot quietly change the other. */
  type ReducePlanView = {
    consequence: string | null; refusal: string | null; capacityRefusal: string | null; capacityWhy: string[];
    shapeError: string | null; steps: { label: string; detail: string }[]; fillLine: string;
    perTeam: number; total: number; realCount: number; fakeCount: number;
    moveCount: number; removeCount: number; writeCount: number; shortfall: number;
  };
  const [rd, setRd] = useState<ReducePlanView | null>(null);
  const [rdBusy, setRdBusy] = useState(false);
  const [rdResults, setRdResults] = useState<{ kind: string; label: string; verdict: string; detail?: string }[] | null>(null);
  const [rdMsg, setRdMsg] = useState<{ text: string; bad: boolean } | null>(null);

  const openReduce = async () => {
    if (rdBusy) return;
    const h = await authHeaders(); if (!h) { setRdMsg({ text: "No active session — sign in again.", bad: true }); return; }
    setRdBusy(true); setRdMsg(null); setRdResults(null);
    try {
      const r = await fetch(`/api/matchday/${env}/matches/${matchId}/reduce-2`, { headers: h, cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setRdMsg({ text: j.error ?? `HTTP ${r.status}`, bad: true }); return; }
      setRd(j);
    } catch (e) { setRdMsg({ text: `UNKNOWN — ${e instanceof Error ? e.message : String(e)}.`, bad: true }); }
    finally { setRdBusy(false); }
  };

  const runReduce = async () => {
    /* NO RETRY. busy is set before the request and the confirmation closes on completion; a second
     * press would move players someone may have moved in between. */
    if (!rd || rdBusy) return;
    const h = await authHeaders(); if (!h) { setRdMsg({ text: "No active session — sign in again.", bad: true }); return; }
    setRdBusy(true); setRdMsg(null);
    try {
      const r = await fetch(`/api/matchday/${env}/matches/${matchId}/reduce-2`, {
        method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const j = await r.json();
      setRd(null);
      setRdResults(j.results ?? null);
      const mirrorWarn = j.ok && j.mirrored === false
        && j.mirrorReason !== "not production" && j.mirrorReason !== "no mirrored fields";
      setRdMsg({
        text: (j.message ?? j.error ?? `HTTP ${r.status}`)
          + (mirrorWarn ? ` — BUT THE CLUBHOUSE COPY STILL SHOWS THE OLD SPOT COUNT (${j.mirrorReason ?? "unknown"}). Run the matches sync on /data.` : ""),
        bad: !j.ok || mirrorWarn,
      });
      await load(); await loadRoster();
    } catch (e) {
      setRdMsg({ text: `UNKNOWN — ${e instanceof Error ? e.message : String(e)}. Reload before acting.`, bad: true });
    } finally { setRdBusy(false); }
  };

  const cancel = useCancelMatch({
    env, matchId, source: "Match panel · cancel", authHeaders,
    onCancelled: async (landed) => {
      if (landed) noteImmediate("cancelled the match");
      await load(); await loadRoster();
    },
  });

  /* DATE or START TIME moves the whole match and keeps its length; END TIME changes the length
   * and moves nothing else. Both refuse to write a half-empty input: a cleared <input type=date>
   * yields "", and buildWall("", "19:00") is the string "T19:00:00.000Z" — not empty, not a date,
   * and it would reach the wire looking like a value. The staged pair is the base, so editing the
   * end and THEN the date keeps the end the operator chose. */
  const applyWhen = (date: string, time: string) => {
    setWhen((w) => ({ ...w, date, time }));
    setCur((c) => {
      const curStart = String(c.startDate ?? orig?.startDate ?? "");
      const curEnd = String(c.endDate ?? orig?.endDate ?? "");
      if (!wallInputsReady(date, time)) return c;
      if (!curStart || !curEnd) return { ...c, startDate: buildWall(date, time) };
      const moved = movePair(curStart, curEnd, date, time);
      if (!moved) return c;
      setWhen((w) => ({ ...w, endDate: parseWall(moved.endDate).date, endTime: parseWall(moved.endDate).time }));
      return { ...c, startDate: moved.startDate, endDate: moved.endDate };
    });
  };

  /* END TIME. Editable at ANY time — no gate on roster, spots sold, or whether the match has
   * already happened. That is deliberate: Retool's WEB app blocks this once players have joined
   * and its MOBILE app does not, and the API sides with mobile — proven on staging 2560, a match
   * with two players attached, where a lone endDate write LANDED and left startDate alone. A
   * control that refused would be refusing something the server permits. */
  const applyEnd = (endTime: string) => {
    setWhen((w) => ({ ...w, endTime }));
    setCur((c) => {
      const curStart = String(c.startDate ?? orig?.startDate ?? "");
      const curEnd = String(c.endDate ?? orig?.endDate ?? "");
      if (!curStart || !curEnd) return c;
      const next = moveEnd(curStart, curEnd, endTime);
      if (!next) return c;
      setWhen((w) => ({ ...w, endDate: parseWall(next).date }));
      return { ...c, endDate: next };
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
  /* THE MONOTONIC LADDER CHECK IS GONE, DELIBERATELY.
   *
   * It warned whenever a rung rose as kickoff approached, on the reasoning that fakes coming back
   * off a match makes it "empty out instead of filling up". THAT IS THE INTENDED OPERATION. Near
   * kickoff you strip the fakes so a match does not look full when it should have cancelled, and
   * doing that means raising the 3h rung ABOVE the earlier ones. The warning flagged the correct
   * action as a mistake.
   *
   * It was a UI caution only and never blocked Save — the server does not enforce it, confirmed on
   * staging by writing 3H above 36H and reading the values back intact. The only remaining bounds
   * are the real ones: each rung between 0 and capacity.
   */

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
  /* THE APP CAN RENDER A FRACTIONAL TEAM SIZE. Clubhouse must never be able to produce one — so a
   * capacity that does not divide by the team count blocks the save and says why, rather than
   * being rounded into a number nobody chose. Checked against the STAGED pair, so it catches a
   * team-count change and a capacity edit alike. */
  const shapeErr = teamShapeError(capacity, rosterTeamCount);

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

  /* THE MANAGER CONFIRMATION GATE.
   *
   * Every other field on this panel is a property of the match. THIS ONE DECIDES WHO GETS PAID —
   * Manager Pay pays per match at $20/$30 on max_player_count, keyed on the attachment this write
   * sets. So a manager change does not go out on the same "Save" as a name edit: it stops here
   * first and names the person, the match and the amount. A yes/no on "Save changes?" confirms
   * that something is about to happen, not what.
   *
   * It gates the WRITE, not the edit — the diff is unchanged, the body is unchanged, and cancelling
   * sends nothing at all. */
  const MGR_KEYS = ["managerId", "secondManagerId"] as const;
  const doSave = async (confirmedMgr = false) => {
    /* THE SECOND HALF OF THE BLOCK. The button is disabled, but a disabled button is a UI fact
     * and this is a match-record write: the API will happily store an end before a start
     * (staging 2557 returned 2xx and read back inverted), so the refusal lives on the path that
     * actually sends, not only on the control that starts it. */
    if (whenError(cur.startDate as string | undefined, cur.endDate as string | undefined)) return;
    /* AND THE SHAPE, on the path rather than only on the button. A disabled button is a UI fact;
     * this write decides what the players see when they arrive at the pitch. */
    if (teamShapeError(Number(cur.maxPlayerCount) || 0, rosterTeamCount)) return;
    if (!orig || saving) return;
    if (changed.length === 0 && pendingN === 0) return;
    const mgrChanged = changed.filter((k) => (MGR_KEYS as readonly string[]).includes(k));
    if (mgrChanged.length > 0 && !confirmedMgr) {
      const lines: string[] = [];
      for (const k of mgrChanged) {
        const toId = normalizeManagerId(cur[k]);
        const fromId = normalizeManagerId(orig[k]);
        const opt = [...mgrOpts, ...mgrOpts2].find((o) => o.id === toId);
        lines.push(...confirmLines({
          matchName: orig.name == null ? null : String(orig.name),
          whenText: when.date ? `${when.date}${when.time ? ` ${when.time}` : ""}` : null,
          cityLabel: orig.cityName ?? null,
          fromName: fromId == null ? null : mgrName(fromId),
          toName: toId == null ? null : mgrName(toId),
          maxPlayerCount: Number(cur.maxPlayerCount) || null,
          // Co-managed pays $20 each. A SECOND manager on the match is what makes it co-managed,
          // and that is exactly the field that may be changing in this same save.
          coManaged: normalizeManagerId(cur.secondManagerId) != null,
          offCity: !!opt?.offCity,
        }).map((l) => (k === "secondManagerId" ? `Second manager — ${l}` : l)));
      }
      setMgrConfirm({ lines, keys: mgrChanged });
      return;
    }
    setMgrConfirm(null);
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
      /* THE MIRROR IS PART OF THE OUTCOME NOW. The MatchDay write landing and the Clubhouse row
       * being right are two different facts, and until 2026-09-01 only the first was reported —
       * an edited time landed, the mirror kept the old one, and every Clubhouse screen showed
       * stale data with nothing on screen to say so. A write-through that did not happen is said
       * out loud; `mirrorReason` is null only when it genuinely refreshed.
       *
       * "not production" and "no mirrored fields" are NOT failures and do not warn: staging has no
       * mirror row to keep, and an edit touching only unmirrored fields has nothing to go stale. */
      const mirrorWarn = j.mirrored === false
        && j.mirrorReason !== "not production" && j.mirrorReason !== "no mirrored fields";
      setToast(
        `Outcome ${j.outcome ?? "?"} — ${landed}/${sentKeys.length} field(s) LANDED (re-read confirmed).` +
        (notApplied.length ? ` NOT APPLIED: ${notApplied.map((k) => LABELS[k] ?? k).join(", ")}.` : "") +
        (mirrorWarn
          ? ` — BUT THE CLUBHOUSE COPY WAS NOT UPDATED (${j.mirrorReason ?? "unknown"}). Other screens will show the old value until the nightly sync. Run the matches sync on /data.`
          : ""),
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
    { const w = orig.startDate ? parseWall(orig.startDate) : { date: "", time: "" };
      const we = orig.endDate ? parseWall(orig.endDate) : { date: "", time: "" };
      setWhen({ date: w.date, time: w.time, endDate: we.date, endTime: we.time }); }
    setPending(emptyPending());
    setTeamDraft(Object.fromEntries((roster?.teams ?? []).map((t) => [t.id, t.name])));
    setMovePick(null);
    setWriteResults([]);
    setDiffOpen(false);
    setToast(null);
  };

  /* THESE MEMOS SIT ABOVE THE EARLY RETURNS ON PURPOSE. They were first written next to mgrName,
   * which is below `if (!orig) return <Loading/>` — so on the first render they did not run and on
   * the second they did, and React logged "a change in the order of Hooks" and rendered nothing.
   * A hook cannot live after a conditional return. */
  /* THE DERIVED READOUT, in the same style CAPACITY uses — a value, not a sentence. The
   * next-day tag is DATA too: with a time-only control, an end that rolls past midnight is
   * otherwise invisible, and "ends 17 Aug" is the difference between a 1h match and a 25h one. */
  const whenDuration = useMemo(
    () => durationLabel(cur.startDate as string | undefined, cur.endDate as string | undefined),
    [cur.startDate, cur.endDate]);
  const whenErr = useMemo(
    () => whenError(cur.startDate as string | undefined, cur.endDate as string | undefined),
    [cur.startDate, cur.endDate]);
  const whenEndsNextDay = useMemo(() => {
    if (!cur.startDate || !cur.endDate) return null;
    const a = parseWall(String(cur.startDate)).date, b = parseWall(String(cur.endDate)).date;
    return a === b ? null : `ends ${b}`;
  }, [cur.startDate, cur.endDate]);

  const mgrOffered = useMemo(() => offeredCounts(managers, managersAll), [managers, managersAll]);
  // The CURRENT manager is always an option even when they are on neither list — otherwise the
  // control shows a different person than the match actually has.
  const mgrOpts = useMemo(
    () => pickerOptions(managers, managersAll, false,
      cur.managerId == null ? null : { id: Number(cur.managerId), name: managerNameIn([...managers, ...managersAll], cur.managerId) }),
    [managers, managersAll, cur.managerId]);
  const mgrOpts2 = useMemo(
    () => pickerOptions(managers, managersAll, false,
      cur.secondManagerId == null ? null : { id: Number(cur.secondManagerId), name: managerNameIn([...managers, ...managersAll], cur.secondManagerId) }),
    [managers, managersAll, cur.secondManagerId]);

  if (loadErr) return <div className="mp"><style>{CSS}</style><div className="mp-panel" data-testid="mp-panel"><div className="mp-err" data-testid="mp-load-error">{loadErr}</div></div></div>;
  if (!orig) return <div className="mp"><style>{CSS}</style><div className="mp-panel" data-testid="mp-panel"><div className="mp-loading">Loading match…</div></div></div>;

  /* THE NAME LOOKUP SEARCHES BOTH LISTS. It used to search the city roster only, so an off-city
   * manager — and any manager who has since come off this city's roster — rendered as "id 41207"
   * in the diff and in the confirmation. A confirmation that names an id is not naming a person. */
  const mgrName = (id: unknown) => managerNameIn([...managers, ...managersAll], id);

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

        {!mayWrite && (
          <div className="mp-noedit" data-testid="mp-readonly">
            <b>Read-only</b>
            <span data-testid="mp-readonly-why">{access.ok ? "" : access.reason}</span>
          </div>
        )}
        {/* A real <fieldset disabled> — the browser makes every control inside genuinely
            unclickable, rather than a class that only looks disabled. */}
        <fieldset className="mp-fs" disabled={!mayWrite} data-testid="mp-fieldset">
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
              {/* THE PRIMARY MANAGER IS THE PAID ONE. Both selects use "none" as the detach
                  sentinel rather than "": a cleared <select> yields "", the API rejects "" with a
                  400, and normalizeManagerId is the one place that mapping lives. The value is a
                  STRING so a null managerId selects the explicit "no manager" option — it used to
                  be Number(cur.managerId ?? 0), which matches no option, so the browser displayed
                  whichever manager happened to be first and a blind Save would have attached them. */}
              <label className="mp-f"><span className="mp-lb">MANAGER <em>send the id, choose the name · {mgrOffered.city} in {orig.cityName ?? "this city"}</em></span>
                <select data-testid="mp-mgr" value={cur.managerId == null ? "none" : String(cur.managerId)} className={isDirty("managerId") ? "mp-chg" : ""}
                  onChange={(e) => setField("managerId", normalizeManagerId(e.target.value))}>
                  <option value="none">{CAN_UNASSIGN_MANAGER_FROM_MATCH ? "— no manager —" : "— no manager (unavailable) —"}</option>
                  {mgrOpts.map((m) => <option key={m.id} value={m.id}>{m.offCity ? `${m.name} · other city` : m.name}</option>)}
                </select></label>
              <label className="mp-f"><span className="mp-lb">SECOND MANAGER <em>optional</em></span>
                <select data-testid="mp-mgr2" value={cur.secondManagerId == null ? "none" : String(cur.secondManagerId)} className={isDirty("secondManagerId") ? "mp-chg" : ""}
                  onChange={(e) => setField("secondManagerId", normalizeManagerId(e.target.value))}>
                  <option value="none">— none —</option>
                  {mgrOpts2.map((m) => <option key={m.id} value={m.id}>{m.offCity ? `${m.name} · other city` : m.name}</option>)}
                </select></label>
            </div>
            {/* THE "SHOW MANAGERS FROM ALL CITIES" ESCAPE STOOD HERE AND IS GONE. It offered the
                whole roster instead of this city's, and over 90 days it produced ZERO assignments:
                every one of the 100 matches carrying an off-roster manager carried one of 8 people
                who are on NO city's roster, so this control never offered them either. It was also
                the "blank bordered box" in this section — .mp input (the text-field rule below)
                gave the checkbox width:100% and min-height:40px, blowing it to 541x40 and shoving
                its label off the panel edge. Removing it closes that gap.
                AN OFF-ROSTER MANAGER IS STILL SHOWN. pickerOptions injects the currently-attached
                person whatever the roster says (managerAssign.ts:93) and marks them "· other city";
                that is what keeps match 17467 readable, and it is asserted below. */}
          </Section>

          {/* CAMERA lived here. Removed — Master Schedule carries the Veo toggle on every
              match card (VeoMasterSchedule posts the same /api/veo/intent), so nothing is lost and
              nothing shared went with it. */}
          <Section title="WHEN" dirty={secDirty(["startDate", "endDate"])}>
            <div className="mp-grid3">
              <label className="mp-f"><span className="mp-lb">DATE</span>
                <input type="date" data-testid="mp-date" value={when.date} className={isDirty("startDate") ? "mp-chg" : ""} onChange={(e) => applyWhen(e.target.value, when.time)} /></label>
              <label className="mp-f"><span className="mp-lb">START TIME</span>
                <input type="time" data-testid="mp-start" value={when.time} className={isDirty("startDate") ? "mp-chg" : ""} onChange={(e) => applyWhen(when.date, e.target.value)} /></label>
              {/* END TIME — NEVER DISABLED. Not on players joined, not on spots sold, not on a
                  match that has already been played. See applyEnd for the evidence. */}
              <label className="mp-f"><span className="mp-lb">END TIME{whenEndsNextDay ? <em data-testid="mp-end-nextday">{whenEndsNextDay}</em> : null}</span>
                <input type="time" data-testid="mp-end" value={when.endTime} className={isDirty("endDate") ? "mp-chg" : ""} onChange={(e) => applyEnd(e.target.value)} /></label>
            </div>
            <label className="mp-f"><span className="mp-lb">DURATION <em>derived</em></span>
              <span className="mp-ro" data-testid="mp-duration">{whenDuration ?? "\u2014"}</span></label>
            {whenErr && <div className="mp-err" data-testid="mp-when-err">{whenErr}</div>}
          </Section>

          {/* MONEY */}
          <Section title="MONEY" dirty={secDirty(["registrationPrice", "additionalSpotPrice", "guestCount", "isFreeMember"])}>
            <div className="mp-grid3">
              {/* MoneyInput, shared with the Master Schedule editor: select-all on focus, verbatim
                  while typing, two decimals on blur. The cents conversion is unchanged — onCents
                  hands back exactly what the old onChange computed. */}
              <label className="mp-f"><span className="mp-lb">PRICE <em>$</em></span>
                <MoneyInput data-testid="mp-price" cents={cur.registrationPrice as number | string | null}
                  className={isDirty("registrationPrice") ? "mp-chg" : ""}
                  onCents={(v) => setField("registrationPrice", v)} /></label>
              <label className="mp-f"><span className="mp-lb">SPOT PRICE <em>$</em></span>
                <MoneyInput data-testid="mp-spot" placeholder="—" cents={cur.additionalSpotPrice as number | string | null}
                  className={isDirty("additionalSpotPrice") ? "mp-chg" : ""}
                  onCents={(v) => setField("additionalSpotPrice", v)} /></label>
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
            {shapeErr && <div className="mp-err" data-testid="mp-shape-err">{shapeErr}</div>}
          </Section>

          <Section title="SPOTS SHOWN" dirty={secDirty(MARKS.map((h) => `fakeSpotLeft${h}h`))}>
            <span className="mp-lb" style={{ marginBottom: 8 }}>MOST SPOTS SHOWN AS LEFT</span>
            <div className="mp-rel" data-testid="mp-ladder">
              {MARKS.map((h) => {
                const ceiling = Number(cur[`fakeSpotLeft${h}h`]) || 0;
                const need = fakesNeeded(ceiling);

                return (
                  <div className="mp-relcol" key={h} data-mark={h}>
                    <span className="mp-relmk">{h} H</span>
                    <input data-testid={`mp-fake${h}`} className="mp-relin" inputMode="numeric" value={ceiling}
                      aria-label={`Most spots shown as left from ${h} hours before kickoff`}
                      onChange={(e) => setField(`fakeSpotLeft${h}h`, e.target.value.trim() === "" ? "" : Number(e.target.value))} />
                    <span className="mp-relfk" data-testid={`mp-fakeneed${h}`}>{need === 0 ? "no fakes" : `${need} fake`}</span>
                  </div>
                );
              })}
            </div>
            <span className="mp-note" data-testid="mp-laddernote">
              Each figure is the most spots shown as LEFT from that point, so showing FEWER spots
              left means MORE fake spots. A later figure may be higher than an earlier one — that is
              how fake spots come off a match near kickoff, and it is intentional.
            </span>
          </Section>

          {/* AUTOMATION */}
          <Section title="AUTOMATION" dirty={secDirty(["autoCanceled", "autoCanceledMinutes", "minPlayerCount", "isAutoBump", "maxTeamSize2Team", "maxTeamSize4Team"])}>
            <Toggle id="mp-ac" on={!!cur.autoCanceled} dirty={isDirty("autoCanceled")} onToggle={(v) => setField("autoCanceled", v)}
              title="Auto-cancel" sub="Cancel automatically if the match has not filled" />
            <div className="mp-grid" style={{ marginTop: 11 }}>
              <label className="mp-f"><span className="mp-lb">AUTO-CANCEL MINUTES <em>before kickoff</em></span>
                <input data-testid="mp-acmin" inputMode="numeric" value={cur.autoCanceledMinutes == null ? "" : String(cur.autoCanceledMinutes)} disabled={!cur.autoCanceled}
                  className={isDirty("autoCanceledMinutes") ? "mp-chg" : ""} onChange={(e) => setField("autoCanceledMinutes", e.target.value.trim() === "" ? "" : Number(e.target.value))} /></label>
              {/* ── THE FIELD THE GAMEDAY BANNER STEPPER ALSO WRITES ────────────────────────────
                  Highlighted and said out loud, with the live real-player count beside it, because
                  two surfaces writing one field is exactly where a stale draft gets saved. The
                  banner discards its pending value when this editor opens; this label is the other
                  half of that contract — it tells the operator which number they are looking at.
                  BELOW THIS, IT CANCELS — and the comparison is against REAL players. Proven on
                  staging 2026-09-01: a match with 0 real and 11 fake against a minimum of 9 was
                  watched through its deadline. */}
              <label className="mp-f mp-linked" data-testid="mp-min-field">
                <span className="mp-lb">MIN PLAYERS <em>below this, it cancels</em></span>
                <input data-testid="mp-min" inputMode="numeric" value={cur.minPlayerCount == null ? "" : String(cur.minPlayerCount)} disabled={!cur.autoCanceled}
                  className={isDirty("minPlayerCount") ? "mp-chg" : ""} onChange={(e) => setField("minPlayerCount", e.target.value.trim() === "" ? "" : Number(e.target.value))} />
                <span className="mp-linknote" data-testid="mp-min-note">
                  Also set by the Gameday Ops banner stepper.{` ${realPlayers} real player${realPlayers === 1 ? "" : "s"} in right now.`}
                </span>
              </label>
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
            {/* CONVERT TO 4 TEAMS. Offered only on a 2-team match, and only when the match has
                not been played — the refusal comes from the server's own plan so the button and
                the write cannot disagree about whether it is allowed. */}
            {rosterTeamCount === 2 && (
              <div className="mp-cv" data-testid="mp-convert">
                {!cv ? (
                  <>
                    <button type="button" className="mp-btn" data-testid="mp-convert-open" disabled={cvBusy || !mayWrite}
                      onClick={() => void openConvert()}>{cvBusy ? "Reading…" : "Convert to 4 teams"}</button>
                    <span className="mp-cvsub">Opens capacity for more players. This is not auto-bump.</span>
                  </>
                ) : cv.refusal || cv.shapeError ? (
                  <div className="mp-note warn" data-testid="mp-convert-refusal">
                    {cv.refusal ?? cv.shapeError}
                    <button type="button" className="mp-btn" style={{ marginLeft: 10 }} onClick={() => setCv(null)}>Close</button>
                  </div>
                ) : (
                  <div className="mp-cvconfirm" data-testid="mp-convert-confirm">
                    {/* THE NUMBERS, computed at click time from the match in front of you. */}
                    <b data-testid="mp-convert-summary">{cv.summary}</b>
                    <div className="mp-cvnote">
                      {cv.moveCount} write{cv.moveCount === 1 ? "" : "s"} after the shape, one per player, sent one at a
                      time. Each reports its own result. Nothing retries.
                    </div>
                    <div className="mp-cv-acts">
                      <button type="button" className="mp-btn mp-nowrap" data-testid="mp-convert-cancel" onClick={() => setCv(null)}>Keep 2 teams</button>
                      <button type="button" className="mp-btn mp-pri mp-nowrap" data-testid="mp-convert-go" disabled={cvBusy}
                        onClick={() => void runConvert()}>{cvBusy ? "Converting…" : "Convert to 4 teams"}</button>
                    </div>
                  </div>
                )}
                {cvMsg && <div className={"mp-note " + (cvMsg.bad ? "warn" : "info")} data-testid="mp-convert-msg">{cvMsg.text}</div>}
                {/* ONE ROW PER WRITE. A single outcome for eleven writes would be a lie. */}
                {cvResults && (
                  <ul className="mp-wres" data-testid="mp-convert-results">
                    {cvResults.map((r, i) => (
                      <li key={i} data-testid="mp-convert-result" data-verdict={r.verdict}>
                        <span className="v">{r.verdict}</span>
                        <span>{r.label}{r.detail ? ` — ${r.detail}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/* REDUCE TO 2 TEAMS. Offered only when there are more than 2 teams — on a 2-team match
                there is nothing to reduce, and the control is absent rather than disabled. Disabled
                while any other operation on this panel is in flight, as Convert is. */}
            {rosterTeamCount > 2 && (
              <div className="mp-cv" data-testid="mp-reduce">
                {!rd ? (
                  <>
                    <button type="button" className="mp-btn" data-testid="mp-reduce-open" disabled={rdBusy || cvBusy || !mayWrite}
                      onClick={() => void openReduce()}>{rdBusy ? "Reading…" : "Reduce to 2 teams"}</button>
                    <span className="mp-cvsub">Takes the fakes out and puts everyone on teams 1 and 2. This is not auto-bump.</span>
                  </>
                ) : rd.refusal || rd.shapeError ? (
                  <div className="mp-note warn" data-testid="mp-reduce-refusal">
                    {rd.refusal ?? rd.shapeError}
                    <button type="button" className="mp-btn" style={{ marginLeft: 10 }} onClick={() => setRd(null)}>Close</button>
                  </div>
                ) : rd.capacityRefusal ? (
                  /* THE ARITHMETIC, ON SCREEN. Both numbers and the shortfall, and an answer to the
                     first thing anyone thinks of — that taking the fakes out would make room. */
                  <div className="mp-note warn" data-testid="mp-reduce-nofit">
                    {/* THE SENTENCE ALREADY NAMES BOTH NUMBERS. A bold lead saying "36 real
                        players, 22 spots" above "36 real players will not fit into 22 spots" said
                        it twice — measured on production match 18365. */}
                    <b>Not reduced.</b> {rd.capacityRefusal}
                    <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                      {rd.capacityWhy.map((w, i) => <li key={i} data-testid="mp-reduce-why">{w}</li>)}
                    </ul>
                    <button type="button" className="mp-btn" style={{ marginTop: 8 }} onClick={() => setRd(null)}>Close</button>
                  </div>
                ) : (
                  <div className="mp-cvconfirm" data-testid="mp-reduce-confirm">
                    {/* THE CONSEQUENCE, from the plan's own numbers. */}
                    <b data-testid="mp-reduce-consequence">{rd.consequence}</b>
                    <ol className="mp-wres" data-testid="mp-reduce-steps" style={{ counterReset: "none" }}>
                      {rd.steps.map((st, i) => (
                        <li key={i} data-testid="mp-reduce-step">
                          <span className="v">{i + 1}</span>
                          <span>{st.label} — <em>{st.detail}</em></span>
                        </li>
                      ))}
                    </ol>
                    {/* WHAT PLAYERS WILL SEE, before the press rather than after it. */}
                    <div className="mp-cvnote" data-testid="mp-reduce-fill">{rd.fillLine}</div>
                    <div className="mp-cvnote">
                      {rd.writeCount} write{rd.writeCount === 1 ? "" : "s"}, sent one at a time, each reporting its own
                      result. Nothing retries. Every live player&rsquo;s team and spot goes into the change log before the
                      first move — the shape can be put back, the arrangement cannot.
                    </div>
                    <div className="mp-cv-acts">
                      <button type="button" className="mp-btn mp-nowrap" data-testid="mp-reduce-cancel" onClick={() => setRd(null)}>Keep {rosterTeamCount} teams</button>
                      <button type="button" className="mp-btn mp-pri mp-nowrap" data-testid="mp-reduce-go" disabled={rdBusy}
                        onClick={() => void runReduce()}>{rdBusy ? "Reducing…" : "Reduce it"}</button>
                    </div>
                  </div>
                )}
                {rdMsg && <div className={"mp-note " + (rdMsg.bad ? "warn" : "info")} data-testid="mp-reduce-msg">{rdMsg.text}</div>}
                {/* ONE ROW PER WRITE. A single outcome for fourteen writes would be a lie. */}
                {rdResults && (
                  <ul className="mp-wres" data-testid="mp-reduce-results">
                    {rdResults.map((r, i) => (
                      <li key={i} data-testid="mp-reduce-result" data-verdict={r.verdict} data-kind={r.kind}>
                        <span className="v">{r.verdict}</span>
                        <span>{r.label}{r.detail ? ` — ${r.detail}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="mp-teams" data-testid="mp-teams">
            {rosterErr ? <div className="mp-err" data-testid="mp-teams-error">Couldn’t load teams: {rosterErr}</div>
             : !roster ? <div className="mp-loading" data-testid="mp-teams-loading">Loading teams…</div>
             : <>
              {opToast && <div className={"mp-optoast" + (opToast.bad ? " bad" : "")} data-testid="mp-optoast">{opToast.text}</div>}

              {/* THE TEAM COUNT CONTROL THAT STOOD HERE IS GONE, and it was a DUPLICATE, not a
                  second opinion: both it and the TEAMS segmented control in SPOTS called the same
                  stageTeamCount(), which is the only writer of pending.teamCount. Proven before the
                  cut rather than assumed — two controls writing to different fields would not be
                  duplicates, and removing one would have silently dropped a real edit.
                  teamCountConsequence() still exists and is still unit-tested; only its render is
                  gone. The one surviving control is in SPOTS. */}

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
                        {/* THE MEMBER COUNT, counted from THIS team's own rows. */}
                        <span className="mp-teammem" data-testid={`mp-teammembers-${t.teamNumber}`}
                          data-count={teamMemberCount(origin.rows, t.teamNumber)}>
                          {teamMemberCount(origin.rows, t.teamNumber)} member{teamMemberCount(origin.rows, t.teamNumber) === 1 ? "" : "s"}
                        </span>
                        <span className="mp-teamcap">{live.length}{roster.shape?.perTeam ? `/${roster.shape.perTeam}` : ""}</span>
                        {/* THE TEAM'S OWN ROWS, ADDED UP. */}
                        <span className="mp-teammoney" data-testid={`mp-teammoney-${t.teamNumber}`}
                          data-booked={usdPlain(teamMoney(origin.rows, t.teamNumber).booked)}>
                          {usd(teamMoney(origin.rows, t.teamNumber).booked)}
                        </span>
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
                            {/* COLUMN 1 — the pick. A fake has no phone and no person behind it, so
                                it cannot be texted and is not offered. */}
                            {p.fake
                              ? <span className="mp-ckhole" aria-hidden="true" />
                              : <input type="checkbox" className="mp-ck" data-testid={`mp-pick-${p.umId}`}
                                  checked={picked.has(p.umId)} onChange={() => togglePick(p.umId)}
                                  aria-label={`Select ${p.name} for a text`} />}
                            <span className="mp-pnum" data-testid="mp-spot">{spot ?? "—"}</span>
                            {/* NAME then PHONE. Two lines: a phone number on the same line as a name
                                is what crushed both. Display only — see the roster route: it never
                                reaches change_log, where the rule is last-4 via phoneLast4(). */}
                            <span className="mp-pident">
                              <span className="mp-pname" data-testid="mp-pname">{p.name}{p.fake && <span className="mp-fake-tag" data-testid="mp-fake-tag">FAKE</span>}{(p as PlayerRow).promoCode && <span className="mp-promo-tag" data-testid="mp-promo-tag">{(p as PlayerRow).promoCode}</span>}{kinds.get(p.umId) === "guest" && (
                                /* A DOT ON THE NAME'S OWN LINE, not a sub-line. An explanation
                                   underneath made one row in eighteen taller and the grid ragged. */
                                <span className="mp-sharedot" data-testid={`mp-shared-${p.umId}`}
                                  title={`Additional spot — same booking as ${p.name}, one phone and one email`} aria-hidden="true" />
                              )}</span>
                              <span className="mp-pphone" data-testid="mp-pphone">{p.phone ?? (p.fake ? "fake — no phone" : "no phone on file")}</span>
                            </span>
                            {/* COLUMN 4 — THE KIND, in a fixed column so the chips line up into a
                                stripe you can read down without reading a word. Three weights for
                                three kinds: member is the only filled one because it is what you
                                are scanning for, daily is the ordinary case and carries no box at
                                all, guest is the odd one and is outlined. */}
                            <span className="mp-pkind" data-testid={`mp-kind-${p.umId}`} data-kind={kinds.get(p.umId) ?? "fake"}>
                              {p.fake ? <span className="mp-kfake">—</span>
                                : roster.membershipError ? <span className="mp-kunknown" data-testid="mp-kind-unknown">unknown</span>
                                : kinds.get(p.umId) === "member" ? <span className="mp-kmember">Member</span>
                                : kinds.get(p.umId) === "guest" ? <span className="mp-kguest">Guest</span>
                                : <span className="mp-kdaily">Daily</span>}
                            </span>
                            {/* COLUMN 5 — THE MONEY, right-aligned, tabular. The credit sits on a
                                second line INSIDE the height the name and phone already set, so a
                                row where credit was used is exactly as tall as one where it was
                                not. Nothing here is ever blank: a blank cell reads as missing data,
                                so a fake row says "—" and a comped one says $0.00. */}
                            <span className="mp-pmoney" data-testid={`mp-money-${p.umId}`}
                              data-paid={(p as PlayerRow).paid ?? 0} data-credit={(p as PlayerRow).credit ?? 0}
                              data-kind={money.get(p.umId) ?? "paid"}>
                              {money.get(p.umId) === "fake"
                                ? <b className="mp-mnone">&mdash;</b>
                                : money.get(p.umId) === "on-booking"
                                  ? <b className="mp-monbook" title={`Paid for on another spot in ${p.name}'s booking — this row was not charged separately`}>on the booking</b>
                                  : <b>{usd((p as PlayerRow).paid ?? 0)}</b>}
                              {((p as PlayerRow).credit ?? 0) > 0 && (
                                <em className="mp-mcredit" data-testid={`mp-credit-${p.umId}`}
                                  title="How much of this spot came off the player's credit balance">
                                  {usd((p as PlayerRow).credit ?? 0)} credit
                                </em>
                              )}
                            </span>
                            <span className="mp-pacts">
                              {collision && <span className="mp-clashtag" data-testid="mp-collision">SAME SPOT</span>}
                              {/* COPY EMAIL — an icon, because the words written out eighteen times
                                  were most of the noise. The address is in the title, the aria-label
                                  says what it does. A FAKE ROW OFFERS NONE: its @matchday.com
                                  address is not a person. */}
                              {!p.fake && (p as PlayerRow).email
                                ? <button type="button" className="mp-icon" data-testid={`mp-copy-${p.umId}`}
                                    title={(p as PlayerRow).email ?? ""} aria-label={`Copy email for ${p.name}`}
                                    onClick={() => void copyEmail(p as PlayerRow)}>{copied === p.umId ? "\u2713" : "\u2709"}</button>
                                /* THE SPACER MUST BE THE SIZE OF THE BUTTON IT REPLACES. An 18px
                                   hole where a 32px icon would be made every fake row 6px shorter
                                   than every real one — measured on match 18477, spread 48 vs 54. */
                                : <span className="mp-iconhole" aria-hidden="true" />}
                              {removed ? <span className="mp-pendtag rm" data-testid="mp-pending-remove">REMOVING</span>
                               : moved && <span className="mp-pendtag" data-testid="mp-pending-move">MOVING</span>}
                              {/* ONE move control at ANY team count. Four teams used to mean three
                                  destination buttons plus a x on every row, which is what crushed
                                  the names to "L", "T", "G". */}
                              {/* AN ICON, NOT THE WORD. "Move" written out on every row cost about a
                                  button's width per row, which is the difference between a name
                                  column and no name column in a narrow drawer. The label and the
                                  tooltip carry the meaning. */}
                              <button type="button" data-testid={`mp-move-${p.umId}`} className="mp-icon" disabled={removed}
                                aria-expanded={movePick?.umId === p.umId} aria-label={`Move ${p.name} to another team or spot`}
                                title={`Move ${p.name} to another team or spot`}
                                onClick={() => setMovePick((m) => (m?.umId === p.umId ? null : { umId: p.umId, team: null }))}>&#8646;</button>
                              <button type="button" data-testid={`mp-remove-${p.umId}`} className={removed ? "mp-mini" : "mp-icon danger"}
                                title={removed ? `Keep ${p.name}` : `Remove ${p.name}`} aria-label={removed ? `Keep ${p.name} on the roster` : `Remove ${p.name} from the match`}
                                onClick={() => toggleRemove(p)}>{removed ? "Undo" : "\u2715"}</button>
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

              {/* ── THE MATCH LINE ──────────────────────────────────────────────────────────────
                  THREE SUMS, EACH OF ONE REAL COLUMN, and it says out loud what it leaves out.
                  "booked" is the spot price before the card fee; "on cards" is what Stripe actually
                  took, fee included. They do not reconcile to the cent and this line does not
                  pretend otherwise — a figure an operator cannot find on a statement is worse than
                  no figure. */}
              <p className="mp-matchmoney" data-testid="mp-matchmoney"
                data-booked={usdPlain(matchMoney.booked)} data-charged={usdPlain(matchMoney.charged)} data-credit={usdPlain(matchMoney.credit)}>
                <b data-testid="mp-money-booked">{usd(matchMoney.booked)} booked</b>
                <span> &middot; <b data-testid="mp-money-charged">{usd(matchMoney.charged)}</b> on cards, card fee included</span>
                <span> &middot; <b data-testid="mp-money-credit">{usd(matchMoney.credit)}</b> on credit</span>
              </p>

              {/* WHAT THE ROSTER IS MADE OF, in the same subdued voice as the money above it.
                  SPOTS, NOT PEOPLE: somebody holding two spots is counted twice, which is why this
                  disagrees with the text count in the selection bar — that one counts phones. */}
              <p className="mp-matchcounts" data-testid="mp-rostercounts"
                data-promo={roster.promo?.spots ?? 0} data-members={counts.members}
                data-daily={counts.daily} data-guests={counts.guests} data-real={counts.real}>
                <b data-testid="mp-count-promo">{roster.promo?.spots ?? 0}</b> on promo
                {" \u00b7 "}<b data-testid="mp-count-members">{counts.members}</b> member{counts.members === 1 ? "" : "s"}
                {" \u00b7 "}<b data-testid="mp-count-daily">{counts.daily}</b> daily
                {" \u00b7 "}<b data-testid="mp-count-guests">{counts.guests}</b> guest{counts.guests === 1 ? "" : "s"}
              </p>

              {/* THE WAY IN. Rearrange is a mode, not a panel section — it needs the window. */}
              <p className="mp-rearrange-open">
                <button type="button" className="mp-mini" data-testid="mp-rearrange-open"
                  onClick={() => setRearrange(true)}>{"Rearrange teams\u2026"}</button>
                <span>Drag players between teams on a full-width board. Stages the same plan; Save still sends it.</span>
              </p>

              {/* THE ICON KEY IS GONE. The membership-read failure was living inside it and is NOT
                  an explainer — without it every row quietly reads Daily when the query failed —
                  so it keeps its own line and appears only when there is something to say. */}
              {roster.membershipError && (
                <p className="mp-legend" data-testid="mp-roster-legend">
                  <b className="mp-memerr" data-testid="mp-member-error">membership could not be read ({roster.membershipError}) — no row can be trusted to say Daily</b>
                </p>
              )}

              {/* ── THE SELECTION BAR ───────────────────────────────────────────────────────────
                  THE NUMBER IS PHONES, NEVER ROWS. Two spots on one booking is one text, and the
                  bar says so in the same breath so the difference is never a surprise at the
                  confirm. */}
              {picked.size > 0 && (
                <div className="mp-selbar" data-testid="mp-selbar">
                  <span className="mp-selcount" data-testid="mp-selcount" data-texts={tally.texts} data-rows={tally.rows}>
                    <b>{tally.texts} text{tally.texts === 1 ? "" : "s"}</b>
                    <em>{tally.rows} row{tally.rows === 1 ? "" : "s"} selected</em>
                  </span>
                  {tally.rows !== tally.texts + tally.noPhone && (
                    <span className="mp-selwhy" data-testid="mp-selwhy">
                      {tally.rows - tally.texts - tally.noPhone === 1
                        ? "One of them shares a phone with somebody else you picked"
                        : `${tally.rows - tally.texts - tally.noPhone} of them share a phone with somebody else you picked`} — one person, one text.
                    </span>
                  )}
                  {tally.noPhone > 0 && (
                    <span className="mp-selwhy" data-testid="mp-selnophone">
                      {tally.noPhone === 1 ? "One of them has" : `${tally.noPhone} of them have`} no phone on file and cannot be texted.
                    </span>
                  )}
                  <span className="mp-selacts">
                    <button type="button" className="mp-mini" data-testid="mp-sel-clear" onClick={clearPicks}>Clear</button>
                    <button type="button" className="mp-mini mp-pri" data-testid="mp-sel-text" disabled={tally.texts === 0}
                      onClick={() => { setComposer(true); setSmsConfirm(false); }}>Send a text</button>
                  </span>
                </div>
              )}

              {/* ── THE COMPOSER ───────────────────────────────────────────────────────────────
                  Deliberately NOT a whole-match send: Match Chats already does that, and this is
                  the other thing. There is no "everyone" button here. */}
              {composer && picked.size > 0 && (
                <div className="mp-sms" data-testid="mp-sms">
                  <div className="mp-smstpl" data-testid="mp-sms-templates">
                    {(["free_form", "field_change", "time_change", "weather_policy"] as const).map((id) => (
                      <button type="button" key={id} className={"mp-mini" + (tplId === id ? " on" : "")}
                        data-testid={`mp-tpl-${id}`} aria-pressed={tplId === id}
                        onClick={() => { setTplId(id); setSmsConfirm(false); setSmsBody(buildTemplateBody(id, mergeValues)); }}>
                        {TEMPLATE_LABELS[id]}
                      </button>
                    ))}
                  </div>
                  <textarea className="mp-smsbody" data-testid="mp-sms-body" rows={4} value={smsBody}
                    aria-label="Message to send" placeholder="Type the message. It goes to the phones you picked."
                    onChange={(e) => { setSmsBody(e.target.value); setSmsConfirm(false); }} />
                  <div className="mp-smsmeta" data-testid="mp-sms-meta">
                    <span data-testid="mp-sms-count">{smsBody.length}/1600 characters &middot; {smsSegments(smsBody).segments} segment{smsSegments(smsBody).segments === 1 ? "" : "s"} &middot; {smsSegments(smsBody).encoding}</span>
                    {unfilledTokens(smsBody).length > 0 && (
                      <b className="mp-smswarn" data-testid="mp-sms-tokens">Fill in {unfilledTokens(smsBody).join(", ")} before sending</b>
                    )}
                  </div>
                  {!smsConfirm ? (
                    <div className="mp-cv-acts">
                      <button type="button" className="mp-mini" data-testid="mp-sms-cancel" onClick={() => { setComposer(false); setSmsConfirm(false); }}>Cancel</button>
                      <button type="button" className="mp-mini mp-pri" data-testid="mp-sms-review"
                        disabled={!smsBody.trim() || unfilledTokens(smsBody).length > 0 || tally.texts === 0}
                        onClick={() => setSmsConfirm(true)}>Review {tally.texts} text{tally.texts === 1 ? "" : "s"}</button>
                    </div>
                  ) : (
                    /* THE CONFIRM SHOWS THE EXACT WORDS AND THE EXACT COUNT, and says plainly that
                       it cannot be recalled. There is no send path from this panel that skips it. */
                    <div className="mp-smsconfirm" data-testid="mp-sms-confirm">
                      <b>Send this to {tally.texts} phone{tally.texts === 1 ? "" : "s"}?</b>
                      <blockquote className="mp-smsquote" data-testid="mp-sms-exact">{smsBody}</blockquote>
                      <p className="mp-smswho" data-testid="mp-sms-who">
                        {pickedRows.filter((r) => !r.fake && r.phone).map((r) => r.name).join(", ")}
                      </p>
                      <p className="mp-smswarn" data-testid="mp-sms-nowayback">
                        These are real phones. A text cannot be recalled, and nothing here retries — one attempt per number.
                      </p>
                      <div className="mp-cv-acts">
                        <button type="button" className="mp-mini" data-testid="mp-sms-back" onClick={() => setSmsConfirm(false)}>Back</button>
                        <button type="button" className="mp-mini mp-pri" data-testid="mp-sms-send" disabled={smsBusy}
                          onClick={() => void sendText()}>{smsBusy ? "Sending\u2026" : `Send ${tally.texts} text${tally.texts === 1 ? "" : "s"}`}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {smsMsg && <div className={"mp-note " + (smsMsg.bad ? "warn" : "info")} data-testid="mp-sms-msg">{smsMsg.text}</div>}

              {/* ── THE REARRANGE BOARD ──────────────────────────────────────────────────────────
                  A full-WINDOW overlay, because the page's own content column is 1276px at a 1600px
                  window and four columns of that are 310px each. Over the window they are 381px,
                  which is what a grip, a spot, a 30-character name, a phone and a Move button need.
                  Under 1280px it is not drawn at all — dragging across four columns on a narrow
                  screen is not worth having, and the Move picker below does the same job. */}
              {rearrange && (
                <div className="mp-rear" data-testid="mp-rearrange" role="dialog" aria-label="Rearrange teams">
                  <div className="mp-rear-bar">
                    <b>{"Rearrange \u2014 "}{roster.name}</b>
                    <span className="mp-rear-sub" data-testid="mp-rear-sub">
                      {pendingN === 0 ? "No changes" : `${gestures.length || pendingN} change${(gestures.length || pendingN) === 1 ? "" : "s"} pending`}
                      {" \u00b7 "}{savePlan(pending, origin).length} write{savePlan(pending, origin).length === 1 ? "" : "s"}
                      {" \u00b7 "}{[...fill.values()].join(" and ")}{uneven ? ", uneven" : ", even"}
                    </span>
                    <button type="button" className="mp-mini" data-testid="mp-rear-close"
                      onClick={() => { setRearrange(false); setBoardPick(null); }}>Back to the panel</button>
                  </div>

                  {/* THE BOARD. Below the breakpoint this whole grid is display:none and only the
                      Move picker remains, which is the phone and keyboard path anyway. */}
                  <div className="mp-rear-board" data-testid="mp-rear-board" data-teams={roster.teams.length}>
                    {roster.teams.map((t) => (
                      <section className="mp-rear-col" key={t.id} data-testid={`mp-rear-col-${t.teamNumber}`}>
                        <header>
                          <b>{t.name}</b>
                          <span className={"mp-rear-fill" + (uneven ? " uneven" : "")} data-testid={`mp-rear-fill-${t.teamNumber}`}
                            data-count={fill.get(t.teamNumber) ?? 0}>
                            {fill.get(t.teamNumber) ?? 0} player{(fill.get(t.teamNumber) ?? 0) === 1 ? "" : "s"}{uneven ? " \u00b7 uneven" : ""}
                          </span>
                        </header>
                        <div className="mp-rear-slots">
                          {slots.filter((sl) => sl.team === t.teamNumber).map((sl) => {
                            const isOver = over?.team === sl.team && over?.spot === sl.spot;
                            const mover = dragUm != null ? rowByUm.get(dragUm) : undefined;
                            return (
                              <div key={sl.spot} className={"mp-slot" + (sl.row ? "" : " empty") + (isOver ? " tgt" : "")}
                                data-testid={`mp-slot-${sl.team}-${sl.spot}`} data-slot-team={sl.team} data-slot-spot={sl.spot}
                                data-occupied={sl.row ? "1" : "0"}>
                                {sl.row ? (
                                  <div className={"mp-card" + (sl.moved ? " moved" : "") + (dragUm === sl.row.umId ? " lifted" : "")}
                                    data-testid={`mp-card-${sl.row.umId}`} data-um={sl.row.umId}
                                    onPointerDown={(e) => onGrab(e, sl.row!.umId)}
                                    onPointerMove={onDragMove} onPointerUp={onDrop} onPointerCancel={onDrop}>
                                    <span className="mp-grip" aria-hidden="true">&#8942;&#8942;</span>
                                    <span className="mp-slotnum">{sl.spot}</span>
                                    <span className="mp-cardwho">
                                      <b>
                                        {multi.has(sl.row.playerId) && (
                                          <span className="mp-sharedot" data-testid={`mp-rear-multi-${sl.row.umId}`}
                                            title={`${sl.row.name} holds more than one spot on this match`} />
                                        )}
                                        {sl.row.name}
                                        {sl.row.fake && <span className="mp-fake-tag" data-testid={`mp-rear-fake-${sl.row.umId}`}>FAKE</span>}
                                      </b>
                                      <span>{sl.row.phone ?? (sl.row.fake ? "fake \u2014 no phone" : "no phone on file")}</span>
                                    </span>
                                    {/* THE KEYBOARD AND PHONE PATH, kept. It stages exactly what a
                                        drop stages, through the same dropOn. */}
                                    <button type="button" className="mp-icon" data-testid={`mp-rear-move-${sl.row.umId}`}
                                      aria-label={`Move ${sl.row.name} to another team or spot`} title={`Move ${sl.row.name}`}
                                      onClick={() => setBoardPick((m) => (m?.umId === sl.row!.umId ? null : { umId: sl.row!.umId, team: null }))}>&#8646;</button>
                                  </div>
                                ) : (
                                  <span className="mp-slotempty">{sl.spot} &middot; empty</span>
                                )}
                                {/* THE HINT SAYS WHAT THE DROP WILL DO WHILE YOU ARE STILL HOLDING IT,
                                    naming the person you would displace and where they would land. */}
                                {isOver && mover && (
                                  <span className="mp-slothint" data-testid="mp-slot-hint">{dropHint(origin, pending, mover, sl.team, sl.spot)}</span>
                                )}
                                {boardPick && sl.row && boardPick.umId === sl.row.umId && (
                                  <div className="mp-rear-pick" data-testid="mp-rear-pick" data-step={boardPick.team == null ? "team" : "spot"}>{/* eslint-disable-line */}
                                    {boardPick.team == null ? (
                                      <>
                                        <span>Which team?</span>
                                        {roster.teams.filter((o) => o.teamNumber !== effectiveRow(sl.row!, pending, origin).team).map((o) => {
                                          const full = (fill.get(o.teamNumber) ?? 0) >= perTeam;
                                          return (
                                            <button key={o.id} type="button" className="mp-mini" disabled={full}
                                              data-testid={`mp-rear-pick-team-${o.teamNumber}`}
                                              title={full ? `${o.name} is full` : `Move to ${o.name}`}
                                              onClick={() => setBoardPick({ umId: sl.row!.umId, team: o.teamNumber })}>
                                              {o.teamNumber} &middot; {o.name} <em>{fill.get(o.teamNumber) ?? 0}/{perTeam}</em>
                                            </button>
                                          );
                                        })}
                                      </>
                                    ) : (
                                      <>
                                        <span>Which spot on {roster.teams.find((x) => x.teamNumber === boardPick.team)?.name}?</span>
                                        {spotsOfTeam(origin, pending, boardPick.team, perTeam).map((sp) => (
                                          <button key={sp.n} type="button" className={"mp-spotbtn" + (sp.who ? " taken" : "")}
                                            data-testid={`mp-rear-pick-spot-${sp.n}`}
                                            title={sp.who ? `Swap with ${sp.who.name}` : `Spot ${sp.n} is open`}
                                            onClick={() => dropOn(sl.row!, boardPick.team!, sp.n)}>{sp.n}</button>
                                        ))}
                                        <button type="button" className="mp-x" data-testid="mp-rear-pick-back"
                                          onClick={() => setBoardPick({ umId: sl.row!.umId, team: null })}>back</button>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>

                  {/* TWO LISTS. What you did, and what Save sends — a swap is one of the first and
                      two of the second, and showing only the writes is what made a pair of swaps
                      read as a rotation nobody performed. */}
                  <div className="mp-rear-plan" data-testid="mp-rear-plan">
                    <div>
                      <h5>What you did</h5>
                      {gestures.length === 0
                        ? <p className="mp-empty" data-testid="mp-rear-nogestures">Nothing yet. Drag a player, or press the move control on a card.</p>
                        : <ol data-testid="mp-rear-gestures">
                            {gestures.map((g, i) => (
                              <li key={i} data-testid="mp-rear-gesture">
                                <span>{g.text}</span> <u>{g.writes} write{g.writes === 1 ? "" : "s"}</u>
                                {i === gestures.length - 1 && (
                                  <button type="button" className="mp-mini" data-testid="mp-rear-stepback" onClick={stepBack}>Step back</button>
                                )}
                              </li>
                            ))}
                          </ol>}
                    </div>
                    <div>
                      <h5>What Save sends</h5>
                      {pendingN === 0
                        ? <p className="mp-empty" data-testid="mp-rear-nowrites">Nothing. Nothing has left this browser.</p>
                        : <ol data-testid="mp-rear-writes">
                            {savePlan(pending, origin).map((w, i) => <li key={i} data-testid="mp-rear-write">{w.label}</li>)}
                          </ol>}
                      <p className="mp-empty">One write per player, in this order, each with its own verdict. Save and Revert are in the panel behind this board and act on the same plan.</p>
                    </div>
                  </div>

                  {/* The dragged card follows the pointer. pointer-events:none so elementFromPoint
                      never finds the ghost instead of the slot under it. */}
                  <div className={"mp-ghost" + (dragUm == null ? " off" : "")} ref={ghostRef} data-testid="mp-rear-ghost" aria-hidden="true">
                    {dragUm != null && rowByUm.get(dragUm)?.name}
                  </div>
                </div>
              )}
            </>}
            </div>
          </Section>

          {/* ── CANCEL (Part C) — the danger zone. Separate, immediate, irreversible. ── */}
          <div className="mp-danger" data-testid="mp-danger">
            <div className="mp-danger-hd">DANGER ZONE · CANCEL THE MATCH</div>
            {!cancel.preview ? (
              <button type="button" className="mp-cancelbtn" data-testid="mp-cancel-open" disabled={cancel.busy} onClick={() => void cancel.open()}>{cancel.busy ? "Reading…" : "Cancel this match…"}</button>
            ) : cancel.preview.alreadyCancelled ? (
              <div className="mp-note warn" data-testid="mp-cancel-already">This match is already cancelled — nothing to do.</div>
            ) : (
              <div className="mp-cancelconfirm" data-testid="mp-cancel-confirm">
                {/* THE PINNED SENTENCE, from the shared helper, so both panels say it in the same
                    words with the same live count. The paragraph under it is this panel's and it
                    is kept: it names the credit TOTAL and says CREDIT rather than refund, which is
                    strictly more than the one-liner carries and is not something to drop for
                    symmetry. */}
                <p className="mp-cancel-line" data-testid="mp-cancel-stakes"><b>{cancelStakes(cancel.preview.count)}</b></p>
                <p className="mp-cancel-line" data-testid="mp-cancel-line">
                  <b>{cancel.preview.count} player{cancel.preview.count === 1 ? "" : "s"} will be credited ${centsToDollars(cancel.preview.totalCents)}</b> and texted that “{cancel.preview.name}” is off. Each gets a <b>CREDIT</b> of the match value to their MatchDay account — nothing leaves Stripe and no money returns to a card. This fires once and cannot be undone.
                </p>
                {/* YES / NO. The type box is gone — grey placeholder text that reads disabled. */}
                <div className="mp-cancel-acts">
                  <button type="button" className="mp-btn mp-nowrap" data-testid="mp-cancel-abort" onClick={cancel.abort}>Keep the match</button>
                  {/* DISABLES ON CLICK: `busy` is set before the fetch and cleared only when it
                      resolves. Writes never retry. */}
                  <button type="button" className="mp-cancelbtn mp-nowrap" data-testid="mp-cancel-do" disabled={cancel.busy} onClick={() => void cancel.run()}>{cancel.busy ? "Cancelling…" : "Cancel the match"}</button>
                </div>
              </div>
            )}
            {cancel.result && <div className="mp-note info" data-testid="mp-cancel-result" style={{ marginTop: 10 }}>{cancel.result}</div>}
          </div>
        </div>

        </fieldset>
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
          {/* THE EXPANDED DIFF STAYS ABOVE THE ROW; the TOGGLE itself moved down into it. The bar was
              two stacked lines — the dirty state on its own, then the buttons — which is 105px of a
              panel that already scrolls. The Master Schedule editor's bar is one line and this now
              matches it. The list is unchanged: it is still the request body, still itemised, and
              still only rendered when opened. */}
          <div className="mp-diffbox">
            {unsaved > 0 && diffOpen && (
              <ul className="mp-difflist" data-testid="mp-diff">
                {changed.map((k) => (
                  <li key={k} data-testid="mp-diff-item" data-key={k}>
                    <span className="mp-k">{LABELS[k] ?? k}</span>{" "}
                    <span className="mp-to">{shownVal(k, cur[k], [...managers, ...managersAll])}</span>
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
          {/* THE CONFIRMATION SITS ON THE SAVE BAR, not in a window.confirm — it has to be readable,
              it has to name the person and the amount, and it has to be assertable. Cancel sends
              nothing; there is no request in flight while this is open. */}
          {mgrConfirm && (
            <div className="mp-mgrconfirm" data-testid="mp-mgr-confirm">
              <b>This changes who gets paid for this match.</b>
              <ul>{mgrConfirm.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              <div className="mp-mgrconfirm-b">
                <button type="button" className="mp-btn" data-testid="mp-mgr-cancel" onClick={() => setMgrConfirm(null)}>Cancel — send nothing</button>
                <button type="button" className="mp-btn mp-pri" data-testid="mp-mgr-go" disabled={saving} onClick={() => { void doSave(true); }}>
                  {saving ? "Sending…" : "Confirm and send"}</button>
              </div>
            </div>
          )}
          <div className="mp-btns">
            <button type="button" className="mp-diffhd" data-testid="mp-diffhd" aria-expanded={diffOpen} disabled={unsaved === 0} onClick={() => setDiffOpen((o) => !o)}>
              <span className="mp-caret">{unsaved ? (diffOpen ? "▾" : "▸") : "·"}</span>
              <span data-testid="mp-diffcount">{unsaved ? `${unsaved} change${unsaved === 1 ? "" : "s"} will be sent` : "No changes"}</span>
            </button>
            <span className="mp-sp" />
            {/* REVERT SENDS NOTHING. It discards intentions; it cannot take back a write, because
                taking one back would BE another write. The label says so. */}
            <button type="button" className="mp-btn" data-testid="mp-revert" disabled={unsaved === 0} onClick={doRevert}
              title="Discards every unsaved change on this panel. Sends no request — it cannot undo anything already saved.">Revert</button>
            <button type="button" className="mp-btn mp-pri" data-testid="mp-save" disabled={!mayWrite || unsaved === 0 || saving || !!whenErr || !!shapeErr} title={whenErr ?? shapeErr ?? (mayWrite ? undefined : (access.ok ? undefined : access.reason))} onClick={() => { if (mayWrite && !whenErr && !shapeErr) void doSave(); }}>
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
/* NO TRAILING PAD. The content scrolls right up under the bar; an 8px gap under the last section
   read as dead space because the bar is pinned directly below it. */
.mp-body{overflow:auto;min-height:0;padding:0}
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
/* THE MINIMUM IS WRITTEN FROM TWO SURFACES — this editor and the Gameday Ops banner stepper — so
   it is marked as such rather than sitting anonymously among the automation fields. The banner
   discards its pending value when this panel opens; the note is the half the operator can see. */
.mp-linked{position:relative;border-radius:9px;padding:8px;margin:-8px;background:#F2F7F4;
  box-shadow:inset 0 0 0 1px #CFE3D8}
.mp-linknote{display:block;margin-top:5px;font-size:10.5px;line-height:1.45;color:#4B5F55}

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
/* PINNED. flex:0 0 auto so it never shrinks or scrolls with the body — .mp-body above it is
   overflow:auto + min-height:0 and takes the remaining height, so the form scrolls UNDER this.
   The safe-area padding lives here because this is the element that touches the bottom of the
   drawer; it was on the drawer body, which no longer reaches the bottom. */
.mp-foot{border-top:1px solid var(--line);background:#fafcfb;padding:10px 16px;flex:0 0 auto;
  padding-bottom:calc(10px + var(--sab, env(safe-area-inset-bottom, 0px)))}
/* Only the expanded list lives here now, so it has no margin when it is empty. */
.mp-diffbox:not(:empty){margin-bottom:8px}
/* width:auto now — it shares a row with the buttons instead of owning a line. min-width:0 plus
   the ellipsis keeps a long "N changes will be sent" from shoving Save off the edge on a phone. */
.mp-diffhd{display:flex;align-items:center;gap:8px;min-width:0;border:0;background:none;font:inherit;text-align:left;cursor:pointer;padding:0 2px;font-size:12.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-diffhd:disabled{cursor:default;opacity:.7}
.mp-difflist{list-style:none;margin:8px 0 0;padding:9px 11px;background:#fff;border:1px solid var(--line);border-radius:9px;font-size:12px;max-height:150px;overflow:auto}
.mp-difflist li{padding:3px 0;border-bottom:1px solid #f0f5f2}
.mp-difflist li:last-child{border-bottom:0}
.mp-k{font-weight:800}
.mp-to{color:var(--grn);font-weight:700}
/* ONE ROW, VERTICALLY CENTRED: dirty state left, Revert and Save right. .mp-sp is the spacer
   between them. Matching the Master Schedule bar, which is 12px 24px on a single line. */
.mp-btns{display:flex;gap:9px;align-items:center;min-height:40px}
.mp-sp{flex:1 1 auto}
.mp-btn{border:1px solid var(--line2);background:var(--card);border-radius:9px;padding:0 14px;font:inherit;font-weight:700;cursor:pointer;color:var(--ink2);min-height:40px}
.mp-btn:disabled{opacity:.5;cursor:not-allowed}
.mp-btn.mp-pri{background:#12301f;border-color:#12301f;color:#fff}
.mp-fs{border:0;margin:0;padding:0;min-width:0}
.mp-noedit{display:flex;flex-direction:column;gap:2px;margin:0 0 10px;border-radius:9px;padding:9px 11px;background:#fdf3e2;border:1px solid #e6c98a}
.mp-noedit b{font-size:11px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:#8a5a00}
.mp-noedit span{font-size:12px;line-height:1.35;color:#6b4a08}
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
/* TWO COLUMNS, BECAUSE PLAYERS ARE DRAGGED BETWEEN TEAMS AND BOTH HAVE TO BE ON SCREEN AT ONCE.
   The stacking rule below is a CONTAINER query, not a viewport one: this panel lives inside a
   drawer whose width has nothing to do with the window's, and a viewport media query is exactly how
   the roster ended up two-up inside a 346px card. It stacks when ITS OWN box cannot hold two rows,
   wherever it is rendered. A row needs about 450px before the name starts truncating hard, so two
   of them plus the gap and the card padding is the threshold. */
.mp-teams{container-type:inline-size;container-name:mproster}
.mp-teamgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:11px 0 4px}
@container mproster (max-width:980px){ .mp-teamgrid{grid-template-columns:1fr} }
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

/* ── THE ROSTER ROW: FIVE FIXED COLUMNS ────────────────────────────────────────────────────────
   pick · spot · name+phone · kind · actions. FIXED is the point: the kind chips line up into a
   stripe you can read down the team without reading a single word, and that column is the whole
   feature. The row was flex-wrap, which put the chip wherever it happened to land. */
/* THE ONLY FLEXIBLE TRACK IS THE NAME, and everything else keeps its intrinsic width. Measured in
   the Gameday drawer at 760px: the fixed tracks plus the actions came to 341px of content in a
   322px row, so the 1fr resolved to ZERO and the name — which was in the DOM the whole time, with
   the right text — rendered at 0 x 0. Nothing else may be squeezed to nothing again, so the name is
   the one that gives, and it gives by truncating. */
.mp-player{display:grid;grid-template-columns:20px 20px minmax(60px,1fr) 62px 74px auto;align-items:center;gap:7px;flex-wrap:nowrap}
/* THE CHECKBOX MUST BEAT THE .mp input RULE, WHICH SETS min-height:40px. NO BACKTICKS IN HERE: this
   stylesheet is a template literal and one backtick in a comment ends the string. This file already
   documents that same input rule
   rule blowing a checkbox to 541x40 in the SPOTS section; here it did something quieter and worse —
   the box measured 20 wide and 40 TALL, so the checkbox, not the content, was setting the height of
   every real row, and a fake row (which has a spacer instead) came out 6px shorter. Measured on
   match 18477: real rows 54px, fake rows 48px. The spacer matches the control exactly. */
/* .mp input is (class + type); a bare .mp-ck is one class and LOSES to it. Qualified so it wins. */
.mp input.mp-ck{width:20px;height:20px;min-height:20px;padding:0;margin:0;accent-color:#2f6fd0;cursor:pointer;flex:0 0 auto}
.mp-ckhole{display:block;width:20px;height:20px}
.mp-iconhole{display:block;width:32px;height:32px;flex:0 0 auto}
/* SELECTION IS BLUE, MEMBERSHIP IS GREEN. Tinting a selected row in the brand green made a
   selected daily player read as a member. */
.mp-player:has(.mp-ck:checked){background:#eef4fd;border-color:#a8c4ea;box-shadow:inset 3px 0 0 #2f6fd0}
.mp-pkind{font-size:11px;line-height:1.2;justify-self:start;white-space:nowrap}
/* THREE WEIGHTS FOR THREE KINDS. Member is the only filled chip because it is what you are
   scanning for. Daily is eleven rows in eighteen — the ordinary case — so it is plain muted text
   with no box at all; boxing it drew eleven boxes of noise. Guest is the odd one, outlined. */
.mp-kmember{display:inline-block;background:#1f7a4d;color:#fff;border-radius:999px;padding:2px 8px;font-weight:800;letter-spacing:.02em}
.mp-kdaily{color:var(--ink3);font-weight:600}
.mp-kguest{display:inline-block;border:1px solid #d9a441;color:#8a5d10;background:transparent;border-radius:999px;padding:1px 7px;font-weight:700}
.mp-kunknown{color:#8a5d10;font-weight:700}
.mp-kfake{color:var(--ink3)}
/* THE SHARED-BOOKING MARK, on the name's own line so no row is taller than its neighbours. */
.mp-sharedot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#2f6fd0;margin-left:6px;vertical-align:middle;flex:0 0 auto}
.mp-sharedot.inline{margin:0 3px}
/* ICON BUTTONS. "Copy email" written out eighteen times was most of the noise; the address lives
   in the title and the aria-label says what the glyph does. Still thumb-sized. */
.mp-icon{border:1px solid var(--line2);background:#fff;border-radius:7px;width:32px;min-height:32px;font-size:13px;line-height:1;color:var(--ink2);cursor:pointer;flex:0 0 auto;padding:0}
.mp-icon.danger{color:var(--red);border-color:#e6b7b0}
.mp-icon:hover{background:#f4f7f5}
/* ── THE MONEY COLUMN. Right-aligned and tabular so a column of figures reads down as a column.
      The credit is a second line, which costs NOTHING in height: the name cell beside it is already
      two lines (name + phone), so the row's height is set there and a credit line fits inside it. */
.mp-pmoney{display:flex;flex-direction:column;align-items:flex-end;justify-self:end;line-height:1.25;font-variant-numeric:tabular-nums;white-space:nowrap}
.mp-pmoney b{font-size:12px;font-weight:700}
.mp-mcredit{font-style:normal;font-size:10px;color:#2f6fd0}
.mp-monbook{font-size:10px;font-weight:600;color:var(--ink3)}
.mp-mnone{color:var(--ink3);font-weight:600}
.mp-teammoney{font-size:10px;font-weight:800;color:var(--ink2);font-variant-numeric:tabular-nums;padding-left:6px}
.mp-matchmoney{margin:10px 0 0;font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums}
.mp-matchcounts{margin:2px 0 0;font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums}
.mp-rearrange-open{margin:10px 0 0;display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;color:var(--ink3)}

/* ── REARRANGE: A FULL-WINDOW MODE ────────────────────────────────────────────────────────────
   Fixed to the VIEWPORT, not to the panel. Measured on /match-ops/gameday at a 1600px window: the
   page content column is 1276px, which is 310px per team; the window is 1600, which is 381px. A
   grip, a spot, a 30-character name, a phone and one control need the second number. z-index sits
   above the Gameday drawer (60) because it is opened from inside it. */
.mp-rear{position:fixed;inset:0;z-index:70;background:#f4f7f5;display:flex;flex-direction:column;padding:14px 20px 16px;gap:10px;overflow:hidden}
.mp-rear-bar{display:flex;align-items:center;gap:12px;flex:0 0 auto}
.mp-rear-bar b{font-size:15px}
.mp-rear-sub{font-size:12px;color:var(--ink3);font-variant-numeric:tabular-nums}
.mp-rear-bar>button{margin-left:auto}
.mp-rear-board{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:repeat(var(--cols,4),minmax(0,1fr));gap:12px;align-content:start}
.mp-rear-board[data-teams="2"]{--cols:2}.mp-rear-board[data-teams="3"]{--cols:3}.mp-rear-board[data-teams="4"]{--cols:4}
.mp-rear-col{border:1px solid var(--line);border-radius:10px;background:#fff;padding:9px;min-width:0;display:flex;flex-direction:column;min-height:0}
.mp-rear-col header{display:flex;align-items:baseline;gap:8px;margin-bottom:7px}
.mp-rear-col header b{font-size:14px;font-weight:800}
.mp-rear-fill{font-size:10px;font-weight:800;color:var(--ink3);margin-left:auto}
.mp-rear-fill.uneven{color:#8a5d10}
.mp-rear-slots{display:flex;flex-direction:column;gap:5px;min-height:0;overflow:auto}
.mp-slot{position:relative;border-radius:9px;min-height:46px;display:flex;align-items:center}
.mp-slot.empty{border:1px dashed var(--line2);padding:0 11px;color:var(--ink3);font-size:11px}
.mp-slot.tgt{outline:2px solid #1f7a4d;outline-offset:1px;background:#eaf5ee}
.mp-slothint{position:absolute;right:9px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:#1f7a4d;background:#fff;border-radius:6px;padding:2px 6px;pointer-events:none;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* THE CARD IS STRIPPED: grip, spot, name, phone, the multi-spot tick and a fake marker. No money,
   no badge, no checkbox, no copy email, no remove — those stay on the panel's row. */
.mp-card{display:grid;grid-template-columns:20px 16px minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;
  border:1px solid var(--line);border-radius:9px;background:#fbfdfc;padding:6px 8px;min-height:46px;
  /* WITHOUT THIS A TOUCH DRAG SCROLLS THE PAGE INSTEAD OF MOVING THE CARD. dragstart does not fire
     on touch at all, which is why this is pointer events; touch-action is the other half of it. */
  touch-action:none;cursor:grab;user-select:none}
.mp-card.moved{border-color:#8fbf9f;background:#f2fbf5}
.mp-card.lifted{opacity:.35}
.mp-grip{color:#b7c6bf;font-size:11px;letter-spacing:-1px;line-height:1;text-align:center}
.mp-slotnum{font-size:10px;font-weight:800;color:#3a5348;font-variant-numeric:tabular-nums;text-align:center}
.mp-cardwho{min-width:0;display:flex;flex-direction:column;line-height:1.25}
.mp-cardwho b{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-cardwho>span{font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-rear-pick{position:absolute;left:8px;right:8px;top:100%;z-index:3;margin-top:3px;background:#fff;border:1px solid var(--line2);border-radius:9px;padding:7px;display:flex;flex-wrap:wrap;gap:5px;align-items:center;box-shadow:0 8px 18px rgba(4,26,18,.12)}
.mp-rear-pick>span{font-size:11px;color:var(--ink3);width:100%}
.mp-rear-pick em{font-style:normal;color:var(--ink3);font-weight:600}
.mp-rear-plan{flex:0 0 auto;display:grid;grid-template-columns:1fr 1fr;gap:16px;border-top:1px solid var(--line);padding-top:9px;max-height:210px;overflow:auto}
.mp-rear-plan h5{margin:0 0 5px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)}
.mp-rear-plan ol{margin:0;padding-left:18px;font-size:12px;line-height:1.6}
.mp-rear-plan u{text-decoration:none;color:var(--ink3);font-size:11px;margin-left:6px}
.mp-rear-plan .mp-mini{margin-left:8px;min-height:26px;font-size:11px;padding:0 7px}
.mp-rear-plan .mp-empty{margin:0;font-size:11px;color:var(--ink3)}
.mp-ghost{position:fixed;left:0;top:0;z-index:80;pointer-events:none;background:#fff;border:1px solid #8fbf9f;border-radius:9px;
  padding:9px 11px;font-size:13px;font-weight:600;box-shadow:0 10px 24px rgba(4,26,18,.22);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-ghost.off{display:none}
/* BELOW FOUR READABLE COLUMNS THE BOARD IS NOT DRAWN AT ALL. Dragging across four columns on a
   narrow screen is not worth having, and the move control on each card does the same job. */
@media (max-width:1279px){
  .mp-rear-board{display:none}
  .mp-rear::after{content:"This screen is too narrow for the board. Use the move control on a player in the panel behind this.";
    font-size:12px;color:var(--ink3);display:block;padding:10px 0}
}
.mp-teammem{font-size:10px;font-weight:800;color:#1f7a4d;letter-spacing:.02em;margin-left:auto;padding-right:6px}
.mp-legend{margin:8px 0 0;font-size:11px;color:var(--ink3);display:flex;align-items:center;gap:3px;flex-wrap:wrap}
.mp-memerr{color:#8a5d10}
/* ── THE SELECTION BAR AND THE COMPOSER ───────────────────────────────────────────────────── */
.mp-selbar{margin-top:10px;border:1px solid #a8c4ea;background:#eef4fd;border-radius:9px;padding:9px 11px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mp-selcount{display:flex;flex-direction:column;line-height:1.25}
.mp-selcount b{font-size:14px}
.mp-selcount em{font-style:normal;font-size:11px;color:var(--ink3)}
.mp-selwhy{font-size:11px;color:var(--ink2);flex:1;min-width:150px}
.mp-selacts{display:inline-flex;gap:6px;margin-left:auto}
.mp-mini.mp-pri{background:#1f7a4d;border-color:#1f7a4d;color:#fff}
.mp-mini.mp-pri:disabled{opacity:.45}
.mp-mini.on{background:#e8f1ea;border-color:#8fbf9f}
.mp-sms{margin-top:8px;border:1px solid var(--line2);border-radius:9px;padding:10px;background:#fff}
.mp-smstpl{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.mp-smsbody{width:100%;box-sizing:border-box;font:inherit;font-size:13px;border:1px solid var(--line2);border-radius:8px;padding:8px;resize:vertical}
.mp-smsmeta{display:flex;gap:10px;font-size:11px;color:var(--ink3);margin:6px 0 8px;flex-wrap:wrap}
.mp-smswarn{color:var(--red);font-weight:700}
.mp-smsconfirm{border-top:1px solid var(--line);padding-top:9px}
.mp-smsquote{margin:7px 0;padding:8px 10px;border-left:3px solid #2f6fd0;background:#f6f9fe;font-size:13px;white-space:pre-wrap}
.mp-smswho{margin:0 0 6px;font-size:11px;color:var(--ink3)}
/* ── ON A PHONE the row goes to two lines. Five fixed columns took 266px of a 310px row and left
      the name 44px, so every name truncated to two letters. The KIND CHIP IS NOT DROPPED: which of
      these people is a member is what the panel is for. */
@media (max-width:560px){
  /* THE MONEY TAKES ITS OWN FULL-WIDTH LINE, above the chip and the actions. Squeezed into the
     shared line it wrapped onto a fourth row; given the width it reads in one, with the credit
     BESIDE the amount rather than under it. */
  .mp-player{grid-template-columns:20px 20px minmax(0,1fr);grid-template-areas:"ck spot name" ". money money" ". kind acts";row-gap:5px}
  .mp-player .mp-ck,.mp-player .mp-ckhole:first-child{grid-area:ck}
  .mp-pnum{grid-area:spot}
  .mp-pident{grid-area:name}
  .mp-pmoney{grid-area:money;flex-direction:row;align-items:baseline;justify-self:start;gap:7px}
  .mp-pkind{grid-area:kind}
  .mp-pacts{grid-area:acts;justify-self:end}
  /* A THUMB, NOT A CURSOR. The row is taller here, so the box can be too without making the grid
     ragged — the spacer grows with it. */
  .mp input.mp-ck{width:26px;height:26px;min-height:26px}
  .mp-ckhole{width:26px;height:26px}
}
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
.mp-mgrconfirm{border:1px solid #F0C98A;background:#FFF7EA;border-radius:10px;padding:11px 13px;margin:0 0 10px;font-size:13px;color:#5E3D05;line-height:1.5}
.mp-mgrconfirm b{display:block;margin-bottom:5px;color:#4A3004}
.mp-mgrconfirm ul{margin:0 0 9px;padding-left:18px}
.mp-mgrconfirm li{margin:2px 0}
.mp-mgrconfirm-b{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.mp-cancel-line{font-size:13px;line-height:1.5;color:#5a1611;margin:0 0 12px}
.mp-cancel-line b{font-weight:800;color:#3d0e0a}
.mp-cv{margin:0 0 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mp-cvsub{font-size:11.5px;color:var(--ink3)}
.mp-cvconfirm{flex-basis:100%;border:1px solid var(--line2);background:#f7fbf9;border-radius:10px;padding:11px 13px}
.mp-cvconfirm b{display:block;font-size:13px;margin-bottom:5px}
.mp-cvnote{font-size:11.5px;color:var(--ink3);line-height:1.5}
.mp-cv-acts{display:flex;gap:10px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}
.mp-cancel-acts{display:flex;gap:10px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}
/* NEITHER BUTTON WRAPS. "Keep the match" is three words and a flex item with no minimum — give
   it nowrap and it keeps its one line at any panel width. */
.mp-nowrap{white-space:nowrap;flex:none}
@media (min-width:1100px){.mp-panel{max-width:860px}}
@media (max-width:560px){.mp-grid,.mp-grid3{grid-template-columns:1fr}.mp-teamgrid{grid-template-columns:1fr}}
`;
