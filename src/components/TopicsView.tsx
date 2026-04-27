"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTopics } from "@/lib/useTopics";
import NewTopicModal from "./NewTopicModal";
import TopicDetail from "./TopicDetail";
import TopicSidebarRow from "./TopicSidebarRow";

export default function TopicsView() {
  const router = useRouter();
  const sp = useSearchParams();
  const { topics, loading } = useTopics();
  const [showModal, setShowModal] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const selectedId = sp.get("topic");
  const selected = topics.find((t) => t.id === selectedId) ?? null;

  function selectTopic(id: string | null) {
    const params = new URLSearchParams(sp.toString());
    params.set("tab", "topics");
    if (id) params.set("topic", id);
    else params.delete("topic");
    // push (not replace) — under Next 16 + React 19 + Turbopack,
    // router.replace() with a same-pathname-different-query target
    // doesn't reliably re-fire useSearchParams(), so the URL would
    // change but selectedId stayed stale and the right panel never
    // re-rendered. push() forces a fresh transition; bonus that
    // browser back/forward steps through topic selections.
    router.push(`/clubhouse?${params.toString()}`);
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

  const open = topics.filter((t) => t.status === "open");
  const resolved = topics.filter((t) => t.status === "resolved");
  const archived = topics.filter((t) => t.status === "archived");

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
