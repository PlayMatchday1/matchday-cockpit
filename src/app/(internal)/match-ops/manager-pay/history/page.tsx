// Manager year report — admin-only (the view checks is_admin and the
// /api/manager-pay/manager-year route is authenticateAdmin-gated). Reached from
// the "Manager history" link in the Manager Pay header.

import type { Metadata } from "next";
import ManagerYearView from "./ManagerYearView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Manager history" };

export default function ManagerHistoryPage() {
  return <ManagerYearView />;
}
