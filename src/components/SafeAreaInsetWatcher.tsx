"use client";

// Forces env(safe-area-inset-top) to recompute after iOS Safari
// standalone PWA keyboard cycles. iOS caches env() per-element and the
// cached value collapses to ~0 while the keyboard is open; it does not
// always refresh after dismiss. The visualViewport resize event fires
// on keyboard show AND dismiss (and orientation change). On every
// resize we create a fresh DOM probe with padding-top: env(...) so iOS
// is forced to compute env() against the current viewport state, read
// the result, and write it back to the --safe-area-top CSS variable
// on <html>. Any consumer using var(--safe-area-top) then stays fresh.

import { useEffect } from "react";

export function SafeAreaInsetWatcher() {
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;

    const update = () => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;top:0;left:-9999px;width:0;height:0;padding-top:env(safe-area-inset-top);visibility:hidden;";
      document.body.appendChild(probe);
      const computed = parseFloat(getComputedStyle(probe).paddingTop) || 0;
      document.body.removeChild(probe);
      document.documentElement.style.setProperty(
        "--safe-area-top",
        `${computed}px`,
      );
    };

    update();
    window.visualViewport.addEventListener("resize", update);

    return () => {
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);

  return null;
}
