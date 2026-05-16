# PWA install + service-worker ops

The Cockpit ships a minimal Progressive Web App layer so operators
can install it to their iPhone home screen and launch it full-
screen, with brand chrome and a service-worker-backed static asset
cache. This doc covers installation, local testing, and how to
invalidate caches when something needs to change for everyone.

## Installing on iPhone (operator-facing)

1. Open Safari on iPhone and go to **matchday-clubhouse.vercel.app**.
2. Sign in. The Cockpit shows a deep-green "Install MatchDay" banner
   at the bottom of the screen on first visit.
3. Tap **How** to see the three steps, or follow them directly:
   - Tap the **Share** button (square with up-arrow, bottom toolbar).
   - Scroll and tap **Add to Home Screen**.
   - Tap **Add** in the top right.
4. MatchDay appears on the home screen with the green-bg badge icon.
   Launching it shows the app full-screen with no Safari URL bar.

The banner remembers a dismissal: tapping **Not now** or **Done**
writes a localStorage flag so it doesn't reappear. Clearing site
data resets that flag.

## What's installed

- **Manifest**: `/manifest.json` — name, theme/background colors,
  icon set, `start_url: /chats`, `display: standalone`,
  `orientation: portrait`.
- **iOS meta tags** in the root layout: apple-touch-icon at 180×180,
  `apple-mobile-web-app-capable=yes`, status bar style
  `black-translucent` (so the dark-green TopNav extends up under
  the iPhone status bar area).
- **Service worker**: `/sw.js` — cache-first for the small precache
  list (manifest, brand icons, the SVG badge, the logo PNG). Skips
  caching for `/api/*`, `/_next/*`, HTML route documents, and any
  cross-origin request.

## Testing locally

Service workers refuse to register outside a secure context. Two
ways to test:

- `npm run dev` + Chrome devtools → Application tab. Localhost is
  treated as secure, so the SW registers. **But:** the SW
  registration is gated on `NODE_ENV === "production"`, so `dev`
  won't actually wire it up. To test the SW locally, run
  `npm run build && npm run start` and visit `http://localhost:3000`.
- A Vercel preview deploy (HTTPS by default) is the easiest path for
  end-to-end testing without a production build locally.

To see the iOS home-screen install on a real iPhone before a prod
deploy, push to a feature branch — Vercel auto-creates an HTTPS
preview URL that iOS Safari treats as a valid PWA target.

## Invalidating the cache for everyone

The service worker uses a versioned cache name
(`matchday-static-${CACHE_VERSION}`). When you ship a new precache
list (e.g. new icons, new SVG badge) and want every operator to
fetch the new asset:

1. Open `public/sw.js`.
2. Bump `CACHE_VERSION` (e.g. `"v1"` → `"v2"`).
3. Ship the change.

On the next page load after the new SW activates, the old cache
is deleted in the `activate` event and the new one is populated.
Operators don't need to manually refresh or reinstall the PWA;
`self.skipWaiting()` + `clients.claim()` make the swap immediate.

If you ever need to wipe a single user's cache (e.g. they're stuck
on a stale asset and can't wait for the next deploy):

- iPhone: Settings → Safari → Clear History and Website Data.
- Desktop Chrome: DevTools → Application → Service Workers →
  Unregister, then Application → Storage → Clear site data.

## Future enhancements deferred from Phase 1

These are intentionally not in the Phase 1 PR. Listed here so we
don't lose track:

- **iPad icon sizes** (152×152, 167×167). Phase 1 scope is iPhone-
  only; Safari falls back to the 180×180 on iPad and renders
  acceptably. Add if iPad operators show up.
- **Dedicated maskable 512 icon**. The existing 512 is referenced
  with `purpose: "any maskable"` but it isn't padded for the
  Android adaptive-icon circle. **Android may clip the brand mark**
  until we generate a properly-padded variant (transparent
  background, ~80% safe area). Iconography polish for a future
  pass.
- **Offline support beyond static assets**. The current SW
  deliberately doesn't cache API responses or HTML routes — that
  would freeze the UI on stale data and break realtime updates.
  Adding a smart offline mode (e.g. read-only access to the most
  recently viewed thread) is a Phase 4-or-later thing.

## Roadmap

- ✅ **Phase 1** — installable shell (this doc).
- ⏳ **Phase 2** — web-push subscription: VAPID key, `/api/push/subscribe`
  endpoint, Supabase table for stored subscriptions, a toggle in the
  Cockpit UI for operators to opt in.
- ⏳ **Phase 3** — push dispatch: the WhatsApp + SMS inbound webhooks
  fire push notifications to subscribed operators, with smart-
  muting (don't push for messages on threads the operator
  authored most recently) and city-scoped routing.
- ⏳ **Phase 4** — mobile UI polish on `/chats` (the deferred work
  flagged across prior PRs).
