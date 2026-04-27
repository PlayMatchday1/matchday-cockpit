"use client";

import { useState } from "react";
import Link from "next/link";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import FinanceUploadCard from "@/components/FinanceUploadCard";
import {
  commitMembers,
  commitStripe,
  previewMembers,
  previewStripe,
  type MembersPreview,
  type StripePreview,
  type StripeVenueResolution,
} from "@/lib/financeImport";

export default function FinanceUploadPage() {
  return (
    <PagePermissionGuard page="finance">
      <FinanceUploadContent />
    </PagePermissionGuard>
  );
}

function FinanceUploadContent() {
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
          Weekly Update
        </h1>
        <p className="mt-2 text-sm text-deep-green/65">
          Drop the latest Members + Stripe exports. Members goes first so
          Stripe membership payments can be allocated to the right cities.
        </p>
      </div>

      <div className="mb-6 flex items-start gap-3 rounded-xl border border-mint/40 bg-mint-soft/40 px-4 py-3 text-sm text-deep-green">
        <span aria-hidden className="text-base">
          💡
        </span>
        <span>
          Upload <strong>Members first</strong> so Stripe membership payments
          can be allocated to the right cities via email lookup.
        </span>
      </div>

      <div className="space-y-6">
        <FinanceUploadCard<MembersPreview>
          index={1}
          title="Members"
          subtitle="Replaces all rows in fin_members. City is derived from Member ID prefix."
          expectedColumns="Member ID, Member Email, Status, First Name, Last Name, Phone Number, Member Activation Date, Membership Length, Price, Canceled At, Cancel Reason"
          preview={previewMembers}
          commit={(p) => commitMembers(p.parsed)}
          renderPreview={renderMembersPreview}
          confirmLabel="Confirm Replace"
        />

        <FinanceUploadCard<StripePreview>
          index={2}
          title="Stripe Activity"
          subtitle="Replaces Stripe-source rows in fin_revenue between the earliest and latest dates in this upload. Membership payments are allocated to the member's city via email lookup; match payments use the cityIdentifier code."
          expectedColumns="Created date (UTC), Amount, Fee, Status, Description, Customer Email, cityIdentifier (metadata), type (metadata) — falls back to Description if type is blank"
          preview={previewStripe}
          commit={commitStripe}
          renderPreview={renderStripePreview}
          confirmLabel="Confirm Replace"
        />
      </div>
    </>
  );
}

