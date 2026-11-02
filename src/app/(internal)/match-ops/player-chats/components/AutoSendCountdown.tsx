"use client";

// "Sending in 2:40" with Cancel, on a row with a hold running. Its own one-second clock, so the list's
// 30-second tick stays the list's.

import { useEffect, useState } from "react";
import { bearerHeaders } from "@/lib/crmConversation";

export default function AutoSendCountdown({ threadId, holdUntil, onDone }: { threadId: string; holdUntil: string | null; onDone: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (result) return <span data-testid="auto-send-cancel-result" className="mt-1.5 inline-flex text-[10.5px] font-[700]" style={{ color: "#5f6f67" }}>{result}</span>;
  const left = holdUntil ? Math.max(0, Math.ceil((Date.parse(holdUntil) - now) / 1000)) : 0;
  return (
    <span className="mt-1.5 flex items-center gap-1.5 text-[10.5px] font-[750]" style={{ color: "#3f544a" }}>
      <span data-testid="auto-send-countdown" className="rounded-[6px] border px-[7px] py-0.5" style={{ background: "#eef1ef", borderColor: "#d5dcd8" }}>
        {left > 0 ? `Sending in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Sending…"}
      </span>
      <button
        type="button"
        data-testid="auto-send-cancel"
        onClick={async (e) => {
          e.stopPropagation();
          const headers = await bearerHeaders();
          if (!headers) { setResult("Sign in again, it wasn't cancelled"); return; }
          const res = await fetch(`/api/crm/threads/${threadId}/auto-send/cancel`, { method: "POST", headers });
          setResult(res.ok ? "Cancelled" : "Too late to cancel");
          onDone();
        }}
        className="rounded-full border bg-white px-2 py-0.5 font-[700] hover:bg-cream-soft"
        style={{ borderColor: "#c4cec9" }}
      >
        Cancel
      </button>
    </span>
  );
}
