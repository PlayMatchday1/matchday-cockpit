"use client";

// Home body (home-v5 redesign): a full-bleed forest hero band with a real-data
// scoreboard, the org-goal deck overlapping up into it, then This Week + P&D as
// a full-width pair. Presentation only — same org-goals query, same comment
// write path, same P&D permission. Scoreboard tiles are real numbers or the
// tile does not render.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { type Goal } from "@/lib/types";
import { computeGoalPace } from "@/lib/goalPace";
import { fetchSnapshot, type Snapshot } from "@/lib/homeStats";
import OrgGoalCard from "./OrgGoalCard";
import GoalEditDrawer, { type DrawerState } from "./GoalEditDrawer";
import GoalCommentsDrawer from "./GoalCommentsDrawer";
import CalendarPanel from "./CalendarPanel";
import PdSchedulePanel from "./PdSchedulePanel";

/* ── ONE BREAKPOINT, ONE GUTTER, AND TWO GRID FLOORS A PHONE CAN MEET ──────────────────────────
 * NO BACKTICK MAY APPEAR IN THIS BLOCK — it is inside a template literal.
 *
 * WHY THIS FILE NOW HAS A STYLESHEET. Three things here have to agree across two components and a
 * breakpoint, and Tailwind literals cannot express any of them:
 *
 *   1. THE GUTTER WAS TWO HARD-CODED px-[30px] VALUES that had to be changed together — one on the
 *      body container, one on the hero's inner. They did agree, and a third block would not have
 *      had to. It is one custom property now, read by both, so a new top-level block cannot land on
 *      a different left edge. At 390 the old 30px cost 60px, 15% of the screen, for nothing.
 *
 *   2. minmax(430px,1fr) IS A 430px FLOOR, AND THAT WAS THE BUG. At 390 the container is
 *      390 - 32 = 358px, so the track was laid out at 430 and THE PAGE OVERFLOWED BY ~100px. The
 *      pair below it, at minmax(400px,1fr), overflowed by ~70. That is why nothing in Ryan's
 *      screenshots lined up: the hero is only viewport-wide, so with the page scrolled right it
 *      appeared shifted left while the two over-wide card families — 430 against 400 — reached the
 *      right edge at two different places.
 *
 *      min(430px,100%) KEEPS THE INTENT AND DROPS THE OVERFLOW. Above 430 of available width the
 *      floor is still 430, so desktop is laid out exactly as before; below it the floor collapses
 *      to the container and one column fills the phone.
 *
 *   3. 760px IS THE ONE BREAKPOINT, and it is written as 759.98/760 rather than 760/760 so the two
 *      halves can never both apply. The stats rule used max-width:760px against the mock's
 *      min-width:760px, which disagreed by exactly one pixel about what 760 is.
 *
 * THE PHONE TRIMS ARE ALL GATED. Everything below 760 is a phone override and desktop is left at
 * the value it had — see the report: the mock writes several of these unconditionally, but it is a
 * phone mock, and "desktop must be untouched" is the harder constraint of the two. */