function renderMembersPreview(p: MembersPreview): React.ReactNode {
  const statusOrder = [
    "ACTIVE",
    "CANCELED",
    "INCOMPLETE_EXPIRED",
    "INCOMPLETE",
  ];
  const statusEntries = [
    ...statusOrder
      .filter((s) => p.byStatus[s] !== undefined)
      .map((s) => [s, p.byStatus[s]] as const),
    ...Object.entries(p.byStatus).filter(([s]) => !statusOrder.includes(s)),
  ];
  const cityEntries = Object.entries(p.activeByCity).sort(
    (a, b) => b[1] - a[1],
  );
  return (
    <div className="space-y-3 text-sm">
      <div>
        <span className="text-deep-green/60">Total members: </span>
        <span className="font-mono font-bold tabular-nums">
          {p.totalMembers.toLocaleString()}
        </span>
      </div>
      <ul className="space-y-0.5 pl-4 text-xs text-deep-green/80">
        {statusEntries.map(([s, n]) => (
          <li key={s} className="flex items-baseline gap-2">
            <span className="text-deep-green/55">•</span>
            <span>{s}:</span>
            <span className="font-mono tabular-nums">
              {n.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
      <div>
        <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
          Active members by city
        </div>
        <ul className="mt-1 space-y-0.5 pl-4 text-xs text-deep-green/80">
          {cityEntries.length === 0 ? (
            <li className="italic text-deep-green/45">No active members.</li>
          ) : (
            cityEntries.map(([city, count]) => (
              <li key={city} className="flex items-baseline gap-2">
                <span className="text-deep-green/55">•</span>
                <span>{city}:</span>
                <span className="font-mono tabular-nums">
                  {count.toLocaleString()}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
      <div className="rounded-md border border-coral/30 bg-coral-soft/30 px-3 py-2 text-xs text-coral">
        This will replace ALL existing fin_members rows.
      </div>
    </div>
  );
}

function renderStripePreview(p: StripePreview): React.ReactNode {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <span className="text-deep-green/60">Paid rows: </span>
        <span className="font-mono font-bold tabular-nums">
          {p.paidRows.toLocaleString()}
        </span>
        <span className="ml-1 text-xs text-deep-green/45">
          of {p.totalRows.toLocaleString()} total
          {p.skippedRows > 0
            ? ` · ${p.skippedRows.toLocaleString()} skipped (non-paid or no date)`
            : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-md border border-cream-line bg-white p-3">
          <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
            Membership payments
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-deep-green">
            {p.membershipPayments.toLocaleString()}
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-deep-green/80">
            <li className="flex items-baseline gap-2">
              <span className="text-mint-hover">•</span>
              <span>Allocated via email:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.emailAllocated.toLocaleString()}
              </span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-coral">•</span>
              <span>Unmatched:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.unmatchedEmails.length.toLocaleString()}
              </span>
            </li>
          </ul>
          {p.unmatchedEmails.length > 0 && (
            <UnmatchedEmailsList emails={p.unmatchedEmails} />
          )}
        </div>
        <div className="rounded-md border border-cream-line bg-white p-3">
          <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
            Match payments
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums text-deep-green">
            {p.matchPayments.toLocaleString()}
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-deep-green/80">
            <li className="flex items-baseline gap-2">
              <span className="text-mint-hover">•</span>
              <span>Venue resolved:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.matchRowsWithVenue.toLocaleString()}
              </span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-coral">•</span>
              <span>No venue:</span>
              <span className="font-mono font-bold tabular-nums">
                {p.matchRowsWithoutVenue.toLocaleString()}
              </span>
            </li>
          </ul>
          {p.matchUnmatchedCityCodes.length > 0 && (
            <div className="mt-2 text-xs text-coral">
              Unrecognized city codes:{" "}
              <span className="font-mono">
                {p.matchUnmatchedCityCodes.join(", ")}
              </span>{" "}
              → Corporate / Unmatched
            </div>
          )}
          {p.matchVenueResolutions.length > 0 && (
            <VenueResolutionsList resolutions={p.matchVenueResolutions} />
          )}
        </div>
      </div>
      {(p.strikePayments > 0 || p.strikeSkipped > 0) && (
        <div className="rounded-md border border-cream-line bg-white p-3">
          <div className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
            Strike payments
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-deep-green/80">
            <li className="flex items-baseline gap-2">
              <span className="text-mint-hover">•</span>
              <span>Imported (Paid):</span>
              <span className="font-mono font-bold tabular-nums">
                {p.strikePayments.toLocaleString()}
              </span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-coral">•</span>
              <span>Skipped (non-Paid status):</span>
              <span className="font-mono font-bold tabular-nums">
                {p.strikeSkipped.toLocaleString()}
              </span>
            </li>
          </ul>
        </div>
      )}
      <div className="text-xs text-deep-green/65">
        Date range:{" "}
        <span className="font-mono">
          {p.earliestDate ?? "—"} → {p.latestDate ?? "—"}
        </span>{" "}
        · Months: {p.monthsAffected.join(", ") || "—"}
      </div>
      <div className="text-xs text-deep-green/65">
        Total gross:{" "}
        <span className="font-mono">
          ${Math.round(p.totalGross).toLocaleString("en-US")}
        </span>{" "}
        · Aggregates to{" "}
        <span className="font-mono font-bold">
          {p.aggregatedRowCount.toLocaleString()}
        </span>{" "}
        row{p.aggregatedRowCount === 1 ? "" : "s"} (one per date · city · type
        · venue)
      </div>
      <div className="rounded-md border border-coral/30 bg-coral-soft/30 px-3 py-2 text-xs text-coral">
        This will replace existing Stripe-source rows in fin_revenue between{" "}
        {p.earliestDate ?? "—"} and {p.latestDate ?? "—"}.
      </div>
    </div>
  );
}

function VenueResolutionsList({
  resolutions,
}: {
  resolutions: StripeVenueResolution[];
}) {
  const [open, setOpen] = useState(false);
  const distinctCount = resolutions.length;
  const unresolvedCount = resolutions.filter((r) => !r.canonical).length;
  const top = resolutions.slice(0, 8);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-bold uppercase tracking-wider text-mint-hover hover:text-deep-green"
      >
        {open ? "Hide" : "Show"} venue resolutions ({distinctCount} distinct
        {unresolvedCount > 0 ? `, ${unresolvedCount} unresolved` : ""})
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-cream-line bg-cream-soft/50 p-2 text-xs">
          <table className="w-full">
            <thead className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              <tr>
                <th className="py-1 pr-3 text-left">#</th>
                <th className="py-1 pr-3 text-left">Raw matchName</th>
                <th className="py-1 pr-3 text-left">Canonical venue</th>
                <th className="py-1 text-right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {(open ? resolutions : top).map((r, i) => (
                <tr
                  key={`${r.original}-${i}`}
                  className="border-t border-cream-line/40"
                >
                  <td className="py-0.5 pr-3 font-mono text-deep-green/55">
                    {i + 1}
                  </td>
                  <td className="py-0.5 pr-3 font-mono text-deep-green/85">
                    {r.original || "(blank)"}
                  </td>
                  <td className="py-0.5 pr-3 font-mono">
                    {r.canonical ? (
                      <span className="text-mint-hover">{r.canonical}</span>
                    ) : (
                      <span className="text-coral">unresolved</span>
                    )}
                  </td>
                  <td className="py-0.5 text-right font-mono tabular-nums text-deep-green/75">
                    {r.count.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UnmatchedEmailsList({ emails }: { emails: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-bold uppercase tracking-wider text-mint-hover hover:text-deep-green"
      >
        {open ? "Hide" : "Show"} {emails.length} email
        {emails.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-2 max-h-48 overflow-auto rounded-md border border-cream-line bg-cream-soft/50 p-2 text-xs">
          {emails.map((e) => (
            <li
              key={e}
              className="font-mono text-deep-green/75 leading-relaxed"
            >
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
