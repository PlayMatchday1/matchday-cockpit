"use client";

import Link from "next/link";
import { FINANCE_IMPORTERS } from "@/lib/financeImport";
import FinanceImportDropzone from "./FinanceImportDropzone";
import FinanceScheduleImportCard from "./FinanceScheduleImportCard";

export default function FinanceImportView() {
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
        <h1 className="font-display text-4xl uppercase leading-none tracking-tight text-deep-green md:text-5xl">
          Q2 2026 import
        </h1>
        <p className="mt-2 text-sm text-deep-green/65">
          One CSV per Sheet tab. Each importer is independent and idempotent —
          re-uploading replaces or upserts, no duplicates.
        </p>
      </div>

      <div className="space-y-4">
        {FINANCE_IMPORTERS.map((cfg) =>
          cfg.key === "schedule" ? (
            <FinanceScheduleImportCard key={cfg.key} />
          ) : (
            <FinanceImportDropzone key={cfg.key} config={cfg} />
          ),
        )}
      </div>
    </>
  );
}
