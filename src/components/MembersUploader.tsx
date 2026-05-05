"use client";

import FinanceUploadCard from "@/components/FinanceUploadCard";
import {
  commitMembers,
  previewMembers,
  type MembersPreview,
} from "@/lib/financeImport";

// Members CSV upload section. Drop-zone wraps the generic
// FinanceUploadCard with the Members preview/commit handlers.
// Visual treatment matches MatchesUploader / ReviewsUploader —
// the section header (mint stripe + title + subtitle) is rendered
// by the parent page; this component is just the body.
export default function MembersUploader() {
  return (
    <FinanceUploadCard<MembersPreview>
      index={1}
      title="Members"
      subtitle="Replaces all rows in fin_members. City is derived from Member ID prefix."
      expectedColumns="Member ID, Member Email, Status, First Name, Last Name, Phone Number, Member Activation Date, Membership Length, Price, Canceled At, Cancel Reason"
      preview={previewMembers}
      commit={(p) => commitMembers(p.parsed, p.filename)}
      renderPreview={renderMembersPreview}
      confirmLabel="Confirm Replace"
    />
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
