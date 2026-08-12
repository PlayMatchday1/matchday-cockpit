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

export default function MatchPanel({ matchId, env = "production" }: { matchId: string; env?: "production" | "staging" }) {
  const [orig, setOrig] = useState<MatchData | null>(null);
  const [cur, setCur] = useState<Record<string, unknown>>({});
  const [when, setWhen] = useState<{ date: string; time: string }>({ date: "", time: "" });
  const [managers, setManagers] = useState<Manager[]>([]);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

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
                <div className="mp-step">
                  <button type="button" data-testid="mp-spt-minus" aria-label="Fewer per team" disabled={teamCount === 0 || capacity <= teamCount}
                    onClick={() => teamCount && setField("maxPlayerCount", Math.max(teamCount, capacity - teamCount))}>−</button>
                  <span className="mp-step-val" data-testid="mp-spt">{teamCount ? (capacity / teamCount % 1 === 0 ? capacity / teamCount : (capacity / teamCount).toFixed(1)) : "—"}</span>
                  <button type="button" data-testid="mp-spt-plus" aria-label="More per team" disabled={teamCount === 0}
                    onClick={() => teamCount && setField("maxPlayerCount", capacity + teamCount)}>+</button>
                </div></div>
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

          {/* Step 2 lands immediate roster/team actions HERE — Save/Revert never touch them. */}
          <div className="mp-immediate" data-testid="mp-immediate-slot" hidden aria-hidden="true" />
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
@media (max-width:560px){.mp-grid,.mp-grid3{grid-template-columns:1fr}}
`;
