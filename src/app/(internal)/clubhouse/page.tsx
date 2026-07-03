"use client";

import { Suspense, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import HeroMessage from "@/components/HeroMessage";
import HomeGoalsView from "@/components/HomeGoalsView";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import QuarterSelector from "@/components/QuarterSelector";
import QuickStats from "@/components/QuickStats";
import TopicsView from "@/components/TopicsView";
import KanbanBoard from "./KanbanBoard";
import { ClubhouseQuarterProvider } from "@/lib/clubhouseQuarter";
import {
  getAvailableQuarters,
  getCurrentQuarter,
  isPlanningQuarter,
  resolveQuarterFromUrl,
  type QuarterInfo,
} from "@/lib/quarters";

export default function ClubhousePage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <Suspense fallback={null}>
        <ClubhouseContent />
      </Suspense>
    </PagePermissionGuard>
  );
}

type ClubhouseTab = "goals" | "topics" | "field-pipeline" | "tech-roadmap";

function ClubhouseContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const rawTab = sp?.get("tab");
  const tab: ClubhouseTab =
    rawTab === "topics" ||
    rawTab === "field-pipeline" ||
    rawTab === "tech-roadmap"
      ? rawTab
      : "goals";

  // Quarter selector + URL state. Same pattern as /admin/finance:
  // ?q=<key> drives the active quarter; selecting the default
  // (current calendar) quarter drops the param to keep URLs clean.
  const availableQuarters = useMemo(() => getAvailableQuarters(), []);
  const quarter = useMemo<QuarterInfo>(
    () => resolveQuarterFromUrl(sp?.get("q") ?? null, new Date()),
    [sp],
  );
  const handleQuarterChange = useCallback(
    (key: string) => {
      const qs = new URLSearchParams(sp?.toString() ?? "");
      if (key === getCurrentQuarter().key) qs.delete("q");
      else qs.set("q", key);
      const s = qs.toString();
      router.replace(s ? `?${s}` : "?");
    },
    [router, sp],
  );

  const planning = isPlanningQuarter(quarter, new Date());

  return (
    <ClubhouseQuarterProvider quarter={quarter}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <HeroMessage />
        <QuarterSelector
          available={availableQuarters}
          value={quarter.key}
          onChange={handleQuarterChange}
          now={new Date()}
        />
      </div>

      {planning && (
        <div
          role="note"
          className="mb-6 rounded-2xl border-[1.5px] border-cream-line bg-cream-soft/60 px-5 py-3 text-sm text-deep-green/70 shadow-sm shadow-deep-green/5"
        >
          <span className="font-bold text-deep-green">{quarter.label}</span> ·
          Planning quarter — set goals and seed topics now to forecast.
        </div>
      )}

      <Tabs active={tab} />
      {tab === "goals" && (
        <>
          <QuickStats />
          <HomeGoalsView />
        </>
      )}
      {tab === "topics" && <TopicsView />}
      {tab === "field-pipeline" && <KanbanBoard boardType="field_pipeline" />}
      {tab === "tech-roadmap" && <KanbanBoard boardType="tech_roadmap" />}
    </ClubhouseQuarterProvider>
  );
}

const TABS: { key: ClubhouseTab; label: string }[] = [
  { key: "goals", label: "Goals" },
  { key: "topics", label: "Topics" },
  { key: "field-pipeline", label: "Field Pipeline" },
  { key: "tech-roadmap", label: "Tech Roadmap" },
];

function Tabs({ active }: { active: ClubhouseTab }) {
  const base =
    "inline-flex items-center rounded-full px-4 py-1.5 text-sm font-bold tracking-tight transition";
  const activeCls = "bg-mint text-deep-green";
  const inactiveCls = "text-deep-green/70 hover:bg-cream-soft";
  return (
    <nav
      className="mb-8 flex flex-wrap gap-2"
      role="tablist"
      aria-label="Clubhouse tabs"
    >
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={`/clubhouse?tab=${t.key}`}
          className={`${base} ${active === t.key ? activeCls : inactiveCls}`}
          role="tab"
          aria-selected={active === t.key}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
