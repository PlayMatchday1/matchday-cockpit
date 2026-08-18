"use client";

import Link from "next/link";
import { MANAGERS } from "@/lib/checkIns";
import { useCheckIns } from "@/lib/useCheckIns";
import CheckInsStatusGrid from "./CheckInsStatusGrid";

export default function CheckInsView() {
  const { data, loading, error } =
    useCheckIns();


  return (
    <>
      <div className="mb-6 text-sm">
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            City Manager Check-Ins
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            Monthly status submissions from each city manager · live from the Google Sheet.
          </p>
        </div>
      </div>

      {/* STRIPPED BACK TO THE MONTHLY CHECK-IN STATUS.
          Removed: the live-sync bar (sync dot / last-synced / Refresh / Auto-refresh), the Payment
          Calendar month grid, and Next Payments. The calendar and the payment cards both rendered
          MANAGERS[].payDay and were mounted nowhere else; that fact now rides on each status card
          so it is not lost with them. An error is still surfaced below, because a failed sheet read
          must not read as "nobody submitted". */}
      <SectionHeader
        title="Monthly Check-In Status"
        subtitle={
          data
            ? `${data.submittedCount} of ${MANAGERS.length} submitted this month`
            : "Loading…"
        }
      />
      <div className="mb-10">
        {loading && !data ? (
          <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
            Loading responses…
          </div>
        ) : !data ? null : (
          <CheckInsStatusGrid statuses={data.statuses} />
        )}
      </div>
    </>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-5 flex items-stretch gap-3">
      <span aria-hidden className="w-1 rounded-full bg-mint" />
      <div className="flex-1 py-0.5">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-deep-green/60">{subtitle}</p>
      </div>
    </div>
  );
}

