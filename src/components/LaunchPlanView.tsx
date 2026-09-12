"use client";

// ONE FIELD'S GO-TO-MARKET PLAN — /growth/launch/[venueId].
//
// Ryan: "on launch tab we need to build a nice go to market plan for each new field that has
// actions we can assign and countdowns and a days till launch and launch and post launch counter
// type thing. It should be visually beautiful. Appealing to everyone to look at. Easy too follow"
//
// ══ THE ONE DESIGN DECISION WORTH READING ════════════════════════════════════════════════════
// A TASK BELONGS TO THE PHASE ITS DEADLINE FALLS IN, NOT THE ONE IT STARTS IN. Built on the start
// week first, Build-up held 18 of 23 and Sustain was EMPTY — every long-running task starts early,
// so three phases stopped dividing anything and became three headings. On the deadline it is
// 10 / 7 / 7, and the group answers the question the page exists for: what has to be finished
// before this phase is over.
//
// ══ THE LAUNCH DATE IS NOT ON THIS PAGE'S RECORDS ════════════════════════════════════════════
// It lives on fin_venues.launch_date, alone. Every date here is computed from it, so moving it
// moves the whole plan in one write instead of 24.
//
// ══ NOTHING HERE MESSAGES ANYONE ═════════════════════════════════════════════════════════════
// No texts, no emails, no chat writes. This is a checklist.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  PHASES,
  PLAN_WEEKS,
  SCOPES,
  SCOPE_KEYS,
  STATE_ICON,
  STATE_LABEL,
  STATE_RANK,
  counterFor,
  daysToLaunch,
  fmtLaunchDate,
  isLive,
  phaseOfWeek,
  shortCountdown,
  stateOf,
  weekOf,
  type PlanPhase,
  type ScopeKey,
} from "@/lib/launchPlan";
import {
  PLAN_TASK_COLUMNS,
  loadTasksForVenues,
  seedLaunchPlan,
  isMissingTable,
  type PlanTask,
} from "@/lib/launchTasks";

/* NO BACKTICK MAY APPEAR IN THIS BLOCK - it is inside a template literal. One ends the string and
 * tsc reports the resulting error on a line that has nothing to do with it. */
