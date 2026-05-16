"use client";

// Bottom-of-screen "Install MatchDay" banner shown on iPhone Safari
// when the operator is browsing inside the auth-gated app and
// hasn't dismissed the prompt before. iOS doesn't fire the
// beforeinstallprompt event (that's Chromium-only), so we render
// our own banner that points operators at Share → Add to Home
// Screen via a "How" overlay.
//
// Visibility rules — all must be true to show:
//   1. Mobile viewport (width < 768px)
//   2. iOS Safari (UA contains iPhone/iPad/iPod AND NOT another
//      well-known UA string that masks iOS Safari)
//   3. NOT already running in standalone mode
//      (display-mode: standalone OR navigator.standalone === true)
//   4. Operator hasn't dismissed before (localStorage flag)
//
// Mounted inside the (internal) layout so it doesn't appear on
// /login. AuthGate already gates that subtree.

import { useEffect, useState } from "react";

const DISMISS_KEY = "pwa:install-prompt-dismissed:v1";

function isInStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  // navigator.standalone is iOS-Safari-specific. matchMedia is the
  // cross-browser path. Either being true means we're already
  // home-screen-launched.
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return window.matchMedia("(display-mode: standalone)").matches;
}

function isIosSafari(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  const isIosDevice = /iPhone|iPad|iPod/.test(ua);
  if (!isIosDevice) return false;
  // CriOS = Chrome on iOS, FxiOS = Firefox on iOS, EdgiOS = Edge on
  // iOS. The Add-to-Home-Screen flow requires real Safari; the
  // banner is misleading on alternative browsers.
  if (/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/.test(ua)) return false;
  return true;
}

export default function PwaInstallPrompt() {
  // Three-state machine: hidden (initial), banner (default after
  // checks pass), overlay (showing the How-to-install steps).
  const [mode, setMode] = useState<"hidden" | "banner" | "overlay">("hidden");

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Re-evaluate visibility on mount. We deliberately don't watch
    // for viewport resize — operators on phones don't typically
    // hit the 768px desktop breakpoint mid-session.
    const isMobile = window.innerWidth < 768;
    if (!isMobile) return;
    if (!isIosSafari()) return;
    if (isInStandaloneMode()) return;

    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      // localStorage unavailable (private mode etc) — still show
      // the banner; the user can dismiss in-session if needed.
    }

    setMode("banner");
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode — banner just hides for this session */
    }
    setMode("hidden");
  }

  if (mode === "hidden") return null;

  return (
    <>
      {/* Bottom banner */}
      {mode === "banner" && (
        <div
          role="region"
          aria-label="Install MatchDay app"
          className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-deep-green/30 bg-deep-green px-4 py-3 text-cream shadow-2xl shadow-deep-green/40"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <div className="flex-1 text-sm">
            <div className="font-bold">Install MatchDay</div>
            <div className="text-xs text-cream/75">
              Add to Home Screen for full-screen access.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMode("overlay")}
            className="rounded-full bg-mint px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
          >
            How
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-full px-2 py-1.5 text-xs font-medium text-cream/75 transition hover:text-cream"
          >
            Not now
          </button>
        </div>
      )}

      {/* How-to overlay */}
      {mode === "overlay" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="How to install MatchDay"
          className="fixed inset-0 z-50 flex items-end"
        >
          <div
            className="absolute inset-0 bg-deep-green/40"
            onClick={() => setMode("banner")}
          />
          <div
            className="relative w-full rounded-t-2xl bg-cream p-6 shadow-2xl"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }}
          >
            <h2 className="text-lg font-extrabold text-deep-green">
              Install MatchDay
            </h2>
            <ol className="mt-4 space-y-3 text-sm text-deep-green">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mint text-xs font-bold text-deep-green">
                  1
                </span>
                <span>
                  Tap the <span className="font-bold">Share</span> button at
                  the bottom of Safari (the square with an up-arrow).
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mint text-xs font-bold text-deep-green">
                  2
                </span>
                <span>
                  Scroll down and tap{" "}
                  <span className="font-bold">Add to Home Screen</span>.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mint text-xs font-bold text-deep-green">
                  3
                </span>
                <span>
                  Tap <span className="font-bold">Add</span> in the top
                  right. MatchDay will appear on your home screen.
                </span>
              </li>
            </ol>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMode("banner")}
                className="rounded-full border border-deep-green/20 bg-white px-3 py-1.5 text-sm font-medium text-deep-green transition hover:bg-cream-soft"
              >
                Back
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full bg-deep-green px-3 py-1.5 text-sm font-medium text-cream transition hover:bg-deep-green-hover"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
