// GET /api/crm/agent-scoreboard — the support agent's weekly line (src/lib/agentScoreboard.ts): requests in
// the last 7 days, how many the agent resolved, how many a person sent from a draft, how many a person
// wrote, and the median first reply in support minutes. Read-only, our database only. A confined account
// sees its own city's threads. Any read error is an error, never a zero.

import { authenticateCrm } from "@/lib/crmAuth";
import { crmScopeCity } from "@/lib/crmScope";
import { agentScoreboard, SCOREBOARD_DAYS, type ScoreMsg } from "@/lib/agentScoreboard";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const PAGE = 1000;

async function getRoute(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  const now = Date.now();
  const since = new Date(now - (SCOREBOARD_DAYS + 1) * 86400e3).toISOString();
  const msgs: ScoreMsg[] = [];
  for (let from = 0; ; from += PAGE) {
    const r = await supabase.from("crm_messages").select("id, thread_id, direction, sent_at, body, is_auto_reply, auto_sent_draft_id, sent_by_user_id, media_kind")
      .gte("sent_at", since).order("sent_at", { ascending: true }).range(from, from + PAGE - 1);
    if (r.error) return Response.json({ error: "Couldn't read the messages." }, { status: 500 });
    msgs.push(...((r.data ?? []) as ScoreMsg[]));
    if ((r.data ?? []).length < PAGE) break;
  }
  const city = crmScopeCity(auth);
  let scoped = msgs;
  if (city) {
    const ids = [...new Set(msgs.map((m) => m.thread_id))];
    const inCity = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const t = await supabase.from("crm_threads").select("id").in("id", ids.slice(i, i + 200)).eq("city_code", city);
      if (t.error) return Response.json({ error: "Couldn't read the threads." }, { status: 500 });
      for (const x of t.data ?? []) inCity.add(x.id as string);
    }
    scoped = msgs.filter((m) => inCity.has(m.thread_id));
  }
  const sent = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const d = await supabase.from("crm_ai_drafts").select("sent_message_id").gte("created_at", since).not("sent_message_id", "is", null).range(from, from + PAGE - 1);
    if (d.error) return Response.json({ error: "Couldn't read the drafts." }, { status: 500 });
    for (const x of d.data ?? []) sent.add(x.sent_message_id as string);
    if ((d.data ?? []).length < PAGE) break;
  }
  return Response.json({ days: SCOREBOARD_DAYS, ...agentScoreboard(scoped, sent, now) }, { headers: { "cache-control": "no-store" } });
}

export const GET = reviewMasked(getRoute);