const HG_CSS = `
:root{--hg-gut:30px}
@media(max-width:759.98px){ :root{--hg-gut:16px} }
.hg-wrap{margin-left:auto;margin-right:auto;max-width:1280px;
  padding-left:var(--hg-gut);padding-right:var(--hg-gut)}

/* ── THE SECOND CAUSE, AND ONE TOKEN COULD NOT HAVE FIXED IT ──────────────────────────────────
 * MEASURED AT 390: the hero's inner started its text at x=16 and the body's at x=48. Both carried
 * the same gutter. The 32px came from AuthGate, whose <main> is mx-auto max-w-[1600px] px-8 — THE
 * HERO ESCAPES THAT PADDING and the body container did not, because the hero band is
 * left-1/2 w-screen -translate-x-1/2 and breaks out to the full viewport.
 *
 * SO IT IS NOT ONLY A PHONE BUG. The two disagree at every width where AuthGate's 32px actually
 * binds — anything under 1280 + 64 — which is why it reads as fine at 1400 and wrong on a laptop
 * as well as a phone. One custom property makes the two gutters equal; it cannot make two
 * different PARENTS hand their child the same available width.
 *
 * THE BODY BREAKS OUT THE SAME WAY. Same 100vw, same max-width, same gutter, therefore the same
 * content edge at every width, by construction rather than by two values agreeing. The margin form
 * is used rather than the hero's translate because a transform creates a containing block for
 * position:fixed descendants, and a fixed bottom nav painting mid-page is a bug this estate has
 * already had once. It is the same technique GamedayBoard uses for its edge-to-edge phone layout.
 *
 * AuthGate IS UNTOUCHED. Its <main> keeps its 1600px cap and its padding for every other page. */
.hg-bleed{width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw)}

.hg-stats{grid-template-columns:repeat(var(--hg-cols,4),minmax(0,1fr))}
.hg-deck{grid-template-columns:repeat(auto-fill,minmax(min(430px,100%),1fr))}
.hg-pair{grid-template-columns:repeat(auto-fit,minmax(min(400px,100%),1fr))}

.hg-heroin{padding-top:38px;padding-bottom:60px}
.hg-pull{margin-top:-58px}
.hg-mission{font-size:25px;margin-top:14px}
/* ── THE CELL DIVIDERS FOLLOW THE GRID, NOT THE SOURCE ORDER ──────────────────────────────────
   It was a Tailwind border-l on every cell but the first, which is right for ONE ROW and wrong for
   a 2x2: the third tile opened row two carrying a left border it should not have, and the two rows
   had no divider between them at all. Expressed here because it is a question about which grid
   cell a tile landed in, which the JSX index cannot answer. */
.hg-cell{padding:16px 22px}
.hg-cell + .hg-cell{border-left:1px solid rgba(255,255,255,.1)}
.hg-cell .hg-v{font-size:31px}
/* THE LOADING RESERVE MATCHES THE BREAKPOINT. It was a flat h-[112px], the ONE-ROW desktop height,
   while the strip is 2x2 below 760 and measures nearly twice that — so on a phone the reserve was
   ~80px short and the goal deck jumped anyway, which is the single thing the line exists to stop. */
.hg-reserve{height:112px}

/* OrgGoalCard's ring and the type inside it. Lives here because this is where the breakpoint is
   defined, and a second copy of 759.98 in another file is the next thing to fall out of step. */
.hg-ring{width:86px;height:86px}
.hg-ringpct{font-size:22px}
.hg-ringpc{font-size:13px}
.hg-ringlab{font-size:8.5px}
.hg-trend{margin-top:18px;margin-bottom:18px}
.hg-card{padding:22px}
/* The card's title is a CONTROL — it opens the edit drawer — and it measured 20.5px tall. */
.hg-goal-title{min-height:32px;display:inline-flex;align-items:center}

@media(max-width:759.98px){
  .hg-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .hg-heroin{padding-top:22px;padding-bottom:52px}
  /* -46 PAIRS WITH THE 52px HERO PADDING. The overlap is the point of this layout and it has to
     survive the trim: too deep a pull and ORG GOALS falls off the dark band onto the cream. */
  .hg-pull{margin-top:-46px}
  .hg-mission{font-size:19px;margin-top:11px}
  .hg-cell{padding:13px 15px}
  .hg-cell + .hg-cell{border-left:0}
  .hg-cell:nth-child(even){border-left:1px solid rgba(255,255,255,.1)}
  .hg-cell:nth-child(n+3){border-top:1px solid rgba(255,255,255,.1)}
  .hg-cell .hg-v{font-size:26px}
  .hg-reserve{height:202px}
  .hg-ring{width:66px;height:66px}
  .hg-ringpct{font-size:17px}
  .hg-ringpc{font-size:8px}
  .hg-ringlab{font-size:8px}
  .hg-trend{margin-top:14px;margin-bottom:14px}
  /* 22px of card padding either side of a 66px ring and a wrapping title is 44px the phone does
     not have — and it is the 16px that puts the first card's bottom edge above the fold. */
  .hg-card{padding:14px}
}
`;


