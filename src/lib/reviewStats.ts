import { getMonday, weekLabel } from "./cityStats";
import type { ReviewRow } from "./useReviewData";

export const MINIMUM_REVIEWS = 50;
// Min review count for a manager to qualify in past-period rankings
// (Last Month, Last 6 Months, All Time). The current-month flow uses
// the on-pace-to-50 logic instead.
export const MIN_REVIEWS_PAST = 25;
export const STAR_MIN = 1;
export const STAR_MAX = 5;

export type ReviewPeriod =
  | "thisMonth"
  | "lastMonth"
  | "last6Months"
  | "allTime";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_MS = 86_400_000;

export function managerKey(r: {
  managerFirstName: string | null;
  managerLastName: string | null;
}): string {
  const first = (r.managerFirstName ?? "").trim();
  const last = (r.managerLastName ?? "").trim();
  if (!first) return "";
  return last ? `${first}|${last}` : first;
}

export function managerDisplayName(
  first: string | null,
  last: string | null,
): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (!f) return "";
  return l ? `${f} ${l}` : f;
}

export type MonthWindow = {
  start: Date;
  end: Date;
  daysInMonth: number;
  todayDay: number;
  today: Date;
  monthName: string;
  year: number;
  isCurrentMonth: boolean;
  daysElapsed: number;
};

export function getActiveMonthWindow(
  rows: ReviewRow[],
  now: Date = new Date(),
): MonthWindow {
  let chosenYear = now.getFullYear();
  let chosenMonth = now.getMonth();

  const hasCurrentMonthData = rows.some(
    (r) =>
      r.startDate.getFullYear() === chosenYear &&
      r.startDate.getMonth() === chosenMonth,
  );

  if (!hasCurrentMonthData && rows.length > 0) {
    let latestY = -1;
    let latestM = -1;
    for (const r of rows) {
      const y = r.startDate.getFullYear();
      const m = r.startDate.getMonth();
      if (y > latestY || (y === latestY && m > latestM)) {
        latestY = y;
        latestM = m;
      }
    }
    if (latestY >= 0) {
      chosenYear = latestY;
      chosenMonth = latestM;
    }
  }

  const start = new Date(chosenYear, chosenMonth, 1);
  const end = new Date(chosenYear, chosenMonth + 1, 1);
  const daysInMonth = new Date(chosenYear, chosenMonth + 1, 0).getDate();
  const isCurrentMonth =
    chosenYear === now.getFullYear() && chosenMonth === now.getMonth();
  const todayDay = isCurrentMonth ? now.getDate() : daysInMonth;
  const today = new Date(chosenYear, chosenMonth, todayDay);

  return {
    start,
    end,
    daysInMonth,
    todayDay,
    today,
    monthName: MONTH_NAMES[chosenMonth],
    year: chosenYear,
    isCurrentMonth,
    daysElapsed: todayDay,
  };
}

export type ManagerStat = {
  key: string;
  firstName: string;
  lastName: string;
  displayName: string;
  city: string;
  count: number;
  avgRating: number;
  sumRating: number;
  qualified: boolean;
  onPace: boolean;
  projected: number;
  paceThreshold: number;
  isEndOfMonth: boolean;
};

