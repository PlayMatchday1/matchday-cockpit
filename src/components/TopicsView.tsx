"use client";

import { useMemo, useState } from "react";
import { useTopics } from "@/lib/useTopics";
import {
  DEPARTMENTS,
  DEPARTMENT_LABEL,
  DEPARTMENT_PILL_CLASS,
  deptKey,
  type Department,
  type DepartmentKey,
} from "@/lib/topics";
import NewTopicModal from "./NewTopicModal";
import TopicDetail from "./TopicDetail";
import TopicSidebarRow from "./TopicSidebarRow";

type DeptFilter = "all" | DepartmentKey;

const DEPT_FILTER_OPTIONS: { value: DeptFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "general", label: "General" },
  ...DEPARTMENTS.map((d) => ({
    value: d as DeptFilter,
    label: DEPARTMENT_LABEL[d as Department],
  })),
];

export default function TopicsView() {
  const { topics, loading } = useTopics();
  const [showModal, setShowModal] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [deptFilter, setDeptFilter] = useState<DeptFilter>("all");

  const filteredTopics = useMemo(() => {
    if (deptFilter === "all") return topics;
    return topics.filter((t) => deptKey(t.department) === deptFilter);
  }, [topics, deptFilter]);

  // Selection in local state instead of the URL — Next 16 + React 19
  // + Turbopack didn't reliably re-fire useSearchParams() when
  // router.push/replace updated only the query string, so the click
  // handler would change the URL but selected stayed null and the
  // right panel kept showing the placeholder. router.push() helped
  // some sessions but not all — kept biting on accounts whose
  // hydration timing differs (token refresh cadence etc). Local
  // state sidesteps the whole router/searchParams/Suspense
  // interaction. Trade-off: refresh loses selection and we can't
  // deep-link. If deep-linking is needed, route at
  // /clubhouse/topics/[id] instead (file-router is reliable here).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = topics.find((t) => t.id === selectedId) ?? null;

  function selectTopic(id: string | null) {
    setSelectedId(id);
  }

  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-8 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading topics…
      </div>
    );
  }

  if (topics.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center rounded-2xl border-[1.5px] border-cream-line bg-white px-6 py-12 text-center shadow-md shadow-deep-green/10">
          <h2 className="text-xl font-bold tracking-tight text-deep-green">
            No topics yet.
          </h2>
          <p className="mt-2 max-w-md text-sm text-deep-green/60">
            Topics are collaborative threads with action items and discussion.
            Create one to start.
          </p>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="mt-6 rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover"
          >
            + New topic
          </button>
        </div>
        {showModal && (
          <NewTopicModal
            onClose={() => setShowModal(false)}
            onCreated={(id) => {
              setShowModal(false);
              selectTopic(id);
            }}
          />
        )}
      </>
    );
  }

  const open = filteredTopics.filter((t) => t.status === "open");
  const resolved = filteredTopics.filter((t) => t.status === "resolved");
  const archived = filteredTopics.filter((t) => t.status === "archived");

  return (
    <>
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-[280px] lg:shrink-0">
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="mb-3 w-full rounded-full bg-mint px-4 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover"
          >
            + New topic
          </button>
          <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-2 shadow-md shadow-deep-green/10">
            <DeptFilterRow value={deptFilter} onChange={setDeptFilter} />
            {open.length > 0 ? (
              <ul className="space-y-1">
                {open.map((t) => (
                  <TopicSidebarRow
                    key={t.id}
                    topic={t}
                    isSelected={t.id === selectedId}
                    onSelect={() => selectTopic(t.id)}
                  />
                ))}
              </ul>
            ) : (
              <div className="px-3 py-2 text-xs text-deep-green/45">
                No open topics.
              </div>
            )}

            {resolved.length > 0 && (
              <CollapsibleSection
                label={`Resolved (${resolved.length})`}
                open={showResolved}
                onToggle={() => setShowResolved((v) => !v)}
              >
                <ul className="space-y-1">
                  {resolved.map((t) => (
                    <TopicSidebarRow
                      key={t.id}
                      topic={t}
                      isSelected={t.id === selectedId}
                      onSelect={() => selectTopic(t.id)}
                    />
                  ))}
                </ul>
              </CollapsibleSection>
            )}

            {archived.length > 0 && (
              <CollapsibleSection
                label={`Archived (${archived.length})`}
                open={showArchived}
                onToggle={() => setShowArchived((v) => !v)}
              >
                <ul className="space-y-1">
                  {archived.map((t) => (
                    <TopicSidebarRow
                      key={t.id}
                      topic={t}
                      isSelected={t.id === selectedId}
                      onSelect={() => selectTopic(t.id)}
                    />
                  ))}
                </ul>
              </CollapsibleSection>
            )}
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {selected ? (
            <TopicDetail
              key={selected.id}
              topic={selected}
              onDeleted={() => selectTopic(null)}
            />
          ) : (
            <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-12 text-center text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
              Select a topic, or create one to get started.
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <NewTopicModal
          onClose={() => setShowModal(false)}
          onCreated={(id) => {
            setShowModal(false);
            selectTopic(id);
          }}
        />
      )}
    </>
  );
}

function DeptFilterRow({
  value,
  onChange,
}: {
  value: DeptFilter;
  onChange: (next: DeptFilter) => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-1 px-1 pt-1">
      {DEPT_FILTER_OPTIONS.map((opt) => {
        const isActive = value === opt.value;
        // Active filter previews the department's pill tint;
        // inactive uses a subdued text-only style. "All" gets the
        // mint-soft treatment when active so it doesn't visually
        // borrow any single department's color.
        const activeCls =
          opt.value === "all"
            ? "bg-mint-soft text-deep-green ring-mint/40"
            : DEPARTMENT_PILL_CLASS[opt.value];
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.label}
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset transition ${
              isActive
                ? activeCls
                : "bg-transparent text-deep-green/55 ring-transparent hover:bg-cream-soft hover:text-deep-green"
            }`}
            aria-pressed={isActive}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 border-t border-cream-line/60 pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] font-bold uppercase tracking-wider text-deep-green/60 transition hover:bg-cream-soft"
      >
        <span>{label}</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}