const LP_CSS = `
.lp{color-scheme:light;
  --surface:#F4F7F5; --card:#fff; --line:#E3EAE6; --line-soft:#EEF3F0;
  --ink:#12241d; --ink-2:#5c7267; --ink-3:#8b9a93; --deep:#0d3b2e; --mint:#CFEEE0;
  /* STATUS IS RESERVED AND NEVER REUSED FOR IDENTITY. Scope wears ink, not hue - see
     src/lib/launchPlan.ts for the validator report that cut the scope palette. */
  --ok:#0ca30c; --warn:#fab219; --crit:#d03b3b;
  background:var(--surface);color:var(--ink);padding:14px;min-height:100%;
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.lp *{box-sizing:border-box}
.lp-wrap{max-width:980px;margin:0 auto}
.lp-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}

.lp-navrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:11px}
.lp-back{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:0 12px;
  border:1px solid var(--line);border-radius:9px;background:#fff;text-decoration:none;
  color:var(--ink-2);font-size:12px;font-weight:750}
.lp-swlab{margin-left:auto;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-3)}
.lp-sel{min-height:38px;max-width:100%;border:1px solid var(--line);border-radius:9px;
  background:#fff;font-family:inherit;font-size:12.5px;font-weight:700;color:var(--ink);padding:0 8px}

.lp-hero{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.lp-hid{min-width:0;flex:1 1 210px}
.lp-fname{font-size:21px;font-weight:800;letter-spacing:-.022em;line-height:1.15}
.lp-fmeta{margin-top:5px;font-size:12.5px;color:var(--ink-2)}
.lp-phase{display:inline-flex;align-items:center;gap:6px;margin-top:9px;padding:4px 10px;
  border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.07em}
.lp-phase[data-p="pre"]{background:#EAF2FB;color:#1b4f8c}
.lp-phase[data-p="launch"]{background:#E3F6EC;color:#0a6b45}
.lp-phase[data-p="post"]{background:#FBF2E4;color:#7a5200}
.lp-cnt{flex:0 0 auto;text-align:right;min-width:132px}
.lp-cnum{font-size:52px;font-weight:800;letter-spacing:-.045em;line-height:.92;
  font-variant-numeric:tabular-nums;color:var(--deep)}
.lp-clab{margin-top:5px;font-size:10.5px;font-weight:800;letter-spacing:.11em;color:var(--ink-2)}
.lp-cdate{margin-top:3px;font-size:11.5px;color:var(--ink-3)}

.lp-prog{margin-top:16px;padding-top:14px;border-top:1px solid var(--line-soft)}
.lp-pline{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:8px}
.lp-pbig{font-size:14px;font-weight:750}
.lp-pmut{font-size:12px;color:var(--ink-2)}
.lp-pover{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:12px;
  font-weight:750;color:var(--crit)}
.lp-bar{height:10px;border-radius:5px;background:#EDF2EF;overflow:hidden;display:flex;gap:2px}
.lp-bar i{display:block;height:100%;border-radius:5px}
.lp-bar i.done{background:var(--ok)}
.lp-bar i.over{background:var(--crit)}

.lp-tlhead{display:flex;align-items:baseline;gap:9px;margin-bottom:12px;flex-wrap:wrap}
.lp-tlhead b{font-size:12.5px;font-weight:800;letter-spacing:-.01em}
.lp-tlhead span{font-size:11.5px;color:var(--ink-2)}
.lp-weeks{display:grid;grid-template-columns:repeat(20,1fr);gap:2px;align-items:end;height:74px}
.lp-wk{position:relative;height:100%;display:flex;flex-direction:column;justify-content:flex-end}
.lp-wk i{display:block;border-radius:4px 4px 0 0;background:#C9DCD2}
.lp-wk[data-ph="launch"] i{background:var(--ok);opacity:.85}
.lp-wk[data-ph="post"] i{background:#DCC9A8}
.lp-wk[data-today="1"] i{outline:2px solid var(--deep);outline-offset:1px}
.lp-wkaxis{display:grid;grid-template-columns:repeat(20,1fr);gap:2px;margin-top:5px}
.lp-wkaxis span{font-size:8.5px;color:var(--ink-3);text-align:center;font-variant-numeric:tabular-nums}
.lp-bands{display:grid;grid-template-columns:4fr 4fr 12fr;gap:2px;margin-top:9px}
.lp-band{border-radius:6px;padding:5px 7px;font-size:9.5px;font-weight:800;letter-spacing:.06em;
  text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lp-band[data-p="pre"]{background:#EAF2FB;color:#1b4f8c}
.lp-band[data-p="launch"]{background:#E3F6EC;color:#0a6b45}
.lp-band[data-p="post"]{background:#FBF2E4;color:#7a5200}
/* AT 390 THE BANDS CANNOT HOLD "BUILD-UP - W1-4" and truncated to "BUILD-...". The week range is
   the only part not recoverable from the strip colour and the line below it, so the range stays
   and the phase word is what drops. */
.lp-band .sm{display:none}
@media(max-width:640px){ .lp-band .lg{display:none} .lp-band .sm{display:inline} }
.lp-todayline{margin-top:9px;font-size:11px;color:var(--ink-2);display:flex;align-items:center;gap:6px}
.lp-todaydot{width:8px;height:8px;border-radius:2px;background:var(--deep);flex:none}

.lp-grp{background:var(--card);border:1px solid var(--line);border-radius:16px;margin-bottom:12px;overflow:hidden}
.lp-gh{width:100%;display:flex;align-items:center;gap:10px;padding:13px 16px;border:0;background:none;
  font-family:inherit;cursor:pointer;text-align:left;min-height:52px}
.lp-gt{font-size:12px;font-weight:800;letter-spacing:.07em}
.lp-gw{font-size:11px;color:var(--ink-3);font-weight:650}
.lp-gc{margin-left:auto;font-size:11.5px;color:var(--ink-2);font-weight:700;
  font-variant-numeric:tabular-nums;flex:none}
.lp-car{font-size:11px;color:var(--ink-3);flex:none}
.lp-glist{padding:0 10px 10px}
.lp-t{display:flex;gap:10px;align-items:flex-start;padding:10px;border-top:1px solid var(--line-soft)}
.lp-t:first-child{border-top:0}
.lp-tick{flex:none;width:22px;height:22px;border-radius:6px;border:1.5px solid #CFDBD4;background:#fff;
  margin-top:1px;display:flex;align-items:center;justify-content:center;font-size:12px;
  color:#fff;font-family:inherit;padding:0;cursor:pointer}
.lp-t[data-done="1"] .lp-tick{background:var(--ok);border-color:var(--ok)}
.lp-tb{min-width:0;flex:1}
.lp-tt{font-size:13px;font-weight:650;line-height:1.35}
.lp-t[data-done="1"] .lp-tt{color:var(--ink-3)}
.lp-tm{margin-top:6px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.lp-scope{font-size:10px;color:var(--ink-2);font-weight:750;background:#EEF3F0;
  border-radius:5px;padding:2px 7px;letter-spacing:.02em}
.lp-win{font-size:10.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.lp-own{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:999px;
  padding:2px 8px 2px 3px;background:#fff;font-family:inherit;font-size:10.5px;font-weight:700;
  color:var(--ink-2);min-height:26px;cursor:pointer}
.lp-av{width:19px;height:19px;border-radius:50%;background:var(--mint);color:var(--deep);
  font-size:8px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none}
/* UNASSIGNED IS A VISIBLE STATE, not a blank. Dashed, and it says Assign. */
.lp-own[data-unassigned="1"]{border-style:dashed;color:var(--ink-3)}
.lp-own[data-unassigned="1"] .lp-av{background:#EDF2EF;color:var(--ink-3)}
.lp-st{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:4px;font-size:10px;
  font-weight:800;letter-spacing:.04em;padding:3px 8px;border-radius:999px}
.lp-st[data-s="over"]{background:#FBE9E9;color:#a32020}
.lp-st[data-s="now"]{background:#FDF3DF;color:#7a5200}
.lp-st[data-s="done"]{background:#E6F4EB;color:#0a6b45}
.lp-st[data-s="soon"]{background:#EEF3F0;color:var(--ink-2)}
.lp-st[data-s="na"]{background:#EEF3F0;color:var(--ink-3)}
@media(max-width:520px){ .lp-st{margin-left:0} .lp-cnum{font-size:44px} .lp-swlab{display:none}
  .lp-sel{flex:1;min-width:0} }

.lp-custom{font-size:9px;font-weight:800;letter-spacing:.05em;color:#7a5200;background:#FBF2E4;
  border-radius:4px;padding:2px 5px}
/* N/A IS NOT DELETION. The task stays, struck through, out of the denominator, the overdue count
   and the timeline - so the record of having deliberately skipped it survives and it can come
   back. Only a task somebody ADDED can be removed, because only that one was never in the plan. */
.lp-t[data-state="na"]{opacity:.52}
.lp-t[data-state="na"] .lp-tt{text-decoration:line-through;text-decoration-thickness:1px}
.lp-na{flex:none;min-height:28px;padding:0 9px;border:1px solid var(--line);border-radius:7px;
  background:#fff;font-family:inherit;font-size:10.5px;font-weight:700;color:var(--ink-2);cursor:pointer}
.lp-rmc{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 10px;background:#FDF3F2;
  border:1px solid #F0CFC9;border-radius:9px;margin:4px 0}
.lp-rmc span{font-size:11.5px;color:#a32020;font-weight:650}
.lp-rmc button{min-height:32px;padding:0 11px;border-radius:7px;font-family:inherit;font-size:11.5px;
  font-weight:750;border:1px solid #CFDBD4;background:#fff;color:var(--ink);cursor:pointer}
.lp-rmc button.yes{margin-left:auto;background:#a32020;border-color:#a32020;color:#fff}
.lp-addbtn{display:flex;align-items:center;gap:6px;width:100%;min-height:42px;margin-top:6px;
  border:1px dashed #CFDBD4;border-radius:10px;background:none;font-family:inherit;
  font-size:12px;font-weight:750;color:var(--ink-2);justify-content:center;cursor:pointer}

.lp-pick{border:1px solid var(--line);border-radius:9px;background:#fff;margin-top:6px;
  max-height:200px;overflow:auto;width:100%}
.lp-pick button{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--line-soft);
  background:none;font-family:inherit;font-size:12px;padding:0 11px;min-height:38px;color:var(--ink);cursor:pointer}
.lp-pick button:first-child{border-top:0}

.lp-scrim{position:fixed;inset:0;background:rgba(7,42,32,.34);display:flex;align-items:center;
  justify-content:center;padding:14px;z-index:60}
.lp-dlg{background:#fff;border-radius:14px;width:100%;max-width:470px;max-height:90vh;overflow:auto}
.lp-dh{padding:14px 16px 10px}
.lp-dh b{display:block;font-size:15px;font-weight:800;letter-spacing:-.015em}
.lp-dh span{display:block;margin-top:4px;font-size:11.5px;color:var(--ink-3)}
.lp-db{padding:0 16px 14px;display:flex;flex-direction:column;gap:11px}
.lp-fld label{display:block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-2);margin-bottom:5px}
.lp-fld input,.lp-fld select{width:100%;min-height:42px;border:1px solid #CFDBD4;border-radius:9px;
  padding:0 11px;font-family:inherit;font-size:13px;color:var(--ink);background:#fff}
.lp-wk2{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.lp-df{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--line-soft)}
.lp-df button{min-height:44px;padding:0 16px;border-radius:9px;font-family:inherit;font-size:13px;
  font-weight:750;border:1px solid #CFDBD4;background:#fff;color:var(--deep);cursor:pointer}
.lp-df button.save{margin-left:auto;background:var(--deep);color:#fff;border-color:var(--deep)}
.lp-df button:disabled{opacity:.4;cursor:default}
.lp-err{font-size:11.5px;color:#a32020;font-weight:650}
.lp-empty{background:var(--card);border:1px dashed var(--line);border-radius:15px;padding:22px 16px;
  text-align:center;font-size:12.5px;color:var(--ink-3)}
`;

