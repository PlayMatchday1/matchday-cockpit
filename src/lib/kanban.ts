// Shared kanban model for the Clubhouse boards (Field Pipeline +
// Tech Roadmap). One data shape, one engine — the board_type
// discriminator plus per-board config drives everything. Board-
// specific fields live in card.data (jsonb): Field Pipeline carries
// { city, owner_label }, Tech Roadmap carries
// { description, priority, planned_date, estimated_hours }.

import { KNOWN_CITY_CODES } from "./cityNormalization";
import { CITY_COLORS } from "./cityColors";

export type BoardType = "field_pipeline" | "tech_roadmap" | "vc_outreach";

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
  /* THE fin_venues ROW THIS CARD IS ABOUT — migration 0172, and null until a person binds it.
   *
   * A card titled "Crossbar Rowlett" and the fin_venues row for Crossbar Rowlett were two
   * unrelated records sharing a string; this is the link. It is NULLABLE because every card
   * already sitting in Confirmed starts unbound and a migration cannot invent the link, and it is
   * ALWAYS NULL ON THE VC BOARD, which shares this table and has no fields.
   *
   * launch_date IS NOT HERE. It lives on fin_venues, which is the point: Finance and Growth read
   * one column. Copying it onto the card would make two homes for one fact. */
  venue_id?: number | null;
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
  /* WHAT THE CHECKLIST IS CALLED HERE. Ryan's word for the VC board is "Actions", and the two
   * boards keep their own words on purpose: a field's to-dos are chores against a venue, a firm's
   * actions are the outreach itself. One shared editor, one label per board. */
  checklistLabel?: string;
};

// ---------------- stage definitions ----------------

export const FIELD_PIPELINE_STAGES: StageDef[] = [
  { id: "backlog", title: "Field Backlog", note: "Target fields pending outreach" },
  { id: "contacted", title: "Contacted", note: "Initial outreach made" },
  { id: "negotiation", title: "Ongoing Negotiation", note: "Active discussion" },
  { id: "confirmed", title: "Confirmed Fields", note: "Confirmed and added to slate", grouped: true },
  { id: "archived", title: "Archived Fields", note: "Previous field partners", grouped: true },
];

/* THE VC BOARD'S SEVEN, in the order the source file had them. NO `note` ON ANY OF THEM: the file
 * carried a description per stage ("Ready for an intro or initial email") and it does not come
 * across — a board does not need a legend telling you what "First Meeting Held" means. */
export const VC_OUTREACH_STAGES: StageDef[] = [
  { id: "not_contacted", title: "Not Contacted" },
  { id: "outreach_sent", title: "Initial Outreach Sent" },
  { id: "reply_needed", title: "Reply Received — Action Needed" },
  { id: "engaged", title: "Responded / Scheduling" },
  { id: "first_meeting", title: "First Meeting Held" },
  { id: "second_scheduling", title: "Scheduling Second Meeting" },
  { id: "second_scheduled", title: "Second Meeting Scheduled" },
];

/* ── THE WAVE LABELS ARE NUMBERED BACKWARDS IN THE SOURCE ──────────────────────────────────────
 * "Wave 1 – Low priority" is 55 firms and "Wave 3 – High prioritiy" is 8 — so the low number is
 * the low priority, which reads backwards to anyone who has ever seen a wave 1 go first. Wave 3
 * also carries a typo. Display resolves to High / Medium / Low and the raw string stays in
 * data.wave_raw, so nothing is lost and nothing has to be re-read from a misspelling.
 *
 * HOLD AND EXCLUDE ARE NOT WAVES. The column holds five distinct values, not three: 2 firms are
 * "Hold" and 2 are "Exclude", which are decisions about whether to approach at all rather than
 * when. They keep their own labels rather than being folded into a priority they do not have. */
export const VC_WAVE_LABEL: Record<string, string> = {
  "Wave 3 – High prioritiy": "High",
  "Wave 2 – Medium priority": "Medium",
  "Wave 1 – Low priority": "Low",
  "Hold": "Hold",
  "Exclude": "Exclude",
};
export const vcWaveLabel = (raw: string | null | undefined): string =>
  VC_WAVE_LABEL[String(raw ?? "").trim()] ?? "";

/** A/B/C/D off the first character, the way the source file's fitClass() did. "" when ungraded —
 *  6 of the 90 are blank or "Unknown" and they are not a fifth grade. */
