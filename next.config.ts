import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow an isolated build dir (NEXT_DIST_DIR) so a verification build (e.g. the seam-stripped
  // proof in scripts/seam-stripped-test.ts) can run without clobbering a running `next dev` .next.
  // Defaults to ".next" — production/Vercel builds are unaffected.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Build stamp — so "is this deployed?" is one glance, not a diagnostic round.
  // VERCEL_GIT_COMMIT_SHA is set by Vercel at build time from the deployed commit;
  // the build time is stamped when this config evaluates (i.e. during the build).
  // Inlined into the client bundle as NEXT_PUBLIC_* and rendered in the account menu.
  env: {
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  // Redirects: legacy upload route folded into /data on 2026-05-05.
  // Permanent so any bookmarks / external references update.
  async redirects() {
    return [
      // FIELD RANKING WAS REMOVED (2026-08-19) — Cost's Field Economics now carries what it
      // showed, so the page repeated a view rather than adding one. `permanent: true` is a 308, so
      // a bookmark lands on Cost instead of a 404.
      {
        source: "/admin/finance/field-ranking",
        destination: "/admin/finance/cost",
        permanent: true,
      },
      // FIELD PIPELINE MOVED OUT OF MATCH OPS to /growth/field-pipeline (2026-08-23). It was the
      // only Match Ops item gated on `tech` rather than `matchops`. 308 so the bookmark and the
      // rail history land on it. NOTE the ordering below: this must not be confused with the
      // /growth → /lifecycle rules, which are enumerated precisely so /growth/field-pipeline is
      // left alone.
      {
        source: "/match-ops/field-pipeline",
        destination: "/growth/field-pipeline",
        permanent: true,
      },
      // ═══ THE PLAYER LIFECYCLE SECTION MOVED: /growth → /lifecycle (2026-08-23) ═══════════════
      //
      // THESE ARE ENUMERATED, NOT A WILDCARD, AND THAT IS THE WHOLE POINT. `/growth/:path*` is one
      // line and it would make the incoming top-level GROWTH TAB unreachable the day it ships:
      // every request to /growth/field-pipeline or /growth/city-launches would 308 into a section
      // that has no such page. Only the paths that existed under /growth are listed, so /growth
      // stays available for its new occupant. Adding a report to Player Lifecycle means adding a
      // line here — verify-lifecycle-rename asserts every one of them, and asserts that an
      // unlisted path is NOT swallowed.
      {
        source: "/growth/:section(funnel|behavior|revenue-per-player|retention|churn|data-room)",
        destination: "/lifecycle/:section",
        permanent: true,
      },
      // The per-city detail pages. The slugs are citySlug() over CITIES (src/lib/types.ts) — the
      // same closed set cityFromSlug() resolves, so this cannot widen to an arbitrary segment.
      {
        source: "/growth/:city(austin|dallas|houston|san-antonio|atlanta|st-louis|okc|el-paso)",
        destination: "/lifecycle/:city",
        permanent: true,
      },
      // THE BARE-ROOT REDIRECT IS GONE, as its own comment said it must be. /growth was Player
      // Lifecycle's landing until 2026-08-23 and 308'd to /lifecycle/funnel; it is now the Growth
      // tab's own page (src/app/(internal)/growth/page.tsx). DELETED, not repointed — repointing
      // would have made the tab unreachable. The fourteen enumerated /growth/<report> and
      // /growth/<city> rules above stay forever, which is the whole reason they were enumerated.
      // Cities section renamed, route moved /cities → /growth on 2026-07-31 and → /lifecycle on
      // 2026-08-23. Pointed STRAIGHT at /lifecycle rather than chaining through /growth: once the
      // Growth tab takes that path, a chained redirect would land a /cities bookmark on a
      // different section entirely. The /api/cities/* endpoints, city/cities data columns, and
      // ?tab= lens values keep their names — only the user-facing section route moved.
      {
        source: "/cities",
        destination: "/lifecycle/funnel",
        permanent: true,
      },
      {
        source: "/cities/:path*",
        destination: "/lifecycle/:path*",
        permanent: true,
      },
      // Clubhouse tab renamed to Home and its route moved /clubhouse → /home
      // on 2026-07-31. Permanent so bookmarks to the old path don't 404. The
      // can_access_clubhouse permission key and clubhouseQuarter context keep
      // their names — only the user-facing route moved.
      {
        source: "/clubhouse",
        destination: "/home",
        permanent: true,
      },
      {
        source: "/admin/finance/upload",
        destination: "/data",
        permanent: true,
      },
      // Match Manager Pay consolidated into the public /managers page
      // on 2026-05-11. Old admin tab + any legacy URL bookmarks
      // redirect there.
      {
        source: "/finance/match-managers",
        destination: "/managers",
        permanent: true,
      },
      {
        source: "/admin/finance/match-managers",
        destination: "/managers",
        permanent: true,
      },
      // Manager Pay moved out of the public /managers page (and the Finance
      // Configure tab) into Match Ops on 2026-08-01 — same data, same pay math,
      // new home. 308 (permanent) so bookmarks to /managers survive. The old
      // /finance/match-managers + /admin/finance/match-managers redirects above
      // still point at /managers, so they chain here — kept intentionally.
      // City Manager Check-Ins moved to Match Ops › Back Office › People. It was never a route
      // under Finance (it was in-page tab state, then an overlay), so this is belt-and-braces for
      // anything that guessed the URL rather than a bookmark we know exists.
      {
        source: "/admin/finance/check-ins",
        destination: "/match-ops/check-ins",
        permanent: true,
      },
      {
        source: "/managers",
        destination: "/match-ops/manager-pay",
        permanent: true,
      },
      // Partner Dashboards moved out of Finance into Match Ops on 2026-08-02.
      // The old Finance secondary-nav tab (?tab=partner-dashboards) and the
      // per-partner detail route both land on the new unified index. 308 so
      // bookmarks survive.
      {
        source: "/admin/finance/partners/:id*",
        destination: "/match-ops/partner-dashboards",
        permanent: true,
      },
      {
        source: "/admin/finance",
        has: [{ type: "query", key: "tab", value: "partner-dashboards" }],
        destination: "/match-ops/partner-dashboards",
        permanent: true,
      },
      // Player Chat page moved from /crm → /chats on 2026-05-16
      // (UI label was already "Chats"; the URL was the last
      // mismatch). The /api/crm/* API routes and the underlying
      // crm_* DB tables are NOT renamed — only the user-facing
      // page route.
      {
        source: "/crm",
        destination: "/match-ops/match-chats",
        permanent: true,
      },
      // Chats split into /match-ops/match-chats + /match-ops/player-chats on
      // 2026-07-31 (the rail is the toggle now). The old single "chats" entries
      // default to Match Chats; Player Chats is reached via the rail. /api/crm/*
      // routes and crm_* tables keep their names.
      {
        source: "/chats",
        destination: "/match-ops/match-chats",
        permanent: true,
      },
      {
        source: "/match-ops/chats",
        destination: "/match-ops/match-chats",
        permanent: true,
      },
      // Match Chats page moved /match-chats → /match-ops/match-chats.
      {
        source: "/match-chats",
        destination: "/match-ops/match-chats",
        permanent: true,
      },
      {
        source: "/match-chats/:path*",
        destination: "/match-ops/match-chats/:path*",
        permanent: true,
      },
      // Master Schedule + Field Ops lenses moved out of the Growth page to
      // Match Ops. The old ?tab= deep links redirect (unmatched query like
      // ?fo=veo passes through automatically).
      {
        source: "/growth",
        has: [{ type: "query", key: "tab", value: "master-schedule" }],
        destination: "/match-ops/master-schedule",
        permanent: true,
      },
      {
        source: "/growth",
        has: [{ type: "query", key: "tab", value: "fields" }],
        destination: "/match-ops/field-ops",
        permanent: true,
      },
      // Reviews consolidated out of Growth → Cities into Match Ops on
      // 2026-08-01 (was split across Match Review / Performance / Leaderboard
      // sub-tabs). Old deep link redirects so bookmarks survive.
      {
        source: "/growth",
        has: [{ type: "query", key: "tab", value: "reviews" }],
        destination: "/match-ops/reviews",
        permanent: true,
      },
      // Membership moved out of the Growth lens to its own top-level tab on
      // 2026-08-02. Old ?tab=membership deep links (incl. ?month=) redirect.
      {
        source: "/growth",
        has: [{ type: "query", key: "tab", value: "membership" }],
        destination: "/membership",
        permanent: true,
      },
      // Slate Review moved out of Finance into Match Ops on 2026-08-02, and the
      // standalone Match P&L tab was absorbed into it. Both old Finance deep
      // links redirect to the new page.
      {
        source: "/admin/finance",
        has: [{ type: "query", key: "tab", value: "slate-review" }],
        destination: "/match-ops/slate-review",
        permanent: true,
      },
      {
        source: "/admin/finance",
        has: [{ type: "query", key: "tab", value: "match-pnl" }],
        destination: "/match-ops/slate-review",
        permanent: true,
      },
      // Field Ops ?fo= deep links (inventory / veo / community / fields) are
      // redirected in src/proxy.ts, which can strip the fo param cleanly — a
      // config redirect here would pass ?fo= through and loop on fo=fields.
      // Veo review queue + field-code editor moved from /admin/veo to
      // Cities → Field Ops → Veo on 2026-07-26. Routing-layer redirect (real
      // 307) so bookmarks land on the tab regardless of the (internal) client
      // layout — a page-level redirect() there resolves client-side, not as an
      // HTTP redirect. Temporary (permanent:false) so browsers don't hard-cache
      // the tab URL. The /admin/veo page.tsx stays as a fallback.
      {
        source: "/admin/veo",
        destination: "/match-ops/field-ops?fo=veo",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
