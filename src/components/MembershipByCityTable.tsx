"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import { buildCityMembershipRows } from "@/lib/membershipStats";
import { CITIES } from "@/lib/types";
import { type MembershipMonthView } from "@/lib/useMembershipSnapshots";

export default function MembershipByCityTable({
  view,
}: {
  view: MembershipMonthView;
}) {
  // Current month is live; a prior month reads its frozen by_city map.
  if (!view.isCurrentMonth) return <SnapshotByCity view={view} />;
  return <LiveByCity label={view.monthLabel} />;
}

function LiveByCity({ label }: { label: string }) {
  const { data, loading } = useFinanceData();
  const now = new Date();

  if (loading && !data) {
    return <Frame label={label}>Loading membership data…</Frame>;
  }
  if (!data || data.members.length === 0) {
    return <Frame label={label}>No member data yet.</Frame>;
  }

  return (
    <ByCitySection
      label={label}
      rows={buildCityMembershipRows(data.members, CITIES, now)}
    />
  );
}

function SnapshotByCity({ view }: { view: MembershipMonthView }) {
  const { snapshotRow, snapshotLoading, monthLabel } = view;

  if (snapshotLoading) {
    return <Frame label={monthLabel}>Loading membership data…</Frame>;
  }
  if (!snapshotRow) {
    return (
      <Frame label={monthLabel}>
        No data for {monthLabel}. Pick another month above.
      </Frame>
    );
  }

  const rows: ByCityDisplayRow[] = CITIES.map((city) => {
    const c = snapshotRow.by_city?.[city];
    return {
      city,
      active: c?.active ?? 0,
      // undefined on snapshots captured before Past Due shipped → "—".
      pastDue: c?.pastDue ?? null,
      newThisMonth: c?.new ?? 0,
      cancelled: c?.cancelled ?? 0,
      net: (c?.new ?? 0) - (c?.cancelled ?? 0),
    };
  }).sort((a, b) => b.active - a.active);

  return <ByCitySection label={monthLabel} rows={rows} />;
}

// pastDue is number | null: null = this month's snapshot predates the
// Past Due bucket, rendered "—". The live path (CityMembershipRow,
// pastDue: number) is assignable.
type ByCityDisplayRow = {
  city: string;
  active: number;
  pastDue: number | null;
  newThisMonth: number;
  cancelled: number;
  net: number;
};

function ByCitySection({
  label,
  rows,
}: {
  label: string;
  rows: ByCityDisplayRow[];
}) {
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        By city · {label}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-line text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              <th className="px-2 py-2 text-left">City</th>
              <th className="px-2 py-2 text-right">Active</th>
              <th className="px-2 py-2 text-right">Past Due</th>
              <th className="px-2 py-2 text-right">New</th>
              <th className="px-2 py-2 text-right">Cancelled</th>
              <th className="px-2 py-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.city}
                className="border-b border-cream-line/50 transition hover:bg-cream-soft/40"
              >
                <td className="px-2 py-2 font-medium text-deep-green">
                  {r.city}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-deep-green">
                  {r.active.toLocaleString()}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-[#9a6a00]">
                  {r.pastDue == null ? "—" : r.pastDue.toLocaleString()}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-deep-green/80">
                  {r.newThisMonth}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-deep-green/80">
                  {r.cancelled}
                </td>
                <td
                  className={`px-2 py-2 text-right font-bold tabular-nums ${netClass(r.net)}`}
                >
                  {fmtSigned(r.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Frame({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        By city · {label}
      </div>
      <div className="mt-3 text-sm text-deep-green/55">{children}</div>
    </div>
  );
}

function fmtSigned(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : String(n);
}

function netClass(n: number): string {
  if (n > 0) return "text-mint-hover";
  if (n < 0) return "text-coral";
  return "text-deep-green/55";
}
