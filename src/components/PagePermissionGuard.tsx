"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  canAccess,
  firstAllowedPath,
  useAuth,
  type PageName,
} from "@/lib/useAuth";

export default function PagePermissionGuard({
  page,
  children,
}: {
  page: PageName;
  children: React.ReactNode;
}) {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (!canAccess(appUser, page)) {
      router.replace(firstAllowedPath(appUser));
    }
  }, [appUser, isLoading, page, router]);

  if (isLoading || !appUser) return null;
  if (!canAccess(appUser, page)) return null;
  return <>{children}</>;
}
