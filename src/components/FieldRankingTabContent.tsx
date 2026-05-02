"use client";

import { useState } from "react";
import FieldRankingTable from "@/components/FieldRankingTable";

// Body-only Field Ranking tab content. Drops the back-link + h1
// from the standalone page; keeps the local collapse state.

export default function FieldRankingTabContent() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="mb-12">
      <FieldRankingTable
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
    </div>
  );
}