export function getMonthlyManagerStats(
  rows: ReviewRow[],
  city: string | null,
  now: Date = new Date(),
): ManagerStat[] {
  const window = getActiveMonthWindow(rows, now);
  const paceThreshold = Math.ceil(
    (window.daysElapsed / window.daysInMonth) * MINIMUM_REVIEWS,
  );
  const isEnd =
    !window.isCurrentMonth || window.todayDay === window.daysInMonth;

  const groups = new Map<
    string,
    {
      firstName: string;
      lastName: string;
      cityCounts: Map<string, number>;
      sumRating: number;
      count: number;
    }
  >();

  for (const r of rows) {
    if (city !== null && r.city !== city) continue;
    if (r.startDate < window.start || r.startDate >= window.end) continue;
    const key = managerKey(r);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.sumRating += r.starRating;
      existing.count += 1;
      existing.cityCounts.set(
        r.city,
        (existing.cityCounts.get(r.city) ?? 0) + 1,
      );
    } else {
      const cm = new Map<string, number>();
      cm.set(r.city, 1);
      groups.set(key, {
        firstName: (r.managerFirstName ?? "").trim(),
        lastName: (r.managerLastName ?? "").trim(),
        cityCounts: cm,
        sumRating: r.starRating,
        count: 1,
      });
    }
  }

  const out: ManagerStat[] = [];
  for (const [key, g] of groups) {
    let topCity = "";
    let topCount = 0;
    for (const [c, n] of g.cityCounts) {
      if (n > topCount) {
        topCount = n;
        topCity = c;
      }
    }

    const avg = g.sumRating / g.count;
    const projected =
      window.daysElapsed > 0
        ? Math.round((g.count / window.daysElapsed) * window.daysInMonth)
        : g.count;

    out.push({
      key,
      firstName: g.firstName,
      lastName: g.lastName,
      displayName: managerDisplayName(g.firstName, g.lastName),
      city: topCity,
      count: g.count,
      avgRating: avg,
      sumRating: g.sumRating,
      qualified: g.count >= MINIMUM_REVIEWS,
      onPace: g.count >= paceThreshold,
      projected,
      paceThreshold,
      isEndOfMonth: isEnd,
    });
  }

  return out;
}

export function getTop3Eligible(
  rows: ReviewRow[],
  now: Date = new Date(),
): ManagerStat[] {
  const all = getMonthlyManagerStats(rows, null, now);
  const eligible = all.filter((m) => m.qualified || m.onPace);
  eligible.sort((a, b) => {
    if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating;
    return b.count - a.count;
  });
  return eligible.slice(0, 3);
}

export function getBottom3(
  rows: ReviewRow[],
  now: Date = new Date(),
): ManagerStat[] {
  const all = getMonthlyManagerStats(rows, null, now);
  const filtered = all.filter((m) => m.count > 0);
  filtered.sort((a, b) => {
    if (a.avgRating !== b.avgRating) return a.avgRating - b.avgRating;
    return b.count - a.count;
  });
  return filtered.slice(0, 3);
}

// Closed-period (lastMonth / last6Months / allTime) manager stats.
// Strict date window per period; pace-related fields collapse to
// closed-period defaults since "still in progress" doesn't apply.
function getClosedPeriodManagerStats(
  rows: ReviewRow[],
  period: Exclude<ReviewPeriod, "thisMonth">,
  now: Date = new Date(),
): ManagerStat[] {
  let start: Date | null = null;
  let end: Date | null = null;
  if (period === "lastMonth") {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === "last6Months") {
    // Rolling 6 months ending at now (not 6 calendar months). E.g.
    // on May 5, 2026 the window is Nov 5 2025 → May 5 2026.
    start = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    end = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );
  }
  // "allTime": both null → no date filter.

  const groups = new Map<
    string,
    {
      firstName: string;
      lastName: string;
      cityCounts: Map<string, number>;
      sumRating: number;
      count: number;
    }
  >();

  for (const r of rows) {
    if (start && r.startDate < start) continue;
    if (end && r.startDate >= end) continue;
    const key = managerKey(r);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.sumRating += r.starRating;
      existing.count += 1;
      existing.cityCounts.set(
        r.city,
        (existing.cityCounts.get(r.city) ?? 0) + 1,
      );
    } else {
      const cm = new Map<string, number>();
      cm.set(r.city, 1);
      groups.set(key, {
        firstName: (r.managerFirstName ?? "").trim(),
        lastName: (r.managerLastName ?? "").trim(),
        cityCounts: cm,
        sumRating: r.starRating,
        count: 1,
      });
    }
  }

  const out: ManagerStat[] = [];
  for (const [key, g] of groups) {
    let topCity = "";
    let topCount = 0;
    for (const [c, n] of g.cityCounts) {
      if (n > topCount) {
        topCount = n;
        topCity = c;
      }
    }
    const avg = g.count > 0 ? g.sumRating / g.count : 0;
    out.push({
      key,
      firstName: g.firstName,
      lastName: g.lastName,
      displayName: managerDisplayName(g.firstName, g.lastName),
      city: topCity,
      count: g.count,
      avgRating: avg,
      sumRating: g.sumRating,
      // Pace fields don't apply to closed periods.
      qualified: g.count >= MIN_REVIEWS_PAST,
      onPace: false,
      projected: g.count,
      paceThreshold: 0,
      isEndOfMonth: true,
    });
  }
  return out;
}

