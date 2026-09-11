"use client";

import type { ManagerStatus } from "@/lib/checkIns";
import CheckInsStatusCard from "./CheckInsStatusCard";

export default function CheckInsStatusGrid({
  statuses,
  onDeleted,
}: {
  statuses: ManagerStatus[];
  onDeleted?: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {statuses.map((s) => (
        <CheckInsStatusCard key={s.manager.name} status={s} onDeleted={onDeleted} />
      ))}
    </div>
  );
}
