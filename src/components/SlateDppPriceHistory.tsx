"use client";

// Per-city DPP per-spot price changes, surfaced in the Slate Review
// stack. Reconstructs history from mdapi_match_players because no
// native audit log exists for mdapi_matches.registration_price
// edits — see src/lib/dppPriceHistory.ts header for the modal
// algorithm and noise-filter rationale.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";
import { fetchLegacyMatchRegistrations } from "@/lib/mdapiMatchesRead";
import {
  detectDppPriceShifts,
  type DppRegistration,
  type DppPriceChange,
} from "@/lib/dppPriceHistory";
import type { City } from "@/lib/types";

// 16-week lookback. Long enough to surface a quarter's worth of
// changes; short enough to keep the registration fetch manageable.
const HISTORY_WEEKS = 16;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function fmtMonthDay(d: Date): string {
  return `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()}`;
}

function fmtAgo(daysAgo: number, weeksAgo: number): string {
  if (daysAgo <= 1) return daysAgo === 0 ? "today" : "1 day ago";
  if (daysAgo < 7) return `${daysAgo} days ago`;
  return weeksAgo === 1 ? "1 week ago" : `${weeksAgo} weeks ago`;
}

// "YYYY-MM-DD HH:MM:SS" → local Date. Mirrors the parser in
// matchPnL.ts (intentional duplication; both files share the same
// upstream string shape but each is self-contained).
function parseLocal(s: string): Date | null {
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 3) return null;
  const [yr, mo, dy, hr = "0", mn = "0"] = parts;
  const [y, m, d, h, n] = [yr, mo, dy, hr, mn].map(Number);
  if ([y, m, d, h, n].some((x) => Number.isNaN(x))) return null;
  return new Date(y, m - 1, d, h, n);
}

export default function SlateDppPriceHistory({ city }: { city: City }) {
  const { data, loading: dataLoading } = useFinanceData();
  const [changes, setChanges] = useState<DppPriceChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (dataLoading || !data) return;
    setChanges(null);
    setError(null);

    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() - HISTORY_WEEKS * 7);

    (async () => {
      try {
        const rows = await fetchLegacyMatchRegistrations(supabase, {
          fromDate: ymd(from),
          toDate: ymd(now),
        });
        if (cancelled) return;

        const venueById = new Map(data.venues.map((v) => [v.id, v]));
        const regs: DppRegistration[] = [];
        for (const r of rows) {
          if (r.payment_type !== "DAILY PAID") continue;
          if (r.field_id == null) continue;
          const venueId = data.venueFields.get(r.field_id);
          if (venueId == null) continue;
          const venue = venueById.get(venueId);
          if (!venue || venue.city !== city) continue;
          const matchStart = parseLocal(r.match_start);
          if (!matchStart) continue;
          regs.push({
            matchStart,
            venueId,
            venueName: venue.venue_name,
            city: venue.city,
            amountDollars: r.match_price_paid,
          });
        }

        const shifts = detectDppPriceShifts(regs, { now });
        if (!cancelled) setChanges(shifts);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [city, data, dataLoading]);

  if (error) {
    return (
      <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
        {error}
      </div>
    );
  }

  if (changes === null) {
    return <div className="text-xs italic text-deep-green/45">Loading…</div>;
  }

  if (changes.length === 0) {
    return (
      <div className="text-xs italic text-deep-green/55">
        No DPP price changes detected in the last {HISTORY_WEEKS} weeks for {city}.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-deep-green/55">
        Detected from per-match registration prices over the last{" "}
        {HISTORY_WEEKS} weeks. A change is recorded only if the new
        modal holds for ≥2 observations, so one-off discounts don't
        appear.
      </div>
      <ul className="space-y-1.5">
        {changes.map((c) => (
          <li
            key={`${c.venueId}|${c.changeWeekStart.toISOString()}`}
            className="rounded-lg border border-cream-line bg-white px-3 py-2"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-bold text-deep-green">{c.venueName}</span>
              <span className="font-mono tabular-nums text-deep-green/55">
                DPP
              </span>
              <span className="font-mono font-bold tabular-nums text-deep-green">
                ${c.prevPriceDollars} → ${c.newPriceDollars}
              </span>
              <span className="text-[11px] text-deep-green/55">
                on {fmtMonthDay(c.changeWeekStart)} ·{" "}
                {fmtAgo(c.daysAgo, c.weeksAgo)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
