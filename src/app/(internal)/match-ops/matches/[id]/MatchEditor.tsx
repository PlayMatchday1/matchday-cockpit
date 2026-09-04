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
/* THE SAME MODEL MATCH PANEL USES. Two surfaces can open the same match and both write managerId;
 * giving each its own picker rule and its own confirmation wording is the two-paths-one-question
 * shape that put $1,815 and $2,006 on two screens for four months. One model, one answer. */
import {
  pickerOptions, confirmLines, normalizeManagerId, managerNameIn,
} from "@/lib/managerAssign";
import { FULL_EDITOR_ENV } from "@/lib/matchEnv";
import { useCancelMatch, cancelStakes } from "@/lib/useCancelMatch";
import MoneyInput from "@/components/MoneyInput";
/* THE SHAPE OF A MATCH COMES FROM ONE PLACE. teamCountWrites and teamShapeError are the same two
 * functions Match panel calls — pure functions of (teamCount, perTeam) and (total, teamCount), so
 * there is nothing panel-specific in them and nothing to fork. Reimplementing either here would
 * bring back the stale-rung bug that put production match 18125 at 5.5 players a team. */
import { teamCountWrites, teamShapeError } from "@/lib/rosterEditModel";
import { noteLogResponse } from "@/lib/logHealth";
import LogHealthBanner from "@/components/LogHealthBanner";
import { useAuth, canEditMatches } from "@/lib/useAuth";
import { wallDate, wallTime, buildStartDate, shiftedEndDate, isInvertedPair } from "@/lib/matchWallClock";
import { tzShift } from "@/lib/matchTimezone";

// MatchDay startDate/endDate are WALL-CLOCK strings mislabelled "…Z" (the true instant is
// startDateUtc). NEVER `new Date()` them — that re-shifts to the viewer's timezone and
// shows a wrong clock. Read the wall parts by slicing, exactly like the drawer.
const hhmm12 = (t: string) => { const [H, M] = t.split(":").map(Number); const ap = H >= 12 ? "PM" : "AM"; const h = H % 12 === 0 ? 12 : H % 12; return `${h}:${String(M).padStart(2, "0")} ${ap}`; };
/* ── A SECTION THAT STATES ITS VALUES WHILE SHUT ──────────────────────────────────────────────
 * All shut by default. The rule is the folded field chips': state what IS set, never what is
 * available — so the summary is the current values, not a list of what lives inside.
 *
 * A SHUT SECTION MUST NOT HIDE A PENDING CHANGE, so `dirty` puts a dot on the header. Without it
 * the save bar could list three changes with every section closed and nothing saying where they
 * are.
 */
function Section({ id, title, summary, dirty, danger, open, onToggle, children }: {
  id: string; title: string; summary?: React.ReactNode; dirty?: boolean; danger?: boolean;
  open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <section className={"card" + (danger ? " danger" : "")} data-testid={`sec-${id}`} data-open={open ? "1" : "0"} data-dirty={dirty ? "1" : "0"}>
      <button type="button" className="ch chbtn" data-testid={`sec-${id}-head`} aria-expanded={open} onClick={onToggle}>
        <h2>{title}{dirty ? <i className="dot" data-testid={`sec-${id}-dot`} aria-label="unsaved changes" /> : null}</h2>
        {!open && summary ? <span className="sum" data-testid={`sec-${id}-sum`}>{summary}</span> : null}
        <span className="caret" aria-hidden>{open ? "\u25b4" : "\u25be"}</span>
      </button>
      {open && <div className="cb">{children}</div>}
    </section>
  );
}

/** What a grid needs after a save. Everything the week and month cells render and the editor
 *  knows — player counts are deliberately absent, because a field edit cannot change them. */
export type SavedPatch = {
  name: string; startDate: string; endDate: string | null; venue: string | null; city: string | null;
  price: number | null; capacity: number | null; minPlayers: number | null; cancelled: boolean;
};

/** "Thu 17 Sep". A CALENDAR DATE, formatted at UTC midnight — these are wall-clock dates, and
 *  parsing one as a local instant is the trap that lands a Thursday match on Wednesday. */
function dayLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
}

/** "one-hour" / "90-minute" — the duration a shifted match keeps, said the way a person would. */
function matchLengthLabel(startIso: string, endIso: string): string {
  const mins = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return "same";
  if (mins % 60 === 0) { const h = mins / 60; return h === 1 ? "one-hour" : `${h}-hour`; }
  return `${mins}-minute`;
}
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

