import type { Metadata } from "next";
import ApplicationsView from "@/components/ApplicationsView";

export const metadata: Metadata = { title: "Applications — Clubhouse" };

export default function Page() {
  return <ApplicationsView />;
}
