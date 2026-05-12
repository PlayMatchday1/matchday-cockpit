export const TOPIC_STATUSES = ["open", "resolved", "archived"] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const TOPIC_STATUS_ORDER: Record<TopicStatus, number> = {
  open: 0,
  resolved: 1,
  archived: 2,
};

export const TOPIC_STATUS_LABEL: Record<TopicStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  archived: "Archived",
};

export const TOPIC_STATUS_PILL: Record<TopicStatus, string> = {
  open: "bg-mint-soft text-deep-green ring-mint/40",
  resolved: "bg-blue-soft text-blue-info ring-blue-info/30",
  archived: "bg-muted-soft text-muted ring-cream-line",
};

// Department categorization. NULL = General/Org-wide (default).
// Schema: topics.department TEXT with CHECK constraint on the
// three values below. NULL is allowed and the default.
export const DEPARTMENTS = ["marketing", "ops", "growth_partnerships"] as const;
export type Department = (typeof DEPARTMENTS)[number];

// Internal key used by lookup tables — "general" is the synthetic
// key for null department, since lookup tables can't be keyed by null.
export type DepartmentKey = Department | "general";

export function deptKey(d: Department | null): DepartmentKey {
  return d ?? "general";
}

export const DEPARTMENT_LABEL: Record<DepartmentKey, string> = {
  general: "General",
  marketing: "Marketing",
  ops: "Ops",
  growth_partnerships: "Growth & Partnerships",
};

// Pill class palette — all four departments use the same treatment:
// light tinted background, deep-green text, colored ring. Consistent
// look-and-feel so the pills read as one component family.
export const DEPARTMENT_PILL_CLASS: Record<DepartmentKey, string> = {
  general: "bg-muted-soft text-deep-green ring-cream-line",
  marketing: "bg-[#D4A017]/15 text-deep-green ring-[#D4A017]/40",
  ops: "bg-[#00E676]/15 text-deep-green ring-[#00E676]/40",
  growth_partnerships: "bg-[#8B5CF6]/15 text-deep-green ring-[#8B5CF6]/40",
};

export type Topic = {
  id: string;
  title: string;
  description: string | null;
  // Legacy free-text tag column. Kept readable during the soak
  // window after the department migration; UI no longer reads or
  // writes it. Schedule a DROP COLUMN follow-up after a week.
  tag: string | null;
  department: Department | null;
  status: TopicStatus;
  sort_order: number | null;
  // QuarterKey shape ("2026Q2"). Added in migration 0028 so topics
  // can be filtered alongside Goals by the Clubhouse quarter
  // selector.
  quarter_key: string;
  created_at: string;
  updated_at: string;
};

export type ActionItem = {
  id: string;
  topic_id: string;
  body: string;
  owner: string | null;
  due_date: string | null;
  is_done: boolean;
  done_at: string | null;
  sort_order: number | null;
  created_at: string;
};

export type TopicComment = {
  id: string;
  topic_id: string;
  author: string | null;
  // author_email is the canonical authorship signal (case-insensitive
  // match against app_users.email). `author` is the display name and
  // can collide; `author_email` is what the edit gate checks against.
  author_email: string | null;
  body: string;
  created_at: string;
  // null on insert, set to now() on edit. UI renders "(edited)" when
  // non-null, no fuzzy timestamp comparisons against created_at.
  updated_at: string | null;
};
