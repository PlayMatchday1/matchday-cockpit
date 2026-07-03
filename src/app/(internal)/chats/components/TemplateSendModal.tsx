"use client";

// Send-a-WhatsApp-template modal. Distinct from TemplatesPicker
// (canned responses that populate the textarea): this fires a
// pre-approved Meta template message immediately, with operator-filled
// variables, and is allowed OUTSIDE the 24-hour window — the tool for
// reviving stale threads. Marketing category, so each send is billable.

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  getTemplate,
  renderTemplateBody,
  type WhatsAppTemplate,
} from "@/lib/whatsappTemplates";
import type { ConversationMessage } from "./MessageBubble";

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// v1 ships a single template; the registry + this constant make adding
// more a small change (swap to a picker when there's a second one).
const TEMPLATE_NAME = "support_followup";

export default function TemplateSendModal({
  open,
  onClose,
  threadId,
  initialCustomerName,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  threadId: string;
  initialCustomerName: string;
  onSent: (m: ConversationMessage) => void;
}) {
  const tpl = getTemplate(TEMPLATE_NAME);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed variable values when the modal opens (customer_name from the
  // linked player; the rest blank).
  useEffect(() => {
    if (!open || !tpl) return;
    const seed: Record<string, string> = {};
    for (const v of tpl.variables) {
      seed[v.key] = v.source === "player" ? initialCustomerName : "";
    }
    setVars(seed);
    setError(null);
  }, [open, tpl, initialCustomerName]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending, onClose]);

  const preview = useMemo(() => {
    if (!tpl) return "";
    // Show operator input, or a bracketed hint for empty vars so the
    // structure is visible.
    const filled: Record<string, string> = {};
    for (const v of tpl.variables) {
      filled[v.key] = vars[v.key]?.trim() || `[${v.label.toLowerCase()}]`;
    }
    return renderTemplateBody(tpl, filled);
  }, [tpl, vars]);

  if (!open || !tpl) return null;

  const missingRequired = tpl.variables.some(
    (v) => v.required && !(vars[v.key]?.trim()),
  );

  async function handleSend(template: WhatsAppTemplate) {
    if (missingRequired || sending) return;
    setSending(true);
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("No active session — sign in again.");
      setSending(false);
      return;
    }
    try {
      const res = await fetch("/api/crm/send-template", {
        method: "POST",
        headers,
        body: JSON.stringify({
          thread_id: threadId,
          template_name: template.name,
          variables: vars,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        message?: ConversationMessage;
        error?: string;
        send_error?: string;
      };
      if (!res.ok) {
        throw new Error(j.send_error || j.error || `HTTP ${res.status}`);
      }
      if (j.message) onSent(j.message);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-deep-green/40 px-4 py-10 backdrop-blur-sm"
      onClick={() => !sending && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-cream-line bg-cream p-6 shadow-2xl shadow-deep-green/30"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-deep-green">
              Send template
            </h2>
            <p className="mt-0.5 text-xs text-deep-green/55">
              {tpl.label} · {tpl.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-deep-green/60 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Marketing / billable advisory */}
        <div className="mb-4 rounded-lg border border-gold/40 bg-gold-soft/60 px-3 py-2 text-[12px] font-medium text-deep-green/80">
          <span aria-hidden className="mr-1">
            ⚠
          </span>
          Marketing template — billable send. Goes out even past the 24-hour
          window; only send to customers who have engaged with support.
        </div>

        <div className="grid gap-3">
          {tpl.variables.map((v) => (
            <label
              key={v.key}
              className="grid gap-1.5 text-[11px] font-bold uppercase tracking-wide text-deep-green/60"
            >
              {v.label}
              {v.source === "player" && (
                <span className="font-medium normal-case tracking-normal text-deep-green/45">
                  {" "}
                  (auto-filled from the linked player, editable)
                </span>
              )}
              <input
                className="h-11 w-full rounded-lg border border-cream-line bg-white px-3 text-sm font-medium text-deep-green focus:border-deep-green/50 focus:outline-none"
                value={vars[v.key] ?? ""}
                placeholder={v.placeholder}
                onChange={(e) =>
                  setVars((prev) => ({ ...prev, [v.key]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>

        {/* Live preview of the exact message */}
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-deep-green/60">
            Preview
          </div>
          <div className="whitespace-pre-wrap rounded-lg border border-cream-line bg-white px-3 py-2 text-sm text-deep-green/85">
            {preview}
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral-hover">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="rounded-full border border-cream-line bg-transparent px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSend(tpl)}
            disabled={sending || missingRequired}
            className="rounded-full bg-deep-green px-5 py-2 text-xs font-bold text-cream transition hover:bg-deep-green-soft disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send template"}
          </button>
        </div>
      </div>
    </div>
  );
}
