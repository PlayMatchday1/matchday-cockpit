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
  byCity: Record<string, number>;
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
  window: { fromIso: string | null; toIso: string | null };
  hero: Hero;
  funnel: Funnel;
  byCity: ByCityRow[];
  growthMonthly: GrowthBucket[];
  growthWeekly: GrowthBucket[];
  funnelSpeed: FunnelSpeedRow[];
  matrix: Matrix;
};

// ---------------------------------------------------------------
// Window selector — pill names live in URL as ?window=<name>.
// Custom uses ?window=custom&from=YYYY-MM-DD&to=YYYY-MM-DD.
// ---------------------------------------------------------------

type WindowName = "all" | "2026_ytd" | "last_90" | "last_12m" | "custom";

const WINDOW_PILLS: { value: WindowName; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "2026_ytd", label: "2026 YTD" },
  { value: "last_90", label: "Last 90 days" },
  { value: "last_12m", label: "Last 12 months" },
  { value: "custom", label: "Custom" },
];

function isoDay(d: Date): string {
  // YYYY-MM-DD in local time. Used for URL params + native date inputs.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetDates(name: WindowName, now: Date): { from: string | null; to: string | null } {
  if (name === "all") return { from: null, to: null };
  if (name === "2026_ytd") {
    return { from: "2026-01-01", to: isoDay(now) };
  }
  if (name === "last_90") {
    const from = new Date(now);
    from.setDate(from.getDate() - 90);
    return { from: isoDay(from), to: isoDay(now) };
  }
  if (name === "last_12m") {
    const from = new Date(now);
    from.setFullYear(from.getFullYear() - 1);
    return { from: isoDay(from), to: isoDay(now) };
  }
  // custom — caller must supply from/to.
  return { from: null, to: null };
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
  // Default = "all" when no params. Custom requires both from + to.
  const urlWindow =
    (searchParams?.get("window") as WindowName | null) ?? "all";
  const urlFrom = searchParams?.get("from") ?? null;
  const urlTo = searchParams?.get("to") ?? null;

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
      if (next === "all") {
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

// Bar-area height in CSS pixels. Per spec, "Bar max height should be
// ~140-160px so the chart isn't disproportionately tall." Sum of all
// bucket segments scales to fill this area for the largest bucket;
// other buckets scale proportionally.
const BAR_AREA_PX = 150;

function GrowthChart({
  monthly,
  weekly,
  windowFromIso,
  windowToIso,
}: {
  monthly: GrowthBucket[];
  weekly: GrowthBucket[];
  windowFromIso: string | null;
  windowToIso: string | null;
}) {
  const [view, setView] = useState<"monthly" | "weekly">("monthly");
  const buckets = view === "monthly" ? monthly : weekly;
  const max = Math.max(1, ...buckets.map((b) => b.signups));
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
          // so a month with no SATX signups doesn't pollute the line.
          const cityLines = CITY_STACK_ORDER.filter(
            (c) => (b.byCity[c] ?? 0) > 0,
          )
            .map((c) => `${c} ${(b.byCity[c] ?? 0).toLocaleString()}`)
            .join(", ");
          const tooltip =
            `${b.period}\n` +
            `${b.signups.toLocaleString()} signups · ${b.completedPct}% completed · ${b.played1Pct}% played 1+\n` +
            (cityLines ? `By city: ${cityLines}` : "By city: (none)") +
            (dim ? "\noutside selected window" : "");
          // Total height for this bucket's stack (px). All buckets
          // share the same scale so visual heights are comparable
          // across periods.
          const totalPx = (b.signups / max) * BAR_AREA_PX;
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
                {b.signups.toLocaleString()}
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
