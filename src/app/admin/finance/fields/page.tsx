"use client";

import { useState } from "react";
import Link from "next/link";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import FieldRankingTable from "@/components/FieldRankingTable";

export default function FinanceFieldsPage() {
  return (
    <PagePermissionGuard page="finance">
      <FinanceFieldsContent />
    </PagePermissionGuard>
  );
}

function FinanceFieldsContent() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      <div className="mb-6 text-sm">
        <Link
          href="/admin/finance"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← Back to Finance
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          Field Ranking
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
          Per-venue financial breakdown ranked by net contribution.
        </p>
      </div>

      <div className="mb-12">
        <FieldRankingTable
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
        />
      </div>
    </>
  );
}
