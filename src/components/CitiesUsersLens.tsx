"use client";

// Cities → Users sub-tab. Reads from /api/cities/users-lens (single
// server-side aggregation; lens UI is render-only).
//
// Phase 2: 6 sections rendered from the route's payload.
// Phase 2b: time-window selector (All time / 2026 YTD / Last 90d /
// Last 12mo / Custom). The window filters cohort-based metrics
// (hero registered/completed/played1/members, funnel, byCity,
// funnelSpeed, matrix). It does NOT filter Active 30d (current
// activity) or growth-chart bars (which dim when outside window).
// State persists in URL search params (?window=last_90, etc.) so
// the page is shareable and back/forward navigates cleanly.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { CITY_STACK_ORDER, colorForCity } from "@/lib/cityColors";
import { colorForField } from "@/lib/fieldColors";

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
  active30dPctOfNetworkPlayed1: number;
  members: number;
  membersPctOfPlayed1: number;
};
type Funnel = {
  accountCreated: number;
  completedSignup: number;
  played1: number;
  played3: number;
  played5: number;
  played10: number;
  activeMember: number;
};
type ByCityRow = {
  city: string;
  registered: number;
  completedSignup: number;
  completedSignupPct: number;
  played1: number;
  played1Pct: number;
  played3: number;
  played3PctOfPlayed1: number;
  played5: number;
  played5PctOfPlayed1: number;
  played10: number;
  played10PctOfPlayed1: number;
  active30d: number;
  members: number;
  activationRate: number;
};
type GrowthBucket = {
  period: string;
  bucketStart: string;
  total: number;
  byCity: Record<string, number>;
  completedPct?: number;
  played1Pct?: number;
};
type GrowthSeries = {
  signups: GrowthBucket[];
  completed: GrowthBucket[];
  played: GrowthBucket[];
};

type GrowthMetric = "signups" | "completed" | "played";

const METRIC_PILLS: { value: GrowthMetric; label: string; explainer: string }[] =
  [
    {
      value: "signups",
      label: "Signups",
      explainer:
        "Anyone who created an account, including users who never finished onboarding.",
    },
    {
      value: "completed",
      label: "Completed signups",
      explainer:
        "Users who finished onboarding (selected a city, etc). Excludes ~70% of signups who abandon partway.",
    },
    {
      value: "played",
      label: "Played 1+",
      explainer:
        "First-time players, bucketed by their first match date. The truest growth metric.",
    },
  ];
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
type FirstMatchByFieldBucket = {
  period: string;
  bucketStart: string;
  total: number;
  byField: Record<string, number>;
};
type FirstMatchByFieldCity = {
  city: string;
  totalInWindow: number;
  fields: string[];
  buckets: FirstMatchByFieldBucket[];
};

type LensPayload = {
  lastSyncedAt: string | null;
  window: { fromIso: string | null; toIso: string | null };
  hero: Hero;
  funnel: Funnel;
  byCity: ByCityRow[];
  growthMonthly: GrowthSeries;
  growthWeekly: GrowthSeries;
  funnelSpeed: FunnelSpeedRow[];
  matrix: Matrix;
  firstMatchByFieldMonthly: FirstMatchByFieldCity[];
  firstMatchByFieldWeekly: FirstMatchByFieldCity[];
};

// ---------------------------------------------------------------
// Window selector — pill names live in URL as ?window=<name>.
// Custom uses ?window=custom&from=YYYY-MM-DD&to=YYYY-MM-DD.
// ---------------------------------------------------------------

type WindowName =
  | "all"
  | "mtd"
  | "qtd"
  | "2026_ytd"
  | "last_30"
  | "last_90"
  | "last_12m"
  | "custom";

// Pill order: All time first as default reset; current-period anchors
// (MTD, QTD, YTD) in increasing length; rolling windows (Last 30/90/12mo)
// in increasing length; Custom last. Wraps to two lines on narrow
// viewports via flex-wrap on the parent.
const WINDOW_PILLS: { value: WindowName; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "mtd", label: "MTD" },
  { value: "qtd", label: "QTD" },
  { value: "2026_ytd", label: "2026 YTD" },
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "last_12m", label: "Last 12 months" },
  { value: "custom", label: "Custom" },
];

function isoDay(d: Date): string {
  // YYYY-MM-DD in UTC so window boundaries are deterministic across
  // user timezones. Custom date inputs and preset boundaries both
  // pass through this so the route sees the same shape regardless
  // of where the user is.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetDates(
  name: WindowName,
  now: Date,
): { from: string | null; to: string | null } {
  if (name === "all") return { from: null, to: null };
  const today = isoDay(now);
  if (name === "mtd") {
    // First day of current UTC month → today.
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const from = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    return { from, to: today };
  }
  if (name === "qtd") {
    // First day of current UTC quarter (Jan/Apr/Jul/Oct 1) → today.
    const y = now.getUTCFullYear();
    const qStart = Math.floor(now.getUTCMonth() / 3) * 3;
    const from = `${y}-${String(qStart + 1).padStart(2, "0")}-01`;
    return { from, to: today };
  }
  if (name === "2026_ytd") {
    return { from: "2026-01-01", to: today };
  }
  if (name === "last_30") {
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from: isoDay(from), to: today };
  }
  if (name === "last_90") {
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    return { from: isoDay(from), to: today };
  }
  if (name === "last_12m") {
    const from = new Date(now);
    from.setUTCFullYear(from.getUTCFullYear() - 1);
    return { from: isoDay(from), to: today };
  }
  // custom — caller must supply from/to.
  return { from: null, to: null };
}

