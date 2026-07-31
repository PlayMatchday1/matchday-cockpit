import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Redirects: legacy upload route folded into /data on 2026-05-05.
  // Permanent so any bookmarks / external references update.
  async redirects() {
    return [
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
        destination: "/chats",
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
        destination: "/cities?tab=fields&fo=veo",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
