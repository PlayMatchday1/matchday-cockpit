"use client";

import MembershipActiveChart from "./MembershipActiveChart";
import MembershipByCityTable from "./MembershipByCityTable";
import MembershipHealthTable from "./MembershipHealthTable";
import MembershipSnapshot from "./MembershipSnapshot";
import MembershipTrendChart from "./MembershipTrendChart";

// Top-down narrative: KPI snapshot → health by city (relocated from
// /admin/finance/cash-flow) → per-city Active/New/Cancelled (already
// sorted Active descending) → all-time line → 6-month bars.
export default function CitiesMembershipLens() {
  return (
    <div className="space-y-6">
      <MembershipSnapshot />
      <MembershipHealthTable />
      <MembershipByCityTable />
      <MembershipActiveChart />
      <MembershipTrendChart />
    </div>
  );
}
