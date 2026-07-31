"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import HeroMessage from "@/components/HeroMessage";
import HomeGoalsView from "@/components/HomeGoalsView";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import KanbanBoard from "./KanbanBoard";
import { ClubhouseQuarterProvider } from "@/lib/clubhouseQuarter";
import { resolveQuarterFromUrl, type QuarterInfo } from "@/lib/quarters";

export default function ClubhousePage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <Suspense fallback={null}>
        <ClubhouseContent />
      </Suspense>
    </PagePermissionGuard>
  );
}

type ClubhouseTab = "goals" | "field-pipeline" | "tech-roadmap";

function ClubhouseContent() {
  const sp = useSearchParams();
  const rawTab = sp?.get("tab");
  const tab: ClubhouseTab =
    rawTab === "field-pipeline" || rawTab === "tech-roadmap"
      ? rawTab
      : "goals"; // unknown/removed tabs (incl. the retired ?tab=topics) → goals

  // The Home page no longer renders a quarter selector, greeting, or KPI row —
  // the goals tab shows only the (quarter-agnostic) Org goals. The quarter
  // still resolves from ?q= and is provided as context so goal editing keeps
  // working, but there is no UI to change it here.
  const quarter = useMemo<QuarterInfo>(
    () => resolveQuarterFromUrl(sp?.get("q") ?? null, new Date()),
    [sp],
  );

  return (
    <ClubhouseQuarterProvider quarter={quarter}>
      <HeroMessage />
      <Tabs active={tab} />
      {tab === "goals" && <HomeGoalsView />}
      {tab === "field-pipeline" && <KanbanBoard boardType="field_pipeline" />}
      {tab === "tech-roadmap" && <KanbanBoard boardType="tech_roadmap" />}
    </ClubhouseQuarterProvider>
  );
}

const TABS: { key: ClubhouseTab; label: string }[] = [
  { key: "goals", label: "Goals" },
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
      aria-label="Home tabs"
    >
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={`/home?tab=${t.key}`}
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
