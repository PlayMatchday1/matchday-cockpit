"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { hasAnyAccess, useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabase";
import TopNav from "./TopNav";
import MobileBottomNav from "./MobileBottomNav";

const PUBLIC_PATHS = ["/login", "/auth/callback"];

function isPublicPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, appUser, isLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = isPublicPath(pathname);

  useEffect(() => {
    if (isLoading || isPublic) return;
    if (!user) {
      const next =
        pathname && pathname !== "/" && pathname !== "/clubhouse"
          ? `?next=${encodeURIComponent(pathname)}`
          : "";
      router.replace(`/login${next}`);
      return;
    }
    if (!appUser) {
      supabase.auth.signOut().then(() => {
        router.replace("/login?error=not_authorized");
      });
      return;
    }
    if (!hasAnyAccess(appUser) && pathname !== "/no-access") {
      router.replace("/no-access");
    }
  }, [user, appUser, isLoading, isPublic, pathname, router]);

  if (isPublic) {
    return <>{children}</>;
  }

  if (isLoading || !user || !appUser) {
    return <FullPageSpinner />;
  }

  if (!hasAnyAccess(appUser) && pathname !== "/no-access") {
    return <FullPageSpinner />;
  }

  return (
    <>
      <TopNav />
      <main
        className="mx-auto max-w-6xl px-6 py-8"
        style={{ paddingBottom: "calc(2rem + var(--bottom-nav-h))" }}
      >
        {children}
      </main>
      <MobileBottomNav />
    </>
  );
}

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream">
      <div className="text-sm font-medium text-deep-green/60">Loading…</div>
    </div>
  );
}
