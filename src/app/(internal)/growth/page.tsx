import { redirect } from "next/navigation";

// /growth is Field Pipeline — the only Growth page today, and the first step of the work this
// section covers. A redirect rather than a duplicate render, so there is one implementation.
//
// THIS FILE REPLACES A REDIRECT THAT POINTED THE OTHER WAY. Until 2026-08-23 /growth was Player
// Lifecycle's landing and next.config.ts 308'd it to /lifecycle/funnel. That line was deleted in
// the same push that added this file; the fourteen enumerated /growth/<report> and /growth/<city>
// redirects stay, which is why they were enumerated rather than wildcarded.
export default function GrowthPage() {
  redirect("/growth/field-pipeline");
}
