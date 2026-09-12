/* THE ESTATE'S ONLY MATCH-NAME WRITER, and now it has two surfaces.
 *
 * WHY THIS FILE EXISTS. The PUT used to live inside VeoMasterSchedule as a closure over that
 * component's own state (`setWroteName`, `markFailed`, `setError`). The camera-name reconcile moved
 * to the Veo page, and the rule it has to keep is "the moved control calls the SAME writer rather
 * than growing its own" — one host guard, one EDIT MATCHES gate, one recordWrite per write. A
 * component-local closure cannot be called from another component, so the PUT is here and the
 * bookkeeping stays with whoever is doing it.
 *
 * WHAT IS SHARED IS THE PART THAT MUST NOT DIVERGE: nameForVeo's decision, the refusal to send a
 * no-change edit, the gate check, the request body, and the rule that A 2xx IS NOT PROOF — the
 * route classifies from a read-back and anything but `landed` is a failure to surface.
 *
 * WHAT IS NOT SHARED is each caller's own memory. Master Schedule remembers what it wrote (the
 * mirror lags an hour, so the next toggle must not be computed from a name it knows is stale) and
 * marks the failing chip; the Veo reconcile prints one verdict per row instead. Those are different
 * jobs and pushing them in here would have made this function know about two screens.
 *
 * IT IS NEVER A CRON. A person presses the button that writes. A match name is player-visible and
 * the rule is written down twice already — crm-characterize-test.ts:87 and veoNameSync's closing
 * note. There is no server-side caller of this and there must never be one.
 */
import { nameForVeo } from "@/lib/veoNameSync";
/* The env literal rather than an import: matchEnv keeps BadgeEnv local. */
type WriteEnv = "production" | "staging";

export type NameWriteOutcome = "LANDED" | "FAILED" | string;

export type NameWrite = {
  /** LANDED only when the route's read-back said so. Anything else is a failure to surface. */
  outcome: NameWriteOutcome;
  /** The name that was sent, so a caller can show what it tried. */
  sent: string;
  /** Why it is not LANDED, in words, or null when it is. */
  reason: string | null;
};

/**
 * Writes the 🎥 into (or out of) a match name. Returns `null` for A NO-CHANGE EDIT — the caller
 * decides what to call that; both of ours report NOT APPLIED and send nothing at all.
 *
 * `mayWrite` is the courtesy half of EDIT MATCHES. The server refuses without it regardless; this
 * turns a 403 into a sentence instead of a retry.
 */
export async function writeVeoMatchName(opts: {
  env: WriteEnv;
  apiId: number;
  /** The name as it stands. nameForVeo re-derives the edit from it, so a name that gained a 🎥
   *  between a count and this write still sends nothing. */
  rawName: string;
  enabled: boolean;
  mayWrite: boolean;
  token: string | null;
  /** Names the surface in change_log. The two are distinguishable in the audit trail. */
  source: string;
}): Promise<NameWrite | null> {
  const edit = nameForVeo(opts.rawName, opts.enabled);
  if (!edit.change) return null; // NOT A CHANGE — send nothing at all.

  if (!opts.mayWrite) {
    return { outcome: "FAILED", sent: edit.next,
      reason: "Writing the 🎥 into the match name needs EDIT MATCHES." };
  }
  if (!opts.token) {
    return { outcome: "FAILED", sent: edit.next, reason: "No active session." };
  }

  try {
    const res = await fetch(`/api/matchday/${opts.env}/matches/${opts.apiId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      // The existing match write path: admin + EDIT MATCHES, host-guarded on the parsed host,
      // recordWrite() into change_log with the old and new name, verdict from a re-read.
      body: JSON.stringify({ changes: { name: edit.next }, source: opts.source, saveId: crypto.randomUUID() }),
    });
    const j = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
    if (!res.ok) {
      return { outcome: "FAILED", sent: edit.next, reason: j.error ?? `HTTP ${res.status}` };
    }
    // A 2xx IS NOT PROOF. The route classifies from a read-back; anything but `landed` is a
    // failure to surface, not a success to assume.
    const outcome = (j.outcome ?? "unknown").toUpperCase();
    return outcome === "LANDED"
      ? { outcome, sent: edit.next, reason: null }
      : { outcome, sent: edit.next, reason: `reported ${outcome} — the match name may not have changed` };
  } catch {
    return { outcome: "FAILED", sent: edit.next, reason: "Network error writing the match name." };
  }
}
