// One board per URL — /tech/tech-roadmap/app and /tech/tech-roadmap/clubhouse.
// An unknown board redirects to App rather than 404ing a typo'd link. Viewing
// keeps the clubhouse gate; mutations inside RoadmapView are gated on is_admin.

import { redirect } from "next/navigation";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import RoadmapView from "../RoadmapView";
import type { RoadmapBoard } from "@/lib/kanban";

export default async function TechRoadmapBoardPage({
  params,
}: {
  params: Promise<{ board: string }>;
}) {
  const { board } = await params;
  if (board !== "app" && board !== "clubhouse") redirect("/tech/tech-roadmap/app");

  return (
    <PagePermissionGuard page="clubhouse">
      <RoadmapView board={board as RoadmapBoard} />
    </PagePermissionGuard>
  );
}
