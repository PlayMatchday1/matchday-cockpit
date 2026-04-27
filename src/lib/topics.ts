import { CITIES } from "./types";

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

export const COMMON_TAGS: readonly string[] = ["General", ...CITIES];

export type Topic = {
  id: string;
  title: string;
  description: string | null;
  tag: string | null;
  status: TopicStatus;
  sort_order: number | null;
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
