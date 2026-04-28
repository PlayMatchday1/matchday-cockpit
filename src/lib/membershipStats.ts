import type { FinMember } from "./useFinanceData";

const INTERNAL_EMAIL_RX = /@matchday\.|@playmatchday\./i;

// Structural subset that all membership predicates need. FinMember
// (read path) and MemberRow (import path before insert, no id yet)
// both satisfy this — lets us compute snapshots from either side.
export type MemberLike = Pick<
  FinMember,
  "status" | "price_cents" | "email" | "activation_date" | "canceled_at" | "city"
>;

export function isPaidExternalMember(m: MemberLike): boolean {
  if (m.price_cents <= 0) return false;
  if (m.email && INTERNAL_EMAIL_RX.test(m.email)) return false;
  // Stripe INCOMPLETE / INCOMPLETE_EXPIRED never completed checkout —
  // they were never charged. ACTIVE / PAST_DUE / CANCELED / UNPAID all
  // mean "paid at some point" and stay in scope.
  if (m.status?.toUpperCase().startsWith("INCOMPLETE")) return false;
  return true;
}

// activation_date is YYYY-MM-DD plain date — parse as local midnight so
// the 1st of the month doesn't UTC-shift into the prior month. canceled_at
// is a full ISO timestamp; default Date parser handles it (TZ embedded).
export function parseMemberDate(s: string | null): Date | null {
  if (!s) return null;
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function inMonth(d: Date | null, ref: Date): boolean {
  if (!d) return false;
  return (
    d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth()
  );
}

export function monthLabel(ref: Date): string {
  return ref.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function monthShort(ref: Date): string {
  return ref.toLocaleDateString("en-US", { month: "short" });
}

export function lastNMonths(n: number, now: Date): Date[] {
  const out: Date[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  }
  return out;
}

// 25-day cancel-policy window: cancellations on the 6th of one month
// through the 5th of the next month roll off at end of that next
// month. So "currently churning" = members who cancelled in the
// rolling window aligned to the cycle that ends on the 5th of THIS
// month: [6th of prior month, 5th of this month] inclusive, still
// flagged ACTIVE. Cancellations from the 6th of THIS month onward
// belong to the next cycle and aren't churning yet.
export function isChurning(m: MemberLike, now: Date): boolean {
  if (!isPaidExternalMember(m)) return false;
  if (m.status !== "ACTIVE") return false;
  const canceled = parseMemberDate(m.canceled_at);
  if (!canceled) return false;
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 1, 6);
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), 6); // exclusive — covers all of the 5th
  return canceled >= windowStart && canceled < windowEnd;
}

export function isActiveMember(m: MemberLike): boolean {
  return m.status === "ACTIVE" && isPaidExternalMember(m);
}

export function isNewInMonth(m: MemberLike, ref: Date): boolean {
  if (!isPaidExternalMember(m)) return false;
  return inMonth(parseMemberDate(m.activation_date), ref);
}

// Cancellations book-keeping: every canceled_at falling in the
// reference month, regardless of past/future or status. Overlaps
// intentionally with isChurning on the 1st-5th of the current month.
export function isCancelledInMonth(m: MemberLike, ref: Date): boolean {
  if (!isPaidExternalMember(m)) return false;
  return inMonth(parseMemberDate(m.canceled_at), ref);
}

export type CityMembershipRow = {
  city: string;
  active: number;
  newThisMonth: number;
  cancelled: number;
  net: number;
};

export function buildCityMembershipRows(
  members: MemberLike[],
  cities: readonly string[],
  now: Date,
): CityMembershipRow[] {
  return cities
    .map((city) => {
      const cityMembers = members.filter((m) => m.city === city);
      const active = cityMembers.filter(isActiveMember).length;
      const newThisMonth = cityMembers.filter((m) => isNewInMonth(m, now))
        .length;
      const cancelled = cityMembers.filter((m) => isCancelledInMonth(m, now))
        .length;
      return {
        city,
        active,
        newThisMonth,
        cancelled,
        net: newThisMonth - cancelled,
      };
    })
    .sort((a, b) => b.active - a.active);
}

export type MonthBucket = {
  month: Date;
  label: string;
  newCount: number;
  cancelledCount: number;
  isCurrent: boolean;
};

export function buildMonthlyBuckets(
  members: MemberLike[],
  monthsBack: number,
  now: Date,
): MonthBucket[] {
  const months = lastNMonths(monthsBack, now);
  return months.map((m, i) => ({
    month: m,
    label: monthShort(m),
    newCount: members.filter((mb) => isNewInMonth(mb, m)).length,
    cancelledCount: members.filter((mb) => isCancelledInMonth(mb, m)).length,
    isCurrent: i === months.length - 1,
  }));
}