export type RankedManagers = {
  top: ManagerStat[];
  bottom: ManagerStat[];
  // Total managers eligible under the period's qualifying rule.
  // For thisMonth top: qualified or on-pace.
  // For thisMonth bottom: any with count > 0.
  // For closed periods: count >= MIN_REVIEWS_PAST (applies to both
  // top and bottom — the "Only N MMs qualify" note in the UI uses
  // this number to tell the operator the filter is biting).
  topQualifyingCount: number;
  bottomQualifyingCount: number;
};

export function getRankedManagersForPeriod(
  rows: ReviewRow[],
  period: ReviewPeriod,
  now: Date = new Date(),
): RankedManagers {
  if (period === "thisMonth") {
    const all = getMonthlyManagerStats(rows, null, now);
    const topEligible = all
      .filter((m) => m.qualified || m.onPace)
      .sort((a, b) => {
        if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating;
        return b.count - a.count;
      });
    const bottomEligible = all
      .filter((m) => m.count > 0)
      .sort((a, b) => {
        if (a.avgRating !== b.avgRating) return a.avgRating - b.avgRating;
        return b.count - a.count;
      });
    return {
      top: topEligible.slice(0, 3),
      bottom: bottomEligible.slice(0, 3),
      topQualifyingCount: topEligible.length,
      bottomQualifyingCount: bottomEligible.length,
    };
  }

  const all = getClosedPeriodManagerStats(rows, period, now);
  const eligible = all.filter((m) => m.count >= MIN_REVIEWS_PAST);
  const topSorted = [...eligible].sort((a, b) => {
    if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating;
    return b.count - a.count;
  });
  const bottomSorted = [...eligible].sort((a, b) => {
    if (a.avgRating !== b.avgRating) return a.avgRating - b.avgRating;
    return b.count - a.count;
  });
  return {
    top: topSorted.slice(0, 3),
    bottom: bottomSorted.slice(0, 3),
    topQualifyingCount: eligible.length,
    bottomQualifyingCount: eligible.length,
  };
}

export type WeekStat = {
  weekStart: Date;
  weekLabel: string;
  count: number;
  avgRating: number;
};

export function getRecentReviewStats(
  rows: ReviewRow[],
  city: string | null,
  weeksBack: number = 8,
  now: Date = new Date(),
): { count: number; avgRating: number; weeks: WeekStat[] } {
  const currentMonday = getMonday(now);

  const weeks: WeekStat[] = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const ws = new Date(
      currentMonday.getFullYear(),
      currentMonday.getMonth(),
      currentMonday.getDate() - 7 * i,
    );
    weeks.push({
      weekStart: ws,
      weekLabel: weekLabel(ws),
      count: 0,
      avgRating: 0,
    });
  }

  const sums = new Array(weeksBack).fill(0);
  const counts = new Array(weeksBack).fill(0);

  let totalCount = 0;
  let totalSum = 0;

  const earliestStart = weeks[0].weekStart;
  const lastWeek = weeks[weeksBack - 1].weekStart;
  const latestEnd = new Date(
    lastWeek.getFullYear(),
    lastWeek.getMonth(),
    lastWeek.getDate() + 7,
  );

  for (const r of rows) {
    if (city !== null && r.city !== city) continue;
    if (r.startDate < earliestStart || r.startDate >= latestEnd) continue;
    const diffDays = Math.floor(
      (r.startDate.getTime() - earliestStart.getTime()) / DAY_MS,
    );
    if (diffDays < 0) continue;
    const weekIdx = Math.floor(diffDays / 7);
    if (weekIdx >= weeksBack) continue;
    sums[weekIdx] += r.starRating;
    counts[weekIdx] += 1;
    totalCount += 1;
    totalSum += r.starRating;
  }

  for (let i = 0; i < weeksBack; i++) {
    weeks[i].count = counts[i];
    weeks[i].avgRating = counts[i] > 0 ? sums[i] / counts[i] : 0;
  }

  return {
    count: totalCount,
    avgRating: totalCount > 0 ? totalSum / totalCount : 0,
    weeks,
  };
}
