"use client";

import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { canSeeCheckInsPreview, MANAGERS } from "@/lib/checkIns";
import { useCheckIns } from "@/lib/useCheckIns";

export default function CheckInsButtonCard() {
  const { appUser } = useAuth();
  const visible = canSeeCheckInsPreview(appUser?.email);
  const { data, loading, error } = useCheckIns();

  // Hidden entirely for non-allowlisted users during the preview
  // window. Remove this guard in Phase 2.
  if (!visible) return null;

  return (
    <Link
      href="/admin/finance/check-ins"
      className="block rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-deep-green/20"
    >
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/45">
        Check-ins
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <div className="text-base font-bold text-deep-green">
          City Manager Check-Ins
        </div>
        <div className="text-xs text-deep-green/65">
          {data ? (
            <>
              <span className="font-bold text-deep-green">
                {data.submittedCount}
              </span>{" "}
              of{" "}
              <span className="font-bold text-deep-green">
                {MANAGERS.length}
              </span>{" "}
              submitted this month
              {data.overdueCount > 0 && (
                <>
                  {" · "}
                  <span className="font-bold text-coral">
                    {data.overdueCount}
                  </span>{" "}
                  overdue
                </>
              )}
            </>
          ) : loading ? (
            "Loading…"
          ) : error ? (
            <span className="text-coral">Sheet unavailable</span>
          ) : null}
        </div>
      </div>
      <div className="mt-3 text-xs font-bold uppercase tracking-wider text-mint-hover">
        Open →
      </div>
    </Link>
  );
}
