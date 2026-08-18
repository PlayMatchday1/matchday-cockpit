"use client";

// Field Costs — moved out of the Configure overlay into its own route. It was reachable only by
// opening a strip that replaced whichever section you were on; the rail names it directly now.
// Same component, unchanged.
import FieldCostsView from "@/components/FieldCostsView";

export default function Page() {
  return <FieldCostsView />;
}
