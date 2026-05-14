"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import FieldRankingTable from "@/components/FieldRankingTable";
import PeriodComparePanel, {
  type PeriodMode,
} from "@/components/PeriodComparePanel";

// Body-only Field Ranking tab content. Two top-level views — the
// existing "Current" month-picker table and the new "Period Compare"
// cross-quarter grid. URL state via ?view= and ?period= so the view
// survives refresh and is shareable. Default is Current to avoid
// surprising existing users.

type View = "current" | "compare";

function parseView(raw: string | null): View {
  return raw === "compare" ? "compare" : "current";
}
function parsePeriod(raw: string | null): PeriodMode {
  return raw === "weekly" ? "weekly" : "monthly";
}

export default function FieldRankingTabContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const view = parseView(sp?.get("view") ?? null);
  const period = parsePeriod(sp?.get("period") ?? null);

  const [collapsed, setCollapsed] = useState(false);

  // URL update helpers. Keep the rest of the query string intact so
  // ?q=<quarter> + ?tab=... still ride along on Period Compare even
  // though it ignores the quarter value semantically.
  const setView = useCallback(
    (next: View) => {
      const qs = new URLSearchParams(sp?.toString() ?? "");
      if (next === "current") {
        qs.delete("view");
        qs.delete("period");
      } else {
        qs.set("view", "compare");
        if (!qs.has("period")) qs.set("period", "monthly");
      }
      const s = qs.toString();
      router.replace(s ? `?${s}` : "?");
    },
    [router, sp],
  );

  const setPeriod = useCallback(
    (next: PeriodMode) => {
      const qs = new URLSearchParams(sp?.toString() ?? "");
      qs.set("view", "compare");
      qs.set("period", next);
      router.replace(`?${qs.toString()}`);
    },
    [router, sp],
  );

  return (
    <div className="mb-12 space-y-5">
      <div className="inline-flex rounded-full border border-cream-line bg-cream-soft p-0.5 text-xs font-bold">
        {(["current", "compare"] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setView(opt)}
            className={`rounded-full px-4 py-1.5 transition ${
              view === opt
                ? "bg-mint text-deep-green"
                : "text-deep-green/65 hover:text-deep-green"
            }`}
            aria-pressed={view === opt}
          >
            {opt === "current" ? "Current" : "Period Compare"}
          </button>
        ))}
      </div>

      {view === "current" ? (
        <FieldRankingTable
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
        />
      ) : (
        <PeriodComparePanel mode={period} onModeChange={setPeriod} />
      )}
    </div>
  );
}
