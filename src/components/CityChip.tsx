// Soft pastel city chip — same hue as the cross-cockpit per-city
// palette in src/lib/cityColors.ts (used by CitiesUsersLens etc.),
// rendered at 10% alpha so it reads as a pastel pill rather than the
// full saturation of the chart swatches.
//
// `code` may be a canonical city code (ATX, HOU, …) or "Unknown" for
// threads/items with no city association. Falls back to the Unknown
// hue if the code is anything else.

import { colorForCity, UNKNOWN_CITY } from "@/lib/cityColors";

const SIZE_CLASS: Record<"xs" | "sm", string> = {
  xs: "px-1.5 py-0.5 text-[10px]",
  sm: "px-2 py-0.5 text-xs",
};

export default function CityChip({
  code,
  size = "xs",
}: {
  code: string | null | undefined;
  size?: "xs" | "sm";
}) {
  const label = code && code.length > 0 ? code : UNKNOWN_CITY;
  const hex = colorForCity(label);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full font-medium ${SIZE_CLASS[size]}`}
      style={{ backgroundColor: hex + "1a", color: hex }}
      title={`City: ${label}`}
    >
      {label}
    </span>
  );
}
