"use client";

// EVERY LAUNCH IN FLIGHT — /growth/launch, and the landing page for the whole feature.
//
// ══ WHY THIS EXISTS AT ALL ═══════════════════════════════════════════════════════════════════
// Ryan: "now how does it look as far as seeing all the fields you are about to launch and
// switching between them?" The first cut had no answer: a plan you can only reach by finding its
// card on a kanban board is a plan nobody opens. This is the answer, and the plan page's field
// switcher is the other half of it.
//
// ══ GROUPED BY THE GROUP, NOT BY THE PHASE ═══════════════════════════════════════════════════
// A field ten days past its date is still inside the LAUNCH WINDOW by phase, but it belongs under
// "launched, still running" — it is open, people are playing on it. Sorting these two by phase
// conflates "about to open" with "just opened", which is the one distinction the page exists to
// draw. So the split is on the sign of the countdown and nothing else.
//
// ══ DAY ONE IS EMPTY ═════════════════════════════════════════════════════════════════════════
// No pipeline card is bound to a field yet (0 of 27 in Confirmed), so the first thing anybody sees
// here is the empty state. It says how a plan starts rather than sitting blank.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { counterFor, daysToLaunch, isLive, weekOf, type Counter } from "@/lib/launchPlan";
import { loadTasksForVenues, type PlanTask } from "@/lib/launchTasks";

/* NO BACKTICK MAY APPEAR IN THIS BLOCK - it is inside a template literal. A single one ends the
 * string and tsc then reports the error somewhere else entirely. */
const LX_CSS = `
.lx{color-scheme:light;
  --surface:#F4F7F5; --card:#fff; --line:#E3EAE6; --line-soft:#EEF3F0;
  --ink:#12241d; --ink-2:#5c7267; --ink-3:#8b9a93; --deep:#0d3b2e;
  --ok:#0ca30c; --crit:#d03b3b;
  background:var(--surface);color:var(--ink);padding:14px;min-height:100%;
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.lx *{box-sizing:border-box}
.lx-wrap{max-width:1080px;margin:0 auto}
.lx-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.lx-top h1{margin:0;font-size:21px;font-weight:800;letter-spacing:-.022em}
.lx-sub{font-size:12.5px;color:var(--ink-2)}
/* THE ONE NUMBER THAT DECIDES WHERE TO LOOK. Overdue work across every launch, stated once at the
   top with the field count, and absent entirely when there is none. */
.lx-alarm{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;
  font-weight:750;color:var(--crit);background:#FBE9E9;border-radius:999px;padding:5px 11px}
.lx-sect{margin:18px 0 9px;font-size:10.5px;font-weight:800;letter-spacing:.09em;color:var(--ink-2)}
.lx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:12px}
.lx-f{display:block;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);
  border-radius:15px;padding:14px;font-family:inherit;color:inherit;cursor:pointer;min-width:0;
  text-decoration:none}
.lx-f[data-over="1"]{border-color:#EFC9C4}
.lx-fh{display:flex;gap:12px;align-items:flex-start}
.lx-fn{min-width:0;flex:1}
.lx-fn b{display:block;font-size:15.5px;font-weight:780;letter-spacing:-.015em;line-height:1.2;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lx-fn span{display:block;margin-top:3px;font-size:11.5px;color:var(--ink-2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lx-fc{flex:none;text-align:right;min-width:74px}
.lx-fc b{display:block;font-size:28px;font-weight:800;letter-spacing:-.035em;line-height:.95;
  font-variant-numeric:tabular-nums;color:var(--deep)}
.lx-fc span{display:block;margin-top:3px;font-size:8.5px;font-weight:800;letter-spacing:.08em;
  color:var(--ink-3)}
.lx-fp{display:inline-flex;margin-top:10px;padding:3px 9px;border-radius:999px;font-size:9.5px;
  font-weight:800;letter-spacing:.06em}
.lx-fp[data-p="pre"]{background:#EAF2FB;color:#1b4f8c}
.lx-fp[data-p="launch"]{background:#E3F6EC;color:#0a6b45}
.lx-fp[data-p="post"]{background:#FBF2E4;color:#7a5200}
.lx-bar{height:8px;border-radius:4px;background:#EDF2EF;overflow:hidden;display:flex;gap:2px;margin-top:11px}
.lx-bar i{display:block;height:100%;border-radius:4px}
.lx-bar i.d{background:var(--ok)} .lx-bar i.o{background:var(--crit)}
.lx-ff{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.lx-ff .n{font-size:11.5px;color:var(--ink-2);font-weight:650}
.lx-ff .ov{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:4px;font-size:10.5px;
  font-weight:800;color:#a32020;background:#FBE9E9;border-radius:999px;padding:2px 8px}
.lx-ff .na{font-size:10.5px;color:var(--ink-3)}
.lx-empty{background:var(--card);border:1px dashed var(--line);border-radius:15px;padding:22px 16px;
  text-align:center;font-size:12.5px;color:var(--ink-3)}
.lx-empty b{display:block;font-size:14px;font-weight:750;color:var(--ink-2);margin-bottom:5px}
.lx-note{margin-top:12px;font-size:11.5px;color:var(--ink-3)}
`;

