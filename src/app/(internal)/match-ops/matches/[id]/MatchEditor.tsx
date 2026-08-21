"use client";

// The match field editor (Phase 2; Phase 11: PRODUCTION). Guarded partial write.
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
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { EDITABLE_KEYS, MONEY_KEYS as MONEY, TOGGLE_KEYS as TOGGLE, NULLABLE_NUM, fieldChanged, diffKeys, pick } from "@/lib/matchEditModel";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { noteLogResponse } from "@/lib/logHealth";
import LogHealthBanner from "@/components/LogHealthBanner";
import { useAuth, canEditMatches } from "@/lib/useAuth";
import { wallDate, wallTime, buildStartDate, shiftedEndDate, isInvertedPair } from "@/lib/matchWallClock";
import { tzShift } from "@/lib/matchTimezone";

// MatchDay startDate/endDate are WALL-CLOCK strings mislabelled "…Z" (the true instant is
// startDateUtc). NEVER `new Date()` them — that re-shifts to the viewer's timezone and
// shows a wrong clock. Read the wall parts by slicing, exactly like the drawer.
const hhmm12 = (t: string) => { const [H, M] = t.split(":").map(Number); const ap = H >= 12 ? "PM" : "AM"; const h = H % 12 === 0 ? 12 : H % 12; return `${h}:${String(M).padStart(2, "0")} ${ap}`; };
const wallStamp = (iso: string) => `${wallDate(iso)} ${hhmm12(wallTime(iso))}`; // "2026-08-09 8:00 PM"

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

function specs(fields: FieldRow[], managers: { id: number; name: string }[] = []): Spec[] {
  const fieldOpts: [number, string][] = fields.map((f) => [f.id, `${f.city ? f.city + " — " : ""}${f.title}`]);
  const mgrOpts: [number, string][] = managers.map((m) => [m.id, m.name]);
  return [
    { key: "name", group: "match", kind: "text", label: "Name", wide: true },
    { key: "fieldId", group: "match", kind: "select", label: "Field", opts: fieldOpts },
    { key: "category", group: "match", kind: "select", label: "Category", opts: CATS },
    { key: "type", group: "match", kind: "select", label: "Type", opts: TYPES },
    // A NAMED DROPDOWN, as the drawer had — not a raw id box. A currently-selected id that is NOT
    // in the list stays selected and labelled; it is never blanked, because blanking would report
    // a change nobody made and then save it.
    { key: "managerId", group: "match", kind: "select", label: "Manager 1", opts: mgrOpts },
    { key: "secondManagerId", group: "match", kind: "select", label: "Manager 2", opts: mgrOpts, hint: "Leave empty if only one" },
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
    // These are TOTAL SPOTS for each format, not team sizes, and not three ways of
    // stating one number: maxPlayerCount is what the match holds NOW; the two
    // maxTeamSize fields are what it would hold if it became a 2- or 4-team match
    // (the auto-bump growth path). 0 means that format is unavailable. Rendered
    // with per-side hints by the capacity block below (not renderField).
    { key: "maxTeamSize2Team", group: "auto", kind: "number", label: "Total spots as 2 teams", cond: (s) => !!s.isAutoBump },
    { key: "maxTeamSize4Team", group: "auto", kind: "number", label: "Total spots as 4 teams", cond: (s) => !!s.isAutoBump },
    { key: "maxPlayerCount", group: "auto", kind: "number", label: "Capacity now", hint: "Total spots the match holds now. Blank or 0 = special event (no cap)." },
  ];
}

// The three caps are a capacity + a growth path, NOT three views of one number,
// so they are independent by design and we do NOT flag them as "inconsistent"
// (81% of production would trip that — pure noise). We flag ONLY genuine
// contradictions with the current configuration: a match played as N teams whose
// N-team total is 0 (nobody can sign up), or a capacity-now above every available
// format total (it can't fill past the largest format). null/blank is not 0.
function capNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function capacityContradiction(state: Data, teamCount: number): string | null {
  const mpc = capNum(state.maxPlayerCount), m2 = capNum(state.maxTeamSize2Team), m4 = capNum(state.maxTeamSize4Team);
  if (teamCount >= 4 && m4 === 0) return "This is a 4-team match, but its 4-team total is 0 (not available) — no one can sign up in the current configuration.";
  if (teamCount < 4 && m2 === 0) return "This is a 2-team match, but its 2-team total is 0 (not available) — no one can sign up in the current configuration.";
  const caps = [m2, m4].filter((c): c is number => c !== null && c > 0);
  if (mpc !== null && mpc > 0 && caps.length > 0 && mpc > Math.max(...caps)) {
    return `Capacity now (${mpc}) is above every available format total (${caps.join(", ")}) — it can't fill past the largest format.`;
  }
  return null;
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(path, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, cache: "no-store" });
}
const money = (cents: unknown) => "$" + (Number(cents ?? 0) / 100).toFixed(2);

/* ONE COMPONENT, TWO MODES — and the switch is deliberately small.
 *
 * EDIT (the Gameday Ops behaviour, unchanged): loads the match by id, start/end render as a
 * disabled input with the sentence they have always carried.
 *
 * CREATE: no match to load. The nine fields POST /admin/matches requires are pre-filled from the
 * SOURCE match, and start/end become REQUIRED inputs that arrive BLANK — a copy carrying last
 * week's date is one careless save away from duplicating a match that already exists.
 *
 * COPY-STEP-TWO: an ordinary edit of the newly created match, with the source's remaining fields
 * overlaid onto `state` so the diff shows them as changed and one save sends them. That is why
 * create can take nine fields and a copy can still carry twenty-one.
 */
