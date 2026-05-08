"use client";

// Cities → Users sub-tab. Reads from /api/cities/users-lens (single
// server-side aggregation; lens UI is render-only). Six sections,
// described in Phase 2 spec.
//
// Cohort filter: every count on this page excludes internal users
// (isInternalUser — staff domains, +admin/+city/+test patterns,
// isFakePlayer). Filter happens server-side in the route; lens
// component just renders the numbers.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ---------------------------------------------------------------
// Types — mirror the route's UsersLensPayload exactly.
// ---------------------------------------------------------------

type Hero = {
  registered: number;
  completedSignup: number;
  completedSignupPctOfRegistered: number;
  played1: number;
  played1PctOfCompleted: number;
  active30d: number;
  active30dPctOfPlayed1: number;
  members: number;
  membersPctOfPlayed1: number;
};
type Funnel = {
  accountCreated: number;
  completedSignup: number;
  played1: number;
  played3: number;
  activeMember: number;
};
type ByCityRow = {
  city: string;
  registered: number;
  completedSignup: number;
  completedSignupPct: number;
  played1: number;
  played1Pct: number;
  active30d: number;
  members: number;
  activationRate: number;
};
type GrowthBucket = {
  period: string;
  bucketStart: string;
  signups: number;
  completedPct: number;
  played1Pct: number;
};
type FunnelSpeedRow = {
  city: string;
  medianDaysCreatedToCompleted: number | null;
  medianDaysCompletedToFirstMatch: number | null;
  medianDaysFirstToThirdMatch: number | null;
  medianDaysFirstMatchToMember: number | null;
  cohortSize: number;
};
type Matrix = {
  rows: string[];
  cols: string[];
  cells: number[][];
  rowTotals: number[];
  colTotals: number[];
  grandTotal: number;
};
type LensPayload = {
  lastSyncedAt: string | null;
  hero: Hero;
  funnel: Funnel;
  byCity: ByCityRow[];
  growthMonthly: GrowthBucket[];
  growthWeekly: GrowthBucket[];
  funnelSpeed: FunnelSpeedRow[];
  matrix: Matrix;
};

// ---------------------------------------------------------------
// Lens component.
// ---------------------------------------------------------------

