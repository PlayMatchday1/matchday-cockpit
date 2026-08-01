"use client";

// Automated Chat Messaging — one page, two stacked sections:
//   A. Community posting  (CommunityDashboard, embedded)
//   B. Veo film links     (VeoDashboard, embedded)
// The two dashboards' own health lines and Refresh buttons are suppressed; this
// page owns one shared header carrying both health lines, one Refresh that
// reloads both sections, a back link to Match Chats, and the title. Nothing
// about either dashboard's data or behaviour changes — this is a move.

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import CommunityDashboard from "@/components/CommunityDashboard";
import VeoDashboard from "@/components/VeoDashboard";

function fmtAgo(min: number | null): string {
  if (min == null) return "never";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AutomationClient() {
  const [reloadKey, setReloadKey] = useState(0);
  const [comm, setComm] = useState<{ successMin: number | null; stale: boolean; cityCount: number } | null>(null);
  const [veo, setVeo] = useState<{ queueLen: number; postedCount: number } | null>(null);

  const onComm = useCallback((h: { successMin: number | null; stale: boolean; cityCount: number }) => setComm(h), []);
  const onVeo = useCallback((h: { queueLen: number; postedCount: number }) => setVeo(h), []);

  return (
    <div className="min-w-0 px-1 pb-16">
      {/* header */}
      <div className="mb-5">
        <Link
          href="/match-ops/match-chats"
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-deep-green/55 transition hover:text-deep-green"
        >
          <ArrowLeft aria-hidden size={15} /> Match Chats
        </Link>
        <div className="mt-1.5 flex flex-wrap items-start gap-4">
          <div>
            <h1 className="m-0 text-[26px] font-extrabold tracking-tight text-deep-green">
              Automated Chat Messaging
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-deep-green/55">
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-semibold ${
                  comm?.stale
                    ? "border-coral/40 bg-coral-soft text-coral-hover"
                    : "border-mint/50 bg-mint-soft text-deep-green"
                }`}
              >
                Community poster · last successful run: {comm ? fmtAgo(comm.successMin) : "…"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-cream-line bg-white px-2.5 py-1 font-semibold text-deep-green">
                Veo · {veo ? veo.queueLen : "…"} in review · {veo ? veo.postedCount : "…"} recent auto-post
                {veo && veo.postedCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-cream-line bg-white px-3 py-2 text-[13px] font-semibold text-deep-green transition hover:border-mint"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Section A — Community posting */}
      <section className="mb-10">
        <h2 className="mb-3 border-b border-cream-line pb-2 text-[15px] font-extrabold tracking-tight text-deep-green">
          Community posting
        </h2>
        <CommunityDashboard embedded reloadKey={reloadKey} onHealth={onComm} />
      </section>

      {/* Section B — Veo film links */}
      <section>
        <h2 className="mb-3 border-b border-cream-line pb-2 text-[15px] font-extrabold tracking-tight text-deep-green">
          Veo film links
        </h2>
        <VeoDashboard embedded reloadKey={reloadKey} onHealth={onVeo} />
      </section>
    </div>
  );
}
