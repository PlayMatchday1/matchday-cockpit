import { Suspense } from "react";
import ManagerPayView from "./ManagerPayView";

export const dynamic = "force-dynamic";

export default function ManagerPayPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-[#6d7b74]">Loading manager pay…</div>}>
      <ManagerPayView />
    </Suspense>
  );
}
