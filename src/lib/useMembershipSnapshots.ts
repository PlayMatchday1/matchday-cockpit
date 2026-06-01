"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { monthLabel } from "./membershipStats";

// One row of members_monthly_snapshots — the full monthly breakdown the
// Membership tab needs to render a prior month WITHOUT recomputing from
// the live mdapi_subscriptions table. Live recompute drifts: a member
// who cancels in a later month would retroactively change a past month's
// "active" count, because isActiveAsOf keys off current status. The
// snapshot is the frozen historical record. See investigation 2026-05-31.
export type MembershipSnapshotRow = {
  month: string; // YYYY-MM-DD, always first of month
  active_count: number;
  new_count: number;
  cancelled_count: number;
  churning_count: number;
  avg_matches_per_member: number | null;
  members_tracked: number | null;
  by_city: Record<string, { active: number; new: number; cancelled: number }>;
};

// View passed from CitiesMembershipLens down to each switchable card.
// isCurrentMonth === true means "render the existing live path"; false
// means "render from snapshotRow (or show no-data / loading)".
export type MembershipMonthView = {
  monthIso: string; // YYYY-MM-01
  monthLabel: string; // e.g. "May 2026"
  isCurrentMonth: boolean;
  snapshotRow: MembershipSnapshotRow | null;
  snapshotLoading: boolean;
};

// Churning was only reliably captured from the first live (non-backfill)
// snapshot — April 2026 — onward. Earlier rows were backfilled with
// churning_count = 0 because the rolling active+cancel window can't be
// faithfully reconstructed from current-state data, so a stored 0 there
// means "not measured", not "measured zero". Show "—" for those months.
// (avg_matches_per_member / members_tracked are genuinely NULL before
// March 2026, so those mask themselves.)
export const CHURNING_TRACKED_SINCE_ISO = "2026-04-01";

export function firstOfMonthIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// "2026-05" → "2026-05-01". Returns null for anything that isn't a
// well-formed YYYY-MM so a junk ?month= param falls back to current.
export function monthParamToIso(param: string | null): string | null {
  if (!param || !/^\d{4}-\d{2}$/.test(param)) return null;
  return `${param}-01`;
}

// "2026-05-01" → "2026-05" for the ?month= URL param.
export function isoToMonthParam(iso: string): string {
  return iso.slice(0, 7);
}

// "2026-05-01" → local Date at midnight (no UTC shift) → "May 2026".
export function monthLabelFromIso(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})/);
  if (!m) return iso;
  return monthLabel(new Date(+m[1], +m[2] - 1, 1));
}

// Fetches every captured monthly snapshot once, newest first, so the
// Membership tab can populate its month selector and render any prior
// month from the frozen row.
export function useMembershipSnapshots(): {
  rows: MembershipSnapshotRow[];
  loading: boolean;
  error: string | null;
} {
  const [rows, setRows] = useState<MembershipSnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("members_monthly_snapshots")
      .select(
        "month, active_count, new_count, cancelled_count, churning_count, avg_matches_per_member, members_tracked, by_city",
      )
      .order("month", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setError(error.message);
          setLoading(false);
          return;
        }
        setRows((data ?? []) as MembershipSnapshotRow[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { rows, loading, error };
}
