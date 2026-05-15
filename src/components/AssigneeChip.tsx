// Assignee chip — small pill with an initials avatar + the operator's
// first name (or email if no name). Unassigned variant renders as a
// dashed-border muted pill.
//
// Sizes:
//   "sm" — inbox row, dense (h-5)
//   "md" — conversation header, tappable (h-7), used as a dropdown
//          trigger

import type { ReactNode } from "react";

export type Assignee = {
  id: string;
  email: string;
  full_name: string | null;
};

function firstNameOf(a: Assignee): string {
  const full = a.full_name?.trim();
  if (full) {
    const first = full.split(/\s+/)[0];
    if (first) return first;
  }
  // Fall back to the local-part of the email ("rmancuso").
  const at = a.email.indexOf("@");
  return at > 0 ? a.email.slice(0, at) : a.email;
}

function initialsOf(a: Assignee): string {
  const full = a.full_name?.trim();
  if (full) {
    const parts = full.split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    const out = (first + last).toUpperCase();
    if (out) return out;
  }
  // Email fallback: first letter of local-part.
  return a.email.slice(0, 1).toUpperCase();
}

const SIZE: Record<
  "sm" | "md",
  { wrap: string; avatar: string; label: string }
> = {
  sm: {
    wrap: "h-5 pl-0.5 pr-2 text-[10px] gap-1",
    avatar: "h-4 w-4 text-[9px]",
    label: "",
  },
  md: {
    wrap: "h-7 pl-1 pr-2 text-xs gap-1.5",
    avatar: "h-5 w-5 text-[10px]",
    label: "",
  },
};

export default function AssigneeChip({
  assignee,
  size = "sm",
  trailing,
}: {
  assignee: Assignee | null;
  size?: "sm" | "md";
  /** Optional trailing element, e.g. dropdown caret on the md variant. */
  trailing?: ReactNode;
}) {
  const s = SIZE[size];

  if (!assignee) {
    return (
      <span
        className={`inline-flex shrink-0 items-center rounded-full border border-dashed border-muted/60 text-muted ${s.wrap}`}
        title="Unassigned"
      >
        <span
          className={`inline-flex items-center justify-center rounded-full bg-muted-soft text-muted ${s.avatar}`}
          aria-hidden
        >
          ?
        </span>
        <span className={s.label}>Unassigned</span>
        {trailing}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full bg-deep-green-line/40 text-deep-green ${s.wrap}`}
      title={`${assignee.full_name ?? assignee.email}`}
    >
      <span
        className={`inline-flex items-center justify-center rounded-full bg-deep-green text-cream font-bold ${s.avatar}`}
        aria-hidden
      >
        {initialsOf(assignee)}
      </span>
      <span className={s.label}>{firstNameOf(assignee)}</span>
      {trailing}
    </span>
  );
}
