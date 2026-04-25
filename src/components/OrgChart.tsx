"use client";

import { useOrgDirectory } from "@/lib/useOrgDirectory";
import OrgGroupNode from "./OrgGroupNode";

export default function OrgChart() {
  const dir = useOrgDirectory();

  if (!dir) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading org…
      </div>
    );
  }

  const root = dir.groups.find((g) => g.kind === "org");
  if (!root) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        No org root configured. Run the org seed SQL.
      </div>
    );
  }

  return <OrgGroupNode group={root} dir={dir} />;
}