export const vcFitGrade = (raw: string | null | undefined): "A" | "B" | "C" | "D" | "" => {
  const c = String(raw ?? "").trim().charAt(0).toUpperCase();
  return c === "A" || c === "B" || c === "C" || c === "D" ? c : "";
};

/* ── THE VC CARD'S OWN FIELDS ───────────────────────────────────────────────────────────────────
 * The keys are SNAKE_CASE in the row and camelCase in the import file — `fund_focus` here,
 * `fundFocus` there. Measured on all 90 live cards: fit_raw, warm_raw, wave_raw, fund_focus,
 * relationship, owners, contacts, warm_rationale, next_steps, next_step_due, notes,
 * last_touchpoint, source_id, plus the derived fit/warm/wave. Read through these helpers so the
 * modal and the card cannot disagree about which spelling is real.
 *
 * next_steps IS NOT READ HERE ANY MORE. It was free text, empty on all 90 (measured), and the
 * actions list replaces it — two places to write the same thing is how they drift. */
export type VcContact = { name?: string; title?: string; email?: string };
const vcData = (c: Pick<KanbanCard, "data">) => (c.data ?? {}) as Record<string, unknown>;
const vcStr = (v: unknown) => (v == null ? "" : String(v));

export const vcFitRaw = (c: Pick<KanbanCard, "data">) => vcStr(vcData(c).fit_raw);
export const vcFundFocus = (c: Pick<KanbanCard, "data">) => vcStr(vcData(c).fund_focus);
export const vcRelationship = (c: Pick<KanbanCard, "data">) => vcStr(vcData(c).relationship);
export const vcNotes = (c: Pick<KanbanCard, "data">) => vcStr(vcData(c).notes);
export const vcNextStepDue = (c: Pick<KanbanCard, "data">) => vcStr(vcData(c).next_step_due).slice(0, 10);
export const vcOwners = (c: Pick<KanbanCard, "data">): string[] =>
  (Array.isArray(vcData(c).owners) ? (vcData(c).owners as unknown[]) : []).map(vcStr).filter(Boolean);
export const vcContacts = (c: Pick<KanbanCard, "data">): VcContact[] =>
  (Array.isArray(vcData(c).contacts) ? (vcData(c).contacts as VcContact[]) : []).filter(Boolean);

/* THE FIVE FIT OPTIONS, and the fifth is why this list exists. fit_raw holds the source file's own
 * strings ("A – Top firm"), and 6 of 90 are blank or "Unknown" — ungraded. Without a bucket for
 * ungraded, a select would have to invent a grade for a firm nobody has graded, and the board's
 * A/B/C/D chips (13+21+27+23 = 84) would never sum to All (90). Ungraded writes "", which is what
 * vcFitGrade already reads as no grade.
 * NOTE: "Unknown" is folded into Ungraded on save — the two mean the same thing and only a save
 * rewrites it. The BOARD'S chips are untouched by this build; adding an Ungraded chip there is the
 * add-firm brief's business, and this one must not change the filters. */
/* THE LABELS CARRY THE WORDS, as the mock's select does — "A" alone is a letter, "A — Top firm" is
 * the grade the source file actually meant. The VALUES are the stored strings verbatim, EN DASH and
 * all, so a save cannot quietly re-spell what 87 rows already hold. */
export const VC_FIT_OPTIONS: readonly { label: string; value: string }[] = [
  { label: "A — Top firm", value: "A – Top firm" },
  { label: "B — Strong firm", value: "B – Strong firm" },
  { label: "C — Opportunistic", value: "C – Opportunistic" },
  { label: "D — Unlikely fit", value: "D – Unlikely fit" },
  { label: "Ungraded", value: "" },
];

/** The stored fit_raw, matched to one of the five options — "" for blank, "Unknown" and anything
 *  else that does not start with a grade letter. */
export const vcFitOptionValue = (raw: string | null | undefined): string => {
  const g = vcFitGrade(raw);
  return g ? (VC_FIT_OPTIONS.find((o) => o.value.startsWith(g))?.value ?? "") : "";
};

/* THE ONE WORD THE BLURB CARRIED THAT YOU SCAN BY. 62 of 90 fund_focus values open with an
 * ALL-CAPS category ("SPORTS. Spun out of…"), so it comes back as a chip and the other 28 show
 * NOTHING rather than a placeholder. The token must be capitals and the run must end at a full
 * stop, or "AUSTIN seed fund" would become a category it is not. */
