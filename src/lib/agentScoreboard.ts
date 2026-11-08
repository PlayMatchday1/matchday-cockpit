// THE SUPPORT AGENT'S WEEKLY LINE at the top of Player Chats (Ryan, 2026-11-08). Pure, so
// scripts/ai-draft-test.ts asserts it inside `npm run verify`; /api/crm/agent-scoreboard reads the rows.
//
// A REQUEST is a run of player messages up to our first real reply (an out-of-hours auto-reply and an
// emoji reaction don't count either way). It is counted in the week it STARTED. Who answered it:
//   - the agent: that first reply went out on its own (crm_messages.auto_sent_draft_id)
//   - drafted: a person sent a draft, as is or edited (crm_ai_drafts.sent_message_id)
//   - a person: anything else, templates included
// RESOLVED BY THE AGENT is stricter than answered: the agent replied and no person wrote in that thread in
// the 24 hours after. A request still waiting is "open"; one ending on a bare "ok"/"thanks" with no reply
// isn't a request and isn't counted. Median first reply is in SUPPORT minutes (9am to 9pm Central).

import { businessMinutesBetween, median } from "@/lib/businessHours";
import { isAcknowledgment } from "@/lib/awaitingReply";

export type ScoreMsg = {
  id: string; thread_id: string; direction: "inbound" | "outbound"; sent_at: string; body: string | null;
  is_auto_reply: boolean | null; auto_sent_draft_id: string | null; sent_by_user_id: string | null; media_kind: string | null;
};
export type Scoreboard = { requests: number; resolvedByAgent: number; answeredByAgent: number; drafted: number; byPerson: number; open: number; medianFirstReplyMin: number | null };
export const SCOREBOARD_DAYS = 7;
const DAY = 86400e3;

export function agentScoreboard(msgs: readonly ScoreMsg[], draftSentIds: ReadonlySet<string>, now: number, days = SCOREBOARD_DAYS): Scoreboard {
  const from = now - days * DAY;
  const byThread = new Map<string, ScoreMsg[]>();
  for (const m of msgs) {
    if (m.media_kind === "reaction" || (m.direction === "outbound" && m.is_auto_reply === true)) continue;
    byThread.set(m.thread_id, [...(byThread.get(m.thread_id) ?? []), m]);
  }
  const out: Scoreboard = { requests: 0, resolvedByAgent: 0, answeredByAgent: 0, drafted: 0, byPerson: 0, open: 0, medianFirstReplyMin: null };
  const waits: number[] = [];
  for (const ms of byThread.values()) {
    ms.sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].direction !== "inbound" || (i > 0 && ms[i - 1].direction === "inbound")) continue;
      const start = Date.parse(ms[i].sent_at);
      let j = i;
      while (j < ms.length && ms[j].direction === "inbound") j++;
      if (start < from || start > now) continue;
      const reply = ms[j];
      if (!reply) {
        if (!isAcknowledgment(ms[j - 1].body)) { out.requests++; out.open++; }
        continue;
      }
      out.requests++;
      waits.push(businessMinutesBetween(start, Date.parse(reply.sent_at)));
      if (reply.auto_sent_draft_id) {
        out.answeredByAgent++;
        const at = Date.parse(reply.sent_at);
        const personAfter = ms.some((m) => m.direction === "outbound" && !m.auto_sent_draft_id && Date.parse(m.sent_at) > at && Date.parse(m.sent_at) <= at + DAY);
        if (!personAfter) out.resolvedByAgent++;
      } else if (draftSentIds.has(reply.id)) out.drafted++;
      else out.byPerson++;
    }
  }
  out.medianFirstReplyMin = median(waits);
  return out;
}