const HERO_FALLBACK =
  "Building the premier pickup soccer experience. We're rewriting how the world plays.";

export default function HomeGoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [history, setHistory] = useState<Record<string, number[]>>({});
  const [mission, setMission] = useState<string>(HERO_FALLBACK);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [commentsGoal, setCommentsGoal] = useState<Goal | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("goals")
      .select("*")
      .eq("scope", "org")
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    const rows = (data ?? []) as Goal[];
    setGoals(rows);

    const ids = rows.map((g) => g.id);
    if (ids.length) {
      const { data: h } = await supabase
        .from("goal_progress_history")
        .select("goal_id,progress,recorded_at")
        .in("goal_id", ids)
        .order("recorded_at", { ascending: true });
      const by: Record<string, number[]> = {};
      for (const r of (h ?? []) as { goal_id: string; progress: number }[]) {
        (by[r.goal_id] ??= []).push(r.progress);
      }
      setHistory(by);
    } else {
      setHistory({});
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let off = false;
    (async () => {
      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "hero_message")
        .maybeSingle();
      if (!off && data?.value) setMission(data.value as string);
    })();
    fetchSnapshot().then((s) => {
      if (!off) setSnap(s);
    });
    return () => {
      off = true;
    };
  }, []);

  const offPace = useMemo(
    () =>
      goals.filter((g) => {
        const k = computeGoalPace({
          progress: g.progress,
          startDate: g.start_date,
          createdAt: g.created_at,
          targetDate: g.target_date,
        }).status?.key;
        return k === "behind" || k === "risk";
      }).length,
    [goals],
  );

  return (
    <>
      <style>{HG_CSS}</style>
      <GradientDefs />
      <HeroBand mission={mission} snapshot={snap} />

      <div className="hg-bleed hg-wrap pb-16">
        {/* Goal deck pulled up into the hero band (the overlap is the point). */}
        <div className="hg-pull relative z-[2]">
          {/* Header sits in the pull zone, i.e. on the dark hero, so it uses the mockup's light
              on-forest colours. WRAPS, and aligns on centre rather than baseline: at 390 the
              title, the count and a 36px Add goal do not fit one line, and a baseline-aligned
              36px button against 13px text sits visibly low. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-[3px] pb-3">
            <h2 className="text-[13px] font-[750] uppercase tracking-[0.1em] text-[#a8cbbb]">
              Org goals
            </h2>
            <span className="text-[12px] font-medium text-[#7fa693]">
              {goals.length} goal{goals.length === 1 ? "" : "s"} ·{" "}
              {offPace > 0 ? `${offPace} off pace` : "all on pace"}
            </span>
            <span className="ml-auto">
              <button
                type="button"
                onClick={() => setDrawer({ mode: "create", scope: "org" })}
                // 36px MINIMUM: it was py-[6px] on 12px text, a 28px target on the one control
                // that creates a goal.
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-mint bg-mint px-[13px] text-[12px] font-bold text-deep-green transition hover:bg-mint-hover"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add goal
              </button>
            </span>
          </div>

          <div className="hg-deck grid items-start gap-[18px]">
            {goals.map((g) => (
              <OrgGoalCard
                key={g.id}
                goal={g}
                history={history[g.id] ?? []}
                onEdit={(goal) => setDrawer({ mode: "edit", goal })}
                onOpenComments={(goal) => setCommentsGoal(goal)}
              />
            ))}
          </div>
        </div>

        {/* This Week + P&D — full-width pair. */}
        <div className="hg-pair mt-[34px] grid items-start gap-[18px]">
          <CalendarPanel />
          <PdSchedulePanel />
        </div>
      </div>

      <GoalEditDrawer
        state={drawer}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          load();
        }}
      />
      <GoalCommentsDrawer goal={commentsGoal} onClose={() => setCommentsGoal(null)} />
    </>
  );
}