export const vcFocusCategory = (raw: string | null | undefined): string => {
  const m = /^([A-Z][A-Z&/ -]{1,18})\./.exec(String(raw ?? "").trim());
  return m ? m[1].trim() : "";
};

/* DUE, IN THE WORDS THE MOCK USES, and `late` is a separate flag so the colour can differ as well
 * as the wording — a date that reads "3d overdue" in the same grey as "due Sep 12" is a date
 * nobody sees. Compared as WALL-CLOCK DAYS in the viewer's zone: a due date is a day, not an
 * instant, so it is parsed at noon to keep it away from either midnight. */
export function vcDueChip(iso: string | null | undefined, nowMs: number = Date.now()): { label: string; late: boolean } | null {
  const s = String(iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const due = new Date(`${s}T12:00:00`);
  if (!Number.isFinite(due.getTime())) return null;
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, late: true };
  if (days === 0) return { label: "due today", late: true };
  return { label: `due ${due.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, late: false };
}

/** Warm is a yes/no, and 73 of 90 are "No" — so only a true yes earns a chip. */
export const vcIsWarm = (raw: unknown): boolean => {
  const vals = Array.isArray(raw) ? raw : [raw];
  return vals.some((v) => /^(yes|warm)/i.test(String(v ?? "").trim()));
};

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

/* ── AGING IS PER BOARD, AND FIELD PIPELINE'S IS THE DEFAULT ────────────────────────────────────
 * STAGES_THAT_AGE holds Field Pipeline's stage ids, so stageAge() returned null for every VC stage.
 * Rather than widen that set — which would age Field Pipeline stages it deliberately does not age —
 * each board brings its own stages and thresholds, and the parameter DEFAULTS to field_pipeline.
 * Its two callers (FieldPipelineBoard :520-521) pass nothing and are unchanged by construction.
 *
 * VC: every stage EXCEPT not_contacted. All 90 firms are in not_contacted with the same
 * stage_entered_at (the import, 2026-09-11), so an age there would be one number on ninety cards,
 * which is not information. Thresholds 14/30 from the mock rather than Field Pipeline's 21/45: a
 * fund that has not replied in two weeks is late in a way a field in negotiation is not.
 *
 * `reply_needed` is NOT given a tighter band of its own, though the brief argues for one. One band
 * pair per board is a thing a person can hold; per-stage bands would be a second concept, and
 * nobody has used the first one on this board yet. Worth revisiting once they have. */
const BOARD_AGING: Record<BoardType, { stages: ReadonlySet<string>; warn: number; crit: number }> = {
  field_pipeline: { stages: STAGES_THAT_AGE, warn: AGE_WARN_DAYS, crit: AGE_CRIT_DAYS },
  vc_outreach: {
    stages: new Set(["outreach_sent", "reply_needed", "engaged", "first_meeting", "second_scheduling", "second_scheduled"]),
    warn: 14,
    crit: 30,
  },
  tech_roadmap: { stages: new Set<string>(), warn: AGE_WARN_DAYS, crit: AGE_CRIT_DAYS },
};

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
  boardType: BoardType = "field_pipeline",
): { days: number; exact: boolean } | null {
  if (!BOARD_AGING[boardType].stages.has(card.stage)) return null;
  const src = card.stage_entered_at ?? null;
  if (src) {
    const days = Math.floor((nowMs - new Date(src).getTime()) / 86_400_000);
    return { days: Math.max(0, days), exact: true };
  }
  if (!card.updated_at) return null;
  const days = Math.floor((nowMs - new Date(card.updated_at).getTime()) / 86_400_000);
  return { days: Math.max(0, days), exact: false };
}

export function ageBand(days: number, boardType: BoardType = "field_pipeline"): "warn" | "crit" | null {
  const { warn, crit } = BOARD_AGING[boardType];
  if (days >= crit) return "crit";
  if (days >= warn) return "warn";
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
  vc_outreach: {
    boardType: "vc_outreach",
    title: "VC Outreach",
    subtitle: "",
    stages: VC_OUTREACH_STAGES,
    /* ON, AND IT REPLACES THE FREE-TEXT NEXT STEP. The original brief deferred this deliberately;
     * this is that second build. The checklist rides on its card in 0166's policy, so turning it on
     * opens no new hole — proven with a confined token rather than assumed. */
    showChecklists: true,
    showCity: false,
    minColWidthPx: 298,
    checklistLabel: "Actions",
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