export default function MatchEditor({ id, mode = "edit", sourceId, variant = "page", onDirtyChange, veo, onToggleVeo }: {
  id: string;
  mode?: "edit" | "create";
  /** The match being copied FROM — pre-fills create, and step two's overlay. */
  sourceId?: string | null;
  /* ONE COMPONENT, TWO PRESENTATIONS — content identical, chrome different.
   *
   * page   the Gameday Ops route: its own header, a full-bleed background, a save bar fixed to
   *        the viewport.
   * panel  inside Master Schedule's drawer, which already supplies a header (sibling arrows,
   *        close, the production framing). So panel mode drops this component's own header,
   *        stops claiming the viewport, and makes the save bar STICKY WITHIN the panel instead
   *        of fixed across the screen — which is the only thing that genuinely could not work
   *        unchanged. No logic, no field and no validation differs between them.
   */
  variant?: "page" | "panel";
  /** Panel mode reports dirtiness up so the drawer can block week-nav and card-switching. */
  onDirtyChange?: (dirty: boolean) => void;
  /* VEO COVERAGE, MOVED IN FROM THE DRAWER. Camera intent is a Clubhouse concept, not a MatchDay
   * one: it posts to /api/veo/intent and is NOT part of the match PUT — a separate call, exactly
   * as it was. The caller owns the value because it also owns the card badge that has to update;
   * the editor owns the control and the wording. */
  veo?: boolean;
  onToggleVeo?: (next: boolean) => void;
}) {
  const { appUser } = useAuth();
  const router = useRouter();
  const canEdit = canEditMatches(appUser); // courtesy gate; the server write path holds
  // Back to wherever we came from (Gameday Ops / Master Schedule), Gameday Ops on a direct
  // load. Same control as the roster screen.
  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/match-ops/gameday");
  };
  const [fields, setFields] = useState<FieldRow[]>([]);
  // THE ROUTE HAS ALWAYS RETURNED THESE; this component simply never read them, and rendered
  // managerId as a raw id box while the drawer showed a name dropdown. The drawer's body is gone,
  // so reading them here is what keeps that capability alive.
  const [managers, setManagers] = useState<{ id: number; name: string }[]>([]);
  const [players, setPlayers] = useState<Data[]>([]);
  const [meta, setMeta] = useState<Data | null>(null); // read-only bits (start/end, teams, isCancelled, occupancy)
  const [loaded, setLoaded] = useState<Data | null>(null);
  const [state, setState] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);

  const FIELDS = useMemo(() => specs(fields, managers), [fields, managers]);

  const ingest = useCallback((m: Data) => {
    const ed: Data = {};
    for (const k of EDITABLE_KEYS) ed[k] = m[k] ?? (TOGGLE.has(k) ? false : null);
    setLoaded(ed); setState(JSON.parse(JSON.stringify(ed)));
    setMeta({ id: m.id, startDate: m.startDate, endDate: m.endDate, isCancelled: m.isCancelled, teams: m.teams, fieldTitle: m.fieldTitle, cityName: m.cityName, occupancy: m.occupancy, maxPlayerCount: m.maxPlayerCount });
    // THE INVERTED-PAIR GUARD. A match whose end is on or before its start is reachable — the
    // server does not validate it — so both inputs are HELD and the reason is shown. Editing a
    // broken pair would rewrite it from a duration that is negative.
    const si = String(m.startDate ?? ""), ei = String(m.endDate ?? "");
    const bad = si && ei ? isInvertedPair(si, ei) : false;
    setInverted(bad);
    setDDate(si ? wallDate(si) : "");
    setDTime(si ? wallTime(si) : "");
  }, []);

  // CREATE MODE'S OWN DATE STATE. Deliberately NOT part of `state`: the twenty-one editable keys
  // are the PUT's business, and these two belong only to the create call.
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [dateErr, setDateErr] = useState<string | null>(null);
  // EDIT MODE'S DATE AND TIME. UI-only, exactly as the drawer models them: they collapse into the
  // startDate/endDate PAIR on save so a time move cannot silently change a match's length.
  const [dDate, setDDate] = useState("");
  const [dTime, setDTime] = useState("");
  const [inverted, setInverted] = useState(false);
  const [created, setCreated] = useState<{ id: number; outcome: string } | null>(null);
  const [dupe, setDupe] = useState<{ id: number; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null); setMsg(null);
    // In CREATE mode there is nothing at `id` yet — the source match is what gets read, and only
    // to pre-fill. Nothing is written until Save.
    const readId = mode === "create" ? sourceId : id;
    if (!readId) { setLoadErr("No source match to copy from."); return; }
    const res = await authFetch(`/api/matchday/${FULL_EDITOR_ENV}/matches/${readId}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setLoadErr(json?.error ?? `HTTP ${res.status}`); return; }
    setFields(json.fields ?? []); setManagers(json.managers ?? []);
    setPlayers(mode === "create" ? [] : (json.players ?? []));
    ingest(json.match);

    /* STEP TWO OF A COPY. The create call could carry only nine fields, so the rest arrive here:
     * the source's editable values are overlaid onto `state` (never onto `loaded`), which makes
     * them show up as UNSAVED CHANGES in the diff the editor already renders. One Save sends them
     * through the PUT that has always worked.
     *
     * EVERY editable key is overlaid, not a hand-listed subset. The nine that create already
     * carried will equal what came back and simply will not appear in the diff — so the list
     * cannot drift out of step with what create sends. */
    if (mode === "edit" && sourceId) {
      try {
        const sres = await authFetch(`/api/matchday/${FULL_EDITOR_ENV}/matches/${sourceId}`);
        const sjson = await sres.json().catch(() => ({}));
        if (sres.ok && sjson?.match) {
          const src = sjson.match as Data;
          setState((cur) => {
            if (!cur) return cur;
            const next: Data = { ...cur };
            for (const k of EDITABLE_KEYS) {
              const v = src[k];
              next[k] = v ?? (TOGGLE.has(k) ? false : null);
            }
            return next;
          });
          setMsg({ kind: "warn", text:
            `Match ${id} was created. These are the copied settings from match ${sourceId}, NOT SAVED YET — ` +
            `press Save to apply them.` });
        } else {
          // STEP ONE LANDED AND STEP TWO COULD NOT EVEN READ THE SOURCE. Say which half landed.
          setMsg({ kind: "warn", text:
            `Match ${id} WAS created, but the source match ${sourceId} could not be read, so none of its ` +
            `other settings were copied. The match exists with defaults — edit it here.` });
        }
      } catch {
        setMsg({ kind: "warn", text:
          `Match ${id} WAS created. Copying the remaining settings from ${sourceId} failed — the match ` +
          `exists with defaults and this editor is open on it.` });
      }
    }
    if (mode === "create") {
      // THE COPY ARRIVES WITHOUT A DATE, ON PURPOSE. Everything else is the source's.
      setStartAt(""); setEndAt("");
      setMeta((m) => ({ ...(m ?? {}), id: null, startDate: null, endDate: null }));
    }
  }, [id, mode, sourceId, ingest]);
  useEffect(() => { void load(); }, [load]);

  // HAS THE DATE OR TIME MOVED? Compared against the loaded wall-clock values via wallDate and
  // wallTime — never by constructing a Date from them, because the "Z" they carry is a lie and
  // parsing it re-shifts the clock into the viewer's zone. (Phrased without the literal call so
  // walltime-guard-test's source scan does not flag this comment as the very thing it warns about
  // — the guard is deliberately literal, and it caught this text on the first run.)
  /* MOVED IN FROM THE DRAWER — both of these existed ONLY there, and swapping the drawer's body
   * for this component would have deleted them from the product.
   *
   * TIMEZONE SHIFT: moving a match to a field in another zone keeps the clock reading and changes
   * the real instant. That warning belongs wherever the field can be changed alongside a time —
   * which, now that dates are editable here, is this component.
   *
   * DELETED MANAGER: a managerId pointing at a deleted account is KEPT exactly as loaded, never
   * blanked — blanking would report a change nobody made and then save it. */
  const tzWarn = useMemo(() => {
    if (!state || !loaded) return null;
    const from = fields.find((f) => f.id === Number(loaded.fieldId))?.city ?? (meta?.cityName as string | undefined);
    const to = fields.find((f) => f.id === Number(state.fieldId))?.city;
    return tzShift(from, to);
  }, [state, loaded, fields, meta]);

  const deletedManagers = useMemo(() => {
    const out: string[] = [];
    const named = (v: unknown) => typeof v === "string" && v.trim().length > 0;
    for (const [key, label] of [["managerId", "Manager"], ["secondManagerId", "Second manager"]] as const) {
      const id = Number(loaded?.[key] ?? 0);
      if (!id) continue;
      // In the list => resolvable. Absent => deleted or unresolved.
      const known = (managers as { id: number; name?: string }[]).some((x) => Number(x.id) === id && named(x.name));
      if (!known) out.push(label);
    }
    return out;
  }, [loaded, managers]);

  const dateMoved = useMemo(() => {
    if (mode !== "edit" || inverted || !meta?.startDate) return false;
    const si = String(meta.startDate);
    return (dDate !== "" && dDate !== wallDate(si)) || (dTime !== "" && dTime !== wallTime(si));
  }, [mode, inverted, meta, dDate, dTime]);

  const changedKeys = useMemo(() => {
    if (!state || !loaded) return [];
    const keys = diffKeys(EDITABLE_KEYS, loaded, state);
    // THE PAIR IS ONE CHANGE TO A READER AND TWO KEYS TO THE API. Both are listed so the diff the
    // user reads is the request that is sent — the route refuses one without the other.
    return dateMoved ? [...keys, "startDate", "endDate"] : keys;
  }, [state, loaded, dateMoved]);

  // THE PAYLOAD — the same key set the diff shows. Shared pick() with the drawer.
  const payload = useMemo(() => {
    const p = pick(state ?? {}, changedKeys.filter((k) => k !== "startDate" && k !== "endDate"));
    if (dateMoved && meta?.startDate && meta?.endDate) {
      const newStart = buildStartDate(dDate, dTime);
      p.startDate = newStart;
      // DURATION PRESERVED, to the minute: the end moves by exactly what the start moved.
      p.endDate = shiftedEndDate(String(meta.startDate), String(meta.endDate), newStart);
    }
    return p;
  }, [changedKeys, state, dateMoved, dDate, dTime, meta]);

  // THE DRAWER BLOCKS week-nav and card-switching while edits pend, so dirtiness is reported up.
  useEffect(() => { onDirtyChange?.(changedKeys.length > 0); }, [changedKeys.length, onDirtyChange]);

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
  const teamCount = Array.isArray(meta.teams) && (meta.teams as unknown[]).length >= 4 ? 4 : 2;
  const capContradiction = capacityContradiction(state, teamCount);

  // Blank/NaN numeric → empty box. A cleared numeric input stays "" in state, which
  // fieldChanged treats as no change, so it never reaches the diff or the body.
  const blank = (v: unknown) => v === "" || v == null || (typeof v === "number" && Number.isNaN(v));

  // A capacity input + its per-side hint. divisor = teams the total is split across
  // (teamCount for capacity-now, 2 or 4 for the format totals). 0 = not available.
  const capField = (key: string, label: string, divisor: number, zeroMsg: string) => {
    const dirty = fieldChanged(key, loaded[key], state[key]);
    const n = capNum(state[key]);
    const hint = n === null ? "—"
      : n === 0 ? zeroMsg
      : `${n} total, ${Math.round((n / divisor) * 10) / 10} a side`;
    return (
      <div className={`f${dirty ? " dirty" : ""}`} key={key} data-f={key}>
        <label>{label}</label>
        <input type="number" data-testid={`in-${key}`} value={blank(state[key]) ? "" : String(state[key])}
          onChange={(e) => set(key, e.target.value === "" ? (NULLABLE_NUM.has(key) ? null : "") : Number(e.target.value))} />
        <span className="hint" data-testid={`perside-${key}`}>{hint}</span>
      </div>
    );
  };

  const renderField = (f: Spec) => {
    if (f.cond && !f.cond(state)) return null;
    const dirty = fieldChanged(f.key, loaded[f.key], state[f.key]);
    const cls = `f${dirty ? " dirty" : ""}${f.wide ? " wide" : ""}`;
    const lbl = <label>{f.label}{f.hint ? <span className="hint">{f.hint}</span> : null}</label>;
    let ctl: React.ReactNode;
    if (f.kind === "select") ctl = (
      <select data-k={f.key} data-testid={`in-${f.key}`} value={String(state[f.key] ?? "")}
        onChange={(e) => set(f.key, e.target.value === "" ? null
          : (f.key === "fieldId" || f.key === "managerId" || f.key === "secondManagerId") ? Number(e.target.value)
          : e.target.value)}>
        {/* A NULLABLE SELECT NEEDS A WAY BACK TO NONE. Manager 2 is legitimately empty. */}
        {NULLABLE_NUM.has(f.key) && <option value="">— none —</option>}
        {/* THE CURRENT VALUE ALWAYS HAS AN OPTION, EVEN IF THE LIST HAS NEVER HEARD OF IT.
            Without this a managerId pointing at a deleted account silently becomes whichever id
            happens to be first — a change nobody made, saved on the next press. The drawer had
            this and porting the dropdown without it reintroduced exactly that bug; the assertion
            that caught it is the one kept from verify-schededit. */}
        {state[f.key] != null && String(state[f.key]) !== "" &&
          !(f.opts ?? []).some(([v]) => String(v) === String(state[f.key])) && (
          <option value={String(state[f.key])}>id {String(state[f.key])} — not in this list</option>
        )}
        {(f.opts ?? []).map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    );
    else if (f.kind === "money") ctl = (
      <div className="money"><span>$</span>
        <input type="number" step="0.01" data-testid={`in-${f.key}`} value={blank(state[f.key]) ? "" : (Number(state[f.key]) / 100).toFixed(2)}
          onChange={(e) => set(f.key, e.target.value === "" ? "" : Math.round(parseFloat(e.target.value) * 100))} /></div>
    );
    else if (f.kind === "number") ctl = (
      <input type="number" data-testid={`in-${f.key}`} value={blank(state[f.key]) ? "" : String(state[f.key])}
        onChange={(e) => set(f.key, e.target.value === "" ? (NULLABLE_NUM.has(f.key) ? null : "") : Number(e.target.value))} />
    );
    else if (f.kind === "textarea") ctl = <textarea data-testid={`in-${f.key}`} value={String(state[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
    else ctl = <input type="text" data-testid={`in-${f.key}`} value={String(state[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />;
    return <div className={cls} key={f.key} data-f={f.key}>{lbl}{ctl}</div>;
  };
  const renderToggle = (f: Spec) => {
    const dirty = fieldChanged(f.key, loaded[f.key], state[f.key]);
    return (
      <div className={`tg${dirty ? " dirty" : ""}`} key={f.key} data-f={f.key}>
        <button type="button" data-testid={`in-${f.key}`} aria-pressed={!!state[f.key]} onClick={() => set(f.key, !state[f.key])}><i /></button>
        <span><span className="tl">{f.label}</span><span className="th">{f.hint}</span></span>
      </div>
    );
  };
  const inGroup = (g: Spec["group"]) => FIELDS.filter((f) => f.group === g);

  /* CREATE — STEP ONE OF TWO.
   *
   * SINGLE-FIRE, AND NOT ONLY BY DISABLING THE BUTTON. `saving` stops a double click; the SERVER
   * refuses a second match at the same field and time, which is what stops a refresh mid-save, a
   * second tab, and a retry below us. Whether the API itself dedupes is UNKNOWN and this is how
   * that stops mattering.
   *
   * A 2xx IS NOT PROOF: the route reads the new match back and returns LANDED / UNKNOWN, and the
   * message says which. On success it hands straight to step two — the same editor, now editing
   * the real match, with the source's remaining fields already staged as changes.
   */
  const createMatch = async (allowDuplicate = false) => {
    if (saving) return;
    if (!startAt || !endAt) {
      setDateErr("Pick a start and end — the copy deliberately arrives without the original's date.");
      return;
    }
    setSaving(true); setMsg(null); setDupe(null);
    const iso = (local: string) => `${local.replace("T", "T")}:00.000Z`;
    const body = {
      match: {
        name: String(state?.name ?? ""),
        description: String(state?.description ?? ""),
        type: String(state?.type ?? "REGULAR"),
        startDate: iso(startAt),
        endDate: iso(endAt),
        fieldId: Number(state?.fieldId ?? 0),
        maxPlayerCount: Number(meta?.maxPlayerCount ?? 0),
        teamNumbers: Array.isArray(meta?.teams) ? (meta!.teams as Data[]).length : 2,
        isFreeMember: state?.isFreeMember === true,
      },
      allowDuplicate,
      source: "Copy match",
    };
    const res = await authFetch(`/api/matchday/${FULL_EDITOR_ENV}/matches/create`, {
      method: "POST", body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (res.status === 409 && json?.duplicate) {
      setDupe({ id: Number(json.duplicate.id), name: String(json.duplicate.name ?? "") });
      return;
    }
    if (!res.ok) { setMsg({ kind: "err", text: json?.error ?? `HTTP ${res.status}` }); return; }
    setCreated({ id: Number(json.id), outcome: String(json.outcome) });
    if (json.outcome === "LANDED" && json.id) {
      // STEP TWO. The remaining fields ride the PUT that already works.
      router.push(`/match-ops/matches/${json.id}?copyFrom=${sourceId ?? ""}`);
    } else {
      setMsg({ kind: "warn", text:
        `The create returned ${json.outcome}. It may or may not have landed — do NOT press it again; ` +
        `check the schedule for ${String(body.match.name)} at ${startAt} before retrying.` });
    }
  };

  const save = async () => {
    if (mode === "create") return createMatch();
    if (!changedKeys.length) return;
    setSaving(true); setMsg(null);
    // A DISTINCT SOURCE PER SURFACE. Without one, the drawer's writes logged as the route's
    // default and were indistinguishable from Match panel's — which is why an 8½-hour move on a
    // production match could not be attributed to whoever made it.
    const res = await authFetch(`/api/matchday/${FULL_EDITOR_ENV}/matches/${id}`, {
      method: "PUT",
      body: JSON.stringify({ changes: payload, source: variant === "panel" ? "Master Schedule drawer" : "Match editor" }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setMsg({ kind: json?.ambiguous ? "warn" : "err", text: json?.error ?? `HTTP ${res.status}` }); return; }
    noteLogResponse(json); // the write landed; surface a Change Log recording hole loudly
    ingest(json.match); setMsg({ kind: "ok", text: "Saved." });
  };
  const revert = () => setState(JSON.parse(JSON.stringify(loaded)));

  // WHO is in the match: real players (cancelled user-matches excluded), grouped by their
  // ACTUAL team and playerNumber — not a preview shape.
  const pname = (p: Data): string => {
    const u = (p.user ?? {}) as Data;
    const nm = [u.firstName, u.lastName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
    return nm || (u.email ? String(u.email) : `Player ${p.userId ?? p.id}`);
  };
  // Plain computations (NOT hooks) — this runs after the early "Loading…" return, so
  // useMemo here would change the hook count between renders.
  const activePlayers = (players as Data[]).filter((p) => !p.isCancelled);
  const rosterTeams = (() => {
    const teamsMeta = (Array.isArray(meta?.teams) ? (meta!.teams as Data[]) : []).slice()
      .sort((a, b) => Number(a.teamNumber) - Number(b.teamNumber));
    const cols = teamsMeta.map((t) => ({ teamNumber: Number(t.teamNumber), name: String(t.name ?? `Team ${t.teamNumber}`), players: [] as Data[] }));
    const byNum = new Map(cols.map((c) => [c.teamNumber, c]));
    for (const p of activePlayers) { const c = byNum.get(Number(p.team)); if (c) c.players.push(p); else cols[0]?.players.push(p); }
    for (const c of cols) c.players.sort((a, b) => Number(a.playerNumber) - Number(b.playerNumber));
    return cols;
  })();
  // Authoritative occupancy = the API's _count.players (real+fake), NOT players.length
  // (which counts cancelled rows and reads as over-capacity). Cap = maxPlayerCount; 0/blank
  // = special event (no cap).
  const occupancy = meta && meta.occupancy != null ? Number(meta.occupancy) : activePlayers.length;
  const cap = meta && meta.maxPlayerCount != null && Number(meta.maxPlayerCount) !== 0 ? Number(meta.maxPlayerCount) : null;
  const over = cap != null ? Math.max(0, occupancy - cap) : 0;
  const playerCount = occupancy; // the cancel card's "N signed up" uses the real occupancy

  return (
    <div className={"me" + (variant === "panel" ? " me-panel" : "")}>
      <style>{CSS}</style>
      <LogHealthBanner />

      {/* ONE HEADER, NOT TWO. In panel mode the drawer already carries the name, the id, the LIVE
          pill, the close and the sibling arrows — rendering this block as well printed all of it
          twice, which is the seam from putting one component into two presentations. On the PAGE
          it still renders, because nothing else supplies it there. */}
      {variant === "page" && (
      <div className="head">
        <div>
          <button className="backb" data-testid="editor-back" onClick={goBack} aria-label="Back">‹ Back</button>
          <h1 data-testid="title">{String(state.name)}</h1>
          <div className="hmeta">
            <span className="chip id">ID {String(meta.id)}</span>
            <span className={`chip ${meta.isCancelled ? "warn" : "live"}`}>{meta.isCancelled ? "Cancelled" : "Live"}</span>
            <span>{meta.startDate ? wallStamp(String(meta.startDate)) : "—"} · {String(meta.fieldTitle ?? "—")}{meta.cityName ? ` · ${String(meta.cityName)}` : ""}</span>
            {/* NO ENVIRONMENT PILL. Master Schedule and this editor cannot be pointed at different
                environments any more, so it fired on every match and was read on none of them. */}
          </div>
        </div>
      </div>
      )}

      {/* THE DUPLICATE REFUSAL. Never a silent second create — it names the match that already
          exists, links to it, and makes the override an explicit second action. */}
      {dupe && (
        <div className="dupe" data-testid="create-duplicate">
          <b>A match already exists at this field and time: {dupe.id}</b>
          {dupe.name ? <span> — {dupe.name}</span> : null}
          <div className="dupe-actions">
            <a href={`/match-ops/matches/${dupe.id}`} data-testid="create-duplicate-link">Open match {dupe.id}</a>
            <button type="button" data-testid="create-duplicate-override" disabled={saving}
              onClick={() => void createMatch(true)}>
              {saving ? "Creating…" : "Create it anyway"}
            </button>
            <button type="button" data-testid="create-duplicate-cancel" onClick={() => setDupe(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {created && created.outcome !== "LANDED" && (
        <div className="dupe" data-testid="create-unknown">
          <b>The create returned {created.outcome}.</b> It may or may not have landed — do not press it
          again. Check the schedule before retrying.
        </div>
      )}

      <div className="cols">
        <div>
          {/* Match */}
          <section className="card"><div className="ch"><h2>Match</h2><span className="cnt" data-testid="cnt-match">{groupCount("match") ? `${groupCount("match")} changed` : ""}</span></div>
            <div className="cb"><div className="grid">{inGroup("match").map(renderField)}
              {mode === "edit" ? (
                <>
                  {/* DATE AND START TIME ARE EDITABLE. They were disabled here with a sentence
                      telling you to fix a broken pair "in the full editor" — which was this page,
                      the one place that could not. The API accepts the pair, the route enforces
                      sending both together, and a production date change is on record as landed. */}
                  <div className="f"><label htmlFor="ed-date">Date{inverted ? <span className="hint">Held — see below.</span> : null}</label>
                    <input id="ed-date" data-testid="in-date" type="date" disabled={inverted}
                      value={dDate} onChange={(e) => { setDDate(e.target.value); setDateErr(null); }} /></div>
                  <div className="f"><label htmlFor="ed-time">Start time<span className="hint">The end moves with it — the match keeps its length.</span></label>
                    <input id="ed-time" data-testid="in-time" type="time" disabled={inverted}
                      value={dTime} onChange={(e) => { setDTime(e.target.value); setDateErr(null); }} /></div>
                  <div className="f"><label>Ends</label>
                    <input type="text" disabled data-testid="ed-endpreview"
                      value={meta.endDate ? hhmm12(wallTime(String(meta.endDate))) : "—"} /></div>
                  {inverted && (
                    <div className="f" data-testid="ed-inverted" style={{ gridColumn: "1 / -1" }}>
                      <div className="diffnote" style={{ color: "#8a4b12" }}>
                        <b>This match ends before it starts.</b> Its end ({meta.endDate ? hhmm12(wallTime(String(meta.endDate))) : "—"}) is on
                        or before its start ({meta.startDate ? hhmm12(wallTime(String(meta.startDate))) : "—"}). Date and time are held so an
                        edit cannot rewrite a broken pair from a negative duration. TO FIX IT: cancel this match and copy it
                        to the times you meant — Copy match on Master Schedule. Every other field here still saves.
                      </div>
                    </div>
                  )}
                  {/* MOVED IN FROM THE DRAWER — the clock stays, the real instant does not. */}
                  {tzWarn && (
                    <div className="f" data-testid="ed-tzwarn" style={{ gridColumn: "1 / -1" }}>
                      <div className="diffnote" style={{ color: "#8a4b12" }}>
                        Moving from {tzWarn.fromLabel} to {tzWarn.toLabel}. The clock stays {dTime ? hhmm12(dTime) : "the same"} — that is{" "}
                        {tzWarn.hours === 1 ? "one hour" : `${tzWarn.hours} hours`} {tzWarn.direction} in real terms.
                      </div>
                    </div>
                  )}
                  {/* ALSO MOVED IN. The id is kept exactly as loaded, never blanked. */}
                  {deletedManagers.length > 0 && (
                    <div className="f" data-testid="ed-delnote" style={{ gridColumn: "1 / -1" }}>
                      <div className="diffnote" style={{ color: "#8a4b12" }}>
                        {deletedManagers.join(" and ")} {deletedManagers.length === 1 ? "points" : "point"} at a deleted or
                        unresolved account. The id is kept exactly as loaded — nothing is blanked, so opening the match
                        reports no change you did not make.
                      </div>
                    </div>
                  )}
                  {dateErr && <div className="f" data-testid="ed-dateerr" style={{ gridColumn: "1 / -1", color: "#b3261e" }}>{dateErr}</div>}
                </>
              ) : (
                <>
                  {/* BLANK ON PURPOSE, AND REQUIRED. The one field a copy must not inherit. */}
                  <div className="f"><label>Start<span className="hint">Blank on purpose — a copy must not arrive carrying the original&rsquo;s date.</span></label>
                    <input type="datetime-local" data-testid="in-startDate" value={startAt}
                      onChange={(e) => { setStartAt(e.target.value); setDateErr(null); }} /></div>
                  <div className="f"><label>End<span className="hint">Same day unless you say otherwise.</span></label>
                    <input type="datetime-local" data-testid="in-endDate" value={endAt}
                      onChange={(e) => { setEndAt(e.target.value); setDateErr(null); }} /></div>
                  {dateErr && <div className="f" data-testid="create-dateerr" style={{ color: "#b3261e" }}>{dateErr}</div>}
                </>
              )}
            </div></div></section>

          {/* VEO COVERAGE — a separate call from the match PUT, and it says so. */}
          {typeof veo === "boolean" && onToggleVeo && (
            <section className="card" data-testid="ed-veo"><div className="ch"><h2>Veo coverage</h2><span className="cnt" /></div>
              <div className="cb"><div className="veorow">
                <div>
                  <div className="veolab">Camera assigned</div>
                  <div className="veosub">{veo ? "Counted in this week's camera nights." : "This match is not covered."}</div>
                </div>
                <button type="button" role="switch" aria-checked={veo} data-testid="ed-veo-switch"
                  aria-label="Camera assigned" className={"veosw" + (veo ? " on" : "")}
                  onClick={() => onToggleVeo(!veo)}><i /></button>
              </div>
              <div className="veohint">Veo lives in Clubhouse, not the MatchDay API — it saves the instant you flip it and is not part of the list below.</div>
              </div></section>
          )}

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
              {/* Capacity + growth path. Three independent TOTALS (not team sizes),
                  each with the implied per-side number. 0 = format unavailable.
                  maxTeamSize{2,4} keep the auto-bump-driven show/hide. */}
              <div className="grid" data-testid="capacity">
                {capField("maxPlayerCount", "Capacity now", teamCount, "special event (no cap)")}
                {state.isAutoBump ? capField("maxTeamSize2Team", "Total spots as 2 teams", 2, "not available as a 2-team match") : null}
                {state.isAutoBump ? capField("maxTeamSize4Team", "Total spots as 4 teams", 4, "not available as a 4-team match") : null}
              </div>
              {capContradiction ? (
                <div className="ladderNote" data-testid="cap-contradiction" style={{ marginTop: 4 }}>
                  <b>Capacity contradiction.</b> {capContradiction} Nothing is changed for you.
                </div>
              ) : null}
            </div></section>

          {/* Cancel — its own red card, never in the save bar */}
          <section className="card danger" data-testid="cancel-card"><div className="ch"><h2>Cancel this match</h2></div>
            <div className="cb"><div className="dz">
              <p><b>{playerCount === 0 ? "No players are signed up." : `${playerCount} player${playerCount === 1 ? "" : "s"} ${playerCount === 1 ? "is" : "are"} signed up.`}</b> Cancelling notifies every one of them and starts refunds. It is not part of Save — it happens on its own.</p>
              <button className="dbtn" data-testid="cancel-btn" aria-pressed={cancelArmed} onClick={() => setCancelArmed((a) => !a)}>{cancelArmed ? "Confirm cancel" : "Cancel match"}</button>
            </div>
            {cancelArmed ? <div className="ladderNote" style={{ marginTop: 10 }}>Would call <code>PATCH /admin/matches/{id}/cancel</code> — a separate action, not wired in this phase.</div> : null}</div></section>
        </div>

        {/* Roster — the ACTUAL roster: real names, grouped by real team + number. */}
        <div className="card sticky">
          <div className="ch"><h2>Players in the match</h2>
            <span className={"cnt cap" + (over > 0 ? " over" : "")} data-testid="pcount">
              {occupancy}{cap != null ? <> of {cap}{over > 0 ? <b data-testid="cap-over"> · over by {over}</b> : occupancy === cap ? " · full" : ""}</> : " · no cap (special event)"}
            </span>
          </div>
          <div className="cb">
            <div className="roster real" data-testid="roster">
              {rosterTeams.length === 0 && <div className="pfoot">No teams on this match.</div>}
              {rosterTeams.map((c) => (
                <div className="teamcol" data-testid="team-col" data-team={c.teamNumber} key={c.teamNumber}>
                  <div className="tch">{c.name} <span className="tcn">{c.players.length}</span></div>
                  {c.players.length === 0 ? <div className="slot open"><span className="open">no players</span></div>
                    : c.players.map((p) => (
                      <div className="slot filled" data-testid="slot" key={String(p.id)}>
                        <span className="sn">{String(p.playerNumber ?? "—")}</span>
                        <span className="pn" data-testid="player-name">{pname(p)}</span>
                        {(p.user as Data)?.isFakePlayer ? <span className="fkb">FAKE</span> : null}
                      </div>
                    ))}
                </div>
              ))}
            </div>
            <div className="pfoot">Real roster from MatchDay. {occupancy} counted toward the cap{activePlayers.length !== occupancy ? ` (${activePlayers.length} signed up)` : ""}. Add / Move / Remove are separate endpoints — use the roster editor.</div>
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
            <button className="btn go" data-testid="save"
              disabled={saving || !canEdit || (mode === "edit" && !changedKeys.length)}
              onClick={save} title={!canEdit ? "Read-only — you don't have EDIT MATCHES" : undefined}>
              {saving ? (mode === "create" ? "Creating…" : "Saving…") : (mode === "create" ? "Create match" : "Save")}
            </button>
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
.me .backb{background:none;border:0;padding:2px 0 6px;font-size:13px;font-weight:800;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.me .backb:hover{color:var(--forest)}
.me h1{margin:0;font-size:24px;font-weight:900;letter-spacing:-.5px;color:var(--forest)}
.me .hmeta{margin-top:7px;font-size:12.5px;color:var(--muted);display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.me .chip{font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;border-radius:99px;padding:3px 9px;white-space:nowrap}
.me .chip.live{background:var(--mintSoft);color:var(--mintInk);border:1px solid var(--mintEdge)}
.me .chip.id{background:var(--slot);color:var(--muted);border:1px solid var(--line);font-variant-numeric:tabular-nums}
.me .chip.warn{background:var(--amber);color:var(--amberInk);border:1px solid var(--amberEdge)}
/* PRODUCTION: unmistakable red pill (the editor writes live matches). */
.me .chip.prod{background:#E5121B;color:#fff;border:1px solid #E5121B;box-shadow:0 0 0 2px rgba(229,18,27,.30)}
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
.me .money span{position:absolute;left:11px;top:50%;transform:translateY(-50%);font-size:13px;font-weight:850;color:var(--muted);pointer-events:none}
/* [type=number] to out-specify ".me input[type=number]" — otherwise padding-left
   is 11px and the "$" overlay covers the leading digit ($12 -> $2). */
.me .money input[type=number]{padding-left:24px}
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
.me .roster{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.me .teamcol{border:1px solid var(--line);border-radius:10px;padding:8px;min-width:0}
.me .tch{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:7px;display:flex;align-items:center;gap:6px}
.me .tch .tcn{background:var(--slot);border:1px solid var(--line);border-radius:99px;padding:1px 7px;font-variant-numeric:tabular-nums;color:var(--forest)}
.me .slot{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;padding:6px 7px;border-bottom:1px solid #EDF1EC}
.me .slot:last-child{border-bottom:0}
.me .slot .sn{font-size:10px;font-weight:900;color:var(--faint);min-width:16px;font-variant-numeric:tabular-nums}
.me .slot .pn{min-width:0;overflow-wrap:anywhere}
.me .slot .fkb{margin-left:auto;font-size:9px;font-weight:900;letter-spacing:.4px;color:#7A5200;background:#FBF0DC;border:1px solid #E3C88A;border-radius:5px;padding:1px 5px}
.me .slot .open{color:var(--faint);font-weight:700}
.me .cnt.cap{font-variant-numeric:tabular-nums;color:var(--muted)}
.me .cnt.cap.over{color:#A83120;font-weight:800}.me .cnt.cap.over b{color:#A83120}
.me .pfoot{font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5}
.me .savebar{position:fixed;left:0;right:0;bottom:0;background:var(--paper);border-top:1px solid var(--line);box-shadow:0 -8px 24px rgba(0,51,38,.09);z-index:60}
/* PANEL MODE — the same content in Master Schedule's drawer. Only chrome changes: the drawer
   supplies the header and the production framing, so this stops claiming the viewport and the
   save bar sticks to the PANEL rather than spanning the screen behind it. */
/* THREE PARTS: the drawer's header stays, the BODY scrolls, the save bar stays. The panel used to
   be one long column inside a fixed-height drawer, so everything below Date and Start time was
   simply unreachable — Save and Revert are pinned at the bottom, and the form between them had
   nowhere to go. .cols is the body (a backtick here would END this template literal —
   which is exactly how this broke the first time); min-height:0 lets a flex child actually shrink and
   therefore scroll, and without it the column just grows and the overflow never engages. */
.me.me-panel{min-height:0;max-width:none;margin:0;background:transparent;padding:0;
  height:100%;display:flex;flex-direction:column}
.me.me-panel .cols{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 14px 10px}
.me.me-panel .savebar{position:static;flex:0 0 auto;box-shadow:0 -6px 18px rgba(0,51,38,.08)}
.me.me-panel .savebar .diff,.me.me-panel .sbin{max-width:none;padding-left:14px;padding-right:14px}
.me.me-panel .cols{grid-template-columns:1fr}
.me.me-panel .wrap{padding-left:14px;padding-right:14px}
/* Veo coverage — moved in from the drawer, same switch, same wording. */
.me .veorow{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--line);border-radius:10px;padding:12px 13px;background:var(--slot)}
.me .veolab{font-weight:700;font-size:13px}
.me .veosub{font-size:11.5px;color:var(--muted);margin-top:2px}
.me .veohint{font-size:11px;color:var(--faint);margin-top:8px;line-height:1.5}
.me .veosw{width:44px;height:25px;border-radius:999px;border:1px solid var(--line);background:#E7EBE7;position:relative;cursor:pointer;flex:none}
.me .veosw i{position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:left .15s}
.me .veosw.on{background:#0F6B4F;border-color:#0F6B4F}
.me .veosw.on i{left:22px}
.me .savebar .diff{max-width:1500px;margin:0 auto;padding:12px 24px 0}
.me .diffin{background:var(--blue);border:1px solid var(--blueEdge);border-radius:12px;padding:11px 14px}
.me .diffin h3{margin:0 0 8px;font-size:10px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--blueInk)}
.me .dl{display:flex;flex-wrap:wrap;gap:8px}
.me .di{background:#fff;border:1px solid var(--blueEdge);border-radius:99px;padding:5px 12px;font-size:11.5px;font-weight:850;color:var(--ink)}
.me .di b{color:var(--blueInk)}
.me .di s{color:var(--faint);text-decoration:line-through;font-weight:700}
.me .diffnote{font-size:11px;color:var(--blueInk);margin-top:9px;line-height:1.5;font-weight:700}
/* The duplicate refusal and the UNKNOWN outcome. Loud on purpose — both are states where pressing
   the button again is the wrong instinct. */
.me .dupe{margin:12px 0;padding:11px 13px;border:1.5px solid #e6c9a8;background:#fdf6ee;border-radius:12px;font-size:13px;color:#6b4a1f;line-height:1.55}
.me .dupe b{color:#5a3a12}
.me .dupe-actions{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
.me .dupe-actions a{font-weight:700;text-decoration:underline;color:#5a3a12}
.me .dupe-actions button{border:1px solid #e6c9a8;background:#fff;border-radius:8px;padding:4px 10px;font:inherit;font-size:12.5px;cursor:pointer;color:#5a3a12}
.me .dupe-actions button:disabled{opacity:.5;cursor:default}
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
