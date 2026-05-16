// MatchDay Cockpit — PWA Phase 1 service worker.
//
// Scope: minimal cache-first for the handful of static assets the
// app needs on cold launch (manifest, brand icons, the SVG badge
// in the root layout). Everything else — API routes, HTML pages,
// JS bundles — passes straight through to the network. Caching
// HTML would freeze the UI on stale bundles; caching /api/* would
// break realtime + audit trails. Don't do it.
//
// Cache version bumps invalidate all old caches. Bump CACHE_VERSION
// whenever the precache list changes OR you ship a new icon set.
// Users get the new assets on their NEXT page load after the SW
// activates (we skipWaiting so activation is immediate).

const CACHE_VERSION = "v1";
const CACHE_NAME = `matchday-static-${CACHE_VERSION}`;

// Static assets to precache on install. Same-origin, GET-safe,
// stable URLs. Keep this list tight — fonts come from Google's
// CDN (cross-origin, handled by the browser's HTTP cache) and
// don't belong here.
const PRECACHE_URLS = [
  "/manifest.json",
  "/icons/apple-touch-icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/matchday-badge.svg",
  "/matchday-logo.png",
];

// Install: open the named cache and stuff the precache list into
// it. Each addAll is atomic — if any one URL fails the whole
// install fails and the SW doesn't activate. That's fine; the
// fallback is the network direct.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  // Take over without waiting for old SW (if any) to release
  // control. Phase 1 ships clean; this matters once we're on v2+.
  self.skipWaiting();
});

// Activate: nuke any old cache versions and claim open clients.
// Clients claim avoids the "first page after update still uses
// the old SW" gotcha.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("matchday-static-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

// Fetch handler. Strategy:
//   1. Only intercept same-origin GETs. Cross-origin (fonts,
//      Firestore, Supabase realtime, Vercel analytics) → pass
//      through with no handling.
//   2. Skip /api/* and /_next/* explicitly. Those are dynamic.
//   3. If the URL is in our precache list → cache-first. Hit cache,
//      fall back to network on miss.
//   4. Otherwise → pass through to network (default browser).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Same-origin only. Cross-origin requests get default browser
  // handling (HTTP cache, no SW involvement).
  if (url.origin !== self.location.origin) return;

  // Dynamic surfaces — never intercept.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/")) return;

  // HTML route documents — never cache. We want fresh JS bundle
  // references on every navigation. Identifying HTML by the
  // browser's stated Accept header is sufficient here; bypass
  // anything that lists text/html as the primary accept.
  if (req.headers.get("accept")?.includes("text/html")) return;

  // Precache list — cache-first.
  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => cached ?? fetch(req)),
    );
    return;
  }

  // Everything else → default network. No respondWith() call
  // means the browser handles the request normally.
});
