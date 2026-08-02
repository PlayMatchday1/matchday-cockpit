// The board is addressable by URL (/tech/tech-roadmap/app|clubhouse) so each
// sidebar item is a real link, the back button works, and a board can be pasted
// into Slack. The bare route redirects to the App board.

import { redirect } from "next/navigation";

export default function TechRoadmapIndex() {
  redirect("/tech/tech-roadmap/app");
}
