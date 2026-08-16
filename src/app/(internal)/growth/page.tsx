import { redirect } from "next/navigation";

// /growth is the Player Funnel — the first step of the journey the section walks. A redirect
// rather than a duplicate render, so there is one implementation of that page.
export default function GrowthPage() {
  redirect("/growth/funnel");
}
