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
      <GradientDefs />
      <HeroBand mission={mission} snapshot={snap} />

      <div className="mx-auto max-w-[1280px] px-[30px] pb-16">
        {/* Goal deck pulled up into the hero band (the overlap is the point). */}
        <div className="relative z-[2] -mt-[58px]">
          {/* Header sits in the -58px pull zone, i.e. on the dark hero, so it
              uses the mockup's light on-forest colours. */}
          <div className="flex items-baseline gap-3 px-[3px] pb-3">
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
                className="inline-flex items-center gap-1.5 rounded-full border border-mint bg-mint px-[13px] py-[6px] text-[12px] font-bold text-deep-green transition hover:bg-mint-hover"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add goal
              </button>
            </span>
          </div>

          <div
            className="grid items-start gap-[18px]"
            style={{ gridTemplateColumns: "repeat(auto-fill,minmax(430px,1fr))" }}
          >
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
        <div
          className="mt-[34px] grid items-start gap-[18px]"
          style={{ gridTemplateColumns: "repeat(auto-fit,minmax(400px,1fr))" }}
        >
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
      <div className="relative mx-auto max-w-[1280px] px-[30px] pb-[60px] pt-[38px]">
        <span className="inline-block rounded-full border px-[11px] py-[5px] text-[10px] font-extrabold uppercase tracking-[0.15em]" style={{ color: "#8ff0c0", background: "rgba(53,199,127,.13)", borderColor: "rgba(53,199,127,.3)" }}>
          MatchDay mission
        </span>
        <h1 className="mt-[14px] max-w-[56ch] text-[25px] font-[660] leading-[1.35] tracking-[-0.018em]" style={{ color: "#f2fdf7" }}>
          {mission}
        </h1>
        <SnapshotStrip snapshot={snapshot} />
      </div>
    </div>
  );
}

function SnapshotStrip({ snapshot }: { snapshot: Snapshot | null }) {
  // Reserve the strip's height while the queries resolve so the goal deck
  // doesn't jump.
  if (!snapshot) return <div aria-hidden className="mt-[26px] h-[112px]" />;
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
      u: "paid memberships",
      title: "mdapi_subscriptions with status = ACTIVE and price > 0, as of now.",
    });
  if (snapshot.activeFields != null)
    cells.push({
      k: "Active fields",
      v: snapshot.activeFields.toLocaleString("en-US"),
      u: "used in the last 30 days",
      title: "Distinct mdapi_matches.field_id with a non-cancelled match in the last 30 days.",
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
        className="grid overflow-hidden rounded-[16px] border"
        style={{
          gridTemplateColumns: `repeat(${cells.length},minmax(0,1fr))`,
          background: "rgba(255,255,255,.055)",
          borderColor: "rgba(255,255,255,.13)",
          backdropFilter: "blur(2px)",
        }}
      >
        {cells.map((c, i) => (
          <div key={c.k} title={c.title} className={`px-[22px] py-[16px] ${i ? "border-l" : ""}`} style={{ borderColor: "rgba(255,255,255,.1)" }}>
            <div className="text-[9.5px] font-[750] uppercase tracking-[0.12em]" style={{ color: "#84bda2" }}>
              {c.k}
            </div>
            <div className="mt-[9px] text-[31px] font-[730] leading-none tracking-[-0.032em]" style={{ color: "#eafff4" }}>
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