export default function CitiesUsersLens() {
  const [data, setData] = useState<LensPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error("No active session — please sign in again.");
        const res = await fetch("/api/cities/users-lens", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        if (!cancelled) setData(json.payload as LensPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading user data… (~2s)
      </section>
    );
  }
  if (error) {
    return (
      <section className="rounded-2xl border border-coral/40 bg-coral-soft p-6 text-sm text-coral">
        {error}
      </section>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-4">
          <h2 className="text-2xl font-extrabold tracking-tight text-deep-green">
            Users
          </h2>
          <p className="text-sm text-deep-green/60">
            Cohort: every MatchDay account, including users who never played.
          </p>
          {data.lastSyncedAt && (
            <p className="mt-1 text-[11px] text-deep-green/50">
              Last synced: {timeAgo(data.lastSyncedAt)} ·{" "}
              <Link
                href="/data"
                className="underline-offset-2 hover:underline"
              >
                refresh on /data
              </Link>
            </p>
          )}
        </div>
      </section>

      <HeroKpis hero={data.hero} />
      <ActivationFunnel funnel={data.funnel} />
      <UsersByCityTable rows={data.byCity} />
      <GrowthChart monthly={data.growthMonthly} weekly={data.growthWeekly} />
      <FunnelSpeedTable rows={data.funnelSpeed} />
      <SignupMatrix matrix={data.matrix} />
    </div>
  );
}

// ---------------------------------------------------------------
// Section 1: Hero KPIs.
// ---------------------------------------------------------------

function HeroKpis({ hero }: { hero: Hero }) {
  return (
    <section>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Registered"
          value={hero.registered.toLocaleString()}
          hint="non-internal accounts"
        />
        <Stat
          label="Completed Signup"
          value={hero.completedSignup.toLocaleString()}
          hint={`${hero.completedSignupPctOfRegistered}% of registered`}
        />
        <Stat
          label="Played 1+"
          value={hero.played1.toLocaleString()}
          hint={`${hero.played1PctOfCompleted}% of completed`}
        />
        <Stat
          label="Active 30d"
          value={hero.active30d.toLocaleString()}
          hint={`${hero.active30dPctOfPlayed1}% of played 1+`}
        />
        <Stat
          label="Members"
          value={hero.members.toLocaleString()}
          hint={`${hero.membersPctOfPlayed1}% of played 1+`}
        />
      </div>
      <p className="mt-4 text-sm text-deep-green/65">
        <strong className="font-bold tabular-nums text-deep-green">
          {hero.completedSignup.toLocaleString()}
        </strong>{" "}
        of{" "}
        <strong className="font-bold tabular-nums text-deep-green">
          {hero.registered.toLocaleString()}
        </strong>{" "}
        registered users completed onboarding ({hero.completedSignupPctOfRegistered}%).
        Of those,{" "}
        <strong className="font-bold tabular-nums text-deep-green">
          {hero.played1.toLocaleString()}
        </strong>{" "}
        played at least one match ({hero.played1PctOfCompleted}%).{" "}
        <strong className="font-bold tabular-nums text-deep-green">
          {hero.members.toLocaleString()}
        </strong>{" "}
        are currently active members.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      <div className="mt-1 text-3xl font-extrabold tabular-nums text-deep-green">
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-deep-green/60">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------
// Section 2: 5-stage activation funnel.
// ---------------------------------------------------------------

function ActivationFunnel({ funnel }: { funnel: Funnel }) {
  const stages = [
    { name: "Account Created", count: funnel.accountCreated, prevCount: null as number | null },
    { name: "Completed Signup", count: funnel.completedSignup, prevCount: funnel.accountCreated },
    { name: "Played 1+ Match", count: funnel.played1, prevCount: funnel.completedSignup },
    { name: "Played 3+ Matches", count: funnel.played3, prevCount: funnel.played1 },
    // Active Member is % of Played 1+ per spec, not % of Played 3+.
    { name: "Active Member", count: funnel.activeMember, prevCount: funnel.played1 },
  ];
  // Identify the worst-performing stage by absolute drop-off count for
  // coral highlighting. Skip the baseline (no prevCount).
  const drops = stages
    .map((s, i) => ({
      i,
      drop: s.prevCount === null ? 0 : (s.prevCount ?? 0) - s.count,
    }))
    .filter((d) => d.drop > 0);
  const worstIdx =
    drops.length > 0 ? drops.reduce((a, b) => (b.drop > a.drop ? b : a)).i : -1;
  // Bar widths scaled to the baseline (Account Created = 100%).
  const baseline = funnel.accountCreated || 1;
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4">
        <h3 className="text-lg font-bold text-deep-green">
          Activation Funnel
        </h3>
        <p className="mt-0.5 text-xs text-deep-green/60">
          5-stage lifetime conversion. % shown is of the previous stage.
        </p>
      </div>
      <div className="space-y-3">
        {stages.map((s, i) => {
          const pctOfBase = (s.count / baseline) * 100;
          const pctOfPrev =
            s.prevCount === null
              ? 100
              : s.prevCount === 0
                ? 0
                : (s.count / s.prevCount) * 100;
          const drop = s.prevCount === null ? 0 : s.prevCount - s.count;
          const isWorst = i === worstIdx;
          return (
            <div key={s.name}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                <span className="font-bold text-deep-green">{s.name}</span>
                <span className="font-mono tabular-nums text-deep-green">
                  {s.count.toLocaleString()}
                  {s.prevCount !== null && (
                    <span className="ml-2 text-deep-green/55">
                      ({pctOfPrev.toFixed(1)}% of prev)
                    </span>
                  )}
                </span>
              </div>
              <div className="h-7 overflow-hidden rounded-md bg-cream-soft">
                <div
                  className={`h-full ${
                    isWorst ? "bg-coral/70" : "bg-deep-green/70"
                  }`}
                  style={{ width: `${Math.max(0.5, pctOfBase)}%` }}
                />
              </div>
              {drop > 0 && (
                <div className="mt-1 text-[11px] text-deep-green/50">
                  {drop.toLocaleString()} dropped off here
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-deep-green/55">
        Account Created → Completed Signup is the onboarding completion rate.
        Completed Signup → Played 1+ is the booking conversion rate.
        Played 1+ → Played 3+ is the retention rate.
        Played 1+ → Member is the monetization rate.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------
// Section 3: Users by City table (sortable).
// ---------------------------------------------------------------

type SortKey = keyof Pick<
  ByCityRow,
  | "city"
  | "registered"
  | "completedSignup"
  | "played1"
  | "active30d"
  | "members"
  | "activationRate"
>;

function UsersByCityTable({ rows }: { rows: ByCityRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("registered");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [rows, sortKey, sortDir]);

  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        registered: acc.registered + r.registered,
        completedSignup: acc.completedSignup + r.completedSignup,
        played1: acc.played1 + r.played1,
        active30d: acc.active30d + r.active30d,
        members: acc.members + r.members,
      }),
      { registered: 0, completedSignup: 0, played1: 0, active30d: 0, members: 0 },
    );
    const completedPct = t.registered > 0 ? (t.completedSignup / t.registered) * 100 : 0;
    const played1Pct = t.completedSignup > 0 ? (t.played1 / t.completedSignup) * 100 : 0;
    const activationRate = t.registered > 0 ? (t.played1 / t.registered) * 100 : 0;
    return { ...t, completedPct, played1Pct, activationRate };
  }, [rows]);

  function header(label: string, key: SortKey) {
    const active = sortKey === key;
    return (
      <button
        type="button"
        onClick={() => {
          if (active) setSortDir(sortDir === "asc" ? "desc" : "asc");
          else {
            setSortKey(key);
            setSortDir(typeof rows[0]?.[key] === "number" ? "desc" : "asc");
          }
        }}
        className={
          active
            ? "font-bold text-deep-green"
            : "text-deep-green/60 hover:text-deep-green"
        }
      >
        {label}
        {active && <span aria-hidden> {sortDir === "asc" ? "↑" : "↓"}</span>}
      </button>
    );
  }

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <h3 className="mb-4 text-lg font-bold text-deep-green">Users by City</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-cream-soft text-[10px] uppercase tracking-wider">
            <tr className="border-b border-cream-line">
              <th className="px-3 py-2 text-left">{header("City", "city")}</th>
              <th className="px-3 py-2 text-right">{header("Registered", "registered")}</th>
              <th className="px-3 py-2 text-right">{header("Completed Signup", "completedSignup")}</th>
              <th className="px-3 py-2 text-right">{header("Played 1+", "played1")}</th>
              <th className="px-3 py-2 text-right">{header("Active 30d", "active30d")}</th>
              <th className="px-3 py-2 text-right">{header("Members", "members")}</th>
              <th className="px-3 py-2 text-right">{header("Activation", "activationRate")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.city}
                className="border-t border-cream-line/40 hover:bg-cream-soft/40"
              >
                <td className="px-3 py-2 font-bold text-deep-green">{r.city}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {r.registered.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {r.completedSignup.toLocaleString()}
                  <span className="ml-1 text-[10px] text-deep-green/50">
                    ({r.completedSignupPct}%)
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {r.played1.toLocaleString()}
                  <span className="ml-1 text-[10px] text-deep-green/50">
                    ({r.played1Pct}%)
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {r.active30d.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {r.members.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-deep-green">
                  {r.activationRate.toFixed(1)}%
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-cream-line bg-cream-soft/40 font-bold">
              <td className="px-3 py-2 text-deep-green">Total</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.registered.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.completedSignup.toLocaleString()}{" "}
                <span className="text-[10px] font-normal text-deep-green/50">
                  ({totals.completedPct.toFixed(1)}%)
                </span>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.played1.toLocaleString()}{" "}
                <span className="text-[10px] font-normal text-deep-green/50">
                  ({totals.played1Pct.toFixed(1)}%)
                </span>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.active30d.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.members.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.activationRate.toFixed(1)}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------
// Section 4: New signups growth chart (Weekly / Monthly toggle).
// TODO: stacked-by-city variant — out of scope for Phase 2.
// ---------------------------------------------------------------

function GrowthChart({
  monthly,
  weekly,
}: {
  monthly: GrowthBucket[];
  weekly: GrowthBucket[];
}) {
  const [view, setView] = useState<"monthly" | "weekly">("monthly");
  const buckets = view === "monthly" ? monthly : weekly;
  const max = Math.max(1, ...buckets.map((b) => b.signups));
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-lg font-bold text-deep-green">New Signups</h3>
        <div className="inline-flex rounded-full bg-cream-soft p-1 ring-1 ring-cream-line">
          {(["monthly", "weekly"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={
                view === v
                  ? "rounded-full bg-mint px-3 py-1 text-[11px] font-bold text-deep-green"
                  : "rounded-full px-3 py-1 text-[11px] font-bold text-deep-green/60 hover:text-deep-green"
              }
            >
              {v === "monthly" ? "Monthly · 12mo" : "Weekly · 16wk"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex h-48 items-end gap-2 overflow-x-auto">
        {buckets.map((b) => (
          <div
            key={b.bucketStart}
            className="flex min-w-[36px] flex-1 flex-col items-center justify-end"
            title={`${b.period} · ${b.signups.toLocaleString()} signups · ${b.completedPct}% completed · ${b.played1Pct}% played 1+`}
          >
            <div className="mb-1 text-[10px] font-mono tabular-nums text-deep-green/65">
              {b.signups.toLocaleString()}
            </div>
            <div
              className="w-full rounded-t bg-deep-green/70 transition hover:bg-deep-green"
              style={{ height: `${(b.signups / max) * 100}%` }}
            />
            <div className="mt-1 text-[10px] text-deep-green/55">
              {b.period}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-deep-green/55">
        Hover a bar for the period&apos;s onboarding-completion and played-1+ rates.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------
// Section 5: Acquisition Funnel Speed.
// Uses last 90 days of cohort (server clamps). Phase 2b will replace
// this clamp with a window selector.
// ---------------------------------------------------------------

function FunnelSpeedTable({ rows }: { rows: FunnelSpeedRow[] }) {
  const fmt = (n: number | null) =>
    n == null ? "—" : n < 1 ? `<1d` : `${n.toFixed(1)}d`;
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4">
        <h3 className="text-lg font-bold text-deep-green">
          Acquisition Funnel Speed
        </h3>
        <p className="mt-0.5 text-xs text-deep-green/60">
          Median days between stages. Cohort = users registered in the last 90 days.
          Cells with n &lt; 5 show &quot;—&quot;.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-cream-soft text-[10px] uppercase tracking-wider text-deep-green/60">
            <tr className="border-b border-cream-line">
              <th className="px-3 py-2 text-left">City</th>
              <th className="px-3 py-2 text-right">Cohort n</th>
              <th className="px-3 py-2 text-right">Created → Completed</th>
              <th className="px-3 py-2 text-right">Completed → 1st match</th>
              <th className="px-3 py-2 text-right">1st → 3rd match</th>
              <th className="px-3 py-2 text-right">1st match → Member</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.city}
                className="border-t border-cream-line/40 hover:bg-cream-soft/40"
              >
                <td className="px-3 py-2 font-bold text-deep-green">{r.city}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/65">
                  {r.cohortSize.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {fmt(r.medianDaysCreatedToCompleted)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {fmt(r.medianDaysCompletedToFirstMatch)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {fmt(r.medianDaysFirstToThirdMatch)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {fmt(r.medianDaysFirstMatchToMember)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-deep-green/50">
        &quot;1st match → Member&quot; is an upper-bound proxy: days from first match to today
        for users who eventually became members. We don&apos;t store member-activation date
        per user, so this isn&apos;t exactly &quot;days to convert&quot;.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------
// Section 6: Signup City × First-Match City matrix.
// Diagonal cells highlighted. Color intensity = magnitude on a single
// teal ramp (lighter → darker).
// ---------------------------------------------------------------

function SignupMatrix({ matrix }: { matrix: Matrix }) {
  const max = Math.max(1, ...matrix.cells.flat());
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4">
        <h3 className="text-lg font-bold text-deep-green">
          Signup City × First-Match City
        </h3>
        <p className="mt-0.5 text-xs text-deep-green/60">
          Rows = signup city. Columns = city of first non-cancelled match.
          Diagonal = users who first played in their signup city.
          The right-most column counts users who haven&apos;t played yet.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white px-2 py-1 text-left text-[10px] uppercase tracking-wider text-deep-green/60">
                Signup ↓ &nbsp;/&nbsp; First match →
              </th>
              {matrix.cols.map((c) => (
                <th
                  key={c}
                  className="px-2 py-1 text-center text-[10px] uppercase tracking-wider text-deep-green/60"
                >
                  {c}
                </th>
              ))}
              <th className="px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-deep-green/70">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r, ri) => (
              <tr key={r}>
                <td className="sticky left-0 z-10 bg-white px-2 py-1 font-bold text-deep-green">
                  {r}
                </td>
                {matrix.cols.map((c, ci) => {
                  const v = matrix.cells[ri][ci];
                  const isDiagonal = r === c; // both arrays use same codes
                  // Color intensity: 0 = transparent, max = full mint.
                  const alpha = v === 0 ? 0 : 0.15 + (v / max) * 0.6;
                  const bg = isDiagonal
                    ? `rgba(29, 214, 122, ${alpha + 0.1})` // mint w/ slight diagonal lift
                    : `rgba(10, 26, 16, ${alpha * 0.45})`; // ink at low alpha
                  return (
                    <td
                      key={c}
                      title={`${r} → ${c}: ${v.toLocaleString()}`}
                      className={`px-2 py-1 text-center font-mono tabular-nums ${
                        isDiagonal ? "font-bold" : ""
                      }`}
                      style={{ backgroundColor: bg }}
                    >
                      {v === 0 ? (
                        <span className="text-deep-green/30">·</span>
                      ) : (
                        v.toLocaleString()
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-1 text-center font-mono font-bold tabular-nums text-deep-green">
                  {matrix.rowTotals[ri].toLocaleString()}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-cream-line">
              <td className="sticky left-0 z-10 bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/70">
                Total
              </td>
              {matrix.cols.map((c, ci) => (
                <td
                  key={c}
                  className="px-2 py-1 text-center font-mono font-bold tabular-nums text-deep-green"
                >
                  {matrix.colTotals[ci].toLocaleString()}
                </td>
              ))}
              <td className="px-2 py-1 text-center font-mono font-bold tabular-nums text-deep-green">
                {matrix.grandTotal.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
