"use client";

// Popover lister for /api/crm/canned-responses, rendered from the
// Composer when the operator clicks the Templates icon.
//
// Behavior per template kind:
//   - Text-only (body_text, no image)   → onPickText(body_text)
//   - Image+caption                     → if canSendMedia, fetches
//                                          the signed URL, downloads
//                                          the bytes client-side,
//                                          builds a File, and calls
//                                          onPickImage(file, caption).
//                                          Otherwise emits a fallback:
//                                          onPickFallback(body_text)
//                                          or onPickInfo when the
//                                          template is image-only.
//
// The signed URL is minted on selection, not on list render — keeps
// the Storage round-trips proportional to operator actions.

import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, X } from "lucide-react";
import { supabase } from "@/lib/supabase";

type CannedResponse = {
  id: string;
  label: string;
  body_text: string | null;
  image_path: string | null;
  display_order: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  canSendMedia: boolean;
  // Whether to surface the image-template gating notice. False when
  // canSendMedia is true (image templates can be sent verbatim).
  showImageGate: boolean;
  onPickText: (bodyText: string) => void;
  onPickImage: (file: File, caption: string) => void;
};

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export default function TemplatesPicker({
  open,
  onClose,
  canSendMedia,
  showImageGate,
  onPickText,
  onPickImage,
}: Props) {
  const [rows, setRows] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Load on first open. Subsequent opens reuse the cached rows; we
  // accept slightly-stale data over churn. The admin curates rarely.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    setError(null);
    (async () => {
      const headers = await bearerHeaders();
      if (!headers) {
        setError("No active session.");
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
    })();
  }, [open]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onDown(e: MouseEvent) {
      const el = popoverRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  const handlePick = useCallback(
    async (row: CannedResponse) => {
      setNotice(null);
      setError(null);

      // Text-only template — straightforward populate.
      if (!row.image_path) {
        if (row.body_text) {
          onPickText(row.body_text);
          onClose();
        }
        return;
      }

      // Image template. If the channel/window can't accept media:
      if (!canSendMedia) {
        if (showImageGate) {
          // Fall back to populating just the caption (if any). Image-
          // only templates surface an inline notice instead of doing
          // anything destructive.
          if (row.body_text) {
            onPickText(row.body_text);
            setNotice(
              "Image templates require an active WhatsApp thread. Sent text only.",
            );
            // Don't close — let the operator see the notice. Auto-
            // dismiss after 3.5s.
            setTimeout(() => setNotice(null), 3500);
            return;
          }
          setNotice(
            "Image templates require an active WhatsApp thread.",
          );
          setTimeout(() => setNotice(null), 3500);
          return;
        }
        return;
      }

      // Image template + canSendMedia. Fetch signed URL, download
      // the bytes, build a File, hand it to the Composer.
      setPicking(row.id);
      try {
        const headers = await bearerHeaders();
        if (!headers) throw new Error("No active session.");
        const sigRes = await fetch(
          `/api/crm/canned-responses/${row.id}/signed-url`,
          { headers },
        );
        const sigJson = (await sigRes.json().catch(() => ({}))) as {
          url?: string;
          error?: string;
        };
        if (!sigRes.ok || !sigJson.url) {
          throw new Error(sigJson.error || `HTTP ${sigRes.status}`);
        }
        const fetchRes = await fetch(sigJson.url);
        if (!fetchRes.ok) {
          throw new Error(`Image fetch failed: HTTP ${fetchRes.status}`);
        }
        const blob = await fetchRes.blob();
        const filename = filenameFromPath(row.image_path);
        const file = new File([blob], filename, {
          type: blob.type || "image/jpeg",
        });
        onPickImage(file, row.body_text ?? "");
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPicking(null);
      }
    },
    [canSendMedia, showImageGate, onPickText, onPickImage, onClose],
  );

  if (!open) return null;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label="Canned responses"
      className="absolute bottom-full left-0 z-40 mb-2 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-cream-line bg-white p-2 shadow-2xl"
    >
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-deep-green/55">
          Templates
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close templates"
          className="rounded-full p-1 text-deep-green/55 hover:bg-cream-soft hover:text-deep-green"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>

      {notice && (
        <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-2 rounded-md border border-coral/40 bg-coral-soft px-2.5 py-1.5 text-[11px] text-coral-hover">
          {error}
        </div>
      )}

      {loading ? (
        <div className="px-2 py-4 text-xs text-deep-green/55">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-2 py-4 text-xs text-deep-green/55">
          No templates yet.
        </div>
      ) : (
        <ul className="max-h-[60vh] overflow-y-auto">
          {rows.map((r) => {
            const isPicking = picking === r.id;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => void handlePick(r)}
                  disabled={isPicking}
                  className="flex w-full items-start gap-2 rounded-md p-2 text-left transition hover:bg-cream-soft disabled:opacity-60"
                >
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cream-soft text-deep-green/45">
                    {r.image_path ? (
                      <ImageIcon aria-hidden className="h-4 w-4" />
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-wider">
                        TXT
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-bold text-deep-green">
                      {r.label}
                    </div>
                    {r.body_text && (
                      <div className="line-clamp-2 text-[11px] text-deep-green/65">
                        {r.body_text}
                      </div>
                    )}
                    {r.image_path && !r.body_text && (
                      <div className="text-[11px] italic text-deep-green/45">
                        Image only
                      </div>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function filenameFromPath(path: string): string {
  const trimmed = path.replace(/.*\//, "");
  return trimmed || "image.jpg";
}
