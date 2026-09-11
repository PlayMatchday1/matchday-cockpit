"use client";

import { useCallback, useMemo, useState } from "react";
import { Link2, Check, X } from "lucide-react";
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

  const { data, loading, error, refresh } = useCheckIns(month);

  /* COPY FORM LINK — the same control as InventoryDashboard's, same mint button, same icon swap,
   * same 1600ms revert, pointing at /check-in.
   *
   * ONE DIFFERENCE, AND IT IS A BUG FIX RATHER THAN A REDESIGN. The Inventory version is
   * `void navigator.clipboard?.writeText(url)` followed by an unconditional setCopied(true), so it
   * says "Copied!" in two cases where nothing was copied: an insecure origin, where
   * navigator.clipboard is undefined and the `?.` silently short-circuits, and a rejected write.
   * The operator then pastes whatever was on the clipboard before into a message to a city
   * manager. This awaits the write and reports what actually happened. INVENTORY IS LEFT ALONE in
   * this build, as briefed — see the report. */
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const copyLink = useCallback(async () => {
    const url = `${window.location.origin}/check-in`;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard on this origin");
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    window.setTimeout(() => setCopied("idle"), 1600);
  }, []);

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
            What the monthly meeting agreed, and the managers&rsquo; own submissions underneath it.
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
        /* AGAINST THE CHECK-IN SECTION, NOT THE PAGE HEADER. This link IS the check-in form; the
           page above it also carries the meeting's action items, and a link sitting there would
           read as belonging to both. Nothing accompanies it — the button's own label is the whole
           of the copy. */
        action={
          <button
            type="button"
            data-testid="ci-copy-link"
            onClick={() => void copyLink()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-mint px-4 py-2 text-[13px] font-extrabold text-deep-green transition hover:bg-mint-hover"
          >
            {copied === "ok" ? <Check aria-hidden size={14} />
              : copied === "fail" ? <X aria-hidden size={14} />
              : <Link2 aria-hidden size={14} />}
            {copied === "ok" ? "Copied!" : copied === "fail" ? "Couldn't copy" : "Copy form link"}
          </button>
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
          <CheckInsStatusGrid statuses={statuses} onDeleted={() => void refresh()} />
        )}
      </div>
    </>
  );
}

function SectionHeader({ title, subtitle, action }: {
  title: string; subtitle: string; action?: React.ReactNode;
}) {
  return (
    /* flex-wrap + a min-w-0 text column so a phone drops the action onto its own line instead of
       squeezing the subtitle or pushing the button off the right edge. */
    <div className="mb-5 flex flex-wrap items-stretch gap-3">
      <span aria-hidden className="w-1 rounded-full bg-mint" />
      <div className="min-w-0 flex-1 py-0.5">
        <h2 className="text-2xl font-bold tracking-tight text-deep-green">{title}</h2>
        <p className="mt-0.5 text-sm text-deep-green/60">{subtitle}</p>
      </div>
      {action && <div className="flex items-center">{action}</div>}
    </div>
  );
}
