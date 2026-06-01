"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import {
  computeAvgMatchesPerMember,
  isActiveMember,
  isCancelledInMonth,
  isChurning,
  isNewInMonth,
  type AttendanceRow,
} from "@/lib/membershipStats";
import {
  CHURNING_TRACKED_SINCE_ISO,
  type MembershipMonthView,
} from "@/lib/useMembershipSnapshots";

// Em-dash, not "0" — for a field that wasn't captured, "—" says "not
// available" where 0 would falsely read as "measured zero".
const NA = "—";

export default function MembershipSnapshot({
  view,
}: {
  view: MembershipMonthView;
}) {
  // Current month is the live view; a prior month reads its frozen row.
  if (!view.isCurrentMonth) return <SnapshotMonthKPIs view={view} />;
  return <LiveMonthKPIs label={view.monthLabel} />;
}

function LiveMonthKPIs({ label }: { label: string }) {
  const { data, loading } = useFinanceData();
  const { rows: matchRows } = useMatchData();
  const now = new Date();

  if (loading && !data) {
    return (
      <Frame label={label} eyebrow="current snapshot">
        <div className="text-sm text-deep-green/55">
          Loading membership data…
        </div>
      </Frame>
    );
  }
  if (!data || data.members.length === 0) {
    return (
      <Frame label={label} eyebrow="current snapshot">
        <div className="text-sm text-deep-green/55">No member data yet.</div>
      </Frame>
    );
  }

  const members = data.members;
  const active = members.filter(isActiveMember).length;
  const newThisMonth = members.filter((m) => isNewInMonth(m, now)).length;
  const cancellations = members.filter((m) => isCancelledInMonth(m, now))
    .length;
  const churning = members.filter((m) => isChurning(m, now)).length;

  const attendance: AttendanceRow[] = matchRows.map((r) => ({
    match_start: r.matchStart,
    payment_type: r.paymentType,
    email: r.email,
  }));
  const { avg, membersTracked } = computeAvgMatchesPerMember(
    members,
    attendance,
    now,
  );

  return (
    <Frame label={label} eyebrow="current snapshot">
      <KPIGrid>
        <KPI label="Active Members" value={active.toLocaleString()} />
        <KPI
          label="New This Month"
          value={newThisMonth.toLocaleString()}
          tone="up"
          hint="this mo"
        />
        <KPI
          label="Cancellations"
          value={cancellations.toLocaleString()}
          tone="down"
          hint="this mo"
        />
        <KPI
          label="Churning"
          value={churning.toLocaleString()}
          tone="down"
          hint="still active"
        />
        <KPI
          label="Avg Matches/Member"
          value={membersTracked > 0 ? avg.toFixed(1) : NA}
          hint={
            membersTracked > 0
              ? `${membersTracked.toLocaleString()} members tracked`
              : "not tracked"
          }
          muted={membersTracked === 0}
        />
      </KPIGrid>
    </Frame>
  );
}

function SnapshotMonthKPIs({ view }: { view: MembershipMonthView }) {
  const { snapshotRow, snapshotLoading, monthLabel, monthIso } = view;

  if (snapshotLoading) {
    return (
      <Frame label={monthLabel} eyebrow="captured snapshot">
        <div className="text-sm text-deep-green/55">
          Loading membership data…
        </div>
      </Frame>
    );
  }
  if (!snapshotRow) {
    return (
      <Frame label={monthLabel} eyebrow="captured snapshot">
        <div className="text-sm text-deep-green/55">
          No data for {monthLabel}. Pick another month above.
        </div>
      </Frame>
    );
  }

  // Backfilled months stored churning as 0 — show "—" there. avg /
  // members_tracked are genuinely NULL pre-instrumentation.
  const churnTracked = monthIso >= CHURNING_TRACKED_SINCE_ISO;
  const avg = snapshotRow.avg_matches_per_member;
  const tracked = snapshotRow.members_tracked;

  return (
    <Frame label={monthLabel} eyebrow="captured snapshot">
      <KPIGrid>
        <KPI
          label="Active Members"
          value={snapshotRow.active_count.toLocaleString()}
        />
        <KPI
          label="New This Month"
          value={snapshotRow.new_count.toLocaleString()}
          tone="up"
          hint="this mo"
        />
        <KPI
          label="Cancellations"
          value={snapshotRow.cancelled_count.toLocaleString()}
          tone="down"
          hint="this mo"
        />
        <KPI
          label="Churning"
          value={churnTracked ? snapshotRow.churning_count.toLocaleString() : NA}
          tone="down"
          hint={churnTracked ? "still active" : "not tracked"}
          muted={!churnTracked}
        />
        <KPI
          label="Avg Matches/Member"
          value={avg != null ? avg.toFixed(1) : NA}
          hint={
            tracked != null
              ? `${tracked.toLocaleString()} members tracked`
              : "not tracked"
          }
          muted={avg == null}
        />
      </KPIGrid>
    </Frame>
  );
}

function Frame({
  label,
  eyebrow,
  children,
}: {
  label: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        {label} · {eyebrow}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function KPIGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
      {children}
    </div>
  );
}

function KPI({
  label,
  value,
  tone,
  hint,
  muted,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  hint?: string;
  muted?: boolean;
}) {
  const toneCls = muted
    ? "text-deep-green/45"
    : tone === "up"
      ? "text-mint-hover"
      : tone === "down"
        ? "text-coral"
        : "text-deep-green";
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      <div
        className={`mt-1 text-3xl font-extrabold tabular-nums leading-none ${toneCls}`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[11px] text-deep-green/55">{hint}</div>
      )}
    </div>
  );
}
