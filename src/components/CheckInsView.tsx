"use client";

import { useMemo, useState } from "react";
import { MANAGERS } from "@/lib/checkIns";
import { useCheckIns } from "@/lib/useCheckIns";
import CheckInsStatusGrid from "./CheckInsStatusGrid";
import CmActionItems from "./CmActionItems";
import { monthLabel, monthOf } from "@/lib/cmActions";

export default function CheckInsView() {
  /* ONE MONTH AND ONE CITY GOVERN THE WHOLE PAGE, and they live HERE — above both sections — for
   * the reason the mock gives: goals, team actions and check-ins run on the same monthly cadence
   * for the same cities, and two pickers would only let them drift out of step. Picking Austin
   * narrows the goals AND the check-ins below to Garrett.
   *
   * The current month is taken in America/Chicago, the timezone the rest of Clubhouse reads
   * operator-facing dates in, via en-CA which yields YYYY-MM-DD. */
  const currentMonth = useMemo(
    () => monthOf(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })), []);
  const [month, setMonth] = useState(currentMonth);
  const [city, setCity] = useState<string | null>(null);

  const { data, loading, error } = useCheckIns(month);

  /* THE CITY FILTER REACHES THE CHECK-INS TOO — that is the point of one control. Matched on
   * cityId, never on the display name: the repo spells the same city three ways and a name match
   * would silently drop four of the seven. */
  const statuses = useMemo(
    () => (data?.statuses ?? []).filter((s) => !city || s.manager.cityId === city),
    [data, city]);
  const managerCount = city ? MANAGERS.filter((m) => m.cityId === city).length : MANAGERS.length;
  const submitted = statuses.filter((s) => s.submitted).length;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            City Manager Check-Ins
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
            What the monthly meeting agreed, and the managers&rsquo; own submissions underneath it ·
            check-ins live from the Google Sheet.
          </p>
        </div>
      </div>

      {/* THE MEETING'S ACTION ITEMS, ABOVE THE CHECK-INS. What was agreed comes before what was
          reported — the check-in is the answer to the goal, so the goal reads first. */}
      <CmActionItems month={month} setMonth={setMonth} city={city} setCity={setCity}
        currentMonth={currentMonth} />

      {/* STRIPPED BACK TO THE MONTHLY CHECK-IN STATUS.
          Removed long ago: the live-sync bar, the Payment Calendar month grid, and Next Payments.
          An error is still surfaced below, because a failed sheet read must not read as "nobody
          submitted". */}
      <SectionHeader
        title="Monthly Check-In Status"
        subtitle={
          loading && !data
            ? "Loading…"
            : `${submitted} of ${managerCount} submitted for ${monthLabel(month)}`
        }
      />
      <div className="mb-10">
        {error && (
          <div className="mb-4 rounded-2xl border-[1.5px] border-coral/40 bg-coral-soft p-4 text-sm text-coral-hover">
            <b>The check-ins could not be loaded — this is not &ldquo;nobody submitted&rdquo;.</b> {error}
          </div>
        )}
        {loading && !data ? (
          <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
            Loading responses…
          </div>
        ) : !data ? null : statuses.length === 0 ? (
          <div data-testid="checkins-empty" className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
            No city manager is assigned to this city, so there is no check-in to show.
          </div>
        ) : (
          <CheckInsStatusGrid statuses={statuses} />
        )}
      </div>
    </>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5 flex items-stretch gap-3">
      <span aria-hidden className="w-1 rounded-full bg-mint" />
      <div className="flex-1 py-0.5">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">{title}</h2>
        <p className="mt-0.5 text-sm text-deep-green/60">{subtitle}</p>
      </div>
    </div>
  );
}
