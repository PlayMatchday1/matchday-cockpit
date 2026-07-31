import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Redirects: legacy upload route folded into /data on 2026-05-05.
  // Permanent so any bookmarks / external references update.
  async redirects() {
    return [
      // Cities section renamed to Growth; route moved /cities → /growth on
      // 2026-07-31. Permanent so bookmarks/hardcoded links don't 404. The
      // /api/cities/* endpoints, city/cities data columns, and ?tab= lens
      // values keep their names — only the user-facing section route moved.
      {
        source: "/cities",
        destination: "/growth",
        permanent: true,
      },
      {
        source: "/cities/:path*",
        destination: "/growth/:path*",
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
      // First-Match Review moved /admin/first-match-review → /match-ops/review
      // on 2026-07-31 (still AdminGuard-gated). Bookmarks survive.
      {
        source: "/admin/first-match-review",
        destination: "/match-ops/review",
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