function specs(fields: FieldRow[], managers: { id: number; name: string; offCity?: boolean }[] = [],
               managers2: { id: number; name: string; offCity?: boolean }[] = managers): Spec[] {
  const fieldOpts: [number, string][] = fields.map((f) => [f.id, `${f.city ? f.city + " — " : ""}${f.title}`]);
  // An off-city person is LABELLED, never mixed in unmarked — the operator should be able to see
  // that the picker has been widened.
  const lbl = (m: { name: string; offCity?: boolean }) => (m.offCity ? `${m.name} \u00b7 other city` : m.name);
  /* TWO LISTS, because each select injects ITS OWN attached manager. Sharing one list put
   * Manager 1's off-roster person into Manager 2's dropdown as a selectable option. */
  const mgrOpts: [number, string][] = managers.map((m) => [m.id, lbl(m)]);
  const mgrOpts2: [number, string][] = managers2.map((m) => [m.id, lbl(m)]);
  return [
    { key: "name", group: "match", kind: "text", label: "Name", wide: true },
    { key: "fieldId", group: "match", kind: "select", label: "Field", opts: fieldOpts },
    { key: "category", group: "match", kind: "select", label: "Category", opts: CATS },
    { key: "type", group: "match", kind: "select", label: "Type", opts: TYPES },
    // A NAMED DROPDOWN, as the drawer had — not a raw id box. A currently-selected id that is NOT
    // in the list stays selected and labelled; it is never blanked, because blanking would report
    // a change nobody made and then save it.
    { key: "managerId", group: "match", kind: "select", label: "Manager 1", opts: mgrOpts },
    { key: "secondManagerId", group: "match", kind: "select", label: "Manager 2", opts: mgrOpts2, hint: "Leave empty if only one" },
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
    { key: "maxTeamSize2Team", group: "auto", kind: "number", label: "Max spots, 2 teams" },
    { key: "maxTeamSize4Team", group: "auto", kind: "number", label: "Max spots, 4 teams" },
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
export default function MatchEditor({ id, mode = "edit", sourceId, variant = "page", onDirtyChange, veo, onToggleVeo, onCancelLanded, onSaved }: {
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
  /* A SAVE THAT LANDED, reported up with the fields a grid draws, so the surface holding this
   * panel can patch its one card instead of refetching. This prop did not exist: MatchDrawer
   * declared an onSaved and had nothing to call it from, so the patch path below it had never
   * run once — a save left both grids showing the old values. */
  onSaved?: (id: number, patch: SavedPatch) => void;
  /* VEO COVERAGE, MOVED IN FROM THE DRAWER. Camera intent is a Clubhouse concept, not a MatchDay
   * one: it posts to /api/veo/intent and is NOT part of the match PUT — a separate call, exactly
   * as it was. The caller owns the value because it also owns the card badge that has to update;
   * the editor owns the control and the wording. */
  veo?: boolean;
  onToggleVeo?: (next: boolean) => void;
  /* A CANCEL THAT LANDED, reported up so the surface holding this panel can refresh itself. ONLY
   * on landed: NOT APPLIED and UNKNOWN leave the caller's screen exactly as it was, with the
   * message still on it. */
  onCancelLanded?: () => void;
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
  const [managersAll, setManagersAll] = useState<{ id: number; name: string }[]>([]);
  /* MANAGER CHANGES DO NOT RIDE ALONG ON "SAVE". This write decides who Manager Pay pays, so it
   * stops here first and names the person, the match and the amount. */
  const [mgrConfirm, setMgrConfirm] = useState<string[] | null>(null);
  const [players, setPlayers] = useState<Data[]>([]);
  const [meta, setMeta] = useState<Data | null>(null); // read-only bits (start/end, teams, isCancelled, occupancy)
  const [loaded, setLoaded] = useState<Data | null>(null);
  const [state, setState] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  /* CANCEL USES THE SHARED HOOK — the same one Gameday Ops' drawer calls. This panel used to
   * render a red "Confirm cancel" that fired nothing and admitted it in a footnote. A second
   * implementation of a write that texts players and credits accounts is the worst possible place
   * for drift, so there is one: useCancelMatch. */

  const mgrNameOf = (id: unknown) => managerNameIn([...managers, ...managersAll], id);
  /* THE CURRENT MANAGER IS ALWAYS AN OPTION — the same call the drawer makes, not a second
   * mechanism. Before this, an off-roster manager reached the select only through renderField's
   * generic "id N — not in this list" fallback: the right OUTCOME by a different route, with a
   * different label, and with pickerOptions' offCity flag never set. Measured on 17467 before the
   * change — value="74440", selectedIndex=1 of 15, nothing on the wire for a blind Save — so this
   * fixes a divergence, NOT a live mis-assignment. */
  const mgrPick = useMemo(() => pickerOptions(managers, managersAll, false,
    state?.managerId == null ? null
      : { id: Number(state.managerId), name: managerNameIn([...managers, ...managersAll], state.managerId) }),
    [managers, managersAll, state?.managerId]);
  const mgrPick2 = useMemo(() => pickerOptions(managers, managersAll, false,
    state?.secondManagerId == null ? null
      : { id: Number(state.secondManagerId), name: managerNameIn([...managers, ...managersAll], state.secondManagerId) }),
    [managers, managersAll, state?.secondManagerId]);
  const FIELDS = useMemo(() => specs(fields, mgrPick, mgrPick2), [fields, mgrPick, mgrPick2]);

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
    setFields(json.fields ?? []); setManagers(json.managers ?? []); setManagersAll(json.managersAllCities ?? []);
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

  /* TEAM COUNT MOVED. teamNumbers is WRITE_ONLY on the route (accepted on a PUT, absent from the
   * GET), so it is not in EDITABLE_KEYS and diffKeys can never see it. It is compared against the
   * STORED count — meta.teams.length — exactly as the date pair is compared against meta. */
  const teamsMoved = useMemo(() => {
    const staged = state?.teamNumbers;
    if (staged == null) return false;
    const stored = Array.isArray(meta?.teams) ? (meta!.teams as unknown[]).length : 0;
    return Number(staged) !== stored;
  }, [state, meta]);

  const changedKeys = useMemo(() => {
    if (!state || !loaded) return [];
    const keys = diffKeys(EDITABLE_KEYS, loaded, state);
    // THE PAIR IS ONE CHANGE TO A READER AND TWO KEYS TO THE API. Both are listed so the diff the
    // user reads is the request that is sent — the route refuses one without the other.
    const withDate = dateMoved ? [...keys, "startDate", "endDate"] : keys;
    return teamsMoved ? [...withDate, "teamNumbers"] : withDate;
  }, [state, loaded, dateMoved, teamsMoved]);

  // THE PAYLOAD — the same key set the diff shows. Shared pick() with the drawer.
  const payload = useMemo(() => {
    // teamNumbers rides through pick() like any other staged key — it is in changedKeys above.
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

  /* NOTHING IS OPEN BY DEFAULT. Shut, the drawer is a readable summary of the match; open, it is
   * the editor it always was. */
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({});
  const toggleSec = (k: string) => setOpenSec((o) => ({ ...o, [k]: !o[k] }));
  /* WHICH LONG FIELDS ARE OPEN. Neither renders a textarea until asked — Description and Manager
   * intro were ~130px of blank box each on a match that has neither. */
  const [openLong, setOpenLong] = useState<Record<string, boolean>>({});

  /* ── THE CHANGE LIST, AS ROWS ─────────────────────────────────────────────────────────────────
   * ONE LIST STILL DRIVES BOTH the panel and the request body — this shapes changedKeys for
   * reading, it does not decide what is sent. payload above is unchanged.
   *
   * THE BUG THIS FIXES. changedKeys appends "startDate" and "endDate" when the date moves, but
   * specs() defines neither, so FIELDS.find(...)?.label was undefined and fmt() returned "—" for
   * both sides — `loaded` carries the dates in meta, not in state. The panel whose whole job is to
   * say what is about to change rendered "— → —" for the date and the time, which are the two most
   * edited fields on a schedule.
   *
   * endDate IS NOT A ROW. It moves because the start moved — the duration is preserved to the
   * minute — so it is a clause on the Start row rather than a fourth change nobody made. */
  const diffRows = useMemo(() => {
    if (!state || !loaded) return [] as { key: string; label: string; from: string; to: string; note?: string }[];
    const rows: { key: string; label: string; from: string; to: string; note?: string }[] = [];
    for (const k of changedKeys) {
      if (k === "startDate" || k === "endDate") continue;   // handled as one pair below
      if (k === "teamNumbers") { rows.push({ key: k, label: "Teams", from: String(Array.isArray(meta?.teams) ? (meta!.teams as unknown[]).length : 0), to: String(state[k] ?? "") }); continue; }
      rows.push({ key: k, label: FIELDS.find((f) => f.key === k)?.label ?? k, from: fmt(k, loaded[k]), to: fmt(k, state[k]) });
    }
    if (dateMoved && meta?.startDate) {
      const si = String(meta.startDate);
      const oldDate = wallDate(si), oldTime = wallTime(si);
      if (dDate && dDate !== oldDate) {
        rows.push({ key: "startDate", label: "Date", from: dayLabel(oldDate), to: dayLabel(dDate) });
      }
      if (dTime && dTime !== oldTime) {
        // THE CONSEQUENCE, STATED. The end moves with the start and the match keeps its length —
        // that is a fact the operator did not type and would otherwise have to infer.
        const newEnd = meta.endDate ? wallTime(shiftedEndDate(si, String(meta.endDate), buildStartDate(dDate || oldDate, dTime))) : null;
        rows.push({
          key: "startTime", label: "Start", from: hhmm12(oldTime), to: hhmm12(dTime),
          note: newEnd ? `Ends ${hhmm12(newEnd)} — the match keeps its ${matchLengthLabel(si, String(meta.endDate))} length.` : undefined,
        });
      }
    }
    return rows;
  }, [changedKeys, state, loaded, FIELDS, dateMoved, meta, dDate, dTime]);


  /* ABOVE THE EARLY RETURNS. A hook after `if (!state) return …` runs on some renders and not
   * others, and React refuses: "Rendered more hooks than during the previous render." This is the
   * same trap the drawer's memos hit when they sat below `if (!orig) return`. */
  const cancel = useCancelMatch({
    env: FULL_EDITOR_ENV, matchId: id, source: "Master Schedule panel · cancel",
    authHeaders: async () => {
      const { data } = await supabase.auth.getSession();
      const t = data.session?.access_token;
      return t ? { Authorization: `Bearer ${t}` } : null;
    },
    onCancelled: async (landed) => { await load(); if (landed) onCancelLanded?.(); },
  });

  if (loadErr) return <div style={{ padding: 24, fontFamily: "system-ui" }}><h1>Match {id}</h1><p style={{ color: "#A83120" }}>Couldn’t load: {loadErr}</p></div>;
  if (!state || !loaded || !meta) return <div style={{ padding: 24, fontFamily: "system-ui", color: "#5C6B62" }}>Loading match {id}…</div>;

  const groupCount = (g: Spec["group"]) => changedKeys.filter((k) => FIELDS.find((f) => f.key === k)?.group === g).length;
  const ladderVals = LADDER.map((k) => Number(state[k]));
  const descending = ladderVals.every((v, i) => i === 0 || v <= ladderVals[i - 1]);
  /* THE STORED TEAM COUNT, not a guess between two. This read `>= 4 ? 4 : 2`, so every 3-team
   * match was reported as 2 — production 18136 is 3 × 6 and this panel said "18 total, 9 a side".
   * 28 of 711 non-cancelled matches over 8 weeks run 3 teams, so 3 is not a corner case. */
  const originTeams = Array.isArray(meta.teams) ? (meta.teams as unknown[]).length : 0;
  /* THE STAGED COUNT. teamNumbers is WRITE_ONLY on the route — accepted on a PUT, absent from the
   * GET — so it cannot be diffed out of `loaded` the way every other field is. It rides the same
   * explicit route the start/end pair does: appended to changedKeys and set on the payload when
   * it differs from the stored value. */
  const teamCount = state.teamNumbers == null ? originTeams : Number(state.teamNumbers);
  const capacityNow = capNum(state.maxPlayerCount) ?? 0;
  const perTeamNow = teamCount > 0 && capacityNow % teamCount === 0 ? capacityNow / teamCount : null;
  const shapeErr = teamShapeError(capacityNow, teamCount);
  /* SWITCHING MODE CARRIES THE CAPACITY WITH IT — the whole point of teamCountWrites. Staging the
   * count alone is what put a match into 4-team mode reading a rung nobody had set. A capacity
   * that does not divide has no honest per-team figure to carry, so it is left exactly as stored
   * rather than reshaped behind the operator. */
  const stageTeams = (target: number) => {
    set("teamNumbers", target);
    if (perTeamNow == null) return;
    const writes = teamCountWrites(target, perTeamNow);
    for (const [k, v] of Object.entries(writes)) set(k, v);
  };
  const setPerTeam = (per: number) => {
    if (per < 1) return;
    const writes = teamCountWrites(teamCount, per);
    for (const [k, v] of Object.entries(writes)) set(k, v);
  };
  const capContradiction = capacityContradiction(state, teamCount);

  // Blank/NaN numeric → empty box. A cleared numeric input stays "" in state, which
  // fieldChanged treats as no change, so it never reaches the diff or the body.
  const blank = (v: unknown) => v === "" || v == null || (typeof v === "number" && Number.isNaN(v));

  // A capacity input + its per-side hint. divisor = teams the total is split across
  // (teamCount for capacity-now, 2 or 4 for the format totals). 0 = not available.
  const capField = (key: string, label: string, divisor: number, zeroMsg: string, disabled = false) => {
    const dirty = fieldChanged(key, loaded[key], state[key]);
    const n = capNum(state[key]);
    /* THE TOTAL, STATED THE WAY MATCH PANEL STATES IT. These are TOTALS, not team sizes — the
     * standing trap: a "10 × 10" control sends 20. The 2-team rung reads "9 v 9 = 18 spots" and
     * the 4-team rung "4 × 9 = 36 spots", so the total is always the number on the right of the
     * equals sign and can never be mistaken for the per-side figure. Capacity-now keeps the
     * "N total, M a side" form because its divisor is the match's OWN team count, which is 3 as
     * often as it is 2 and has no v-notation. */
    const per = Math.round((n ?? 0) / divisor);
    const hint = n === null ? "—"
      : n === 0 ? zeroMsg
      : key === "maxTeamSize2Team" ? `${per} v ${per} = ${n} spots`
      : key === "maxTeamSize4Team" ? `4 × ${per} = ${n} spots`
      : `${n} total, ${Math.round((n / divisor) * 10) / 10} a side`;
    return (
      <div className={`f${dirty ? " dirty" : ""}`} key={key} data-f={key}>
        <label>{label}</label>
        <input type="number" data-testid={`in-${key}`} value={blank(state[key]) ? "" : String(state[key])} disabled={disabled}
          onChange={(e) => set(key, e.target.value === "" ? (NULLABLE_NUM.has(key) ? null : "") : Number(e.target.value))} />
        <span className="hint" data-testid={`perside-${key}`}>{hint}</span>
      </div>
    );
  };

  /* ── WHAT A SHUT SECTION SAYS ─────────────────────────────────────────────────────────────────
   * The current values, never a list of what the section contains. Same rule as the folded field
   * chips: state what IS set. A summary that read "price, spot price, guests" would tell an
   * operator nothing they could not guess from the heading. */
  const nz = (v: unknown) => v !== null && v !== undefined && v !== "" && Number(v) !== 0;
  const sumWhen = meta?.startDate
    ? `${dayLabel(dDate || wallDate(String(meta.startDate)))} \u00b7 ${hhmm12(dTime || wallTime(String(meta.startDate)))}${meta.endDate ? ` \u2013 ${hhmm12(wallTime(String(meta.endDate)))}` : ""}`
    : "not set";
  const sumMatch = [
    fields.find((f) => f.id === Number(state.fieldId))?.title,
    CATS.find((c) => c[0] === state.category)?.[1],
    mgrPick.find((m) => m.id === Number(state.managerId))?.name,
  ].filter(Boolean).join(" · ") || "not set";
  const sumMoney = [
    nz(state.registrationPrice) ? money(state.registrationPrice) : "free",
    nz(state.additionalSpotPrice) ? `${money(state.additionalSpotPrice)} spot` : "no spot price",
    `${Number(state.guestCount ?? 0)} guest${Number(state.guestCount ?? 0) === 1 ? "" : "s"}`,
  ].join(" · ");
  const sumSpots = LADDER.map((k) => (blank(state[k]) ? "—" : String(state[k]))).join(" → ");
  const sumAuto = [
    state.autoCanceled
      ? `Cancels ${Number(state.autoCanceledMinutes ?? 0)} min out under ${Number(state.minPlayerCount ?? 0)}`
      : "No auto-cancel",
    state.isFreeMember ? "free to members" : null,
    state.isAutoBump ? "bumps to tourney" : null,
  ].filter(Boolean).join(" · ");
  const sumCapacity = [
    `${Number(state.maxPlayerCount ?? 0)} total`,
    nz(state.maxTeamSize2Team) ? `2 teams \u00d7 ${Math.floor(Number(state.maxTeamSize2Team) / 2)}` : null,
  ].filter(Boolean).join(" · ");

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
    /* MoneyInput, shared with Match panel. It reformatted on every render here too — value was
       (cents/100).toFixed(2) — so the caret landed in the cents on every keystroke. The cents
       conversion is unchanged; only the display timing moved to focus/blur. */
    else if (f.kind === "money") ctl = (
      <div className="money"><span>$</span>
        <MoneyInput data-testid={`in-${f.key}`} cents={blank(state[f.key]) ? "" : (state[f.key] as number)}
          onCents={(v) => set(f.key, v)} /></div>
    );
    else if (f.kind === "number") ctl = (
      <input type="number" data-testid={`in-${f.key}`} value={blank(state[f.key]) ? "" : String(state[f.key])}
        onChange={(e) => set(f.key, e.target.value === "" ? (NULLABLE_NUM.has(f.key) ? null : "") : Number(e.target.value))} />
    );
    else if (f.kind === "textarea") {
      /* NO TEXTAREA IN THE DOM UNTIL ASKED. Set shows a two-line preview with Edit; empty says
         "Not set" and the button says Add — the VERB tells you which state it is in, which a
         disabled-looking empty box never did. */
      const txt = String(state[f.key] ?? "").trim();
      const isOpen = !!openLong[f.key];
      ctl = isOpen ? (
        <div className="longopen">
          <textarea data-testid={`in-${f.key}`} value={String(state[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} />
          <button type="button" className="longb" data-testid={`long-done-${f.key}`}
            onClick={() => setOpenLong((o) => ({ ...o, [f.key]: false }))}>Done</button>
        </div>
      ) : (
        <div className="longshut" data-testid={`long-${f.key}`} data-set={txt ? "1" : "0"}>
          <span className={"longtxt" + (txt ? "" : " none")}>{txt || "Not set"}</span>
          <button type="button" className="longb" data-testid={`long-open-${f.key}`}
            onClick={() => setOpenLong((o) => ({ ...o, [f.key]: true }))}>{txt ? "Edit" : "Add"}</button>
        </div>
      );
    }
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
    /* THE COPY SENDS WHAT STEP TWO WOULD HAVE STAGED — every EDITABLE_KEY, not the nine
     * structural ones. Sending nine is how production 18408 went live at $0: registrationPrice
     * was not in the body, and the API defaults an absent price to 0. Step two still runs and
     * still shows the diff, but it is a confirmation now rather than the only thing standing
     * between a live match and the wrong price.
     *
     * `state` IS THE SOURCE at this point — createMatch only runs in create mode, where the
     * editor was loaded from `sourceId`. So this is the source's own values, not defaults. */
    const copied: Record<string, unknown> = {};
    for (const k of EDITABLE_KEYS) {
      const v = state?.[k];
      // Absent stays absent; the route sends only what it is given.
      if (v !== undefined) copied[k] = v;
    }
    const body = {
      match: {
        ...copied,
        // The structural nine win over the copied values: the date is deliberately the operator's,
        // and the shape fields come from the source's live meta rather than its editable state.
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
    /* THE MIRROR ROW. A created match has none until this route inserts one, and without it the
     * match is invisible on Master Schedule — the page Copy match is launched from — until the
     * nightly cron. A failure here does NOT block the create: the match exists in MatchDay and
     * step two still runs. It is said out loud instead of leaving the operator to wonder why the
     * match they just made is not on the grid. */
    if (json.outcome === "LANDED" && json.mirrored === false
        && json.mirrorReason !== "not production" && json.mirrorReason !== "no read-back") {
      setMsg({ kind: "warn", text:
        `The match was created, but the Clubhouse copy was not (${json.mirrorReason ?? "unknown"}). ` +
        `It will not appear on Master Schedule until the nightly sync — run the matches sync on /data.` });
    }
    if (json.outcome === "LANDED" && json.id) {
      // STEP TWO. The remaining fields ride the PUT that already works.
      router.push(`/match-ops/matches/${json.id}?copyFrom=${sourceId ?? ""}`);
    } else {
      setMsg({ kind: "warn", text:
        `The create returned ${json.outcome}. It may or may not have landed — do NOT press it again; ` +
        `check the schedule for ${String(body.match.name)} at ${startAt} before retrying.` });
    }
  };

  const MGR_KEYS = ["managerId", "secondManagerId"];
  const save = async (confirmedMgr = false) => {
    if (mode === "create") return createMatch();
    if (!changedKeys.length) return;
    /* THE MANAGER GATE. Same rule and same wording as Match panel, because it is the same model —
     * a confirmation that says something different on two screens about one write is worse than
     * no confirmation, since whichever one you read feels authoritative. */
    const mgrChanged = changedKeys.filter((k) => MGR_KEYS.includes(k));
    if (mgrChanged.length > 0 && !confirmedMgr) {
      const lines: string[] = [];
      for (const k of mgrChanged) {
        const toId = normalizeManagerId(state[k]);
        const fromId = normalizeManagerId(loaded[k]);
        lines.push(...confirmLines({
          matchName: meta?.name == null ? null : String(meta.name),
          whenText: meta?.startDate ? `${wallDate(String(meta.startDate))} ${wallTime(String(meta.startDate))}` : null,
          cityLabel: (meta?.cityName as string | undefined) ?? null,
          fromName: fromId == null ? null : mgrNameOf(fromId),
          toName: toId == null ? null : mgrNameOf(toId),
          maxPlayerCount: meta?.maxPlayerCount == null ? null : Number(meta.maxPlayerCount),
          coManaged: normalizeManagerId(state.secondManagerId) != null,
          offCity: !![...mgrPick, ...mgrPick2].find((o) => o.id === toId)?.offCity,
        }).map((l) => (k === "secondManagerId" ? `Second manager — ${l}` : l)));
      }
      setMgrConfirm(lines);
      return;
    }
    setMgrConfirm(null);
    /* REFUSED ON THE PATH. Same rule as Match panel: a disabled button is a UI fact, and this is
     * the guard. A fractional team size is a thing the player app will render to real people. */
    if (teamShapeError(capNum(state.maxPlayerCount) ?? 0, Number(state.teamNumbers ?? (Array.isArray(meta?.teams) ? (meta!.teams as unknown[]).length : 0)))) return;
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
    /* REPORTED UP, from the SAVED RECORD the route read back — not from local state, which is
       what the operator typed rather than what landed. */
    const m = (json.match ?? {}) as Data;
    onSaved?.(Number(id), {
      name: String(m.name ?? ""),
      startDate: String(m.startDate ?? ""),
      endDate: m.endDate == null ? null : String(m.endDate),
      venue: m.fieldTitle == null ? null : String(m.fieldTitle),
      city: m.cityName == null ? null : String(m.cityName),
      price: m.registrationPrice == null ? null : Number(m.registrationPrice),
      capacity: m.maxPlayerCount == null ? null : Number(m.maxPlayerCount),
      minPlayers: m.minPlayerCount == null ? null : Number(m.minPlayerCount),
      cancelled: !!m.isCancelled,
    });
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

      {/* ── THE HEADER CARRIES THE MATCH ──────────────────────────────────────────────────────────
          The four facts you open a match to check, on one line, before any section is opened:
          when, how long, how full, what it costs.

          VEO IS HERE AND NOT A SECTION. It is one boolean that saves on its own the instant it is
          flipped — that does not earn a heading, a card and two lines of architecture. The switch
          says which state it is in rather than what it would do. */}
      {mode === "edit" && (
        <div className="mfacts" data-testid="ed-facts">
          <div className="mf1">
            <span className="mfcity">{meta.cityName ? String(meta.cityName) : ""}</span>
            <b className="mfname">{String(state.name ?? "")}</b>
          </div>
          <div className="mf2" data-testid="ed-facts-line">
            <span>{meta.startDate ? dayLabel(wallDate(String(meta.startDate))) : "—"}</span>
            <span>{meta.startDate ? hhmm12(wallTime(String(meta.startDate))) : "—"}{meta.endDate ? ` – ${hhmm12(wallTime(String(meta.endDate)))}` : ""}</span>
            <span>{occupancy}{cap != null ? ` of ${cap}` : " · no cap"}</span>
            <span>{money(state.registrationPrice)}</span>
          </div>
          <div className="mf3">
            <span className="chip id">ID {String(meta.id)}</span>
            {meta.cityName ? <span className="chip">{String(meta.cityName)}</span> : null}
            <span className={`chip ${meta.isCancelled ? "warn" : "live"}`}>{meta.isCancelled ? "Cancelled" : "Live"}</span>
            {typeof veo === "boolean" && onToggleVeo && (
              <button type="button" role="switch" aria-checked={veo} data-testid="ed-veo-switch"
                className={"veosw2" + (veo ? " on" : "")} onClick={() => onToggleVeo(!veo)}>
                <i /> {veo ? "Covered" : "No camera"}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="cols">
        <div>
          {/* WHEN. Split out of Match, where the date and the time sat in the same grid as the
              name, the field and two manager pickers. They are the first thing looked up and the
              most edited pair on the drawer; they are not a property of the match's description. */}
          <Section id="when" title="When" open={!!openSec.when} onToggle={() => toggleSec("when")}
            dirty={dateMoved} summary={sumWhen}>
            <div className="grid">
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
            </div>
          </Section>

          {/* Match */}
          <Section id="match" title="Match" open={!!openSec.match} onToggle={() => toggleSec("match")}
            dirty={groupCount("match") > 0} summary={sumMatch}>
            <div>
              {/* THE "SHOW MANAGERS FROM ALL CITIES" ESCAPE STOOD HERE AND IS GONE, for the reason
                  it went from the drawer: over 90 days it produced ZERO assignments, because every
                  one of the 100 matches carrying an off-roster manager carries one of 8 people on
                  NO city's roster — people this control never offered either. Two pages must not
                  disagree about what the manager picker is. */}
              <div className="grid">{inGroup("match").map(renderField)}</div>
            </div>
          </Section>

          <section className="card">
            <div className="cb"><div id="teamsRO">{(Array.isArray(meta.teams) ? meta.teams as Data[] : []).map((t) => (
              <div className="team" key={String(t.id)}><span className="nm"><i className="sw" style={{ background: Number(t.teamNumber) === 1 ? "#fff" : "#14352A" }} />{String(t.name)}</span>
                <div className="ro">{t.price == null ? "no price" : money(t.price)}{t.locked ? " · locked" : ""}</div></div>
            ))}</div>
            </div></section>

          <Section id="money" title="Money" open={!!openSec.money} onToggle={() => toggleSec("money")}
            dirty={groupCount("price") > 0} summary={sumMoney}>
            <div className="grid">{["registrationPrice", "additionalSpotPrice"].map((k) => renderField(inGroup("price").find((f) => f.key === k)!))}</div>
            {/* GUEST COUNT ON ITS OWN ROW. The three-across grid was repeat(3,1fr), and `1fr` is
                minmax(AUTO,1fr) — a track cannot shrink below its own min-content, so the two money
                inputs took what they needed and the third collapsed onto its longest word. Measured
                at 580px: a 43px column wrapping nine words over seven lines. Given the row to
                itself, the hint sits beside the input at full width. */}
            <div className="guestrow">{renderField(inGroup("price").find((f) => f.key === "guestCount")!)}</div>
          </Section>

          <Section id="spots" title="Spots shown" open={!!openSec.spots} onToggle={() => toggleSec("spots")}
            dirty={groupCount("ladder") > 0} summary={sumSpots}>
            <div><div className="ladder">{inGroup("ladder").map(renderField)}</div>
              <div className="ladderNote" data-testid="ladder-note">{descending
                ? "Spots still unsold are released back at each mark. Each number should be no higher than the one before it."
                : <><b>These should descend.</b> {ladderVals.join(" → ")} rises at some point, which releases more spots closer to kick-off than further out.</>}</div></div>
          </Section>

          <Section id="auto" title="Automation" open={!!openSec.auto} onToggle={() => toggleSec("auto")}
            dirty={groupCount("auto") > 0} summary={sumAuto}>
            <div>
              {renderToggle(inGroup("auto").find((f) => f.key === "autoCanceled")!)}
              <div className="grid">{["autoCanceledMinutes", "minPlayerCount"].map((k) => renderField(inGroup("auto").find((f) => f.key === k)!))}</div>
              {renderToggle(inGroup("auto").find((f) => f.key === "isFreeMember")!)}
              {renderToggle(inGroup("auto").find((f) => f.key === "isAutoBump")!)}
            </div>
          </Section>

          {/* CAPACITY IS ITS OWN SECTION. It lived inside Automation, but "how many people fit"
              is not an automation rule — it is the first thing looked up and the last thing
              guessed at, and it was three scrolls down inside a card about auto-cancelling. */}
          <Section id="capacity" title="Capacity" open={!!openSec.capacity} onToggle={() => toggleSec("capacity")}
            dirty={["maxPlayerCount", "maxTeamSize2Team", "maxTeamSize4Team", "teamNumbers"].some((k) => changedKeys.includes(k))}
            summary={sumCapacity}>
            <div>
              {/* Capacity + growth path. Three independent TOTALS (not team sizes),
                  each with the implied per-side number. 0 = format unavailable.
                  maxTeamSize{2,4} keep the auto-bump-driven show/hide. */}
              {/* NOBODY DECIDES "36". They decide how many teams and how many a side, and the
                  capacity falls out — so the two controls are TEAMS and SPOTS PER TEAM and the
                  total is derived and read-only. Same three controls, same wording and the same
                  two shared functions as Match panel.

                  THE PICKER OFFERS 2 / 3 / 4 and 3 is real: 28 of 711 non-cancelled matches over
                  8 weeks run 3 teams. What 3 lacks is a RUNG — the API models only
                  maxTeamSize2Team and maxTeamSize4Team — so selecting it writes maxPlayerCount
                  alone, which is what teamCountWrites does and why it is not reimplemented here. */}
              <div className="grid" data-testid="shape">
                <div className="f" data-f="teamNumbers">
                  <label>Teams{teamsMoved ? <span className="hint">staged — was {originTeams}</span> : null}</label>
                  <div className="seg" role="group" aria-label="Team count" data-testid="me-teams-seg">
                    {[2, 3, 4].map((n) => (
                      <button type="button" key={n} data-testid={`me-teams-${n}`} data-on={teamCount === n ? "true" : "false"}
                        aria-pressed={teamCount === n} className={teamCount === n ? "on" : ""}
                        disabled={!canEdit} onClick={() => stageTeams(n)}>{n}</button>
                    ))}
                  </div>
                </div>
                <div className="f">
                  <label>Spots per team<span className="hint">{teamCount} teams</span></label>
                  {perTeamNow != null ? (
                    <div className="step" data-testid="me-step">
                      <button type="button" data-testid="me-spt-minus" aria-label="Fewer per team"
                        disabled={!canEdit || capacityNow <= teamCount} onClick={() => setPerTeam(perTeamNow - 1)}>−</button>
                      <span className="stepv" data-testid="me-spt">{perTeamNow}</span>
                      <button type="button" data-testid="me-spt-plus" aria-label="More per team"
                        disabled={!canEdit} onClick={() => setPerTeam(perTeamNow + 1)}>+</button>
                    </div>
                  ) : (
                    // The TRUE stored total, never a rounded one — a match that got here must not
                    // be silently reshaped into something the stepper could say.
                    <span className="ro" data-testid="me-spt-na">{teamCount > 0
                      ? `${capacityNow} total doesn't divide evenly into ${teamCount} teams — shown as stored.`
                      : `Team count unknown — stored capacity is ${capacityNow}.`}</span>
                  )}
                </div>
                <div className="f">
                  <label>Capacity<span className="hint">derived</span></label>
                  <span className="ro" data-testid="me-capacity" data-value={capacityNow}>
                    {perTeamNow != null ? `${capacityNow} total — ${teamCount} teams × ${perTeamNow}` : `${capacityNow} total`}
                  </span>
                </div>
              </div>
              {/* THE BLOCK. A total that does not divide by the team count shows as a FRACTIONAL
                  team size in the player app — 22 across 4 teams reads 5.5 — so it is refused with
                  the reason on screen and Save is disabled. Same function, same message as Match
                  panel; the check on the save PATH is below, because a disabled button is a UI
                  fact and not a guard. */}
              {shapeErr && <div className="ladderNote bad" data-testid="me-shape-err" style={{ marginTop: 4 }}>{shapeErr}</div>}
              <div className="grid" data-testid="capacity">
                {capField("maxPlayerCount", "Capacity now", teamCount, "special event (no cap)")}
                {/* ALWAYS RENDERED, as Match panel renders them. The 4-team rung GREYS OUT when
                    auto bump is off rather than vanishing: a control that disappears reads as
                    "this match has no 4-team total", which is a different claim from "this match
                    will not grow into one". The stored number is still shown either way. */}
                {capField("maxTeamSize2Team", "Max spots, 2 teams", 2, "not available as a 2-team match")}
                {capField("maxTeamSize4Team", "Max spots, 4 teams", 4, "not available as a 4-team match", !state.isAutoBump)}
              </div>
              {capContradiction ? (
                <div className="ladderNote" data-testid="cap-contradiction" style={{ marginTop: 4 }}>
                  <b>Capacity contradiction.</b> {capContradiction} Nothing is changed for you.
                </div>
              ) : null}
            </div>
          </Section>

          {/* Cancel — its own red card. NEVER part of Save: Save sends the field diff, this fires a
              different endpoint with its own confirmation and its own verdict. */}
          <section className="card danger" data-testid="cancel-card">
            <div className="cb"><div className="dz">
              {/* ONE LINE, AND IT IS DATA. The count is the LIVE roster read at confirm time once
                  the preview arrives, not the render-time occupancy — the sentence is a promise to
                  real people. It says CREDITS, not refunds: the endpoint's own audit proved the
                  wallet credit and the SMS are server-side effects of the one PATCH, and no card
                  charge is reversed. */}
              <p data-testid="cancel-stakes"><b>{cancelStakes(cancel.preview ? cancel.preview.count : playerCount)}</b></p>
              {cancel.preview?.alreadyCancelled ? (
                <div className="ladderNote" data-testid="cancel-already">This match is already cancelled — nothing to do.</div>
              ) : !cancel.preview ? (
                <button className="dbtn" data-testid="cancel-btn" disabled={cancel.busy || !canEdit}
                  title={canEdit ? undefined : "Cancelling a match needs EDIT MATCHES."}
                  onClick={() => void cancel.open()}>{cancel.busy ? "Reading…" : "Cancel match"}</button>
              ) : (
                /* YES / NO. The type-to-confirm box is gone — it rendered as grey placeholder
                   text that reads DISABLED, and it was never a requirement. Two buttons, both
                   legible, neither wrapping: .cancelrow gives them room and .nowrap holds them
                   on one line. */
                <div data-testid="cancel-confirm" className="cancelrow">
                  <button className="secondary nowrap" data-testid="cancel-abort" onClick={cancel.abort}>Keep the match</button>
                  {/* DISABLES ON CLICK and stays disabled until the response returns — `busy` is
                      set before the fetch. A control that stays clickable during a write that
                      texts people is a control that texts them twice. */}
                  <button className="dbtn nowrap" data-testid="cancel-do" disabled={cancel.busy}
                    onClick={() => void cancel.run()}>{cancel.busy ? "Cancelling…" : "Cancel the match"}</button>
                </div>
              )}
            </div>
            {cancel.result && <div className="ladderNote" data-testid="cancel-result" style={{ marginTop: 10 }}>{cancel.result}</div>}
            </div></section>
        </div>

        {/* Roster — the ACTUAL roster: real names, grouped by real team + number. */}
        <Section id="roster" title="Roster" open={!!openSec.roster} onToggle={() => toggleSec("roster")}
          summary={<span className={over > 0 ? "over" : undefined} data-testid="pcount">
            {occupancy}{cap != null ? <> of {cap}{over > 0 ? <b data-testid="cap-over"> · over by {over}</b> : occupancy === cap ? " · full" : ""}</> : " · no cap (special event)"}
          </span>}>
          <div>
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
            <div className="pfoot">{occupancy} counted toward the cap{activePlayers.length !== occupancy ? ` (${activePlayers.length} signed up)` : ""} — use the roster editor to add, move or remove.</div>
          </div>
        </Section>
      </div>

      {/* Sticky save bar — diff panel IS the payload; Cancel is NOT here */}
      <div className="savebar" data-testid="savebar">
        {diffRows.length ? (
          <div className="diff"><div className="diffin">
            {/* THE IDEA IS UNCHANGED — one list drives both this panel and the request body. Only
                the language changed: it was written as a note to an engineer about PUT semantics,
                and the person reading it is deciding whether to press save. */}
            <h3>{diffRows.length} change{diffRows.length === 1 ? "" : "s"} ready to save</h3>
            {/* ROWS, NOT CHIPS. A chip wraps badly the moment a value is a field name, and these
                values are field names, times and money. */}
            <div className="dl" data-testid="diff-list">{diffRows.map((r) => (
              <div className="di" data-testid="diff-item" data-key={r.key}
                data-from={JSON.stringify(r.from)} data-to={JSON.stringify(r.to)} key={r.key}>
                <span className="dk">{r.label}</span>
                <s>{r.from}</s>
                <span className="dar" aria-hidden>→</span>
                <b>{r.to}</b>
                {r.note && <span className="dn" data-testid="diff-note">{r.note}</span>}
              </div>
            ))}</div>
            <div className="diffnote">Nothing else on this match is touched.</div>
          </div></div>
        ) : <div className="nochanges" data-testid="no-changes">No changes yet.</div>}
        {/* THE MANAGER CONFIRMATION, ON THE SAVE BAR. Cancel sends nothing — there is no request in
            flight while this is open. */}
        {mgrConfirm && (
          <div className="mgrconfirm" data-testid="mgr-confirm">
            <b>This changes who gets paid for this match.</b>
            <ul>{mgrConfirm.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <div className="mgrconfirm-b">
              <button className="btn" data-testid="mgr-cancel" onClick={() => setMgrConfirm(null)}>Cancel — send nothing</button>
              <button className="btn go" data-testid="mgr-go" disabled={saving} onClick={() => { void save(true); }}>
                {saving ? "Sending…" : "Confirm and send"}</button>
            </div>
          </div>
        )}
        <div className="sbin">
          <span className="sbtxt" data-testid="sb-text">{changedKeys.length ? <><b>{changedKeys.length}</b> {changedKeys.length === 1 ? "change" : "changes"} not saved</> : "No changes"}</span>
          {msg ? <span className="sbmsg" data-testid="sb-msg" style={{ color: msg.kind === "ok" ? "#046B45" : msg.kind === "warn" ? "#7A5200" : "#A83120" }}>{msg.kind === "warn" ? "⚠ " : ""}{msg.text}</span> : null}
          <span className="sbact">
            <button className="btn" data-testid="revert" disabled={!changedKeys.length || saving} onClick={revert}>Revert</button>
            <button className="btn go" data-testid="save"
              disabled={saving || !canEdit || !!shapeErr || (mode === "edit" && !changedKeys.length)}
              onClick={() => { void save(); }} title={!canEdit ? "Read-only — you don't have EDIT MATCHES" : undefined}>
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
/* THE CHANGE LIST — a label column, the old value struck through, an arrow, the new value bold.
   The consequence line (the end time moving with the start) spans the row underneath it. */
.me .dl{display:flex;flex-direction:column;gap:7px}
.me .di{display:grid;grid-template-columns:104px auto 14px 1fr;align-items:baseline;gap:8px;font-size:12.5px}
.me .di .dk{font-weight:800;color:var(--ink)}
.me .di s{color:var(--faint);text-decoration:line-through}
.me .di .dar{color:var(--faint)}
.me .di b{font-weight:800;color:var(--ink)}
.me .di .dn{grid-column:2/-1;font-size:11.5px;font-weight:600;color:var(--faint);line-height:1.4}
.me .card{background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 9px 26px rgba(0,51,38,.06);margin-bottom:16px;overflow:hidden}
.me .card.sticky{position:sticky;top:16px}
.me .ch{display:flex;align-items:center;gap:11px;padding:13px 18px;border-bottom:1px solid var(--line)}
.me .ch h2{margin:0;font-size:12px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.me .ch .cnt{margin-left:auto;font-size:11px;font-weight:850;color:var(--mintInk)}
.me .cb{padding:15px 18px}
.me .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:13px}
.me .grid.three{grid-template-columns:repeat(3,1fr)}
/* Guest count: the control on the left at its natural width, the hint beside it with the rest. */
.me .guestrow{margin-top:13px}
.me .guestrow .f{display:grid;grid-template-columns:120px 1fr;align-items:start;gap:12px}
.me .guestrow .f label{grid-column:1;font-size:11px}
.me .guestrow .f label .hint{display:none}
.me .guestrow .f input{grid-column:1;grid-row:2}
.me .guestrow .f::after{content:"Spots a player can buy for someone with no account";grid-column:2;grid-row:1/3;align-self:center;font-size:11.5px;font-weight:600;color:var(--faint);line-height:1.45}
/* Long fields, folded. */
.me .longshut{display:flex;align-items:flex-start;gap:10px}
.me .longtxt{flex:1;min-width:0;font-size:12.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.me .longtxt.none{color:var(--faint);font-style:italic}
.me .longb{flex:none;border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:5px 11px;font:inherit;font-size:11.5px;font-weight:700;color:var(--ink);cursor:pointer}
.me .longopen{display:flex;flex-direction:column;gap:7px;align-items:flex-start}
.me .longopen textarea{width:100%}
/* Collapsible section chrome. */
.me .chbtn{width:100%;background:none;border:0;border-bottom:1px solid var(--line);text-align:left;cursor:pointer;font:inherit}
.me .chbtn h2{display:flex;align-items:center;gap:7px}
.me .chbtn .dot{width:7px;height:7px;border-radius:50%;background:#C9721B;flex:none}
.me .chbtn .sum{margin-left:auto;font-size:11.5px;font-weight:600;color:var(--muted);text-align:right;min-width:0}
.me .mfacts{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:13px 16px;margin-bottom:16px}
.me .mf1{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.me .mfcity{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.me .mfname{font-size:16px;font-weight:800;letter-spacing:-.2px;min-width:0}
.me .mf2{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:5px;font-size:13px;font-weight:700;color:var(--ink)}
.me .mf2 span+span::before{content:"\\00b7";margin-right:12px;color:var(--faint);font-weight:400}
.me .mf3{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:9px}
.me .veosw2{display:inline-flex;align-items:center;gap:7px;margin-left:auto;border:1px solid var(--line);background:var(--paper);border-radius:999px;padding:4px 11px 4px 5px;font:inherit;font-size:11.5px;font-weight:700;color:var(--muted);cursor:pointer}
.me .veosw2 i{width:30px;height:17px;border-radius:999px;background:#E7EBE7;position:relative;flex:none;transition:background .15s}
.me .veosw2 i::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}
.me .veosw2.on{color:#0F6B4F;border-color:#BEDCCB}
.me .veosw2.on i{background:#0F6B4F}
.me .veosw2.on i::after{left:15px}
.me .nochanges{font-size:12px;font-weight:600;color:var(--faint);padding:2px 2px 6px}
.me .chbtn .caret{margin-left:9px;flex:none;color:var(--faint);font-size:11px}
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
/* THE TWO CANCEL BUTTONS. "Keep the match" was an unstyled <button class="secondary"> — there was
   no .secondary rule in this stylesheet — so it inherited the browser default, took no width in a
   flex row that had already given .dbtn margin-left:auto, and wrapped onto THREE LINES. Both now
   have a real style, room, and white-space:nowrap. The row owns the margin-left:auto so .dbtn
   stops pushing against its sibling. */
/* TEAMS / SPOTS PER TEAM / CAPACITY — the same three controls Match panel renders, styled to
   this panel's own tokens rather than importing its stylesheet. */
.me .seg{display:inline-flex;background:var(--slot);border-radius:10px;padding:3px;gap:3px}
.me .seg button{border:0;background:transparent;border-radius:8px;padding:6px 16px;min-height:32px;
  font:inherit;font-size:13px;font-weight:800;color:var(--muted);cursor:pointer}
.me .seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.10)}
.me .seg button:disabled{opacity:.5;cursor:not-allowed}
.me .step{display:inline-flex;align-items:center;gap:4px}
.me .step button{width:32px;height:32px;border:1px solid var(--line);background:#fff;border-radius:8px;
  font:inherit;font-size:15px;font-weight:900;color:var(--forest);cursor:pointer;flex:none}
.me .step button:disabled{opacity:.45;cursor:not-allowed}
.me .stepv{min-width:34px;text-align:center;font-size:14px;font-weight:900;color:var(--ink);
  font-variant-numeric:tabular-nums}
.me .ro{font-size:12.5px;font-weight:800;color:var(--ink);padding:7px 0;line-height:1.45}
.me .ladderNote.bad{border-color:var(--coralEdge);background:var(--coral);color:var(--coralInk);font-weight:800}
.me .cancelrow{margin-left:auto;display:flex;align-items:center;gap:10px;flex:none}
.me .cancelrow .dbtn{margin-left:0}
.me .nowrap{white-space:nowrap}
.me .secondary{background:#fff;border:1px solid var(--line);color:var(--forest);font-family:inherit;
  font-size:12px;font-weight:900;border-radius:9px;padding:9px 15px;cursor:pointer;flex:none}
.me .secondary:hover{background:var(--slot)}
/* The stakes sentence keeps the room it needs; the buttons take theirs. */
.me .dz p{flex:1 1 auto;min-width:0}
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
.mgrconfirm{border-top:1px solid #F0C98A;background:#FFF7EA;padding:11px 16px;font-size:13px;color:#5E3D05;line-height:1.5}
.mgrconfirm b{display:block;margin-bottom:5px;color:#4A3004}
.mgrconfirm ul{margin:0 0 9px;padding-left:18px}
.mgrconfirm li{margin:2px 0}
.mgrconfirm-b{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
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
