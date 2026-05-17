"use client";

// Composer at the bottom of the conversation pane. Auto-expanding
// textarea (min 80, max 240). Enter to send / Shift+Enter newline.
// Round mint send button with ArrowUp icon — meets the 44×44px
// touch-target minimum.
//
// WhatsApp 24-hour window: when expired, the textarea + button are
// disabled and a muted info banner explains why. Server enforces
// the same rule and 422s if violated; the client check just avoids
// the round-trip.
//
// SMS-only segment counter (GSM-7 vs UCS-2) is rendered below the
// textarea. Hidden for WhatsApp threads — Meta doesn't bill per
// segment so it would be misleading.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CrmChannel } from "@/components/ChannelChip";
import type { ConversationMessage } from "./MessageBubble";

const GSM7_RX =
  /^[\n\rA-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà€\\[\]{}|~^]*$/;

function smsBudget(body: string): {
  encoding: "gsm7" | "ucs2";
  segmentSize: number;
  segments: number;
} {
  const encoding = GSM7_RX.test(body) ? "gsm7" : "ucs2";
  const segmentSize = encoding === "gsm7" ? 160 : 70;
  const len = body.length;
  const segments = len === 0 ? 0 : Math.ceil(len / segmentSize);
  return { encoding, segmentSize, segments };
}

async function bearerHeaders(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export default function Composer({
  threadId,
  appUserId,
  channel,
  whatsappWindowExpired,
  onSent,
}: {
  threadId: string;
  appUserId: string | null;
  channel: CrmChannel;
  whatsappWindowExpired: boolean;
  onSent: (m: ConversationMessage) => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(240, Math.max(80, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [body]);

  // Clear input when switching threads.
  useEffect(() => {
    setBody("");
    setError(null);
  }, [threadId]);

  const budget = useMemo(() => smsBudget(body), [body]);

  const disabled = sending || !appUserId || whatsappWindowExpired;
  const placeholder = !appUserId
    ? "Sign in to send."
    : whatsappWindowExpired
      ? "WhatsApp session expired — player must message first."
      : "Type a reply. Enter to send, Shift+Enter for newline.";

  const submit = useCallback(async () => {
    if (sending) return;
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    const headers = await bearerHeaders();
    if (!headers) {
      setError("No active session — sign in again.");
      setSending(false);
      return;
    }
    try {
      const res = await fetch("/api/crm/send", {
        method: "POST",
        headers,
        body: JSON.stringify({ thread_id: threadId, body }),
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
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [body, sending, threadId, onSent]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  return (
    <div className="border-t border-cream-line bg-cream px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4">
      {whatsappWindowExpired && (
        <div className="mb-2 rounded-md border border-cream-line bg-cream-soft px-2 py-1.5 text-[11px] text-deep-green/65">
          <span aria-hidden className="mr-1">
            ⓘ
          </span>
          WhatsApp session expired — player must message first to reopen the
          24-hour window.
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          value={body}
          disabled={disabled}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="block flex-1 resize-none rounded-2xl border border-cream-line bg-white px-3 py-2 text-sm text-deep-green placeholder:text-deep-green/40 focus:border-deep-green focus:outline-none disabled:bg-cream-soft disabled:text-deep-green/40"
          style={{ minHeight: 44, maxHeight: 240 }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={sending || !body.trim() || !appUserId || whatsappWindowExpired}
          aria-label={sending ? "Sending message" : "Send message"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mint text-deep-green shadow-sm transition hover:bg-mint-hover disabled:opacity-40"
        >
          <ArrowUp aria-hidden className="h-5 w-5" strokeWidth={2.5} />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-deep-green/55">
        <div>
          <span className="font-medium text-deep-green/75">{body.length}</span>{" "}
          chars
          {channel === "sms" && (
            <>
              {" · "}
              {budget.encoding === "gsm7" ? "GSM-7 (160/seg)" : "UCS-2 (70/seg)"}
              {" · "}
              <span className="font-medium text-deep-green/75">
                {budget.segments}
              </span>{" "}
              seg{budget.segments === 1 ? "" : "s"}
            </>
          )}
          {error && <span className="ml-2 text-coral-hover">{error}</span>}
        </div>
        <div className="text-[10px] text-deep-green/40">
          {channel === "whatsapp" ? "WhatsApp" : "SMS"}
        </div>
      </div>
    </div>
  );
}
