// CLAUDE DRAFTS — a LIVE check on REAL threads, on demand only (NOT in `npm run verify`: it costs money,
// needs a key and reads production). The real data path (aiDraftDeps) and the real model, with every
// write stubbed: no row is stored, nothing is sent, nothing is superseded. It re-drafts the player
// message an earlier draft was made for, as of 20 minutes after it, and prints what staff actually sent.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/ai-draft-live-real.ts [per-category] [max-threads]
//
// Output carries first names and message text: read it, don't paste it anywhere. About $0.03 a thread;
// not recorded in crm_ai_drafts. Paced at one thread per 2 seconds (MatchDay reads, no bulk sweeps).

import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const { runDraft } = await import("../src/lib/aiDraftRun");
  const { draftDataDeps } = await import("../src/lib/aiDraftDeps");
  const { draftCostUsd } = await import("../src/lib/aiDraftModel");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  const perCategory = Number(process.argv[2] ?? 2), maxThreads = Number(process.argv[3] ?? 1000);
  const rows = await sb.from("crm_ai_drafts").select("thread_id, based_on_message_id, category, created_at").not("category", "is", null).order("created_at", { ascending: false }).limit(200);
  if (rows.error) throw new Error(rows.error.message);
  const seen = new Set<string>(), count = new Map<string, number>();
  const picks = (rows.data ?? []).filter((d) => {
    if (seen.has(d.thread_id) || (count.get(d.category) ?? 0) >= perCategory) return false;
    seen.add(d.thread_id); count.set(d.category, (count.get(d.category) ?? 0) + 1);
    return true;
  }).slice(0, maxThreads);
  let slowest = 0, total = 0, n = 0, shown = 0, failed = 0, actions = 0, words = 0;
  for (const p of picks) {
    const based = await sb.from("crm_messages").select("sent_at").eq("id", p.based_on_message_id).single();
    if (based.error || !based.data) continue;
    const asOf = Date.parse(based.data.sent_at) + 20 * 60e3;
    const real = draftDataDeps({ supabase: sb, threadId: p.thread_id, requestedBy: null, confinedCity: null, apiKey: process.env.ANTHROPIC_API_KEY?.trim() });
    let cost = 0, exampleBlock = false;
    const r = await runDraft({
      ...real,
      threadId: p.thread_id, requestedBy: null, regenerate: false, now: () => asOf, hasKey: true,
      loadMessages: async () => (await real.loadMessages()).filter((m) => Date.parse(m.sent_at) <= Date.parse(based.data!.sent_at)),
      latestDraftFor: async () => null,
      supersedePending: async () => {},
      callModel: async (req) => {
        exampleBlock = req.messages[0].content.includes("EXAMPLES OF HOW THE TEAM WRITES");
        const t0 = Date.now();
        const reply = await real.callModel(req);
        cost = draftCostUsd(reply.usage);
        slowest = Math.max(slowest, Date.now() - t0);
        console.log(`\n── was ${p.category} · ${req.model} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${reply.usage.input_tokens} in, ${reply.usage.output_tokens} out, $${cost.toFixed(4)}, ${reply.stopReason}, examples: ${exampleBlock}`);
        return reply;
      },
      insertDraft: async (row) => { console.log(`  keys: ${row.context_keys.filter((k) => !k.startsWith("match:")).join(", ")}`); return { id: "not-stored", created_at: new Date(asOf).toISOString() }; },
    });
    total += cost; n++;
    const sent = await sb.from("crm_messages").select("body").eq("thread_id", p.thread_id).eq("direction", "outbound").not("sent_by_user_id", "is", null).gt("sent_at", based.data.sent_at).order("sent_at", { ascending: true }).limit(1).maybeSingle();
    if (r.status === "ok") {
      shown++; words += r.draft.text.split(/\s+/).length;
      console.log(`  reply: ${r.draft.text}`);
      if (r.draft.action) { actions++; console.log(`  action: ${JSON.stringify(r.draft.action)}\n  without: ${r.draft.text_without_action}`); }
      for (const note of r.draft.staff_notes) console.log(`  note: ${note}`);
    } else {
      if (r.status === "failed") failed++;
      console.log(`  ${r.status}: ${"message" in r ? r.message : ""}`);
    }
    console.log(`  staff actually sent: ${(sent.data?.body as string | undefined)?.slice(0, 200) ?? "(nothing)"}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  console.log(`\n${n} threads · ${shown} shown · ${failed} failed by a guard · ${actions} with an action · ${shown ? (words / shown).toFixed(1) : 0} words a reply · $${total.toFixed(4)} · $${n ? (total / n).toFixed(4) : 0} a draft · slowest ${(slowest / 1000).toFixed(1)}s`);
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