function HeroBand({
  mission,
  snapshot,
}: {
  mission: string;
  snapshot: Snapshot | null;
}) {
  return (
    <div
      className="relative left-1/2 w-screen -translate-x-1/2 -mt-[26px] overflow-hidden"
      style={{
        background:
          "radial-gradient(1100px 380px at 6% 150%, rgba(53,199,127,.24), transparent 62%)," +
          "radial-gradient(760px 320px at 88% -40%, rgba(44,219,135,.14), transparent 66%)," +
          "linear-gradient(168deg,#0f4234 0%, #0a3227 55%, #072a20 100%)",
      }}
    >
      {/* mowing stripes */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(90deg,rgba(196,242,219,.020) 0 118px,rgba(196,242,219,0) 118px 236px)",
        }}
      />
      {/* pitch backdrop (verbatim from the mockup) */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <svg
          viewBox="0 0 1600 500"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          className="block h-full w-full"
          style={{ color: "#c8f2dd", opacity: 0.075 }}
        >
          <path d="M14 14h1572v472H14z" />
          <path d="M800 14v472" />
          <circle cx="800" cy="250" r="112" />
          <circle cx="800" cy="250" r="5" fill="currentColor" stroke="none" />
          <path d="M14 86h206v328H14" />
          <path d="M14 178h74v144H14" />
          <circle cx="146" cy="250" r="5" fill="currentColor" stroke="none" />
          <path d="M220 182a112 112 0 0 1 0 136" />
          <path d="M1586 86h-206v328h206" />
          <path d="M1586 178h-74v144h74" />
          <circle cx="1454" cy="250" r="5" fill="currentColor" stroke="none" />
          <path d="M1380 182a112 112 0 0 0 0 136" />
          <path d="M14 44a30 30 0 0 0 30-30" />
          <path d="M1586 44a30 30 0 0 1-30-30" />
          <path d="M14 456a30 30 0 0 1 30 30" />
          <path d="M1586 456a30 30 0 0 0-30 30" />
        </svg>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(9,44,34,.72) 0%, rgba(9,44,34,.30) 34%, rgba(9,44,34,0) 62%)",
        }}
      />

      {/* Mission full-width, then the snapshot strip. Bottom padding leaves
          dark room for the -58px goal-deck overlap. */}
      <div className="hg-wrap hg-heroin relative">
        <span className="inline-block rounded-full border px-[11px] py-[5px] text-[10px] font-extrabold uppercase tracking-[0.15em]" style={{ color: "#8ff0c0", background: "rgba(53,199,127,.13)", borderColor: "rgba(53,199,127,.3)" }}>
          MatchDay mission
        </span>
        {/* 19px ON A PHONE, 25px FROM 760 UP — see HG_CSS. At 390 the 25px mission wrapped to six
            lines and spent about 200px of the first screen before a single number appeared; 19px
            measures around 100px and is still the largest type on the page. */}
        <h1 className="hg-mission max-w-[56ch] font-[660] leading-[1.35] tracking-[-0.018em]" style={{ color: "#f2fdf7" }}>
          {mission}
        </h1>
        <SnapshotStrip snapshot={snapshot} />
      </div>
    </div>
  );
}

