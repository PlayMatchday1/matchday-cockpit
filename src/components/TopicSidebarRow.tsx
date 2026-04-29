"use client";

import type { Topic } from "@/lib/topics";
import DepartmentPill from "./DepartmentPill";

function relativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(mo / 12)}y`;
}

export default function TopicSidebarRow({
  topic,
  isSelected,
  onSelect,
}: {
  topic: Topic;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full rounded-md border-l-4 py-2 pl-2 pr-3 text-left transition ${
          isSelected
            ? "border-mint bg-cream-soft"
            : "border-transparent hover:bg-cream-soft"
        }`}
        aria-current={isSelected ? "true" : undefined}
      >
        <div className="truncate text-sm font-bold text-deep-green">
          {topic.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-deep-green/55">
          <DepartmentPill department={topic.department} />
          <span className="shrink-0">{relativeShort(topic.updated_at)} ago</span>
        </div>
      </button>
    </li>
  );
}
