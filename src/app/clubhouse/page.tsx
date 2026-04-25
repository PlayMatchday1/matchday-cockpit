"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import HeroMessage from "@/components/HeroMessage";
import HomeGoalsView from "@/components/HomeGoalsView";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import QuickStats from "@/components/QuickStats";
import TopicsView from "@/components/TopicsView";

export default function ClubhousePage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <Suspense fallback={null}>
        <ClubhouseContent />
      </Suspense>
    </PagePermissionGuard>
  );
}

function ClubhouseContent() {
  const sp = useSearchParams();
  const tab = sp.get("tab") === "topics" ? "topics" : "goals";

  return (
    <>
      <HeroMessage />
      <Tabs active={tab} />
      {tab === "goals" ? (
        <>
          <QuickStats />
          <HomeGoalsView />
        </>
      ) : (
        <TopicsView />
      )}
    </>
  );
}

function Tabs({ active }: { active: "goals" | "topics" }) {
  const base =
    "inline-flex items-center rounded-full px-4 py-1.5 text-sm font-bold tracking-tight transition";
  const activeCls = "bg-mint text-deep-green";
  const inactiveCls = "text-deep-green/70 hover:bg-cream-soft";
  return (
    <nav className="mb-8 flex gap-2" role="tablist" aria-label="Clubhouse tabs">
      <Link
        href="/clubhouse?tab=goals"
        className={`${base} ${active === "goals" ? activeCls : inactiveCls}`}
        role="tab"
        aria-selected={active === "goals"}
      >
        Goals
      </Link>
      <Link
        href="/clubhouse?tab=topics"
        className={`${base} ${active === "topics" ? activeCls : inactiveCls}`}
        role="tab"
        aria-selected={active === "topics"}
      >
        Topics
      </Link>
    </nav>
  );
}
