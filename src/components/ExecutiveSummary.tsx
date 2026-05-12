"use client";

import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { Pencil } from "lucide-react";
import { useAuth } from "@/lib/useAuth";
import { useFinanceData, refetchFinanceData } from "@/lib/useFinanceData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import { supabase } from "@/lib/supabase";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(raw: string): string {
  const escaped = escapeHtml(raw);
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold.replace(/(^|[\s(])_(.+?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  const html = withItalic
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, "<br />")}</p>`)
    .join("");
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "strong", "em", "br"],
    ALLOWED_ATTR: [],
  });
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function ExecutiveSummary() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();
  const quarter = useFinanceQuarter();
  const [editing, setEditing] = useState(false);
  const [eyebrowDraft, setEyebrowDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const commentary = data?.commentary ?? null;
  const isAdmin = appUser?.is_admin ?? false;

  useEffect(() => {
    if (editing) return;
    setEyebrowDraft(commentary?.eyebrow ?? "");
    setBodyDraft(commentary?.body ?? "");
  }, [commentary, editing]);

  const renderedBody = useMemo(
    () => (commentary?.body ? renderMarkdown(commentary.body) : ""),
    [commentary?.body],
  );

  if (loading && !commentary) {
    return (
      <div className="rounded-2xl border-l-4 border-gold bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading executive summary…
      </div>
    );
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    const payload = {
      eyebrow: eyebrowDraft.trim() || null,
      body: bodyDraft,
      updated_at: new Date().toISOString(),
      quarter_key: quarter.key,
    };
    try {
      // Upsert on quarter_key (UNIQUE per migration 0026). Saving
      // from a Q3 view creates a new row; saving from Q2 updates
      // the existing Q2 row. The active quarter's row is the only
      // one ever loaded by useFinanceData (filtered by quarter_key),
      // so the local `commentary.id` lookup is just a sanity guard.
      const { error } = await supabase
        .from("fin_commentary")
        .upsert(payload, { onConflict: "quarter_key" });
      if (error) throw error;
      await refetchFinanceData();
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative rounded-2xl border-l-4 border-gold bg-white p-6 shadow-md shadow-deep-green/10 sm:p-8">
      {!editing && isAdmin && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="absolute right-5 top-5 inline-flex items-center gap-1 rounded-full border border-cream-line bg-cream-soft px-3 py-1 text-xs font-bold text-deep-green hover:bg-cream"
          aria-label="Edit executive summary"
        >
          <Pencil size={12} aria-hidden />
          Edit
        </button>
      )}

      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
              Eyebrow
            </label>
            <input
              type="text"
              value={eyebrowDraft}
              onChange={(e) => setEyebrowDraft(e.target.value)}
              placeholder="Executive Summary · April 2026 (through 4/24)"
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
              Body — supports **bold**, _italic_, blank line for new paragraph
            </label>
            <textarea
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-md border border-cream-line bg-white px-3 py-2 text-base leading-relaxed text-deep-green focus:border-deep-green focus:outline-none"
            />
          </div>
          {saveError && (
            <div className="text-xs text-coral">{saveError}</div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setSaveError(null);
                setEyebrowDraft(commentary?.eyebrow ?? "");
                setBodyDraft(commentary?.body ?? "");
              }}
              disabled={saving}
              className="rounded-full border border-cream-line bg-transparent px-4 py-1.5 text-xs font-bold text-deep-green hover:bg-cream-soft disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green hover:bg-mint-hover hover:text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
            {commentary?.eyebrow || "Executive Summary"}
          </div>
          {commentary?.body ? (
            <div
              className="mt-3 text-[17px] leading-relaxed text-deep-green [&>p]:m-0 [&>p+p]:mt-3"
              dangerouslySetInnerHTML={{ __html: renderedBody }}
            />
          ) : (
            <div className="mt-3 text-sm italic text-deep-green/45">
              No executive summary yet.
              {isAdmin ? " Click Edit to add one." : ""}
            </div>
          )}
          {commentary?.updated_at && (
            <div className="mt-3 text-[11px] text-deep-green/45">
              Last updated {relativeTime(commentary.updated_at)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
