"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { isEmptyHtml } from "@/lib/html";
import { displayName, useAuth } from "@/lib/useAuth";
import {
  DEPARTMENTS,
  DEPARTMENT_LABEL,
  DEPARTMENT_PILL_CLASS,
  TOPIC_STATUSES,
  TOPIC_STATUS_LABEL,
  TOPIC_STATUS_PILL,
  deptKey,
  type ActionItem,
  type Department,
  type Topic,
  type TopicComment,
  type TopicStatus,
} from "@/lib/topics";
import { refetchTopics } from "@/lib/useTopics";
import ActionItemRow from "./ActionItemRow";
import RichCommentEditor from "./RichCommentEditor";
import TopicCommentItem from "./TopicCommentItem";

function sortActionItems(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => {
    if (a.is_done !== b.is_done) return a.is_done ? 1 : -1;
    if (!a.is_done) {
      const aSort = a.sort_order ?? Number.POSITIVE_INFINITY;
      const bSort = b.sort_order ?? Number.POSITIVE_INFINITY;
      if (aSort !== bSort) return aSort - bSort;
      return a.created_at.localeCompare(b.created_at);
    }
    const aDone = a.done_at ?? "";
    const bDone = b.done_at ?? "";
    return bDone.localeCompare(aDone);
  });
}

