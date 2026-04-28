"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import {
  isActiveMember,
  isCancelledInMonth,
  isChurning,
  isNewInMonth,
  monthLabel,
} from "@/lib/membershipStats";

export default function MembershipSnapshot() {
  const { data, loading } = useFinanceData();
  const now = new Date();

  if (loading && !data) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10 sm:p-7">
        Loading membership data…
      </div>
    );
  }
  if (!data || data.members.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          {monthLabel(now)} · current snapshot
        </div>
        <div className="mt-3 text-sm text-deep-green/55">
          No member data yet.
        </div>
      </div>
    );
  }

  const members = data.members;
  const active = members.filter(isActiveMember).length;
  const newThisMonth = members.filter((m) => isNewInMonth(m, now)).length;
  const cancellations = members.filter((m) => isCancelledInMonth(m, now))
    .length;
  const churning = members.filter((m) => isChurning(m, now)).length;

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        {monthLabel(now)} · current snapshot
      </div>
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
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
          value="0"
          hint="0 members tracked"
          muted
        />
      </div>
    </section>
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
  const toneCls =
    muted
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
