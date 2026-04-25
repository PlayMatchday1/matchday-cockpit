"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { partitionDirectory } from "@/lib/org";
import { useOrgDirectory } from "@/lib/useOrgDirectory";
import type { GoalComment } from "@/lib/types";
import CommentBody from "./CommentBody";
import DirectoryOptions from "./DirectoryOptions";
import RichCommentEditor from "./RichCommentEditor";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function isEmptyHtml(html: string): boolean {
  if (!html) return true;
  const stripped = html.replace(/<[^>]*>/g, "").replace(/\s|&nbsp;/g, "");
  return stripped.length === 0;
}

export default function CardComments({ goalId }: { goalId: string }) {
  const [comments, setComments] = useState<GoalComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [author, setAuthor] = useState<string>("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const dir = useOrgDirectory();
  const partition = useMemo(
    () => (dir ? partitionDirectory(dir) : null),
    [dir],
  );

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("goal_comments")
      .select("*")
      .eq("goal_id", goalId)
      .order("created_at", { ascending: true });
    setComments((data ?? []) as GoalComment[]);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  async function submitComment() {
    if (isEmptyHtml(body) || !author || posting) return;
    setPosting(true);
    setPostError(null);
    const { error } = await supabase
      .from("goal_comments")
      .insert({ goal_id: goalId, author, body });
    setPosting(false);
    if (error) {
      setPostError(error.message);
      return;
    }
    setBody("");
    load();
  }

  function onFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitComment();
  }

  async function remove(id: string) {
    const prev = comments;
    setComments((cs) => cs.filter((c) => c.id !== id));
    const { error } = await supabase
      .from("goal_comments")
      .delete()
      .eq("id", id);
    if (error) {
      setComments(prev);
      alert(error.message);
    }
  }

  const canPost = !isEmptyHtml(body) && author.length > 0 && !posting;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-deep-green/60">
          Comments{comments.length > 0 ? ` · ${comments.length}` : ""}
        </span>
        {comments.length > 0 && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-xs font-medium text-deep-green/60 hover:text-deep-green"
          >
            {collapsed ? "Show comments" : "Hide comments"}
          </button>
        )}
      </div>

      {!collapsed &&
        (loading ? (
          <div className="text-xs text-deep-green/50">Loading…</div>
        ) : comments.length === 0 ? (
          <div className="text-xs text-deep-green/50">No comments yet.</div>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li
                key={c.id}
                className="group relative rounded-lg bg-cream px-3 py-2 text-sm"
              >
                <div className="text-xs font-bold text-deep-green">
                  {c.author}{" "}
                  <span className="font-normal text-deep-green/50">
                    · {relativeTime(c.created_at)}
                  </span>
                </div>
                <div className="mt-0.5">
                  <CommentBody html={c.body} />
                </div>
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  className="absolute right-1.5 top-1.5 rounded-full p-1 text-deep-green/30 opacity-0 transition group-hover:opacity-100 hover:bg-coral-soft hover:text-coral"
                  aria-label="Delete comment"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        ))}

      <form onSubmit={onFormSubmit} className="space-y-2">
        <select
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          className="w-full rounded-md border border-cream-line bg-cream px-2 py-1.5 text-xs font-medium text-deep-green focus:border-deep-green focus:outline-none"
          aria-label="Comment author"
        >
          <option value="" disabled>
            Choose author…
          </option>
          {partition && <DirectoryOptions partition={partition} />}
        </select>
        <RichCommentEditor
          value={body}
          onChange={setBody}
          placeholder="Add a comment..."
          onSubmit={submitComment}
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!canPost}
            className="rounded-md bg-mint px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:cursor-not-allowed disabled:bg-cream-line disabled:text-deep-green/40"
          >
            {posting ? "Posting…" : "Post"}
          </button>
        </div>
      </form>

      {postError && (
        <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-1.5 text-xs text-coral">
          {postError}
        </div>
      )}
    </div>
  );
}
