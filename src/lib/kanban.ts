// Shared kanban model for the Clubhouse boards (Field Pipeline +
// Tech Roadmap). One data shape, one engine — the board_type
// discriminator plus per-board config drives everything. Board-
// specific fields live in card.data (jsonb): Field Pipeline carries
// { city, owner_label }, Tech Roadmap carries
// { description, priority, planned_date, estimated_hours }.

import { KNOWN_CITY_CODES } from "./cityNormalization";
import { CITY_COLORS } from "./cityColors";

export type BoardType = "field_pipeline" | "tech_roadmap";

// The Tech Roadmap is split into two boards (App + Clubhouse) via the `board`
// discriminator (migration 0090); Field Pipeline ignores it. Optional so the
// type stays valid pre-migration.
export type RoadmapBoard = "app" | "clubhouse";

export type KanbanCard = {
  id: string;
  board_type: BoardType;
  board?: RoadmapBoard;
  title: string;
  stage: string;
  owner_user_id: string | null;
  sort_order: number;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Present only after the stage_entered_at migration is applied. Until then the
  // column doesn't exist and this is undefined; the age helper falls back to an
  // updated_at lower bound. useKanbanBoard selects "*", so it appears
  // automatically once the migration lands — no client change needed.
  stage_entered_at?: string | null;
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

// ── ordering cards inside one column ───────────────────────────────────────
// Both boards order a column the same way, so the maths lives here once and
// KanbanBoard (Field Pipeline) and RoadmapView (Tech Roadmap) both read it.

// The minimum a card needs to be placed. Kept narrow so the ordering maths can
// be exercised without building a whole card.
export type Orderable = { id: string; sort_order: number };

// The order a column renders in.
//
// Both tiebreaks are load-bearing, not decoration. sort_order is
// `double precision NOT NULL DEFAULT 0` (migration 0066), so any two rows that
// were never explicitly ordered are both 0; and the Clubhouse seed insert
// (migration 0090) wrote several rows in one statement, giving them the SAME
// created_at to the microsecond — so created_at alone cannot separate those.
// id is the final tiebreak, which is what makes this a TOTAL order: the same
// list on every load, whatever order Postgres happens to hand the rows back in.
// An order that reshuffles on reload is worse than no order at all.
export function compareBoardOrder(
  a: { sort_order: number; created_at?: string; id: string },
  b: { sort_order: number; created_at?: string; id: string },
): number {
  return (
    (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
    (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
    a.id.localeCompare(b.id)
  );
}

// Where a card lands when it is dropped ahead of `beforeId`. `siblings` is the
// target column, already in compareBoardOrder order, with the moving card
// REMOVED. `beforeId` null — or naming a card that is not in `siblings` — means
// append to the end.
//
// The midpoint between the two neighbours is the whole point: a move writes ONE
// row. Renumbering the column would write every row in it, and the audit
// trigger (migration 0066) deliberately files no audit row for a pure
// sort_order change — so a renumber would be a silent N-row write on every
// drag. sort_order is `double precision`, so the midpoint is exact for the ~50
// successive halvings of one gap it takes to exhaust a double; past that the
// two neighbours tie and compareBoardOrder's created_at/id tiebreak still
// yields a stable order rather than a shuffling one.
//
// The `0` seed on the max is deliberate and harmless: a column whose every
// sort_order is negative appends at 1, which is still after all of them.
export function sortOrderForDrop(
  siblings: Orderable[],
  beforeId: string | null,
): number {
  const append = () =>
    siblings.reduce((m, c) => Math.max(m, c.sort_order), 0) + 1;
  if (!beforeId) return append();
  const idx = siblings.findIndex((c) => c.id === beforeId);
  if (idx === -1) return append();
  const before = siblings[idx];
  const prev = siblings[idx - 1];
  return prev
    ? (prev.sort_order + before.sort_order) / 2
    : before.sort_order - 1;
}

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

// ---------------- stage age (Field Pipeline) ----------------
//
// Thresholds from the mockup. Aging applies ONLY to the pre-commitment stages;
// a Confirmed or Archived field is a settled state, not something going stale.
export const AGE_WARN_DAYS = 21;
export const AGE_CRIT_DAYS = 45;
const STAGES_THAT_AGE = new Set(["backlog", "contacted", "negotiation"]);

// One source of truth for "how long has this card sat in its stage", returning
// {days, exact}. EXACT when the row records when it entered the stage
// (stage_entered_at, once the migration lands). Otherwise a TRUE LOWER BOUND
// from updated_at: that column is maintained by a BEFORE UPDATE trigger
// (migration 0066), so it moved when stage last changed and only ever moved
// later — (now - updated_at) can under-report time in stage but never
// over-report it. The UI shows "≥ Nd" for the bound and "Nd" for the exact
// value, and reads only this function — never branch on the source elsewhere.
export function stageAge(
  card: Pick<KanbanCard, "stage" | "updated_at" | "stage_entered_at">,
  nowMs: number = Date.now(),
): { days: number; exact: boolean } | null {
  if (!STAGES_THAT_AGE.has(card.stage)) return null;
  const src = card.stage_entered_at ?? null;
  if (src) {
    const days = Math.floor((nowMs - new Date(src).getTime()) / 86_400_000);
    return { days: Math.max(0, days), exact: true };
  }
  if (!card.updated_at) return null;
  const days = Math.floor((nowMs - new Date(card.updated_at).getTime()) / 86_400_000);
  return { days: Math.max(0, days), exact: false };
}

export function ageBand(days: number): "warn" | "crit" | null {
  if (days >= AGE_CRIT_DAYS) return "crit";
  if (days >= AGE_WARN_DAYS) return "warn";
  return null;
}

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
  WAW: "Warsaw",
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
