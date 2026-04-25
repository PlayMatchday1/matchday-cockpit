"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { firstAllowedPath, useAuth } from "@/lib/useAuth";

export default function AdminGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (!appUser.is_admin) {
      router.replace(firstAllowedPath(appUser));
    }
  }, [appUser, isLoading, router]);

  if (isLoading || !appUser) return null;
  if (!appUser.is_admin) return null;
  return <>{children}</>;
}
