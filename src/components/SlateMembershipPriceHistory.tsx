"use client";

// Per-city membership price changes, surfaced in the Slate Review
// stack. Reads from membership_price_snapshots (migration 0051),
// which is populated by the nightly cron step or the /data → Sync
// now manual trigger. Each snapshot row represents an insert-on-
// change event: a city's MAX active-subscription price differing
// from its prior snapshot. The first snapshot per city is the
// baseline (no prior; nothing to compare).
//
// History before the first snapshot is GONE — no upstream audit
// log existed to backfill from. The empty-state copy makes that
// situation legible to the operator rather than rendering a blank
// section that looks broken.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { City } from "@/lib/types";

type Snapshot = {
  id: string;
  captured_at: string;
  city: string;
  max_price_dollars: number;
  active_count_at_price: number;
};

function fmtFullDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtMonthDay(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()}`;
}

function fmtAgo(daysAgo: number): string {
  if (daysAgo <= 1) return daysAgo === 0 ? "today" : "1 day ago";
  if (daysAgo < 7) return `${daysAgo} days ago`;
  const weeks = Math.floor(daysAgo / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

function daysSince(iso: string, now: Date): number {
  const d = new Date(iso);
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
}

export default function SlateMembershipPriceHistory({
  city,
}: {
  city: City;
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSnapshots(null);
    setError(null);

    supabase
      .from("membership_price_snapshots")
      .select("*")
      .eq("city", city)
      .order("captured_at", { ascending: false })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(err.message);
        else setSnapshots((data ?? []) as Snapshot[]);
      });

    return () => {
      cancelled = true;
    };
  }, [city]);

  if (error) {
    return (
      <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
        {error}
      </div>
    );
  }

  if (snapshots === null) {
    return <div className="text-xs italic text-deep-green/45">Loading…</div>;
  }

  if (snapshots.length === 0) {
    return (
      <div className="text-xs italic text-deep-green/55">
        No membership snapshots for {city} yet. The next nightly sync
        will create the baseline.
      </div>
    );
  }

  const now = new Date();
  // Snapshots ordered DESC. The last element is the baseline (oldest).
  const baseline = snapshots[snapshots.length - 1];
  const latest = snapshots[0];

  if (snapshots.length === 1) {
    return (
      <div className="space-y-2 text-xs text-deep-green/65">
        <div>
          Membership history captured since{" "}
          <span className="font-bold text-deep-green">
            {fmtFullDate(baseline.captured_at)}
          </span>{" "}
          — no changes recorded.
        </div>
        <div>
          Current MAX active price:{" "}
          <span className="font-mono font-bold tabular-nums text-deep-green">
            ${baseline.max_price_dollars}
          </span>{" "}
          ({baseline.active_count_at_price} active at this price)
        </div>
      </div>
    );
  }

  // Adjacent pairs become change events. snapshot[i] is the newer
  // value; snapshot[i+1] is the prior value that was superseded.
  const events: {
    prev: number;
    next: number;
    changedAtIso: string;
    activeCount: number;
  }[] = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const newer = snapshots[i];
    const older = snapshots[i + 1];
    events.push({
      prev: older.max_price_dollars,
      next: newer.max_price_dollars,
      changedAtIso: newer.captured_at,
      activeCount: newer.active_count_at_price,
    });
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-deep-green/55">
        Tracks the highest active-subscription price per city. Snapshot
        captured nightly; a row is written only when the max changes.
        History captured since{" "}
        <span className="font-bold text-deep-green">
          {fmtFullDate(baseline.captured_at)}
        </span>
        . Current: <span className="font-mono font-bold text-deep-green">${latest.max_price_dollars}</span>.
      </div>
      <ul className="space-y-1.5">
        {events.map((e) => (
          <li
            key={e.changedAtIso}
            className="rounded-lg border border-cream-line bg-white px-3 py-2"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono tabular-nums text-deep-green/55">
                Membership
              </span>
              <span className="font-mono font-bold tabular-nums text-deep-green">
                ${e.prev} → ${e.next}
              </span>
              <span className="text-[11px] text-deep-green/55">
                on {fmtMonthDay(e.changedAtIso)} ·{" "}
                {fmtAgo(daysSince(e.changedAtIso, now))}
              </span>
              <span className="text-[11px] text-deep-green/45">
                · {e.activeCount} active at this price
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
