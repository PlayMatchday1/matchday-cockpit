// Shared kanban model for the Clubhouse boards (Field Pipeline +
// Tech Roadmap). One data shape, one engine — the board_type
// discriminator plus per-board config drives everything. Board-
// specific fields live in card.data (jsonb): Field Pipeline carries
// { city, owner_label }, Tech Roadmap carries
// { description, priority, planned_date, estimated_hours }.

import { KNOWN_CITY_CODES } from "./cityNormalization";
import { CITY_COLORS } from "./cityColors";

export type BoardType = "field_pipeline" | "tech_roadmap";

export type KanbanCard = {
  id: string;
  board_type: BoardType;
  title: string;
  stage: string;
  owner_user_id: string | null;
  sort_order: number;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ChecklistItem = {
  id: string;
  card_id: string;
  text: string;
  done: boolean;
  owner_user_id: string | null;
  sort_order: number;
};

export type KanbanOwner = {
  id: string;
  email: string;
  full_name: string | null;
};

export type StageDef = {
  id: string;
  title: string;
  note?: string;
  // Field Pipeline's Confirmed + Archived render as collapsible
  // per-city accordion groups (matching the ops prototype).
  grouped?: boolean;
};

export type BoardConfig = {
  boardType: BoardType;
  title: string;
  subtitle: string;
  stages: StageDef[];
  showChecklists: boolean;
  showCity: boolean;
  minColWidthPx: number;
};

// ---------------- stage definitions ----------------

export const FIELD_PIPELINE_STAGES: StageDef[] = [
  { id: "backlog", title: "Field Backlog", note: "Target fields pending outreach" },
  { id: "contacted", title: "Contacted", note: "Initial outreach made" },
  { id: "negotiation", title: "Ongoing Negotiation", note: "Active discussion" },
  { id: "confirmed", title: "Confirmed Fields", note: "Confirmed and added to slate", grouped: true },
  { id: "archived", title: "Archived Fields", note: "Previous field partners", grouped: true },
];

export const TECH_ROADMAP_STAGES: StageDef[] = [
  { id: "ideas", title: "Ideas" },
  { id: "in_plan", title: "In Plan" },
  { id: "in_progress", title: "In Progress" },
  { id: "shipped", title: "Shipped" },
];

export const BOARD_CONFIG: Record<BoardType, BoardConfig> = {
  field_pipeline: {
    boardType: "field_pipeline",
    title: "Field Pipeline",
    subtitle:
      "Track fields by lifecycle stage, color-coded by city and assigned to owners.",
    stages: FIELD_PIPELINE_STAGES,
    showChecklists: true,
    showCity: true,
    minColWidthPx: 270,
  },
  tech_roadmap: {
    boardType: "tech_roadmap",
    title: "Tech Roadmap",
    subtitle: "Track product and engineering work from idea to shipped.",
    stages: TECH_ROADMAP_STAGES,
    showChecklists: false,
    showCity: false,
    minColWidthPx: 280,
  },
};

// ---------------- cities (Field Pipeline) ----------------

// The 8 canonical markets plus a "New Market" escape hatch for
// exploration cities. Known codes color-code from the cross-cockpit
// palette; exploration markets carry their own name and share one
// neutral accent.
export const FIELD_CITY_CODES: readonly string[] = [...KNOWN_CITY_CODES];

export const NEW_MARKET_SENTINEL = "__new_market__";
export const NEW_MARKET_COLOR = "#64748b"; // slate — clearly "off-list"

const CITY_DISPLAY: Record<string, string> = {
  ATX: "Austin",
  ATL: "Atlanta",
  DFW: "Dallas",
  HOU: "Houston",
  OKC: "Oklahoma City",
  SATX: "San Antonio",
  STL: "St. Louis",
  ELP: "El Paso",
};

export function isKnownCity(city: string): boolean {
  return Object.prototype.hasOwnProperty.call(CITY_DISPLAY, city);
}

export function cityLabel(city: string | null | undefined): string {
  if (!city) return "No city";
  return CITY_DISPLAY[city] ?? city; // exploration markets show their name
}

export function cityColor(city: string | null | undefined): string {
  if (!city) return NEW_MARKET_COLOR;
  return CITY_COLORS[city] ?? NEW_MARKET_COLOR;
}

export function cardCity(card: KanbanCard): string | null {
  const c = card.data?.city;
  return typeof c === "string" && c.length > 0 ? c : null;
}

// ---------------- priority (Tech Roadmap) ----------------

export const PRIORITIES = ["High", "Medium", "Low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function cardPriority(card: KanbanCard): Priority | null {
  const p = card.data?.priority;
  return p === "High" || p === "Medium" || p === "Low" ? p : null;
}

export function cardDescription(card: KanbanCard): string {
  const d = card.data?.description;
  return typeof d === "string" ? d : "";
}

export function cardPlannedDate(card: KanbanCard): string {
  const d = card.data?.planned_date;
  return typeof d === "string" ? d : "";
}

// ---------------- estimated hours (Tech Roadmap) ----------------
// Optional numeric estimate stored in data.estimated_hours (0.5-step
// half-hour increments allowed). Absent/invalid -> null.
export function cardEstimatedHours(card: KanbanCard): number | null {
  const h = card.data?.estimated_hours;
  return typeof h === "number" && Number.isFinite(h) && h >= 0 ? h : null;
}

// "8h" / "1.5h" — JS renders 8, 1.5, 0.5 without trailing zeros.
export function formatHours(h: number): string {
  return `${h}h`;
}

// Parse the Estimated-hours modal input: "" -> null (clears the field),
// a valid non-negative number -> that number, anything else -> null.
export function parseEstimatedHours(input: string): number | null {
  const t = input.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Owner-label fallback: seed cards whose owner name did not match an
// app_user keep the original name here so the card still shows who
// owns it (rendered visibly "unlinked" in the UI).
export function cardOwnerLabel(card: KanbanCard): string {
  const l = card.data?.owner_label;
  return typeof l === "string" ? l : "";
}

// ---------------- owner display ----------------

export function ownerName(owner: KanbanOwner | null | undefined): string {
  if (!owner) return "";
  const full = owner.full_name?.trim();
  if (full) return full;
  return owner.email.split("@")[0];
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