function SnapshotStrip({ snapshot }: { snapshot: Snapshot | null }) {
  /* Reserve the strip's height while the queries resolve so the goal deck doesn't jump. The height
     follows the breakpoint — see .hg-reserve. */
  if (!snapshot) return <div aria-hidden className="hg-reserve mt-[26px]" data-testid="hg-reserve" />;
  const mo = snapshot.monthLabel;
  const cells: { k: string; v: string; u: string; title: string }[] = [];
  if (snapshot.revenueGross != null)
    cells.push({
      k: "Revenue",
      v: `$${Math.round(snapshot.revenueGross / 1000)}K`,
      u: "all 7 cities",
      title: `Gross revenue (before processing fees): SUM(fin_revenue.gross) for ${mo}. Basis: payment date (Stripe charge date), month-to-date. Not the match-date basis.`,
    });
  if (snapshot.monthlyPlayers != null)
    cells.push({
      k: "Monthly players",
      v: snapshot.monthlyPlayers.toLocaleString("en-US"),
      u: "unique players",
      title: `Distinct real players (user_is_fake_player = false) in non-cancelled matches with start_date in ${mo}, month-to-date.`,
    });
  if (snapshot.activeMembers != null)
    cells.push({
      k: "Active members",
      v: snapshot.activeMembers.toLocaleString("en-US"),
      /* "AS OF NOW", NOT MONTH TO DATE. The strip header above says "month to date" and three of
         these four tiles are; this one is a HEADCOUNT — it is not 28/31ths of anything, and it was
         sitting under a period claim it does not answer, exactly as Active fields was. */
      u: "paying · as of now",
      title: "Paying, external, activated members with status ACTIVE, right now — membershipStats"
        + ".countActiveMembers, the same predicate the Membership page and members_monthly_snapshots"
        + " use. Excludes 64 subscriptions priced at 0 and 40 @playmatchday.com staff accounts, which"
        + " is why this reads lower than the 455 ACTIVE rows in the table.",
    });
  if (snapshot.activeFields != null)
    cells.push({
      k: "Active fields",
      v: snapshot.activeFields.toLocaleString("en-US"),
      // "this month", so the tile agrees with the header above it and with its three neighbours.
      u: "this month",
      title:
        "Distinct mapped field IDs (fin_venue_fields) with a non-cancelled match dated this " +
        "calendar month, 1st to today — scheduled as well as ran. Counts pitches, not venues: " +
        "Soccer Central's three fields count as three." +
        (snapshot.activeFieldsUnmapped
          ? ` ${snapshot.activeFieldsUnmapped} further field${snapshot.activeFieldsUnmapped === 1 ? " has" : "s have"} matches this month with no fin_venue_fields row and ${snapshot.activeFieldsUnmapped === 1 ? "is" : "are"} not counted.`
          : ""),
    });
  if (cells.length === 0) return null;
  return (
    <div className="mt-[26px]">
      <div className="flex items-baseline gap-[10px] px-[3px] pb-[9px]">
        <span className="text-[11px] font-[780] uppercase tracking-[0.13em]" style={{ color: "#8fc4ac" }}>
          Operating snapshot
        </span>
        <span className="text-[12px] font-semibold" style={{ color: "#6ea78e" }}>
          {mo} · month to date
        </span>
      </div>
      <div
        className="hg-stats grid overflow-hidden rounded-[16px] border"
        data-testid="hg-stats"
        style={{
          // 2 x 2 below the breakpoint (see the hg-stats rule): four across at 390px gave each tile
          // ~80px, which wrapped "used in the last 30 days" onto three lines.
          ["--hg-cols" as string]: String(cells.length),
          background: "rgba(255,255,255,.055)",
          borderColor: "rgba(255,255,255,.13)",
          // NO backdrop-filter. It is decorative, and a backdrop-filter creates a CONTAINING BLOCK
          // for position:fixed descendants — the documented cause of a fixed bottom nav painting
          // mid-page. Not worth 2px of blur.
        }}
      >
        {cells.map((c) => (
          <div key={c.k} title={c.title} className="hg-cell">
            <div className="text-[9.5px] font-[750] uppercase tracking-[0.12em]" style={{ color: "#84bda2" }}>
              {c.k}
            </div>
            <div className="hg-v mt-[9px] font-[730] leading-none tracking-[-0.032em]" style={{ color: "#eafff4" }}>
              {c.v}
            </div>
            <div className="mt-[7px] text-[11.5px] font-semibold" style={{ color: "#6ea78e" }}>
              {c.u}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Ring gradient defs — referenced by OrgGoalCard's stroke url(#g*). Rendered
// once, off-screen.
function GradientDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <linearGradient id="gAhead" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6ee7ab" />
          <stop offset="100%" stopColor="#22a86a" />
        </linearGradient>
        <linearGradient id="gPace" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7fd7b0" />
          <stop offset="100%" stopColor="#2e9e70" />
        </linearGradient>
        <linearGradient id="gBehind" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f0cf7a" />
          <stop offset="100%" stopColor="#c9911a" />
        </linearGradient>
        <linearGradient id="gRisk" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4906f" />
          <stop offset="100%" stopColor="#cf4222" />
        </linearGradient>
      </defs>
    </svg>
  );
}
