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
    ];
  },
};

export default nextConfig;
