"use client";

// /match-ops on its own has no content — redirect to the landing sub-tab.
// Master Schedule (page="cities") is the default landing; users without cities
// access fall through to chats, then Field Pipeline, then their own first-allowed
// page (the top-level tab is hidden for them anyway, but typing the URL must not
// 500).

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { canAccess, firstAllowedPath, useAuth } from "@/lib/useAuth";

export default function MatchOpsIndex() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (canAccess(appUser, "cities")) router.replace("/match-ops/master-schedule");
    else if (canAccess(appUser, "chats")) router.replace("/match-ops/chats");
    else if (canAccess(appUser, "clubhouse"))
      router.replace("/match-ops/field-pipeline");
    else router.replace(firstAllowedPath(appUser));
  }, [appUser, isLoading, router]);

  return null;
}