// Subset of a match_registrations row needed to compute member
// attendance. Both the in-app MatchRow (post-parsing) and the raw
// DB row shape can satisfy this — pass match_start as either a Date
// or a parseable string.
export type AttendanceRow = {
  match_start: string | Date;
  payment_type: string | null;
  email: string | null;
};

export type AvgMatchesResult = {
  avg: number;
  membersTracked: number;
};

// Average member attendance for the reference month.
// - Filter attendance to type_of_payment === MEMBER and match_start in ref month.
// - Lowercase-match attendance email to fin_members email (members
//   already filtered through isPaidExternalMember, which excludes
//   INCOMPLETE / internal / price=0 rows).
// - Group by member email, count matches per member.
// - avg = total_matches / members_with_at_least_one_match
//   (denominator is "members tracked" — not the entire active base).
// - Returns { avg: 0, membersTracked: 0 } when nothing matches.
export function computeAvgMatchesPerMember(
  members: MemberLike[],
  attendance: AttendanceRow[],
  ref: Date,
): AvgMatchesResult {
  const eligibleEmails = new Set<string>();
  for (const m of members) {
    if (!isPaidExternalMember(m)) continue;
    if (!m.email) continue;
    eligibleEmails.add(m.email.toLowerCase());
  }
  if (eligibleEmails.size === 0) return { avg: 0, membersTracked: 0 };

  const matchesByMember = new Map<string, number>();
  for (const a of attendance) {
    if (!a.email) continue;
    if ((a.payment_type ?? "").toUpperCase() !== "MEMBER") continue;
    const matchDate =
      a.match_start instanceof Date ? a.match_start : parseAttendanceDate(a.match_start);
    if (!matchDate) continue;
    if (!inMonth(matchDate, ref)) continue;
    const key = a.email.toLowerCase();
    if (!eligibleEmails.has(key)) continue;
    matchesByMember.set(key, (matchesByMember.get(key) ?? 0) + 1);
  }

  const membersTracked = matchesByMember.size;
  if (membersTracked === 0) return { avg: 0, membersTracked: 0 };
  const total = [...matchesByMember.values()].reduce((s, n) => s + n, 0);
  return { avg: total / membersTracked, membersTracked };
}

// Wall-clock parse for "YYYY-MM-DD HH:MM:SS"-style strings — same
// idea as useMatchData's parseLocal, kept inline so this module
// doesn't depend on UI code.
function parseAttendanceDate(s: string): Date | null {
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 3) return null;
  const [yr, mo, dy, hr = "0", mn = "0"] = parts;
  const [y, m, d, h, n] = [yr, mo, dy, hr, mn].map(Number);
  if ([y, m, d, h, n].some((x) => Number.isNaN(x))) return null;
  return new Date(y, m - 1, d, h, n);
}

export type MembershipSnapshotPayload = {
  month: string; // YYYY-MM-01
  active_count: number;
  new_count: number;
  cancelled_count: number;
  churning_count: number;
  avg_matches_per_member: number | null;
  members_tracked: number | null;
  by_city: Record<string, { active: number; new: number; cancelled: number }>;
  source_file_name?: string;
};

export function computeMonthlySnapshot(
  members: MemberLike[],
  attendance: AttendanceRow[],
  cities: readonly string[],
  now: Date,
  sourceFileName?: string,
): MembershipSnapshotPayload {
  const monthIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const byCity: MembershipSnapshotPayload["by_city"] = {};
  for (const city of cities) {
    const cm = members.filter((m) => m.city === city);
    byCity[city] = {
      active: cm.filter(isActiveMember).length,
      new: cm.filter((m) => isNewInMonth(m, now)).length,
      cancelled: cm.filter((m) => isCancelledInMonth(m, now)).length,
    };
  }

  const { avg, membersTracked } = computeAvgMatchesPerMember(
    members,
    attendance,
    now,
  );

  return {
    month: monthIso,
    active_count: members.filter(isActiveMember).length,
    new_count: members.filter((m) => isNewInMonth(m, now)).length,
    cancelled_count: members.filter((m) => isCancelledInMonth(m, now)).length,
    churning_count: members.filter((m) => isChurning(m, now)).length,
    avg_matches_per_member: membersTracked > 0 ? avg : null,
    members_tracked: membersTracked > 0 ? membersTracked : null,
    by_city: byCity,
    source_file_name: sourceFileName,
  };
}
