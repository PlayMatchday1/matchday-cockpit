"use client";

// /admin/test — the v8 analytics dashboard, shown full-bleed as its own
// design. The mockup already carries its own left sidebar (Revenue / Field
// Costs / Growth / Members & Retention, plus a System group), so Cockpit adds
// no sub-nav: this page renders ONE thing — the mockup in an <iframe>, filling
// the whole area below the MATCHDAY header.
//
// It stays an <iframe> permanently: the mockup ships global element selectors
// (star / html / body, lines 21-23) that would overwrite Cockpit's layout
// app-wide if the markup were ever inlined.
//
// Admin-only. Gated on app_users.is_admin directly (the nav link is also
// is_admin-gated, but hiding a link is not a permission check).

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth, firstAllowedPath } from "@/lib/useAuth";

const MOCKUP_SRC = "/mockups/clubhouse-additions-v8.html";

export default function AdminTestPage() {
  const { appUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || !appUser) return;
    if (!appUser.is_admin) router.replace(firstAllowedPath(appUser));
  }, [appUser, isLoading, router]);

  if (isLoading || !appUser) return null;
  if (!appUser.is_admin) return null;

  // Fixed below the 64px (h-16) MATCHDAY header so it escapes AuthGate's
  // max-w-6xl padded <main>: full width edge-to-edge, from the header's bottom
  // to the viewport bottom. Flex column — thin banner, then the iframe fills
  // the rest (height = 100vh − header − banner) and scrolls internally; the
  // outer page does not scroll.
  return (
    <div className="fixed inset-x-0 bottom-0 top-16 z-10 flex flex-col bg-cream">
      {/* Non-dismissible, always-visible sample-data strip, directly under the
          header, kept as thin as possible. */}
      <div
        role="alert"
        className="shrink-0 bg-amber-50 px-4 py-1 text-center text-[11px] font-bold text-amber-800"
      >
        Design mockup — all figures are sample data, not live. For layout review
        only.
      </div>
      <iframe
        src={MOCKUP_SRC}
        title="Matchday Clubhouse — Operating Dashboard v8 (design mockup)"
        className="w-full flex-1 border-0"
      />
    </div>
  );
}
