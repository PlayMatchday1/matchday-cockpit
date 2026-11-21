/* FREE FIRST MATCH — THE FIELD SWITCH (Ryan, 2026-11-21). There is no field-level setting in the backend:
 * the only switch is the match's own `firstMatchFreeEnabled`, admin-only, the one Match panel writes. A
 * field's switch on /lifecycle/free-first-match therefore sends that SAME write, through the SAME route
 * (PUT /api/matchday/prod/matches/{id}: admin check on app_users.is_admin, read-back, change_log via
 * recordWrite, mirror write-through), once per upcoming match on the field whose value differs.
 *
 * Rules, all from CLAUDE.md "Writes":
 *   - The body is the diff: `{ firstMatchFreeEnabled: value }` and nothing else, and only to matches
 *     whose value is not already `value`.
 *   - One match at a time, at least GAP_MS apart. Never in parallel.
 *   - A write NEVER retries. The first match that does not come back LANDED stops the run; every match
 *     after it is reported NOT SENT, never attempted.
 *   - LANDED means the route's own outcome is landed AND its read-back carries the value. A 2xx alone is
 *     not enough; a thrown fetch is UNKNOWN (it may have landed).
 * Pure apart from the injected put / sleep, so scripts/ffm-field-switch-test.ts runs it offline. */

export const FIELD_SWITCH_SOURCE = "Free First Match · field switch";
export const GAP_MS = 2000;

export type StepState = "waiting" | "sending" | "landed" | "notapplied" | "failed" | "unknown" | "not_sent";
export type SwitchStep = { id: number; wall: string; state: StepState; note?: string };
export type PutResult = { status: number; body: { outcome?: string; match?: Record<string, unknown> | null; error?: string } | null };

/** The upcoming matches the switch will write: only those whose value differs (null = not in the mirror). */
export function matchesToChange<T extends { id: number; ffe: boolean | null }>(upcoming: readonly T[], value: boolean): T[] {
  return upcoming.filter((u) => u.ffe !== value);
}

/** The request body. The diff, and the source change_log records it under. */
export const switchBody = (value: boolean) => ({ changes: { firstMatchFreeEnabled: value }, source: FIELD_SWITCH_SOURCE });

export async function runFieldSwitch(opts: {
  matches: readonly { id: number; wall: string }[];
  value: boolean;
  put: (id: number, body: ReturnType<typeof switchBody>) => Promise<PutResult>;
  sleep: (ms: number) => Promise<void>;
  onStep?: (steps: SwitchStep[]) => void;
  gapMs?: number;
}): Promise<SwitchStep[]> {
  const gap = Math.max(GAP_MS, opts.gapMs ?? GAP_MS);
  const steps: SwitchStep[] = opts.matches.map((m) => ({ id: m.id, wall: m.wall, state: "waiting" }));
  const emit = () => opts.onStep?.(steps.map((s) => ({ ...s })));
  emit();
  let stopped = false;
  for (let i = 0; i < steps.length; i++) {
    if (stopped) { steps[i].state = "not_sent"; continue; }
    if (i > 0) await opts.sleep(gap);
    steps[i].state = "sending";
    emit();
    let r: PutResult;
    try {
      r = await opts.put(steps[i].id, switchBody(opts.value));
    } catch (e) {
      steps[i].state = "unknown";
      steps[i].note = `No answer (${e instanceof Error ? e.message : String(e)}). It may have landed; check the match.`;
      stopped = true; emit(); continue;
    }
    const b = r.body ?? {};
    if (r.status < 200 || r.status >= 300) {
      steps[i].state = "failed";
      steps[i].note = b.error ?? `HTTP ${r.status}`;
    } else if (b.outcome === "landed" && b.match?.firstMatchFreeEnabled === opts.value) {
      steps[i].state = "landed";
    } else if (b.outcome === "landed" || b.outcome === "notapplied") {
      steps[i].state = "notapplied";
      steps[i].note = "Sent, but the match reads back unchanged.";
    } else if (b.outcome === "failed") {
      steps[i].state = "failed";
      steps[i].note = b.error ?? "The write failed.";
    } else {
      steps[i].state = "unknown";
      steps[i].note = "The write could not be confirmed.";
    }
    if (steps[i].state !== "landed") stopped = true;
    emit();
  }
  emit();
  return steps;
}
