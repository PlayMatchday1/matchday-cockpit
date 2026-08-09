"use client";
// The "writes are not being recorded" banner (Phase 16). RED — this is a hole in the
// record, not an open question (that's the amber unresolved band). Shown wherever writes
// happen (Gameday Ops, the match editor) and on the Change Log itself, so an operator
// learns the log is down without having to open it. Reads the per-browser counter.

import { useEffect, useState } from "react";
import { getLogHealth, LOG_HEALTH_EVENT, type LogHealth } from "@/lib/logHealth";

export default function LogHealthBanner() {
  const [h, setH] = useState<LogHealth>({ count: 0, lastAt: null });
  useEffect(() => {
    const read = () => setH(getLogHealth());
    read();
    const onEvt = () => read();
    window.addEventListener(LOG_HEALTH_EVENT, onEvt);
    window.addEventListener("storage", onEvt); // cross-tab
    return () => { window.removeEventListener(LOG_HEALTH_EVENT, onEvt); window.removeEventListener("storage", onEvt); };
  }, []);
  if (h.count < 1) return null;
  const at = h.lastAt ? new Date(h.lastAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  return (
    <div data-testid="log-health-banner" role="alert" style={{
      display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px", padding: "11px 16px",
      background: "#FDEEEB", border: "1px solid #E9B6AC", borderLeft: "4px solid #A83120",
      borderRadius: 12, color: "#A83120", fontSize: 14, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif",
    }}>
      <span aria-hidden style={{ width: 22, height: 22, flex: "0 0 22px", borderRadius: "50%", background: "#A83120", color: "#fff", fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>!</span>
      <span><b>{h.count} write{h.count === 1 ? "" : "s"} could not be recorded</b>{at ? <>, most recently at {at}</> : null}. The change went through, but the Change Log did not capture it — apply the log migration or check the store.</span>
    </div>
  );
}
