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

  // Chat shells (/chats, /match-chats) render their own MobileBottomNav
  // inline as a flex child of their 100dvh shell, instead of relying on
  // viewport-fixed positioning. iOS Safari PWA miscalculates
  // position:fixed bottom:0 against the visual viewport in those
  // locked-shell pages after a keyboard cycle. Skipping the fixed nav
  // here keeps the rest of the app on the old (working) fixed-nav
  // layout while letting chat routes opt into the inline pattern.
  const onChatShell =
    !!pathname &&
    (pathname.startsWith("/chats") || pathname.startsWith("/match-chats"));

  return (
    <>
      <TopNav />
      <main
        className="mx-auto max-w-6xl px-6"
        style={{
          // max() so the top padding clears the iOS status bar on
          // mobile PWA (TopNav hidden, no other chrome above) while
          // staying at the standard 2rem buffer on desktop and any
          // viewport where env() resolves to 0.
          paddingTop: "max(env(safe-area-inset-top), 2rem)",
          paddingBottom: "calc(2rem + var(--bottom-nav-h))",
        }}
      >
        {children}
      </main>
      {!onChatShell && <MobileBottomNav />}
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
