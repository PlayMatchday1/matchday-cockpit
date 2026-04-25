export const CSV_TO_COCKPIT_CITY: Record<string, string> = {
  "Dallas / Fort Worth": "Dallas",
  "Oklahoma City": "OKC",
  Austin: "Austin",
  Houston: "Houston",
  "San Antonio": "San Antonio",
  "St. Louis": "St. Louis",
  Atlanta: "Atlanta",
  "El Paso": "El Paso",
};

export function normalizeCity(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return CSV_TO_COCKPIT_CITY[trimmed] ?? null;
}
