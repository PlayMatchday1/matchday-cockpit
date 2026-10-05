/* The Ads page became Acquisition (Ryan, 2026-10-04). Old links and bookmarks land there. */
import { redirect } from "next/navigation";

export default function LifecycleAdsRedirect() {
  redirect("/lifecycle/acquisition");
}
