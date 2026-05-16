"use client";

// Registers /sw.js once per browser session in production. Mounted
// at the root layout level so it kicks off as early as possible
// without blocking the first paint.
//
// Skipped in dev (NODE_ENV !== "production") to avoid the classic
// service-worker-caches-an-old-bundle pain during local hot reload.
// Skipped on non-https origins too — browsers refuse to register
// SWs outside secure contexts anyway, but we filter early to keep
// the console clean.

import { useEffect } from "react";

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Secure context required by the spec. Localhost is treated as
    // secure by all browsers, but a `next start` on a non-https
    // host (e.g. behind a tunnel) would fail registration. Skip.
    if (!window.isSecureContext) return;

    // Wait for load so SW registration doesn't compete with the
    // initial route's network fan-out.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => {
          // Non-fatal: app still works, we just lose the static-
          // asset cache benefit. Log so we notice in dev tools.
          console.warn("[pwa] service worker registration failed:", err);
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }, []);

  return null;
}