// Lens window name → snapshot_key for the route. Returns null for
// dynamic windows (mtd / qtd / last_30 / custom) which the snapshot
// doesn't pre-compute. 'all' maps to 'all_time' to match the
// snapshot table's key naming.
function lensWindowToSnapshotKey(name: WindowName): string | null {
  if (name === "all") return "all_time";
  if (name === "2026_ytd") return "2026_ytd";
  if (name === "last_90") return "last_90";
  if (name === "last_12m") return "last_12mo";
  return null;
}

function fmtDateLabel(iso: string | null): string {
  if (!iso) return "";
  // Parse YYYY-MM-DD as local-noon to dodge UTC-rollover off-by-ones.
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------
// Lens component.
// ---------------------------------------------------------------

export default function CitiesUsersLens() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // --- Read window state from URL ---
  // Default = "2026_ytd" when no params (Phase 3 Step 2c — recent
  // activity is more useful than 4 years of cumulative). Custom
  // requires both from + to. URL-param-set windows still resolve
  // as before; the default change only affects the no-param case.
  const urlWindow =
    (searchParams?.get("window") as WindowName | null) ?? "2026_ytd";
  const urlFrom = searchParams?.get("from") ?? null;
  const urlTo = searchParams?.get("to") ?? null;
  // --- Growth metric (Phase 2c) ---
  // Default = "signups". Validated against the pill set so a stale
  // URL value can't break the page.
  const urlMetric = searchParams?.get("growth_metric") as GrowthMetric | null;
  const validMetric = (
    METRIC_PILLS.map((p) => p.value) as string[]
  ).includes(urlMetric ?? "");
  const activeMetric: GrowthMetric = validMetric
    ? (urlMetric as GrowthMetric)
    : "signups";

  const isValidWindow = (WINDOW_PILLS.map((p) => p.value) as string[]).includes(
    urlWindow,
  );
  const activeWindow: WindowName = isValidWindow ? urlWindow : "all";

  // Compute concrete from/to dates for the route call. For presets,
  // resolve at render time so a "Last 90 days" link viewed two weeks
  // later picks up the rolling window. For custom, use URL values.
  const { fromForRoute, toForRoute, fromLabel, toLabel } = useMemo(() => {
    const now = new Date();
    if (activeWindow === "custom") {
      return {
        fromForRoute: urlFrom,
        toForRoute: urlTo,
        fromLabel: urlFrom,
        toLabel: urlTo,
      };
    }
    const { from, to } = presetDates(activeWindow, now);
    return {
      fromForRoute: from,
      toForRoute: to,
      fromLabel: from,
      toLabel: to,
    };
  }, [activeWindow, urlFrom, urlTo]);

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
        const qs = new URLSearchParams();
        if (fromForRoute) qs.set("from", fromForRoute);
        if (toForRoute) qs.set("to", toForRoute);
        // Stable windows have pre-computed snapshots — pass
        // ?snapshot_key= so the route serves <100ms instead of the
        // ~4.6s live aggregation. Dynamic windows (mtd / qtd /
        // last_30 / custom) and back-compat 'all' remain live.
        const snapshotKey = lensWindowToSnapshotKey(activeWindow);
        if (snapshotKey) qs.set("snapshot_key", snapshotKey);
        const url = qs.toString()
          ? `/api/cities/users-lens?${qs.toString()}`
          : `/api/cities/users-lens`;
        const res = await fetch(url, {
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
  }, [fromForRoute, toForRoute]);

  const setWindow = useCallback(
    (next: WindowName, customFrom?: string, customTo?: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "2026_ytd") {
        // 2026_ytd is now the default — drop the param to keep the
        // URL clean. The lens reads no-param URLs as 2026_ytd.
        params.delete("window");
        params.delete("from");
        params.delete("to");
      } else if (next === "custom") {
        params.set("window", "custom");
        if (customFrom) params.set("from", customFrom);
        if (customTo) params.set("to", customTo);
      } else {
        params.set("window", next);
        params.delete("from");
        params.delete("to");
      }
      const qs = params.toString();
      router.push(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  const setMetric = useCallback(
    (next: GrowthMetric) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "signups") params.delete("growth_metric");
      else params.set("growth_metric", next);
      const qs = params.toString();
      router.push(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );

  // --- Header always renders (with window selector) ---
  // Loading + error states swap into the body, but the pill row and
  // last-synced indicator stay visible so navigation between windows
  // is responsive.
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
          {data?.lastSyncedAt && (
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
        <WindowSelector
          active={activeWindow}
          urlFrom={urlFrom}
          urlTo={urlTo}
          onChange={setWindow}
        />
        {data && (
          <p className="mt-2 text-xs text-deep-green/55">
            Showing{" "}
            <strong className="font-bold tabular-nums text-deep-green">
              {data.hero.registered.toLocaleString()}
            </strong>{" "}
            registered users from{" "}
            <strong className="font-bold text-deep-green">
              {WINDOW_PILLS.find((p) => p.value === activeWindow)?.label ??
                "All time"}
            </strong>
            {fromLabel && toLabel
              ? ` (${fmtDateLabel(fromLabel)} → ${fmtDateLabel(toLabel)})`
              : activeWindow === "all"
                ? ""
                : ""}
          </p>
        )}
      </section>

      {loading && (
        <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
          Loading user data… (~2s)
        </section>
      )}
      {error && (
        <section className="rounded-2xl border border-coral/40 bg-coral-soft p-6 text-sm text-coral">
          {error}
        </section>
      )}
      {data && !loading && !error && (
        <>
          <HeroKpis hero={data.hero} />
          <ActivationFunnel funnel={data.funnel} />
          <UsersByCityTable rows={data.byCity} />
          <GrowthChart
            monthly={data.growthMonthly}
            weekly={data.growthWeekly}
            metric={activeMetric}
            onMetricChange={setMetric}
            windowFromIso={data.window.fromIso}
            windowToIso={data.window.toIso}
          />
          <SmallMultiples
            monthly={data.growthMonthly}
            weekly={data.growthWeekly}
            metric={activeMetric}
            windowFromIso={data.window.fromIso}
            windowToIso={data.window.toIso}
          />
          <FunnelSpeedTable
            rows={data.funnelSpeed}
            windowLabel={
              WINDOW_PILLS.find((p) => p.value === activeWindow)?.label ??
              "All time"
            }
          />
          <FirstMatchByField
            monthly={data.firstMatchByFieldMonthly}
            weekly={data.firstMatchByFieldWeekly}
            initialPeriod={
              (searchParams?.get("field_period") === "weekly"
                ? "weekly"
                : "monthly") as "monthly" | "weekly"
            }
            onPeriodChange={(p) => {
              const params = new URLSearchParams(
                searchParams?.toString() ?? "",
              );
              if (p === "monthly") params.delete("field_period");
              else params.set("field_period", "weekly");
              const qs = params.toString();
              router.push(qs ? `?${qs}` : "?", { scroll: false });
            }}
          />
          <SignupMatrix matrix={data.matrix} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Window selector — pill row + custom-range date inputs.
// ---------------------------------------------------------------

function WindowSelector({
  active,
  urlFrom,
  urlTo,
  onChange,
}: {
  active: WindowName;
  urlFrom: string | null;
  urlTo: string | null;
  onChange: (next: WindowName, customFrom?: string, customTo?: string) => void;
}) {
  const today = useMemo(() => isoDay(new Date()), []);
  // Default custom range to last 90 days when activating Custom for
  // the first time. Once URL has from/to, those win.
  const ninetyDaysAgo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return isoDay(d);
  }, []);
  const [customFrom, setCustomFrom] = useState<string>(
    urlFrom ?? ninetyDaysAgo,
  );
  const [customTo, setCustomTo] = useState<string>(urlTo ?? today);
  const [customError, setCustomError] = useState<string | null>(null);

  // Sync local custom-input state when URL changes (e.g. via back/forward).
  useEffect(() => {
    if (urlFrom) setCustomFrom(urlFrom);
    if (urlTo) setCustomTo(urlTo);
  }, [urlFrom, urlTo]);

  function applyCustom() {
    setCustomError(null);
    if (!customFrom || !customTo) {
      setCustomError("Both start and end dates are required.");
      return;
    }
    if (customFrom > customTo) {
      setCustomError("Start date must be on or before end date.");
      return;
    }
    if (customTo > today) {
      setCustomError("End date can't be in the future.");
      return;
    }
    onChange("custom", customFrom, customTo);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {WINDOW_PILLS.map((p) => {
          const isActive = p.value === active;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                if (p.value === "custom") {
                  // Activating Custom for the first time pushes the
                  // current local-state defaults to the URL.
                  onChange("custom", customFrom, customTo);
                } else {
                  onChange(p.value);
                }
              }}
              aria-pressed={isActive}
              className={
                isActive
                  ? "rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
                  : "rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green/65 transition hover:bg-cream-soft hover:text-deep-green"
              }
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {active === "custom" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-cream-line bg-cream-soft/40 p-3">
          <label className="block">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
              From
            </div>
            <input
              type="date"
              value={customFrom}
              max={today}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm font-mono text-deep-green focus:border-deep-green focus:outline-none"
            />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
              To
            </div>
            <input
              type="date"
              value={customTo}
              max={today}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-cream-line bg-white px-3 py-1.5 text-sm font-mono text-deep-green focus:border-deep-green focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={applyCustom}
            className="rounded-md bg-deep-green px-4 py-1.5 text-sm font-bold text-cream transition hover:bg-deep-green-soft"
          >
            Apply
          </button>
          {customError && (
            <span className="text-xs text-coral">{customError}</span>
          )}
        </div>
      )}
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
          tooltip="Recent cohorts may have lower activation rates simply because they haven't had time to play yet. Compare windows of equal length for fairer comparison."
        />
        <Stat
          label="Active 30d"
          value={hero.active30d.toLocaleString()}
          hint={`${hero.active30dPctOfNetworkPlayed1}% of all-time players`}
          subhint="network-wide, not cohort-filtered"
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
  subhint,
  tooltip,
}: {
  label: string;
  value: string;
  hint?: string;
  subhint?: string;
  tooltip?: string;
}) {
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex items-center gap-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
          {label}
        </div>
        {tooltip && (
          <span
            title={tooltip}
            aria-label={tooltip}
            className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-deep-green/15 text-[9px] font-bold text-deep-green/70"
          >
            i
          </span>
        )}
      </div>
      <div className="mt-1 text-3xl font-extrabold tabular-nums text-deep-green">
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-deep-green/60">{hint}</div>}
      {subhint && (
        <div className="text-[10px] italic text-deep-green/45">{subhint}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// Section 2: 5-stage activation funnel.
// ---------------------------------------------------------------

function ActivationFunnel({ funnel }: { funnel: Funnel }) {
  // Played 3+/5+/10+ chain successively (each % is of the previous
  // played-N). Active Member breaks that chain — its prevCount stays
  // anchored to Played 1+ since member status is independent of how
  // many matches the user has played.
  const stages = [
    { name: "Account Created", count: funnel.accountCreated, prevCount: null as number | null },
    { name: "Completed Signup", count: funnel.completedSignup, prevCount: funnel.accountCreated },
    { name: "Played 1+ Match", count: funnel.played1, prevCount: funnel.completedSignup },
    { name: "Played 3+ Matches", count: funnel.played3, prevCount: funnel.played1 },
    { name: "Played 5+ Matches", count: funnel.played5, prevCount: funnel.played3 },
    { name: "Played 10+ Matches", count: funnel.played10, prevCount: funnel.played5 },
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
        Played 1+ → Played 3+ → Played 5+ → Played 10+ shows deepening
        retention. Played 1+ → Member is the monetization rate.
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
  | "played3"
  | "played5"
  | "played10"
  | "members"
  | "activationRate"
  | "active30d"
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

  // Totals row sums absolute counts across cities. Percentage cells
  // recompute from the totals (not a sum of per-city percentages),
  // which is the only way the network rate matches what hero/funnel
  // show.
  const totals = useMemo(() => {
    const t = rows.reduce(
      (acc, r) => ({
        registered: acc.registered + r.registered,
        completedSignup: acc.completedSignup + r.completedSignup,
        played1: acc.played1 + r.played1,
        played3: acc.played3 + r.played3,
        played5: acc.played5 + r.played5,
        played10: acc.played10 + r.played10,
        active30d: acc.active30d + r.active30d,
        members: acc.members + r.members,
      }),
      {
        registered: 0,
        completedSignup: 0,
        played1: 0,
        played3: 0,
        played5: 0,
        played10: 0,
        active30d: 0,
        members: 0,
      },
    );
    const completedPct =
      t.registered > 0 ? (t.completedSignup / t.registered) * 100 : 0;
    const played1Pct =
      t.completedSignup > 0 ? (t.played1 / t.completedSignup) * 100 : 0;
    const played3Pct = t.played1 > 0 ? (t.played3 / t.played1) * 100 : 0;
    const played5Pct = t.played1 > 0 ? (t.played5 / t.played1) * 100 : 0;
    const played10Pct = t.played1 > 0 ? (t.played10 / t.played1) * 100 : 0;
    const activationRate =
      t.registered > 0 ? (t.played1 / t.registered) * 100 : 0;
    return {
      ...t,
      completedPct,
      played1Pct,
      played3Pct,
      played5Pct,
      played10Pct,
      activationRate,
    };
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

  // Single cell render for "count (pct%)" right-aligned. Used by all
  // played-N depth columns so the formatting stays in lockstep.
  const numericCell = (count: number, pct: number) => (
    <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
      {count.toLocaleString()}
      <span className="ml-1 text-[10px] text-deep-green/50">
        ({pct.toFixed(1)}%)
      </span>
    </td>
  );

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <h3 className="mb-4 text-lg font-bold text-deep-green">Users by City</h3>
      <p className="mb-3 text-[11px] text-deep-green/55">
        Played 3+ / 5+ / 10+ percentages are share of THAT row&apos;s
        Played 1+ — read across to see the retention curve narrow per
        city.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-cream-soft text-[10px] uppercase tracking-wider">
            <tr className="border-b border-cream-line">
              <th className="px-3 py-2 text-left">{header("City", "city")}</th>
              <th className="px-3 py-2 text-right">{header("Registered", "registered")}</th>
              <th className="px-3 py-2 text-right">{header("Completed Signup", "completedSignup")}</th>
              <th className="px-3 py-2 text-right">{header("Played 1+", "played1")}</th>
              <th className="px-3 py-2 text-right">{header("Played 3+", "played3")}</th>
              <th className="px-3 py-2 text-right">{header("Played 5+", "played5")}</th>
              <th className="px-3 py-2 text-right">{header("Played 10+", "played10")}</th>
              <th className="px-3 py-2 text-right">{header("Members", "members")}</th>
              <th className="px-3 py-2 text-right">{header("Activation", "activationRate")}</th>
              <th className="px-3 py-2 text-right">{header("Active 30d", "active30d")}</th>
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
                {numericCell(r.completedSignup, r.completedSignupPct)}
                {numericCell(r.played1, r.played1Pct)}
                {numericCell(r.played3, r.played3PctOfPlayed1)}
                {numericCell(r.played5, r.played5PctOfPlayed1)}
                {numericCell(r.played10, r.played10PctOfPlayed1)}
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {r.members.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-deep-green">
                  {r.activationRate.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                  {r.active30d.toLocaleString()}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-cream-line bg-cream-soft/40 font-bold">
              <td className="px-3 py-2 text-deep-green">Total</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.registered.toLocaleString()}
              </td>
              {numericCell(totals.completedSignup, totals.completedPct)}
              {numericCell(totals.played1, totals.played1Pct)}
              {numericCell(totals.played3, totals.played3Pct)}
              {numericCell(totals.played5, totals.played5Pct)}
              {numericCell(totals.played10, totals.played10Pct)}
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.members.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.activationRate.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green">
                {totals.active30d.toLocaleString()}
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

// Bar-area height in CSS pixels. Per spec, "Bar max height should be
// ~140-160px so the chart isn't disproportionately tall." Sum of all
// bucket segments scales to fill this area for the largest bucket;
// other buckets scale proportionally.
const BAR_AREA_PX = 150;

function GrowthChart({
  monthly,
  weekly,
  metric,
  onMetricChange,
  windowFromIso,
  windowToIso,
}: {
  monthly: GrowthSeries;
  weekly: GrowthSeries;
  metric: GrowthMetric;
  onMetricChange: (next: GrowthMetric) => void;
  windowFromIso: string | null;
  windowToIso: string | null;
}) {
  const [view, setView] = useState<"monthly" | "weekly">("monthly");
  const buckets = (view === "monthly" ? monthly : weekly)[metric];
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const activePill = METRIC_PILLS.find((p) => p.value === metric);
  // Phase 2b: bars whose bucketStart falls outside the selected window
  // are dimmed to 30% opacity. When no window is set (All time), all
  // bars render at full opacity.
  const fromMs = windowFromIso ? new Date(windowFromIso).getTime() : null;
  const toMs = windowToIso ? new Date(windowToIso).getTime() : null;
  const inWindow = (bucketStart: string): boolean => {
    if (fromMs === null && toMs === null) return true;
    const t = new Date(`${bucketStart}T00:00:00.000Z`).getTime();
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  };
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

      {/* Metric toggle. Drives both this chart and the small-multiples
          grid below. URL-persisted via ?growth_metric=. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {METRIC_PILLS.map((p) => {
          const isActive = p.value === metric;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => onMetricChange(p.value)}
              aria-pressed={isActive}
              className={
                isActive
                  ? "rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green"
                  : "rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green/65 hover:bg-cream-soft hover:text-deep-green"
              }
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {activePill && (
        <p className="mb-3 text-[11px] text-deep-green/55">
          {activePill.explainer}
        </p>
      )}

      {/* Legend — same color/order as the stacked segments below. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-deep-green/65">
        {CITY_STACK_ORDER.map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: colorForCity(c) }}
            />
            {c}
          </span>
        ))}
      </div>

      <div className="flex items-end gap-2 overflow-x-auto">
        {buckets.map((b) => {
          const dim = !inWindow(b.bucketStart);
          // Build the per-city tooltip line. Order matches the stack
          // (ATX first → Unknown last). Only non-zero entries surface
          // so a month with no SATX entries doesn't pollute the line.
          const cityLines = CITY_STACK_ORDER.filter(
            (c) => (b.byCity[c] ?? 0) > 0,
          )
            .map((c) => `${c} ${(b.byCity[c] ?? 0).toLocaleString()}`)
            .join(", ");
          // Tooltip header: total + active metric label. For the
          // Signups series we also surface the bucket-set's
          // completed/played-1+ rates (only meaningful there).
          const metricLabel = activePill?.label.toLowerCase() ?? "signups";
          const ratesLine =
            metric === "signups" &&
            b.completedPct !== undefined &&
            b.played1Pct !== undefined
              ? `\n${b.completedPct}% completed · ${b.played1Pct}% played 1+`
              : "";
          const tooltip =
            `${b.period}\n` +
            `${b.total.toLocaleString()} ${metricLabel}` +
            ratesLine +
            "\n" +
            (cityLines ? `By city: ${cityLines}` : "By city: (none)") +
            (dim ? "\noutside selected window" : "");
          // Total height for this bucket's stack (px). All buckets
          // share the same scale so visual heights are comparable
          // across periods.
          const totalPx = (b.total / max) * BAR_AREA_PX;
          // Render segments bottom-up via flex-col-reverse: first
          // child (ATX) lands at the bottom, last (Unknown) at top.
          return (
            <div
              key={b.bucketStart}
              className="flex min-w-[36px] flex-1 flex-col items-center"
              title={tooltip}
              style={{ opacity: dim ? 0.3 : 1 }}
            >
              <div className="mb-1 text-[10px] font-mono tabular-nums text-deep-green/65">
                {b.total.toLocaleString()}
              </div>
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t"
                style={{ height: `${BAR_AREA_PX}px` }}
              >
                {/* Empty filler so an empty bucket still occupies the
                    full height. The segments stack from the bottom
                    upward via flex-col-reverse; this filler sits at
                    the top of the column for non-zero bars. */}
                <div style={{ flex: "1 0 auto" }} />
                {CITY_STACK_ORDER.map((c) => {
                  const n = b.byCity[c] ?? 0;
                  if (n === 0) return null;
                  const segPx = (n / max) * BAR_AREA_PX;
                  return (
                    <div
                      key={c}
                      style={{
                        height: `${segPx}px`,
                        background: colorForCity(c),
                        flex: "0 0 auto",
                      }}
                    />
                  );
                })}
                {/* Hairline cap so a single-segment bar gets a clean
                    top edge against the background. */}
                {totalPx > 0 && (
                  <div
                    style={{
                      flex: "0 0 auto",
                      height: 0,
                    }}
                  />
                )}
              </div>
              <div className="mt-1 text-[10px] text-deep-green/55">
                {b.period}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-deep-green/55">
        Bars are stacked by signup city in the order shown above. Bars outside
        the selected cohort window are dimmed. Hover a bar for the period&apos;s
        per-city breakdown plus onboarding-completion and played-1+ rates.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------
// Section 5: Acquisition Funnel Speed.
// Uses last 90 days of cohort (server clamps). Phase 2b will replace
// this clamp with a window selector.
// ---------------------------------------------------------------

function FunnelSpeedTable({
  rows,
  windowLabel,
}: {
  rows: FunnelSpeedRow[];
  windowLabel: string;
}) {
  const fmt = (n: number | null) =>
    n == null ? "—" : n < 1 ? `<1d` : `${n.toFixed(1)}d`;
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4">
        <h3 className="text-lg font-bold text-deep-green">
          Acquisition Funnel Speed
        </h3>
        <p className="mt-0.5 text-xs text-deep-green/60">
          Median days between stages. Cohort ={" "}
          <strong className="font-bold text-deep-green">{windowLabel}</strong>{" "}
          (matches the window selector at the top of the page). Cells with n
          &lt; 5 show &quot;—&quot;.
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

// ---------------------------------------------------------------
// First Match by Field — per-city stacked bars, one user counted
// once at their first field. Cities rendered in alphabetical order
// (ATL, ATX, DFW, ELP, HOU, OKC, SATX, STL, Unknown last) per spec.
// Window selector + Monthly/Weekly toggle drive the data.
// ---------------------------------------------------------------

// Line-chart layout dimensions. The card is now table-first; the
// chart sits below as a visual trend supplement, ~30% shorter than
// the line-only version since the table does the precision work.
const FMBF_PLOT_HEIGHT = 90;
const FMBF_LABEL_PAD_TOP = 16; // margin above the plot for marker labels
const FMBF_X_LABEL_HEIGHT = 14;
const FMBF_Y_AXIS_WIDTH = 30;
const FMBF_SVG_WIDTH = 340;
const FMBF_SVG_HEIGHT =
  FMBF_LABEL_PAD_TOP + FMBF_PLOT_HEIGHT + FMBF_X_LABEL_HEIGHT;

function FirstMatchByField({
  monthly,
  weekly,
  initialPeriod,
  onPeriodChange,
}: {
  monthly: FirstMatchByFieldCity[];
  weekly: FirstMatchByFieldCity[];
  initialPeriod: "monthly" | "weekly";
  onPeriodChange: (p: "monthly" | "weekly") => void;
}) {
  const [period, setPeriod] = useState<"monthly" | "weekly">(initialPeriod);
  // Keep local state in sync with URL changes (back/forward).
  useEffect(() => {
    setPeriod(initialPeriod);
  }, [initialPeriod]);

  const series = period === "monthly" ? monthly : weekly;

  // Render order: alphabetical by city code, then Unknown last.
  const ALPHA = ["ATL", "ATX", "DFW", "ELP", "HOU", "OKC", "SATX", "STL"];
  const ordered = [
    ...ALPHA.map((c) => series.find((s) => s.city === c)).filter(
      (s): s is FirstMatchByFieldCity => !!s,
    ),
    ...series.filter((s) => s.city === "Unknown"),
  ];

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-deep-green">
            First Match by Field
          </h3>
          <p className="mt-0.5 text-xs text-deep-green/60">
            Where new players landed for their first ever match. Each user
            counted once, at their first field.
          </p>
        </div>
        <div className="inline-flex rounded-full bg-cream-soft p-1 ring-1 ring-cream-line">
          {(["monthly", "weekly"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setPeriod(v);
                onPeriodChange(v);
              }}
              className={
                period === v
                  ? "rounded-full bg-mint px-3 py-1 text-[11px] font-bold text-deep-green"
                  : "rounded-full px-3 py-1 text-[11px] font-bold text-deep-green/60 hover:text-deep-green"
              }
            >
              {v === "monthly" ? "Monthly · 12mo" : "Weekly · 16wk"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {ordered.map((c) => (
          <CityFirstMatchChart key={c.city} city={c} periodType={period} />
        ))}
      </div>
    </section>
  );
}

function CityFirstMatchChart({
  city,
  periodType,
}: {
  city: FirstMatchByFieldCity;
  periodType: "monthly" | "weekly";
}) {
  // Max value across ANY (bucket, field) pair in this city — sets the
  // y-axis ceiling so small fields stay readable while big fields
  // anchor the top of the plot. NOT the max bucket total (that would
  // squash small lines).
  const maxValue = Math.max(
    1,
    ...city.fields.flatMap((f) =>
      city.buckets.map((b) => b.byField[f] ?? 0),
    ),
  );
  const hasAnyData = city.buckets.some((b) => b.total > 0);
  const bucketCount = city.buckets.length;

  // SVG coordinate helpers. plot area sits inside the SVG with reserved
  // padding above (for labels) and below (for x-axis tick text), and a
  // y-axis-width column on the left for tick labels.
  const plotLeft = FMBF_Y_AXIS_WIDTH;
  const plotRight = FMBF_SVG_WIDTH;
  const plotTop = FMBF_LABEL_PAD_TOP;
  const plotBottom = FMBF_LABEL_PAD_TOP + FMBF_PLOT_HEIGHT;
  const plotW = plotRight - plotLeft;
  const slotW = plotW / Math.max(1, bucketCount);
  const xFor = (i: number) => plotLeft + slotW * (i + 0.5);
  const yFor = (n: number) =>
    plotBottom - (n / maxValue) * FMBF_PLOT_HEIGHT;

  // Y-axis ticks: 0 + max, plus midpoint when max >= 4 so the scale is
  // legible for small-volume cities without cluttering bigger ones.
  const midTick = maxValue >= 4 ? Math.round(maxValue / 2) : null;

  // X-axis label stride: weekly view (16 buckets) shows every-other to
  // avoid crowding; monthly (12) shows all.
  const labelStride = bucketCount > 12 ? 2 : 1;

  return (
    <div className="rounded-lg border border-cream-line bg-cream-soft/30 p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold text-deep-green">{city.city}</span>
        <span className="text-[10px] font-mono tabular-nums text-deep-green/55">
          {city.totalInWindow.toLocaleString()} first matches
        </span>
      </div>

      {!hasAnyData ? (
        <div
          className="rounded border border-dashed border-cream-line bg-white/40 px-3 py-6 text-center text-[11px] italic text-deep-green/45"
          style={{ minHeight: `${FMBF_PLOT_HEIGHT + 30}px` }}
        >
          No first matches in this window.
        </div>
      ) : (
        <>
          {/* Per-field × per-period table — fields as rows (largest
              total first, mirroring the route's `fields` ordering).
              Empty cells render as a muted em-dash rather than "0"
              so the eye skips them. Last column = row total; last
              row = column totals. Horizontal scroll inside the card
              for narrow viewports. */}
          <div className="mb-3 overflow-x-auto">
            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr className="border-b border-cream-line text-[9px] uppercase tracking-wider text-deep-green/55">
                  <th className="px-2 py-1 text-left font-bold">Field</th>
                  {city.buckets.map((b) => (
                    <th
                      key={b.bucketStart}
                      className="px-1.5 py-1 text-right font-mono tabular-nums"
                    >
                      {periodType === "monthly"
                        ? b.period.slice(0, 3)
                        : b.period}
                    </th>
                  ))}
                  <th className="px-2 py-1 text-right font-bold">Total</th>
                </tr>
              </thead>
              <tbody>
                {city.fields.map((f) => {
                  const rowTotal = city.buckets.reduce(
                    (s, b) => s + (b.byField[f] ?? 0),
                    0,
                  );
                  return (
                    <tr
                      key={f}
                      className="border-b border-cream-line/40"
                    >
                      <td className="whitespace-nowrap px-2 py-1 font-bold text-deep-green">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="inline-block h-2 w-2 rounded-sm"
                            style={{ background: colorForField(f) }}
                          />
                          {f}
                        </span>
                      </td>
                      {city.buckets.map((b) => {
                        const v = b.byField[f] ?? 0;
                        return (
                          <td
                            key={b.bucketStart}
                            className="px-1.5 py-1 text-right font-mono tabular-nums text-deep-green"
                          >
                            {v === 0 ? (
                              <span className="text-deep-green/30">—</span>
                            ) : (
                              v.toLocaleString()
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1 text-right font-mono tabular-nums font-bold text-deep-green">
                        {rowTotal.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-cream-line bg-cream-soft/40">
                  <td className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-deep-green/70">
                    Total
                  </td>
                  {city.buckets.map((b) => (
                    <td
                      key={b.bucketStart}
                      className="px-1.5 py-1 text-right font-mono tabular-nums font-bold text-deep-green"
                    >
                      {b.total === 0 ? (
                        <span className="text-deep-green/30">—</span>
                      ) : (
                        b.total.toLocaleString()
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-mono tabular-nums font-bold text-deep-green">
                    {city.totalInWindow.toLocaleString()}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <svg
            viewBox={`0 0 ${FMBF_SVG_WIDTH} ${FMBF_SVG_HEIGHT}`}
            preserveAspectRatio="none"
            className="w-full"
            style={{ height: `${FMBF_SVG_HEIGHT}px` }}
            role="img"
            aria-label={`${city.city} first match by field over time`}
          >
            {/* y-axis tick lines + labels */}
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={plotBottom}
              y2={plotBottom}
              stroke="rgba(10, 26, 16, 0.15)"
              strokeWidth={1}
            />
            <text
              x={plotLeft - 4}
              y={plotBottom + 3}
              fontSize={9}
              textAnchor="end"
              fill="rgba(10, 26, 16, 0.45)"
            >
              0
            </text>
            <text
              x={plotLeft - 4}
              y={plotTop + 3}
              fontSize={9}
              textAnchor="end"
              fill="rgba(10, 26, 16, 0.45)"
            >
              {maxValue.toLocaleString()}
            </text>
            {midTick !== null && (
              <>
                <line
                  x1={plotLeft}
                  x2={plotRight}
                  y1={yFor(midTick)}
                  y2={yFor(midTick)}
                  stroke="rgba(10, 26, 16, 0.08)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
                <text
                  x={plotLeft - 4}
                  y={yFor(midTick) + 3}
                  fontSize={9}
                  textAnchor="end"
                  fill="rgba(10, 26, 16, 0.45)"
                >
                  {midTick.toLocaleString()}
                </text>
              </>
            )}

            {/* one polyline + markers + labels per field */}
            {city.fields.map((f) => {
              const color = colorForField(f);
              const points = city.buckets.map((b, i) => ({
                x: xFor(i),
                y: yFor(b.byField[f] ?? 0),
                v: b.byField[f] ?? 0,
                period: b.period,
              }));
              const polyPoints = points
                .map((p) => `${p.x},${p.y}`)
                .join(" ");
              return (
                <g key={f}>
                  <polyline
                    points={polyPoints}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {points.map((p, i) => (
                    <g key={i}>
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={3}
                        fill={color}
                        stroke="white"
                        strokeWidth={1}
                      >
                        <title>
                          {`${f} · ${p.period}: ${p.v.toLocaleString()} first matches`}
                        </title>
                      </circle>
                      {/* Numeric label above the marker. Skip zeros —
                          a "0" label on a line dipping to baseline
                          adds noise without information. */}
                      {p.v > 0 && (
                        <text
                          x={p.x}
                          y={p.y - 6}
                          fontSize={9}
                          textAnchor="middle"
                          fill={color}
                          fontWeight={600}
                          style={{ paintOrder: "stroke" }}
                          stroke="white"
                          strokeWidth={3}
                        >
                          {p.v.toLocaleString()}
                        </text>
                      )}
                    </g>
                  ))}
                </g>
              );
            })}

            {/* x-axis period labels */}
            {city.buckets.map((b, i) =>
              i % labelStride === 0 ? (
                <text
                  key={b.bucketStart}
                  x={xFor(i)}
                  y={plotBottom + FMBF_X_LABEL_HEIGHT - 2}
                  fontSize={9}
                  textAnchor="middle"
                  fill="rgba(10, 26, 16, 0.45)"
                >
                  {b.period.slice(0, 3)}
                </text>
              ) : null,
            )}
          </svg>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-deep-green/65">
            {city.fields.map((f) => (
              <span key={f} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: colorForField(f) }}
                />
                {f}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

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
// Small multiples — 9 mini bar charts in a 3×3 grid, one per city.
// Each city gets its own y-axis (so ELP at hundreds and ATX at
// thousands stay both readable). Driven by the same metric toggle +
// view (Monthly/Weekly) + window dimming as the stacked chart above.
// ---------------------------------------------------------------

function SmallMultiples({
  monthly,
  weekly,
  metric,
  windowFromIso,
  windowToIso,
}: {
  monthly: GrowthSeries;
  weekly: GrowthSeries;
  metric: GrowthMetric;
  windowFromIso: string | null;
  windowToIso: string | null;
}) {
  // Mirror the parent chart's view choice. Could be lifted into a
  // shared parent state later; for now both default to Monthly so
  // they read together on first paint.
  const [view, setView] = useState<"monthly" | "weekly">("monthly");
  const buckets = (view === "monthly" ? monthly : weekly)[metric];
  const fromMs = windowFromIso ? new Date(windowFromIso).getTime() : null;
  const toMs = windowToIso ? new Date(windowToIso).getTime() : null;
  const inWindow = (bucketStart: string): boolean => {
    if (fromMs === null && toMs === null) return true;
    const t = new Date(`${bucketStart}T00:00:00.000Z`).getTime();
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  };

  const metricLabel =
    METRIC_PILLS.find((p) => p.value === metric)?.label.toLowerCase() ??
    "signups";

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-deep-green">By city</h3>
          <p className="mt-0.5 text-xs text-deep-green/60">
            Each city scaled to its own y-axis. Hover bars for exact counts.
          </p>
        </div>
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CITY_STACK_ORDER.map((city) => (
          <CityMini
            key={city}
            city={city}
            buckets={buckets}
            metricLabel={metricLabel}
            inWindow={inWindow}
            view={view}
          />
        ))}
      </div>
    </section>
  );
}

const MINI_BAR_AREA_PX = 110;
// Reserved space ABOVE the tallest bar for the always-visible count
// label. Label height (~10px font + tiny breathing room) ensures
// labels for tall bars don't clip the chart's top edge.
const MINI_LABEL_PX = 14;
const MINI_TOTAL_PX = MINI_BAR_AREA_PX + MINI_LABEL_PX;

function CityMini({
  city,
  buckets,
  metricLabel,
  inWindow,
  view,
}: {
  city: string;
  buckets: GrowthBucket[];
  metricLabel: string;
  inWindow: (bucketStart: string) => boolean;
  view: "monthly" | "weekly";
}) {
  const counts = buckets.map((b) => b.byCity[city] ?? 0);
  const total = counts.reduce((s, n) => s + n, 0);
  const max = Math.max(1, ...counts);
  const color = colorForCity(city);
  // Label-density rule: weekly view has 16 buckets — show every other
  // label so they don't crowd. Monthly view (12) is fine showing all.
  const labelStride = view === "weekly" ? 2 : 1;

  return (
    <div className="rounded-lg border border-cream-line bg-cream-soft/30 p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold text-deep-green">{city}</span>
        <span className="text-[10px] font-mono tabular-nums text-deep-green/55">
          {total.toLocaleString()} {metricLabel}
        </span>
      </div>
      {/* Bar area. y-axis tick labels were dropped — the per-bar count
          labels above each bar make them redundant and would visually
          collide. The bottom edge of the chart serves as the implicit
          0 baseline. */}
      <div className="flex flex-1 items-end gap-[2px]">
        {buckets.map((b) => {
          const n = b.byCity[city] ?? 0;
          const dim = !inWindow(b.bucketStart);
          const h = (n / max) * MINI_BAR_AREA_PX;
          return (
            <div
              key={b.bucketStart}
              className="flex flex-1 flex-col items-stretch"
              style={{ opacity: dim ? 0.3 : 1 }}
              title={`${city} · ${b.period}: ${n.toLocaleString()} ${metricLabel}${dim ? " (outside selected window)" : ""}`}
            >
              {/* Slot = bar + label, with the label always sitting just
                  above the bar's top edge. Empty bars (n=0, h=0) drop
                  the label down to the chart baseline so all 9 minis
                  visually share the same baseline regardless of value. */}
              <div
                style={{
                  position: "relative",
                  height: `${MINI_TOTAL_PX}px`,
                }}
              >
                {/* The bar itself, anchored to the bottom. */}
                <div
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${h}px`,
                    background: n === 0 ? "transparent" : color,
                    borderRadius: "2px 2px 0 0",
                  }}
                />
                {/* The count label, anchored above the bar's top edge.
                    bottom: ${h} puts the label's bottom flush with the
                    bar's top; height: MINI_LABEL_PX gives it room. */}
                <div
                  style={{
                    position: "absolute",
                    bottom: `${h}px`,
                    left: 0,
                    right: 0,
                    height: `${MINI_LABEL_PX}px`,
                    lineHeight: `${MINI_LABEL_PX}px`,
                    fontSize: "10px",
                    textAlign: "center",
                    color: "rgba(10, 26, 16, 0.55)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {n.toLocaleString()}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* x-axis labels under the bars */}
      <div className="mt-1 flex">
        <div className="flex flex-1 gap-[2px]">
          {buckets.map((b, i) => (
            <div
              key={b.bucketStart}
              className="flex-1 text-center text-[9px] text-deep-green/45"
            >
              {i % labelStride === 0
                ? view === "monthly"
                  ? b.period.slice(0, 3) // "Mar 2026" → "Mar"
                  : b.period
                : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
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