type VenueRow = { id: number; venue_name: string; city: string | null; launch_date: string | null };
type UserRow = { id: string; full_name: string | null; email: string };
type AddState = { phase: PlanPhase; title: string; scope: ScopeKey; w1: string; w2: string };

const userLabel = (u: UserRow) => u.full_name?.trim() || u.email.split("@")[0];
const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((x) => x[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export default function LaunchPlanView({ venueId }: { venueId: number }) {
  const [venue, setVenue] = useState<VenueRow | null>(null);
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [others, setOthers] = useState<{ id: number; name: string; days: number; launch: string }[]>([]);
  const [coordinator, setCoordinator] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [needsMigration, setNeedsMigration] = useState(false);

  /* ── WHICH PHASES ARE OPEN IS STATE, NOT A DERIVATION ──────────────────────────────────────
   * It was recomputed from the current week on every render, so every tick, every N/A and every
   * add slammed the groups shut under whoever was working in them. Seeded from the current phase
   * ONCE (null until the launch date is known), then owned by the operator. */
  const [openPhases, setOpenPhases] = useState<Record<string, boolean> | null>(null);
  const [confirmRm, setConfirmRm] = useState<number | null>(null);
  const [adding, setAdding] = useState<AddState | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  /** Set once the first seed attempt has been made, so a second load reads rather than re-seeds. */
  const seedingRef = useRef(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [vRes, uRes, cRes] = await Promise.all([
        supabase.from("fin_venues").select("id, venue_name, city, launch_date").eq("id", venueId).maybeSingle(),
        supabase.from("app_users").select("id, full_name, email").eq("is_admin", true)
          .order("full_name", { ascending: true, nullsFirst: false }),
        supabase.from("kanban_cards").select("venue_id, owner_user_id")
          .eq("board_type", "field_pipeline").not("venue_id", "is", null),
      ]);
      if (vRes.error) throw new Error(vRes.error.message);
      const v = (vRes.data ?? null) as VenueRow | null;
      setVenue(v);
      setUsers((uRes.data ?? []) as UserRow[]);

      const bound = (cRes.data ?? []) as { venue_id: number | null; owner_user_id: string | null }[];
      setCoordinator(bound.find((c) => c.venue_id === venueId)?.owner_user_id ?? null);

      /* ── THE SWITCHER'S OTHER PLANS ────────────────────────────────────────────────────────
       * Ordered the way the index orders them, nearest launch first, so you can move between
       * fields by urgency rather than by going back and hunting. */
      const otherIds = bound.map((c) => c.venue_id).filter((x): x is number => x != null);
      if (otherIds.length > 0) {
        const ov = await supabase.from("fin_venues").select("id, venue_name, launch_date").in("id", otherIds);
        const today = new Date();
        const list = ((ov.data ?? []) as VenueRow[])
          .filter((x) => x.launch_date && isLive(x.launch_date, today))
          .map((x) => ({
            id: x.id,
            name: x.venue_name,
            launch: x.launch_date as string,
            days: daysToLaunch(x.launch_date as string, today) ?? 0,
          }))
          .sort((a, z) => (a.days >= 0 ? 0 : 1) - (z.days >= 0 ? 0 : 1) || (a.days >= 0 ? a.days - z.days : z.days - a.days));
        setOthers(list);
      }

      if (!v?.launch_date) {
        setTasks([]);
        return;
      }
      /* ── ONE SEED AT A TIME, PER MOUNT ────────────────────────────────────────────────────
       * React runs effects twice in development, so load() fires twice, both calls read an empty
       * plan and both insert 24 rows. The unique index refuses the loser (23505, treated as the
       * other tab winning), so the data is never wrong — but the wasted round trip is real and it
       * hid behind a constraint. This is the cheap half of the fix; the index is the half that
       * holds when the two racers are two browser tabs rather than two effect runs.
       *
       * IT GUARDS THE SEED, NOT THE LOAD. A second run still has to read the rows, or the page
       * renders an empty plan after the first run wrote one.
       *
       * SEED ON OPEN, NOT ONLY ON BIND. A field bound before migration 0173 applied has no rows,
       * and a bind whose seeding failed left a plan half-made. Seeding is idempotent, so running
       * it on open is the repair and costs one small SELECT. */
      if (!seedingRef.current) {
        seedingRef.current = true;
        const seeded = await seedLaunchPlan(venueId, coordinatorOf(bound, venueId));
        if (seeded.missingTable) {
          setNeedsMigration(true);
          setTasks([]);
          return;
        }
        if (seeded.error) throw new Error(seeded.error);
      }
      const tRes = await loadTasksForVenues([venueId]);
      if (tRes.missingTable) {
        setNeedsMigration(true);
        setTasks([]);
        return;
      }
      if (tRes.error) throw new Error(tRes.error);
      setTasks(tRes.tasks);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = new Date();
  const launch = venue?.launch_date ?? null;
  const counter = launch ? counterFor(launch, today) : null;
  const weekNow = launch ? weekOf(launch, today) ?? 1 : 1;

  // Seed the open phase once the week is known, then never again.
  useEffect(() => {
    if (openPhases || !launch) return;
    const cur = phaseOfWeek(Math.min(PLAN_WEEKS, Math.max(1, weekNow)));
    setOpenPhases(Object.fromEntries(PHASES.map((p) => [p.key, p.key === cur])));
  }, [openPhases, launch, weekNow]);

  const counted = useMemo(() => tasks.filter((t) => !t.na), [tasks]);
  const doneN = counted.filter((t) => t.done).length;
  const naN = tasks.length - counted.length;
  const overN = counted.filter((t) => !t.done && weekNow > t.week_end).length;

  /* ── WRITES ────────────────────────────────────────────────────────────────────────────────
   * Optimistic, then the row. A failure reloads onto the server's truth rather than leaving the
   * page showing a tick that is not there. */
  const patchTask = useCallback(
    async (id: number, patch: Partial<PlanTask> & Record<string, unknown>) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      const { error } = await supabase.from("field_launch_tasks").update(patch).eq("id", id);
      if (error && !isMissingTable(error)) {
        setErr(error.message);
        void load();
      }
    },
    [load],
  );

  const toggleDone = (t: PlanTask) =>
    void patchTask(t.id, { done: !t.done, done_at: t.done ? null : new Date().toISOString() });
  /* Marking N/A clears done: a task that does not apply here is not a task that was completed. */
  const toggleNa = (t: PlanTask) => void patchTask(t.id, { na: !t.na, ...(t.na ? {} : { done: false }) });
  const assign = (t: PlanTask, userId: string | null) => {
    setPicking(null);
    void patchTask(t.id, { owner_user_id: userId });
  };

  const removeTask = useCallback(
    async (id: number) => {
      setConfirmRm(null);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      /* BELT AND BRACES AT THE DATABASE: only a task with no template_key was ever removable, and
       * the filter says so in the delete itself rather than trusting the button that called it. */
      const { error } = await supabase
        .from("field_launch_tasks")
        .delete()
        .eq("id", id)
        .is("template_key", null);
      if (error) {
        setErr(error.message);
        void load();
      }
    },
    [load],
  );

  const saveAdd = useCallback(async () => {
    if (!adding) return;
    const w1 = Number(adding.w1);
    const w2 = Number(adding.w2);
    if (!(adding.title.trim().length > 1) || !okWeeks(w1, w2)) return;
    setAddErr(null);
    const { data, error } = await supabase
      .from("field_launch_tasks")
      .insert({
        venue_id: venueId,
        template_key: null,
        title: adding.title.trim(),
        scope: adding.scope,
        week_start: w1,
        week_end: w2,
        sort_order: 900,
      })
      .select(PLAN_TASK_COLUMNS)
      .single();
    if (error || !data) {
      setAddErr(error?.message ?? "Could not add that task.");
      return;
    }
    setTasks((prev) => [...prev, data as PlanTask]);
    setAdding(null);
  }, [adding, venueId]);

  if (loading) {
    return (
      <div className="lp" data-testid="lp-page">
        <style>{LP_CSS}</style>
        <div className="lp-wrap">
          <p className="lp-empty">Loading the plan…</p>
        </div>
      </div>
    );
  }

  if (!venue) {
    return (
      <div className="lp" data-testid="lp-page">
        <style>{LP_CSS}</style>
        <div className="lp-wrap">
          <div className="lp-navrow">
            <Link className="lp-back" href="/growth/launch" data-testid="lp-back">
              <span aria-hidden>←</span> All launches
            </Link>
          </div>
          <p className="lp-empty" data-testid="lp-missing">That field no longer exists.</p>
        </div>
      </div>
    );
  }

  if (!launch || !counter) {
    return (
      <div className="lp" data-testid="lp-page">
        <style>{LP_CSS}</style>
        <div className="lp-wrap">
          <div className="lp-navrow">
            <Link className="lp-back" href="/growth/launch" data-testid="lp-back">
              <span aria-hidden>←</span> All launches
            </Link>
          </div>
          <p className="lp-empty" data-testid="lp-nodate">
            <b>{venue.venue_name}</b> has no launch date, and every date on this plan is computed
            from it. Set one in Finance › Field Costs and the 20 weeks start.
          </p>
        </div>
      </div>
    );
  }

  const phaseNow = PHASES.find((p) => p.key === phaseOfWeek(Math.min(PLAN_WEEKS, Math.max(1, weekNow))))!;
  const tot = counted.length;
  const donePct = tot > 0 ? (doneN / tot) * 100 : 0;
  const overPct = tot > 0 ? (overN / tot) * 100 : 0;

  /* THE TIMELINE IS THE PLAN'S OWN WORKLOAD CURVE — how many tasks are running each week. N/A rows
   * are out of it, which is what makes marking one change the shape. */
  const activity: number[] = [];
  for (let w = 1; w <= PLAN_WEEKS; w++) {
    activity.push(counted.filter((t) => w >= t.week_start && w <= t.week_end).length);
  }
  const maxAct = Math.max(1, ...activity);

  return (
    <div className="lp" data-testid="lp-page">
      <style>{LP_CSS}</style>
      <div className="lp-wrap">
        {/* GETTING BACK, AND GETTING SIDEWAYS. A plan reachable only from a board is a plan you
            stop opening. */}
        <div className="lp-navrow">
          <Link className="lp-back" href="/growth/launch" data-testid="lp-back">
            <span aria-hidden>←</span> All launches
          </Link>
          <label className="lp-swlab" htmlFor="lp-fieldsel">Field</label>
          <select
            id="lp-fieldsel"
            className="lp-sel"
            data-testid="lp-fieldswitch"
            value={String(venueId)}
            onChange={(e) => {
              window.location.href = `/growth/launch/${e.target.value}`;
            }}
          >
            {others.map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.name} · {shortCountdown(o.launch, today)}
              </option>
            ))}
          </select>
        </div>

        {err && <p className="lp-empty" data-testid="lp-error" style={{ color: "#a32020" }}>{err}</p>}
        {needsMigration && (
          <p className="lp-empty" data-testid="lp-nomigration">
            The plan tables are not in place yet. Apply migration 0173 and reload; the 24 tasks seed
            themselves on the next open.
          </p>
        )}

        {/* ══ HERO ══ */}
        <div className="lp-card">
          <div className="lp-hero">
            <div className="lp-hid">
              <div className="lp-fname" data-testid="lp-field">{venue.venue_name}</div>
              <div className="lp-fmeta">
                {venue.city ?? "—"} · launch coordinator{" "}
                {users.find((u) => u.id === coordinator) ? userLabel(users.find((u) => u.id === coordinator)!) : "unassigned"}
              </div>
              <span className="lp-phase" data-p={counter.phase} data-testid="lp-phase">
                {phaseTitleFor(counter.phase).toUpperCase()}
              </span>
            </div>
            <div className="lp-cnt">
              <div className="lp-cnum" data-testid="lp-count">{counter.n}</div>
              <div className="lp-clab" data-testid="lp-countlabel">{counter.label}</div>
              <div className="lp-cdate" data-testid="lp-date">{fmtLaunchDate(launch)}</div>
            </div>
          </div>
          <div className="lp-prog">
            <div className="lp-pline">
              <span className="lp-pbig" data-testid="lp-done">{doneN} of {tot} done</span>
              <span className="lp-pmut">
                {tot - doneN} to go{naN ? ` · ${naN} N/A` : ""}
              </span>
              {/* IN WEEK 1 NOTHING CAN BE LATE, AND THE PAGE DOES NOT INVENT AN ALARM. */}
              {overN > 0 && (
                <span className="lp-pover" data-testid="lp-overdue">
                  <span aria-hidden>!</span>{overN} overdue
                </span>
              )}
            </div>
            <div className="lp-bar" role="img" aria-label={`${doneN} of ${tot} tasks done, ${overN} overdue`}>
              <i className="done" style={{ width: `${donePct.toFixed(1)}%` }} />
              {overN > 0 && <i className="over" style={{ width: `${overPct.toFixed(1)}%` }} />}
            </div>
          </div>
        </div>

        {/* ══ TIMELINE ══ */}
        <div className="lp-card">
          <div className="lp-tlhead">
            <b>The 20 weeks</b>
            <span>how much is running each week · launch is week {PHASES[1].w1}</span>
          </div>
          <div className="lp-weeks" data-testid="lp-weeks">
            {activity.map((n, i) => {
              const w = i + 1;
              return (
                <div
                  key={w}
                  className="lp-wk"
                  data-w={w}
                  data-ph={phaseOfWeek(w)}
                  {...(w === weekNow ? { "data-today": "1" } : {})}
                  title={`Week ${w} · ${n} running`}
                >
                  <i style={{ height: `${Math.max(6, Math.round((n / maxAct) * 100))}%` }} />
                </div>
              );
            })}
          </div>
          <div className="lp-wkaxis">
            {activity.map((_, i) => (
              <span key={i}>{(i + 1) % 2 === 1 ? i + 1 : ""}</span>
            ))}
          </div>
          <div className="lp-bands">
            {PHASES.map((p) => (
              <div key={p.key} className="lp-band" data-p={p.key} data-testid="lp-band">
                <span className="lg">{p.title.toUpperCase()} · W{p.w1}–{p.w2}</span>
                <span className="sm">W{p.w1}–{p.w2}</span>
              </div>
            ))}
          </div>
          <p className="lp-todayline">
            <span className="lp-todaydot" aria-hidden />
            {weekNow >= 1 && weekNow <= PLAN_WEEKS
              ? `You are in week ${weekNow} — ${phaseNow.sub}.`
              : weekNow < 1
                ? `The plan opens in ${1 - weekNow} week${1 - weekNow === 1 ? "" : "s"}.`
                : "The 20 weeks are over."}
          </p>
        </div>

        {/* ══ TASKS ══ */}
        {PHASES.map((p) => {
          const inPhase = tasks
            .filter((t) => phaseOfWeek(t.week_end) === p.key)
            .slice()
            .sort(
              (a, z) =>
                STATE_RANK[stateOf(rowState(a), weekNow)] - STATE_RANK[stateOf(rowState(z), weekNow)] ||
                a.week_start - z.week_start ||
                a.sort_order - z.sort_order,
            );
          const liveRows = inPhase.filter((t) => !t.na);
          const d = liveRows.filter((t) => t.done).length;
          const o = liveRows.filter((t) => !t.done && weekNow > t.week_end).length;
          const open = openPhases?.[p.key] ?? false;
          return (
            <section key={p.key} className="lp-grp" data-testid="lp-group" data-phase={p.key} data-open={open ? 1 : 0}>
              <button
                type="button"
                className="lp-gh"
                aria-expanded={open}
                onClick={() => setOpenPhases((prev) => ({ ...(prev ?? {}), [p.key]: !(prev?.[p.key] ?? false) }))}
              >
                <span className="lp-gt">{p.title.toUpperCase()}</span>
                <span className="lp-gw">W{p.w1}–{p.w2}</span>
                <span className="lp-gc" data-testid="lp-groupcount">
                  {d}/{inPhase.length}
                  {o ? ` · ${o} overdue` : ""}
                </span>
                <span className="lp-car">{open ? "▴" : "▾"}</span>
              </button>
              {/* EVERY LIST IS RENDERED AND HIDDEN, never conditionally built: opening a collapsed
                  phase must show its tasks without a refetch, and the counts above are already
                  computed from the same rows. */}
              <div className="lp-glist" hidden={!open}>
                {inPhase.map((t) => {
                  const s = stateOf(rowState(t), weekNow);
                  return (
                    <div key={t.id} className="lp-t" data-testid="lp-task" data-state={s} data-done={t.done ? 1 : 0}>
                      <button
                        type="button"
                        className="lp-tick"
                        aria-label={t.done ? "Mark not done" : "Mark done"}
                        onClick={() => toggleDone(t)}
                      >
                        {t.done ? "✓" : ""}
                      </button>
                      <div className="lp-tb">
                        <div className="lp-tt">{t.title}</div>
                        <div className="lp-tm">
                          <span className="lp-scope">{SCOPES[t.scope] ?? t.scope}</span>
                          <span className="lp-win">
                            W{t.week_start}{t.week_end !== t.week_start ? `–${t.week_end}` : ""}
                          </span>
                          <button
                            type="button"
                            className="lp-own"
                            data-testid="lp-owner"
                            data-unassigned={t.owner_user_id ? 0 : 1}
                            onClick={() => setPicking(picking === t.id ? null : t.id)}
                          >
                            <span className="lp-av">
                              {t.owner_user_id
                                ? initials(userLabel(users.find((u) => u.id === t.owner_user_id) ?? fallbackUser(t.owner_user_id)))
                                : "+"}
                            </span>
                            {t.owner_user_id
                              ? userLabel(users.find((u) => u.id === t.owner_user_id) ?? fallbackUser(t.owner_user_id))
                              : "Assign"}
                          </button>
                          {t.template_key === null && (
                            <span className="lp-custom" data-testid="lp-custom">ADDED HERE</span>
                          )}
                          {/* N/A FOR A PLAYBOOK TASK; REMOVE ONLY FOR ONE SOMEBODY ADDED. */}
                          {t.template_key === null ? (
                            <button
                              type="button"
                              className="lp-na"
                              data-testid="lp-remove"
                              onClick={() => setConfirmRm(t.id)}
                            >
                              Remove
                            </button>
                          ) : (
                            <button type="button" className="lp-na" data-testid="lp-na" onClick={() => toggleNa(t)}>
                              {t.na ? "Put back" : "N/A here"}
                            </button>
                          )}
                          <span className="lp-st" data-s={s} data-testid="lp-state">
                            <span aria-hidden>{STATE_ICON[s]}</span>
                            {STATE_LABEL[s]}
                          </span>
                        </div>
                        {picking === t.id && (
                          <div className="lp-pick" data-testid="lp-ownerpick">
                            <button type="button" onClick={() => assign(t, null)}>Nobody</button>
                            {users.map((u) => (
                              <button key={u.id} type="button" onClick={() => assign(t, u.id)}>
                                {userLabel(u)}
                              </button>
                            ))}
                          </div>
                        )}
                        {/* REMOVAL ASKS FIRST — never one tap on a list being scrolled with a thumb. */}
                        {confirmRm === t.id && (
                          <div className="lp-rmc" data-testid="lp-rmconfirm">
                            <span>Remove this task from {venue.venue_name}?</span>
                            <button type="button" data-testid="lp-rm-no" onClick={() => setConfirmRm(null)}>
                              Keep it
                            </button>
                            <button type="button" className="yes" data-testid="lp-rm-yes" onClick={() => void removeTask(t.id)}>
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="lp-addbtn"
                  data-testid="lp-add"
                  onClick={() => {
                    setAddErr(null);
                    setAdding({ phase: p.key, title: "", scope: "ops", w1: "", w2: "" });
                  }}
                >
                  <span aria-hidden>+</span> Add a task for {venue.city ?? venue.venue_name}
                </button>
              </div>
            </section>
          );
        })}

        {adding && (
          <AddDialog
            state={adding}
            error={addErr}
            onChange={setAdding}
            onCancel={() => setAdding(null)}
            onSave={() => void saveAdd()}
            fieldName={venue.venue_name}
          />
        )}
      </div>
    </div>
  );
}

/* ── HELPERS ──────────────────────────────────────────────────────────────────────────────────*/

const rowState = (t: PlanTask) => ({ w1: t.week_start, w2: t.week_end, done: t.done, na: t.na });

const phaseTitleFor = (p: PlanPhase) => PHASES.find((x) => x.key === p)?.title ?? p;

const okWeeks = (w1: number, w2: number) =>
  Number.isFinite(w1) && Number.isFinite(w2) && w1 >= 1 && w1 <= PLAN_WEEKS && w2 >= w1 && w2 <= PLAN_WEEKS;

/** An owner who is no longer an admin still has to render as a name, not as a blank chip. */
const fallbackUser = (id: string): UserRow => ({ id, full_name: null, email: "someone@" });

function coordinatorOf(
  bound: { venue_id: number | null; owner_user_id: string | null }[],
  venueId: number,
): string | null {
  return bound.find((c) => c.venue_id === venueId)?.owner_user_id ?? null;
}

function AddDialog({
  state,
  error,
  onChange,
  onCancel,
  onSave,
  fieldName,
}: {
  state: AddState;
  error: string | null;
  onChange: (s: AddState) => void;
  onCancel: () => void;
  onSave: () => void;
  fieldName: string;
}) {
  const w1 = Number(state.w1);
  const w2 = Number(state.w2);
  const bothTyped = state.w1 !== "" && state.w2 !== "";
  const good = okWeeks(w1, w2);
  const canSave = state.title.trim().length > 1 && good;
  return (
    <div className="lp-scrim">
      <div className="lp-dlg" role="dialog" aria-modal="true" data-testid="lp-adddlg">
        <div className="lp-dh">
          <b>A task just for {fieldName}</b>
          {/* ADDING IS PER PLAN AND THE TEMPLATE MUST NOT MOVE, so the dialog says so in as many
              words rather than leaving somebody to assume it seeds every future field. */}
          <span>
            This is added to this field&rsquo;s plan only. The playbook every other launch is seeded
            from does not change.
          </span>
        </div>
        <div className="lp-db">
          <div className="lp-fld">
            <label htmlFor="lp-at">What needs doing</label>
            <input
              id="lp-at"
              data-testid="lp-add-title"
              value={state.title}
              onChange={(e) => onChange({ ...state, title: e.target.value })}
              placeholder="e.g. Get the HOA notice posted at the gate"
            />
          </div>
          <div className="lp-fld">
            <label htmlFor="lp-as">Scope</label>
            <select
              id="lp-as"
              data-testid="lp-add-scope"
              value={state.scope}
              onChange={(e) => onChange({ ...state, scope: e.target.value as ScopeKey })}
            >
              {SCOPE_KEYS.map((k) => (
                <option key={k} value={k}>{SCOPES[k]}</option>
              ))}
            </select>
          </div>
          <div className="lp-wk2">
            <div className="lp-fld">
              <label htmlFor="lp-aw1">From week</label>
              <input id="lp-aw1" type="number" min={1} max={PLAN_WEEKS} data-testid="lp-add-w1"
                value={state.w1} onChange={(e) => onChange({ ...state, w1: e.target.value })} />
            </div>
            <div className="lp-fld">
              <label htmlFor="lp-aw2">To week</label>
              <input id="lp-aw2" type="number" min={1} max={PLAN_WEEKS} data-testid="lp-add-w2"
                value={state.w2} onChange={(e) => onChange({ ...state, w2: e.target.value })} />
            </div>
          </div>
          {bothTyped && !good ? (
            <p className="lp-win" data-testid="lp-add-badweek" style={{ color: "#a32020" }}>
              Weeks run 1 to {PLAN_WEEKS}, and the end cannot come before the start.
            </p>
          ) : good ? (
            /* NAMED FROM ITS DEADLINE, the same rule as everything else on the page. */
            <p className="lp-win" data-testid="lp-add-lands">
              Lands in <b>{phaseTitleFor(phaseOfWeek(w2))}</b> — that is where its deadline falls.
            </p>
          ) : null}
          {error && <p className="lp-err">{error}</p>}
        </div>
        <div className="lp-df">
          <button type="button" data-testid="lp-add-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="save" data-testid="lp-add-save" disabled={!canSave} onClick={onSave}>
            Add to this plan
          </button>
        </div>
      </div>
    </div>
  );
}