const PHASE_WORD: Record<string, string> = {
  pre: "BUILD-UP",
  launch: "LAUNCH WINDOW",
  post: "SUSTAIN",
};

/** One field with a plan, already reduced to what a card draws. */
export type LaunchRow = {
  venueId: number;
  name: string;
  city: string;
  coordinator: string;
  launch: string;
  counter: Counter;
  days: number;
  done: number;
  total: number;
  over: number;
  na: number;
};

type CardRow = { venue_id: number | null; owner_user_id: string | null };
type VenueRow = { id: number; venue_name: string; city: string | null; launch_date: string | null };
type UserRow = { id: string; full_name: string | null; email: string };

/* ── DONE / TOTAL / OVERDUE, COUNTED EXACTLY AS THE PLAN PAGE COUNTS THEM ──────────────────────
 * N/A is out of the denominator and out of the overdue count on both pages, so the arithmetic is
 * here once and the index card cannot drift from the plan hero it links to. */
export function tallyTasks(tasks: PlanTask[], weekNow: number) {
  const live = tasks.filter((t) => !t.na);
  return {
    done: live.filter((t) => t.done).length,
    total: live.length,
    na: tasks.length - live.length,
    over: live.filter((t) => !t.done && weekNow > t.week_end).length,
  };
}

export default function LaunchIndex() {
  const [rows, setRows] = useState<LaunchRow[] | null>(null);
  const [finished, setFinished] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [needsMigration, setNeedsMigration] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      /* A FIELD HAS A PLAN WHEN A PIPELINE CARD IS BOUND TO IT. There is no plans table to ask —
       * kanban_cards.venue_id (0172) already records exactly this, and a second record could
       * disagree with it. */
      const cardsRes = await supabase
        .from("kanban_cards")
        .select("venue_id, owner_user_id")
        .eq("board_type", "field_pipeline")
        .not("venue_id", "is", null);
      if (cardsRes.error) throw new Error(cardsRes.error.message);
      const cards = (cardsRes.data ?? []) as CardRow[];
      const venueIds = [...new Set(cards.map((c) => c.venue_id).filter((v): v is number => v != null))];
      if (venueIds.length === 0) {
        setRows([]);
        setFinished(0);
        return;
      }

      const [venuesRes, usersRes, taskRes] = await Promise.all([
        supabase.from("fin_venues").select("id, venue_name, city, launch_date").in("id", venueIds),
        supabase.from("app_users").select("id, full_name, email"),
        loadTasksForVenues(venueIds),
      ]);
      if (venuesRes.error) throw new Error(venuesRes.error.message);
      if (taskRes.error) throw new Error(taskRes.error);
      setNeedsMigration(taskRes.missingTable);

      const userById = new Map(((usersRes.data ?? []) as UserRow[]).map((u) => [u.id, u]));
      const ownerByVenue = new Map<number, string | null>();
      for (const c of cards) if (c.venue_id != null) ownerByVenue.set(c.venue_id, c.owner_user_id);
      const byVenue = new Map<number, PlanTask[]>();
      for (const t of taskRes.tasks) {
        const list = byVenue.get(t.venue_id);
        if (list) list.push(t);
        else byVenue.set(t.venue_id, [t]);
      }

      const today = new Date();
      const out: LaunchRow[] = [];
      let done = 0;
      for (const v of (venuesRes.data ?? []) as VenueRow[]) {
        /* A BOUND FIELD WITH NO DATE CANNOT HAVE A PLAN, because every date on the plan is
         * computed from it. Binding requires one, so this is unreachable through the UI — it is
         * here so a row edited in Finance drops out quietly rather than rendering NaN. */
        if (!v.launch_date) continue;
        const c = counterFor(v.launch_date, today);
        const d = daysToLaunch(v.launch_date, today);
        if (!c || d == null) continue;
        if (!isLive(v.launch_date, today)) {
          done += 1;
          continue;
        }
        /* THE PLAN'S OWN WEEK NUMBER, from the shared helper — the index's overdue count and the
         * plan hero's overdue count are the same arithmetic or they will disagree on a card. */
        const weekNow = weekOf(v.launch_date, today) ?? 1;
        out.push({
          venueId: v.id,
          name: v.venue_name,
          city: v.city ?? "—",
          coordinator: coordinatorName(userById.get(ownerByVenue.get(v.id) ?? "") ?? null),
          launch: v.launch_date,
          counter: c,
          days: d,
          ...tallyTasks(byVenue.get(v.id) ?? [], weekNow),
        });
      }
      setRows(out);
      setFinished(done);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { upcoming, launched, totalOver, overFields } = useMemo(() => {
    const live = rows ?? [];
    return {
      upcoming: live.filter((r) => r.days >= 0).sort((a, z) => a.days - z.days),
      launched: live.filter((r) => r.days < 0).sort((a, z) => z.days - a.days),
      totalOver: live.reduce((a, r) => a + r.over, 0),
      overFields: live.filter((r) => r.over > 0).length,
    };
  }, [rows]);

  if (rows === null) {
    return (
      <div className="lx" data-testid="li-page">
        <style>{LX_CSS}</style>
        <div className="lx-wrap">
          <p className="lx-empty">Loading launches…</p>
        </div>
      </div>
    );
  }

  const liveN = rows.length;
  return (
    <div className="lx" data-testid="li-page">
      <style>{LX_CSS}</style>
      <div className="lx-wrap">
        <div className="lx-top">
          <h1>Launches</h1>
          <span className="lx-sub" data-testid="li-sub">
            {liveN} {liveN === 1 ? "field in flight" : "fields in flight"}
            {finished ? ` · ${finished} finished` : ""}
          </span>
          {totalOver > 0 && (
            <span className="lx-alarm" data-testid="li-alarm">
              <span aria-hidden>!</span>
              {totalOver} task{totalOver === 1 ? "" : "s"} overdue across {overFields} field
              {overFields === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {err && (
          <p className="lx-empty" data-testid="li-error" style={{ color: "#a32020" }}>
            {err}
          </p>
        )}

        {liveN === 0 && !err ? (
          <p className="lx-empty" data-testid="li-empty">
            <b>No launches in flight.</b>
            A field gets a plan when its card reaches Confirmed on the Field Pipeline — binding it
            to a field record and a launch date is what starts the 20 weeks.
          </p>
        ) : (
          <>
            {upcoming.length > 0 && (
              <>
                <p className="lx-sect" data-testid="li-sect">
                  STILL TO LAUNCH · {upcoming.length}
                </p>
                <div className="lx-grid" data-testid="li-grid">
                  {upcoming.map((r) => (
                    <FieldCard key={r.venueId} r={r} />
                  ))}
                </div>
              </>
            )}
            {launched.length > 0 && (
              <>
                <p className="lx-sect" data-testid="li-sect">
                  LAUNCHED, STILL RUNNING · {launched.length}
                </p>
                <div className="lx-grid" data-testid="li-grid">
                  {launched.map((r) => (
                    <FieldCard key={r.venueId} r={r} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {needsMigration && (
          <p className="lx-note" data-testid="li-nomigration">
            The plan tables are not in place yet, so task counts read zero. Apply migration 0173.
          </p>
        )}
      </div>
    </div>
  );
}

function coordinatorName(u: UserRow | null): string {
  if (!u) return "No coordinator";
  const full = u.full_name?.trim();
  return full || u.email.split("@")[0];
}

function FieldCard({ r }: { r: LaunchRow }) {
  const pct = r.total > 0 ? (r.done / r.total) * 100 : 0;
  const opct = r.total > 0 ? (r.over / r.total) * 100 : 0;
  return (
    <Link
      href={`/growth/launch/${r.venueId}`}
      className="lx-f"
      data-testid="li-field"
      data-name={r.name}
      data-phase={r.counter.phase}
      data-days={r.days}
      data-over={r.over ? 1 : 0}
    >
      <span className="lx-fh">
        <span className="lx-fn">
          <b>{r.name}</b>
          <span>
            {r.city} · {r.coordinator}
          </span>
        </span>
        <span className="lx-fc">
          <b data-testid="li-count">{r.counter.n}</b>
          <span>{r.counter.label}</span>
        </span>
      </span>
      <span className="lx-fp" data-p={r.counter.phase} data-testid="li-phase">
        {PHASE_WORD[r.counter.phase]}
      </span>
      <span
        className="lx-bar"
        role="img"
        aria-label={`${r.done} of ${r.total} done, ${r.over} overdue`}
      >
        <i className="d" style={{ width: `${pct.toFixed(1)}%` }} />
        {r.over > 0 && <i className="o" style={{ width: `${opct.toFixed(1)}%` }} />}
      </span>
      <span className="lx-ff">
        <span className="n" data-testid="li-prog">
          {r.done} of {r.total} done
        </span>
        {r.na > 0 && <span className="na">{r.na} N/A</span>}
        {r.over > 0 && (
          <span className="ov" data-testid="li-over">
            <span aria-hidden>!</span>
            {r.over} overdue
          </span>
        )}
      </span>
    </Link>
  );
}
