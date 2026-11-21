"use client";

/* FREE FIRST MATCH — is giving the first match away worth it (app 1.89, live since 2026-11-05). Redesign
 * 2026-11-21, Figma 9TgSk4sYqq4nNoTH73wRRs frame 21615:72. No period bar and needsGrowthData false: the
 * page owns its range and city pickers (in the title row) and reads only /api/lifecycle/free-first-match. */

import { useState } from "react";
import FreeFirstMatchView, { FreeFirstMatchControls, FreeFirstMatchInfo, type Preset } from "@/components/growth/FreeFirstMatchView";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleFreeFirstMatchPage() {
  const g = useGrowth();
  const [preset, setPreset] = useState<Preset>("launch");
  const [city, setCity] = useState("");
  const [cities, setCities] = useState<{ code: string; name: string }[]>([]);
  return (
    <SectionFrame
      title="Free First Match"
      subtitle="Is giving the first match away worth it? Live since Nov 5. Compared with the same number of days before."
      period={false}
      needsGrowthData={false}
      titleTestId="ffm-title"
      titleAccessory={<>
        <FreeFirstMatchInfo />
        <FreeFirstMatchControls preset={preset} setPreset={setPreset} city={city} setCity={setCity} cities={cities} />
      </>}
    >
      <FreeFirstMatchView authHeaders={g.authHeaders} preset={preset} city={city} onCities={setCities} />
    </SectionFrame>
  );
}
