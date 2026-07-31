"use client";

// /tech on its own redirects to its one sub-tab. Route must not 500 if the user
// can't access it — send them to their first-allowed page instead.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { canAccess, firstAllowedPath, useAuth } from "@/lib/useAuth";

export default function TechIndex() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (canAccess(appUser, "clubhouse")) router.replace("/tech/tech-roadmap");
    else router.replace(firstAllowedPath(appUser));
  }, [appUser, isLoading, router]);

  return null;
}
