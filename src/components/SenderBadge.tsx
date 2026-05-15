// Sender role chip rendered above each Match Chat message.
//
// Four variants:
//   "matchday" — Cockpit-authored, distinct mint background, used
//                for messages where sentBy === "MatchDay".
//   "staff"    — sender's email matches @playmatchday.com.
//   "manager"  — sender's email matches the match's manager_email.
//   null       — no badge (default player voice).
//
// The role-derivation lives in the consumer (per-message logic
// depends on the match doc); this component is presentational only.

export type SenderRole = "matchday" | "staff" | "manager";

const STYLES: Record<
  SenderRole,
  { pill: string; dot: string; label: string }
> = {
  matchday: {
    pill: "bg-mint-soft text-deep-green ring-mint/40",
    dot: "bg-mint",
    label: "MatchDay",
  },
  staff: {
    pill: "bg-blue-soft text-blue-info ring-blue-info/30",
    dot: "bg-blue-info",
    label: "Staff",
  },
  manager: {
    pill: "bg-purple-soft text-purple-done ring-purple-done/30",
    dot: "bg-purple-done",
    label: "Manager",
  },
};

const PILL_BASE =
  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ring-inset shadow-[inset_0_1px_0_rgb(255_255_255_/_0.55)]";

export default function SenderBadge({ role }: { role: SenderRole | null }) {
  if (!role) return null;
  const s = STYLES[role];
  return (
    <span className={`${PILL_BASE} ${s.pill}`}>
      <span aria-hidden className={`h-1 w-1 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
