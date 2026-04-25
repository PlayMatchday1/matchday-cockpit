export const STATUSES = [
  "Not started",
  "On track",
  "In progress",
  "At risk",
  "Done",
] as const;
export type Status = (typeof STATUSES)[number];

export const SCOPES = ["org", "q2", "monthly", "city"] as const;
export type Scope = (typeof SCOPES)[number];

export const CITIES = [
  "Austin",
  "Dallas",
  "Houston",
  "San Antonio",
  "Atlanta",
  "St. Louis",
  "OKC",
  "El Paso",
] as const;
export type City = (typeof CITIES)[number];

export type CityHealth = "Healthy" | "Building" | "At risk";

export const CITY_STATS: Record<
  City,
  { venues: number; matchesPerWeek: number; health: CityHealth }
> = {
  Austin: { venues: 6, matchesPerWeek: 38, health: "Healthy" },
  Houston: { venues: 4, matchesPerWeek: 22, health: "At risk" },
  "San Antonio": { venues: 2, matchesPerWeek: 14, health: "Healthy" },
  Dallas: { venues: 3, matchesPerWeek: 9, health: "Building" },
  Atlanta: { venues: 2, matchesPerWeek: 8, health: "Building" },
  "St. Louis": { venues: 2, matchesPerWeek: 7, health: "Building" },
  OKC: { venues: 1, matchesPerWeek: 4, health: "At risk" },
  "El Paso": { venues: 1, matchesPerWeek: 2, health: "Building" },
};

export type Goal = {
  id: string;
  title: string;
  owner: string;
  status: Status;
  progress: number;
  scope: Scope;
  city: City | null;
  sort_order: number | null;
  target_date: string | null;
  last_progress_change_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoalComment = {
  id: string;
  goal_id: string;
  author: string;
  body: string;
  created_at: string;
};

export type Doc = {
  id: string;
  title: string;
  url: string;
  note: string | null;
  added_at: string;
  created_at: string;
};

// URL slug helpers — keep "St. Louis" / "San Antonio" etc. clean in routes.
export function citySlug(city: City): string {
  return city.toLowerCase().replace(/\./g, "").replace(/\s+/g, "-");
}

export function cityFromSlug(slug: string): City | null {
  return CITIES.find((c) => citySlug(c) === slug) ?? null;
}
