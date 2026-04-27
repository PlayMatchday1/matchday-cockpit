"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { isEmptyHtml } from "@/lib/html";
import { useAuth } from "@/lib/useAuth";
import type { TopicComment } from "@/lib/topics";
import CommentBody from "./CommentBody";
import RichCommentEditor from "./RichCommentEditor";

// Duplicated locally — same helper exists in TopicDetail and
// TopicSidebarRow. Extract to a shared util next time any of those
// files get touched.
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

export default function TopicCommentItem({
  comment,
  onChanged,
}: {
  comment: TopicComment;
  onChanged: () => void;
}) {
  const { appUser } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // App-side permission gate (no RLS on this table). Authorship is
  // checked by email — case-insensitive — because app_users stores
  // emails lowercase via auth and existing comments may have been
  // written before that pattern was consistent. Admins inherit
  // delete-only over others' comments; edit stays author-only since
  // edit implies authorship.
  const isAuthor =
    !!appUser?.email &&
    !!comment.author_email &&
    appUser.email.toLowerCase() === comment.author_email.toLowerCase();
  const isAdmin = appUser?.is_admin ?? false;
  const canEdit = isAuthor;
  const canDelete = isAuthor || isAdmin;

  async function save() {
    if (isEmptyHtml(draft) || saving) return;
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from("topic_comments")
      .update({ body: draft, updated_at: new Date().toISOString() })
      .eq("id", comment.id);
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    setEditing(false);
    onChanged();
  }

  function cancel() {
    setDraft(comment.body);
    setEditing(false);
    setError(null);
  }

  async function doDelete() {
    if (deleting) return;
    setDeleting(true);
    const { error: err } = await supabase
      .from("topic_comments")
      .delete()
      .eq("id", comment.id);
    setDeleting(false);
    if (err) {
      alert(err.message);
      return;
    }
    onChanged();
  }

  if (editing) {
    return (
      <li className="rounded-lg bg-cream px-3 py-2">
        <div className="text-xs font-bold text-deep-green">
          {comment.author || "—"}{" "}
          <span className="font-normal text-deep-green/50">· editing</span>
        </div>
        <div className="mt-2 space-y-2">
          <RichCommentEditor
            value={draft}
            onChange={setDraft}
            onSubmit={save}
          />
          {error && (
            <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-1 text-xs text-coral">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="text-xs font-medium text-deep-green/60 transition hover:text-deep-green disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || isEmptyHtml(draft)}
              className="rounded-md bg-mint px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:cursor-not-allowed disabled:bg-cream-line disabled:text-deep-green/40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </li>
    );
  }

  if (confirmDelete) {
    return (
      <li className="rounded-lg border border-coral/40 bg-coral-soft/40 px-3 py-2">
        <div className="text-xs text-coral">
          Delete this comment? This can&apos;t be undone.
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            disabled={deleting}
            className="text-xs font-medium text-deep-green/60 transition hover:text-deep-green disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doDelete}
            disabled={deleting}
            className="rounded-md bg-coral px-3 py-1 text-xs font-bold text-white transition hover:bg-coral-hover disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group relative rounded-lg bg-cream px-3 py-2">
      {(canEdit || canDelete) && (
        <div className="pointer-events-none absolute right-2 top-2 flex gap-3 text-[11px] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
              className="font-medium text-deep-green/55 transition hover:text-deep-green"
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="font-medium text-deep-green/55 transition hover:text-coral"
            >
              Delete
            </button>
          )}
        </div>
      )}
      <div className="text-xs font-bold text-deep-green">
        {comment.author || "—"}{" "}
        <span className="font-normal text-deep-green/50">
          · {relativeTime(comment.created_at)}
          {comment.updated_at && <> · edited</>}
        </span>
      </div>
      <div className="mt-0.5 pr-20">
        <CommentBody html={comment.body} />
      </div>
    </li>
  );
}
