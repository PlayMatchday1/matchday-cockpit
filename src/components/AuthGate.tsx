"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { hasAnyAccess, useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabase";
import MobileAppBar from "./MobileAppBar";
import { SectionNavProvider } from "./SectionNav";
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
        pathname && pathname !== "/" && pathname !== "/home"
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
    (pathname.startsWith("/match-ops/match-chats") ||
      pathname.startsWith("/match-ops/player-chats"));

  return (
    /* THE PROVIDER WRAPS BOTH THE BAR AND <main>, because the bar READS what the section shells
     * inside main PUBLISH. Anything narrower and the bar cannot see them. */
    <SectionNavProvider>
      <TopNav />
      {/* THE ONE MOBILE APP BAR, ABOVE <main> AND NOT INSIDE IT. Five section shells used to render
          their own copy from inside main, and main also paid the notch inset, so a Dynamic Island
          phone paid 59px twice before the bar's own 44px band. The shell owns the bar now; it pays
          var(--sat), and main pays var(--main-pt), which is 0 at these widths. */}
      <MobileAppBar />
      <main
        className="mx-auto max-w-[1600px] px-8"
        style={{
          // --main-pt is max(env(safe-area-inset-top), 26px) on desktop and 0 below the rail
          // breakpoint, where MobileAppBar pays the inset instead. ONE formula, in globals.css,
          // because the literal used to be written out here and negated in two page files that
          // then had to agree with it forever. Widened container (was max-w-6xl / 1152px) so wide
          // monitors aren't half-empty.
          paddingTop: "var(--main-pt)",
          paddingBottom: "calc(60px + var(--bottom-nav-h))",
        }}
      >
        {children}
      </main>
      {!onChatShell && <MobileBottomNav />}
    </SectionNavProvider>
  );
}

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream">
      <div className="text-sm font-medium text-deep-green/60">Loading…</div>
    </div>
  );
}
