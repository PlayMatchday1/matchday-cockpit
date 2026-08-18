import { Suspense } from "react";
import CheckInsView from "@/components/CheckInsView";

// CITY MANAGER CHECK-INS — moved here from Finance, where it was an overlay over whichever
// section you happened to be on. It is about PEOPLE, not money, so it sits with Manager Pay and
// Partner Dashboards in Back Office › People, and it has its own URL rather than a modal state.
//
// THE COMPONENT IS UNCHANGED except for being stripped to the monthly status — this is a move.

export const dynamic = "force-dynamic";

export default function CheckInsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-[#6d7b74]">Loading check-ins…</div>}>
      <CheckInsView />
    </Suspense>
  );
}
