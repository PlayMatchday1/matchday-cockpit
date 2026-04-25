"use client";

import type { Goal } from "@/lib/types";
import GoalCard from "./GoalCard";

export default function GoalsSection({
  title,
  subtitle,
  goals,
  onEdit,
  onAdd,
  onChange,
}: {
  title: string;
  subtitle: string;
  goals: Goal[];
  onEdit: (g: Goal) => void;
  onAdd: () => void;
  onChange: () => void;
}) {
  return (
    <section>
      <div className="mb-5 flex items-stretch gap-3">
        <span aria-hidden className="w-1 rounded-full bg-mint" />
        <div className="py-0.5">
          <h2 className="text-2xl font-bold tracking-tight text-deep-green">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-deep-green/60">{subtitle}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {goals.map((g) => (
          <GoalCard
            key={g.id}
            goal={g}
            onEdit={() => onEdit(g)}
            onChange={onChange}
          />
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="flex min-h-[200px] items-center justify-center rounded-2xl border-2 border-dashed border-deep-green/20 bg-cream-soft/40 text-sm font-semibold text-deep-green/60 transition hover:border-deep-green/50 hover:bg-cream-soft hover:text-deep-green"
        >
          + Add goal
        </button>
      </div>
    </section>
  );
}
