"use client";

// Notify players drawer — operational SMS to the currently-registered
// players in a match. Opens from the match right-pane header.
//
// Steps: compose -> confirm -> result. Recipients are previewed from
// GET /api/match-chats/[chatId]/notify (masked phones); the actual send
// + audit happen server-side on POST. All copy here is strict ASCII so
// the SMS stays on GSM-7 (160-char segments, not 70).

import { useCallback, useEffect, useMemo, useState } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatMatchTitle } from "@/lib/cityTimezones";
import {
  buildTemplateBody,
  personalize,
  unfilledTokens,
  smsSegments,
  displayName,
  TEMPLATE_LABELS,
  NOTIFY_TEMPLATE_IDS,
  type NotifyTemplateId,
  type MatchMergeValues,
} from "@/lib/matchNotify";

type MatchLite = {
  city_identifier: string | null;
  start_date_utc: string | null;
  field_title: string | null;
};

type PreviewRecipient = {
  user_id: number;
  first_name: string | null;
  last_name: string | null;
  masked_phone: string;
};

type Preview = {
  recipient_count: number;
  no_phone_count: number;
  total_registered: number;
  recipients: PreviewRecipient[];
};

type SendResult = {
  recipient_count: number;
  success_count: number;
  failure_count: number;
  failures: { masked_phone: string; error: string | null }[];
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

export default function NotifyPlayersDrawer({
  open,
  onClose,
  chatId,
  match,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  match: MatchLite | null;
}) {
  const [step, setStep] = useState<"compose" | "confirm" | "result">("compose");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [templateId, setTemplateId] = useState<NotifyTemplateId | null>(null);
  const [body, setBody] = useState("");
  const [listExpanded, setListExpanded] = useState(false);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  const merge: MatchMergeValues = useMemo(() => {
    const t = formatMatchTitle({
      cityCode: match?.city_identifier,
      startDateIso: match?.start_date_utc,
      fieldTitle: match?.field_title,
    });
    return {
      date: t.date && t.date !== "—" ? t.date : "the scheduled date",
      time: t.time || "the scheduled time",
      field: match?.field_title?.trim() || t.venue,
    };
  }, [match]);

  // Reset + load recipients each time the drawer opens.
  useEffect(() => {
    if (!open) return;
    setStep("compose");
    setTemplateId(null);
    setBody("");
    setListExpanded(false);
    setSendError(null);
    setResult(null);
    setPreview(null);
    setPreviewError(null);
    setLoadingPreview(true);

    let cancelled = false;
    (async () => {
      try {
        const headers = await bearerHeaders();
        if (!headers) throw new Error("No active session. Sign in again.");
        const res = await fetch(`/api/match-chats/${chatId}/notify`, {
          headers,
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({}))) as Preview & {
          error?: string;
        };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (!cancelled) setPreview(json);
      } catch (e) {
        if (!cancelled) {
          setPreviewError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chatId]);

  // Escape closes (unless mid-send).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, sending, onClose]);

  const pickTemplate = useCallback(
    (id: NotifyTemplateId) => {
      setTemplateId(id);
      setBody(buildTemplateBody(id, merge));
      setSendError(null);
    },
    [merge],
  );

  const exampleName = preview?.recipients[0]?.first_name ?? "there";
  const renderedPreview = useMemo(
    () => personalize(body, exampleName),
    [body, exampleName],
  );
  const seg = useMemo(() => smsSegments(renderedPreview), [renderedPreview]);
  const leftover = useMemo(() => unfilledTokens(body), [body]);

  const recipientCount = preview?.recipient_count ?? 0;
  const canSend =
    !!body.trim() &&
    recipientCount > 0 &&
    leftover.length === 0 &&
    templateId != null;

  async function doSend() {
    if (sending) return;
    setSending(true);
    setSendError(null);
    try {
      const headers = await bearerHeaders();
      if (!headers) throw new Error("No active session. Sign in again.");
      const res = await fetch(`/api/match-chats/${chatId}/notify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          template_used: templateId,
          message_body: body,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as SendResult & {
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResult(json);
      setStep("result");
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      setStep("compose");
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-deep-green/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Notify players"
        className="flex h-full w-full max-w-md flex-col border-l border-cream-line bg-white shadow-2xl"
      >
        {/* Header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-cream-line px-4">
          <span className="font-display text-lg uppercase tracking-tight text-deep-green">
            Notify players
          </span>
          <button
            type="button"
            onClick={() => !sending && onClose()}
            aria-label="Close"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {/* ---------- RESULT ---------- */}
          {step === "result" && result ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-cream-line bg-cream-soft/50 p-4">
                <div className="text-sm font-bold text-deep-green">
                  Sent to {result.success_count} of {result.recipient_count}{" "}
                  players.
                  {result.failure_count > 0
                    ? ` ${result.failure_count} failed.`
                    : ""}
                </div>
              </div>
              {result.failure_count > 0 && (
                <div className="rounded-xl border border-coral/40 bg-coral-soft/30 p-3">
                  <div className="mb-1 text-xs font-bold uppercase tracking-wide text-coral">
                    Failed sends
                  </div>
                  <ul className="space-y-1 text-xs text-deep-green/80">
                    {result.failures.map((f, i) => (
                      <li key={i}>
                        {f.masked_phone}
                        {f.error ? ` — ${f.error}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-deep-green/55">
                This send was recorded in the notify log.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="self-end rounded-full bg-deep-green px-5 py-2 text-xs font-bold text-white hover:bg-deep-green/90"
              >
                Done
              </button>
            </div>
          ) : null}

          {/* ---------- CONFIRM ---------- */}
          {step === "confirm" ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-cream-line bg-cream-soft/50 p-4 text-sm text-deep-green">
                <span className="font-bold">{recipientCount}</span> player
                {recipientCount === 1 ? "" : "s"} will receive this SMS.
              </div>
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-deep-green/55">
                  Final message (example for {exampleName})
                </div>
                <div className="whitespace-pre-wrap rounded-xl border border-cream-line bg-white p-3 text-sm text-deep-green">
                  {renderedPreview}
                </div>
              </div>
              {sendError && (
                <div className="rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-xs text-coral">
                  {sendError}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setStep("compose")}
                  disabled={sending}
                  className="rounded-full border border-cream-line px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft disabled:opacity-50"
                >
                  Go back
                </button>
                <button
                  type="button"
                  onClick={doSend}
                  disabled={sending}
                  className="rounded-full bg-deep-green px-5 py-2 text-xs font-bold text-white hover:bg-deep-green/90 disabled:opacity-50"
                >
                  {sending ? "Sending..." : "Confirm send"}
                </button>
              </div>
            </div>
          ) : null}

          {/* ---------- COMPOSE ---------- */}
          {step === "compose" ? (
            <div className="flex flex-col gap-4">
              {/* Template picker */}
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-deep-green/55">
                  Template
                </div>
                <div className="flex flex-wrap gap-2">
                  {NOTIFY_TEMPLATE_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => pickTemplate(id)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${
                        templateId === id
                          ? "border-deep-green bg-deep-green text-white"
                          : "border-cream-line text-deep-green hover:bg-cream-soft"
                      }`}
                    >
                      {TEMPLATE_LABELS[id]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Editable body */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label
                    htmlFor="notify-body"
                    className="text-[11px] font-bold uppercase tracking-wide text-deep-green/55"
                  >
                    Message
                  </label>
                  <span className="text-[11px] text-deep-green/50">
                    {seg.chars} chars - {seg.segments} segment
                    {seg.segments === 1 ? "" : "s"}
                  </span>
                </div>
                <textarea
                  id="notify-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                  placeholder={
                    templateId
                      ? ""
                      : "Pick a template above, or start typing a free-form message."
                  }
                  className="w-full resize-y rounded-xl border border-cream-line bg-white p-3 text-sm text-deep-green focus:border-deep-green focus:outline-none"
                />
                <div className="mt-1 space-y-1">
                  <p className="text-[11px] text-deep-green/45">
                    {"{first_name}"} is replaced with each player&apos;s first
                    name.
                  </p>
                  {leftover.length > 0 && (
                    <p className="text-[11px] font-medium text-coral">
                      Fill in {leftover.join(", ")} before sending.
                    </p>
                  )}
                  {seg.encoding === "UCS-2" && (
                    <p className="text-[11px] font-medium text-coral">
                      Message contains special characters and will send as
                      shorter 70-character segments. Use plain text to keep it
                      to 160.
                    </p>
                  )}
                </div>
              </div>

              {/* Recipients */}
              <div className="rounded-xl border border-cream-line bg-cream-soft/40 p-3">
                {loadingPreview ? (
                  <div className="text-xs text-deep-green/55">
                    Loading recipients...
                  </div>
                ) : previewError ? (
                  <div className="text-xs text-coral">{previewError}</div>
                ) : preview ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setListExpanded((v) => !v)}
                      className="flex w-full items-center justify-between text-left"
                    >
                      <span className="text-sm font-bold text-deep-green">
                        Sending to {recipientCount} player
                        {recipientCount === 1 ? "" : "s"} in this match
                      </span>
                      {listExpanded ? (
                        <ChevronDown aria-hidden className="h-4 w-4 text-deep-green/60" />
                      ) : (
                        <ChevronRight aria-hidden className="h-4 w-4 text-deep-green/60" />
                      )}
                    </button>
                    {preview.no_phone_count > 0 && (
                      <div className="mt-1 text-[11px] text-deep-green/55">
                        {preview.no_phone_count} player
                        {preview.no_phone_count === 1 ? " has" : "s have"} no
                        phone on file and will not receive this.
                      </div>
                    )}
                    {listExpanded && (
                      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                        {preview.recipients.map((r) => (
                          <li
                            key={r.user_id}
                            className="flex items-center justify-between text-xs text-deep-green/80"
                          >
                            <span>{displayName(r.first_name, r.last_name)}</span>
                            <span className="tabular-nums text-deep-green/55">
                              {r.masked_phone}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : null}
              </div>

              {sendError && (
                <div className="rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-xs text-coral">
                  {sendError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full border border-cream-line px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSendError(null);
                    setStep("confirm");
                  }}
                  disabled={!canSend}
                  className="rounded-full bg-deep-green px-5 py-2 text-xs font-bold text-white hover:bg-deep-green/90 disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
