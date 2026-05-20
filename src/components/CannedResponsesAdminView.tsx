"use client";

// Admin curation for the /chats Composer canned-response picker.
// CRUD against /api/crm/canned-responses. Image upload uses the same
// client-side compression as the Composer (shared via
// src/lib/imageCompression).
//
// Rows are sorted by display_order ASC, then label ASC (the list
// endpoint already returns this order). Display order is a manual
// numeric field per spec — no drag-to-reorder in v1.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Image as ImageIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { maybeCompressImage } from "@/lib/imageCompression";

const MAX_LABEL_LEN = 120;
const MAX_BODY_LEN = 4000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const BODY_PREVIEW_CHARS = 140;

type CannedResponse = {
  id: string;
  label: string;
  body_text: string | null;
  image_path: string | null;
  display_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type EditorState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; row: CannedResponse }
  | { kind: "delete"; row: CannedResponse };

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function bearerHeadersMultipart(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

export default function CannedResponsesAdminView() {
  const [rows, setRows] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });

  const load = useCallback(async () => {
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("No active session — sign in again.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/crm/canned-responses", { headers });
      const j = (await res.json().catch(() => ({}))) as {
        responses?: CannedResponse[];
        error?: string;
      };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setRows(j.responses ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultDisplayOrder = useMemo(() => {
    if (rows.length === 0) return 10;
    return Math.max(...rows.map((r) => r.display_order)) + 10;
  }, [rows]);

  const onSaved = useCallback(() => {
    setEditor({ kind: "closed" });
    void load();
  }, [load]);

  const confirmDelete = useCallback(async () => {
    if (editor.kind !== "delete") return;
    const id = editor.row.id;
    const headers = await bearerHeaders();
    if (!headers) {
      setError("No active session — sign in again.");
      return;
    }
    try {
      const res = await fetch(`/api/crm/canned-responses/${id}`, {
        method: "DELETE",
        headers,
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setEditor({ kind: "closed" });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [editor, load]);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-deep-green/65">
          {rows.length} template{rows.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={() => setEditor({ kind: "create" })}
          className="inline-flex items-center gap-1.5 rounded-full bg-mint px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
        >
          <Plus aria-hidden className="h-3.5 w-3.5" />
          Add response
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-md border border-cream-line bg-white p-6 text-sm text-deep-green/60">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-cream-line bg-white p-6 text-sm text-deep-green/60">
          No templates yet. Click <strong>Add response</strong> to create one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-cream-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-cream-soft text-[11px] uppercase tracking-wide text-deep-green/55">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Image</th>
                <th className="px-3 py-2 text-left font-semibold">Label</th>
                <th className="px-3 py-2 text-left font-semibold">Body</th>
                <th className="px-3 py-2 text-right font-semibold">Order</th>
                <th className="w-20 px-3 py-2 text-right font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-line">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    {r.image_path ? (
                      <Thumbnail responseId={r.id} />
                    ) : (
                      <div className="h-10 w-10 rounded-md bg-cream-soft" />
                    )}
                  </td>
                  <td className="px-3 py-2 font-bold text-deep-green">
                    {r.label}
                  </td>
                  <td className="px-3 py-2 text-deep-green/70">
                    {r.body_text
                      ? r.body_text.slice(0, BODY_PREVIEW_CHARS) +
                        (r.body_text.length > BODY_PREVIEW_CHARS ? "…" : "")
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-deep-green/60">
                    {r.display_order}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditor({ kind: "edit", row: r })}
                        aria-label="Edit"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-deep-green/55 hover:bg-cream-soft hover:text-deep-green"
                      >
                        <Pencil aria-hidden className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditor({ kind: "delete", row: r })}
                        aria-label="Delete"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-coral-hover/70 hover:bg-coral-soft"
                      >
                        <Trash2 aria-hidden className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editor.kind === "create" || editor.kind === "edit") && (
        <EditorModal
          mode={editor}
          defaultDisplayOrder={defaultDisplayOrder}
          onClose={() => setEditor({ kind: "closed" })}
          onSaved={onSaved}
        />
      )}

      {editor.kind === "delete" && (
        <DeleteConfirm
          label={editor.row.label}
          onCancel={() => setEditor({ kind: "closed" })}
          onConfirm={confirmDelete}
        />
      )}
    </section>
  );
}

// ============================================================
// Thumbnail — fetches a signed URL per row. Keeps the row endpoint
// stateless and mirrors the picker's "fetch only when needed"
// pattern. ~10-20 rows total, so the request fan-out is negligible.
// ============================================================
function Thumbnail({ responseId }: { responseId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const headers = await bearerHeaders();
      if (!headers) return;
      try {
        const res = await fetch(
          `/api/crm/canned-responses/${responseId}/signed-url`,
          { headers },
        );
        if (!res.ok) {
          if (!cancelled) setErrored(true);
          return;
        }
        const j = (await res.json()) as { url?: string };
        if (!cancelled && j.url) setUrl(j.url);
      } catch {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [responseId]);

  if (errored || !url) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-cream-soft text-deep-green/40">
        <ImageIcon aria-hidden className="h-4 w-4" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={url}
      alt=""
      className="h-10 w-10 rounded-md object-cover ring-1 ring-cream-line"
    />
  );
}

// ============================================================
// Create / Edit modal
// ============================================================
function EditorModal({
  mode,
  defaultDisplayOrder,
  onClose,
  onSaved,
}: {
  mode: { kind: "create" } | { kind: "edit"; row: CannedResponse };
  defaultDisplayOrder: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = mode.kind === "edit";
  const existing = isEdit ? mode.row : null;
  const [label, setLabel] = useState(existing?.label ?? "");
  const [bodyText, setBodyText] = useState(existing?.body_text ?? "");
  const [displayOrder, setDisplayOrder] = useState<number>(
    existing?.display_order ?? defaultDisplayOrder,
  );
  // file is set when the operator picks a new image. existingImagePath
  // is set when editing a row that already has an image.
  const [file, setFile] = useState<File | null>(null);
  const [clearImage, setClearImage] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [existingImageSignedUrl, setExistingImageSignedUrl] = useState<
    string | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch the existing image's signed URL for preview when editing.
  useEffect(() => {
    if (!existing?.image_path) return;
    let cancelled = false;
    (async () => {
      const headers = await bearerHeaders();
      if (!headers) return;
      try {
        const res = await fetch(
          `/api/crm/canned-responses/${existing.id}/signed-url`,
          { headers },
        );
        if (!res.ok) return;
        const j = (await res.json()) as { url?: string };
        if (!cancelled && j.url) setExistingImageSignedUrl(j.url);
      } catch {
        // best effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [existing]);

  // Object URL for the picked file preview. Revoke on change/unmount.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onPickImage = useCallback(async (picked: File) => {
    setError(null);
    if (!ALLOWED_MIMES.has(picked.type.toLowerCase())) {
      setError(`Unsupported image type: ${picked.type}`);
      return;
    }
    let final = picked;
    try {
      const compressed = await maybeCompressImage(picked, MAX_IMAGE_BYTES);
      if (compressed) final = compressed;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compression failed");
      return;
    }
    if (final.size > MAX_IMAGE_BYTES) {
      setError("Image too large even after compression.");
      return;
    }
    setFile(final);
    setClearImage(false);
  }, []);

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      void onPickImage(f);
    },
    [onPickImage],
  );

  const removeImage = useCallback(() => {
    setFile(null);
    setClearImage(true);
    setExistingImageSignedUrl(null);
  }, []);

  const submit = useCallback(async () => {
    if (saving) return;
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("Label is required.");
      return;
    }
    if (trimmedLabel.length > MAX_LABEL_LEN) {
      setError(`Label exceeds ${MAX_LABEL_LEN} chars.`);
      return;
    }
    if (bodyText.length > MAX_BODY_LEN) {
      setError(`Body exceeds ${MAX_BODY_LEN} chars.`);
      return;
    }
    const hasImage = !!file || (!clearImage && !!existing?.image_path);
    if (!bodyText.trim() && !hasImage) {
      setError("Either body text or an image is required.");
      return;
    }
    setSaving(true);
    setError(null);

    try {
      // Use multipart whenever an image is involved (new file OR
      // clear request). Otherwise JSON keeps it simple.
      const useMultipart = !!file || clearImage;
      const url = isEdit
        ? `/api/crm/canned-responses/${existing!.id}`
        : "/api/crm/canned-responses";
      const method = isEdit ? "PATCH" : "POST";
      let res: Response;
      if (useMultipart) {
        const headers = await bearerHeadersMultipart();
        if (!headers) throw new Error("No active session.");
        const form = new FormData();
        form.append("label", trimmedLabel);
        form.append("body_text", bodyText);
        form.append("display_order", String(displayOrder));
        if (file) form.append("image", file);
        if (clearImage && !file) form.append("clear_image", "true");
        res = await fetch(url, { method, headers, body: form });
      } else {
        const headers = await bearerHeaders();
        if (!headers) throw new Error("No active session.");
        res = await fetch(url, {
          method,
          headers,
          body: JSON.stringify({
            label: trimmedLabel,
            body_text: bodyText.trim() || null,
            display_order: displayOrder,
          }),
        });
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    label,
    bodyText,
    displayOrder,
    file,
    clearImage,
    existing,
    isEdit,
    onSaved,
  ]);

  const showingPreview = previewUrl ?? existingImageSignedUrl;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep-green/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? "Edit canned response" : "Add canned response"}
    >
      <div className="w-full max-w-lg rounded-2xl bg-cream-soft p-5 shadow-2xl">
        <h2 className="mb-3 text-base font-bold text-deep-green">
          {isEdit ? "Edit canned response" : "Add canned response"}
        </h2>

        <label className="mb-3 block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/60">
            Label
          </span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={MAX_LABEL_LEN}
            disabled={saving}
            placeholder="e.g. Push notifications setup"
            className="mt-1 block w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
        </label>

        <label className="mb-3 block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/60">
            Body text (optional)
          </span>
          <textarea
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            disabled={saving}
            rows={4}
            placeholder="Sent as-is, or as the image caption when an image is attached."
            className="mt-1 block w-full resize-none rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
          <span className="mt-1 block text-[10px] text-deep-green/45">
            {bodyText.length}/{MAX_BODY_LEN}
          </span>
        </label>

        <div className="mb-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/60">
            Image (optional)
          </span>
          <div className="mt-1 flex items-center gap-3">
            {showingPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={showingPreview}
                alt=""
                className="h-16 w-16 rounded-md object-cover ring-1 ring-cream-line"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-cream-line bg-white text-deep-green/40">
                <ImageIcon aria-hidden className="h-5 w-5" />
              </div>
            )}
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
                className="rounded-full border border-cream-line bg-white px-3 py-1 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
              >
                {showingPreview ? "Replace image" : "Upload image"}
              </button>
              {showingPreview && (
                <button
                  type="button"
                  onClick={removeImage}
                  disabled={saving}
                  className="text-[11px] font-medium text-coral-hover hover:underline"
                >
                  Remove
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={onFileInput}
            />
          </div>
          <p className="mt-1.5 text-[10px] text-deep-green/45">
            JPEG / PNG / WebP / GIF, ≤ 5 MB. Larger images are
            auto-compressed.
          </p>
        </div>

        <label className="mb-3 block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-deep-green/60">
            Display order
          </span>
          <input
            type="number"
            value={displayOrder}
            onChange={(e) => setDisplayOrder(Number(e.target.value))}
            disabled={saving}
            className="mt-1 block w-32 rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
          />
          <span className="mt-1 block text-[10px] text-deep-green/45">
            Lower numbers appear first.
          </span>
        </label>

        {error && (
          <div className="mb-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green hover:bg-cream-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="rounded-full bg-mint px-3 py-1.5 text-xs font-bold text-deep-green hover:bg-mint-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : isEdit ? "Save changes" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirm({
  label,
  onCancel,
  onConfirm,
}: {
  label: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-deep-green/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm delete"
    >
      <div className="w-full max-w-sm rounded-2xl bg-cream-soft p-5 shadow-2xl">
        <h2 className="text-base font-bold text-deep-green">
          Delete &ldquo;{label}&rdquo;?
        </h2>
        <p className="mt-2 text-sm text-deep-green/70">
          This cannot be undone. The row and any attached image will be
          removed.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green hover:bg-cream-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            className="rounded-full bg-coral px-3 py-1.5 text-xs font-bold text-white hover:bg-coral-hover"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
