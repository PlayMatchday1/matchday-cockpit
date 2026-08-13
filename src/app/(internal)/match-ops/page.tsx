"use client";

// /match-ops on its own has no content — redirect to the landing sub-tab.
//
// Phase 24: bare /match-ops lands on the FIRST DAILY OPS ITEM the viewer can actually open
// (Gameday Ops for anyone with matchops; the chats-only operator falls through to Match Chats,
// which is also Daily Ops). Previously this went to Master Schedule, which is now Back Office —
// landing there would drop an operator into the weeks-long rhythm rather than today's.
// firstSectionHref reads the same list the rail draws, so the landing target can never name a
// route the viewer cannot open.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { canAccess, firstAllowedPath, useAuth } from "@/lib/useAuth";
import { firstSectionHref } from "./sections";

export default function MatchOpsIndex() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    const daily = firstSectionHref(appUser, "daily");
    if (daily) router.replace(daily);
    else if (canAccess(appUser, "tech")) router.replace("/match-ops/field-pipeline");
    else router.replace(firstAllowedPath(appUser));
  }, [appUser, isLoading, router]);

  return null;
}
