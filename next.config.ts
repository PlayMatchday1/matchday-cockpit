import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Redirects: legacy upload route folded into /data on 2026-05-05.
  // Permanent so any bookmarks / external references update.
  async redirects() {
    return [
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
    ];
  },
};

export default nextConfig;