export default function TopicDetail({
  topic,
  onDeleted,
}: {
  topic: Topic;
  onDeleted: () => void;
}) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [comments, setComments] = useState<TopicComment[]>([]);
  const [loadingChildren, setLoadingChildren] = useState(true);

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(topic.title);
  const [editingDesc, setEditingDesc] = useState(false);

  const [adding, setAdding] = useState(false);
  const [newItemBody, setNewItemBody] = useState("");

  const [commentBody, setCommentBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const { appUser } = useAuth();

  async function reload() {
    const [aRes, cRes] = await Promise.all([
      supabase
        .from("topic_action_items")
        .select("*")
        .eq("topic_id", topic.id),
      supabase
        .from("topic_comments")
        .select("*")
        .eq("topic_id", topic.id)
        .order("created_at", { ascending: true }),
    ]);
    setItems((aRes.data ?? []) as ActionItem[]);
    setComments((cRes.data ?? []) as TopicComment[]);
  }

  useEffect(() => {
    let cancelled = false;
    setLoadingChildren(true);
    (async () => {
      await reload();
      if (!cancelled) setLoadingChildren(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.id]);

  useEffect(() => {
    setDraftTitle(topic.title);
    setEditingTitle(false);
    setEditingDesc(false);
  }, [topic.id, topic.title, topic.department]);

  async function saveTitle() {
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === topic.title) {
      setEditingTitle(false);
      setDraftTitle(topic.title);
      return;
    }
    const { error } = await supabase
      .from("topics")
      .update({ title: trimmed, updated_at: new Date().toISOString() })
      .eq("id", topic.id);
    setEditingTitle(false);
    if (error) return alert(error.message);
    refetchTopics();
  }

  async function saveDescription(value: string) {
    const trimmed = value.trim();
    const next = trimmed || null;
    if (next === (topic.description ?? null)) {
      setEditingDesc(false);
      return;
    }
    const { error } = await supabase
      .from("topics")
      .update({ description: next, updated_at: new Date().toISOString() })
      .eq("id", topic.id);
    setEditingDesc(false);
    if (error) return alert(error.message);
    refetchTopics();
  }

  async function saveDepartment(value: Department | "") {
    const next = value || null;
    if (next === (topic.department ?? null)) return;
    const { error } = await supabase
      .from("topics")
      .update({ department: next, updated_at: new Date().toISOString() })
      .eq("id", topic.id);
    if (error) return alert(error.message);
    refetchTopics();
  }

  async function changeStatus(newStatus: TopicStatus) {
    if (newStatus === topic.status) return;
    const { error } = await supabase
      .from("topics")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", topic.id);
    if (error) return alert(error.message);
    refetchTopics();
  }

  async function deleteTopic() {
    if (
      !confirm(
        "Delete this topic? Action items and comments will also be removed.",
      )
    )
      return;
    const { error } = await supabase
      .from("topics")
      .delete()
      .eq("id", topic.id);
    if (error) return alert(error.message);
    refetchTopics();
    onDeleted();
  }

  async function addActionItem() {
    const trimmed = newItemBody.trim();
    if (!trimmed) return;
    const maxSort = items
      .filter((i) => !i.is_done)
      .reduce((m, i) => Math.max(m, i.sort_order ?? 0), 0);
    const { error } = await supabase.from("topic_action_items").insert({
      topic_id: topic.id,
      body: trimmed,
      sort_order: maxSort + 1,
    });
    if (error) return alert(error.message);
    setNewItemBody("");
    setAdding(false);
    reload();
  }

  async function postComment() {
    if (isEmptyHtml(commentBody) || !appUser || posting) return;
    setPosting(true);
    setPostError(null);
    const { error } = await supabase.from("topic_comments").insert({
      topic_id: topic.id,
      author: displayName(appUser),
      author_email: appUser.email,
      body: commentBody,
    });
    setPosting(false);
    if (error) {
      setPostError(error.message);
      return;
    }
    setCommentBody("");
    reload();
  }

  const sortedItems = useMemo(() => sortActionItems(items), [items]);
  const doneCount = items.filter((i) => i.is_done).length;
  const canPost = !isEmptyHtml(commentBody) && !!appUser && !posting;
  const posterName = displayName(appUser);

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 md:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setDraftTitle(topic.title);
                  setEditingTitle(false);
                }
              }}
              className="w-full rounded-md border border-mint bg-white px-2 py-1 text-2xl font-extrabold tracking-tight text-deep-green focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftTitle(topic.title);
                setEditingTitle(true);
              }}
              className="block w-full rounded-md px-2 py-1 text-left text-2xl font-extrabold tracking-tight text-deep-green hover:bg-cream-soft"
            >
              {topic.title}
            </button>
          )}

          {editingDesc ? (
            <textarea
              autoFocus
              defaultValue={topic.description ?? ""}
              onBlur={(e) => saveDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditingDesc(false);
              }}
              rows={3}
              className="mt-2 w-full resize-none rounded-md border border-mint bg-white px-2 py-1 text-sm text-deep-green focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingDesc(true)}
              className="mt-2 block w-full whitespace-pre-wrap rounded-md px-2 py-1 text-left text-sm text-deep-green/75 hover:bg-cream-soft"
            >
              {topic.description || (
                <span className="italic text-deep-green/40">
                  Add description…
                </span>
              )}
            </button>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <select
            value={topic.status}
            onChange={(e) => changeStatus(e.target.value as TopicStatus)}
            className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset focus:outline-none ${TOPIC_STATUS_PILL[topic.status]}`}
            aria-label="Topic status"
          >
            {TOPIC_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TOPIC_STATUS_LABEL[s]}
              </option>
            ))}
          </select>

          <select
            value={topic.department ?? ""}
            onChange={(e) =>
              saveDepartment(e.target.value as Department | "")
            }
            aria-label="Topic department"
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset focus:outline-none ${DEPARTMENT_PILL_CLASS[deptKey(topic.department)]}`}
          >
            <option value="">{DEPARTMENT_LABEL.general}</option>
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {DEPARTMENT_LABEL[d]}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={deleteTopic}
            className="text-xs font-medium text-deep-green/40 transition hover:text-coral"
          >
            Delete
          </button>
        </div>
      </div>

      <section className="mt-8 border-t border-cream-line/60 pt-6">
        <h3 className="mb-3 flex items-baseline gap-2 text-xs font-bold uppercase tracking-wider text-deep-green/60">
          Action items
          {items.length > 0 && (
            <span className="text-xs font-normal normal-case text-deep-green/45">
              ({items.length} · {doneCount} done)
            </span>
          )}
        </h3>
        {loadingChildren ? (
          <div className="text-xs text-deep-green/50">Loading…</div>
        ) : sortedItems.length === 0 ? (
          <div className="mb-2 text-xs text-deep-green/50">
            No action items yet.
          </div>
        ) : (
          <ul className="space-y-1">
            {sortedItems.map((item) => (
              <ActionItemRow key={item.id} item={item} onChange={reload} />
            ))}
          </ul>
        )}
        {adding ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-mint bg-mint-soft/30 px-3 py-2">
            <input
              autoFocus
              value={newItemBody}
              onChange={(e) => setNewItemBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addActionItem();
                } else if (e.key === "Escape") {
                  setNewItemBody("");
                  setAdding(false);
                }
              }}
              placeholder="What needs doing?"
              className="min-w-0 flex-1 rounded border border-cream-line bg-white px-2 py-1 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
            <button
              type="button"
              onClick={addActionItem}
              disabled={!newItemBody.trim()}
              className="shrink-0 rounded bg-mint px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setNewItemBody("");
                setAdding(false);
              }}
              className="shrink-0 text-xs font-medium text-deep-green/60 transition hover:text-deep-green"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-2 text-sm font-medium text-deep-green/60 transition hover:text-deep-green"
          >
            + Add action item
          </button>
        )}
      </section>

      <section className="mt-8 border-t border-cream-line/60 pt-6">
        <h3 className="mb-3 flex items-baseline gap-2 text-xs font-bold uppercase tracking-wider text-deep-green/60">
          Discussion
          {comments.length > 0 && (
            <span className="text-xs font-normal normal-case text-deep-green/45">
              ({comments.length})
            </span>
          )}
        </h3>
        {loadingChildren ? (
          <div className="mb-4 text-xs text-deep-green/50">Loading…</div>
        ) : comments.length === 0 ? (
          <div className="mb-4 text-xs text-deep-green/50">
            No comments yet.
          </div>
        ) : (
          <ul className="mb-4 space-y-2">
            {comments.map((c) => (
              <TopicCommentItem key={c.id} comment={c} onChanged={reload} />
            ))}
          </ul>
        )}

        <div className="space-y-2">
          {posterName && (
            <div className="text-[11px] text-deep-green/55">
              Posting as <span className="font-bold">{posterName}</span>
            </div>
          )}
          <RichCommentEditor
            value={commentBody}
            onChange={setCommentBody}
            placeholder="Add a comment..."
            onSubmit={postComment}
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={postComment}
              disabled={!canPost}
              className="rounded-md bg-mint px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:cursor-not-allowed disabled:bg-cream-line disabled:text-deep-green/40"
            >
              {posting ? "Posting…" : "Post"}
            </button>
          </div>
          {postError && (
            <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-1.5 text-xs text-coral">
              {postError}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
